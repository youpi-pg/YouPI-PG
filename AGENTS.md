# AGENTS.md — YOUPI PG V2 Operating & Integration Standard

This document establishes the mandatory architectural rules, Git workflows, security standards, and payment lifecycle invariants for both AI coding agents and human engineers contributing to or integrating with **YOUPI PG V2**.

---

## Part 1: AI & Developer Operating Standard

### 1. Mandatory Git Workflow & Branching Rules

1. **NEVER make direct commits to `main`**.
2. **Branch Directly Off Active Working Branch (Never Checkout `main` First)**:
   - For every bug fix, feature addition, or code modification, create a dedicated feature or fix branch:
     - Features: `feature/<feature-name>` (e.g., `feature/postgres-adapter`, `feature/reviewground-ci`)
     - Fixes: `fix/<issue-name>` (e.g., `fix/otp-throttle-test`, `fix/bank-sms-regex`)
   - **Never revert to or checkout `main` when creating a new branch**: Always branch directly off the **current active working branch** (`git checkout -b <new-branch>`). This preserves ongoing work, staged changes, and prevents context loss or accidental regression.
3. **Mandatory Pre-Commit & Pre-Push Checklist**:
   - **Sync & Prune (`git fetch --prune --all`)**: Always run `git fetch --prune --all` before creating branches, pushing, or opening a PR to clean up stale remote-tracking references.
   - **Typecheck**: Run `npm run typecheck` locally to verify TypeScript compiles without errors.
   - **Unit & Regression Tests**: Run `npm test` locally to ensure 100% of curated test suites pass cleanly.
   - **Inspect Changes**: Always check `git status`, `git diff`, and `git log -n 3 --oneline` before staging/committing to prevent accidental secret leaks, debug dumps, or unneeded files.
   - **Environment Integrity**: Ensure any new environment variables are documented in `.env.example` and `docs/CONFIGURATION.md`. Never hardcode API keys, tokens, or private credentials into source code.
4. **Strict No-Unsolicited-Push Rule & PR Protocol**:
   - **Never Push Automatically**: After committing locally, **NEVER execute `git push` to remote (`origin`) without informing and obtaining explicit confirmation from the user in chat first**. All commits must remain strictly local until pre-approved.
   - **Auto-Create PR Upon Push Confirmation**: Once the user explicitly approves pushing, push the branch (`git push -u origin <branch>`). Check first if a PR already exists (`gh pr list --head <branch>`); if an existing PR is found, inform the developer of the updated PR. If no PR exists, open a Pull Request against `main` using GitHub CLI (`gh pr create`) with a detailed title, summary, and verification details.
   - **Strict No-Unsolicited-Merge Rule & Clean Branch Deletion (`--delete-branch`)**:
     - **NEVER merge the PR into `main` automatically**. Always ask/inform the developer and wait for their explicit command before merging any PR.
     - **Mandatory Branch Deletion & Standard Merge Commit (`--merge`)**: When instructed to merge, ALWAYS execute the merge using a standard merge commit with automatic branch deletion enabled (`gh pr merge <pr-number> --merge --delete-branch`), followed by cleaning up local tracking references (`git checkout main && git pull && git fetch --prune --all && git branch -D <branch>`).
5. **Mandatory Granular & Atomic Commits Standard**:
   - **Never Bundle Multiple Unrelated Features into a Single Monolithic Commit**: Create independent, atomic commits for each logical unit of work.
   - **Conventional Commits**: Every commit header MUST adhere strictly to Conventional Commits:
     - `feat(...)` — New features (Minor bump)
     - `fix(...)` — Bug fixes (Patch bump)
     - `perf(...)` — Performance improvements
     - `refactor(...)` — Refactoring without behavioral change
     - `docs(...)` — Documentation changes
     - `test(...)` — Adding or correcting tests
     - `ci(...)` — CI/CD workflow changes
     - `chore(...)` — Maintenance tasks
   - **Always Commit with Detailed Information**:
     - Every commit message MUST include a conventional header, a bulleted list of what changed, the architectural rationale, and verification status.
6. **Mandatory Automated PR Review & Interactive Suggestion Resolution Protocol**:
   - **Proactive Review & Inline Suggestion Inspection**: After opening a PR or pushing a commit, inspect GitHub Actions CI run results, automated AI code review comments (e.g., ReviewGround, security linters), and **inline PR review suggestions** via `gh pr view <pr-number> --comments` and `gh api repos/<owner>/<repo>/pulls/<pr-number>/comments`.
   - **Continuous Suggestion & Inline Fix Resolution**: If automated reviews or maintainers flag valid and needed suggestions—such as 1-click inline code suggestions, eliminating dynamic evaluation (`new Function`, `eval`), strengthening path traversal boundaries (`path.relative`), resolving security advisories/CWEs, fixing memory leaks, or improving code safety—the agent **MUST continuously and proactively address and implement them**.
   - **Sync Fixes Across Fork & Upstream PRs**: When fixes or architectural improvements are committed on the fork, verify whether corresponding open upstream PRs require the same updates and push the new commits to upstream PR branches promptly.
   - **Re-Verification & Push**: Always verify all fixes locally (`npm run typecheck`, `npm test`) and push updates to the active PR branch so that the PR achieves 100% green checks with zero unresolved blockers or critical warnings before requesting merge approval.
