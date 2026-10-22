import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../../../../scripts/test-support.js';
import { Database, runMigrations, MerchantRepository, PaymentSessionRepository, ObservationRepository } from '@youpi/db';
import { WebhookEngine } from '../webhook-engine.js';
import { verifyHmac } from '@youpi/common';

describe('Webhook Engine Integration Tests', () => {
  let db;
  let merchantRepo;
  let sessionRepo;
  let webhookEngine;
  let receiverServer;
  let receiverPort;
  let receivedWebhooks = [];
  let shouldReceiverFail = false;

  before(async () => {
    db = new Database({ inMemory: true });
    runMigrations(db);
    merchantRepo = new MerchantRepository(db);
    sessionRepo = new PaymentSessionRepository(db);

    webhookEngine = new WebhookEngine({
      db,
      merchantRepo,
      maxRetries: 3
    });

    // Start a mock merchant webhook receiver HTTP server
    receiverServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        receivedWebhooks.push({
          headers: req.headers,
          body: JSON.parse(body || '{}')
        });

        if (shouldReceiverFail) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Merchant Error');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        }
      });
    });

    await new Promise(resolve => {
      receiverServer.listen(0, () => {
        receiverPort = receiverServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise(cb => receiverServer.close(cb));
    db.close();
  });

  test('successfully dispatches HMAC-SHA256 signed webhook on payment event', async () => {
    const merchant = merchantRepo.create({
      businessName: 'Webhook Test Store',
      slug: 'webhook-store',
      contactEmail: 'store@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook`,
      webhookSecret: 'test_secret_for_merchant_signatures_123'
    });

    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-001',
      amountPaise: 20000n
    });

    receivedWebhooks = [];
    shouldReceiverFail = false;

    const result = await webhookEngine.dispatch('SUCCESS', session);

    assert.equal(result.delivered, true);
    assert.equal(result.status, 200);
    assert.ok(result.deliveryId);

    // Verify received payload & signature
    assert.equal(receivedWebhooks.length, 1);
    const hook = receivedWebhooks[0];

    assert.equal(hook.headers['x-gateway-event'], 'SUCCESS');
    assert.ok(hook.headers['x-gateway-signature'].startsWith('sha256='));
    assert.equal(hook.headers['x-gateway-delivery-id'], result.deliveryId);

    assert.equal(hook.body.event, 'SUCCESS');
    assert.equal(hook.body.orderId, 'HOOK-ORD-001');
    assert.equal(hook.body.amount, '200.00');
    assert.equal(hook.body.amountPaise, 20000);

    // Cryptographically verify signature using merchant webhookSecret
    const rawSig = hook.headers['x-gateway-signature'].replace('sha256=', '');
    const isValid = verifyHmac(JSON.stringify(hook.body), merchant.webhookSecret, rawSig);
    assert.equal(isValid, true);
    assert.ok('utr' in hook.body);

    // Verify recorded in DB as successful
    const delivery = db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [result.deliveryId]);
    assert.ok(delivery);
    assert.equal(delivery.is_successful, 1);
    assert.equal(delivery.response_status, 200);
  });

  test('carries the bank reference (UTR) from the attributed observation', async () => {
    const merchant = merchantRepo.create({
      businessName: 'UTR Store',
      slug: 'utr-store',
      contactEmail: 'utr@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-utr`,
      webhookSecret: 'test_secret_for_utr_signatures_123'
    });

    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-UTR',
      amountPaise: 20000n,
      receivingAccountId: '00000000-0000-0000-0000-000000000002'
    });

    // The UTR lives on the observation, not on the session row.
    const observation = new ObservationRepository(db).create({
      receivingAccountId: session.receivingAccountId,
      source: 'GOOGLE_MESSAGES',
      rawText: 'Rs 200.00 credited UPI ref 412345678901',
      amountPaise: 20000n,
      bankReferenceNumber: '412345678901',
      observedAt: new Date(),
      fingerprintHash: 'fp_utr_test'
    });
    db.execute('UPDATE payment_sessions SET attributed_observation_id = ? WHERE id = ?', [observation.id, session.id]);

    receivedWebhooks = [];
    shouldReceiverFail = false;

    const result = await webhookEngine.dispatch('SUCCESS', sessionRepo.findById(session.id));
    assert.equal(result.delivered, true);

    const hook = receivedWebhooks.find(h => h.body.orderId === 'HOOK-ORD-UTR');
    assert.ok(hook, 'webhook not received');
    assert.equal(hook.body.utr, '412345678901');

    // The signature must still cover the body that now includes the UTR.
    const rawSig = hook.headers['x-gateway-signature'].replace('sha256=', '');
    assert.equal(verifyHmac(JSON.stringify(hook.body), merchant.webhookSecret, rawSig), true);

    // The documented webhook contract must expose every field.
    for (const field of ['event', 'paymentId', 'orderId', 'amount', 'amountPaise', 'currency', 'method', 'utr', 'completedAt', 'metadata']) {
      assert.ok(field in hook.body, `missing documented webhook field: ${field}`);
    }
  });

  test('records failure and supports retry on merchant HTTP 500 error', async () => {
    const merchant = merchantRepo.create({
      businessName: 'Failing Store',
      slug: 'failing-store',
      contactEmail: 'fail@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-fail`,
      webhookSecret: 'secret_abc_123'
    });

    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-FAIL',
      amountPaise: 50000n
    });

    shouldReceiverFail = true;
    const result = await webhookEngine.dispatch('FAILED', session);

    assert.equal(result.delivered, false);
    assert.equal(result.status, 500);

    // Verify recorded as failed with next_retry_at set
    const delivery = db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [result.deliveryId]);
    assert.equal(delivery.is_successful, 0);
    assert.equal(delivery.attempt_count, 1);
    assert.ok(delivery.next_retry_at);

    // Now make receiver healthy and simulate retry worker
    shouldReceiverFail = false;
    const pastIso = new Date(Date.now() - 60000).toISOString();
    db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [pastIso, result.deliveryId]);

    const retryResults = await webhookEngine.retryPending();
    assert.equal(retryResults.length, 1);
    assert.equal(retryResults[0].success, true);
    assert.equal(retryResults[0].attempt, 2);

    const updatedDelivery = db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [result.deliveryId]);
    assert.equal(updatedDelivery.is_successful, 1);

    // A retried delivery must carry the SAME MAC as a first delivery: the signature covers
    // the exact transmitted body, so the merchant's verification accepts it too. Signing the
    // retry as `${timestamp}.${payload}` made every retry fail verification.
    const retried = receivedWebhooks.filter(h => h.body && h.body.orderId === 'HOOK-ORD-FAIL').pop();
    assert.ok(retried, 'retried webhook not received');
    const retrySig = retried.headers['x-gateway-signature'].replace('sha256=', '');
    assert.equal(verifyHmac(JSON.stringify(retried.body), merchant.webhookSecret, retrySig), true);
  });

  test('a retried delivery keeps the timestamp and delivery id of the original body', async () => {
    const merchant = merchantRepo.create({
      businessName: 'Retry Consistency Store',
      slug: 'retry-consistency-store',
      contactEmail: 'retry@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-retry-consistency`,
      webhookSecret: 'test_secret_for_retry_consistency_123'
    });

    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-RETRY-CONSISTENCY',
      amountPaise: 70000n
    });

    receivedWebhooks = [];
    shouldReceiverFail = false;

    const result = await webhookEngine.dispatch('SUCCESS', session);
    assert.equal(result.delivered, true);
    const first = receivedWebhooks[receivedWebhooks.length - 1];
    const firstBody = first.body;
    assert.ok(firstBody.timestamp, 'payload must carry a timestamp');
    assert.ok(firstBody.deliveryId, 'payload must carry a delivery id');

    // The retry resends the SAME body, so the headers must describe that same body.
    db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [
      new Date(Date.now() - 60000).toISOString(), result.deliveryId
    ]);
    await webhookEngine.retryPending();

    const retried = receivedWebhooks[receivedWebhooks.length - 1];
    assert.equal(String(retried.headers['x-gateway-timestamp']), String(firstBody.timestamp),
      'a retry must not recompute the timestamp, or it disagrees with the signed body');
    assert.equal(String(retried.headers['x-gateway-delivery-id']), String(firstBody.deliveryId),
      'a retry must keep the delivery id of the body it resends');
    assert.equal(JSON.stringify(retried.body), JSON.stringify(first.body), 'a retry must resend the identical body');

    // And the merchant's verifier must accept the retried delivery.
    const rawSig = retried.headers['x-gateway-signature'].replace('sha256=', '');
    assert.equal(verifyHmac(JSON.stringify(retried.body), merchant.webhookSecret, rawSig), true);
  });

  test('persists delivery failure record when merchant webhookSecret is missing', async () => {
    const merchantNoSecret = merchantRepo.create({
      businessName: 'No Secret Store',
      slug: 'no-secret-store',
      contactEmail: 'nosecret@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-no-secret`,
      webhookSecret: 'temp_secret'
    });
    // Explicitly set secret to empty string in DB to test missing secret guard
    db.execute("UPDATE merchants SET webhook_secret = '' WHERE id = ?", [merchantNoSecret.id]);

    const session = sessionRepo.create({
      merchantId: merchantNoSecret.id,
      orderId: 'HOOK-ORD-NO-SEC',
      amountPaise: 10000n
    });

    const res = await webhookEngine.dispatch('SUCCESS', session);
    assert.equal(res.delivered, false);
    assert.equal(res.status, 500);
    assert.ok(res.deliveryId);

    const recorded = db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [res.deliveryId]);
    assert.ok(recorded);
    assert.equal(recorded.is_successful, 0);
    assert.equal(recorded.response_status, 500);
    assert.match(recorded.response_body, /webhookSecret is not configured/);
  });
});

