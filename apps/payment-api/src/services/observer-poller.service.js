import { getObserverToken } from '@youpi/common';

/**
 * ObserverPollerService
 *
 * Consolidated, coordinated background poller and verification daemon.
 * Replaces duplicate, uncoordinated polling loops with a single unified orchestrator:
 * - Automatically idles when no active/processing UPI sessions exist.
 * - Enforces minimum 1.5s–2.0s cooldown between external observer sweeps (SMS and Gmail).
 * - Drops redundant in-flight HTTP requests to prevent observer socket exhaustion.
 * - Serializes observation attribution with a mutex lock to eliminate SQLite lock contention (SQLITE_BUSY).
 * - Reacts immediately to payment events (SESSION.PROCESSING, SESSION.ACTIVATED) without waiting for timer ticks.
 */
export class ObserverPollerService {
  /**
   * @param {{
   *   db: import('@youpi/db').Database,
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   obsRepo: import('@youpi/db').ObservationRepository,
   *   attributionEngine: import('@youpi/core').AttributionEngine,
   *   eventEmitter: import('node:events').EventEmitter,
   *   pollIntervalMs?: number,
   *   minSweepCooldownMs?: number,
   *   smsPort?: number,
   *   gmailPort?: number,
   *   smsBaseUrl?: string,
   *   gmailBaseUrl?: string,
   *   observerToken?: string,
   *   autoStart?: boolean
   * }} options
   */
  constructor(options) {
    if (!options || !options.db || !options.sessionRepo || !options.obsRepo || !options.attributionEngine || !options.eventEmitter) {
      throw new Error('ObserverPollerService requires db, sessionRepo, obsRepo, attributionEngine, and eventEmitter');
    }

    this.db = options.db;
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.attributionEngine = options.attributionEngine;
    this.eventEmitter = options.eventEmitter;

    // Configurable timing parameters
    this.pollIntervalMs = Number(options.pollIntervalMs || process.env.OBSERVER_POLL_INTERVAL_MS || 1500);
    this.minSweepCooldownMs = Number(options.minSweepCooldownMs || process.env.OBSERVER_SWEEP_COOLDOWN_MS || 2000);
    this.smsPort = Number(options.smsPort || process.env.SMS_OBSERVER_PORT || 6002);
    this.gmailPort = Number(options.gmailPort || process.env.GMAIL_OBSERVER_PORT || 6003);
    const publicOrigin = process.env.PUBLIC_APP_URL
      || process.env.CHECKOUT_PUBLIC_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    this.smsBaseUrl = options.smsBaseUrl
      || process.env.SMS_OBSERVER_URL
      || (publicOrigin ? `${publicOrigin.replace(/\/+$/, '')}/internal/sms` : `http://localhost:${this.smsPort}`);
    this.gmailBaseUrl = options.gmailBaseUrl
      || process.env.GMAIL_OBSERVER_URL
      || (publicOrigin ? `${publicOrigin.replace(/\/+$/, '')}/internal/gmail` : `http://localhost:${this.gmailPort}`);
    this.observerToken = options.observerToken || null;

    // Lifecycle and concurrency control state
    this._isRunning = false;
    this._isPollingCycle = false;
    this._isIdle = true;
    this._timer = null;

    // Cooldown and in-flight tracking for observer endpoints
    this._lastSmsSweepTime = 0;
    this._lastGmailSweepTime = 0;
    this._isSmsSweepInFlight = false;
    this._isGmailSweepInFlight = false;

    // Attribution mutex & in-flight hash set to prevent SQLite write contention
    this._isAttributionInProgress = false;
    this._inFlightObservationHashes = new Set();

    // Event listener bindings
    this._boundOnSessionProcessing = this.handleSessionProcessing.bind(this);
    this._boundOnSessionActivated = this.handleSessionActivated.bind(this);
    this._boundOnPaymentTerminal = this.handlePaymentTerminal.bind(this);

    if (options.autoStart !== false) {
      this.start();
    }
  }

  get isRunning() {
    return this._isRunning;
  }

  get isIdle() {
    return this._isIdle;
  }

  get isSmsSweepInFlight() {
    return this._isSmsSweepInFlight;
  }

  get isGmailSweepInFlight() {
    return this._isGmailSweepInFlight;
  }

  get isAttributionInProgress() {
    return this._isAttributionInProgress;
  }

  get lastSmsSweepTime() {
    return this._lastSmsSweepTime;
  }

  get lastGmailSweepTime() {
    return this._lastGmailSweepTime;
  }

