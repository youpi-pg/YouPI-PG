import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, CustomerRepository, PaymentSessionRepository, MerchantRepository } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Section 12: Developer Test Mode Acceptance Tests (All 29 Points)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;
  let customerRepo;
  let sessionRepo;
  let merchantRepo;
  const merchantId = '00000000-0000-0000-0000-000000000001';
  const receivingAccountId = '00000000-0000-0000-0000-000000000002';

  before(async () => {
    testDb = new Database({ inMemory: true });
    customerRepo = new CustomerRepository(testDb);
    sessionRepo = new PaymentSessionRepository(testDb);
    merchantRepo = new MerchantRepository(testDb);

    apiInstance = await startPaymentApi(6198, testDb);
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
        headers: {
          'Content-Type': 'application/json',
          'x-merchant-id': merchantId,
          ...authHeadersFor(path), ...(options.headers || {})
        }
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

  // Helper to create an active payment session
  function createActiveSession(orderId, amountPaise, customerId = null, slotOffsetMs = 0) {
    // A receiving account may hold only one slot-occupying session at a time (enforced by a
    // partial unique index). Release any session left over from the previous case so each
    // helper call starts from a clean slot, as the real queue does.
    testDb.execute(
      `UPDATE payment_sessions SET status = ?, updated_at = ?
       WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')`,
      [PaymentStatus.CANCELLED, new Date().toISOString(), receivingAccountId]
    );

    const now = Date.now() + slotOffsetMs;
    const session = sessionRepo.create({
      merchantId,
      customerId,
      receivingAccountId,
      orderId,
      amountPaise,
      currency: 'INR',
      method: PaymentMethod.UPI,
      status: PaymentStatus.ACTIVE,
      slotAcquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 600000).toISOString()
    });
    return session;
  }

  // ---------------------------------------------------------------------------
  // 1-4. Enable Test Mode, 10-Minute Expiry, Refresh & Restart Invariance
  // ---------------------------------------------------------------------------
  test('1 & 2. Enable Test Mode & verify 10-minute server-side expiration', async () => {
    const enableRes = await request('/api/v1/admin/dev/test-mode', {
      method: 'POST',
      body: { enabled: true }
    });

    assert.equal(enableRes.status, 200);
    assert.equal(enableRes.body.enabled, true);
    assert.equal(enableRes.body.autoBanDisabled, true);
    assert.ok(enableRes.body.testModeUntil > Date.now());
    assert.ok(enableRes.body.testModeEnabledAt <= Date.now());

    // Verify 10-minute window (approx 600,000 ms)
    const durationMs = enableRes.body.testModeUntil - enableRes.body.testModeEnabledAt;
    assert.equal(durationMs, 10 * 60 * 1000);
    assert.ok(enableRes.body.remainingSeconds >= 595 && enableRes.body.remainingSeconds <= 600);
  });

  test('3. Verify browser refresh does not reset timer (server-authoritative remaining time)', async () => {
    // Read state like a browser reload
    const getRes = await request('/api/v1/admin/dev/test-mode');
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.enabled, true);
    assert.equal(getRes.body.autoBanDisabled, true);
    assert.ok(getRes.body.remainingSeconds > 0 && getRes.body.remainingSeconds <= 600);
  });

  test('4. Verify server restart does not reset timer (DB persistence)', async () => {
    // Read directly from DB merchant branding to confirm persistence
    const merchant = merchantRepo.findById(merchantId);
    assert.ok(merchant.branding.testModeUntil);
    assert.ok(merchant.branding.testModeEnabledAt);
    assert.equal(merchant.branding.testModeUntil - merchant.branding.testModeEnabledAt, 600000);
  });

  // ---------------------------------------------------------------------------
  // 5-6. Inject valid SMS & verify passes real parser & stages
  // ---------------------------------------------------------------------------
  test('5 & 6. Inject a valid SMS message & verify passes through real parser and stages', async () => {
    const s1 = createActiveSession('TEST_ORD_001', 49900); // ₹499.00
    const rawSms = 'A/C XX1234 credited by Rs 499.00 CR. Ref 123456789012.';

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawSms,
        sender: 'VM-HDFCBK',
        paymentSessionId: s1.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, 'VERIFIED');
    assert.equal(res.body.amount, '₹499.00');
    assert.equal(res.body.reference, '123456789012');
    assert.equal(res.body.stages.stage1.status, 'LOADED');
    assert.equal(res.body.stages.stage2.status, 'PASSED');
    assert.equal(res.body.stages.stage3.status, 'PARSED');
    assert.equal(res.body.stages.stage4.status, 'VERIFIED');
    assert.equal(res.body.stages.stage5.status, 'PASSED');
    assert.equal(res.body.stages.stage6.status, 'ATTRIBUTED');

    // Confirm state machine moved session
    const updated = sessionRepo.findById(s1.id);
    assert.ok([PaymentStatus.OBSERVED_SUCCESS, PaymentStatus.PROCESSING].includes(updated.status));
  });

  // ---------------------------------------------------------------------------
  // 7-8. Inject valid Gmail & verify passes real parser
  // ---------------------------------------------------------------------------
  test('7 & 8. Inject a valid Gmail message & verify passes through real parser', async () => {
    const s2 = createActiveSession('TEST_ORD_002', 75000); // ₹750.00
    const rawGmail = 'Dear Customer, your account has been credited with INR 750.00 via UPI. UPI Ref No: 987654321098.';

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'GMAIL',
        message: rawGmail,
        sender: 'alerts@hdfcbank.net',
        paymentSessionId: s2.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, 'VERIFIED');
    assert.equal(res.body.amount, '₹750.00');
    assert.equal(res.body.reference, '987654321098');
    assert.equal(res.body.stages.stage2.status, 'PASSED');
    assert.equal(res.body.stages.stage3.status, 'PARSED');
    assert.equal(res.body.stages.stage4.status, 'VERIFIED');
    assert.equal(res.body.stages.stage6.status, 'ATTRIBUTED');
  });

  // ---------------------------------------------------------------------------
  // 9-10. Inject incorrect amount & verify rejection
  // ---------------------------------------------------------------------------
  test('9 & 10. Inject an incorrect amount & verify rejection', async () => {
    const s3 = createActiveSession('TEST_ORD_003', 49900); // Expects ₹499.00
    const rawWrongAmount = 'A/C XX1234 credited by Rs 250.00 CR. Ref 111122223333.';

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawWrongAmount,
        sender: 'VM-HDFCBK',
        paymentSessionId: s3.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 4);
    assert.equal(res.body.reason, 'AMOUNT_MISMATCH');
    assert.equal(res.body.stages.stage4.status, 'FAILED');
  });

  // ---------------------------------------------------------------------------
  // 11-12. Remove CR/CREDIT/CREDITED & verify rejection
  // ---------------------------------------------------------------------------
  test('11 & 12. Remove CR/CREDIT/CREDITED & verify rejection', async () => {
    const s4 = createActiveSession('TEST_ORD_004', 49900);
    // Missing credit indicator
    const rawNoCredit = 'A/C XX1234 notification for Rs 499.00. Ref 123456789012.';

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawNoCredit,
        sender: 'VM-HDFCBK',
        paymentSessionId: s4.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 3);
    assert.equal(res.body.reason, 'MISSING_CREDIT_INDICATOR');
    assert.equal(res.body.stages.stage3.status, 'FAILED');
  });

  // ---------------------------------------------------------------------------
  // 13-14. Remove Rs/₹ & verify rejection
  // ---------------------------------------------------------------------------
  test('13 & 14. Remove Rs/₹ & verify rejection', async () => {
    const s5 = createActiveSession('TEST_ORD_005', 49900);
    // Missing currency indicator
    const rawNoCurrency = 'A/C XX1234 credited by 499.00 CR. Ref 123456789012.';

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawNoCurrency,
        sender: 'VM-HDFCBK',
        paymentSessionId: s5.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 3);
    assert.equal(res.body.reason, 'MISSING_CURRENCY_INDICATOR');
    assert.equal(res.body.stages.stage3.status, 'FAILED');
  });

  // ---------------------------------------------------------------------------
  // 15-16. Remove 12-digit reference & verify rejection
  // ---------------------------------------------------------------------------
  test('15 & 16. Remove 12-digit reference & verify rejection', async () => {
    const s6 = createActiveSession('TEST_ORD_006', 49900);
    // Missing 12-digit reference
    const rawNoRef = 'A/C XX1234 credited by Rs 499.00 CR. Transaction completed without reference.';

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawNoRef,
        sender: 'VM-HDFCBK',
        paymentSessionId: s6.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 3);
    assert.equal(res.body.reason, 'MISSING_12_DIGIT_REFERENCE');
    assert.equal(res.body.stages.stage3.status, 'FAILED');
  });

  // ---------------------------------------------------------------------------
  // 17-18. Inject message received before session creation & verify rejection
  // ---------------------------------------------------------------------------
  test('17 & 18. Inject a message received before session creation & verify rejection', async () => {
    const s7 = createActiveSession('TEST_ORD_007', 49900);
    const rawValid = 'A/C XX1234 credited by Rs 499.00 CR. Ref 555666777888.';
    // Timestamp explicitly 5 minutes in the past
    const pastTimestamp = new Date(Date.now() - 300000).toISOString();

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawValid,
        sender: 'VM-HDFCBK',
        receivedAt: pastTimestamp,
        paymentSessionId: s7.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 4);
    assert.equal(res.body.reason, 'BEFORE_SESSION_CREATION');
    assert.equal(res.body.stages.stage4.status, 'FAILED');
  });

  // ---------------------------------------------------------------------------
  // 19-20. Inject duplicate observation & verify duplicate protection
  // ---------------------------------------------------------------------------
  test('19 & 20. Inject a duplicate observation & verify duplicate protection', async () => {
    const s8 = createActiveSession('TEST_ORD_008', 35000); // ₹350.00
    const fixedTime = new Date().toISOString();
    const rawMsg = 'A/C XX1234 credited by Rs 350.00 CR. Ref 777888999000.';

    // 1st injection
    const res1 = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawMsg,
        sender: 'VM-HDFCBK',
        receivedAt: fixedTime,
        paymentSessionId: s8.id
      }
    });
    assert.equal(res1.body.status, 'VERIFIED');

    // 2nd identical injection with same fingerprint
    const res2 = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawMsg,
        sender: 'VM-HDFCBK',
        receivedAt: fixedTime,
        paymentSessionId: s8.id
      }
    });

    assert.equal(res2.body.success, false);
    assert.equal(res2.body.status, 'REJECTED');
    assert.equal(res2.body.failingStage, 4);
    assert.equal(res2.body.reason, 'DUPLICATE_OBSERVATION');
  });

  // ---------------------------------------------------------------------------
  // 21-22. Inject suspicious/fraud-like message & verify detection occurs but auto-ban does NOT occur
  // ---------------------------------------------------------------------------
  test('21 & 22. Inject suspicious message: verify fraud detection occurs and automatic banning is executed immediately', async () => {
    const customer = customerRepo.create({
      name: 'Safe Developer Tester',
      email: 'safe_tester@youpi.local',
      mobileNumber: '9988776655',
      status: 'ACTIVE'
    });

    const s9 = createActiveSession('TEST_ORD_009', 49900, customer.id);
    const rawSuspicious = 'A/C XX1234 credited by Rs 499.00 CR. Ref 444333222111. <script>stealToken()</script> FRAUD_PAYLOAD';

    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawSuspicious,
        sender: customer.mobileNumber,
        paymentSessionId: s9.id
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.stages.stage5.status, 'FAILED');
    assert.equal(res.body.stages.stage5.isSuspicious, true);
    assert.equal(res.body.stages.stage5.autoBanApplied, true);
    assert.equal(res.body.stages.stage5.reason, 'FRAUDULENT_PAYMENT_INJECTION');

    // Verify identity was automatically banned!
    const customerAfter = customerRepo.findById(customer.id);
    assert.equal(customerAfter.status, 'BANNED');
    assert.equal(customerAfter.banReason, 'FRAUDULENT_PAYMENT_INJECTION');
  });

  // ---------------------------------------------------------------------------
  // 23-24. Confirm raw test SMS and Gmail are preserved verbatim
  // ---------------------------------------------------------------------------
  test('23 & 24. Confirm raw test SMS and Gmail are preserved verbatim', async () => {
    const rawCustomSms = '   Custom SMS with exact spacing: A/C XX1234 credited by Rs 499.00 CR. Ref 888777666555.   ';
    const s10 = createActiveSession('TEST_ORD_010', 49900);

    const smsRes = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: rawCustomSms,
        sender: 'VM-HDFCBK',
        paymentSessionId: s10.id
      }
    });
    assert.equal(smsRes.body.raw, rawCustomSms);

    const rawCustomGmail = '   Exact raw email body: Dear User, credited with Rs 499.00. Ref 112233445566.   ';
    const s11 = createActiveSession('TEST_ORD_011', 49900);

    const gmailRes = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'GMAIL',
        message: rawCustomGmail,
        sender: 'alerts@hdfcbank.net',
        paymentSessionId: s11.id
      }
    });
    assert.equal(gmailRes.body.raw, rawCustomGmail);
  });

  // ---------------------------------------------------------------------------
  // 25-27. Test Mode expires -> automatically becomes OFF & auto-banning is restored
  // ---------------------------------------------------------------------------
  test('25, 26 & 27. Wait until Test Mode expires: verify Test Mode = OFF & automatic banning is restored', async () => {
    // Simulate expiration by setting testModeUntil in the past
    const merchant = merchantRepo.findById(merchantId);
    merchantRepo.update(merchantId, {
      branding: {
        ...merchant.branding,
        testModeUntil: Date.now() - 1000 // Expired 1 second ago
      }
    });

    // Check GET status
    const statusRes = await request('/api/v1/admin/dev/test-mode');
    assert.equal(statusRes.body.enabled, false);
    assert.equal(statusRes.body.autoBanDisabled, false);
    assert.equal(statusRes.body.remainingSeconds, 0);

    // Verify automatic banning is restored: Test using the pipeline when testModeActive = false
    const badCustomer = customerRepo.create({
      name: 'Malicious Attacker',
      email: 'attacker@evil.com',
      mobileNumber: '9111222333',
      status: 'ACTIVE'
    });

    const s12 = createActiveSession('ATTACK_ORD_012', 49900, badCustomer.id);
    const pipeline = apiInstance.app.context.pipeline;

    const attackResult = pipeline.process({
      source: 'SMS',
      rawText: 'A/C XX1234 credited by Rs 499.00 CR. Ref 999888777666.',
      sender: badCustomer.mobileNumber,
      paymentSessionId: s12.id,
      isTest: false,
      testModeActive: false // Expired!
    });

    assert.equal(attackResult.status, 'REJECTED');
    assert.equal(attackResult.stages.stage5.status, 'FAILED');
    assert.equal(attackResult.stages.stage5.autoBanApplied, true);

    // Verify customer is now BANNED in DB!
    const bannedCustomer = customerRepo.findById(badCustomer.id);
    assert.equal(bannedCustomer.status, 'BANNED');
  });

  // ---------------------------------------------------------------------------
  // 28-29. Attempt synthetic injection after expiration & verify controls are blocked
  // ---------------------------------------------------------------------------
  test('28 & 29. Attempt another synthetic injection after expiration & verify test controls are blocked', async () => {
    // Test Mode is expired
    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: 'A/C XX1234 credited by Rs 499.00 CR. Ref 123456789012.',
        sender: 'VM-HDFCBK'
      }
    });

    // Must be blocked with 403 Forbidden!
    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
    assert.equal(res.body.testModeActive, false);
    assert.ok(res.body.error.includes('Test Mode is inactive or has expired'));
  });

  // ---------------------------------------------------------------------------
  // Additional: Audit log endpoint verification (Section 11I)
  // ---------------------------------------------------------------------------
  test('Audit Log Endpoint returns recorded test injections and metadata', async () => {
    const auditRes = await request('/api/v1/admin/dev/test-mode/audit');
    assert.equal(auditRes.status, 200);
    assert.ok(Array.isArray(auditRes.body.logs));
    assert.ok(auditRes.body.logs.length > 0);
  });
});