describe('Webhook retry claim lifetime', () => {
  function pendingDeliveries(count) {
    const db = new Database({ inMemory: true });
    runMigrations(db);
    const sessionRepo = new PaymentSessionRepository(db);
    const merchantRepo = new MerchantRepository(db);
    const merchant = merchantRepo.create({
      businessName: 'Retry claim store',
      slug: 'retry-claim-store',
      contactEmail: 'retry@example.com',
      contactPhone: '9876543210',
      webhookUrl: 'https://example.com/webhook',
      webhookSecret: 'synthetic-retry-claim-secret'
    });
    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'RETRY-CLAIM',
      amountPaise: 10000n
    });
    const timestamp = Date.now() - 1000;
    for (let i = 0; i < count; i++) {
      const id = `retry-${String(i).padStart(2, '0')}`;
      db.execute(`
        INSERT INTO webhook_deliveries (
          id, merchant_id, payment_id, event_type, payload, endpoint_url, next_retry_at
        ) VALUES (?, ?, ?, 'SUCCESS', ?, ?, ?)
      `, [id, merchant.id, session.id, JSON.stringify({ deliveryId: id, timestamp }), merchant.webhookUrl, new Date(timestamp).toISOString()]);
    }
    return {
      db,
      engine: new WebhookEngine({ db, merchantRepo }),
      otherEngine: new WebhookEngine({ db, merchantRepo })
    };
  }

  test('overlapping sweeps send each due delivery once when a slow batch exceeds the claim lease', async (t) => {
    const { db, engine, otherEngine } = pendingDeliveries(10);
    t.after(() => db.close());
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const sent = new Map();
    let requests = 0;
    let overlappingSweep;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const id = options.headers['X-Gateway-Delivery-Id'];
      sent.set(id, (sent.get(id) || 0) + 1);
      requests++;
      // Each response takes less than the HTTP timeout, but the sequential batch
      // exceeds the 60s lease. A second worker wakes while request eight is in flight.
      if (requests <= 8) t.mock.timers.tick(9000);
      if (requests === 8) overlappingSweep = otherEngine.retryPending();
      return { ok: true, status: 200, text: async () => 'OK' };
    });

    const results = await engine.retryPending();
    const overlappingResults = await overlappingSweep;
    assert.equal(requests, 10, 'a slow backlog must not create duplicate HTTP requests');
    assert.equal(results.length + overlappingResults.length, 10);
    assert.equal(sent.size, 10);
    for (const count of sent.values()) assert.equal(count, 1);
    for (const row of db.query('SELECT attempt_count, is_successful FROM webhook_deliveries')) {
      assert.equal(row.attempt_count, 2, 'waiting for an earlier delivery must not consume attempts');
      assert.equal(row.is_successful, 1);
    }
  });

  test('a second worker can process waiting deliveries while the first request is in flight', async (t) => {
    const { db, engine, otherEngine } = pendingDeliveries(3);
    t.after(() => db.close());
    let releaseFirst;
    const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      if (++requests === 1) await firstResponse;
      return { ok: true, status: 200, text: async () => 'OK' };
    });

    const firstSweep = engine.retryPending();
    let secondResults;
    try {
      secondResults = await otherEngine.retryPending();
    } finally {
      releaseFirst();
      await firstSweep;
    }
    assert.equal(secondResults.length, 2);
    assert.equal(requests, 3);
  });

  test('a sweep remains bounded to twenty deliveries', async (t) => {
    const { db, engine } = pendingDeliveries(21);
    t.after(() => db.close());
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, text: async () => 'OK' }));

    assert.equal((await engine.retryPending()).length, 20);
    assert.equal(db.queryOne('SELECT COUNT(*) AS count FROM webhook_deliveries WHERE attempt_count = 1').count, 1);
  });
});
