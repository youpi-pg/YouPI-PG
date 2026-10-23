import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YoupiPaymentClient } from '@youpi/merchant-sdk';
import { getCoinStoreWebhookSecret } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Security headers applied to every HTML response served by the store. */
const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'"
});

/**
 * Escapes a value for interpolation into HTML text or attribute context.
 * Order ids, UTRs and failure reasons arrive from query parameters, so they must never be
 * injected raw into the order-status templates.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Upper bound for an unauthenticated JSON request body. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Largest single top-up the demo store accepts. */
const MAX_TOPUP_RUPEES = 100000;
/** Accepted clock skew for an inbound webhook's X-Gateway-Timestamp. */
// The gateway signs the delivery timestamp into the body and reuses it on every retry, so
// a retried delivery legitimately arrives with an older timestamp. The window therefore
// has to cover the gateway's whole retry schedule (backoffs up to 1 hour), otherwise a
// legitimate retry is rejected as a replay. Replay of the SAME delivery is still caught by
// the delivery-id dedupe below.
const WEBHOOK_MAX_SKEW_MS = 2 * 60 * 60 * 1000;

/** Keeps a client-supplied pack name printable and bounded before it is stored as metadata. */
function sanitizePackName(value) {
  const cleaned = String(value ?? '').replace(/[^\w .&()'-]/g, '').trim().slice(0, 60);
  return cleaned || 'Gamer Pack';
}

/**
 * Strips headers that would let a browser claim to be an internal renderer before the
 * request is relayed to the payment core.
 */
function sanitizedForwardHeaders(req, targetHost) {
  const headers = { ...req.headers, host: targetHost };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'x-internal-render' || lower === 'x-internal-token') {
      delete headers[name];
    }
  }
  return headers;
}

/**
 * Replaces {{PLACEHOLDER}} tokens with escaped values.
 *
 * The replacement is done with a replacer function so that `$&`, `$'` and `` $` ``
 * inside an attacker-controlled value are inserted literally instead of being
 * expanded as replacement patterns.
 */
export function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    return escapeHtml(values[key]);
  });
}

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

export class CoinWalletStoreServer {
  /**
   * @param {{
   *   gatewayApiUrl?: string,
   *   merchantId?: string,
   *   webhookSecret?: string
   * }} [options={}]
   */
  constructor(options = {}) {
    const internalPort = process.env.PAYMENT_API_PORT || 6100;
    this.gatewayApiUrl = options.gatewayApiUrl || process.env.PAYMENT_API_URL || process.env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${internalPort}`;
    this.merchantId = options.merchantId || '00000000-0000-0000-0000-000000000001';
    this.webhookSecret = options.webhookSecret || getCoinStoreWebhookSecret();

    // Canonical public origin of this store. Post-payment return URLs are built from this
    // value rather than from the request's Host / X-Forwarded-* headers, which are
    // attacker-controllable and would otherwise allow redirecting paying customers elsewhere.
    this.publicBaseUrl = (options.publicBaseUrl || process.env.COIN_STORE_PUBLIC_URL || `http://localhost:${process.env.STORE_PORT || 5000}`)
      .replace(/\/+$/, '');

    // orderId -> gateway paymentId for orders this store created (used to verify payments server-side)
    this.orderPayments = new Map();
    // orderId -> { orderId, paymentId, amountPaise, coins, packName, createdAt }
    this.orders = new Map();

    // Recently processed X-Gateway-Delivery-Id values, used to reject replayed webhooks.
    this.seenDeliveryIds = new Map();

    this.paymentClient = new YoupiPaymentClient({
      apiUrl: this.gatewayApiUrl,
      merchantId: this.merchantId,
      webhookSecret: this.webhookSecret
    });

    // In-memory persistent wallet balance & ledger for demo store
    this.walletCoins = 50; // default starting balance
    this.transactionHistory = [];

    this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8');
    this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8');
    this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8');
    this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8');
    this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8');
    this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8');
    this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8');
  }

