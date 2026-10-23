import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTransition,
  assertValidTransition,
  toPublicOutcome,
  ObservationNormalizer,
  AttributionEngine,
  BankSmsParser
} from '../index.js';
import { extractIntelligentAmount } from '../bank-sms-parser.js';
import {
  PaymentStatus,
  PublicPaymentOutcome,
  ObserverSource,
  ObservationAttributionStatus
} from '@youpi/common';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  CustomerRepository
} from '@youpi/db';

describe('@youpi/core Unit & Integration Tests', () => {
  describe('Payment State Machine', () => {
    test('permits valid transitions and denies illegal transitions', () => {
      assert.equal(isValidTransition(PaymentStatus.INITIATED, PaymentStatus.ACTIVE), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.PROCESSING), true);
      assert.equal(isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.SUCCESS), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.OBSERVED_SUCCESS), true);
      assert.equal(isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.OBSERVED_SUCCESS), true);
      assert.equal(isValidTransition(PaymentStatus.OBSERVED_SUCCESS, PaymentStatus.RECONCILED), true);
      assert.equal(isValidTransition(PaymentStatus.MANUAL_REVIEW, PaymentStatus.RECONCILED), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.RECONCILED), false);
      assert.equal(isValidTransition(PaymentStatus.OBSERVED_SUCCESS, PaymentStatus.SUCCESS), false);
      assert.equal(isValidTransition(PaymentStatus.RECONCILED, PaymentStatus.OBSERVED_SUCCESS), false);
      assert.equal(isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.FAILED), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.EXPIRED), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.CANCELLED), true);

      // Cash-on-Delivery: placing the order terminates the session as SUCCESS even before
      // a UPI slot is acquired (INITIATED/QUEUED) or while it is held (ACTIVE).
      assert.equal(isValidTransition(PaymentStatus.INITIATED, PaymentStatus.SUCCESS), true);
      assert.equal(isValidTransition(PaymentStatus.QUEUED, PaymentStatus.SUCCESS), true);

      // Illegal transitions
      assert.equal(isValidTransition(PaymentStatus.QUEUED, PaymentStatus.PROCESSING), false);
      assert.equal(isValidTransition(PaymentStatus.EXPIRED, PaymentStatus.SUCCESS), false);
      assert.equal(isValidTransition(PaymentStatus.SUCCESS, PaymentStatus.FAILED), false);
      assert.equal(isValidTransition(PaymentStatus.SUCCESS, PaymentStatus.ACTIVE), false);
      assert.equal(isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.ACTIVE), false);

      assert.throws(
        () => assertValidTransition(PaymentStatus.SUCCESS, PaymentStatus.ACTIVE),
        /Illegal payment state transition/
      );
    });

    test('maps internal terminal states to public contract outcomes', () => {
      assert.equal(toPublicOutcome(PaymentStatus.SUCCESS), PublicPaymentOutcome.SUCCESS);
      assert.equal(toPublicOutcome(PaymentStatus.OBSERVED_SUCCESS), PublicPaymentOutcome.OBSERVED_SUCCESS);
      assert.equal(toPublicOutcome(PaymentStatus.RECONCILED), PublicPaymentOutcome.RECONCILED);
      assert.equal(toPublicOutcome(PaymentStatus.MANUAL_REVIEW), PublicPaymentOutcome.MANUAL_REVIEW);
      assert.equal(toPublicOutcome(PaymentStatus.FAILED), PublicPaymentOutcome.FAILED);
      assert.equal(toPublicOutcome(PaymentStatus.EXPIRED), PublicPaymentOutcome.EXPIRED);
      assert.equal(toPublicOutcome(PaymentStatus.CANCELLED), PublicPaymentOutcome.CANCELLED);

      assert.throws(
        () => toPublicOutcome(PaymentStatus.ACTIVE),
        /internal non-terminal state/
      );
    });
  });

  describe('Observation Normalizer', () => {
    test('extracts monetary amounts from various notification formats', () => {
      const obs1 = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: 'acc_1',
        rawPayload: {
          snippet: 'Your account has been credited with Rs. 200.00 on 08-Sep-2026. Ref: UTR12345678'
        }
      });
      assert.equal(obs1.amountPaise, 20000n);
      assert.equal(obs1.bankReferenceNumber, 'UTR12345678');
      assert.ok(obs1.fingerprintHash);

      const obs2 = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: 'acc_1',
        rawPayload: {
          notificationText: 'Payment of ₹1,500.50 received from user@upi via PhonePe.'
        }
      });
      assert.equal(obs2.amountPaise, 150050n);
      assert.equal(obs2.senderVpa, 'user@upi');
    });

    test('normalizes explicit amount in paise directly', () => {
      const obs = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: 'acc_1',
        amountPaise: 49900n,
        rawPayload: { text: 'Bank SMS alert' }
      });
      assert.equal(obs.amountPaise, 49900n);
    });

    test('intelligently extracts amounts without standard currency symbols e.g. "20.00 received"', () => {
      const obs = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: 'acc_1',
        rawPayload: { text: '20.00 received from alt account' }
      });
      assert.equal(obs.amountPaise, 2000n);
    });
  });

  describe('Attribution Engine & Invariants', () => {
    let db;
    let sessionRepo;
    let obsRepo;
    let ticketRepo;
    let auditRepo;
    let customerRepo;
    let defaultMerchant;
    let receivingAccount;
    let attributionEngine;
    let emittedEvents;

    beforeEach(() => {
      db = new Database({ inMemory: true });
      const seed = runMigrations(db);
      defaultMerchant = seed.defaultMerchant;
      receivingAccount = { id: '00000000-0000-0000-0000-000000000002' };

      sessionRepo = new PaymentSessionRepository(db);
      obsRepo = new ObservationRepository(db);
      ticketRepo = new SupportTicketRepository(db);
      auditRepo = new AuditLogRepository(db);
      customerRepo = new CustomerRepository(db);

      emittedEvents = [];
      attributionEngine = new AttributionEngine({
        sessionRepo,
        obsRepo,
        ticketRepo,
        auditRepo,
        eventEmitter: {
          emit: (event, payload) => emittedEvents.push({ event, payload })
        }
      });
    });

    afterEach(() => {
      db.close();
    });

    test('attributes matching observation to active processing session', () => {
      // 1. Create and activate session for ₹200
      const session = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-101',
        amountPaise: 20000n
      });

      sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);

      // 2. Normalize and ingest observation for ₹200
      const normObs = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR998877',
        rawPayload: { text: 'Received Rs 200' }
      });

      const result = attributionEngine.processObservation(normObs);
      assert.equal(result.attributed, true);
      assert.equal(result.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);
      assert.equal(result.paymentSessionId, session.id);

      // Verify session updated to SUCCESS in DB
      const updatedSession = sessionRepo.findById(session.id);
      assert.equal(updatedSession.status, PaymentStatus.OBSERVED_SUCCESS);
      assert.ok(updatedSession.completedAt);

      // Verify event was emitted
      assert.ok(emittedEvents.some(e => e.event === 'PAYMENT.OBSERVED_SUCCESS'));
    });

    test('deduplicates multi-channel observations (SMS + Gmail)', () => {
      const session = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-DEDUP',
        amountPaise: 20000n
      });
      sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);

      // Method 1: SMS observes ₹200 with UTR111 -> Level 1 (L1)
      const obsSms = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR111',
        rawPayload: { text: 'Bank SMS notification Rs 200' }
      });
      const res1 = attributionEngine.processObservation(obsSms);
      assert.equal(res1.attributed, true);
      assert.equal(res1.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);
      assert.equal(res1.verificationLevel, 1);

      // Method 2: Gmail observes same payment from independent channel -> Upgrades to Level 2 (L2 Dual Verification)
      const obsGmail = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR111',
        rawPayload: { text: 'Gmail bank email Rs 200' }
      });
      const res2 = attributionEngine.processObservation(obsGmail);
      assert.equal(res2.attributed, true);
      assert.equal(res2.verificationLevel, 2);

      // Duplicate test: SMS submits same UTR111 again -> MUST be rejected as DUPLICATE_IGNORED!
      const resSmsDup = attributionEngine.processObservation(obsSms);
      assert.equal(resSmsDup.attributed, false);
      assert.equal(resSmsDup.duplicate, true);
      assert.equal(resSmsDup.outcomeStatus, ObservationAttributionStatus.DUPLICATE_IGNORED);

      // Exactly ONE success event was emitted (subsequent multi-channel confirmations were verification upgrades)!
      const successEvents = emittedEvents.filter(e => e.event === 'PAYMENT.OBSERVED_SUCCESS');
      assert.equal(successEvents.length, 1);
      const upgradeEvents = emittedEvents.filter(e => e.event === 'PAYMENT.VERIFICATION_UPGRADED');
      assert.equal(upgradeEvents.length, 1);
    });

    test('CRITICAL INVARIANT: Late observation does not attach to a new queued customer', () => {
      // Customer A creates ₹200 session, but it expires
      const customerA = customerRepo.create({
        merchantId: defaultMerchant.id,
        phoneNumber: '9876500001',
        fullName: 'Customer A',
        password: 'PassWord1!'
      });

      const sessionA = sessionRepo.create({
        merchantId: defaultMerchant.id,
        customerId: customerA.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-EXPIRED-A',
        amountPaise: 20000n
      });
      sessionRepo.acquireSlotAtomic(sessionA.id, receivingAccount.id, 300000);
      sessionRepo.transitionToTerminal(sessionA.id, PaymentStatus.EXPIRED);

      // Customer B arrives for another ₹200 and becomes ACTIVE
      const customerB = customerRepo.create({
        merchantId: defaultMerchant.id,
        phoneNumber: '9876500002',
        fullName: 'Customer B',
        password: 'PassWord2!'
      });

      const sessionB = sessionRepo.create({
        merchantId: defaultMerchant.id,
        customerId: customerB.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-ACTIVE-B',
        amountPaise: 20000n
      });
      sessionRepo.acquireSlotAtomic(sessionB.id, receivingAccount.id, 300000);

      // Delayed observation arrives for ₹200 with timestamp corresponding to Customer A's window
      const lateObs = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'DELAYED-UTR-A',
        observedAt: new Date(Date.now() - 60000), // observed during A's time
        rawPayload: { text: 'Delayed bank email' }
      });

      // Customer B is live at the same amount as expired Customer A.
      // The alert could belong to either session, so it must not be given to B
      // and B must be held for manual review instead of staying payable.
      const lateRes = attributionEngine.processObservation(lateObs);

      assert.equal(lateRes.attributed, false);
      assert.equal(lateRes.ambiguous, true);
      assert.equal(lateRes.outcomeStatus, PaymentStatus.MANUAL_REVIEW);

      const checkB = sessionRepo.findById(sessionB.id);
      assert.equal(checkB.status, PaymentStatus.MANUAL_REVIEW);
      const checkA = sessionRepo.findById(sessionA.id);
      assert.equal(checkA.status, PaymentStatus.EXPIRED);
      assert.equal(emittedEvents.some(e => e.event === 'PAYMENT.OBSERVED_SUCCESS'), false);
    });
  });

  

