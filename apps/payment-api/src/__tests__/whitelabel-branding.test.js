import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

describe('White-Label Branding & Visual Gateway Customizer Test Suite', () => {
  let apiInstance;
  let testDb;
  let baseUrl;
  let merchantId = '00000000-0000-0000-0000-000000000001';

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6209, testDb);
    baseUrl = 'http://localhost:6209';
  });

  after(async () => {
    if (apiInstance) {
      await apiInstance.close();
    }
    if (testDb) {
      testDb.close();
    }
  });

  it('1. GET /api/v1/admin/merchant-settings returns baseline white-label branding', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings?merchantId=${merchantId}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.branding, 'Branding object must be present');
    assert.strictEqual(typeof body.branding.appName, 'string');
    assert.strictEqual(typeof body.branding.primaryColor, 'string');
  });

  it('2. POST /api/v1/admin/merchant-settings updates and persists extended white-label settings', async () => {
    const customBranding = {
      appName: 'AuraPay Gateway',
      primaryColor: '#8b5cf6',
      headerTheme: 'dark',
      logoUrl: 'https://aurapay.io/logo.svg',
      trustBadgeText: 'AuraPay Certified Merchant',
      hideTrustBadge: false,
      subbannerText: '⚡ 100% Instant Bank Verification',
      hideSubbanner: false,
      hidePoweredBy: true,
      hideTimeSavingBanner: true,
      sidebarNotice: 'Ultra Fast 256-Bit SSL Payments',
      footerGuarantee: '100% Buyer Shield Guarantee',
      counterInstructions: 'Proceed to Till #4 for Cash payment.',
      cardCounterInstructions: 'Swipe on AuraPay POS Terminal.',
      termsUrl: 'https://aurapay.io/terms',
      privacyPolicyUrl: 'https://aurapay.io/privacy'
    };

    const updateRes = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId,
        businessName: 'Aura Corp Global',
        branding: customBranding
      })
    });
    assert.strictEqual(updateRes.status, 200);
    const updateBody = await updateRes.json();
    assert.strictEqual(updateBody.success, true);

    // Read back and assert all fields
    const getRes = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings?merchantId=${merchantId}`);
    const getData = await getRes.json();
    const b = getData.branding;

    assert.strictEqual(b.appName, 'AuraPay Gateway');
    assert.strictEqual(b.primaryColor, '#8b5cf6');
    assert.strictEqual(b.headerTheme, 'dark');
    assert.strictEqual(b.logoUrl, 'https://aurapay.io/logo.svg');
    assert.strictEqual(b.trustBadgeText, 'AuraPay Certified Merchant');
    assert.strictEqual(b.hideTrustBadge, false);
    assert.strictEqual(b.subbannerText, '⚡ 100% Instant Bank Verification');
    assert.strictEqual(b.hideSubbanner, false);
    assert.strictEqual(b.hidePoweredBy, true);
    assert.strictEqual(b.hideTimeSavingBanner, true);
    assert.strictEqual(b.footerGuarantee, '100% Buyer Shield Guarantee');
    assert.strictEqual(b.counterInstructions, 'Proceed to Till #4 for Cash payment.');
    assert.strictEqual(b.cardCounterInstructions, 'Swipe on AuraPay POS Terminal.');
    assert.strictEqual(b.termsUrl, 'https://aurapay.io/terms');
    assert.strictEqual(b.privacyPolicyUrl, 'https://aurapay.io/privacy');
  });

  it('3. Checkout state endpoint propagates updated branding to customer checkout', async () => {
    // Initiate payment session
    const initRes = await authFetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': merchantId
      },
      body: JSON.stringify({
        orderId: 'ORD-WL-CHECK-99',
        amount: '499.00',
        currency: 'INR'
      })
    });
    assert.strictEqual(initRes.status, 201);
    const initData = await initRes.json();
    assert.ok(initData.paymentId);

    // Fetch checkout state
    const stateRes = await authFetch(`${baseUrl}/api/v1/checkout/${initData.paymentId}/state`);
    assert.strictEqual(stateRes.status, 200);
    const state = await stateRes.json();

    assert.strictEqual(state.merchantName, 'Aura Corp Global');
    assert.strictEqual(state.branding.appName, 'AuraPay Gateway');
    assert.strictEqual(state.branding.primaryColor, '#8b5cf6');
    assert.strictEqual(state.branding.headerTheme, 'dark');
    assert.strictEqual(state.branding.trustBadgeText, 'AuraPay Certified Merchant');
    assert.strictEqual(state.branding.hidePoweredBy, true);
    assert.strictEqual(state.branding.termsUrl, 'https://aurapay.io/terms');
  });

  it('4. sanitizePublicBranding falls back to environment variables when merchant branding is unset', async () => {
    const origEnv = { ...process.env };
    process.env.DEFAULT_APP_NAME = 'EnvCustomGateway';
    process.env.DEFAULT_PRIMARY_COLOR = '#059669';

    // Clear merchant branding directly in DB
    testDb.run("UPDATE merchants SET branding = '{}' WHERE id = ?", [merchantId]);

    // Create session without merchant branding override
    const initRes = await authFetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': merchantId },
      body: JSON.stringify({
        orderId: 'ORD-ENV-TEST-01',
        amount: '150.00',
        currency: 'INR'
      })
    });
    assert.strictEqual(initRes.status, 201);
    const initData = await initRes.json();

    const stateRes = await authFetch(`${baseUrl}/api/v1/checkout/${initData.paymentId}/state`);
    assert.strictEqual(stateRes.status, 200);
    const state = await stateRes.json();

    assert.strictEqual(state.branding.appName, 'EnvCustomGateway');
    assert.strictEqual(state.branding.primaryColor, '#059669');

    // Restore env
    process.env = { ...origEnv };
  });
});
