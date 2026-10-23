import { generateHmac, getObserverToken } from '@youpi/common';

export class PaymentObserverClient {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   sourceName: string
   * }} options
   */
  constructor(options) {
    this.apiBaseUrl = (options.apiBaseUrl || process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100').replace(/\/+$/, '');
    this.sourceName = options.sourceName;
  }

  /**
   * Submits a normalized or semi-normalized observation to Payment Core.
   * @param {{
   *   receivingAccountId: string,
   *   amountPaise?: bigint | number,
   *   amount?: string | number,
   *   observedAt?: Date | string,
   *   senderVpa?: string,
   *   bankReferenceNumber?: string,
   *   rawPayload?: Record<string, any>
   * }} data
   * @returns {Promise<{ accepted: boolean, observationId: string, attribution: any }>}
   */
  async submitObservation(data) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/events`;
    const payload = {
      source: this.sourceName,
      receivingAccountId: data.receivingAccountId,
      amountPaise: data.amountPaise !== undefined ? data.amountPaise.toString() : undefined,
      amount: data.amount,
      observedAt: (data.observedAt instanceof Date ? data.observedAt : new Date(data.observedAt || Date.now())).toISOString(),
      senderVpa: data.senderVpa,
      bankReferenceNumber: data.bankReferenceNumber,
      sender: data.sender || data.rawPayload?.sender || data.rawPayload?.from,
      rawText: data.rawText || data.rawPayload?.text || data.rawPayload?.body,
      rawPayload: data.rawPayload || {}
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getObserverToken()}` },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Observer submit failed [HTTP ${res.status}]: ${errBody}`);
    }

    return await res.json();
  }

  /**
   * Fetches active window sessions from payment core with observer bearer authentication.
   * @returns {Promise<Array<any>>}
   */
  async getActiveWindow() {
    const url = `${this.apiBaseUrl}/api/v1/pollers/active-window`;
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${getObserverToken()}` },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const data = await res.json();
        return data.sessions || [];
      }
    } catch {}
    return [];
  }

  /**
   * Submits signed observation from Android Observer with HMAC-SHA256 signature.
   * @param {{
   *   deviceId: string,
   *   signingKey: string,
   *   receivingAccountId?: string,
   *   amount?: string | number,
   *   amountPaise?: bigint | number,
   *   observedAt?: Date | string,
   *   rawNotification?: Record<string, any>
   * }} data
   */
  async submitAndroidSigned(data) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/events`;
    const timestamp = Date.now().toString();

    const bodyObj = {
      deviceId: data.deviceId,
      receivingAccountId: data.receivingAccountId,
      amount: data.amount,
      amountPaise: data.amountPaise !== undefined ? data.amountPaise.toString() : undefined,
      observedAt: (data.observedAt instanceof Date ? data.observedAt : new Date(data.observedAt || Date.now())).toISOString(),
      rawNotification: data.rawNotification || {}
    };

    const bodyString = JSON.stringify(bodyObj);
    const sigPayload = `${bodyString}:${timestamp}`;
    const signature = generateHmac(sigPayload, data.signingKey);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': data.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: bodyString
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Android observation submit failed [HTTP ${res.status}]: ${errBody}`);
    }

    return await res.json();
  }

  /**
   * Submits Android heartbeat.
   * @param {string} deviceId
   */
  async submitHeartbeat(deviceId) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/heartbeat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId
      },
      body: JSON.stringify({ deviceId })
    });
    return await res.json();
  }
}