describe('Bank SMS Parser UTR & Amount Extraction', () => {
    test('does not extract English words as UTR when ref prefix is absent', () => {
      const sms = {
        text: 'Dear Customer, your ac no. XXXXX12345 has been credited with Rs 500.00 on 18-Oct-26.'
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '500.00');
      assert.equal(parsed.amountPaise, 50000n);
      assert.notEqual(parsed.bankReferenceNumber, 'Customer');
      assert.equal(parsed.bankReferenceNumber, undefined);
    });

    test('extracts valid UTR from explicit ref no prefix', () => {
      const sms = {
        text: 'A/C 1234 credited by Rs. 499.00 on 18-10-26. UPI Ref no 429182736451 from rahul@upi.'
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '499.00');
      assert.equal(parsed.amountPaise, 49900n);
      assert.equal(parsed.bankReferenceNumber, '429182736451');
      assert.equal(parsed.senderVpa, 'rahul@upi');
    });

    test('extracts standalone 12-digit UTR', () => {
      const sms = {
        text: 'Rs 1200.00 received in your account via UPI 987654321012 on 18/10.'
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '1200.00');
      assert.equal(parsed.bankReferenceNumber, '987654321012');
    });

    test('ignores available balance amount appearing before credit amount', () => {
      const sms = {
        text: 'Avl Bal Rs 15,000.00. Rs 500.00 credited to A/c XX1234 for UPI txn Ref 123456789012.'
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '500.00');
      assert.equal(parsed.amountPaise, 50000n);
      assert.equal(parsed.bankReferenceNumber, '123456789012');
    });

    test('rejects debit notification even if credited disclaimer appears later', () => {
      const sms = {
        text: 'Dear Customer, A/c *1234 is debited for Rs 750 on 19-Oct-26. If not done by you, contact bank. Amount will be credited back in 48 hours.'
      };
      const parsed = BankSmsParser.parse(sms);
      assert.equal(parsed, null);
    });

    test('amount extraction is not vulnerable to quadratic backtracking (ReDoS)', () => {
      // The credit patterns chain several whitespace-matching quantifiers. A body such as
      // "credited" followed by a long whitespace run used to take seconds to scan and blocked
      // the payment event loop, so the text is whitespace-collapsed before matching.
      const hostile = 'credited' + ' '.repeat(20000);
      const started = Date.now();
      extractIntelligentAmount(hostile);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 500, `amount extraction took ${elapsed}ms on a whitespace flood`);
    });

    test('rejects bare payment or transfer debit message without credit indicator', () => {
      const sms = {
        text: 'Payment of Rs 350.00 sent to merchant@upi on 19-Oct. UPI Ref 998877665544.'
      };
      const parsed = BankSmsParser.parse(sms);
      assert.equal(parsed, null);
    });

    test('Issue #20: correctly parses FamPay / FamApp credit notification with wallet, transaction ID, and UPI ID', () => {
      const sms = {
        text: 'Money received! Rs. 350.00 credited to FamPay Wallet via UPI from Gaurav (UPI ID: gaurav@fam). Transaction ID: 418293847562'
      };
      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amount, '350.00');
      assert.equal(parsed.amountPaise, 35000n);
      assert.equal(parsed.bankReferenceNumber, '418293847562');
      assert.equal(parsed.senderVpa, 'gaurav@fam');
    });

    test('Issue #20: normalizes FamPay observation with added to account format', () => {
      const obs = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: 'acc_1',
        rawPayload: {
          text: 'Payment received! Rs. 500.00 added to your account via UPI from user@idfcbank. UPI Ref: 328910293841'
        }
      });
      assert.equal(obs.amountPaise, 50000n);
      assert.equal(obs.bankReferenceNumber, '328910293841');
      assert.equal(obs.senderVpa, 'user@idfcbank');
    });
  });

