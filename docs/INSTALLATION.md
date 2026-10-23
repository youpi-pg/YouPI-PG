# Installation & Host Environment Setup Guide

## 1. Operating Environment

YOUPI PG is distributed as source code and is engineered to run directly as native host processes on standard Linux (Ubuntu, Debian, RHEL, CentOS) and Windows 10/11 environments.

**Zero Docker Requirement:** Docker, Docker Compose, and external container engines are completely optional and not required. Standard `npm install` works out-of-the-box across all workspace packages.

### Prerequisites

- **Node.js:** v24.22.1 Active LTS ("Krypton") or higher (verify with `node -v`) for native `node:sqlite` (`DatabaseSync` Release Candidate with defensive mode) and essential protection against October 2026 security CVEs (CVE-2026-111497, CVE-2026-105482, CVE-2026-105483).
- **Database:** Built-in zero-dependency SQLite WAL with automatic schema provisioning (or optional PostgreSQL v14+)
- **Java/JDK (Optional, for Android APK build):** OpenJDK 17+
- **Docker & Docker Compose (Optional):** For containerized zero-setup execution

---

## 2. Zero-Config Quickstart (All Platforms)

Thanks to **Zero-Config Database Auto-Provisioning**, YOUPI PG automatically creates `data/youpi_pg.sqlite` and executes idempotent schema migrations and default seeds on first launch:

```bash
# 1. Clone repository
git clone <your-repository-url> youpi-pg
cd youpi-pg

# 2. Install dependencies (Standard NPM out-of-the-box)
npm install

# 3. Configure environment
cp .env.example .env

# 4. Start all services
npm start
# or for live development:
npm run dev
```

---

## 3. Linux (Ubuntu / Debian) Production Setup

```bash
# 1. Update system packages
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js 24 LTS & Git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

# 3. Clone and enter repository
git clone <your-repository-url> youpi-pg
cd youpi-pg

# 4. Install dependencies
npm install

# 5. Configure environment
cp .env.example .env
nano .env

# 6. Start production cluster (SQLite auto-initializes on boot)
npm start
```

---

## 4. Windows 10 / 11 Setup

```powershell
# 1. Verify Node.js (>= v24.22.1 LTS)
node -v

# 2. Install dependencies
npm install

# 3. Configure environment
Copy-Item .env.example .env

# 4. Start services (Zero-config auto-initialization)
npm run dev
```

Navigate to `http://localhost:8090` to access the Control Center supervisor and verify all running services.
