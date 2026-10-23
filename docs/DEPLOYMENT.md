# YOUPI PG V2 — Deployment & Installation Guide

This document describes how to deploy and run the clean distributable **YOUPI PG V2** package.

## 1. Prerequisites

- **Operating System**: Linux (Ubuntu 22.04+ / Debian 12+), macOS, or Windows 10/11 / Windows Server.
- **Node.js**: Version `>= 20.0.0` (LTS recommended).
- **Package Manager**: `npm` (included with Node.js).
- **Network Ports**:
  - `6100`: Payment Core API
  - `7000`: Checkout Portal & `youpi.js` SDK host
  - `6001`: Merchant Admin Panel
  - `5000`: Demo Coin Wallet Store (Reference Implementation)
  - `6002`: SMS Observer
  - `6003`: Gmail Observer
  - `8090`: Control Center Supervisor

---

## 2. Installation Steps

### Step 1: Extract / Clone Package
Ensure you are in the package root directory:
```bash
cd "YOUPI PG PACKAGE"
```

### Step 2: Configure Environment
Copy the clean template to `.env`:
```bash
cp .env.example .env
```
Open `.env` in your editor and configure:
1. `ENCRYPTION_MASTER_KEY`: Generate a 64-character hex key (e.g. `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`).
2. `JWT_SECRET`: Random string at least 32 characters.
3. `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`: Credentials for your Merchant Admin dashboard.
4. `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL`: Your public domain or localhost URLs.

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Initialize Fresh Database
Run the automated database setup to initialize schema and seed the default merchant and receiving account:
```bash
npm run db:setup
```
*(Creates `data/youpi_pg.sqlite` in clean state with 0 transactions).*

### Step 5: Start the System

#### Development / Demonstration Mode:
```bash
npm run dev
```
Starts all services with live reload and console aggregation under the Control Center at `http://localhost:8090`.

#### Production Mode:
```bash
npm run start
```
Starts services in background daemon mode.

---

## 3. Verifying Your Installation

1. **Checkout Portal & SDK**:
   Open `http://localhost:7000/youpi.js` — you should see the official JavaScript SDK.
2. **Demo Store**:
   Open `http://localhost:5000` — you should see the reference YOUPI Store with the interactive buy button and Developer Guide.
3. **Merchant Admin**:
   Open `http://localhost:6001` and log in with your admin credentials from `.env`.
   Configure your active UPI ID and payee name in the Receiving Accounts tab.
4. **Health Check**:
   `curl http://localhost:6100/health` returns `{"status":"UP"}`.

---

## 4. Production Domain & SSL (Cloudflare / NGINX)

For production deployment:
1. Terminate SSL at your reverse proxy (NGINX, Caddy, or Cloudflare Tunnel).
2. Point your public domain (e.g. `pay.yourdomain.com`) to port `7000` (Checkout Portal) or `6100` (Payment API).
   *The Checkout Portal automatically proxies all `/api/*` requests to the Payment API.*
3. Update `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL` in `.env` to match your public HTTPS domain.
## Vercel Services

The root `vercel.json` defines the approved multi-service deployment. Public
traffic is routed to `/` (checkout), `/api/*` (payment API), `/admin/*`
(merchant admin), `/help/*` (payment help), and `/store/*` (coin wallet store).
The control center, Gmail observer, and SMS observer remain internal services.

Service-to-service URLs are injected by Vercel bindings at runtime. The
application reads `PAYMENT_API_URL`, `CHECKOUT_PORTAL_URL`,
`CONTROL_CENTER_URL`, `GMAIL_OBSERVER_URL`, and `SMS_OBSERVER_URL`; these are
binding variables and must not be manually configured with deployment URLs.

Vercel Services is currently beta. The native deployment still remains the
recommended production target for the SQLite-backed gateway and its long-lived
observer processes; a Vercel deployment must use a persistent database and
separate worker strategy before handling production payment traffic.