describe('Issue #4: Terminal State Invariants and Re-activation Guards', () => {
    let db;
    let sessionRepo;
    let obsRepo;
    let ticketRepo;
    let auditRepo;
    let customerRepo;
    let defaultMerchant;
    let receivingAccount;
    let attributionEngine;
    let emittedEvents;

    beforeEach(() => {
      db = new Database({ inMemory: true });
      const seed = runMigrations(db);
      defaultMerchant = seed.defaultMerchant;
      receivingAccount = { id: '00000000-0000-0000-0000-000000000002' };

      sessionRepo = new PaymentSessionRepository(db);
      obsRepo = new ObservationRepository(db);
      ticketRepo = new SupportTicketRepository(db);
      auditRepo = new AuditLogRepository(db);
      customerRepo = new CustomerRepository(db);

      emittedEvents = [];
      attributionEngine = new AttributionEngine({
        sessionRepo,
        obsRepo,
        ticketRepo,
        auditRepo,
        eventEmitter: {
          emit: (event, payload) => emittedEvents.push({ event, payload })
        }
      });
    });

    afterEach(() => {
      db.close();
    });
    test('strictly forbids all transitions out of terminal states in the state machine', () => {
      const terminalStates = [
        PaymentStatus.SUCCESS,
        PaymentStatus.RECONCILED,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      const allStates = [
        PaymentStatus.INITIATED,
        PaymentStatus.QUEUED,
        PaymentStatus.ACTIVE,
        PaymentStatus.PROCESSING,
        PaymentStatus.SUCCESS,
        PaymentStatus.OBSERVED_SUCCESS,
        PaymentStatus.RECONCILED,
        PaymentStatus.MANUAL_REVIEW,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      for (const terminal of terminalStates) {
        for (const target of allStates) {
          assert.equal(
            isValidTransition(terminal, target),
            false,
            `Expected isValidTransition('${terminal}', '${target}') to be false`
          );
          assert.throws(
            () => assertValidTransition(terminal, target),
            /Illegal payment state transition/
          );
        }
      }
    });

    test('acquireSlotAtomic rejects sessions in terminal status', () => {
      const testCases = [
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      for (const status of testCases) {
        const session = sessionRepo.create({
          merchantId: defaultMerchant.id,
          receivingAccountId: receivingAccount.id,
          orderId: `ORD-TERMINAL-${status}`,
          amountPaise: 50000n
        });

        if (status === PaymentStatus.CANCELLED) {
          sessionRepo.transitionToTerminal(session.id, PaymentStatus.CANCELLED);
        } else {
          sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id);
          sessionRepo.transitionToTerminal(session.id, status);
        }

        const terminalSession = sessionRepo.findById(session.id);
        assert.equal(terminalSession.status, status);

        assert.throws(
          () => sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id),
          /Cannot acquire slot for session in terminal status|Illegal payment state transition/
        );

        // Status must remain terminal in database
        const afterAttempt = sessionRepo.findById(session.id);
        assert.equal(afterAttempt.status, status);
      }
    });

    test('recordVerificationSource ignores terminal non-success sessions and preserves terminal status', () => {
      const terminalStatuses = [
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      for (const status of terminalStatuses) {
        const session = sessionRepo.create({
          merchantId: defaultMerchant.id,
          receivingAccountId: receivingAccount.id,
          orderId: `ORD-VERIFY-${status}`,
          amountPaise: 40000n
        });
        if (status === PaymentStatus.CANCELLED) {
          sessionRepo.transitionToTerminal(session.id, PaymentStatus.CANCELLED);
        } else {
          sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id);
          sessionRepo.transitionToTerminal(session.id, status);
        }

        const res = sessionRepo.recordVerificationSource(session.id, ObserverSource.GMAIL, 'obs_fake_123', { finalizeSuccess: true });
        assert.equal(res.isFirstSuccess, false);

        // Status in database must still be the terminal status
        const unchanged = sessionRepo.findById(session.id);
        assert.equal(unchanged.status, status);
      }
    });

    test('transitionToProcessing rejects terminal sessions and non-active sessions', () => {
      // 1. INITIATED session rejects transition to PROCESSING
      const initiated = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-INITIATED',
        amountPaise: 15000n
      });
      assert.throws(
        () => sessionRepo.transitionToProcessing(initiated.id),
        /Cannot transition to PROCESSING from status|Illegal payment state transition/
      );

      // 2. QUEUED session rejects transition to PROCESSING
      const activeSess = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-ACTIVE',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(activeSess.id, receivingAccount.id);

      const queuedSess = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-QUEUED',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(queuedSess.id, receivingAccount.id);
      assert.equal(sessionRepo.findById(queuedSess.id).status, PaymentStatus.QUEUED);

      assert.throws(
        () => sessionRepo.transitionToProcessing(queuedSess.id),
        /Cannot transition to PROCESSING from status|Illegal payment state transition/
      );

      // 3. SUCCESS session rejects transition to PROCESSING
      sessionRepo.transitionToTerminal(activeSess.id, PaymentStatus.SUCCESS);
      assert.throws(
        () => sessionRepo.transitionToProcessing(activeSess.id),
        /Cannot transition to PROCESSING from status|Illegal payment state transition/
      );

      // 4. CANCELLED session rejects transition to PROCESSING
      const cancelled = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-CANCELLED',
        amountPaise: 15000n
      });
      sessionRepo.transitionToTerminal(cancelled.id, PaymentStatus.CANCELLED);
      assert.throws(
        () => sessionRepo.transitionToProcessing(cancelled.id),
        /Cannot transition to PROCESSING from status|Illegal payment state transition/
      );

      // 5. EXPIRED session rejects transition to PROCESSING
      const expired = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-EXPIRED',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(expired.id, receivingAccount.id);
      sessionRepo.transitionToTerminal(expired.id, PaymentStatus.EXPIRED);
      assert.throws(
        () => sessionRepo.transitionToProcessing(expired.id),
        /Cannot transition to PROCESSING from status|Illegal payment state transition/
      );

      // 6. FAILED session rejects transition to PROCESSING
      const failed = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-FAILED',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(failed.id, receivingAccount.id);
      sessionRepo.transitionToTerminal(failed.id, PaymentStatus.FAILED);
      assert.throws(
        () => sessionRepo.transitionToProcessing(failed.id),
        /Cannot transition to PROCESSING from status|Illegal payment state transition/
      );
    });


    test('AttributionEngine does not revive expired session to SUCCESS and creates support ticket', () => {
      const customer = customerRepo.create({
        merchantId: defaultMerchant.id,
        phoneNumber: '9123456780',
        fullName: 'Late Paying User',
        password: 'Password9!'
      });

      const expiredSession = sessionRepo.create({
        merchantId: defaultMerchant.id,
        customerId: customer.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-LATE-RECONCILE',
        amountPaise: 75000n
      });

      sessionRepo.acquireSlotAtomic(expiredSession.id, receivingAccount.id);
      sessionRepo.transitionToTerminal(expiredSession.id, PaymentStatus.EXPIRED);

      const lateObs = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: receivingAccount.id,
        amountPaise: 75000n,
        bankReferenceNumber: 'UTR-LATE-999',
        observedAt: new Date(),
        rawPayload: { text: 'Bank alert Rs 750' }
      });

      const result = attributionEngine.processObservation(lateObs);

      assert.equal(result.attributed, false);
      assert.equal(result.lateMatch, true);
      assert.equal(result.paymentSessionId, expiredSession.id);
      assert.equal(result.outcomeStatus, ObservationAttributionStatus.LATE_UNMATCHED);

      // Verify the session status in DB is STILL EXPIRED (not SUCCESS)
      const freshSession = sessionRepo.findById(expiredSession.id);
      assert.equal(freshSession.status, PaymentStatus.EXPIRED);

      // Verify support ticket was created
      const tickets = ticketRepo.findTicketsByCustomer(customer.id);
      assert.ok(tickets.length >= 1);
      const ticket = tickets.find(t => t.paymentId === expiredSession.id);
      assert.ok(ticket);
      assert.ok(ticket.subject.includes('[LATE PAYMENT DETECTED]'));

      // Verify PAYMENT.LATE_DETECTED was emitted and not PAYMENT.OBSERVED_SUCCESS
      const lateEvents = emittedEvents.filter(e => e.event === 'PAYMENT.LATE_DETECTED' && e.payload.paymentId === expiredSession.id);
      assert.equal(lateEvents.length, 1);
      const successEvents = emittedEvents.filter(e => e.event === 'PAYMENT.OBSERVED_SUCCESS' && e.payload.paymentId === expiredSession.id);
      assert.equal(successEvents.length, 0);
    });
  });
});

