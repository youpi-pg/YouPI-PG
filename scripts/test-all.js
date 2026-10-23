import { spawnSync } from 'node:child_process';

const testFiles = [
  'packages/common/src/__tests__/common.test.js',
  'packages/db/src/__tests__/customer-reset.test.js',
  'packages/db/src/__tests__/auth-matrix.test.js',
  'packages/db/src/__tests__/db.test.js',
  'packages/db/src/__tests__/schema-parity.test.js',
  'packages/core/src/__tests__/core.test.js',
  'packages/core/src/__tests__/statement-reconciliation.test.js',
  'packages/core/src/__tests__/queue-timing.test.js',
  'packages/core/src/__tests__/webhook-engine.test.js',
  'packages/merchant-sdk/src/__tests__/merchant-sdk.test.js',
  'packages/youpi-mcp/src/__tests__/mcp-server.test.js',
  'packages/merchant-sdk/src/__tests__/youpi-universal-integration.test.js',
  'apps/checkout-portal/src/__tests__/checkout-portal.test.js',
  'apps/checkout-portal/src/__tests__/checkout-xss.test.js',
  'apps/checkout-portal/src/__tests__/issue-64-hardening.test.js',
  'apps/coin-wallet-store/src/__tests__/coin-wallet-store.test.js',
  'apps/merchant-admin/src/__tests__/merchant-admin.test.js',
  'apps/payment-help/src/__tests__/payment-help.test.js',
  'apps/gmail-observer/src/__tests__/gmail-observer.test.js',
  'apps/sms-observer/src/__tests__/sms-observer.test.js',
  'apps/android-observer-app/__tests__/android-observer.test.js',
  'apps/control-center/src/__tests__/control-center.test.js',
  'apps/payment-api/src/__tests__/payment-api.test.js',
  'apps/payment-api/src/__tests__/phase1-observed-success.test.js',
  'apps/payment-api/src/__tests__/statement-import.test.js',
  'apps/payment-api/src/__tests__/auth-guard.test.js',
  'apps/payment-api/src/__tests__/counter-payments.test.js',
  'apps/payment-api/src/__tests__/selling-modes-and-cod.test.js',
  'apps/payment-api/src/__tests__/developer-payment-simulator.test.js',
  'apps/payment-api/src/__tests__/developer-test-mode.test.js',
  'apps/payment-api/src/__tests__/device-binding-duplicate-session.test.js',
  'apps/payment-api/src/__tests__/fraud-ban-pipeline.test.js',
  'apps/payment-api/src/__tests__/sms-gmail-verification-levels.test.js',
  'apps/payment-api/src/__tests__/verification-fallthrough.test.js',
  'apps/payment-api/src/__tests__/upi-server-health-and-pc-ui.test.js',
  'apps/payment-api/src/__tests__/whatsapp-berry-auth.test.js',
  'apps/payment-api/src/__tests__/whitelabel-branding.test.js',
  'apps/payment-api/src/__tests__/cod-parallel-timer-decoupling.test.js',
  'apps/payment-api/src/__tests__/gateway-hardening-invariants.test.js',
  'apps/payment-api/src/__tests__/observer-poller.test.js',
  'scripts/chaos-concurrency.test.js',
  'scripts/production-infrastructure.test.js'
];

console.log('============================================================');
console.log('🧪 YOUPI PG V2 — FULL REGRESSION TEST RUNNER');
console.log(`Running ${testFiles.length} curated test suites...`);
console.log('============================================================\n');

let passedCount = 0;
const startTotal = Date.now();

for (let i = 0; i < testFiles.length; i++) {
  const file = testFiles[i];
  process.stdout.write(`[${i + 1}/${testFiles.length}] Testing ${file}... `);
  const startFile = Date.now();
  const result = spawnSync(process.execPath, ['--test', file], {
    stdio: 'pipe',
    env: {
      ...process.env,
      YOUPI_MODE: 'localhost',
      NODE_ENV: 'test'
    },
    encoding: 'utf8'
  });

  const duration = ((Date.now() - startFile) / 1000).toFixed(2);

  if (result.status === 0) {
    passedCount++;
    console.log(`✅ PASS (${duration}s)`);
  } else {
    console.log(`❌ FAIL (${duration}s)\n`);
    console.error(result.stdout || '');
    console.error(result.stderr || '');
    console.error(`\n[-] Test failed in ${file}`);
    process.exit(result.status || 1);
  }
}

const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(2);
console.log('\n============================================================');
console.log(`🎉 ALL ${passedCount} TEST SUITES PASSED CLEANLY (Total: ${totalDuration}s)`);
console.log('============================================================');
process.exit(0);
