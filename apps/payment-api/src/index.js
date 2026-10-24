import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentStatus } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_CHECKOUT_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(rootDir, '.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}
import {
  getDatabase,
  ensureDatabaseInitialized,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  CustomerRepository,
  CustomerSessionRepository,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  DeviceRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  WebhookEngine,
  PaymentVerificationPipeline
} from '@youpi/core';
import { HttpServer } from './server.js';
import { authGuard } from './auth-guard.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerCheckoutRoutes } from './routes/checkout.routes.js';
import { registerPollerRoutes } from './routes/pollers.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';
import { registerDeviceRoutes } from './routes/device.routes.js';
import { getWhatsAppBerryService, WhatsAppBerryService } from './services/whatsapp-berry.service.js';
import { ObserverPollerService } from './services/observer-poller.service.js';

export function createPaymentApp(customDb = null, options = {}) {
  const db = customDb || getDatabase();
  ensureDatabaseInitialized(db);
  const { defaultMerchant } = runMigrations(db);
  const isCustom = !!customDb;
  const whatsappBerryService = options.whatsappBerryService || (isCustom ? new WhatsAppBerryService({
    sessionId: 'test_berry_session',
    sessionPath: path.resolve(rootDir, 'data/test_berry_auth'),
    databasePath: path.resolve(rootDir, 'data/test_berry_store.db'),
    metaFile: path.resolve(rootDir, 'data/test_whatsapp_session.json')
  }) : getWhatsAppBerryService());

  const merchantRepo = new MerchantRepository(db);
  const accountRepo = new ReceivingAccountRepository(db);
  const customerRepo = new CustomerRepository(db);
  const customerSessionRepo = new CustomerSessionRepository(db, customerRepo);
  const sessionRepo = new PaymentSessionRepository(db);
  const obsRepo = new ObservationRepository(db);
  const ticketRepo = new SupportTicketRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const deviceRepo = new DeviceRepository(db);

  const eventEmitter = new EventEmitter();

  // The active window and the processing window drive the slot expiry that is written to
  // the database, so a malformed value must not reach it: a negative value would expire
  // every session instantly and Infinity would throw a RangeError on toISOString().
  const parseWindowMs = (raw, fallback, label) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 24 * 60 * 60 * 1000) {
      console.warn(`[config] Ignoring invalid ${label}=${raw}; using ${fallback}ms.`);
      return fallback;
    }
    return Math.floor(value);
  };
  const activeDurationMs = parseWindowMs(process.env.PAYMENT_ACTIVE_WINDOW_MS, 300000, 'PAYMENT_ACTIVE_WINDOW_MS');
  const processingDurationMs = parseWindowMs(process.env.PAYMENT_PROCESSING_WINDOW_MS, 30000, 'PAYMENT_PROCESSING_WINDOW_MS');

  const queueEngine = new QueueEngine({
    sessionRepo,
    accountRepo,
    eventEmitter,
    auditRepo,
    activeDurationMs,
    processingDurationMs
  });

  const timingEngine = new TimingEngine({
    sessionRepo,
    queueEngine,
    eventEmitter,
    auditRepo,
    activeDurationMs,
    processingDurationMs
  });

  const attributionEngine = new AttributionEngine({
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    eventEmitter
  });

  const webhookEngine = new WebhookEngine({
    db,
    merchantRepo,
    maxRetries: Number(process.env.WEBHOOK_MAX_RETRIES || 5)
  });

  const recoveryEngine = new RecoveryEngine({
    db,
    sessionRepo,
    accountRepo,
    queueEngine,
    timingEngine,
    webhookEngine,
    auditRepo,
    eventEmitter
  });

  const server = new HttpServer();
  server.use(authGuard);
  let checkoutBaseUrl = process.env.BASE_CHECKOUT_URL || 'http://localhost:7000';
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      const raw = fs.readFileSync(rootEnv, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('BASE_CHECKOUT_URL=')) {
          const val = trimmed.split('=')[1]?.trim();
          if (val) checkoutBaseUrl = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {}

  // BULLETPROOF QUEUE PROMOTION HANDLER
  function handleSlotFreedAndPromote(receivingAccountId) {
    if (!receivingAccountId) return null;
    const promoted = queueEngine.promoteNext(receivingAccountId);
    if (promoted) {
      if (promoted.expiresAt) {
        timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
      server.broadcastSse(promoted.id, 'status_change', {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt: promoted.expiresAt
      });
      server.broadcastSse(`queue_${receivingAccountId}`, 'queue_update', {
        promotedId: promoted.id
      });
    }
    return promoted;
  }

  // When a payment succeeds, fails, expires, or cancels: dispatch webhook & promote next queued customer
  eventEmitter.on('PAYMENT.SUCCESS', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.SUCCESS,
        verificationLevel: data.verificationLevel || session.verificationLevel || 1,
        verificationTag: data.verificationTag || session.verificationTag,
        sources: data.sources || session.verificationSources
      });
      webhookEngine.dispatch('SUCCESS', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.LEVEL1_VERIFIED', (data) => {
    server.broadcastSse(data.paymentId, 'status_change', {
      status: 'VERIFYING',
      verificationLevel: 1,
      verificationTag: data.verificationTag,
      message: 'Payment detected! Verifying secondary channel...'
    });
  });

  eventEmitter.on('PAYMENT.FAILED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('FAILED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.EXPIRED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.EXPIRED
      });
      webhookEngine.dispatch('EXPIRED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.CANCELLED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.CANCELLED
      });
      webhookEngine.dispatch('CANCELLED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.FRAUD_BLOCKED', (data) => {
    if (data.sessionId) {
      server.broadcastSse(data.sessionId, 'status_change', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
          investigating: true
        }
      });
      server.broadcastSse(data.sessionId, 'account_blocked', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION'
      });
    }
  });


  // Continuous 1-second background queue sync and auto-expiry daemon
  const queueSyncDaemon = setInterval(() => {
    try {
      const nowIso = new Date().toISOString();

      // Sweep expired ACTIVE sessions
      const expiredActive = db.query(`
        SELECT id, merchant_id, order_id, receiving_account_id FROM payment_sessions
        WHERE status = 'ACTIVE' AND expires_at <= ?
      `, [nowIso]);

      for (const row of expiredActive) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.EXPIRED });
        eventEmitter.emit('PAYMENT.EXPIRED', {
          paymentId: row.id,
          orderId: row.order_id,
          merchantId: row.merchant_id
        });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Sweep failed PROCESSING sessions
      const failedProc = db.query(`
        SELECT id, merchant_id, order_id, receiving_account_id FROM payment_sessions
        WHERE status = 'PROCESSING' AND processing_expires_at <= ?
      `, [nowIso]);

      for (const row of failedProc) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.FAILED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.FAILED });
        eventEmitter.emit('PAYMENT.FAILED', {
          paymentId: row.id,
          orderId: row.order_id,
          merchantId: row.merchant_id
        });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Scan for vacant receiving accounts that have waiting queued sessions
      const vacantAccounts = db.query(`
        SELECT id FROM payment_receiving_accounts
        WHERE is_active = 1 AND (is_slot_busy = 0 OR current_active_session_id IS NULL)
      `);

      for (const acc of vacantAccounts) {
        handleSlotFreedAndPromote(acc.id);
      }
    } catch {}
  }, 1000);

  if (queueSyncDaemon.unref) queueSyncDaemon.unref();

  // Continuous Recurring Webhook Retry Daemon (Sweeps and dispatches pending webhook deliveries every 5s)
  //
  // The tick is defensive: `retryPending()` is expected to return a promise,
  // but a throw inside it — or a non-promise return — must not escape the
  // interval callback, because an exception thrown from a timer callback is
  // an unhandled error that can take the process down.
  const webhookRetryDaemon = setInterval(() => {
    try {
      const outcome = webhookEngine.retryPending();
      if (outcome && typeof outcome.catch === 'function') outcome.catch(() => {});
    } catch {}
  }, Number(process.env.WEBHOOK_RETRY_INTERVAL_MS || 5000));

  if (webhookRetryDaemon.unref) webhookRetryDaemon.unref();

  // Consolidated, Coordinated Observer Polling & Verification Daemon
  // Eliminates duplicate HTTP sweeps, enforces 1.5s-2s cooldown, and prevents SQLite write contention
  const observerPollerService = new ObserverPollerService({
    db,
    sessionRepo,
    obsRepo,
    attributionEngine,
    eventEmitter,
    pollIntervalMs: Number(process.env.OBSERVER_POLL_INTERVAL_MS || 1500),
    minSweepCooldownMs: Number(process.env.OBSERVER_SWEEP_COOLDOWN_MS || 2000),
    smsPort: Number(process.env.SMS_OBSERVER_PORT || 6002),
    gmailPort: Number(process.env.GMAIL_OBSERVER_PORT || 6003)
  });

  // Execute crash recovery on boot (AFTER event listeners are wired so recovered terminal transitions emit webhooks)
  const recoveryStats = recoveryEngine.recover();
  // Immediately kick off a background retry sweep for any recovered in-flight or backfilled webhooks
  try {
    const initialRetry = webhookEngine.retryPending();
    if (initialRetry && typeof initialRetry.catch === 'function') initialRetry.catch(() => {});
  } catch {}

  // Health check routes
  const healthHandler = (req, res) => {
    HttpServer.json(res, 200, {
      status: 'UP',
      service: 'payment-api',
      timestamp: new Date().toISOString(),
      recoveryStats
    });
  };
  server.get('/health', healthHandler);
  server.get('/api/v1/health', healthHandler);

  const pipeline = new PaymentVerificationPipeline({
    db,
    sessionRepo,
    obsRepo,
    customerRepo,
    attributionEngine,
    auditRepo,
    merchantRepo,
    server,
    eventEmitter
  });

  const context = {
    db,
    merchantRepo,
    accountRepo,
    customerRepo,
    customerSessionRepo,
    sessionRepo,
    deviceRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    queueEngine,
    timingEngine,
    attributionEngine,
    pipeline,
    recoveryEngine,
    eventEmitter,
    defaultMerchant,
    checkoutBaseUrl,
    whatsappBerryService,
    webhookEngine,
    observerPollerService,
    otpCooldownMs: options.otpCooldownMs
  };

  registerPaymentRoutes(server, context);
  registerCheckoutRoutes(server, context);
  registerPollerRoutes(server, context);
  registerAdminRoutes(server, context);
  registerCustomerRoutes(server, context);
  registerDeviceRoutes(server, context);

  function destroy() {
    clearInterval(queueSyncDaemon);
    clearInterval(webhookRetryDaemon);
    observerPollerService.destroy();
    timingEngine.destroy();
    if (typeof attributionEngine.destroy === 'function') {
      attributionEngine.destroy();
    }
    if (whatsappBerryService && typeof whatsappBerryService.disconnect === 'function') {
      whatsappBerryService.disconnect({ cleanSession: false }).catch(() => {});
    }
  }

  return {
    server,
    context,
    destroy,
    rawServer: server.createServer()
  };
}

export function startServer(port = null, customDb = null) {
  const finalPort = port || Number(process.env.PAYMENT_API_PORT || 6100);
  const app = createPaymentApp(customDb);

  return new Promise(resolve => {
    // Loopback by default; reach this service via the local Cloudflare Tunnel, not 0.0.0.0.
    const bindHost = process.env.YOUPI_BIND_HOST || '127.0.0.1';
    const instance = app.rawServer.listen(finalPort, bindHost, () => {
      console.log(`[Payment API] Server listening on port ${finalPort}`);
      resolve({
        app,
        port: finalPort,
        close: () => new Promise(cb => {
          app.destroy();
          instance.close(cb);
        })
      });
    });
  });
}

// Auto-run if executed directly as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
