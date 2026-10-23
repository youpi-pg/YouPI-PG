import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

describe('Merchant Management & Multi-Tenant Onboarding Test Suite', () => {
  let apiInstance;
  let testDb;
  let baseUrl;
  const port = 6219;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(port, testDb);
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    if (apiInstance) {
      await apiInstance.close();
    }
    if (testDb) {
      testDb.close();
    }
  });

  it('1. GET /api/v1/admin/merchants returns default seeded merchant', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.merchants), 'merchants array must be present');
    assert.ok(body.merchants.length >= 1, 'At least 1 default merchant must exist');
    const defaultM = body.merchants.find(m => m.id === '00000000-0000-0000-0000-000000000001');
    assert.ok(defaultM, 'Default merchant 00000000-0000-0000-0000-000000000001 must exist');
  });

  it('2. POST /api/v1/admin/merchants rejects request with missing businessName', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'test-store' })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /businessName is required/);
  });

  let createdMerchant;
  it('3. POST /api/v1/admin/merchants creates new merchant with auto-generated API key & secret', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Nova Supermart',
        slug: 'nova-supermart',
        contactEmail: 'contact@nova.example',
        contactPhone: '9876543210',
        vpa: 'novastore@okhdfcbank'
      })
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(body.merchant, 'merchant object must be returned');
    assert.ok(body.merchant.id, 'merchant ID must be generated');
    assert.strictEqual(body.merchant.businessName, 'Nova Supermart');
    assert.strictEqual(body.merchant.slug, 'nova-supermart');
    assert.ok(body.merchant.apiKey.startsWith('yp_live_'), 'API key must have yp_live_ prefix');
    assert.ok(body.merchant.webhookSecret, 'webhookSecret must be generated');
    createdMerchant = body.merchant;
  });

  it('4. POST /api/v1/admin/merchants rejects duplicate slug', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Nova Another Store',
        slug: 'nova-supermart'
      })
    });
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /already exists/);
  });

  it('5. POST /api/v1/admin/merchants/:id/rotate-key rotates merchant API key', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants/${createdMerchant.id}/rotate-key`, {
      method: 'POST'
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.apiKey.startsWith('yp_live_'));
    assert.notStrictEqual(body.apiKey, createdMerchant.apiKey, 'New API key must differ from old key');
    createdMerchant.apiKey = body.apiKey;
  });

  it('6. POST /api/v1/payments verifies authentication with the new merchant ID and rotated API key', async () => {
    // Attempt with invalid key -> 401
    const failRes = await fetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': createdMerchant.id,
        'X-Merchant-Key': 'invalid_secret_key'
      },
      body: JSON.stringify({
        orderId: 'ORDER-NOVA-101',
        amount: '299.00',
        currency: 'INR'
      })
    });
    assert.strictEqual(failRes.status, 401);

    // Attempt with valid rotated key -> 201 Created
    const successRes = await fetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': createdMerchant.id,
        'X-Merchant-Key': createdMerchant.apiKey
      },
      body: JSON.stringify({
        orderId: 'ORDER-NOVA-101',
        amount: '299.00',
        currency: 'INR'
      })
    });
    assert.strictEqual(successRes.status, 201);
    const successBody = await successRes.json();
    assert.ok(successBody.paymentId);
    assert.strictEqual(successBody.orderId, 'ORDER-NOVA-101');
  });
});
