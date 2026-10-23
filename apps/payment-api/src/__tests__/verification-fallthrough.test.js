import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { Database, PaymentSessionRepository, ObservationRepository, SupportTicketRepository, AuditLogRepository, ReceivingAccountRepository, CustomerRepository } from '@youpi/db';
import { ObservationNormalizer, PaymentVerificationPipeline, AttributionEngine, RecoveryEngine, QueueEngine, TimingEngine } from '@youpi/core';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Verification Pipeline & Fall-Through Protection (#22)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6295, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...authHeadersFor(path), ...(options.headers || {}) }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('Issue #22: Poller endpoints reject personal numeric SMS senders and do not fall through to attribution', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);

    const session = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'FALLTHROUGH-GUARD-01',
      amountPaise: 50000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, receivingAccountId);

    // Personal numeric SMS sender (+919876543210) attempts to inject payment
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: '+919876543210',
        receivingAccountId,
        amount: '500.00',
        amountPaise: '50000',
        rawText: 'A/C 1234 credited by Rs 500.00 via UPI/123456789012'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.reason, 'PERSONAL_SMS_REJECTED');

    // Confirm session remains ACTIVE (not marked SUCCESS)
    const freshSession = sessionRepo.findById(session.id);
    assert.equal(freshSession.status, PaymentStatus.ACTIVE);
  });

  test('Issue #22: Poller endpoints reject duplicate/reused bank reference number (UTR)', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const obsRepo = apiInstance.app.context.obsRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    // 1. Session 1 is already completed with UTR 123456123456
    const priorObs = obsRepo.create({
      source: 'SMS',
      receivingAccountId,
      amountPaise: 10000n,
      amount: '100.00',
      observedAt: new Date(),
      bankReferenceNumber: '123456123456',
      fingerprintHash: 'hash-utr-consumed-test-999'
    });
    const s1 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'PRIOR-ORDER-99',
      amountPaise: 10000n
    });
    testDb.execute("UPDATE payment_sessions SET status = 'SUCCESS', attributed_observation_id = ? WHERE id = ?", [priorObs.id, s1.id]);

    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);

    // 2. Session 2 is currently active for ₹100
    const s2 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'NEW-ORDER-100',
      amountPaise: 10000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(s2.id, receivingAccountId);

    // 3. Ingest observation reusing the same UTR
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        receivingAccountId,
        amount: '100.00',
        amountPaise: '10000',
        bankReferenceNumber: '123456123456',
        rawText: 'A/C credited with Rs 100.00 on 19-Oct-2026. Ref: 123456123456'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.reason, 'REFERENCE_ALREADY_USED');

    // Confirm s2 is not attributed
    const freshS2 = sessionRepo.findById(s2.id);
    assert.equal(freshS2.status, PaymentStatus.ACTIVE);
  });

  test('Issue #5: ObservationNormalizer extracts reference numbers across varied Indian banking formats', () => {
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const testCases = [
      { text: 'A/c *1234 credited by Rs. 500.00 on 19-Oct-26 Ref no 612345678901', expectedRef: '612345678901' },
      { text: 'Rs. 250.00 received in your account. Ref no. 987654321098. UPI Txn', expectedRef: '987654321098' },
      { text: 'Dear Customer, INR 1,000.00 credited via UPI:612398745612 to A/C *5678', expectedRef: '612398745612' },
      { text: 'Money received: INR 75.00 from user@okaxis UPI Ref: 123456789012', expectedRef: '123456789012' }
    ];

    for (const tc of testCases) {
      const normalized = ObservationNormalizer.normalize({
        source: 'ANDROID_OBSERVER',
        receivingAccountId,
        rawPayload: { text: tc.text }
      });
      assert.equal(normalized.bankReferenceNumber, tc.expectedRef, `Failed for text: ${tc.text}`);
    }
  });

  test('Issue #5: findRecentlyExpiredOrFailed includes CANCELLED sessions to prevent payment hijacking', () => {
    const sessionRepo = new PaymentSessionRepository(testDb);
    const accountRepo = new ReceivingAccountRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const recAcc = accountRepo.create({
      merchantId,
      upiId: `cancel-${crypto.randomUUID().slice(0, 8)}@okaxis`,
      payeeName: 'Test Holder',
      provider: 'AXIS_BANK'
    });

    const cancelledSession = sessionRepo.create({
      merchantId,
      receivingAccountId: recAcc.id,
      orderId: `CANCEL-TEST-${Date.now()}`,
      amountPaise: 45000n,
      customerDetails: { phone: '9876543210' },
      method: 'UPI'
    });

    sessionRepo.transitionToTerminal(cancelledSession.id, PaymentStatus.CANCELLED);

    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recent = sessionRepo.findRecentlyExpiredOrFailed(recAcc.id, thirtyMinutesAgo);

    const found = recent.find(s => s.id === cancelledSession.id);
    assert.ok(found, 'CANCELLED session must be returned by findRecentlyExpiredOrFailed');
    assert.equal(found.status, PaymentStatus.CANCELLED);
  });

  test('Issue #5: Duplicate UTR conflict within 60s raises support ticket and does not overwrite completed session', () => {
    const sessionRepo = new PaymentSessionRepository(testDb);
    const accountRepo = new ReceivingAccountRepository(testDb);
    const obsRepo = new ObservationRepository(testDb);
    const ticketRepo = new SupportTicketRepository(testDb);
    const auditRepo = new AuditLogRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const recAcc = accountRepo.create({
      merchantId,
      upiId: `dup-${crypto.randomUUID().slice(0, 8)}@okaxis`,
      payeeName: 'Dup Utr Test',
      provider: 'AXIS_BANK'
    });

    const customerRepo = new CustomerRepository(testDb);
    const customer = customerRepo.create({ fullName: 'Dup Customer', mobileNumber: '9876543210' });

    // 1. Create a session and transition INITIATED -> ACTIVE
    const session = sessionRepo.create({
      merchantId,
      customerId: customer.id,
      receivingAccountId: recAcc.id,
      orderId: `DUP-UTR-ORDER-${Date.now()}`,
      amountPaise: 65000n,
      customerDetails: { phone: '9876543210' },
      method: 'UPI'
    });
    sessionRepo.acquireSlotAtomic(session.id, recAcc.id, 300000);

    const obs1 = obsRepo.create({
      receivingAccountId: recAcc.id,
      source: 'ANDROID_OBSERVER',
      amountPaise: 65000n,
      bankReferenceNumber: '111111111111',
      fingerprintHash: `fp_first_success_utr_${Date.now()}`,
      observedAt: new Date()
    });

    sessionRepo.recordVerificationSource(session.id, 'ANDROID_OBSERVER', obs1.id, { finalizeSuccess: true });

    // 2. Attribution engine with ticketRepo
    let duplicateEventFired = false;
    const attribution = new AttributionEngine({
      sessionRepo,
      obsRepo,
      ticketRepo,
      auditRepo,
      gracePeriodMs: 0,
      eventEmitter: {
        emit: (event) => {
          if (event === 'PAYMENT.DUPLICATE_DETECTED') duplicateEventFired = true;
        }
      }
    });

    // 3. Second incoming observation for the same amount but different UTR (222222222222)
    const normObs2 = {
      source: 'ANDROID_OBSERVER',
      receivingAccountId: recAcc.id,
      amountPaise: 65000n,
      observedAt: new Date(),
      bankReferenceNumber: '222222222222',
      fingerprintHash: `fp_second_conflict_utr_${Date.now()}`,
      rawPayload: { sender: 'HDFCBK', text: 'Rs. 650.00 credited Ref no 222222222222' }
    };

    const result = attribution.processObservation(normObs2);

    assert.equal(result.attributed, false);
    assert.ok(duplicateEventFired, 'PAYMENT.DUPLICATE_DETECTED event must fire');

    // Verify support ticket was created
    const tickets = testDb.query('SELECT * FROM support_tickets WHERE payment_id = ?', [session.id]);
    assert.ok(tickets.length >= 1, 'Reconciliation support ticket must be raised for duplicate payment');
    assert.match(tickets[0].subject, /DUPLICATE PAYMENT DETECTED/);
  });

  test('Issue #12: VerificationPipeline honors processingExpiresAt during PROCESSING status', () => {
    const sessionRepo = new PaymentSessionRepository(testDb);
    const accountRepo = new ReceivingAccountRepository(testDb);
    const obsRepo = new ObservationRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const recAcc = accountRepo.create({
      merchantId,
      upiId: `proc-${crypto.randomUUID().slice(0, 8)}@okaxis`,
      payeeName: 'Proc Test',
      provider: 'AXIS_BANK'
    });

    // Session whose initial 5-min active timer expired, but processing timer has 3 minutes remaining
    const session = sessionRepo.create({
      merchantId,
      receivingAccountId: recAcc.id,
      orderId: `PROC-TIMER-${Date.now()}`,
      amountPaise: 50000n,
      customerDetails: { phone: '9876543210' },
      method: 'UPI'
    });

    sessionRepo.acquireSlotAtomic(session.id, recAcc.id, 300000);
    sessionRepo.transitionToProcessing(session.id);

    const pastExpiresAt = new Date(Date.now() - 60000).toISOString();
    const futureProcExpiresAt = new Date(Date.now() + 180000).toISOString();

    testDb.execute(`
      UPDATE payment_sessions
      SET expires_at = ?, processing_expires_at = ?
      WHERE id = ?
    `, [pastExpiresAt, futureProcExpiresAt, session.id]);

    const pipeline = new PaymentVerificationPipeline({
      db: testDb,
      sessionRepo,
      obsRepo,
      attributionEngine: new AttributionEngine({ sessionRepo, obsRepo, gracePeriodMs: 0 })
    });

    const result = pipeline.process({
      source: 'SMS_GATEWAY',
      receivingAccountId: recAcc.id,
      paymentSessionId: session.id,
      sender: 'HDFCBK',
      rawText: 'Rs 500.00 credited to account ending 1234 on 19-Oct-26. UTR 918273645102.',
      receivedAt: new Date()
    });

    assert.notEqual(result.finalStatus, 'REJECTED', 'Observation must not be rejected as SESSION_EXPIRED while processingExpiresAt is active');
    assert.notEqual(result.failingCondition, 'SESSION_EXPIRED');
  });

  test('Issue #12: Crash recovery promotes attributed PROCESSING sessions to SUCCESS instead of FAILED', () => {
    const sessionRepo = new PaymentSessionRepository(testDb);
    const accountRepo = new ReceivingAccountRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';
    const recAcc = accountRepo.create({
      merchantId,
      upiId: `rec-${crypto.randomUUID().slice(0, 8)}@okaxis`,
      payeeName: 'Recovery Test',
      provider: 'AXIS_BANK'
    });

    const session = sessionRepo.create({
      merchantId,
      receivingAccountId: recAcc.id,
      orderId: `RECOVER-ATTRIB-${Date.now()}`,
      amountPaise: 35000n,
      customerDetails: { phone: '9876543210' },
      method: 'UPI'
    });

    sessionRepo.acquireSlotAtomic(session.id, recAcc.id, 300000);
    sessionRepo.transitionToProcessing(session.id);

    const obsId = crypto.randomUUID();
    testDb.execute(`
      INSERT INTO payment_observations (id, receiving_account_id, source, amount_paise, bank_reference_number, fingerprint_hash, observed_at)
      VALUES (?, ?, 'ANDROID_OBSERVER', 35000, '555666777888', ?, datetime('now'))
    `, [obsId, recAcc.id, `fp_recover_attrib_${Date.now()}`]);

    // Set session in PROCESSING status with overdue processing_expires_at but already attributed
    const overdueTime = new Date(Date.now() - 10000).toISOString();
    testDb.execute(`
      UPDATE payment_sessions
      SET processing_expires_at = ?, verification_level = 1, attributed_observation_id = ?
      WHERE id = ?
    `, [overdueTime, obsId, session.id]);

    const timingEngine = new TimingEngine({ db: testDb, sessionRepo, accountRepo });
    const queueEngine = new QueueEngine({ db: testDb, sessionRepo, accountRepo, timingEngine });
    let successFired = false;

    const recovery = new RecoveryEngine({
      db: testDb,
      sessionRepo,
      accountRepo,
      queueEngine,
      timingEngine,
      eventEmitter: {
        emit: (event) => {
          if (event === 'PAYMENT.OBSERVED_SUCCESS') successFired = true;
        }
      }
    });

    const stats = recovery.recover();
    const updated = sessionRepo.findById(session.id);

    assert.equal(updated.status, PaymentStatus.OBSERVED_SUCCESS, 'Attributed PROCESSING session must recover to OBSERVED_SUCCESS');
    assert.ok(successFired, 'PAYMENT.OBSERVED_SUCCESS event must fire on recovery of attributed session');
  });

  test('Issue #60: Missing rawText is rejected with HTTP 400 and does not bypass pipeline', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    testDb.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')", [receivingAccountId]);
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);

    const session = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'MISSING-RAWTEXT-01',
      amountPaise: 75000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, receivingAccountId);

    // Caller attempts to bypass pipeline by sending amount and UTR without rawText
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        receivingAccountId,
        amount: '750.00',
        amountPaise: '75000',
        bankReferenceNumber: '750750750750'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.reason, 'MISSING_RAW_TEXT');

    // Confirm session is NOT marked SUCCESS
    const freshSession = sessionRepo.findById(session.id);
    assert.equal(freshSession.status, PaymentStatus.ACTIVE);
  });

  test('Issue #60: UNRESOLVED pipeline result is rejected with HTTP 400 and never falls through to attribution', async () => {
    const accountRepo = new ReceivingAccountRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';

    const unassignedAcc = accountRepo.create({
      merchantId,
      upiId: `unresolved-${crypto.randomUUID().slice(0, 8)}@okaxis`,
      payeeName: 'Unresolved Holder',
      provider: 'AXIS_BANK'
    });

    // Ingest observation for an account with no active or processing session -> Stage 4 returns UNRESOLVED
    const res = await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        receivingAccountId: unassignedAcc.id,
        amount: '999.00',
        amountPaise: '99900',
        bankReferenceNumber: '999111222333',
        rawText: 'A/C 1234 credited with Rs 999.00 on 21-Oct-2026. Ref: 999111222333'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(res.body.status, 'UNRESOLVED');
  });

  test('Issue #60: Concurrent requests with identical UTR are rejected and prevent double-attribution', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const accountRepo = new ReceivingAccountRepository(testDb);
    const merchantId = '00000000-0000-0000-0000-000000000001';

    // Account A and Account B
    const recAcc1 = accountRepo.create({
      merchantId,
      upiId: `race1-${crypto.randomUUID().slice(0, 8)}@okaxis`,
      payeeName: 'Race Holder 1',
      provider: 'AXIS_BANK'
    });
    const recAcc2 = accountRepo.create({
      merchantId,
      upiId: `race2-${crypto.randomUUID().slice(0, 8)}@okaxis`,
      payeeName: 'Race Holder 2',
      provider: 'AXIS_BANK'
    });

    const s1 = sessionRepo.create({
      merchantId,
      receivingAccountId: recAcc1.id,
      orderId: `RACE-ORD-1-${Date.now()}`,
      amountPaise: 88800n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(s1.id, recAcc1.id);

    const s2 = sessionRepo.create({
      merchantId,
      receivingAccountId: recAcc2.id,
      orderId: `RACE-ORD-2-${Date.now()}`,
      amountPaise: 88800n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(s2.id, recAcc2.id);

    const sharedUtr = `RACEUTR${Date.now()}`.slice(0, 12).padEnd(12, '0');

    // Fire two requests concurrently with the same UTR
    const [res1, res2] = await Promise.all([
      request('/api/v1/pollers/events', {
        method: 'POST',
        body: {
          source: 'SMS',
          sender: 'HDFCBK',
          receivingAccountId: recAcc1.id,
          amount: '888.00',
          amountPaise: '88800',
          bankReferenceNumber: sharedUtr,
          rawText: `A/C 1234 credited with Rs 888.00 on 21-Oct-2026. Ref: ${sharedUtr}`
        }
      }),
      request('/api/v1/pollers/events', {
        method: 'POST',
        body: {
          source: 'SMS',
          sender: 'HDFCBK',
          receivingAccountId: recAcc2.id,
          amount: '888.00',
          amountPaise: '88800',
          bankReferenceNumber: sharedUtr,
          rawText: `A/C 5678 credited with Rs 888.00 on 21-Oct-2026. Ref: ${sharedUtr}`
        }
      })
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 400], 'Exactly one request must succeed and the other must be rejected');

    const successRes = res1.status === 200 ? res1 : res2;
    const failedRes = res1.status === 400 ? res1 : res2;

    assert.equal(successRes.body.accepted, true);
    assert.equal(failedRes.body.accepted, false);
    assert.equal(failedRes.body.status, 'REJECTED');
    assert.equal(failedRes.body.reason, 'REFERENCE_ALREADY_USED');

    // Verify exactly one session is SUCCESS and one is ACTIVE
    const s1Fresh = sessionRepo.findById(s1.id);
    const s2Fresh = sessionRepo.findById(s2.id);
    const sessionStatuses = [s1Fresh.status, s2Fresh.status].sort();
    assert.deepEqual(sessionStatuses, [PaymentStatus.ACTIVE, PaymentStatus.OBSERVED_SUCCESS]);
  });
});

