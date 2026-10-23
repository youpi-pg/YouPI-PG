import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Database } from '@youpi/db';
import { PaymentStatus, PaymentMethod } from '@youpi/common';
import { startServer } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

describe('2-Level Verification (SMS Gateway + Gmail) & Queue Management Tests', () => {
  let apiInstance;
  let testDb;
  let baseUrl;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startServer(6208, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
  });

  test('POST /api/v1/admin/queue/clear expires all waiting UPI queue sessions', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    // Create 1 active and 3 queued sessions
    const sActive = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'ORD-ACTIVE-1',
      amountPaise: 10000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sActive.id, receivingAccountId);

    const sQ1 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'ORD-Q-1',
      amountPaise: 20000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sQ1.id, receivingAccountId);

    const sQ2 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      orderId: 'ORD-Q-2',
      amountPaise: 30000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(sQ2.id, receivingAccountId);

    const clearRes = await authFetch(`${baseUrl}/api/v1/admin/queue/clear`, {
      method: 'POST'
    });
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.success, true);
    assert.ok(clearData.clearedCount >= 2);

    // Verify queue sessions are now EXPIRED
    const q1Updated = sessionRepo.findById(sQ1.id);
    const q2Updated = sessionRepo.findById(sQ2.id);
    assert.equal(q1Updated.status, PaymentStatus.EXPIRED);
    assert.equal(q2Updated.status, PaymentStatus.EXPIRED);

    // Clean up sActive so receiving account slot is released
    sessionRepo.transitionToTerminal(sActive.id, PaymentStatus.SUCCESS);
  });

  test('Detects active session conflict when customer already has an active session', async () => {
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const customerRepo = apiInstance.app.context.customerRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const merchantId = '00000000-0000-0000-0000-000000000001';

    // Create a customer
    const customer = customerRepo.create({
      phoneNumber: '9876543210',
      fullName: 'Conflict Test User'
    });

    // Session 1: bound to customer and ACTIVE
    const session1 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      customerId: customer.id,
      orderId: 'ORD-FIRST-ACTIVE',
      amountPaise: 50000n
    });
    apiInstance.app.context.queueEngine.enqueueOrActivate(session1.id, receivingAccountId);

    // Session 2: new session created for the same customer
    const session2 = sessionRepo.create({
      merchantId,
      receivingAccountId,
      customerId: customer.id,
      orderId: 'ORD-SECOND-ATTEMPT',
      amountPaise: 75000n
    });

    // Check state of session 2 via API
    const res = await authFetch(`${baseUrl}/api/v1/checkout/${session2.id}/state`);
    assert.equal(res.status, 200);
    const state = await res.json();

    assert.equal(state.hasActiveSessionConflict, true);
    assert.ok(state.conflictingSession);
    assert.equal(state.conflictingSession.id, session1.id);

    // Retrying new payment clears old conflict
    const retryRes = await authFetch(`${baseUrl}/api/v1/checkout/${session2.id}/retry-new-payment`, {
      method: 'POST'
    });
    assert.equal(retryRes.status, 200);

    const oldSession = sessionRepo.findById(session1.id);
    assert.equal(oldSession.status, PaymentStatus.CANCELLED);

    // Clean up session2 so slot is released
    sessionRepo.transitionToTerminal(session2.id, PaymentStatus.CANCELLED);
  });

  test('Android SMS Gateway pairs via QR, sends HMAC-signed bank SMS and completes payment', async () => {
    // 1. Get pairing QR from admin
    const qrRes = await authFetch(`${baseUrl}/api/v1/admin/sms-gateway/pair-qr`);
    assert.equal(qrRes.status, 200);
    const qrData = await qrRes.json();
    assert.ok(qrData.enrollmentToken);

    // 2. Mobile app pairs
    const pairRes = await authFetch(`${baseUrl}/api/v1/observers/sms/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentToken: qrData.enrollmentToken,
        deviceName: 'Samsung Galaxy S24 Bank Gateway'
      })
    });
    assert.equal(pairRes.status, 200);
    const pairData = await pairRes.json();
    assert.ok(pairData.paired);
    assert.ok(pairData.deviceId);
    assert.ok(pairData.signingKey);

    // 3. Create active payment session for ₹450
    const sessionRepo = apiInstance.app.context.sessionRepo;
    const receivingAccountId = '00000000-0000-0000-0000-000000000002';
    const s450 = sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId,
      orderId: 'ORD-SMS-450',
      amountPaise: 45000n
    });
    testDb.execute("UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL WHERE id = ?", [receivingAccountId]);
    apiInstance.app.context.queueEngine.enqueueOrActivate(s450.id, receivingAccountId);

    // 4. Mobile app captures bank SMS and dispatches to /api/v1/observers/sms
    const timestamp = Date.now();
    const smsPayload = {
      deviceId: pairData.deviceId,
      sender: 'HDFCBK',
      body: 'Dear Customer, A/C *4321 credited by Rs 450.00 on 30-Sep-26 by UPI/9876543210/REF99887766 - HDFC Bank',
      timestamp
    };
    const bodyStr = JSON.stringify(smsPayload);
    const sigPayload = `${bodyStr}:${timestamp}`;
    const signature = crypto.createHmac('sha256', pairData.signingKey).update(sigPayload).digest('hex');

    const smsRes = await authFetch(`${baseUrl}/api/v1/observers/sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': pairData.deviceId,
        'X-Timestamp': timestamp.toString(),
        'X-Signature': signature
      },
      body: bodyStr
    });

    assert.equal(smsRes.status, 200);
    const smsResult = await smsRes.json();
    assert.equal(smsResult.accepted, true);
    assert.equal(smsResult.attribution.attributed, true);
    assert.equal(smsResult.attribution.paymentSessionId, s450.id);

    // 1st hit (SMS Gateway) -> Level 1 verification recorded
    assert.equal(smsResult.attribution.verificationLevel, 1);

    // 2nd hit arrives from Gmail poller within 5s grace window -> upgrades to Level 2 Dual Verification
    const gmailRes = await authFetch(`${baseUrl}/api/v1/pollers/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'GMAIL',
        receivingAccountId,
        amountPaise: '45000',
        amount: '450.00',
        rawText: 'Dear Customer, INR 450.00 credited to A/C *4321. Ref: REF99887766 - HDFC Bank',
        observedAt: new Date().toISOString()
      })
    });
    assert.equal(gmailRes.status, 200);
    const gmailResult = await gmailRes.json();
    assert.equal(gmailResult.accepted, true);
    assert.equal(gmailResult.attribution.attributed, true);
    assert.equal(gmailResult.attribution.verificationLevel, 2);
    assert.ok(gmailResult.attribution.verificationTag.includes('Dual Verification'));

    // Verify session in DB is now SUCCESS and Level 2
    const sUpdated = sessionRepo.findById(s450.id);
    assert.equal(sUpdated.status, PaymentStatus.OBSERVED_SUCCESS);
    assert.equal(sUpdated.verificationLevel, 2);
  });

  test('Gmail credentials can be saved and connection tested via Admin API', async () => {
    const saveRes = await authFetch(`${baseUrl}/api/v1/admin/gmail/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'test-secret',
        refreshToken: 'mock_test_refresh_token_string_98765'
      })
    });
    assert.equal(saveRes.status, 200);
    const saveData = await saveRes.json();
    assert.equal(saveData.success, true);
    assert.equal(saveData.status, 'CONFIGURED');

    const getRes = await authFetch(`${baseUrl}/api/v1/admin/gmail/credentials`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.gmailConfig.clientId, 'test-client-id.apps.googleusercontent.com');

    // Test connection endpoint
    const testRes = await authFetch(`${baseUrl}/api/v1/admin/gmail/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: 'mock_token'
      })
    });
    assert.equal(testRes.status, 200);
  });

  test('Downloads standalone Android APK binary from Payment API', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/sms-gateway/download-apk`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0);
  });
});
