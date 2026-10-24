import { PaymentStatus } from '@youpi/common';

export class RecoveryEngine {
  /**
   * @param {{
   *   db: import('@youpi/db').Database,
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
   *   queueEngine: import('./queue-engine.js').QueueEngine,
   *   timingEngine: import('./timing-engine.js').TimingEngine,
   *   webhookEngine?: import('./webhook-engine.js').WebhookEngine,
   *   auditRepo?: import('@youpi/db').AuditLogRepository,
   *   eventEmitter?: { emit: (event: string, payload: any) => void }
   * }} options
   */
  constructor(options) {
    this.db = options.db;
    this.sessionRepo = options.sessionRepo;
    this.accountRepo = options.accountRepo;
    this.queueEngine = options.queueEngine;
    this.timingEngine = options.timingEngine;
    this.webhookEngine = options.webhookEngine;
    this.auditRepo = options.auditRepo;
    this.eventEmitter = options.eventEmitter;
  }

  /**
   * Performs full crash-recovery on startup.
   * Reconstructs timers and resolves overdue sessions.
   * @returns {{
   *   expiredCount: number,
   *   failedCount: number,
   *   rescheduledCount: number,
   *   promotedCount: number
   * }}
   */
  recover() {
    let expiredCount = 0;
    let failedCount = 0;
    let rescheduledCount = 0;
    let promotedCount = 0;

    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Recover overdue PROCESSING sessions -> mark SUCCESS if verified/attributed, else FAILED
    const overdueProcessing = this.db.query(`
      SELECT id, merchant_id, order_id, receiving_account_id, verification_level, attributed_observation_id FROM payment_sessions
      WHERE status = ? AND processing_expires_at < ?
    `, [PaymentStatus.PROCESSING, nowIso]);

    for (const row of overdueProcessing) {
      if (row.verification_level >= 1 || row.attributed_observation_id) {
        this.sessionRepo.transitionToTerminal(row.id, PaymentStatus.SUCCESS);
        if (this.auditRepo) {
          this.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: row.id,
            action: 'CRASH_RECOVERY_ATTRIBUTED_SUCCESS',
            actorType: 'SYSTEM'
          });
        }
        if (this.eventEmitter) {
          this.eventEmitter.emit('PAYMENT.SUCCESS', {
            paymentId: row.id,
            orderId: row.order_id,
            merchantId: row.merchant_id
          });
        }
      } else {
        this.sessionRepo.transitionToTerminal(row.id, PaymentStatus.FAILED);
        failedCount++;
        if (this.auditRepo) {
          this.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: row.id,
            action: 'CRASH_RECOVERY_EXPIRED_PROCESSING',
            actorType: 'SYSTEM'
          });
        }
        if (this.eventEmitter) {
          this.eventEmitter.emit('PAYMENT.FAILED', {
            paymentId: row.id,
            orderId: row.order_id,
            merchantId: row.merchant_id
          });
        }
      }
    }

    // 2. Recover overdue ACTIVE sessions -> mark EXPIRED
    const overdueActive = this.db.query(`
      SELECT id, merchant_id, order_id, receiving_account_id FROM payment_sessions
      WHERE status = ? AND expires_at < ?
    `, [PaymentStatus.ACTIVE, nowIso]);

    for (const row of overdueActive) {
      this.sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
      expiredCount++;
      if (this.auditRepo) {
        this.auditRepo.log({
          entityType: 'PAYMENT_SESSION',
          entityId: row.id,
          action: 'CRASH_RECOVERY_EXPIRED_ACTIVE',
          actorType: 'SYSTEM'
        });
      }
      if (this.eventEmitter) {
        this.eventEmitter.emit('PAYMENT.EXPIRED', {
          paymentId: row.id,
          orderId: row.order_id,
          merchantId: row.merchant_id
        });
      }
    }

    // 3. Reschedule ongoing ACTIVE sessions
    const ongoingActive = this.db.query(`
      SELECT id, expires_at FROM payment_sessions
      WHERE status = ? AND expires_at >= ?
    `, [PaymentStatus.ACTIVE, nowIso]);

    for (const row of ongoingActive) {
      this.timingEngine.startActiveTimer(row.id, new Date(row.expires_at));
      rescheduledCount++;
    }

    // 4. Reschedule ongoing PROCESSING sessions
    const ongoingProcessing = this.db.query(`
      SELECT id, processing_expires_at FROM payment_sessions
      WHERE status = ? AND processing_expires_at >= ?
    `, [PaymentStatus.PROCESSING, nowIso]);

    for (const row of ongoingProcessing) {
      const remainingMs = Math.max(0, new Date(row.processing_expires_at).getTime() - Date.now());
      const procTimer = setTimeout(() => {
        this.timingEngine.handleProcessingTimerExpiration(row.id);
      }, remainingMs);
      if (procTimer.unref) procTimer.unref();
      this.timingEngine.processingTimers.set(row.id, procTimer);
      rescheduledCount++;
    }

    // 5. Scan all receiving accounts: promote waiting queue if slot is now vacant
    const accounts = this.db.query(`SELECT id FROM payment_receiving_accounts WHERE is_active = 1`);
    for (const acc of accounts) {
      const promoted = this.queueEngine.promoteNext(acc.id);
      if (promoted) {
        promotedCount++;
        this.timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
    }

    // 6. Recover in-flight or missing terminal webhook deliveries
    let recoveredWebhooksCount = 0;
    if (this.webhookEngine && typeof this.webhookEngine.recoverMissingDeliveries === 'function') {
      try {
        recoveredWebhooksCount = this.webhookEngine.recoverMissingDeliveries({ resetInFlight: true });
      } catch {}
    }

    return {
      expiredCount,
      failedCount,
      rescheduledCount,
      promotedCount,
      recoveredWebhooksCount
    };
  }
}
