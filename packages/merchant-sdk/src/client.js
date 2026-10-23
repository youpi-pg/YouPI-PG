import { verifyHmac } from '@youpi/common';

export class YoupiPaymentClient {
  /**
   * @param {{
   *   apiUrl?: string,
   *   merchantId?: string,
   *   webhookSecret?: string,
   *   apiKey?: string
   * }} options
   */
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100').replace(/\/+$/, '');
    this.merchantId = options.merchantId || null;
    this.webhookSecret = options.webhookSecret || null;
    this.apiKey = options.apiKey || null;
  }

  /**
   * Creates a new payment session and receives checkout URL for redirection.
   * @param {{
   *   orderId: string,
   *   amount: string | number,
   *   currency?: string,
   *   returnUrl?: string,
   *   customer?: { phoneNumber: string, fullName?: string },
   *   metadata?: Record<string, any>,
   *   idempotencyKey?: string
   * }} params
   * @returns {Promise<{
   *   paymentId: string,
   *   orderId: string,
   *   amount: string,
   *   amountPaise: string,
   *   currency: string,
   *   status: string,
   *   checkoutUrl: string
   * }>}
   */
  async createPayment(params) {
    const url = `${this.apiUrl}/api/v1/payments`;
    const headers = {
      'Content-Type': 'application/json'
    };

    if (this.merchantId) {
      headers['X-Merchant-Id'] = this.merchantId;
    }
    if (this.apiKey || this.webhookSecret) {
      headers['X-Merchant-Key'] = this.apiKey || this.webhookSecret;
    }
    if (params.orderToken) {
      headers['X-Order-Token'] = params.orderToken;
    }
    if (params.idempotencyKey) {
      headers['Idempotency-Key'] = params.idempotencyKey;
    }

    const payload = {
      orderId: params.orderId,
      amount: params.amount,
      currency: params.currency || 'INR',
      returnUrl: params.returnUrl,
      customer: params.customer,
      metadata: params.metadata
    };
    if (params.autoActivate === true) {
      payload.autoActivate = true;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Create payment failed [HTTP ${res.status}]: ${err}`);
    }

    return await res.json();
  }

  /**
   * Queries payment status and details.
   * @param {string} paymentId
   * @returns {Promise<{
   *   paymentId: string,
   *   orderId: string,
   *   amount: string,
   *   amountPaise: string,
   *   currency: string,
   *   status: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | string,
   *   method: string,
   *   completedAt?: string,
   *   returnUrl?: string,
   *   metadata?: Record<string, any>
   * }>}
   */
  async getPayment(paymentId) {
    const url = `${this.apiUrl}/api/v1/payments/${paymentId}`;
    const headers = {};
    // Present the merchant secret so the gateway returns the merchant-private fields
    // (metadata, verification internals, returnUrl). Without it the caller gets the
    // redacted public view, which is all an unauthenticated holder of a payment id sees.
    if (this.apiKey || this.webhookSecret) {
      headers['X-Merchant-Key'] = this.apiKey || this.webhookSecret;
    }

    const res = await fetch(url, { headers });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Get payment failed [HTTP ${res.status}]: ${err}`);
    }

    return await res.json();
  }

  /**
   * Cryptographically verifies an incoming webhook payload using HMAC-SHA256
   * and enforces timestamp freshness / replay protection when a timestamp is present.
   *
   * @param {string} rawPayloadString Raw request body text (unparsed)
   * @param {string} signatureHeader Value of 'X-Gateway-Signature' header (e.g. 'sha256=...')
   * @param {string | number | { secret?: string, timestamp?: string | number, toleranceMs?: number, deliveryId?: string }} [customSecretOrTimestamp]
   * @param {{ secret?: string, timestamp?: string | number, toleranceMs?: number, deliveryId?: string }} [options]
   * @returns {any} Validated parsed webhook event payload
   */
  verifyWebhook(rawPayloadString, signatureHeader, customSecretOrTimestamp = null, options = null) {
    let customSecret = null;
    let timestampHeader = null;
    let opts = options && typeof options === 'object' ? options : {};

    if (customSecretOrTimestamp && typeof customSecretOrTimestamp === 'object') {
      opts = customSecretOrTimestamp;
      customSecret = opts.secret || null;
      timestampHeader = opts.timestamp !== undefined ? opts.timestamp : null;
    } else if (options !== null && options !== undefined) {
      // 4-argument form: verifyWebhook(rawBody, signatureHeader, timestampHeader, options)
      timestampHeader = customSecretOrTimestamp;
      customSecret = opts.secret || null;
    } else if (
      typeof customSecretOrTimestamp === 'number' ||
      (typeof customSecretOrTimestamp === 'string' && /^\d{10,16}$/.test(customSecretOrTimestamp.trim()))
    ) {
      timestampHeader = customSecretOrTimestamp;
    } else if (typeof customSecretOrTimestamp === 'string') {
      customSecret = customSecretOrTimestamp;
    }

    const secret = customSecret || this.webhookSecret;
    if (!secret) {
      throw new Error('Webhook verification failed: webhookSecret is not configured.');
    }

    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      throw new Error('Webhook verification failed: invalid signature header format. Expected sha256=...');
    }

    const actualSignature = signatureHeader.replace('sha256=', '');
    // The gateway signs the delivery timestamp into the body and reuses it on every retry,
    // so a retried delivery legitimately arrives with an older timestamp. The default window
    // therefore covers the gateway's whole retry schedule (backoffs up to 1 hour); without
    // that, a legitimate retry is rejected as a replay. Replay of the SAME delivery is
    // still caught by deduplicating on the delivery id.
    const toleranceMs = Number.isFinite(opts.toleranceMs) ? opts.toleranceMs : 2 * 60 * 60 * 1000;

    // Validate timestamp header freshness if supplied (or explicitly required via 4-arg call)
    if (timestampHeader !== null || options !== null) {
      const tsNum = Number(timestampHeader);
      if (!timestampHeader || !Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > toleranceMs) {
        throw new Error('Webhook verification failed: timestamp missing or outside tolerance window.');
      }
    }

    const matchesRawBody = verifyHmac(rawPayloadString, secret, actualSignature);
    const matchesTimestampedBody = timestampHeader !== null &&
      verifyHmac(`${timestampHeader}.${rawPayloadString}`, secret, actualSignature);

    if (!matchesRawBody && !matchesTimestampedBody) {
      throw new Error('Webhook verification failed: signature mismatch.');
    }

    const parsed = JSON.parse(rawPayloadString);

    // If the signed JSON payload embeds a timestamp (standard for WebhookEngine), verify its freshness
    // and ensure any X-Gateway-Timestamp header matches the signed payload timestamp.
    if (parsed && parsed.timestamp !== undefined && parsed.timestamp !== null) {
      const bodyTs = Number(parsed.timestamp);
      if (!Number.isFinite(bodyTs) || Math.abs(Date.now() - bodyTs) > toleranceMs) {
        throw new Error('Webhook verification failed: signed payload timestamp outside tolerance window.');
      }
      if (timestampHeader !== null && String(timestampHeader).trim() !== String(parsed.timestamp).trim()) {
        throw new Error('Webhook verification failed: timestamp header does not match signed payload timestamp.');
      }
    } else if (timestampHeader !== null && !matchesTimestampedBody) {
      // If the JSON body did not contain a signed timestamp, a caller verifying a timestampHeader
      // must have the timestamp bound into `${timestamp}.${rawBody}` unless opts.allowUnsignedTimestampHeader is set.
      if (!opts.allowUnsignedTimestampHeader) {
        throw new Error('Webhook verification failed: timestamp is not bound by signature.');
      }
    }

    if (opts.deliveryId && parsed && parsed.deliveryId && String(opts.deliveryId) !== String(parsed.deliveryId)) {
      throw new Error('Webhook verification failed: deliveryId header does not match signed payload deliveryId.');
    }

    return parsed;
  }
}
