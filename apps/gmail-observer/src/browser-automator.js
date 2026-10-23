import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserLauncher } from '@youpi/observer-sdk';
import { getObserverToken } from '@youpi/common';
import { BankEmailParser } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

export class GmailBrowserAutomator {
  /**
   * @param {{
   *   gmailPoller: import('./gmail-poller.js').GmailPoller,
   *   debuggingPort?: number
   * }} options
   */
  constructor(options) {
    this.gmailPoller = options.gmailPoller;
    this.apiBaseUrl = options.apiBaseUrl || process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.debuggingPort = options.debuggingPort || 9223;
    this.profileDir = path.join(rootDir, 'data/browser-sessions/gmail');
    this.stateFilePath = path.join(this.profileDir, 'login-state.json');
    this.targetUrl = 'https://mail.google.com';

    this.visibleProcess = null;
    this.backgroundProcess = null;
    this.browserProcess = null;
    this.isLoggedIn = this.loadStoredLoginState();
    this.mode = 'STANDBY'; // 'BACKGROUND' | 'VISIBLE' | 'STANDBY'
    this.checkTimer = null;
    this.extractionTimer = null;
    this.lastCheckedAt = null;
    this.lastEmailAt = null;
    this.emailsObserved = 0;
    this.processedHashes = new Set();
    this.isEnsuring = false;
  }

