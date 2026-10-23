import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, MerchantRepository } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod, SellingMode } from '@youpi/common';
import { authHeaders, authHeadersFor } from '../../../../scripts/test-support.js';

describe('Architectural Update: Selling Modes (Online vs Offline), COD Flow, & Clean VPA Config', () => {
  let apiInstance;
  let baseUrl;
  let testDb;
  let merchantSecret;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6195, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
    merchantSecret = new MerchantRepository(testDb).findAll()[0].webhookSecret;
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

  test('1. Admin VPA Configuration: Clean VPA + Payee Name without merchant/personal distinction', async () => {
    const res = await request('/api/v1/admin/upi-accounts', {
      method: 'POST',
      body: {
        upiId: 'superstore@okhdfcbank',
        payeeName: 'SuperStore Retail',
        isActive: true
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.account.upiId, 'superstore@okhdfcbank');
    assert.equal(res.body.account.payeeName, 'SuperStore Retail');
    assert.equal(res.body.account.isActive, true);

    // Verify in upi-settings endpoint
    const getRes = await request('/api/v1/admin/upi-settings');
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.upiId, 'superstore@okhdfcbank');
    assert.equal(getRes.body.payeeName, 'SuperStore Retail');
  });

  test('2. Online Selling Mode Configuration & Method Invariants', async () => {
    // Merchant configures Online Selling Mode with Cash on Delivery enabled
    const saveRes = await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      body: {
        sellingMode: 'ONLINE',
        codEnabled: true,
        branding: {
          appName: 'YouPI Online Store',
          sellingMode: 'ONLINE'
        }
      }
    });

    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.body.sellingMode, 'ONLINE');
    assert.deepEqual(saveRes.body.enabledPaymentMethods, ['UPI', 'COD']);
    assert.equal(saveRes.body.codEnabled, true);

    // Create a payment session
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-ONLINE-101',
        amount: '499.00',
        method: PaymentMethod.UPI,
        autoActivate: true
      }
    });
    assert.equal(payRes.status, 201);
    const paymentId = payRes.body.paymentId;

    // Checkout state must return ONLINE mode and enabledMethods: ['UPI', 'COD']
    const stateRes = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.sellingMode, 'ONLINE');
    assert.deepEqual(stateRes.body.enabledMethods, ['UPI', 'COD']);

    // Attempting to select CASH_COUNTER or CARD_COUNTER in ONLINE mode must be rejected
    const invalidSwitchRes = await request(`/api/v1/checkout/${paymentId}/select-method`, {
      method: 'POST',
      body: { method: 'CASH_COUNTER' }
    });
    assert.equal(invalidSwitchRes.status, 400);

    // Turning off COD in ONLINE mode leaves only UPI
    const codOffRes = await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      body: {
        sellingMode: 'ONLINE',
        codEnabled: false
      }
    });
    assert.equal(codOffRes.status, 200);
    assert.deepEqual(codOffRes.body.enabledPaymentMethods, ['UPI']);

    const stateCodOff = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.deepEqual(stateCodOff.body.enabledMethods, ['UPI']);
  });

  test('3. COD Pre-Purchase Confirmation, Slot Release, & Developer API Endpoints', async () => {
    // Ensure slot is free
    testDb.execute(`UPDATE payment_sessions SET status = 'CANCELLED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')`);
    testDb.execute(`UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL`);

    // Re-enable COD in Online mode
    await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      body: {
        sellingMode: 'ONLINE',
        codEnabled: true
      }
    });

    // Create customer to attach to checkout
    testDb.execute(
      `INSERT INTO customers (id, name, mobile_number, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ['00000000-0000-0000-0000-000000000099', 'Rahul Sharma', '9876543210', 'rahul@example.com']
    );

    // Session A is created and holds the active UPI slot
    const payARes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-COD-A',
        amount: '899.00',
        method: PaymentMethod.UPI,
        customerId: '00000000-0000-0000-0000-000000000099',
        autoActivate: true
      }
    });
    const paymentIdA = payARes.body.paymentId;
    assert.equal(payARes.body.status, PaymentStatus.ACTIVE);

    // Session B is created and enters the waiting queue behind Session A
    const payBRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-UPI-B',
        amount: '1200.00',
        method: PaymentMethod.UPI,
        autoActivate: true
      }
    });
    const paymentIdB = payBRes.body.paymentId;
    assert.equal(payBRes.body.status, PaymentStatus.QUEUED);
    assert.equal(payBRes.body.queuePosition, 1);

    // Customer A switches to COD and confirms Cash on Delivery order
    const confirmCodRes = await request(`/api/v1/checkout/${paymentIdA}/confirm-cod`, {
      method: 'POST'
    });

    assert.equal(confirmCodRes.status, 200);
    assert.equal(confirmCodRes.body.success, true);
    assert.equal(confirmCodRes.body.method, 'COD');
    assert.equal(confirmCodRes.body.status, PaymentStatus.SUCCESS);
    assert.equal(confirmCodRes.body.verificationTag, 'COD_ORDER_PLACED');

    // INVARIANT: When Customer A confirmed COD, Session B must immediately be promoted to ACTIVE!
    const checkBRes = await request(`/api/v1/checkout/${paymentIdB}/state`);
    assert.equal(checkBRes.body.status, PaymentStatus.ACTIVE);
    assert.equal(checkBRes.body.queuePosition, 0);

    // Order ids are guessable, so an anonymous caller must not get the delivery contact or metadata.
    for (const path of ['/api/v1/orders/ORDER-COD-A/cod', `/api/v1/payments/${paymentIdA}/cod`, `/api/v1/checkout/${paymentIdA}/cod`]) {
      const anonRes = await request(path);
      assert.equal(anonRes.status, 200);
      assert.equal(anonRes.body.method, 'COD');
      assert.equal(anonRes.body.customer, null, `${path} leaked the customer`);
      assert.equal(anonRes.body.metadata, undefined, `${path} leaked metadata`);
    }

    // Developer API endpoint: GET /api/v1/orders/:orderId/cod (owner credential required for the customer)
    const devOrderRes = await request('/api/v1/orders/ORDER-COD-A/cod', { headers: authHeaders() });
    assert.equal(devOrderRes.status, 200);
    assert.equal(devOrderRes.body.orderId, 'ORDER-COD-A');
    assert.equal(devOrderRes.body.paymentId, paymentIdA);
    assert.equal(devOrderRes.body.method, 'COD');
    assert.equal(devOrderRes.body.status, 'SUCCESS');
    assert.equal(devOrderRes.body.isCod, true);
    assert.equal(devOrderRes.body.amount, '899.00');
    assert.equal(devOrderRes.body.customer.name, 'Rahul Sharma');
    assert.equal(devOrderRes.body.customer.mobileNumber, '9876543210');

    // Developer API endpoint: GET /api/v1/payments/:id/cod
    const devPayRes = await request(`/api/v1/payments/${paymentIdA}/cod`, { headers: authHeaders() });
    assert.equal(devPayRes.body.customer.name, 'Rahul Sharma');
    assert.equal(devPayRes.status, 200);
    assert.equal(devPayRes.body.paymentId, paymentIdA);
    assert.equal(devPayRes.body.orderId, 'ORDER-COD-A');
    assert.equal(devPayRes.body.method, 'COD');

    // Merchant Admin COD Orders listing: GET /api/v1/admin/cod-orders
    const adminCodListRes = await request('/api/v1/admin/cod-orders');
    assert.equal(adminCodListRes.status, 200);
    assert.ok(Array.isArray(adminCodListRes.body.codOrders));
    const foundOrder = adminCodListRes.body.codOrders.find(o => o.orderId === 'ORDER-COD-A');
    assert.ok(foundOrder);
    assert.equal(foundOrder.paymentId, paymentIdA);
    assert.equal(foundOrder.customerName, 'Rahul Sharma');
  });

  test('4. Offline Selling Mode: Cash and Card (renamed), COD completely removed', async () => {
    // Switch to OFFLINE mode with Cash & Card enabled
    const offlineSaveRes = await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      body: {
        sellingMode: 'OFFLINE',
        cashEnabled: true,
        cardEnabled: true
      }
    });

    assert.equal(offlineSaveRes.status, 200);
    assert.equal(offlineSaveRes.body.sellingMode, 'OFFLINE');
    assert.deepEqual(offlineSaveRes.body.enabledPaymentMethods, ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    assert.equal(offlineSaveRes.body.cashEnabled, true);
    assert.equal(offlineSaveRes.body.cardEnabled, true);

    // Create session in OFFLINE mode
    const payRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-OFFLINE-201',
        amount: '150.00',
        method: PaymentMethod.UPI,
        autoActivate: true
      }
    });
    const paymentId = payRes.body.paymentId;

    const stateRes = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.sellingMode, 'OFFLINE');
    assert.deepEqual(stateRes.body.enabledMethods, ['UPI', 'CASH_COUNTER', 'CARD_COUNTER']);
    assert.equal(stateRes.body.enabledMethods.includes('COD'), false);

    // Attempting to confirm COD in OFFLINE mode must be rejected
    const invalidCodRes = await request(`/api/v1/checkout/${paymentId}/confirm-cod`, {
      method: 'POST'
    });
    assert.equal(invalidCodRes.status, 400);

    // Disable Card: only Cash + UPI remain
    const cardOffRes = await request('/api/v1/admin/merchant-settings', {
      method: 'POST',
      body: {
        sellingMode: 'OFFLINE',
        cashEnabled: true,
        cardEnabled: false
      }
    });
    assert.equal(cardOffRes.status, 200);
    assert.deepEqual(cardOffRes.body.enabledPaymentMethods, ['UPI', 'CASH_COUNTER']);

    const stateCardOff = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.deepEqual(stateCardOff.body.enabledMethods, ['UPI', 'CASH_COUNTER']);
  });

  test('a settled order cannot be restarted (409, not a 500 from the unique index)', async () => {
    // Earlier cases in this file switch the merchant's active VPA and leave sessions on it,
    // so resolve the currently active account and release its slot before this case.
    const activeAccount = testDb.queryOne(
      `SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1`,
      ['00000000-0000-0000-0000-000000000001']
    );
    const accountId = activeAccount?.id || '00000000-0000-0000-0000-000000000002';
    testDb.execute(
      `UPDATE payment_sessions SET status = 'CANCELLED', updated_at = ?
       WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING', 'QUEUED')`,
      [new Date().toISOString(), accountId]
    );
    testDb.execute(
      `UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL
       WHERE id = ?`,
      [accountId]
    );

    const pay = await request('/api/v1/payments', {
      method: 'POST',
      body: { orderId: 'PAID-ORD-RESTART', amount: '42.00', autoActivate: true }
    });
    assert.equal(pay.status, 201);
    const paymentId = pay.body.paymentId;

    // Drive the session to a terminal SUCCESS through the normal verification path.
    await request(`/api/v1/checkout/${paymentId}/payment-done`, { method: 'POST' });
    await request('/api/v1/pollers/events', {
      method: 'POST',
      body: {
        source: 'GOOGLE_MESSAGES',
        receivingAccountId: accountId,
        amount: '42.00',
        utr: 'UTR-PAID-ORD-RESTART',
        rawText: 'A/C 1234 credited by Rs 42.00 via UPI/UTR-PAID-ORD-RESTART'
      }
    });
    await new Promise(r => setTimeout(r, 6500));

    const state = await request(`/api/v1/payments/${paymentId}`, { headers: { 'X-Merchant-Key': merchantSecret } });
    assert.equal(state.body.status, 'OBSERVED_SUCCESS');

    // Restarting a paid order must fail cleanly. It reuses the merchant's order reference,
    // and the unique (merchant_id, order_id) index would otherwise reject the duplicate row
    // and surface as HTTP 500.
    const restart = await request(`/api/v1/checkout/${paymentId}/end-and-restart-payment`, {
      method: 'POST',
      headers: { 'x-device-id': 'device-restart-b' },
      body: {}
    });
    assert.equal(restart.status, 409);
    assert.equal(restart.body.error, 'ORDER_ALREADY_PAID');
  });

  test('SECURITY: customer contact is not disclosed to anonymous callers of the COD routes', async () => {
    const reg = await request('/api/v1/customer/register', {
      method: 'POST',
      body: { phoneNumber: '9111000099', fullName: 'COD PII Subject', email: 'codpii@example.com', password: 'Password123!' }
    });
    assert.equal(reg.status, 201);
    const customerToken = reg.body.token;

    const pay = await request('/api/v1/payments', {
      method: 'POST',
      body: { orderId: 'COD-PII-ORDER-1', amount: '55.00' }
    });
    const paymentId = pay.body.paymentId;

    await request(`/api/v1/checkout/${paymentId}/bind-customer`, {
      method: 'POST',
      body: { customerId: reg.body.customerId, token: customerToken }
    });

    // 1. Anonymous callers learn nothing about the customer.
    for (const path of [
      `/api/v1/payments/${paymentId}/cod`,
      `/api/v1/orders/COD-PII-ORDER-1/cod`,
      `/api/v1/checkout/${paymentId}/cod`
    ]) {
      const res = await request(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.body.customer, null, `${path} leaked customer`);
      assert.equal(res.body.metadata, undefined, `${path} leaked metadata`);
    }

    // 2. The checkout state endpoint must not expose the customer to an anonymous holder
    //    of the payment id either.
    const anonState = await request(`/api/v1/checkout/${paymentId}/state`);
    assert.equal(anonState.status, 200);
    assert.equal(anonState.body.customer, null, 'checkout state leaked customer');
    assert.deepEqual(anonState.body.metadata, {}, 'checkout state leaked metadata');

    // 3. The owning merchant does get the full view.
    const ownerRes = await request(`/api/v1/payments/${paymentId}/cod`, {
      headers: { 'X-Merchant-Key': merchantSecret }
    });
    assert.equal(ownerRes.status, 200);
    assert.equal(ownerRes.body.customer.mobileNumber, '9111000099');

    // 4. The customer themselves see their own profile.
    const selfRes = await request(`/api/v1/checkout/${paymentId}/state`, {
      headers: { 'x-customer-token': customerToken }
    });
    assert.equal(selfRes.status, 200);
    assert.equal(selfRes.body.customer.mobileNumber, '9111000099');

    // 5. A wrong merchant key is rejected like an anonymous caller.
    const wrongKey = await request(`/api/v1/payments/${paymentId}/cod`, {
      headers: { 'X-Merchant-Key': 'not-the-merchant-secret' }
    });
    assert.equal(wrongKey.status, 200);
    assert.equal(wrongKey.body.customer, null);
  });
});
