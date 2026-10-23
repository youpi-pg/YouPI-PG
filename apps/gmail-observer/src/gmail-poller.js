import { PaymentObserverClient } from '@youpi/observer-sdk';
import { getObserverToken } from '@youpi/common';
import { BankEmailParser } from './parser.js';

function extractBodyFromGmailPayload(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, 'base64url').toString('utf8');
    } catch {}
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64url').toString('utf8');
        } catch {}
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        try {
          const html = Buffer.from(part.body.data, 'base64url').toString('utf8');
          return html.replace(/<[^>]+>/g, ' ');
        } catch {}
      }
    }
    for (const part of payload.parts) {
      if (part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64url').toString('utf8');
        } catch {}
      }
    }
  }
  return '';
}

export class GmailPoller {
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
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.GMAIL_POLL_INTERVAL_MS || 5000);
    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GMAIL'
    });

    this.isRunning = false;
    this.timer = null;
    this.lastPollAt = null;
    this.observedCount = 0;
    this.credentials = null;
    this.cachedAccessToken = null;
    this.tokenExpiresAt = 0;
    this.processedMessageIds = new Set();
  }

  setCredentials(creds) {
    this.credentials = { ...(this.credentials || {}), ...creds };
  }

  async fetchCredentialsFromPaymentApi() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/admin/gmail/credentials`, { headers: { Authorization: `Bearer ${getObserverToken()}` } });
      if (res.ok) {
        const data = await res.json();
        const conf = data.gmailConfig || data;
        if (conf.refreshToken || conf.clientId) {
          this.setCredentials({
            clientId: conf.clientId,
            clientSecret: conf.clientSecret,
            refreshToken: conf.refreshToken,
            connectedEmail: conf.connectedEmail
          });
        }
      }
    } catch {}
  }

  async getAccessToken() {
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedAccessToken;
    }

    if (!this.credentials?.refreshToken || !this.credentials?.clientId || !this.credentials?.clientSecret) {
      await this.fetchCredentialsFromPaymentApi();
    }

    const { clientId, clientSecret, refreshToken } = this.credentials || {};
    if (!clientId || !clientSecret || !refreshToken) return null;

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (!tokenRes.ok) {
        return null;
      }

      const tokenData = await tokenRes.json();
      this.cachedAccessToken = tokenData.access_token;
      this.tokenExpiresAt = Date.now() + ((tokenData.expires_in || 3500) - 120) * 1000;
      return this.cachedAccessToken;
    } catch (err) {
      console.warn('[Gmail Observer] Failed to refresh Google access token:', err.message);
      return null;
    }
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
   * Ingests an email directly (e.g. from webhook, push notification, or manual poll).
   * @param {{ subject: string, body: string, date?: string | Date, from?: string, id?: string }} email
   */
  async processEmail(email) {
    let parsed = null;
    try {
      parsed = BankEmailParser.parse(email);
    } catch {}

    let targetAccountId = this.receivingAccountId;
    try {
      const activeAcct = await this.resolveActiveReceivingAccount();
      if (activeAcct) targetAccountId = activeAcct;
    } catch {}

    const sender = email.from || email.sender || 'alerts@retail.bank.in';
    const rawContent = `${email.subject || ''}\n${email.body || ''}`.trim();

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: targetAccountId,
        amountPaise: parsed ? parsed.amountPaise : undefined,
        amount: parsed ? parsed.amount : undefined,
        observedAt: email.date ? new Date(email.date) : new Date(),
        bankReferenceNumber: parsed?.bankReferenceNumber,
        senderVpa: parsed?.senderVpa,
        sender,
        rawText: rawContent,
        rawPayload: {
          messageId: email.id || email.messageId || `gmail_${Date.now()}`,
          subject: email.subject || '',
          body: email.body || '',
          snippet: parsed?.rawSnippet || (email.body || '').substring(0, 200),
          from: sender,
          sender,
          source: 'GMAIL',
          internalDate: email.internalDate || (email.date ? new Date(email.date).getTime() : Date.now())
        }
      });

      this.observedCount++;
      return result;
    } catch (err) {
      console.error('[Gmail Observer] Submission failed:', err.message);
      throw err;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Gmail Observer] Poller started (interval: ${this.pollIntervalMs}ms)`);

    // Run first poll cycle immediately
    this.pollCycle().catch(() => {});

    this.timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this._isPolling = false;
    console.log('[Gmail Observer] Poller stopped.');
  }

  async pollCycle() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      this.lastPollAt = new Date();
      const accessToken = await this.getAccessToken();
      if (!accessToken) return;

      const query = encodeURIComponent('subject:(credit OR credited OR received OR upi OR deposit OR alert)');
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${query}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      });

      if (!listRes.ok) {
        if (listRes.status === 401) {
          this.cachedAccessToken = null;
        }
        return;
      }

      const listData = await listRes.json();
      const messages = listData.messages || [];

      for (const m of messages) {
        if (this.processedMessageIds.has(m.id)) continue;

        try {
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(8000)
          });
          if (!msgRes.ok) continue;

          const msgData = await msgRes.json();
          const headers = msgData.payload?.headers || [];
          const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
          const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
          const dateStr = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
          const body = extractBodyFromGmailPayload(msgData.payload) || msgData.snippet || '';

          await this.processEmail({
            id: m.id,
            messageId: m.id,
            subject,
            body,
            from,
            date: dateStr ? new Date(dateStr) : new Date(Number(msgData.internalDate || Date.now()))
          });

          this.processedMessageIds.add(m.id);
          if (this.processedMessageIds.size > 500) {
            const firstKey = this.processedMessageIds.values().next().value;
            this.processedMessageIds.delete(firstKey);
          }
        } catch (msgErr) {
          console.warn(`[Gmail Observer] Error fetching message ${m.id}:`, msgErr.message);
        }
      }
    } catch (err) {
      console.warn('[Gmail Observer] pollCycle error:', err.message);
    } finally {
      this._isPolling = false;
    }
  }
}