7. **Mandatory Real-World & External Verification Standard (RBI, Regulators, Internet & Community Sources)**:
   - **Never Hardcode Assumptions Directly into Code**: When dealing with real-world entities—such as banking identifiers, regulatory domain spaces (e.g., RBI/IDRBT `.bank.in` and `.fin.in` mandates), bank SMS headers, transaction email alert senders, or NPCI UPI specification rules—never insert assumptions or arbitrary hardcoded lists directly into source code.
   - **Mandatory Web, Regulatory & Community Verification**: If verification is needed for a real test case, domain whitelist, regex pattern, or banking protocol, the agent MUST proactively verify it against authoritative regulatory sources (RBI circulars, IDRBT registry, NPCI specs) and authentic real-world telemetry (community forums like Reddit, bank documentation, official releases).
   - **Grounding in Real Test Cases & Specifications**: Ensure unit tests, regex patterns, and validation logic reflect actual production formats used by Indian banks and payment networks (including both modern `.bank.in` domain structures and verified legacy commercial notification channels).

---

## Part 2: High-Level Architecture & Integration Guide

### 1. Payment Lifecycle Architecture

YOUPI PG V2 is a self-hosted, sovereign payment gateway designed for zero-fee UPI and counter payments with automated banking observation (SMS & Gmail parsing).

```
  [ Merchant Website / App ]
              │
    (1) Adds one script: <script src=".../youpi.js" data-youpi-key="...">
              │
    (2) Maps payment button: <button data-youpi-pay data-order-id="..." data-amount="...">
              │
    (3) YOUPI JS dims/blurs background & renders centered responsive modal (or mobile sheet)
              │
    (4) Existing iframe loads /checkout/:id with dynamic single-use QR and UPI intent
              │
    (5) Customer pays via any UPI app (GPay, PhonePe, Paytm, CRED, BHIM)
              │
    (6) Banking Observers detect SMS / Gmail credit notification
              │
    (7) Verification Engine verifies amount, UTR, and timestamps
              │
    (8) Payment State Machine transitions session to SUCCESS
              │
     ┌────────┴──────────────────────────┐
     ▼                                   ▼
 [ Browser CustomEvents ]      [ Signed Webhook Delivery ]
 youpi:payment:success          POST /api/webhook (HMAC-SHA256)
 (For instant UI feedback)      (AUTHORITATIVE PROOF OF PAYMENT)
```

---

### 2. Universal One-Script Integration

#### Step 1: Script Inclusion

Place the script tag in the page's HTML `<head>` or `<body>`:

```html
<script
  src="https://<youpi-checkout-host>/youpi.js"
  data-youpi-key="YOUR_MERCHANT_KEY"
></script>
```

- When running locally, `<youpi-checkout-host>` is `http://localhost:7000`.
- In production, it is your canonical checkout portal domain (e.g., `https://pay.yourdomain.com`).

#### Step 2: One-Button Zero-JS Configuration

Tag any clickable button with `data-youpi-pay`:

```html
<button
  data-youpi-pay
  data-order-id="ORDER-1001"
  data-amount="499"
  data-currency="INR"
  data-customer-name="Mohit"
  data-customer-email="mohit@example.com"
  data-customer-phone="9876543210"
  data-metadata='{"sku":"TSHIRT-01"}'
>
  Buy Now
</button>
```

The script automatically binds click events to elements with `[data-youpi-pay]`, including elements created dynamically at runtime.

#### Step 3: Programmatic API (`Youpi.pay`)

For single-page apps (React, Next.js, Vue, Nuxt, Svelte), use the programmatic interface:

```javascript
Youpi.pay({
  order_id: "ORDER-1001",
  amount: 499.0,
  currency: "INR",
  customer: {
    name: "Mohit",
    email: "mohit@example.com",
    phone: "9876543210",
  },
  metadata: {
    sku: "TSHIRT-01",
    cart_id: "CART-99",
  },
  handler: function (response) {
    console.log("Payment confirmed in modal:", response);
  },
  onClose: function () {
    console.log("Modal closed by customer");
  },
});
```

---

### 3. Normalized Browser Events

The frontend script emits normalized DOM `CustomEvent`s on `window`:

| Event Name                 | Trigger Condition                                       |
| :------------------------- | :------------------------------------------------------ |
| `youpi:payment:success`    | Payment verified by banking observers                   |
| `youpi:payment:failed`     | Payment declined, wrong amount, or verification timeout |
| `youpi:payment:suspicious` | Payment flagged by security/risk engine                 |
| `youpi:payment:expired`    | 5-minute active payment window expired                  |
| `youpi:payment:cancelled`  | Customer cancelled or dismissed the checkout            |
| `youpi:payment:result`     | Unified event dispatched on any outcome                 |

