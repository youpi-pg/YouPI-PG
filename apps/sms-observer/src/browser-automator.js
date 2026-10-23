import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserLauncher } from '@youpi/observer-sdk';
import { getObserverToken } from '@youpi/common';
import { BankSmsParser } from './sms-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

export class GoogleMessagesAutomator {
  /**
   * @param {{
   *   smsService: import('./sms-service.js').SmsObserverService,
   *   debuggingPort?: number
   * }} options
   */
  constructor(options) {
    this.smsService = options.smsService;
    this.apiBaseUrl = options.apiBaseUrl || process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.debuggingPort = options.debuggingPort || 9222;
    this.profileDir = path.join(rootDir, 'data/browser-sessions/google-messages');
    this.stateFilePath = path.join(this.profileDir, 'pairing-state.json');
    this.targetUrl = 'https://messages.google.com/web/authentication';

    this.visibleProcess = null;
    this.backgroundProcess = null;
    this.browserProcess = null;
    this.isPaired = this.loadStoredPairedState();
    this.mode = 'STANDBY'; // 'BACKGROUND' | 'VISIBLE' | 'STANDBY'
    this.checkTimer = null;
    this.extractionTimer = null;
    this.lastSeenAt = null;
    this.lastMessageAt = null;
    this.messagesObserved = 0;
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

  loadStoredPairedState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
        return Boolean(data.paired);
      }
    } catch {}
    return false;
  }

  saveStoredPairedState(paired) {
    try {
      if (!fs.existsSync(this.profileDir)) {
        fs.mkdirSync(this.profileDir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify({ paired, updatedAt: new Date().toISOString() }));
    } catch {}
    this.isPaired = paired;
  }

  /**
   * Automatically ensures connection:
   * - If already paired: launches invisible background browser and starts polling.
   * - If disconnected/unpaired: automatically launches visible pairing window for user to scan QR.
   */
  async autoEnsureConnection() {
    if (this.isEnsuring) return this.getStatus();
    if (process.env.ENABLE_LEGACY_CHROME_OBSERVERS !== 'true') return this.getStatus();
    this.isEnsuring = true;

    try {
      const targets = await BrowserLauncher.getTargets(this.debuggingPort);
      const active = targets.find(t => t.url && t.url.includes('messages.google.com'));

      if (active) {
        this.lastSeenAt = new Date();
        const isPairedUrl = (!active.url.includes('/authentication') && active.url.includes('/web'));
        if (isPairedUrl) {
          this.isPaired = true;
          this.saveStoredPairedState(true);
          this.mode = 'BACKGROUND';
          this.startExtractionLoop();
          return this.getStatus();
        } else {
          this.isPaired = false;
          this.mode = 'VISIBLE';
          this.startStateMonitor();
          return this.getStatus();
        }
      }

      // No browser running currently: check stored pairing state
      if (this.isPaired) {
        console.log('[Google Messages Automator] Existing pairing detected. Launching invisible background browser...');
        this.launchBackgroundObserver();
        this.mode = 'BACKGROUND';
      } else {
        console.log('[Google Messages Automator] No pairing detected. Automatically launching visible window for QR pairing...');
        this.launchPairingWindow();
        this.mode = 'VISIBLE';
      }
    } catch (err) {
      console.error('[Google Messages Automator] autoEnsureConnection error:', err);
    } finally {
      this.isEnsuring = false;
    }

    return this.getStatus();
  }

  /**
   * Opens the visible Google Messages Web pairing browser window on the host.
   */
  launchPairingWindow() {
    if (process.env.ENABLE_LEGACY_CHROME_OBSERVERS !== 'true') {
      return {
        success: false,
        launched: false,
        reason: 'Legacy Chrome observer is disabled in production profile. Use Android APK.'
      };
    }

    this.mode = 'VISIBLE';
    this.browserProcess = BrowserLauncher.launch({
      url: this.targetUrl,
      profileDir: this.profileDir,
      debuggingPort: this.debuggingPort,
      minimized: false // Visible window for user to scan QR code
    });

    this.startStateMonitor();

    return {
      success: true,
      status: 'AWAITING_PAIRING',
      mode: 'VISIBLE',
      debuggingPort: this.debuggingPort,
      profileDir: this.profileDir,
      instructions: 'A Google Messages browser window has opened. On your Android phone, open Google Messages > Device Pairing > Scan QR code.'
    };
  }

  launchBackgroundObserver() {
    this.mode = 'BACKGROUND';
    this.browserProcess = BrowserLauncher.launch({
      url: 'https://messages.google.com/web',
      profileDir: this.profileDir,
      debuggingPort: this.debuggingPort,
      minimized: true // Launches offscreen at position -2400,-2400
    });

    this.startStateMonitor();
    this.startExtractionLoop();
  }

  /**
   * Monitors the browser CDP target to detect when pairing completes.
   * If pairing completes in visible window: auto-closes visible window and switches to quiet background process.
   * If background process gets unlinked: immediately triggers visible window for pairing.
   */
  startStateMonitor() {
    if (this.checkTimer) clearInterval(this.checkTimer);

    this.checkTimer = setInterval(async () => {
      try {
        const targets = await BrowserLauncher.getTargets(this.debuggingPort);
        const msgTarget = targets.find(t => t.url && t.url.includes('messages.google.com'));

        if (msgTarget) {
          this.lastSeenAt = new Date();

          const isPairedUrl = (!msgTarget.url.includes('/authentication') && msgTarget.url.includes('/web'));

          if (isPairedUrl && !this.isPaired) {
            // User just scanned QR in visible window!
            this.saveStoredPairedState(true);
            console.log('[Google Messages Automator] Pairing confirmed! Closing visible window and switching to invisible background observer...');

            // Automatically close the visible pairing window
            if (msgTarget.id) {
              await BrowserLauncher.closeTarget(this.debuggingPort, msgTarget.id);
            }

            // Launch quiet background process
            setTimeout(() => {
              this.launchBackgroundObserver();
            }, 1200);
          } else if (!isPairedUrl && this.isPaired) {
            // Unpaired / session expired: switch to visible window!
            this.saveStoredPairedState(false);
            console.log('[Google Messages Automator] Session unlinked. Opening visible pairing window...');
            if (msgTarget.id) {
              await BrowserLauncher.closeTarget(this.debuggingPort, msgTarget.id);
            }
            setTimeout(() => {
              this.launchPairingWindow();
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
   * Continuous background extraction loop for Google Messages SMS conversations.
   */
  startExtractionLoop() {
    if (this.extractionTimer) clearInterval(this.extractionTimer);

    this.extractionTimer = setInterval(async () => {
      try {
        await this.pollRecentMessages();
      } catch (err) {
        // Target busy or updating
      }
    }, 3000);
    if (this.extractionTimer.unref) this.extractionTimer.unref();
  }

  async pollRecentMessages() {
    if (this._isPollingMessages) return;
    this._isPollingMessages = true;

    try {
      const targets = await BrowserLauncher.getTargets(this.debuggingPort);
    const target = targets.find(t => (t.type === 'page' || !t.type) && t.url && t.url.includes('messages.google.com') && t.webSocketDebuggerUrl)
      || targets.find(t => t.url && t.url.includes('messages.google.com') && t.webSocketDebuggerUrl);
    if (!target) return;

    this.lastSeenAt = new Date();

    // Fetch active payment sessions currently in progress
    const activeSessions = await this.fetchActivePaymentAmounts();
    const targetAmounts = activeSessions.map(s => s.amount);

    // Universal DOM evaluation: deeply inspects conversation previews, chat bubbles, and full text
    const script = `
      (() => {
        const results = [];
        const amounts = ${JSON.stringify(targetAmounts)};

        // 1. Scan conversation snippets and message wrappers
        const items = document.querySelectorAll('mws-conversation-list-item, mws-message-wrapper, .snippet-text, .text-content, .message-content');
        for (const item of items) {
          const text = (item.innerText || item.textContent || '').trim();
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
            results.push(text);
          }
        }

        // 2. Scan full document body text lines
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
            results.push(text);
          }
        }

        return results.slice(0, 20);
      })()
    `;

    const extracted = await BrowserLauncher.evaluate(target.webSocketDebuggerUrl, script);
    if (Array.isArray(extracted) && extracted.length > 0) {
      for (const rawText of extracted) {
        const hash = rawText.substring(0, 80);
        if (!this.processedHashes.has(hash)) {
          this.processedHashes.add(hash);
          if (this.processedHashes.size > 200) {
            const first = this.processedHashes.values().next().value;
            this.processedHashes.delete(first);
          }

          // 1. Try standard bank SMS parser
          let parsed = BankSmsParser.parse({ text: rawText });

          // 2. Intelligent Active Window Fallback:
          // If message contains the active session's exact amount, match it directly!
          if (!parsed && activeSessions.length > 0) {
            for (const s of activeSessions) {
              const intVal = String(Math.floor(Number(s.amount)));
              if (rawText.includes(s.amount) || rawText.includes(intVal)) {
                parsed = {
                  amountPaise: BigInt(s.amountPaise),
                  amount: s.amount,
                  observedAt: new Date(),
                  rawText
                };
                break;
              }
            }
          }

          if (parsed) {
            console.log(`[Google Messages Automator] Extracted incoming payment SMS: ₹${parsed.amount} (Ref: ${parsed.bankReferenceNumber || 'NONE'})`);
            await this.smsService.processSms({
              text: rawText,
              sender: 'Google-Messages-Web',
              timestamp: new Date()
            });
            this.messagesObserved++;
            this.lastMessageAt = new Date();
          }
        }
      }
    }
  } finally {
    this._isPollingMessages = false;
  }
  }

  getStatus() {
    let statusText = 'STANDBY';
    const isLive = Boolean(this.lastSeenAt && (Date.now() - new Date(this.lastSeenAt).getTime() < 300000));
    if (this.isPaired && this.mode === 'BACKGROUND' && isLive) {
      statusText = 'CONNECTED';
    } else if (this.mode === 'VISIBLE' || (this.lastSeenAt && (Date.now() - new Date(this.lastSeenAt).getTime() < 10000))) {
      statusText = 'AWAITING_PAIRING';
    } else {
      statusText = 'STANDBY';
    }

    return {
      service: 'google-messages-web',
      isPaired: Boolean(this.isPaired),
      status: statusText,
      mode: this.mode,
      messagesObserved: this.messagesObserved,
      lastSeenAt: this.lastSeenAt,
      lastMessageAt: this.lastMessageAt,
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