  creditCoins(orderId, coins, packName) {
    this.walletCoins += Number(coins);
    this.transactionHistory.unshift({
      orderId,
      packName: packName || 'Coin Pack',
      coins: Number(coins),
      status: 'CREDITED',
      timestamp: new Date().toISOString()
    });
  }

  /** Records a processed delivery id and prunes entries older than the accepted skew window. */
  rememberDeliveryId(deliveryId) {
    const now = Date.now();
    for (const [id, seenAt] of this.seenDeliveryIds) {
      if (now - seenAt > WEBHOOK_MAX_SKEW_MS * 2) this.seenDeliveryIds.delete(id);
    }
    this.seenDeliveryIds.set(deliveryId, now);
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Gateway-Signature, X-Gateway-Event'
        });
        res.end();
        return;
      }

      // SERVE LOCAL PUBLIC ASSETS: /assets/*, /css/*, /js/*
      if ((pathname.startsWith('/assets/') || pathname.startsWith('/css/') || pathname.startsWith('/js/')) && (method === 'GET' || method === 'HEAD')) {
        const publicDir = path.resolve(__dirname, '../public');
        const safeRelative = path.normalize(pathname.replace(/^\//, '')).replace(/^(\.\.(\/|\\|$))+/, '');
        const targetPath = path.join(publicDir, safeRelative);
        const rel = path.relative(publicDir, targetPath);

        if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
          const ext = path.extname(targetPath).toLowerCase();
          const contentType = ext === '.css' ? 'text/css; charset=utf-8'
            : ext === '.js' ? 'application/javascript; charset=utf-8'
            : ext === '.png' ? 'image/png'
            : ext === '.svg' ? 'image/svg+xml'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': ext === '.css' || ext === '.js' ? 'no-cache' : 'public, max-age=86400'
          });
          if (method === 'HEAD') { res.end(); return; }
          const stream = fs.createReadStream(targetPath);
          stream.pipe(res);
          return;
        }
      }

      // GET /health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'coin-wallet-store', coins: this.walletCoins }));
        return;
      }

      // GET /youpi.js or /sdk/youpi-checkout.js (Universal Frontend Integration Script)
      if (pathname === '/youpi.js' || pathname === '/sdk/youpi-checkout.js' || pathname === '/sdk/youpi.js') {
        const sdkPath = path.resolve(__dirname, '../../checkout-portal/src/sdk/youpi.js');
        if (fs.existsSync(sdkPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(sdkPath, 'utf8'));
          return;
        }
      }

      // GET /openapi.yaml (Public Developer Integration Specification)
      if (pathname === '/openapi.yaml') {
        const openApiPath = path.resolve(__dirname, '../../../openapi.yaml');
        if (fs.existsSync(openApiPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/yaml; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(openApiPath, 'utf8'));
          return;
        }
      }

      // REVERSE PROXY: /checkout/*, /icons/*, /css/*, and /js/* -> Checkout Portal (Port 7000)
      if (pathname.startsWith('/checkout') || pathname.startsWith('/icons/') || pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
      const portalUrl = process.env.CHECKOUT_PORTAL_URL || `http://127.0.0.1:${process.env.CHECKOUT_PORT || 7000}`;
      const targetUrl = new URL(req.url, portalUrl);
      const requestClient = targetUrl.protocol === 'https:' ? https : http;
      const proxyReq = requestClient.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
          method: req.method,
          headers: {
          ...sanitizedForwardHeaders(req, targetUrl.host),
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Checkout Portal unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // REVERSE PROXY: /api/v1/* -> Payment API (Port 6100 / gatewayApiUrl)
      if (pathname.startsWith('/api/v1/')) {
        try {
          const parsedGateway = new URL(this.gatewayApiUrl);
          const requestClient = parsedGateway.protocol === 'https:' ? https : http;
          const proxyReq = requestClient.request({
            hostname: parsedGateway.hostname || '127.0.0.1',
            port: parsedGateway.port || undefined,
            path: `${parsedGateway.pathname.replace(/\/$/, '')}${req.url}`,
            method: req.method,
            headers: {
              ...sanitizedForwardHeaders(req, parsedGateway.host),
              'x-forwarded-host': req.headers.host || '',
              'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
            }
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payment Gateway API unavailable', details: err.message }));
            }
          });

          req.pipe(proxyReq);
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to proxy payment API', details: err.message }));
          return;
        }
      }

      // GET / or /store
      if ((pathname === '/' || pathname === '/store') && (method === 'GET' || method === 'HEAD')) {
        try { this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          ...BASE_SECURITY_HEADERS
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.storeHtml);
        return;
      }

      // GET /wallet
      if (pathname === '/wallet' && (method === 'GET' || method === 'HEAD')) {
        try { this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          ...BASE_SECURITY_HEADERS
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.walletHtml);
        return;
      }

      // GET /order-success or /success
      if ((pathname === '/order-success' || pathname === '/success') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const amount = url.searchParams.get('amount') || '499.00';
        const utr = url.searchParams.get('utr') || url.searchParams.get('bankRef') || '123456789012';
        const mode = url.searchParams.get('mode') || url.searchParams.get('payment_mode') || 'UPI';
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        let rendered = renderTemplate(this.orderSuccessHtml, {
          ORDER_ID: orderId,
          AMOUNT: amount,
          UTR: utr,
          MODE: mode,
          TIMESTAMP: timestamp
        });

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          ...BASE_SECURITY_HEADERS
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-failed or /failed
      if ((pathname === '/order-failed' || pathname === '/failed') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const reason = url.searchParams.get('reason') || 'Transaction verification timed out or declined.';
        let rendered = renderTemplate(this.orderFailedHtml, {
          ORDER_ID: orderId,
          REASON: reason
        });
        // Legacy template still carries a literal `ORDER-#` placeholder.
        rendered = rendered.replace(/ORDER-#/g, () => escapeHtml(orderId));

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          ...BASE_SECURITY_HEADERS
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-suspicious or /suspicious
      if ((pathname === '/order-suspicious' || pathname === '/suspicious') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = renderTemplate(this.orderSuspiciousHtml, { ORDER_ID: orderId });

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          ...BASE_SECURITY_HEADERS
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-expired or /expired
      if ((pathname === '/order-expired' || pathname === '/expired') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = renderTemplate(this.orderExpiredHtml, { ORDER_ID: orderId });

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          ...BASE_SECURITY_HEADERS
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-cancelled or /cancelled
      if ((pathname === '/order-cancelled' || pathname === '/cancelled') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = renderTemplate(this.orderCancelledHtml, { ORDER_ID: orderId });

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          ...BASE_SECURITY_HEADERS
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /api/wallet-balance
      if (pathname === '/api/wallet-balance' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          coins: this.walletCoins,
          history: this.transactionHistory
        }));
        return;
      }

      // POST /api/checkout (Customer clicks purchase pack)
      if (pathname === '/api/checkout' && method === 'POST') {
        let body = '';
        let bodyTooLarge = false;
        req.on('data', chunk => {
          if (bodyTooLarge) return;
          body += chunk;
          if (body.length > MAX_JSON_BODY_BYTES) { bodyTooLarge = true; body = ''; }
        });
        req.on('end', async () => {
          if (bodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            return;
          }
          try {
            const data = JSON.parse(body || '{}');
            const rawVal = data.price !== undefined ? data.price : (data.amount !== undefined ? data.amount : 1.00);
            const price = Number(rawVal);
            if (!Number.isFinite(price) || price < 1 || price > MAX_TOPUP_RUPEES) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: price > MAX_TOPUP_RUPEES
                  ? `Maximum top-up amount is ₹${MAX_TOPUP_RUPEES}.00`
                  : 'Minimum top-up amount is ₹1.00'
              }));
              return;
            }
            const orderId = `COIN-ORD-${Date.now()}`;
            const amountStr = price.toFixed(2);

            // The post-payment return target must be derived from the store's own configured
            // base URL. Building it from Host / X-Forwarded-* lets an attacker choose where a
            // paying customer is redirected (phishing after a real payment).
            const returnUrl = `${this.publicBaseUrl}/wallet?orderId=${encodeURIComponent(orderId)}`;

            // Coin quantity is derived server-side from the amount paid. A client-supplied
            // `coins` value would let a buyer pay ₹1 and be credited an arbitrary balance.
            const coins = Math.round(price);
            const amountPaise = Math.round(price * 100);
            const packName = sanitizePackName(data.packName || data.productName);

            // Call YOUPI Payment Gateway via SDK
            const payment = await this.paymentClient.createPayment({
              orderId,
              amount: amountStr,
              currency: 'INR',
              returnUrl,
              metadata: {
                coins,
                packName
              }
            });

            this.orderPayments.set(orderId, payment.paymentId);
            this.orders.set(orderId, {
              orderId,
              paymentId: payment.paymentId,
              amountPaise,
              coins,
              packName,
              createdAt: Date.now()
            });

            // Normalize checkoutUrl for localhost development / testing to prevent tunnel offline issues
            let resolvedCheckoutUrl = payment.checkoutUrl;
            if (this.publicBaseUrl.includes('localhost') || this.publicBaseUrl.includes('127.0.0.1')) {
              resolvedCheckoutUrl = `${this.publicBaseUrl}/checkout/${payment.paymentId}`;
            }

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              orderId,
              paymentId: payment.paymentId,
              checkoutUrl: resolvedCheckoutUrl
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unable to create payment' }));
          }
        });
        return;
      }

      // POST /api/verify-payment (Instant confirmation & credit from popup drawer handler)
      if (pathname === '/api/verify-payment' && method === 'POST') {
        let body = '';
        let bodyTooLarge = false;
        req.on('data', chunk => {
          if (bodyTooLarge) return;
          body += chunk;
          if (body.length > MAX_JSON_BODY_BYTES) { bodyTooLarge = true; body = ''; }
        });
        req.on('end', async () => {
          if (bodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            return;
          }
          try {
            const data = JSON.parse(body || '{}');
            const { orderId: clientOrderId } = data;
            const sendJson = (status, payload) => {
              res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify(payload));
            };

            // The payment id comes from the order this server created, never from the browser.
            const localOrder = clientOrderId ? this.orders.get(clientOrderId) : undefined;
            const paymentId = localOrder?.paymentId || (clientOrderId ? this.orderPayments.get(clientOrderId) : undefined);
            if (!paymentId) {
              sendJson(404, { error: 'Unknown order' });
              return;
            }

            // Never trust the browser: ask the gateway whether this payment really succeeded,
            // and take the order id and coin amount from the local order record, not from the request.
            let session;
            try {
              session = await this.paymentClient.getPayment(paymentId);
            } catch (e) {
              console.warn('[Coin Wallet Store] getPayment failed:', e.message);
              sendJson(502, { error: 'Unable to verify payment with gateway' });
              return;
            }

            if (!session || session.status !== 'SUCCESS' || session.method !== 'UPI') {
              sendJson(402, { error: 'Payment not completed', status: session?.status || 'UNKNOWN' });
              return;
            }
            if (clientOrderId && clientOrderId !== session.orderId) {
              sendJson(400, { error: 'orderId does not match payment' });
              return;
            }
            if (localOrder && Number(session.amountPaise) !== Number(localOrder.amountPaise)) {
              sendJson(400, { error: 'Payment amount does not match order' });
              return;
            }

            const orderId = session.orderId;
            if (this.transactionHistory.some(t => t.orderId === orderId)) {
              sendJson(200, { success: true, coins: this.walletCoins, message: 'Already credited' });
              return;
            }

            // Always derive credited coins from the authoritative local order record (or paid amountPaise),
            // never from untrusted client parameters or out-of-band metadata.
            const paidPaise = Number(localOrder?.amountPaise ?? session.amountPaise);
            const derivedFromAmount = Number.isFinite(paidPaise) && paidPaise > 0
              ? Math.min(Math.max(1, Math.round(paidPaise / 100)), MAX_TOPUP_RUPEES)
              : 1;
            const creditedCoins = localOrder ? localOrder.coins : derivedFromAmount;
            const finalPackName = sanitizePackName(localOrder?.packName || session.metadata?.packName || 'Coin Pack');

            this.creditCoins(orderId, creditedCoins, finalPackName);
            console.log(`[Coin Wallet Store] Verified & credited ${creditedCoins} coins for Order ${orderId}. New balance: ${this.walletCoins}`);

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              success: true,
              coins: this.walletCoins,
              credited: creditedCoins,
              packName: finalPackName
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // POST /api/webhook or /webhook (Signed webhook listener from YOUPI PG)
      if ((pathname === '/api/webhook' || pathname === '/webhook') && method === 'POST') {
        let rawBody = '';
        let bodyTooLarge = false;
        req.on('data', chunk => {
          if (bodyTooLarge) return;
          rawBody += chunk;
          if (rawBody.length > MAX_JSON_BODY_BYTES) { bodyTooLarge = true; rawBody = ''; }
        });
        req.on('end', () => {
          if (bodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            return;
          }
          const signature = req.headers['x-gateway-signature'];
          const deliveryId = req.headers['x-gateway-delivery-id'] || '';
          const timestamp = req.headers['x-gateway-timestamp'] || '';

          // Reject a replayed delivery. Without this, one captured request can be resent
          // indefinitely and re-credited after the in-memory dedupe is lost on restart.
          const ts = Number(timestamp);
          if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WEBHOOK_MAX_SKEW_MS) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Webhook timestamp missing or outside the accepted window.' }));
            return;
          }
          if (deliveryId && this.seenDeliveryIds.has(deliveryId)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, duplicate: true }));
            return;
          }

          try {
            // Signature is verified over the RAW body, before any JSON parsing.
            const event = this.paymentClient.verifyWebhook(rawBody, signature, timestamp, {
              toleranceMs: WEBHOOK_MAX_SKEW_MS,
              allowUnsignedTimestampHeader: true
            });

            const paidMethod = event.method || event.data?.method;
            // COD / counter 'SUCCESS' means an order was placed, not that money arrived.
            if ((event.event === 'SUCCESS' || event.status === 'SUCCESS') && paidMethod === 'UPI') {
              const orderId = event.orderId || event.data?.orderId;
              const localOrder = orderId ? this.orders.get(orderId) : undefined;
              if (!localOrder && (!orderId || !this.orderPayments.has(orderId))) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unknown order' }));
                return;
              }
              const eventAmountPaise = Number(event.amountPaise ?? event.data?.amountPaise);
              if (localOrder && (!Number.isFinite(eventAmountPaise) || eventAmountPaise !== Number(localOrder.amountPaise))) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Webhook amount does not match order' }));
                return;
              }

              const alreadyCredited = this.transactionHistory.some(t => t.orderId === orderId);
              if (!alreadyCredited) {
                const coinsToAdd = localOrder
                  ? localOrder.coins
                  : Math.min(Math.max(1, Math.round(eventAmountPaise / 100)), MAX_TOPUP_RUPEES);
                const packName = sanitizePackName(localOrder?.packName || event.metadata?.packName || event.data?.metadata?.packName);
                this.creditCoins(orderId, coinsToAdd, packName);
                console.log(`[Coin Wallet Store] Webhook received! Credited ${coinsToAdd} coins for Order ${orderId}. New balance: ${this.walletCoins}`);
              }
            }

            if (deliveryId) this.rememberDeliveryId(deliveryId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, credited: true }));
          } catch (err) {
            console.error('[Coin Wallet Store] Webhook verification failed:', err.message);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid webhook signature' }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Route Not Found');
    });
  }
}