#### Payload Contract (`event.detail`):

```javascript
{
  "status": "SUCCESS",              // 'SUCCESS' | 'FAILED' | 'SUSPICIOUS' | 'EXPIRED' | 'CANCELLED'
  "order_id": "ORDER-1001",
  "amount_received": 499.00,
  "payment_mode": "UPI",            // 'UPI' | 'COD' | 'CASH_COUNTER' | 'CARD_COUNTER'
  "utr": "123456789012",            // 12-digit bank reference number
  "timestamp": "2026-10-07T12:00:00.000Z",
  "metadata": { "sku": "TSHIRT-01" }
}
```

---

### 4. Authoritative Server-to-Server Webhooks

> **CRITICAL RULE**: Browser events are strictly for user interface updates.  
> **NEVER** mark orders as fulfilled or deliver digital goods based on browser events. Only fulfill orders after verifying the server-to-server webhook!  
> **RAW BODY REQUIREMENT**: Request bytes must **NOT** be parsed to JSON before HMAC calculation. Always compute HMAC over raw unparsed request bytes!

#### Webhook Request Specifications:

- **HTTP Method**: `POST`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Gateway-Event: SUCCESS`
  - `X-Gateway-Signature: sha256=<64_char_hex_hash>`
  - `X-Gateway-Delivery-Id: <uuid>`
  - `X-Gateway-Timestamp: <ms>`

#### Payload Contract (`payload`):

```json
{
  "event": "SUCCESS",
  "paymentId": "c7942127-14e3-469a-9e4a-9359a16f903a",
  "orderId": "ORDER-1001",
  "amount": "499.00",
  "amountPaise": 49900,
  "currency": "INR",
  "method": "UPI",
  "utr": "123456789012",
  "completedAt": "2026-10-07T12:00:00.000Z",
  "metadata": { "sku": "TSHIRT-01" }
}
```

> **PAYMENT METHOD RULE**: `event: "SUCCESS"` is also sent when a customer places a **Cash on Delivery** order (`method: "COD"`) or a counter payment is confirmed (`CASH_COUNTER` / `CARD_COUNTER`). For `COD` no money has been received yet. Always check `payload.method` before you treat an order as **paid**.

#### Node.js (Express) Webhook Verification Example:

```javascript
import crypto from "node:crypto";

app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.headers["x-gateway-signature"] || "";
    const secret = process.env.YOUPI_WEBHOOK_SECRET;
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(req.body).digest("hex");

    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    if (payload.event === "SUCCESS" && payload.method === "UPI") {
      db.orders.markPaid(payload.orderId, {
        utr: payload.utr,
        amount: payload.amount,
        amountPaise: payload.amountPaise,
      });
    }

    res.status(200).json({ received: true });
  },
);
```

---

### 5. Security & Architectural Invariants

1. **No Public Force-Success Endpoint**:
   - There is no endpoint that allows a client or developer to arbitrarily declare `SUCCESS`.
   - `SUCCESS` is generated solely by the internal verification engine after matching a genuine bank SMS/Gmail observation.
2. **Never Expose Secret API Keys in Frontend**:
   - Only publishable public keys (e.g., `data-youpi-key`) may appear in HTML/JS.
   - `webhookSecret`, database credentials, and observer tokens must remain strictly on the backend.
3. **Idempotency & Deduplication**:
   - Webhook deliveries include unique `X-Gateway-Delivery-Id` and `orderId`. Merchants must ensure their webhook processing is idempotent.
4. **Preserve Customer Metadata**:
   - Unrecognized fields in `metadata` are passed through untouched and included in webhooks and API responses.
5. **Node.js Engine Standard**:
   - The project strictly targets **Node.js >= 24.22.1** (Active LTS "Krypton") due to built-in `node:sqlite` (`DatabaseSync` Release Candidate with defensive mode) and security hardening against October 2026 CVEs (CVE-2026-111497 Brotli RCE, CVE-2026-105482 DNS truncation, and CVE-2026-105483 TLS bypass).

---

### 6. Service Ports (Standard Topology)

| Service                    | Port   | Description                                          |
| :------------------------- | :----- | :--------------------------------------------------- |
| **Coin Wallet Demo Store** | `5000` | Reference merchant implementation & store            |
| **Payment Core REST API**  | `6100` | Core gateway engine, state machine, queue            |
| **Checkout Portal**        | `7000` | Serves `youpi.js`, iframe `/checkout/:id`, API proxy |
| **Merchant Admin**         | `6001` | Dashboard for slots, receiving VPAs, observers       |
| **SMS Observer**           | `6002` | Android SMS banking webhook ingester                 |
| **Gmail Observer**         | `6003` | Push notification / Gmail observation ingester       |
| **Process Control Center** | `8090` | Local process supervisor daemon                      |
