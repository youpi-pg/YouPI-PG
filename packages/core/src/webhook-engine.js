import crypto from 'node:crypto';
import { PaymentSessionRepository } from '@youpi/db';
import { generateHmac, toRupeesString, validateOutboundWebhookUrl } from '@youpi/common';
import { isTerminalStatus, toPublicOutcome } from './state-machine.js';

export class WebhookEngine {
  /**
   * @param {{
   *   db: import('@youpi/db').Database,
   *   merchantRepo: import('@youpi/db').MerchantRepository,
   *   maxRetries?: number
   * }} options
   */
  constructor(options) {
    this.db = options.db;
    this.merchantRepo = options.merchantRepo;
    this.sessionRepo = options.sessionRepo || new PaymentSessionRepository(this.db);
    this.maxRetries = Math.max(2, Math.min(20, Number(options.maxRetries) || 5));
  }

  /**
   * Formats and dispatches a signed webhook for a payment event.
   * @param {string} event E.g. 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED'
   * @param {any} session The payment session entity
   * @returns {Promise<{ delivered: boolean, deliveryId: string, status?: number, error?: string }>}
   */
  async dispatch(event, session) {
    const merchant = this.merchantRepo.findById(session.merchantId);
    if (!merchant || !merchant.webhookUrl) {
      return { delivered: false, deliveryId: '', error: 'No webhook URL configured for merchant.' };
    }

    const publicOutcome = isTerminalStatus(event) ? toPublicOutcome(event) : event;
    const nowIso = new Date().toISOString();

    // One durable delivery per payment/event, including duplicate or replayed in-process
    // events. SQLite serializes the final create-or-read in the transaction below.
    const prior = this.db.queryOne(
      'SELECT id, is_successful, response_status, response_body FROM webhook_deliveries WHERE payment_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1',
      [session.id, publicOutcome]
    );
    if (prior) {
      return { delivered: Boolean(prior.is_successful), deliveryId: prior.id, status: prior.response_status, error: prior.is_successful ? undefined : prior.response_body };
    }

    // Terminal transitions already have a durable outbox entry. If configuration
    // is missing or unsafe, KEEP that entry instead of recording an irrecoverable
    // synthetic failure row; the operator can repair configuration and replay.
    const isOutboxed = Boolean(this.db.queryOne(
      'SELECT payment_id FROM payment_webhook_outbox WHERE payment_id = ?',
      [session.id]
    ));

    // Direct non-outboxed dispatches still write an auditable failure record.
    if (!merchant.webhookSecret) {
      if (isOutboxed) {
        return { delivered: false, deliveryId: '', status: 500, error: 'Merchant webhookSecret is not configured.' };
      }
      const deliveryId = crypto.randomUUID();
      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 500, 'Merchant webhookSecret is not configured.', 1, 0, NULL, ?)
      `, [
        deliveryId,
        merchant.id,
        session.id,
        publicOutcome,
        JSON.stringify({ error: 'Missing webhookSecret', paymentId: session.id, orderId: session.orderId }),
        merchant.webhookUrl,
        nowIso
      ]);
      return { delivered: false, deliveryId, status: 500, error: 'Merchant webhookSecret is not configured.' };
    }

    // 2. Re-validate at dispatch time (SSRF guard)
    const endpointCheck = validateOutboundWebhookUrl(merchant.webhookUrl);
    if (!endpointCheck.valid) {
      if (isOutboxed) {
        return { delivered: false, deliveryId: '', status: 400, error: `Webhook delivery blocked: ${endpointCheck.error}` };
      }
      const deliveryId = crypto.randomUUID();
      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 400, ?, 1, 0, NULL, ?)
      `, [
        deliveryId,
        merchant.id,
        session.id,
        publicOutcome,
        JSON.stringify({ error: 'SSRF blocked', paymentId: session.id, orderId: session.orderId }),
        merchant.webhookUrl,
        `Webhook delivery blocked: ${endpointCheck.error}`,
        nowIso
      ]);
      return { delivered: false, deliveryId, status: 400, error: `Webhook delivery blocked: ${endpointCheck.error}` };
    }

    // 3. Resolve UTR / bank reference number if attributed
    // The bank reference (UTR/RRN) lives on the attributed observation, not on the
    // session row. Merchants need it to reconcile a webhook against their bank
    // statement, and it is part of the documented webhook contract.
    let utr = session.utr || session.bankReferenceNumber || session.bank_reference_number || '';
    if (!utr && session.attributedObservationId) {
      try {
        const obsRow = this.db.queryOne(
          'SELECT bank_reference_number FROM payment_observations WHERE id = ?',
          [session.attributedObservationId]
        );
        if (obsRow?.bank_reference_number) utr = obsRow.bank_reference_number;
      } catch {}
    }

    const deliveryId = crypto.randomUUID();
    const timestampNum = Date.now();
    const timestamp = timestampNum.toString();

    const payloadObj = {
      event: publicOutcome,
      deliveryId,
      timestamp: timestampNum,
      paymentId: session.id,
      orderId: session.orderId,
      attemptId: session.attemptId || session.id,
      amount: toRupeesString(session.amountPaise),
      amountPaise: Number(session.amountPaise),
      currency: session.currency || 'INR',
      method: session.method || 'UPI',
      utr: String(utr || ''),
      verificationTag: session.verificationTag || session.verification_tag || (session.method === 'COD' ? 'COD_ORDER_PLACED' : 'UNVERIFIED'),
      verificationLevel: session.verificationLevel != null ? Number(session.verificationLevel) : (session.verification_level != null ? Number(session.verification_level) : (session.method === 'COD' ? 1 : 0)),
      completedAt: session.completedAt ? (typeof session.completedAt.toISOString === 'function' ? session.completedAt.toISOString() : String(session.completedAt)) : new Date().toISOString(),
      metadata: session.metadata || {}
    };

    const payloadString = JSON.stringify(payloadObj);
    const signature = generateHmac(payloadString, merchant.webhookSecret);
    const timestampedSignature = generateHmac(`${timestamp}.${payloadString}`, merchant.webhookSecret);

    const headers = {
      'Content-Type': 'application/json',
      'X-Gateway-Event': publicOutcome,
      'X-Gateway-Signature': `sha256=${signature}`,
      'X-Gateway-Signature-V2': `sha256=${timestampedSignature}`,
      'X-Gateway-Delivery-Id': deliveryId,
      'X-Gateway-Timestamp': timestamp
    };

    // Persist BEFORE network IO. A worker dying during fetch must leave an eligible
    // retry with its original deliveryId, timestamp and exact payload bytes.
    // The 60s lease avoids two senders racing while an attempt is in flight.
    const recoveryAt = new Date(Date.now() + 60000).toISOString();
    const existing = this.db.transaction(() => {
      const row = this.db.queryOne(
        'SELECT id, is_successful, response_status, response_body FROM webhook_deliveries WHERE payment_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1',
        [session.id, publicOutcome]
      );
      if (row) return row;
      this.db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url,
          response_status, response_body, attempt_count, is_successful, next_retry_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, 0, ?, ?)
      `, [deliveryId, merchant.id, session.id, publicOutcome, payloadString, merchant.webhookUrl, recoveryAt, nowIso]);
      // Outbox cleanup commits together with durable delivery preparation.
      this.db.execute('DELETE FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]);
      return null;
    });
    if (existing) {
      return { delivered: Boolean(existing.is_successful), deliveryId: existing.id, status: existing.response_status, error: existing.is_successful ? undefined : existing.response_body };
    }

    let responseStatus = null;
    let responseBody = null;
    let isSuccessful = false;

    try {
      const res = await fetch(endpointCheck.url.toString(), {
        method: 'POST',
        headers,
        body: payloadString,
        // Never follow redirects: a public URL could otherwise 302 into internal network (SSRF)
        redirect: 'manual',
        signal: AbortSignal.timeout(10000) // 10s timeout
      });

      responseStatus = res.status;
      responseBody = (await res.text()).substring(0, 1000);
      isSuccessful = res.ok;
    } catch (err) {
      responseBody = err.message || 'Network timeout';
    }

    const nextRetryAt = isSuccessful
      ? null
      : new Date(Date.now() + 5000).toISOString();

    this.db.execute(`
      UPDATE webhook_deliveries
      SET response_status = ?, response_body = ?, is_successful = ?, next_retry_at = ?
      WHERE id = ?
    `, [responseStatus, responseBody, isSuccessful ? 1 : 0, nextRetryAt, deliveryId]);

    return {
      delivered: isSuccessful,
      deliveryId,
      status: responseStatus,
      error: isSuccessful ? undefined : responseBody
    };
  }

  /**
   * Prepare and send terminal events committed before a crash but not yet turned
   * into delivery records. The trigger records only new terminal transitions;
   * historic SUCCESS rows are never swept into webhooks on upgrade.
   */
  async recoverOutbox() {
    const rows = this.db.query(`
      SELECT o.payment_id, o.event_type
      FROM payment_webhook_outbox o
      WHERE NOT EXISTS (
        SELECT 1 FROM webhook_deliveries d
        WHERE d.payment_id = o.payment_id AND d.event_type = o.event_type
      )
      ORDER BY o.created_at, o.payment_id LIMIT 20
    `);
    const outcomes = [];
    for (const row of rows) {
      const session = this.sessionRepo.findById(row.payment_id);
      if (!session) continue;
      const merchant = this.merchantRepo.findById(session.merchantId);
      // Keep unconfigured merchants' events in the outbox for human remediation.
      if (!merchant?.webhookUrl || !merchant.webhookSecret) continue;
      outcomes.push(await this.dispatch(row.event_type, session));
    }
    return outcomes;
  }

  /**
   * Retries overdue pending webhook deliveries with atomic claim & exponential backoff.
   * Backoff strategy: 5s, 30s, 2m, 10m, 1h
   */
  async retryPending() {
    const nowIso = new Date().toISOString();

    // Invariant: Atomically claim overdue pending deliveries in a transaction to prevent duplicate dispatches
    const claimed = this.db.transaction(() => {
      const pending = this.db.query(`
        SELECT id, merchant_id, payment_id, event_type, payload, endpoint_url, attempt_count
        FROM webhook_deliveries
        WHERE is_successful = 0 AND attempt_count < ? AND next_retry_at <= ?
        LIMIT 20
      `, [this.maxRetries, nowIso]);

      if (pending.length === 0) return [];

      // Lock claimed items by setting next_retry_at 60 seconds into the future
      const claimLockIso = new Date(Date.now() + 60000).toISOString();
      for (const item of pending) {
        this.db.execute(`
          UPDATE webhook_deliveries
          SET next_retry_at = ?, attempt_count = attempt_count + 1
          WHERE id = ?
        `, [claimLockIso, item.id]);
      }

      return pending;
    });

    if (claimed.length === 0) return [];

    const results = [];
    const backoffs = [5000, 30000, 120000, 600000, 3600000];

    for (const item of claimed) {
      const merchant = this.merchantRepo.findById(item.merchant_id);
      if (!merchant || !merchant.webhookSecret || !item.endpoint_url) {
        this.db.execute(`
          UPDATE webhook_deliveries
          SET is_successful = 0, next_retry_at = NULL, response_body = 'Missing merchant or webhookSecret'
          WHERE id = ?
        `, [item.id]);
        continue;
      }

      // Re-validate the stored endpoint before every retry (SSRF guard).
      const retryEndpoint = validateOutboundWebhookUrl(item.endpoint_url);
      if (!retryEndpoint.valid) {
        this.db.execute(`
          UPDATE webhook_deliveries
          SET is_successful = 0, next_retry_at = NULL, response_body = ?
          WHERE id = ?
        `, [`SSRF blocked: ${retryEndpoint.error}`, item.id]);
        continue;
      }

      // The retry resends the ORIGINAL body byte for byte, so the headers must describe
      // that same body. Recomputing a fresh timestamp here would make the header disagree
      // with the timestamp embedded in the payload, and the merchant's verification (which
      // cross-checks the two) would reject every retry.
      let storedTimestamp = null;
      let storedDeliveryId = item.id;
      try {
        const storedPayload = JSON.parse(item.payload);
        if (storedPayload && storedPayload.timestamp !== undefined && storedPayload.timestamp !== null) {
          storedTimestamp = String(storedPayload.timestamp);
        }
        if (storedPayload && storedPayload.deliveryId) {
          storedDeliveryId = String(storedPayload.deliveryId);
        }
      } catch {}

      const timestamp = storedTimestamp || Date.now().toString();
      const signature = generateHmac(item.payload, merchant.webhookSecret);
      const timestampedSignature = generateHmac(`${timestamp}.${item.payload}`, merchant.webhookSecret);

      let isSuccess = false;
      let respStatus = null;
      let respBody = null;

      try {
        const res = await fetch(retryEndpoint.url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gateway-Event': item.event_type,
            'X-Gateway-Signature': `sha256=${signature}`,
            'X-Gateway-Signature-V2': `sha256=${timestampedSignature}`,
            'X-Gateway-Delivery-Id': storedDeliveryId,
            'X-Gateway-Timestamp': timestamp
          },
          body: item.payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(10000)
        });
        respStatus = res.status;
        respBody = (await res.text()).substring(0, 1000);
        isSuccess = res.ok;
      } catch (err) {
        respBody = err.message;
      }

      const nextAttempt = item.attempt_count + 1; // item.attempt_count was already incremented during claim
      const nextRetryDelay = backoffs[Math.min(nextAttempt - 1, backoffs.length - 1)];
      const nextRetryAt = isSuccess || nextAttempt >= this.maxRetries
        ? null
        : new Date(Date.now() + nextRetryDelay).toISOString();

      this.db.execute(`
        UPDATE webhook_deliveries
        SET is_successful = ?, response_status = ?, response_body = ?, next_retry_at = ?
        WHERE id = ?
      `, [isSuccess ? 1 : 0, respStatus, respBody, nextRetryAt, item.id]);

      results.push({ id: item.id, success: isSuccess, attempt: nextAttempt });
    }

    return results;
  }
}
