import { PaymentObserverClient } from '@youpi/observer-sdk';
import { BankSmsParser } from './sms-parser.js';

export class SmsObserverService {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string,
   *   pollIntervalMs?: number
   * }} options
   */
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.receivingAccountId = options.receivingAccountId || '00000000-0000-0000-0000-000000000002';
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.SMS_OBSERVER_POLL_INTERVAL_MS || 3000);
    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GOOGLE_MESSAGES'
    });

    this.isRunning = false;
    this.timer = null;
    this.lastPollAt = null;
    this.observedCount = 0;
  }

  async resolveActiveReceivingAccount() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/pollers/active-window`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json();
        if (data.sessions && data.sessions.length > 0) {
          return data.sessions[0].receivingAccountId;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Processes and ingests an incoming SMS notification.
   * @param {{ text: string, sender?: string, timestamp?: Date | number | string }} sms
   */
  async processSms(sms) {
    const parsed = BankSmsParser.parse(sms);
    if (!parsed) return null;

    let targetAccountId = this.receivingAccountId;
    try {
      const activeAcct = await this.resolveActiveReceivingAccount();
      if (activeAcct) targetAccountId = activeAcct;
    } catch {}

    const sender = sms.sender || 'BANK-ALERT';

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: targetAccountId,
        amountPaise: parsed.amountPaise,
        amount: parsed.amount,
        observedAt: parsed.observedAt,
        bankReferenceNumber: parsed.bankReferenceNumber,
        senderVpa: parsed.senderVpa,
        sender,
        rawText: parsed.rawText,
        rawPayload: {
          text: parsed.rawText,
          sender
        }
      });

      this.observedCount++;
      return result;
    } catch (err) {
      console.error('[SMS Observer] Submission failed:', err.message);
      throw err;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[SMS Observer] Service started (poll interval: ${this.pollIntervalMs}ms)`);
    this.timer = setInterval(() => {
      this.pollCycle();
    }, this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log('[SMS Observer] Service stopped.');
  }

  async pollCycle() {
    this.lastPollAt = new Date();
    // In production, interfaces with Google Messages Web automation session via browser trace / WebSocket
  }
}
