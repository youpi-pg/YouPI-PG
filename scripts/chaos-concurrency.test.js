import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ReceivingAccountRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  CustomerRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  ObservationNormalizer
} from '@youpi/core';
import { PaymentStatus, ObserverSource, ObservationAttributionStatus } from '@youpi/common';

describe('Phase 16: Comprehensive Chaos & Concurrency Verification', () => {
  let db;
  let sessionRepo;
  let accountRepo;
  let obsRepo;
  let ticketRepo;
  let auditRepo;
  let customerRepo;
  let queueEngine;
  let timingEngine;
  let attributionEngine;
  let recoveryEngine;
  let testAccount;
  let defaultMerchant;
  let emittedEvents;

  before(() => {
    db = new Database({ inMemory: true });
    const seed = runMigrations(db);
    defaultMerchant = seed.defaultMerchant;
    testAccount = { id: '00000000-0000-0000-0000-000000000002' };

    sessionRepo = new PaymentSessionRepository(db);
    accountRepo = new ReceivingAccountRepository(db);
    obsRepo = new ObservationRepository(db);
    ticketRepo = new SupportTicketRepository(db);
    auditRepo = new AuditLogRepository(db);
    customerRepo = new CustomerRepository(db);

    emittedEvents = [];
    const eventEmitter = {
      emit: (event, payload) => emittedEvents.push({ event, payload })
    };

    queueEngine = new QueueEngine({
      sessionRepo,
      accountRepo,
      eventEmitter,
      auditRepo
    });

    timingEngine = new TimingEngine({
      sessionRepo,
      queueEngine,
      eventEmitter,
      auditRepo,
      activeDurationMs: 1000,
      processingDurationMs: 500
    });

    attributionEngine = new AttributionEngine({
      sessionRepo,
      obsRepo,
      ticketRepo,
      auditRepo,
      eventEmitter
    });

    recoveryEngine = new RecoveryEngine({
      db,
      sessionRepo,
      accountRepo,
      queueEngine,
      timingEngine,
      auditRepo
    });
  });

  after(() => {
    timingEngine.destroy();
    db.close();
  });

  test('CHAOS 1: 10 simultaneous sessions for identical amounts (₹200) acquire slot deterministically', () => {
    const sessionIds = [];

    // Create 10 sessions for identical ₹200.00
    for (let i = 1; i <= 10; i++) {
      const s = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: testAccount.id,
        orderId: `CHAOS-ORD-${i}`,
        amountPaise: 20000n
      });
      sessionIds.push(s.id);
    }

    // Simultaneously attempt slot acquisition
    const results = sessionIds.map(id => queueEngine.enqueueOrActivate(id, testAccount.id, 300000));

    // Exactly 1 must be ACTIVE
    const activeResults = results.filter(r => r.status === PaymentStatus.ACTIVE);
    assert.equal(activeResults.length, 1);
    assert.equal(activeResults[0].queuePosition, 0);

    // Exactly 9 must be QUEUED with sequential positions 1 to 9
    const queuedResults = results.filter(r => r.status === PaymentStatus.QUEUED);
    assert.equal(queuedResults.length, 9);

    const positions = queuedResults.map(r => r.queuePosition).sort((a, b) => a - b);
    assert.deepEqual(positions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Active session owns the slot
    const activeAccount = accountRepo.findById(testAccount.id);
    assert.equal(activeAccount.isSlotBusy, true);
    assert.equal(activeAccount.currentActiveSessionId, sessionIds[0]);
  });

  test('CHAOS 2: Multi-tab simultaneous Payment Done clicks are strictly idempotent', () => {
    const activeSession = sessionRepo.findCurrentActiveOrProcessing(testAccount.id);
    assert.ok(activeSession);

    // Simulate 5 browser tabs clicking Payment Done at the exact same instant
    const results = [1, 2, 3, 4, 5].map(() => {
      try {
        return timingEngine.handlePaymentDone(activeSession.id);
      } catch (err) {
        return { error: err.message };
      }
    });

    // All must resolve to status PROCESSING
    for (const r of results) {
      assert.equal(r.status, PaymentStatus.PROCESSING);
    }

    // Session in DB must be PROCESSING
    const checkDb = sessionRepo.findById(activeSession.id);
    assert.equal(checkDb.status, PaymentStatus.PROCESSING);
  });

  test('CHAOS 3: Dual-channel flood (Gmail + SMS) guarantees exactly 1 payment attribution', () => {
    const activeSession = sessionRepo.findCurrentActiveOrProcessing(testAccount.id);
    assert.ok(activeSession);
    assert.equal(activeSession.status, PaymentStatus.PROCESSING);

    // Simulate SMS and Gmail seeing the exact same ₹200 transfer (same UTR)
    const utr = 'UTR-CHAOS-9999';

    const obsSms = ObservationNormalizer.normalize({
      source: ObserverSource.GOOGLE_MESSAGES,
      receivingAccountId: testAccount.id,
      amountPaise: 20000n,
      bankReferenceNumber: utr,
      rawPayload: { text: 'SMS Rs 200' }
    });

    const obsGmail = ObservationNormalizer.normalize({
      source: ObserverSource.GMAIL,
      receivingAccountId: testAccount.id,
      amountPaise: 20000n,
      bankReferenceNumber: utr,
      rawPayload: { text: 'Email Rs 200' }
    });

    const resSms = attributionEngine.processObservation(obsSms);
    const resGmail = attributionEngine.processObservation(obsGmail);

    // Multi-channel flood confirms payment at Level 1, then upgrades to Level 2 (Dual Verification)!
    assert.equal(resSms.attributed, true);
    assert.equal(resSms.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);
    assert.equal(resSms.verificationLevel, 1);

    assert.equal(resGmail.attributed, true);
    assert.equal(resGmail.verificationLevel, 2);

    // Redundant duplicate from the same source (SMS again) is safely ignored!
    const resSmsDup = attributionEngine.processObservation(obsSms);
    assert.equal(resSmsDup.attributed, false);
    assert.equal(resSmsDup.duplicate, true);
    assert.equal(resSmsDup.outcomeStatus, ObservationAttributionStatus.DUPLICATE_IGNORED);

    // Session transitions to SUCCESS
    const checkDb = sessionRepo.findById(activeSession.id);
    assert.equal(checkDb.status, PaymentStatus.OBSERVED_SUCCESS);
  });

  test('CHAOS 4: Promotion cascade: completed session immediately unblocks waiting queue in order', () => {
    // Current slot is now freed from CHAOS 3
    const promotedSession = queueEngine.promoteNext(testAccount.id);
    assert.ok(promotedSession);
    assert.equal(promotedSession.status, PaymentStatus.ACTIVE);
    assert.equal(promotedSession.queuePosition, 0);

    // Remaining queue positions should now be 1 to 8
    const remainingQueued = sessionRepo.findQueuedSessions(testAccount.id);
    assert.equal(remainingQueued.length, 8);
    for (let i = 0; i < remainingQueued.length; i++) {
      assert.equal(remainingQueued[i].queuePosition, i + 1);
    }
  });

  test('CHAOS 5: Late observation does not hijack currently active customer session', () => {
    // Current active session is customer B
    const activeCustomerB = sessionRepo.findCurrentActiveOrProcessing(testAccount.id);
    assert.ok(activeCustomerB);

    // A delayed observation arrives for an earlier customer session that expired
    const expiredCust = customerRepo.create({
      merchantId: defaultMerchant.id,
      phoneNumber: '9000011111',
      fullName: 'Late Customer',
      password: 'Password1!'
    });

    const expiredSession = sessionRepo.create({
      merchantId: defaultMerchant.id,
      customerId: expiredCust.id,
      receivingAccountId: testAccount.id,
      orderId: 'ORD-LATE-CUSTOMER',
      amountPaise: 20000n
    });
    sessionRepo.acquireSlotAtomic(expiredSession.id, testAccount.id, 100);
    sessionRepo.transitionToTerminal(expiredSession.id, PaymentStatus.EXPIRED);

    // Observation arrives matching expired amount (20000n)
    const delayedObs = ObservationNormalizer.normalize({
      source: ObserverSource.GMAIL,
      receivingAccountId: testAccount.id,
      amountPaise: 20000n,
      bankReferenceNumber: 'UTR-DELAYED-3322',
      observedAt: new Date(Date.now() - 60000)
    });

    const lateResult = attributionEngine.processObservation(delayedObs);

    // MUST NOT attribute to Active Customer B. Same amount as a recent expiry is manual review.
    assert.equal(lateResult.attributed, false);
    assert.equal(lateResult.ambiguous, true);
    assert.equal(lateResult.outcomeStatus, PaymentStatus.MANUAL_REVIEW);

    const checkB = sessionRepo.findById(activeCustomerB.id);
    assert.equal(checkB.status, PaymentStatus.MANUAL_REVIEW);
    assert.equal(sessionRepo.findById(expiredSession.id).status, PaymentStatus.EXPIRED);
  });
});
