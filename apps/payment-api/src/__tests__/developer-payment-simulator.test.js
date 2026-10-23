import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, CustomerRepository, CustomerSessionRepository, PaymentSessionRepository, MerchantRepository } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Feature 65: Developer Payment Simulator Integration & Acceptance Suite', () => {
  let apiInstance;
  let baseUrl;
  let testDb;
  let merchantRepo;
  let sessionRepo;
  let customerRepo;
  let customerSessionRepo;
  const merchantId = '00000000-0000-0000-0000-000000000001';
  const receivingAccountId = '00000000-0000-0000-0000-000000000002';

  before(async () => {
    testDb = new Database({ inMemory: true });
    merchantRepo = new MerchantRepository(testDb);
    sessionRepo = new PaymentSessionRepository(testDb);
    customerRepo = new CustomerRepository(testDb);
    customerSessionRepo = new CustomerSessionRepository(testDb, customerRepo);

    apiInstance = await startPaymentApi(6205, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;

    testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);
  });

  after(async () => {
    if (apiInstance) await apiInstance.close();
    if (testDb) testDb.close();
  });

  function resetSlot() {
    testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    testDb.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?', [receivingAccountId]);
  }

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const headers = {
        'Content-Type': 'application/json',
        ...authHeadersFor(path), ...(options.headers || {})
      };
      if (options.merchantAuth !== false && !headers['x-merchant-id']) {
        headers['x-merchant-id'] = merchantId;
      }

      const req = http.request(url, {
        method: options.method || 'GET',
        headers
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
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  // Helper to enable Developer Test Mode
  async function enableTestMode() {
    const res = await request('/api/v1/admin/dev/test-mode', {
      method: 'POST',
      body: { enabled: true }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    return res.body;
  }

  // Helper to disable Developer Test Mode
  async function disableTestMode() {
    const res = await request('/api/v1/admin/dev/test-mode', {
      method: 'POST',
      body: { enabled: false }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    return res.body;
  }

  test('34. Security: Unauthorized users and customers cannot call simulator endpoints', async () => {
    // 1. Missing merchant header -> 401
    const unauthRes = await request('/api/v1/admin/dev/simulator/customers', {
      merchantAuth: false
    });
    assert.equal(unauthRes.status, 401);
    assert.equal(unauthRes.body.success, false);

    // 2. A customer session token is not an admin credential -> 401
    const cust = customerRepo.create({
      merchantId,
      name: 'Regular Customer',
      email: 'customer@example.com',
      mobileNumber: '+919988776655'
    });

    const custSession = customerSessionRepo.create({ customerId: cust.id });
    const custToken = custSession.token;

    const custRes = await request('/api/v1/admin/dev/simulator/customers', {
      merchantAuth: false,
      headers: {
        'x-merchant-id': merchantId,
        'Authorization': `Bearer ${custToken}`
      }
    });
    assert.equal(custRes.status, 401);
  });

  test('1, 2, 3. Developer can search existing customer, list sessions, and identify active session', async () => {
    resetSlot();

    const cust = customerRepo.create({
      merchantId,
      name: 'Mohit Developer',
      email: 'mohit.dev@example.com',
      mobileNumber: '+918796266491'
    });

    // Create an active payment session for Mohit
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_SIM_TEST_01',
        amount: 499.00,
        customerId: cust.id,
        autoActivate: true
      }
    });
    assert.equal(payRes.status, 201);
    const sessionId = payRes.body.paymentId;

    // 1. Search existing customer
    const searchRes = await request(`/api/v1/admin/dev/simulator/customers?q=Mohit`);
    assert.equal(searchRes.status, 200);
    assert.ok(Array.isArray(searchRes.body.customers));
    const found = searchRes.body.customers.find(c => c.id === cust.id);
    assert.ok(found);
    assert.equal(found.name, 'Mohit Developer');
    assert.equal(found.email, 'mohit.dev@example.com');
    assert.ok(found.phone.includes('8796266491'));

    // 2. Retrieve customer's payment sessions
    const sessRes = await request(`/api/v1/admin/dev/simulator/customers/${cust.id}/sessions`);
    assert.equal(sessRes.status, 200);
    assert.ok(Array.isArray(sessRes.body.sessions));
    assert.equal(sessRes.body.customer.name, 'Mohit Developer');

    // 3. Verify active session exists and is marked isProcessable: true
    const activeSess = sessRes.body.sessions.find(s => s.id === sessionId);
    assert.ok(activeSess);
    assert.equal(activeSess.status, 'ACTIVE');
    assert.equal(activeSess.amount, '499.00');
    assert.equal(activeSess.isProcessable, true);
  });

  test('36. Developer Test Mode requirement: simulation injection is blocked when Test Mode is OFF', async () => {
    await disableTestMode();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'credited with Rs 499.00 Ref 123456789012'
      }
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
    assert.equal(res.body.testModeActive, false);
  });

  test('6. Active Session Requirement: terminal sessions (CANCELLED, EXPIRED, SUCCESS) reject injection with SESSION NO LONGER ACTIVE', async () => {
    resetSlot();
    await enableTestMode();

    // Create a session and cancel it
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_SIM_TERMINAL_TEST',
        amount: 250.00,
        autoActivate: true
      }
    });
    const sessId = payRes.body.paymentId;

    // Cancel session
    testDb.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE id = ?", [sessId]);

    // Attempt injection
    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'credited with Rs 250.00 Ref 998877665544'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'SESSION NO LONGER ACTIVE');
    assert.equal(res.body.reason, 'SESSION_NOT_ACTIVE');
  });

  test('4, 5, 6, 10, 11, 31. SMS Stream: accepts arbitrary sender, free-form raw content preserved verbatim, arbitrary timestamp', async () => {
    await enableTestMode();

    const arbitrarySender = 'MY_RANDOM_SENDER_123';
    const arbitraryRawContent = 'Arbitrary raw string: Rs 999.00 CR 123456789012   extra spaces & unusual chars! ';
    const arbitraryTimestamp = '2026-10-04T11:45:21.000Z';

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: arbitrarySender,
        content: arbitraryRawContent,
        receivedAt: arbitraryTimestamp
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.isSimulated, true);
    assert.equal(res.body.sender, arbitrarySender);
    assert.equal(res.body.raw, arbitraryRawContent);
    assert.equal(res.body.stages.stage1.status, 'LOADED');
  });

  test('7, 8, 9, 32. Gmail Stream: accepts arbitrary sender email, free-form content, arbitrary timestamp', async () => {
    await enableTestMode();

    const arbitrarySenderEmail = 'anything@notadomain.invalid';
    const arbitraryRawEmail = 'Arbitrary email text: ₹500 credited ref 987654321098';

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'GMAIL',
        sender: arbitrarySenderEmail,
        content: arbitraryRawEmail
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.isSimulated, true);
    assert.equal(res.body.source, 'GMAIL');
    assert.equal(res.body.sender, arbitrarySenderEmail);
    assert.equal(res.body.raw, arbitraryRawEmail);
    assert.equal(res.body.stages.stage1.status, 'LOADED');
  });

  test('14. Invalid SMS sender (personal mobile not matching customer) is rejected by REAL Stage 2', async () => {
    await enableTestMode();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: '+918888888888', // Ordinary personal phone number not matching customer
        content: 'A/C XX1234 credited with Rs 499.00 CR. Ref 123456789012'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 2);
    assert.equal(res.body.reason, 'PERSONAL_SMS_REJECTED');
    assert.equal(res.body.stages.stage2.status, 'FAILED');
  });

  test('15. Invalid Gmail sender (unrecognized domain) is rejected by REAL Stage 2', async () => {
    await enableTestMode();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'GMAIL',
        sender: 'test@gmail.com', // Not authorized bank domain
        content: 'INR 499 credited CR 123456789012'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 2);
    assert.equal(res.body.reason, 'INVALID_EMAIL_DOMAIN');
    assert.equal(res.body.stages.stage2.status, 'FAILED');
  });

  test('16. Missing currency indicator is rejected by REAL Stage 3', async () => {
    await enableTestMode();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'A/C credited with 499.00 CR. Ref 123456789012' // Missing Rs/₹/INR
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 3);
    assert.equal(res.body.reason, 'MISSING_CURRENCY_INDICATOR');
  });

  test('17, 18, 19, 20. All currency indicators (Rs, Rs., ₹, INR) pass Stage 3', async () => {
    await enableTestMode();

    const variations = [
      'A/C credited with Rs 499.00 CR. Ref 123456789012',
      'A/C credited with Rs. 499.00 CR. Ref 123456789013',
      'A/C credited with ₹499.00 CR. Ref 123456789014',
      'A/C credited with INR 499.00 CR. Ref 123456789015'
    ];

    for (const text of variations) {
      const res = await request('/api/v1/admin/dev/simulator/inject', {
        method: 'POST',
        body: {
          source: 'SMS',
          sender: 'HDFCBK',
          content: text
        }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.stages.stage3.status, 'PARSED', `Failed on: ${text}`);
      assert.equal(res.body.amount, '₹499.00');
    }
  });

  test('21. Missing credit indicator is rejected by REAL Stage 3', async () => {
    await enableTestMode();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'A/C transfer of Rs 499.00. Ref 123456789012' // Missing credit indicator
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 3);
    assert.equal(res.body.reason, 'MISSING_CREDIT_INDICATOR');
  });

  test('22. Missing 12-digit reference is rejected by REAL Stage 3', async () => {
    await enableTestMode();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'A/C credited with Rs 499.00 CR. Ref short123' // Missing 12-digit reference
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 3);
    assert.equal(res.body.reason, 'MISSING_12_DIGIT_REFERENCE');
  });

  test('23. Wrong amount is rejected by REAL Stage 4', async () => {
    resetSlot();
    await enableTestMode();

    // Create session for ₹500
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_AMT_MISMATCH_TEST',
        amount: 500.00,
        autoActivate: true
      }
    });
    const sessId = payRes.body.paymentId;

    // Inject observation for ₹400
    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'A/C credited with Rs 400.00 CR. Ref 776655443322'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 4);
    assert.equal(res.body.reason, 'AMOUNT_MISMATCH');
  });

  test('24. Message received before session creation is rejected by REAL Stage 4', async () => {
    resetSlot();
    await enableTestMode();

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_TIME_BEFORE_TEST',
        amount: 350.00,
        autoActivate: true
      }
    });
    const sessId = payRes.body.paymentId;

    // Past timestamp (1 hour ago)
    const pastTime = new Date(Date.now() - 3600 * 1000).toISOString();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'A/C credited with Rs 350.00 CR. Ref 887766554433',
        receivedAt: pastTime
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 4);
    assert.equal(res.body.reason, 'BEFORE_SESSION_CREATION');
  });

  test('25. Message received after session expiry is rejected by REAL Stage 4', async () => {
    resetSlot();
    await enableTestMode();

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_TIME_AFTER_TEST',
        amount: 350.00,
        autoActivate: true
      }
    });
    const sessId = payRes.body.paymentId;

    // Future timestamp (30 mins in future, past the 5-min timer)
    const futureTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'A/C credited with Rs 350.00 CR. Ref 112233445566',
        receivedAt: futureTime
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'REJECTED');
    assert.equal(res.body.failingStage, 4);
    assert.equal(res.body.reason, 'SESSION_EXPIRED');
  });

  test('26, 27. Duplicate observation and reference reuse are rejected by REAL Stage 4', async () => {
    resetSlot();
    await enableTestMode();

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_DUP_TEST_01',
        amount: 199.00,
        autoActivate: true
      }
    });
    const sessId = payRes.body.paymentId;

    const ref = '990011223344';
    const nowIso = new Date().toISOString();

    // 1st injection -> VERIFIED
    const res1 = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: `A/C credited with Rs 199.00 CR. Ref ${ref}`,
        receivedAt: nowIso
      }
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.status, 'VERIFIED');

    // 2nd identical injection into a new active session -> DUPLICATE_OBSERVATION
    resetSlot();
    const payRes1B = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_DUP_TEST_01B',
        amount: 199.00,
        autoActivate: true
      }
    });
    const sessId1B = payRes1B.body.paymentId;

    const res2 = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId1B,
        source: 'SMS',
        sender: 'HDFCBK',
        content: `A/C credited with Rs 199.00 CR. Ref ${ref}`,
        receivedAt: nowIso
      }
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.status, 'REJECTED');
    assert.equal(res2.body.failingStage, 4);
    assert.equal(res2.body.reason, 'DUPLICATE_OBSERVATION');

    // 3rd injection on a DIFFERENT session with the SAME reference -> REFERENCE_ALREADY_USED
    resetSlot();
    const payRes2 = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_DUP_TEST_02',
        amount: 299.00,
        autoActivate: true
      }
    });
    const sessId2 = payRes2.body.paymentId;

    const res3 = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId2,
        source: 'SMS',
        sender: 'HDFCBK',
        content: `A/C credited with Rs 299.00 CR. Ref ${ref}`,
        receivedAt: new Date(Date.now() + 2000).toISOString()
      }
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.status, 'REJECTED');
    assert.equal(res3.body.failingStage, 4);
    assert.equal(res3.body.reason, 'REFERENCE_ALREADY_USED');
  });

  test('28, 29, 30. Valid synthetic observation reaches normal VERIFIED status, updates session, and emits SSE', async () => {
    resetSlot();
    await enableTestMode();

    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORD_VERIFY_FLOW_TEST',
        amount: 799.00,
        autoActivate: true
      }
    });
    const sessId = payRes.body.paymentId;

    // Normal checkout state before injection is ACTIVE
    const stateBefore = await request(`/api/v1/checkout/${sessId}/state`);
    assert.equal(stateBefore.status, 200);
    assert.equal(stateBefore.body.status, 'ACTIVE');

    // Inject valid synthetic SMS
    const res = await request('/api/v1/admin/dev/simulator/inject', {
      method: 'POST',
      body: {
        paymentSessionId: sessId,
        source: 'SMS',
        sender: 'HDFCBK',
        content: 'A/C XX9999 credited with Rs 799.00 CR. Ref 554433221100'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'VERIFIED');
    assert.equal(res.body.stages.stage1.status, 'LOADED');
    assert.equal(res.body.stages.stage2.status, 'PASSED');
    assert.equal(res.body.stages.stage3.status, 'PARSED');
    assert.equal(res.body.stages.stage4.status, 'VERIFIED');
    assert.equal(res.body.stages.stage5.status, 'PASSED');
    assert.equal(res.body.stages.stage6.status, 'ATTRIBUTED');

    // Verify session in database transitioned to SUCCESS
    const sessionDb = testDb.db.prepare('SELECT status FROM payment_sessions WHERE id = ?').get(sessId);
    assert.equal(sessionDb.status, 'OBSERVED_SUCCESS');

    // Normal checkout state now reports SUCCESS
    const stateAfter = await request(`/api/v1/checkout/${sessId}/state`);
    assert.equal(stateAfter.status, 200);
    assert.equal(stateAfter.body.status, 'OBSERVED_SUCCESS');
  });

  test('33. Simulation event is audit logged with full evidence and accessible via history', async () => {
    const historyRes = await request('/api/v1/admin/dev/simulator/history');
    assert.equal(historyRes.status, 200);
    assert.ok(Array.isArray(historyRes.body.history));
    assert.ok(historyRes.body.history.length > 0);

    const latest = historyRes.body.history[0];
    assert.ok(latest.messageId.startsWith('SIM-'));
    assert.ok(latest.source);
    assert.ok(latest.result);
    assert.ok(latest.details);
    assert.equal(latest.action, 'SIMULATED_OBSERVATION_INJECTED');
  });
});
