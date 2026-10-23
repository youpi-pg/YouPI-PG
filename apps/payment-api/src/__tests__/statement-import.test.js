import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { PaymentStatus, ObserverSource } from '@youpi/common';
import { ObservationNormalizer } from '@youpi/core';
import { startServer as startPaymentApi } from '../index.js';
import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

describe('admin bank-statement import', () => {
  let api;
  let db;
  const accountId = '00000000-0000-0000-0000-000000000002';

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6212, db);
  });

  after(async () => {
    await api.close();
    db.close();
  });

  function post(token, body) {
    return fetch(`http://127.0.0.1:${api.port}/api/v1/admin/statements/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
  }

  test('requires the admin token and reconciles one observed session', async () => {
    assert.equal((await post(null, { receivingAccountId: accountId, csv: 'x' })).status, 401);
    assert.equal((await post(TEST_OBSERVER_TOKEN, { receivingAccountId: accountId, csv: 'x' })).status, 401);

    const ctx = api.app.context;
    const session = ctx.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: accountId,
      orderId: 'ORD-ADMIN-STMT',
      amountPaise: 49900n
    });
    ctx.sessionRepo.acquireSlotAtomic(session.id, accountId, 300000);
    ctx.sessionRepo.transitionToProcessing(session.id, 30000);
    ctx.attributionEngine.processObservation(ObservationNormalizer.normalize({
      source: ObserverSource.GOOGLE_MESSAGES,
      receivingAccountId: accountId,
      amountPaise: 49900n,
      bankReferenceNumber: '423456789012',
      observedAt: new Date(),
      rawPayload: { text: 'credit 423456789012' }
    }));

    const ist = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const [year, month, day] = ist.split('-');
    const slash = `${day}/${month}/${year}`;
    const csv = [
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      `${slash},"UPI-TEST PAYER-payer@okhdfcbank-HDFC0000001-423456789012-ORDER",0,${slash},,"499.00",10000.00`
    ].join('\n');
    const response = await post(TEST_ADMIN_TOKEN, { receivingAccountId: accountId, csv });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reconciled, 1);
    assert.equal(ctx.sessionRepo.findById(session.id).status, PaymentStatus.RECONCILED);
  });
});
