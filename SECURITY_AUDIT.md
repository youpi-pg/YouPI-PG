# YouPI-PG security & bug-fix status

**Status: EXPERIMENTAL; NOT APPROVED FOR REAL-MONEY PRODUCTION.**
Scope is limited to the fork's `security/webhook-durability-hardening` branch.
This is a targeted static review, not an exhaustive independent penetration test or UPI settlement certification.

## Implemented in this branch

| Area | Source | What changed |
| --- | --- | --- |
| Terminal event durability | `packages/db/src/sqlite-schema.sql`, `schema.sql` | An outbox trigger writes a terminal event in the same SQLite status-update transaction. Migrating existing database records does not enqueue historical terminal orders. |
| Crash-safe dispatch | `packages/core/src/webhook-engine.js` | Persist delivery body, ID and retry lease **before** sending HTTP; update result after response. Existing deliveries suppress duplicate event sends. |
| Startup recovery | `apps/payment-api/src/index.js` | Drain missing outbox deliveries on boot and during the periodic worker; existing pending deliveries continue retrying. |
| Regression coverage | `packages/core/src/__tests__/webhook-outbox-durability.test.js` | Synthetic pre-fetch persistence, pending outbox replay, duplicate prevention and unchanged body/ID retry. |
| Safer configuration templates | `.env.example`, `packages/common/src/secrets.js` | Remove published password/secret defaults, generate local service secrets when unset and restrict POSIX secret-directory/file permissions. |
| Documentation | `README.md`, `ARCHITECTURE.md` | Align runtime with Node 24 and correct claims about timed-out payment verification. |

## Deployment blockers / unresolved areas

1. **Bank settlement is not proven by notification parsing.** An SMS/email/push alert, an amount match, a browser callback or an HMAC webhook does not establish settlement. Require official bank-statement/API reconciliation with human handling for ambiguous cases.
2. **Payment attribution needs adversarial testing.** Duplicate UTR, wrong sender/account, reused amount, spoofed notification, expired session, delayed alert and restart races require traceable integration tests; no production certification has been performed.
3. **Webhook at-least-once semantics:** merchants must verify raw-body signatures, delivery freshness, expected payment/order/amount and deduplicate by `X-Gateway-Delivery-Id`. A receiver can commit before the sender receives an ACK; retry is possible.
4. **Unconfigured/invalid webhook endpoints:** events can remain in the outbox or produce undeliverable audit rows. Implement operational dashboards, manual replay after correction, alerts on backlog and exhausted retries.
5. **Network egress/SSRF:** URL validation is present, but DNS rebinding, private DNS resolutions and outbound firewall isolation have not been independently assessed. Enforce egress controls and trusted HTTPS receiver hosts.
6. **Secrets and account security:** audit every production token, API key, bank observer/OAuth credential and historical Git commit for exposure. Rotation and controlled migration of data encrypted under the old master key require an operational plan.
7. **PII/OTP and devices:** assess observer permissions, SMS/notification content retention, OTP rate limits, device revocation and lost-device behavior.
8. **Compliance and operations:** verify receiving-account terms, UPI/NPCI/banking requirements, legal role, refunds/chargebacks, backups/WAL restore, incident response and fraud reconciliation.
9. **CI not verified here:** run `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm audit --omit=dev --audit-level=high` and Android APK build/verification before merging. GitHub Actions availability on forks may require explicit enabling.

## Synthetic verification plan

- Transition an ACTIVE synthetic session to EXPIRED or a PROCESSING session to SUCCESS; assert exactly one `payment_webhook_outbox` row.
- Stop the API immediately after terminal DB commit but before dispatch; restart with the **same SQLite file**, ensure an eventual durable delivery appears.
- Block an HTTP webhook response; SIGKILL the API; restart and confirm the pending delivery has the **same** ID, timestamp and exact body; merchant deduplication must reject double fulfillment.
- Inject repeated observation data, altered amounts, reused UTR and out-of-order notifications; never treat a questionable event as settled without independent reconciliation.
- Run all tests with synthetic identities and localhost receivers, with no real bank accounts, phone data, OAuth tokens or live money.

## Merge policy

Keep this PR in **draft** until tests and a reviewer validate the behavior. It is not appropriate to merge or deploy based solely on this change list.
