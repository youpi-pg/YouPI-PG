import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../../../scripts/test-support.js';
import { Database, runMigrations, MerchantRepository, PaymentSessionRepository } from '@youpi/db';
import { WebhookEngine } from '../webhook-engine.js';

function fixture(slug) {
  const db = new Database({ inMemory: true });
  runMigrations(db);
  const merchants = new MerchantRepository(db);
  const sessions = new PaymentSessionRepository(db);
  const merchant = merchants.create({
    businessName: 'Synthetic webhook fixture',
    slug,
    contactEmail: slug + '@example.com',
    contactPhone: '9000000000',
    webhookUrl: 'http://localhost:54321/webhook',
    webhookSecret: 'synthetic_hmac_secret_for_webhook_tests'
  });
  const engine = new WebhookEngine({ db, merchantRepo: merchants, sessionRepo: sessions });
  return { db, merchants, sessions, merchant, engine };
}

test('outbox survives terminal transition and is prepared before network dispatch', async () => {
  const { db, sessions, merchant, engine } = fixture('durable-terminal');
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'DURABLE-1', amountPaise: 100n, status: 'ACTIVE' });
    sessions.transitionToTerminal(session.id, 'EXPIRED');
    assert.equal(db.queryOne('SELECT event_type FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).event_type, 'EXPIRED');

    let requestCount = 0;
    globalThis.fetch = async (_url, opts) => {
      requestCount++;
      const row = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
      assert.ok(row, 'delivery MUST be durable before fetch');
      assert.equal(row.is_successful, 0);
      // The first request is still in flight. Zero marks it for immediate boot
      // recovery; dispatch increments the count after this request completes.
      assert.equal(row.attempt_count, 0);
      assert.ok(row.next_retry_at, 'crash recovery lease MUST be set');
      assert.equal(row.id, opts.headers['X-Gateway-Delivery-Id']);
      return { ok: true, status: 200, text: async () => 'ok' };
    };

    const recovered = await engine.recoverOutbox();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].delivered, true);
    assert.equal(requestCount, 1);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).n, 0);
    assert.equal((await engine.recoverOutbox()).length, 0);
    const duplicate = await engine.dispatch('EXPIRED', sessions.findById(session.id));
    assert.equal(duplicate.deliveryId, recovered[0].deliveryId);
    assert.equal(requestCount, 1, 'duplicate terminal events MUST NOT issue another delivery');
  } finally {
    globalThis.fetch = previousFetch;
    db.close();
  }
});

test('interrupted first attempt remains eligible for restart retry with the same delivery ID and body', async () => {
  const { db, sessions, merchant, engine, merchants } = fixture('durable-restart');
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'DURABLE-2', amountPaise: 200n });
    let initialBody;
    globalThis.fetch = async (_url, opts) => {
      const row = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [session.id]);
      assert.ok(row, 'network must not start before persistence');
      initialBody = opts.body;
      assert.equal(row.payload, initialBody);
      throw new Error('synthetic network failure');
    };
    const failed = await engine.dispatch('SUCCESS', session);
    assert.equal(failed.delivered, false);
    const pending = db.queryOne('SELECT * FROM webhook_deliveries WHERE id = ?', [failed.deliveryId]);
    assert.equal(pending.is_successful, 0);
    assert.equal(pending.attempt_count, 1);
    assert.ok(pending.next_retry_at);

    db.execute('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), pending.id]);
    const afterRestart = new WebhookEngine({ db, merchantRepo: merchants, sessionRepo: sessions });
    let resent = 0;
    globalThis.fetch = async (_url, opts) => {
      resent++;
      assert.equal(opts.headers['X-Gateway-Delivery-Id'], pending.id);
      assert.equal(opts.body, initialBody);
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const results = await afterRestart.retryPending();
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(resent, 1);
    assert.equal(db.queryOne('SELECT is_successful FROM webhook_deliveries WHERE id = ?', [pending.id]).is_successful, 1);
  } finally {
    globalThis.fetch = previousFetch;
    db.close();
  }
});

test('missing merchant signing key preserves an outboxed event until configuration is repaired', async () => {
  const { db, sessions, merchant, engine, merchants } = fixture('durable-key-rotation');
  const previousFetch = globalThis.fetch;
  try {
    const session = sessions.create({ merchantId: merchant.id, orderId: 'DURABLE-3', amountPaise: 300n, status: 'ACTIVE' });
    sessions.transitionToTerminal(session.id, 'EXPIRED');
    db.execute("UPDATE merchants SET webhook_secret = '' WHERE id = ?", [merchant.id]);
    assert.equal((await engine.recoverOutbox()).length, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE payment_id = ?', [session.id]).n, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_webhook_outbox WHERE payment_id = ?', [session.id]).n, 1);
    merchants.update(merchant.id, { webhookSecret: 'newly_rotated_synthetic_test_secret' });
    let attempted = 0;
    globalThis.fetch = async () => {
      attempted++;
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const replayed = await engine.recoverOutbox();
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].delivered, true);
    assert.equal(attempted, 1);
  } finally {
    globalThis.fetch = previousFetch;
    db.close();
  }
});