  /**
   * Starts the consolidated poller daemon and binds event listeners.
   */
  start() {
    if (this._isRunning) return;
    this._isRunning = true;

    // Bind reactive lifecycle events
    this.eventEmitter.on('SESSION.PROCESSING', this._boundOnSessionProcessing);
    this.eventEmitter.on('SESSION.ACTIVATED', this._boundOnSessionActivated);
    this.eventEmitter.on('PAYMENT.SUCCESS', this._boundOnPaymentTerminal);
    this.eventEmitter.on('PAYMENT.FAILED', this._boundOnPaymentTerminal);
    this.eventEmitter.on('PAYMENT.EXPIRED', this._boundOnPaymentTerminal);
    this.eventEmitter.on('PAYMENT.CANCELLED', this._boundOnPaymentTerminal);

    // Start single consolidated daemon interval
    this._timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);

    if (this._timer.unref) {
      this._timer.unref();
    }

    // Initial check
    this.pollCycle().catch(() => {});
  }

  /**
   * Stops the daemon, cleans up timers, and removes event listeners.
   */
  stop() {
    this._isRunning = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    if (this.eventEmitter) {
      this.eventEmitter.removeListener('SESSION.PROCESSING', this._boundOnSessionProcessing);
      this.eventEmitter.removeListener('SESSION.ACTIVATED', this._boundOnSessionActivated);
      this.eventEmitter.removeListener('PAYMENT.SUCCESS', this._boundOnPaymentTerminal);
      this.eventEmitter.removeListener('PAYMENT.FAILED', this._boundOnPaymentTerminal);
      this.eventEmitter.removeListener('PAYMENT.EXPIRED', this._boundOnPaymentTerminal);
      this.eventEmitter.removeListener('PAYMENT.CANCELLED', this._boundOnPaymentTerminal);
    }

    this._inFlightObservationHashes.clear();
    this._isPollingCycle = false;
    this._isAttributionInProgress = false;
    this._isSmsSweepInFlight = false;
    this._isGmailSweepInFlight = false;
    this._isIdle = true;
  }

  /**
   * Alias for stop() for standard engine lifecycle parity.
   */
  destroy() {
    this.stop();
  }

  /**
   * Reactive handler when a customer initiates payment confirmation.
   * Wakes up the poller immediately without waiting for the next interval tick.
   * @param {{ sessionId?: string, receivingAccountId?: string }} data
   */
  handleSessionProcessing(data) {
    this.triggerExpeditedSweep(data?.receivingAccountId);
  }

  /**
   * Reactive handler when a new session transitions to ACTIVE.
   * @param {{ sessionId?: string, receivingAccountId?: string }} data
   */
  handleSessionActivated(data) {
    this._isIdle = false;
    this.triggerExpeditedSweep(data?.receivingAccountId);
  }

  /**
   * Reactive handler on terminal payment outcomes.
   */
  handlePaymentTerminal() {
    // Next poll cycle will automatically update idle state
  }

  /**
   * Immediately triggers a poll sweep, waking the poller if idle.
   * @param {string} [preferredAccountId]
   */
  triggerExpeditedSweep(preferredAccountId = null) {
    if (!this._isRunning || this._isPollingCycle) return;
    this.pollCycle(preferredAccountId).catch(() => {});
  }

  /**
   * Finds all active payment sessions waiting for bank verification.
   * Includes ACTIVE, PROCESSING, and recent SUCCESS sessions awaiting secondary channel dual/triple match.
   * @returns {Array<{ id: string, receiving_account_id: string, amount_paise: number, status: string, verification_level?: number }>}
   */
  getActiveSessions() {
    try {
      const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
      // A session that already reached the Triple Verification Standard (level 3) is fully
      // confirmed: sweeping it again can never change its outcome, so it is excluded. This
      // preserves the upper bound the previous per-session sweep timers enforced.
      return this.db.query(`
        SELECT id, receiving_account_id, amount_paise, status, verification_level
        FROM payment_sessions
        WHERE method = 'UPI' AND (
          (status IN ('ACTIVE', 'PROCESSING') AND COALESCE(verification_level, 0) < 3)
          OR (status = 'SUCCESS' AND COALESCE(verification_level, 0) < 2 AND completed_at >= ?)
        )
      `, [sixtySecsAgo]);
    } catch {
      return [];
    }
  }

  /**
   * Executes a single coordinated polling cycle:
   * 1. Evaluates active sessions; idles immediately if none are active.
   * 2. Fires throttled sweeps to SMS and Gmail observers (respecting cooldown & in-flight lock).
   * 3. Sequentially processes unattributed bank observations under mutex lock.
   * @param {string} [preferredAccountId]
   */
  async pollCycle(preferredAccountId = null) {
    if (!this._isRunning || this._isPollingCycle) return;
    this._isPollingCycle = true;

    try {
      const activeSessions = this.getActiveSessions();

      if (activeSessions.length === 0) {
        this._isIdle = true;
        return;
      }

      this._isIdle = false;

      // 1. Concurrently trigger external observer sweeps with strict cooldown & in-flight locks
      await Promise.allSettled([
        this.sweepSmsObserver(),
        this.sweepGmailObserver()
      ]);

      // 2. Process pending unattributed bank observations in DB under sequential mutex lock
      await this.processPendingAttributions(activeSessions, preferredAccountId);
    } finally {
      this._isPollingCycle = false;
    }
  }

  /**
   * Sweeps Google Messages SMS Observer with cooldown and in-flight protection.
   * Drops redundant calls if cooldown has not elapsed or another sweep is currently in flight.
   * @returns {Promise<boolean>} True if sweep was dispatched, false if dropped/in-flight/cooldown.
   */
  async sweepSmsObserver() {
    const now = Date.now();
    if (this._isSmsSweepInFlight || (now - this._lastSmsSweepTime < this.minSweepCooldownMs)) {
      return false;
    }

    this._isSmsSweepInFlight = true;
    this._lastSmsSweepTime = now;

    try {
      const token = this.observerToken || getObserverToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      await fetch(new URL('api/sweep', `${this.smsBaseUrl.replace(/\/+$/, '')}/`), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(1200)
      });
      return true;
    } catch {
      return false;
    } finally {
      this._isSmsSweepInFlight = false;
    }
  }

  /**
   * Sweeps Gmail Observer with cooldown and in-flight protection.
   * Drops redundant calls if cooldown has not elapsed or another sweep is currently in flight.
   * @returns {Promise<boolean>} True if sweep was dispatched, false if dropped/in-flight/cooldown.
   */
  async sweepGmailObserver() {
    const now = Date.now();
    if (this._isGmailSweepInFlight || (now - this._lastGmailSweepTime < this.minSweepCooldownMs)) {
      return false;
    }

    this._isGmailSweepInFlight = true;
    this._lastGmailSweepTime = now;

    try {
      const token = this.observerToken || getObserverToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      await fetch(new URL('api/sweep', `${this.gmailBaseUrl.replace(/\/+$/, '')}/`), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(1200)
      });
      return true;
    } catch {
      return false;
    } finally {
      this._isGmailSweepInFlight = false;
    }
  }

  /**
   * Processes unattributed observations for active accounts under strict sequential mutex lock.
   * Deduplicates receivingAccountIds and tracks in-flight observation hashes to prevent
   * concurrent SQLite write transactions and SQLITE_BUSY contention.
   * @param {Array<{ receiving_account_id: string }>} activeSessions
   * @param {string} [preferredAccountId]
   */
  async processPendingAttributions(activeSessions, preferredAccountId = null) {
    if (this._isAttributionInProgress) return;
    this._isAttributionInProgress = true;

    try {
      const rawAccountIds = activeSessions.map(s => s.receiving_account_id).filter(Boolean);
      const accountIds = [...new Set(rawAccountIds)];

      if (preferredAccountId && accountIds.includes(preferredAccountId)) {
        accountIds.sort((a, b) => a === preferredAccountId ? -1 : (b === preferredAccountId ? 1 : 0));
      }

      for (const accountId of accountIds) {
        const unattributed = this.obsRepo.findUnattributed(accountId);
        if (!Array.isArray(unattributed) || unattributed.length === 0) continue;

        for (const obs of unattributed) {
          const hash = obs.fingerprintHash || obs.id;
          if (this._inFlightObservationHashes.has(hash)) continue;

          this._inFlightObservationHashes.add(hash);
          try {
            this.attributionEngine.processObservation({
              source: obs.source,
              receivingAccountId: obs.receivingAccountId,
              amountPaise: obs.amountPaise,
              observedAt: obs.observedAt,
              bankReferenceNumber: obs.bankReferenceNumber,
              senderVpa: obs.senderVpa,
              rawPayload: obs.rawPayload,
              fingerprintHash: obs.fingerprintHash
            });
          } catch {
            // Silently absorb individual observation attribution failures to avoid interrupting poller loop
          } finally {
            this._inFlightObservationHashes.delete(hash);
          }
        }
      }
    } finally {
      this._isAttributionInProgress = false;
    }
  }
}
