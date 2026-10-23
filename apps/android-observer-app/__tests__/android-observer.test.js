import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../driver.js';
import { PaymentStatus, resolveSecret } from '@youpi/common';

describe('Android Payment Observer Integration Tests', () => {
  let apiInstance;
  let driver;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6217, testDb);
    driver = new AndroidObserverDriver({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      deviceName: 'Pixel 8 Pro Tester',
      deviceModel: 'Pixel 8 Pro'
    });
  });

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
  });

  test('rejects pairing with invalid enrollment token', async () => {
    await assert.rejects(
      () => driver.pair('invalid_token_123'),
      /Device pairing failed/
    );
  });

  test('successfully pairs Android device with valid enrollment token', async () => {
    const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
    const pairResult = await driver.pair(enrollmentSecret);

    assert.ok(pairResult.paired);
    assert.ok(pairResult.deviceId);
    assert.ok(pairResult.signingKey);

    assert.equal(driver.deviceId, pairResult.deviceId);
    assert.equal(driver.signingKey, pairResult.signingKey);
  });

  test('sends heartbeat acknowledging liveness', async () => {
    const hbResult = await driver.sendHeartbeat();
    assert.equal(hbResult.status, 'HEARTBEAT_ACK');
    assert.ok(hbResult.timestamp);
  });

  test('rejects observation with expired/drifted timestamp (Replay Protection)', async () => {
    // Timestamp 2 minutes in the past (> 60s drift)
    const oldTimestamp = Date.now() - 120000;
    const res = await driver.submitObservation({
      amount: '200.00',
      timestampOverride: oldTimestamp
    });

    assert.equal(res.status, 401);
    assert.ok(res.body.error.includes('validity window'));
  });

  test('submits valid HMAC-signed observation and confirms payment in Payment API', async () => {
    // 1. Create and activate a payment session for ₹350
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'ANDR-ORD-350',
      amountPaise: 35000n
    });

    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    // 2. Android observer submits observation for ₹350
    const res = await driver.submitObservation({
      amount: '350.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-ANDR-9876',
      senderVpa: 'customer@paytm',
      notificationText: 'Payment of ₹350 received from customer@paytm on PhonePe'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.paymentSessionId, session.id);
    assert.equal(res.body.attribution.outcomeStatus, PaymentStatus.OBSERVED_SUCCESS);

    // 3. Verify session in DB updated to SUCCESS
    const updated = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(updated.status, PaymentStatus.OBSERVED_SUCCESS);
  });

  test('Issue #61: rejects notification observation when rawNotification has missing or empty package', async () => {
    const resWithoutPkg = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-MISSING-PKG',
      notificationText: 'Payment of ₹100 received from user@bank on UPI',
      package: ''
    });

    assert.equal(resWithoutPkg.status, 400);
    assert.match(resWithoutPkg.body.error, /must specify a valid package name/);
  });

  test('Issue #61: rejects notification observation from untrusted/unallowed package name', async () => {
    const resUntrusted = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-UNTRUSTED-PKG',
      notificationText: 'Payment of ₹100 received from fake@bank on FakeApp',
      package: 'com.attacker.fake.banking'
    });

    assert.equal(resUntrusted.status, 400);
    assert.match(resUntrusted.body.error, /Untrusted Android notification package/);
  });
});