test('recoverOutbox advances past retained invalid endpoints and delivers healthy merchant events (#120)', async () => {
  const { db, sessions, merchants, engine } = fixture('starvation-outbox');
  const previousFetch = globalThis.fetch;
  try {
    const blockedMerchant = merchants.create({
      businessName: 'Blocked merchant with invalid endpoint',
      slug: 'blocked-invalid-url',
      contactEmail: 'blocked@example.com',
      contactPhone: '9000000001',
      webhookUrl: 'not-a-url',
      webhookSecret: 'secret_1'
    });
    const healthyMerchant = merchants.create({
      businessName: 'Healthy merchant with valid endpoint',
      slug: 'healthy-valid-url',
      contactEmail: 'healthy@example.com',
      contactPhone: '9000000002',
      webhookUrl: 'http://localhost:54321/webhook',
      webhookSecret: 'secret_2'
    });

    // 25 terminal events for blocked merchant (exceeds default batchLimit of 20)
    for (let i = 0; i < 25; i++) {
      const session = sessions.create({ merchantId: blockedMerchant.id, orderId: `BLOCKED-${i}`, amountPaise: 100n, status: 'ACTIVE' });
      sessions.transitionToTerminal(session.id, 'EXPIRED');
      db.execute('UPDATE payment_webhook_outbox SET created_at = ? WHERE payment_id = ?',
        [new Date(1700000000000 + i).toISOString(), session.id]);
    }

    // 1 terminal event for healthy merchant created strictly after the blocked events
    const healthySession = sessions.create({ merchantId: healthyMerchant.id, orderId: 'HEALTHY-1', amountPaise: 100n, status: 'ACTIVE' });
    sessions.transitionToTerminal(healthySession.id, 'EXPIRED');
    db.execute('UPDATE payment_webhook_outbox SET created_at = ? WHERE payment_id = ?',
      [new Date(1700000000000 + 100).toISOString(), healthySession.id]);

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return { ok: true, status: 200, text: async () => 'ok' };
    };

    const recovered = await engine.recoverOutbox();
    // Healthy merchant must NOT be starved
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].delivered, true);
    assert.equal(fetchCount, 1);

    // Blocked merchant's 25 outbox rows must remain intact for human remediation
    const retainedBlocked = db.queryOne(
      'SELECT COUNT(*) AS n FROM payment_webhook_outbox o JOIN payment_sessions s ON s.id = o.payment_id WHERE s.merchant_id = ?',
      [blockedMerchant.id]
    ).n;
    assert.equal(retainedBlocked, 25);
  } finally {
    globalThis.fetch = previousFetch;
    db.close();
  }
});

test('recoverMissingDeliveries backfills healthy merchant behind invalid candidate prefix (#120)', async () => {
  const { db, sessions, merchants, engine } = fixture('starvation-backfill');
  try {
    const blockedMerchant = merchants.create({
      businessName: 'Blocked merchant invalid prefix',
      slug: 'blocked-backfill-url',
      contactEmail: 'blocked-bf@example.com',
      contactPhone: '9000000003',
      webhookUrl: 'not-a-url',
      webhookSecret: 'secret_bf_1'
    });
    const healthyMerchant = merchants.create({
      businessName: 'Healthy merchant backfill',
      slug: 'healthy-backfill-url',
      contactEmail: 'healthy-bf@example.com',
      contactPhone: '9000000004',
      webhookUrl: 'http://localhost:54321/webhook',
      webhookSecret: 'secret_bf_2'
    });

    // 105 terminal sessions for blocked merchant (exceeds default batchLimit of 100)
    for (let i = 0; i < 105; i++) {
      const session = sessions.create({ merchantId: blockedMerchant.id, orderId: `BLOCKED-BF-${i}`, amountPaise: 100n, status: 'ACTIVE' });
      db.execute('UPDATE payment_sessions SET status = ?, created_at = ? WHERE id = ?',
        ['EXPIRED', new Date(1700000000000 + i).toISOString(), session.id]);
    }

    // 1 terminal session for healthy merchant created strictly after
    const healthySession = sessions.create({ merchantId: healthyMerchant.id, orderId: 'HEALTHY-BF-1', amountPaise: 100n, status: 'ACTIVE' });
    db.execute('UPDATE payment_sessions SET status = ?, created_at = ? WHERE id = ?',
      ['EXPIRED', new Date(1700000000000 + 200).toISOString(), healthySession.id]);

    const backfilledCount = engine.recoverMissingDeliveries();
    assert.equal(backfilledCount, 1);

    const healthyDelivery = db.queryOne('SELECT * FROM webhook_deliveries WHERE payment_id = ?', [healthySession.id]);
    assert.ok(healthyDelivery);
    assert.equal(healthyDelivery.merchant_id, healthyMerchant.id);
  } finally {
    db.close();
  }
});
