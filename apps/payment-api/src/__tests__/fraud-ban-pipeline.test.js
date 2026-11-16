import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, CustomerRepository, PaymentSessionRepository, MerchantRepository, AuditLogRepository, ObservationRepository } from '@youpi/db';
import { extractIntelligentAmount, BankSmsParser, PaymentVerificationPipeline } from '@youpi/core';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('YOUPI PG: Parser Rule Correction & Exact Fraud/Ban System (All 29 Acceptance Tests)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;
  let customerRepo;
  let sessionRepo;
  let merchantRepo;
  let auditRepo;
  let obsRepo;
  let pipeline;

  const merchantId = '00000000-0000-0000-0000-000000000001';
  const receivingAccountId = '00000000-0000-0000-0000-000000000002';

  before(async () => {
    testDb = new Database({ inMemory: true });
    customerRepo = new CustomerRepository(testDb);
    sessionRepo = new PaymentSessionRepository(testDb);
    merchantRepo = new MerchantRepository(testDb);
    auditRepo = new AuditLogRepository(testDb);
    obsRepo = new ObservationRepository(testDb);

    pipeline = new PaymentVerificationPipeline({
      db: testDb,
      sessionRepo,
      obsRepo,
      customerRepo,
      auditRepo,
      merchantRepo
    });

    apiInstance = await startPaymentApi(6197, testDb);
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

  function createActiveSession(orderId, amountPaise, customerId = null, slotOffsetMs = 0, accountId = receivingAccountId) {
    // A receiving account may hold only one slot-occupying session (partial unique index).
    // Release whatever still occupies *this* account before taking its slot, so repeated
    // calls in separate cases start clean. Sessions on other accounts are untouched.
    testDb.execute(
      `UPDATE payment_sessions SET status = ?, updated_at = ?
       WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING')`,
      [PaymentStatus.CANCELLED, new Date().toISOString(), accountId]
    );

    const now = Date.now() + slotOffsetMs;
    const session = sessionRepo.create({
      merchantId,
      customerId,
      receivingAccountId: accountId,
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

  /**
   * A receiving account holds at most one slot-occupying session (partial unique index).
   * Tests needing several simultaneous ACTIVE sessions must spread them across accounts.
   */
  function createAdditionalReceivingAccount(suffix) {
    const id = `00000000-0000-0000-0000-0000000000${String(suffix).padStart(2, '0')}`;
    testDb.execute(
      `INSERT OR IGNORE INTO payment_receiving_accounts
        (id, merchant_id, upi_id, payee_name, is_merchant_enabled, is_active, is_slot_busy, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)`,
      [id, merchantId, `merchant${suffix}@upi`, 'Fraud Test Merchant', new Date().toISOString(), new Date().toISOString()]
    );
    return id;
  }

  // =========================================================================
  // PARSER ACCEPTANCE TESTS (1 - 6)
  // =========================================================================

  test('1. "Rs 499" parses to 49900 paise', () => {
    const res = extractIntelligentAmount('A/C credited with Rs 499 UPI:123456789012');
    assert.ok(res, 'Should successfully extract amount');
    assert.equal(res.amountPaise, 49900n);
    assert.equal(res.amountStr, '499');
  });

  test('2. "Rs. 499" parses to 49900 paise', () => {
    const res = extractIntelligentAmount('Received Rs. 499 via UPI ref 123456789012');
    assert.ok(res, 'Should successfully extract amount');
    assert.equal(res.amountPaise, 49900n);
    assert.equal(res.amountStr, '499');
  });

  test('3. "₹499" parses to 49900 paise', () => {
    const res = extractIntelligentAmount('Payment of ₹499 received UPI Ref 123456789012');
    assert.ok(res, 'Should successfully extract amount');
    assert.equal(res.amountPaise, 49900n);
    assert.equal(res.amountStr, '499');
  });

  test('4. "INR 499" parses to 49900 paise', () => {
    const res = extractIntelligentAmount('Credited with INR 499 Ref no 123456789012');
    assert.ok(res, 'Should successfully extract amount');
    assert.equal(res.amountPaise, 49900n);
    assert.equal(res.amountStr, '499');
  });

  test('5. "Rs 499.00", "Rs. 499.00", "₹499.00", "INR 499.00" all parse to 49900 paise', () => {
    const variants = [
      'Rs 499.00',
      'Rs. 499.00',
      '₹499.00',
      'INR 499.00'
    ];
    for (const v of variants) {
      const res = extractIntelligentAmount(`Your account has been credited with ${v} Ref 123456789012`);
      assert.ok(res, `Variant ${v} should parse successfully`);
      assert.equal(res.amountPaise, 49900n, `Variant ${v} must normalize to 49900 paise`);
    }
  });

  test('6. Message with no currency indicator ("credited with 499") fails Stage 3 with MISSING_CURRENCY_INDICATOR. NO ban is applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Test No Currency',
      email: 'nocurrency@test.com',
      mobileNumber: '+919999000001'
    });
    const session = createActiveSession('ORD-NOCURR-1', 49900n, cust.id);

    const result = pipeline.process({
      source: 'SMS',
      sender: 'VM-HDFCBK',
      rawText: 'credited with 499 ref 123456789012',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingStage, 3);
    assert.equal(result.failingCondition, 'MISSING_CURRENCY_INDICATOR');

    // Verify NO ban was applied
    const reloadedCust = customerRepo.findById(cust.id);
    assert.equal(reloadedCust.status, 'ACTIVE');
  });

  // =========================================================================
  // AUTO-BAN NON-TRIGGERS (MUST NOT BAN) (7 - 13)
  // =========================================================================

  test('7. Message from unknown personal number (NOT matching customer\'s phone): Rejected at Stage 2. NO ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Customer Seven',
      email: 'seven@test.com',
      mobileNumber: '+919876543207'
    });
    const session = createActiveSession('ORD-SEVEN-1', 49900n, cust.id);

    // Personal number does NOT match customer (+918888888888 vs +919876543210)
    const result = pipeline.process({
      source: 'SMS',
      sender: '+918888888888',
      rawText: 'A/C credited with Rs 499.00 ref 123456789012',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingStage, 2);
    assert.equal(result.failingCondition, 'PERSONAL_SMS_REJECTED');

    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'ACTIVE', 'Customer must remain ACTIVE');
  });

  test('8. Message from personal email (NOT matching customer\'s email): Rejected at Stage 2. NO ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Customer Eight',
      email: 'eight@test.com',
      mobileNumber: '+919876543211'
    });
    const session = createActiveSession('ORD-EIGHT-1', 49900n, cust.id);

    // Personal email does NOT match customer (random@gmail.com vs eight@test.com)
    const result = pipeline.process({
      source: 'GMAIL',
      sender: 'randomstranger@gmail.com',
      rawText: 'Payment credited with Rs 499.00 ref 123456789012',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingStage, 2);
    assert.equal(result.failingCondition, 'INVALID_EMAIL_DOMAIN');

    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'ACTIVE', 'Customer must remain ACTIVE');
  });

  test('9. Valid bank SMS with wrong amount: Rejected at Stage 4. NO ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Customer Nine',
      email: 'nine@test.com',
      mobileNumber: '+919876543212'
    });
    const session = createActiveSession('ORD-NINE-1', 49900n, cust.id);

    // Valid institutional bank sender, but amount is Rs 100 instead of Rs 499
    const result = pipeline.process({
      source: 'SMS',
      sender: 'VM-HDFCBK',
      rawText: 'A/C credited with Rs 100.00 ref 123456789012',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingStage, 4);
    assert.equal(result.failingCondition, 'AMOUNT_MISMATCH');

    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'ACTIVE', 'Customer must remain ACTIVE');
  });

  test('10. Valid bank SMS with missing credit indicator: Rejected at Stage 3. NO ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Customer Ten',
      email: 'ten@test.com',
      mobileNumber: '+919876543213'
    });
    const session = createActiveSession('ORD-TEN-1', 49900n, cust.id);

    // Valid bank sender, has currency and 12-digit ref, but NO credit keyword
    const result = pipeline.process({
      source: 'SMS',
      sender: 'VM-HDFCBK',
      rawText: 'Your account balance is Rs 499.00 ref 123456789012',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingStage, 3);
    assert.equal(result.failingCondition, 'MISSING_CREDIT_INDICATOR');

    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'ACTIVE', 'Customer must remain ACTIVE');
  });

  test('10b. Bank debit alert that names the payee as credited: Rejected at Stage 3', () => {
    const session = createActiveSession('ORD-TEN-B-1', 49900n);

    const result = pipeline.process({
      source: 'SMS',
      sender: 'VM-ICICIB',
      rawText: 'ICICI Bank Acct XX123 debited for Rs 499.00 on 15-Nov-26; SHOP NAME credited. UPI:512345678901. Call 18002662 for dispute.',
      paymentSessionId: session.id
    });

    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingStage, 3);
    assert.equal(result.failingCondition, 'DEBIT_TRANSACTION');
  });

  test('11. Malformed text / random string: Rejected at Stage 3. NO ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Customer Eleven',
      email: 'eleven@test.com',
      mobileNumber: '+919876543214'
    });
    const session = createActiveSession('ORD-ELEVEN-1', 49900n, cust.id);

    const result = pipeline.process({
      source: 'SMS',
      sender: 'VM-HDFCBK',
      rawText: 'asdfqwerty12345randomgarbledtext',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.failingStage, 3);

    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'ACTIVE', 'Customer must remain ACTIVE');
  });

  test('12. Message containing "<script>" or "DROP TABLE": Rejected by parser/sanitizer. NO ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Customer Twelve',
      email: 'twelve@test.com',
      mobileNumber: '+919876543215'
    });
    const session = createActiveSession('ORD-TWELVE-1', 49900n, cust.id);

    // Injection string without defined fraud match
    const result = pipeline.process({
      source: 'SMS',
      sender: 'VM-HDFCBK',
      rawText: '<script>alert("xss")</script> DROP TABLE customers; --',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'REJECTED');

    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'ACTIVE', 'Generic injection strings must NOT trigger automatic banning');
  });

  test('13. Message containing "suspicious", "hack", "test": Processed normally. NO ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Customer Thirteen',
      email: 'thirteen@test.com',
      mobileNumber: '+919876543216'
    });
    const session = createActiveSession('ORD-THIRTEEN-1', 49900n, cust.id);

    // Legitimate bank message where note or sender contains "test" or "suspicious"
    const result = pipeline.process({
      source: 'SMS',
      sender: 'VM-HDFCBK',
      rawText: 'Account credited with Rs 499.00 ref 987654321098 note: suspicious hack test order',
      paymentSessionId: session.id
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'VERIFIED');

    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'ACTIVE', 'Legitimate bank message must remain ACTIVE');
  });

  // =========================================================================
  // DEFINED FRAUD SCENARIO (MUST BAN) (14 - 25)
  // =========================================================================

  test('14. Customer with phone +919876543210 has active payment session. Observation arrives from SMS sender "+919876543210". Content contains valid credit format matching session amount.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Fraud Suspect 14',
      email: 'fraud14@test.com',
      mobileNumber: '+919876543210'
    });
    const session = createActiveSession('ORD-FRAUD-14', 49900n, cust.id);
    const rawFakeMessage = 'A/C credited with Rs 499.00 UPI Ref 112233445566 to YOUPI STORE';

    const result = pipeline.process({
      source: 'SMS',
      sender: '+919876543210',
      rawText: rawFakeMessage,
      paymentSessionId: session.id
    });

    // 1. Payment is NOT confirmed
    assert.equal(result.success, false, 'Payment must NOT be confirmed (DO NOT PAY)');
    assert.equal(result.status, 'REJECTED');

    // 2. customer.status becomes 'BANNED'
    const updatedCust = customerRepo.findById(cust.id);
    assert.equal(updatedCust.status, 'BANNED', 'Customer status must become BANNED');
    assert.equal(updatedCust.banReason, 'FRAUDULENT_PAYMENT_INJECTION');

    // 3. Security event recorded: FRAUDULENT_PAYMENT_INJECTION
    const secEvents = customerRepo.getSecurityEvents(cust.id);
    assert.ok(secEvents.length > 0, 'Security event must be recorded');
    assert.equal(secEvents[0].eventType, 'FRAUDULENT_PAYMENT_INJECTION');

    // 4. Raw message preserved verbatim
    assert.equal(secEvents[0].rawMessage, rawFakeMessage, 'Raw message must be preserved verbatim word-for-word');
  });

  test('15. Customer with phone 9876543210 has active payment session. Observation arrives from SMS sender "+91 98765 43210". Result: Auto-ban applied (phone format normalized).', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Fraud Suspect 15',
      email: 'fraud15@test.com',
      mobileNumber: '9876543255'
    });
    const session = createActiveSession('ORD-FRAUD-15', 50000n, cust.id);

    const result = pipeline.process({
      source: 'SMS',
      sender: '+91 98765 43255', // Spaces and country code formatting
      rawText: '₹500.00 credited to a/c via UPI/CR/123456789099',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    const updatedCust = customerRepo.findById(cust.id);
    assert.equal(updatedCust.status, 'BANNED', 'Phone format must normalize and trigger auto-ban');
  });

  test('16. Customer with email user@gmail.com has active payment session. Observation arrives from email sender "user@gmail.com". Result: Auto-ban applied.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Fraud Suspect 16',
      email: 'user16@gmail.com',
      mobileNumber: '+919876543219'
    });
    const session = createActiveSession('ORD-FRAUD-16', 75000n, cust.id);

    const result = pipeline.process({
      source: 'GMAIL',
      sender: 'user16@gmail.com', // Customer attempts to inject fake payment from personal Gmail
      rawText: 'Payment received: INR 750.00 ref: 998877665544 credited to merchant account',
      paymentSessionId: session.id
    });

    assert.equal(result.success, false);
    const updatedCust = customerRepo.findById(cust.id);
    assert.equal(updatedCust.status, 'BANNED', 'Personal email match must trigger auto-ban');
  });

  test('17. Banned customer attempts to initiate new payment session: Rejected with 403 / BLOCKED status.', async () => {
    const bannedCust = customerRepo.create({
      merchantId,
      name: 'Blocked User 17',
      email: 'blocked17@test.com',
      mobileNumber: '+919876543220'
    });
    customerRepo.banCustomer(bannedCust.id, 'FRAUDULENT_PAYMENT_INJECTION');

    // Attempt initiating payment
    const res = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-BLOCKED-17',
        amount: 499.00,
        customerId: bannedCust.id
      }
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.status, 'BLOCKED');
    assert.ok(res.body.error.includes('ACCESS BLOCKED'));
  });

  test('18. Banned customer\'s existing active sessions: Immediately transitioned to EXPIRED.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Active Session User 18',
      email: 'user18@test.com',
      mobileNumber: '+919876543221'
    });
    const s1 = createActiveSession('ORD-18-A', 49900n, cust.id);
    // Second concurrent session needs a second slot: one account can only hold one.
    const s2 = createActiveSession('ORD-18-B', 99900n, cust.id, 0, createAdditionalReceivingAccount(91));

    assert.equal(sessionRepo.findById(s1.id).status, PaymentStatus.ACTIVE);
    assert.equal(sessionRepo.findById(s2.id).status, PaymentStatus.ACTIVE);

    // Apply ban
    customerRepo.banCustomer(cust.id, 'FRAUDULENT_PAYMENT_INJECTION');

    // Verify both sessions were immediately transitioned to EXPIRED
    assert.equal(sessionRepo.findById(s1.id).status, PaymentStatus.EXPIRED);
    assert.equal(sessionRepo.findById(s2.id).status, PaymentStatus.EXPIRED);
  });

  test('19. Banned customer appears in Merchant Panel Banned Users list.', async () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Listed Banned User 19',
      email: 'user19@test.com',
      mobileNumber: '+919876543222'
    });
    customerRepo.banCustomer(cust.id, 'FRAUDULENT_PAYMENT_INJECTION');

    const res = await request('/api/v1/admin/security/banned-users');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.bannedUsers));
    const found = res.body.bannedUsers.find(u => u.id === cust.id);
    assert.ok(found, 'Banned customer must appear in banned users list');
    assert.equal(found.status, 'BANNED');
  });

  test('20. Merchant can view complete evidence dossier in Merchant Panel including the EXACT raw message text.', async () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Evidence Dossier User 20',
      email: 'user20@test.com',
      mobileNumber: '+919876543223'
    });
    const session = createActiveSession('ORD-20', 49900n, cust.id);
    const exactRaw = 'VERBATIM_RAW_TEST_PAYLOAD_98765: Rs 499 credited ref 123456789012';

    pipeline.process({
      source: 'SMS',
      sender: '+919876543223',
      rawText: exactRaw,
      paymentSessionId: session.id
    });

    const res = await request(`/api/v1/admin/security/banned-users/${cust.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.customer);
    assert.ok(res.body.banDetails);
    assert.ok(res.body.observationMetadata);
    assert.ok(res.body.discrepancyAnalysis);
    assert.ok(res.body.timeline);
    assert.equal(res.body.rawEvidence, exactRaw, 'Evidence dossier must include EXACT verbatim raw message');
  });

  test('21. Merchant can unban customer with mandatory reason.', async () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Unban Target 21',
      email: 'user21@test.com',
      mobileNumber: '+919876543224'
    });
    customerRepo.banCustomer(cust.id, 'FRAUDULENT_PAYMENT_INJECTION');

    const res = await request('/api/v1/admin/security/unban', {
      method: 'POST',
      body: {
        customerId: cust.id,
        reason: 'Customer verified via phone call'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updated = customerRepo.findById(cust.id);
    assert.equal(updated.status, 'ACTIVE', 'Customer status must become ACTIVE after unban');
  });

  test('22. After unban: customer can initiate payments again.', async () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Restored User 22',
      email: 'user22@test.com',
      mobileNumber: '+919876543225'
    });
    customerRepo.banCustomer(cust.id, 'FRAUDULENT_PAYMENT_INJECTION');

    // Unban
    await request('/api/v1/admin/security/unban', {
      method: 'POST',
      body: { customerId: cust.id, reason: 'False positive investigated' }
    });

    // Initiate payment
    const res = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD-RESTORED-22',
        amount: 250.00,
        customerId: cust.id
      }
    });

    assert.ok(res.status === 200 || res.status === 201, 'Customer must be able to initiate payment after unban');
    assert.equal(res.body.orderId, 'ORD-RESTORED-22');
  });

  test('23. Merchant can manually ban customer with mandatory reason.', async () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Manual Ban Target 23',
      email: 'user23@test.com',
      mobileNumber: '+919876543226'
    });

    const res = await request('/api/v1/admin/security/manual-ban', {
      method: 'POST',
      body: {
        customerId: cust.id,
        reason: 'Abusive chargeback threats',
        notes: 'Customer repeatedly threatened fraudulent dispute'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updated = customerRepo.findById(cust.id);
    assert.equal(updated.status, 'BANNED');
    assert.equal(updated.banReason, 'MANUAL_BAN');
  });

  test('24. Manual ban records MANUAL_BAN event in audit log.', () => {
    const logs = testDb.query(`
      SELECT * FROM audit_logs WHERE action = 'CUSTOMER_MANUALLY_BANNED' ORDER BY created_at DESC LIMIT 1
    `);
    assert.ok(logs.length > 0, 'Audit log must contain CUSTOMER_MANUALLY_BANNED');
  });

  test('25. Auto-ban records FRAUDULENT_PAYMENT_INJECTION event in audit log.', () => {
    const logs = testDb.query(`
      SELECT * FROM audit_logs WHERE action = 'CUSTOMER_AUTOMATICALLY_BANNED' ORDER BY created_at DESC LIMIT 1
    `);
    assert.ok(logs.length > 0, 'Audit log must contain CUSTOMER_AUTOMATICALLY_BANNED');
  });

  // =========================================================================
  // TEST MODE ACCEPTANCE TESTS (26 - 29)
  // =========================================================================

  test('26. When defined fraud scenario occurs: triggers FRAUDULENT_PAYMENT_INJECTION detection, payment is NOT confirmed, customer IS automatically banned, and security event is recorded.', () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Test Mode Customer 26',
      email: 'testmode26@test.com',
      mobileNumber: '+919876543227'
    });
    const session = createActiveSession('ORD-TESTMODE-26', 49900n, cust.id);

    const result = pipeline.process({
      source: 'SMS',
      sender: '+919876543227',
      rawText: 'Rs 499.00 credited ref 123456789012 to merchant',
      paymentSessionId: session.id,
      isTest: true,
      testModeActive: true
    });

    // 1. Payment is NOT confirmed and status is REJECTED
    assert.equal(result.success, false, 'Payment must NOT be confirmed');
    assert.equal(result.status, 'REJECTED', 'Status is REJECTED');
    assert.equal(result.failingCondition, 'FRAUDULENT_PAYMENT_INJECTION');

    // 2. Customer status is immediately BANNED
    const reloaded = customerRepo.findById(cust.id);
    assert.equal(reloaded.status, 'BANNED', 'Customer must be automatically banned');
    assert.equal(reloaded.banReason, 'FRAUDULENT_PAYMENT_INJECTION');

    // 3. Security event is recorded
    const secEvents = customerRepo.getSecurityEvents(cust.id);
    assert.ok(secEvents.length > 0, 'Security event must be recorded');
  });

  test('27. Fraud security event has autoBanApplied = true and records verbatim details.', () => {
    const cust = customerRepo.findByMobile('+919876543227');
    const secEvents = customerRepo.getSecurityEvents(cust.id);
    assert.ok(secEvents.length > 0);
    const ev = secEvents[0];
    assert.equal(ev.autoBanApplied, true, 'autoBanApplied must be true');
    assert.equal(ev.fraudReason, 'FRAUDULENT_PAYMENT_INJECTION');
  });

  test('28. Synthetic observations cannot be injected when Test Mode is OFF.', async () => {
    // Explicitly disable test mode
    await request('/api/v1/admin/dev/test-mode', {
      method: 'POST',
      body: { enabled: false }
    });

    // Attempt injection
    const res = await request('/api/v1/admin/dev/test-mode/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        message: 'A/C credited with Rs 499.00 ref 123456789012'
      }
    });

    assert.equal(res.status, 403, 'Synthetic injection must be rejected with 403 when Test Mode is OFF');
    assert.equal(res.body.testModeActive, false);
  });

  test('29. Test Mode automatically expires after 10 minutes.', async () => {
    // Enable test mode
    const enableRes = await request('/api/v1/admin/dev/test-mode', {
      method: 'POST',
      body: { enabled: true }
    });

    assert.equal(enableRes.status, 200);
    assert.equal(enableRes.body.enabled, true);

    const until = enableRes.body.testModeUntil;
    const enabledAt = enableRes.body.testModeEnabledAt;
    assert.ok(until && enabledAt);

    // Verify exactly 10 minutes (600,000 ms) window
    const durationMs = until - enabledAt;
    assert.equal(durationMs, 10 * 60 * 1000, 'Test mode window must be exactly 10 minutes (600,000 ms)');

    // Simulate expiration by setting testModeUntil in the past
    const merchant = merchantRepo.findById(merchantId);
    merchantRepo.update(merchantId, {
      branding: {
        ...(merchant.branding || {}),
        testModeUntil: Date.now() - 5000 // Expired 5 seconds ago
      }
    });

    // Verify status returns enabled = false after expiration
    const statusRes = await request('/api/v1/admin/dev/test-mode');
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.enabled, false, 'Expired test mode must report enabled = false');
    assert.equal(statusRes.body.remainingSeconds, 0);
  });

  // =========================================================================
  // REAL-TIME FAKE SMS/EMAIL DETECTION & CHECKOUT GATEWAY INVESTIGATION SCREEN
  // =========================================================================

  test('30. When user pushes fake SMS: server detects fraud instantly, auto-bans customer, terminates ongoing session, and checkout state reports BLOCKED under-investigation screen', async () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Realtime Fake SMS Pusher',
      email: 'fakesms30@test.com',
      mobileNumber: '+919876543230'
    });
    const session = createActiveSession('ORD-REALTIME-30', 49900n, cust.id);

    // Verify session starts ACTIVE and customer is ACTIVE
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.ACTIVE);
    assert.equal(customerRepo.findById(cust.id).status, 'ACTIVE');

    // User pushes fake SMS matching their registered mobile
    const pushRes = await request(`/api/v1/checkout/${session.id}/simulate-observation`, {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: '+919876543230',
        rawText: 'A/C credited with Rs 499.00 UPI Ref 112233445566 to YOUPI STORE'
      }
    });

    // 1. Instantly rejected with 403 / BLOCKED
    assert.equal(pushRes.status, 403);
    assert.equal(pushRes.body.status, 'BLOCKED');
    assert.equal(pushRes.body.isBanned, true);
    assert.equal(pushRes.body.reason, 'FRAUDULENT_PAYMENT_INJECTION');

    // 2. Customer is instantly BANNED
    const reloadedCust = customerRepo.findById(cust.id);
    assert.equal(reloadedCust.status, 'BANNED');
    assert.equal(reloadedCust.banReason, 'FRAUDULENT_PAYMENT_INJECTION');

    // 3. Ongoing session is instantly TERMINATED (EXPIRED)
    const reloadedSession = sessionRepo.findById(session.id);
    assert.equal(reloadedSession.status, PaymentStatus.EXPIRED);

    // 4. Checkout state endpoint immediately returns BLOCKED with investigation notice
    const stateRes = await request(`/api/v1/checkout/${session.id}/state`);
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.status, 'BLOCKED');
    assert.equal(stateRes.body.isBanned, true);
    assert.equal(stateRes.body.fraudDetected, true);
    assert.ok(stateRes.body.blockedNotice);
    assert.equal(stateRes.body.blockedNotice.title, 'FRAUDULENT ACTIVITY DETECTED');
    assert.equal(stateRes.body.blockedNotice.investigating, true);
    assert.ok(stateRes.body.blockedNotice.message.includes('investigates the issue'));
  });

  test('31. When user pushes fake email: server detects fraud instantly, auto-bans customer, terminates ongoing session, and checkout state reports BLOCKED under-investigation screen', async () => {
    const cust = customerRepo.create({
      merchantId,
      name: 'Realtime Fake Email Pusher',
      email: 'fakeemail31@test.com',
      mobileNumber: '+919876543231'
    });
    const session = createActiveSession('ORD-REALTIME-31', 99900n, cust.id);

    // User pushes fake email matching their registered email
    const pushRes = await request(`/api/v1/checkout/${session.id}/simulate-observation`, {
      method: 'POST',
      body: {
        source: 'GMAIL',
        sender: 'fakeemail31@test.com',
        rawText: 'Your account has been credited with ₹999.00 ref 998877665544 to YOUPI STORE'
      }
    });

    assert.equal(pushRes.status, 403);
    assert.equal(pushRes.body.status, 'BLOCKED');
    assert.equal(pushRes.body.isBanned, true);

    // Customer is instantly BANNED & session is TERMINATED
    assert.equal(customerRepo.findById(cust.id).status, 'BANNED');
    assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.EXPIRED);

    // Checkout portal state reports BLOCKED with investigating badge
    const stateRes = await request(`/api/v1/checkout/${session.id}/state`);
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.status, 'BLOCKED');
    assert.equal(stateRes.body.isBanned, true);
    assert.equal(stateRes.body.fraudDetected, true);
  });
});
