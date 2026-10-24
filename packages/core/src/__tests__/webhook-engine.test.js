import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

  test('survives SIGKILL mid-first-delivery and delivers webhook on restart (Issue #86)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-wh-crash-'));
    const dbPath = path.join(tmpDir, 'crash-test.db');

    let acceptRequests = false;
    let firstAttemptSeenResolve;
    const firstAttemptSeen = new Promise(resolve => { firstAttemptSeenResolve = resolve; });
    const deliveredPayloads = [];

    const hangServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (!acceptRequests) {
          // Signal that the first delivery request reached the server, then hang so child can be SIGKILLed
          firstAttemptSeenResolve();
          return;
        }
        deliveredPayloads.push({
          headers: req.headers,
          body: JSON.parse(body || '{}')
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    const hangPort = await new Promise(resolve => {
      hangServer.listen(0, '127.0.0.1', () => resolve(hangServer.address().port));
    });

    try {
      // Spawn a child process that creates a terminal payment session and calls dispatch(),
      // which will hang waiting for hangServer while we SIGKILL the child process.
      const childScript = `
        import './scripts/test-support.js';
        import { Database, runMigrations, MerchantRepository, PaymentSessionRepository } from '@youpi/db';
        import { WebhookEngine } from '@youpi/core';

        const db = new Database({ dbPath: process.env.CRASH_DB_PATH });
        runMigrations(db);
        const merchantRepo = new MerchantRepository(db);
        const sessionRepo = new PaymentSessionRepository(db);
        const webhookEngine = new WebhookEngine({ db, merchantRepo, maxRetries: 3 });

        const merchant = merchantRepo.create({
          businessName: 'Crash Test Store',
          slug: 'crash-test-store',
          contactEmail: 'crash@example.com',
          contactPhone: '9876543210',
          webhookUrl: process.env.CRASH_WEBHOOK_URL,
          webhookSecret: 'crash_secret_key_123456'
        });

        const session = sessionRepo.create({
          merchantId: merchant.id,
          orderId: 'HOOK-ORD-SIGKILL-86',
          amountPaise: 49900n
        });
        sessionRepo.transitionToTerminal(session.id, 'SUCCESS');
        const updatedSession = sessionRepo.findById(session.id);

        await webhookEngine.dispatch('SUCCESS', updatedSession);
      `;

      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: {
          ...process.env,
          CRASH_DB_PATH: dbPath,
          CRASH_WEBHOOK_URL: `http://localhost:${hangPort}/webhook-crash`
        },
        stdio: 'ignore'
      });

      // Wait until the first HTTP delivery request is in-flight at hangServer
      await firstAttemptSeen;

      // Kill the child process with SIGKILL while the first webhook delivery is in flight
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));

      // Now open the SQLite DB in the parent (simulating API restart)
      const restartedDb = new Database({ dbPath });
      const restartedMerchantRepo = new MerchantRepository(restartedDb);
      const restartedWebhookEngine = new WebhookEngine({
        db: restartedDb,
        merchantRepo: restartedMerchantRepo,
        maxRetries: 3
      });

      // Verify the write-ahead webhook_deliveries row was persisted before fetch()
      const preRow = restartedDb.queryOne(
        "SELECT * FROM webhook_deliveries WHERE json_extract(payload, '$.orderId') = 'HOOK-ORD-SIGKILL-86'"
      );
      assert.ok(preRow, 'webhook_deliveries row must exist even when process crashed mid-first-delivery');
      assert.equal(preRow.is_successful, 0);
      assert.equal(preRow.attempt_count, 0);

      // Run startup recovery to reset in-flight leases and backfill any missing rows
      const recovered = restartedWebhookEngine.recoverMissingDeliveries({ resetInFlight: true });
      assert.ok(recovered >= 1, 'recoverMissingDeliveries should reset the interrupted in-flight row');

      // Allow receiver to respond 200 OK and run retryPending()
      acceptRequests = true;
      const retryOutcome = await restartedWebhookEngine.retryPending();
      assert.equal(retryOutcome.length, 1);
      assert.equal(retryOutcome[0].success, true);

      assert.equal(deliveredPayloads.length, 1);
      assert.equal(deliveredPayloads[0].body.orderId, 'HOOK-ORD-SIGKILL-86');
      assert.equal(deliveredPayloads[0].body.event, 'SUCCESS');

      const postRow = restartedDb.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [preRow.id]);
      assert.equal(postRow.is_successful, 1);
      assert.equal(postRow.response_status, 200);

      restartedDb.close();
    } finally {
      await new Promise(cb => hangServer.close(cb));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('backfills and delivers webhook if process crashed between transitionToTerminal and dispatch (Issue #86)', async () => {
    const merchant = merchantRepo.create({
      businessName: 'Orphan Terminal Store',
      slug: 'orphan-terminal-store',
      contactEmail: 'orphan@example.com',
      contactPhone: '9876543210',
      webhookUrl: `http://localhost:${receiverPort}/webhook-orphan`,
      webhookSecret: 'orphan_secret_key_123456'
    });

    const session = sessionRepo.create({
      merchantId: merchant.id,
      orderId: 'HOOK-ORD-ORPHAN-86',
      amountPaise: 35000n
    });
    // Transition session to terminal state WITHOUT calling webhookEngine.dispatch()
    // (simulating crash right after DB commit of terminal state before event listener ran)
    sessionRepo.transitionToTerminal(session.id, 'SUCCESS');

    const beforeRow = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
    assert.equal(beforeRow, null);

    receivedWebhooks = [];
    shouldReceiverFail = false;

    const retryResults = await webhookEngine.retryPending();
    const matching = retryResults.find(r => {
      const row = db.queryOne('SELECT payment_id FROM webhook_deliveries WHERE id = ?', [r.id]);
      return row && row.payment_id === session.id;
    });
    assert.ok(matching, 'retryPending should backfill and deliver the missing terminal webhook');
    assert.equal(matching.success, true);

    const hook = receivedWebhooks.find(h => h.body.orderId === 'HOOK-ORD-ORPHAN-86');
    assert.ok(hook, 'merchant should receive backfilled webhook');
    assert.equal(hook.body.event, 'SUCCESS');
    assert.equal(hook.body.amountPaise, 35000);
  });
});