  async fetchActivePaymentAmounts() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/pollers/active-window`, {
        headers: { 'Authorization': `Bearer ${getObserverToken()}` },
        signal: AbortSignal.timeout(1500)
      });
      if (res.ok) {
        const data = await res.json();
        return data.sessions || [];
      }
    } catch {}
    return [];
  }

  loadStoredLoginState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
        return Boolean(data.loggedIn);
      }
    } catch {}
    return false;
  }

  saveStoredLoginState(loggedIn) {
    try {
      if (!fs.existsSync(this.profileDir)) {
        fs.mkdirSync(this.profileDir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify({ loggedIn, updatedAt: new Date().toISOString() }));
    } catch {}
    this.isLoggedIn = loggedIn;
  }

  /**
   * Automatically ensures connection:
   * - If already logged in: launches invisible background browser and starts inbox extraction.
   * - If not logged in / disconnected: automatically launches visible browser window for Google login.
   */
  async autoEnsureConnection() {
    if (this.isEnsuring) return this.getStatus();
    if (process.env.ENABLE_LEGACY_CHROME_OBSERVERS !== 'true') return this.getStatus();
    this.isEnsuring = true;

    try {
      const targets = await BrowserLauncher.getTargets(this.debuggingPort);
      const active = targets.find(t => t.url && t.url.includes('mail.google.com'));

      if (active) {
        this.lastCheckedAt = new Date();
        const isRealInbox = active.url.includes('mail.google.com/mail') &&
          (active.url.includes('#inbox') || active.url.includes('#all') || (active.title && active.title.includes('Inbox'))) &&
          !active.url.includes('accounts.google.com') &&
          !active.url.includes('signin') &&
          !active.url.includes('ServiceLogin');

        if (isRealInbox) {
          this.isLoggedIn = true;
          this.saveStoredLoginState(true);
          this.mode = 'BACKGROUND';
          this.startExtractionLoop();
          return this.getStatus();
        } else {
          this.isLoggedIn = false;
          this.mode = 'VISIBLE';
          this.startStateMonitor();
          return this.getStatus();
        }
      }

      // No browser currently running on port: check stored state
      if (this.isLoggedIn) {
        console.log('[Gmail Browser Automator] Existing login session detected. Launching invisible background browser...');
        this.launchBackgroundObserver();
        this.mode = 'BACKGROUND';
      } else {
        console.log('[Gmail Browser Automator] No active login session detected. Automatically launching visible window for Gmail login...');
        this.launchLoginWindow();
        this.mode = 'VISIBLE';
      }
    } catch (err) {
      console.error('[Gmail Browser Automator] autoEnsureConnection error:', err);
    } finally {
      this.isEnsuring = false;
    }

    return this.getStatus();
  }

  /**
   * Launches the real visible Chrome window for the user to log into Gmail.
   */
  launchLoginWindow() {
    if (process.env.ENABLE_LEGACY_CHROME_OBSERVERS !== 'true') {
      return {
        success: false,
        launched: false,
        reason: 'Legacy Chrome observer is disabled in production profile. Use Gmail API OAuth.'
      };
    }

    this.mode = 'VISIBLE';
    this.browserProcess = BrowserLauncher.launch({
      url: this.targetUrl,
      profileDir: this.profileDir,
      debuggingPort: this.debuggingPort,
      minimized: false // Visible window for user to sign in
    });

    this.startStateMonitor();

    return {
      success: true,
      status: 'AWAITING_LOGIN',
      mode: 'VISIBLE',
      debuggingPort: this.debuggingPort,
      profileDir: this.profileDir,
      instructions: 'A Gmail browser window has opened. Log in with your Google account. Your session will be securely saved locally.'
    };
  }

  launchBackgroundObserver() {
    this.mode = 'BACKGROUND';
    this.browserProcess = BrowserLauncher.launch({
      url: 'https://mail.google.com/mail/u/0/#inbox',
      profileDir: this.profileDir,
      debuggingPort: this.debuggingPort,
      minimized: true // Launches offscreen at position -2400,-2400
    });

    this.startStateMonitor();
    this.startExtractionLoop();
  }

  /**
   * Monitors the browser CDP target to detect when user reaches the inbox.
   * If login completes in visible window: auto-closes visible window and switches to quiet background process.
   * If session expires: opens visible window for re-login.
   */
  startStateMonitor() {
    if (this.checkTimer) clearInterval(this.checkTimer);

    this.checkTimer = setInterval(async () => {
      try {
        const targets = await BrowserLauncher.getTargets(this.debuggingPort);
        const gmailTarget = targets.find(t => t.url && t.url.includes('mail.google.com'));

        if (gmailTarget) {
          this.lastCheckedAt = new Date();

          const isRealInbox = gmailTarget.url.includes('mail.google.com/mail') &&
            (gmailTarget.url.includes('#inbox') || gmailTarget.url.includes('#all') || (gmailTarget.title && gmailTarget.title.includes('Inbox'))) &&
            !gmailTarget.url.includes('accounts.google.com') &&
            !gmailTarget.url.includes('signin') &&
            !gmailTarget.url.includes('ServiceLogin');

          if (isRealInbox && !this.isLoggedIn) {
            this.saveStoredLoginState(true);
            console.log('[Gmail Browser Automator] Login confirmed! Closing visible window and switching to invisible background observer...');

            if (gmailTarget.id) {
              await BrowserLauncher.closeTarget(this.debuggingPort, gmailTarget.id);
            }

            setTimeout(() => {
              this.launchBackgroundObserver();
            }, 1200);
          } else if (!isRealInbox && this.isLoggedIn) {
            this.saveStoredLoginState(false);
            console.log('[Gmail Browser Automator] Session expired. Opening visible window for Gmail login...');
            if (gmailTarget.id) {
              await BrowserLauncher.closeTarget(this.debuggingPort, gmailTarget.id);
            }
            setTimeout(() => {
              this.launchLoginWindow();
            }, 1200);
          }
        }
      } catch {
        // Target busy or initializing
      }
    }, 2000);
    if (this.checkTimer.unref) this.checkTimer.unref();
  }

  /**
   * Continuous background extraction loop for Gmail inbox credit alerts.
   */
  startExtractionLoop() {
    if (this.extractionTimer) clearInterval(this.extractionTimer);

    this.extractionTimer = setInterval(async () => {
      try {
        await this.pollInboxEmails();
      } catch {
        // Session idle or updating
      }
    }, 3000);
    if (this.extractionTimer.unref) this.extractionTimer.unref();
  }

  async pollInboxEmails() {
    if (this._isPollingInbox) return;
    this._isPollingInbox = true;

    try {
      const targets = await BrowserLauncher.getTargets(this.debuggingPort);
    const target = targets.find(t => (t.type === 'page' || !t.type) && t.url && t.url.includes('mail.google.com') && t.webSocketDebuggerUrl)
      || targets.find(t => t.url && t.url.includes('mail.google.com') && t.webSocketDebuggerUrl);
    if (!target) return;

    this.lastCheckedAt = new Date();

    // Fetch active payment sessions currently waiting for payment or in verification
    const activeSessions = await this.fetchActivePaymentAmounts();
    const targetAmounts = activeSessions.map(s => s.amount);

    // Universal DOM evaluation: deeply inspects inbox table rows, open emails, and body lines
    const script = `
      (() => {
        const results = [];
        const amounts = ${JSON.stringify(targetAmounts)};

        // Periodically trigger Gmail refresh button to immediately load new incoming emails
        try {
          const refreshBtn = document.querySelector('div[aria-label*="Refresh"], div[data-tooltip*="Refresh"], div[act="20"]');
          if (refreshBtn && Math.random() < 0.35) { refreshBtn.click(); }
        } catch {}

        // 1. Deeply scan all inbox email rows
        const rows = document.querySelectorAll('tr.zA, div[role="main"] tr, table.F tr');
        for (const row of rows) {
          const text = (row.innerText || row.textContent || '').trim();
          if (!text) continue;

          let hasTargetAmount = false;
          for (const amt of amounts) {
            const intVal = String(Math.floor(Number(amt)));
            if (text.includes(amt) || text.includes(intVal)) {
              hasTargetAmount = true;
              break;
            }
          }

          if (hasTargetAmount || /(credited|received|deposit|upi|utr|rs\\.?|inr|₹)/i.test(text)) {
            const subjectEl = row.querySelector('.bog, .bqe, span[data-thread-id]');
            const snippetEl = row.querySelector('.y2');
            results.push({
              subject: subjectEl ? (subjectEl.innerText || subjectEl.textContent || '') : 'Payment Notification',
              body: text,
              date: new Date().toISOString()
            });
          }
        }

        // 2. Scan open email view or full document text
        const bodyText = (document.body.innerText || '');
        const lines = bodyText.split('\\n');
        for (const line of lines) {
          const text = line.trim();
          if (!text) continue;

          let hasTargetAmount = false;
          for (const amt of amounts) {
            const intVal = String(Math.floor(Number(amt)));
            if (text.includes(amt) || text.includes(intVal)) {
              hasTargetAmount = true;
              break;
            }
          }

          if (hasTargetAmount || (text.length > 5 && /(credited|received|deposit|upi|utr|rs\\.?|inr|₹)/i.test(text))) {
            results.push({
              subject: 'Bank Credit Notification',
              body: text,
              date: new Date().toISOString()
            });
          }
        }

        return results.slice(0, 20);
      })()
    `;

    const extracted = await BrowserLauncher.evaluate(target.webSocketDebuggerUrl, script);
    if (Array.isArray(extracted) && extracted.length > 0) {
      for (const email of extracted) {
        const hash = (email.subject + email.body).substring(0, 80);
        if (!this.processedHashes.has(hash)) {
          this.processedHashes.add(hash);
          if (this.processedHashes.size > 200) {
            const first = this.processedHashes.values().next().value;
            this.processedHashes.delete(first);
          }

          // 1. Try standard bank email parser
          let parsed = BankEmailParser.parse(email);

          // 2. Intelligent Active Window Fallback:
          // If customer sent custom/dummy email (e.g. "20.00 received" or body contains "20.00")
          // match it directly against the active payment window running right now!
          if (!parsed && activeSessions.length > 0) {
            for (const s of activeSessions) {
              const intVal = String(Math.floor(Number(s.amount)));
              const matchAmount = email.body.includes(s.amount) || email.body.includes(intVal) ||
                                  email.subject.includes(s.amount) || email.subject.includes(intVal);
              if (matchAmount) {
                parsed = {
                  amountPaise: BigInt(s.amountPaise),
                  amount: s.amount,
                  observedAt: new Date(),
                  rawSnippet: email.body.substring(0, 300)
                };
                break;
              }
            }
          }

          if (parsed) {
            console.log(`[Gmail Browser Automator] Extracted incoming payment email: ₹${parsed.amount} (Ref: ${parsed.bankReferenceNumber || 'NONE'})`);
            await this.gmailPoller.processEmail({
              subject: email.subject,
              body: email.body,
              date: new Date(),
              from: email.from || 'alerts@retail.bank.in'
            });
            this.emailsObserved++;
            this.lastEmailAt = new Date();
          }
        }
      }
    }
  } finally {
    this._isPollingInbox = false;
  }
  }

  getStatus() {
    let statusText = 'STANDBY';
    if (this.isLoggedIn) {
      statusText = 'CONNECTED';
    } else if (this.mode === 'VISIBLE' || (this.lastCheckedAt && (Date.now() - this.lastCheckedAt.getTime() < 10000))) {
      statusText = 'AWAITING_LOGIN';
    }

    return {
      service: 'gmail-browser-session',
      isLoggedIn: this.isLoggedIn,
      status: statusText,
      mode: this.mode,
      emailsObserved: this.emailsObserved,
      lastCheckedAt: this.lastCheckedAt,
      lastEmailAt: this.lastEmailAt,
      profileDir: this.profileDir,
      debuggingPort: this.debuggingPort
    };
  }

  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.extractionTimer) {
      clearInterval(this.extractionTimer);
      this.extractionTimer = null;
    }
  }
}
