import fs from 'node:fs';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

export class ProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;

    // Registry of managed native host services
    this.services = [
      {
        id: 'payment-api',
        name: 'Payment Core API',
        script: path.join(rootDir, 'apps/payment-api/src/index.js'),
        port: Number(process.env.PAYMENT_API_PORT || 6100),
        healthPath: '/health',
        child: null,
        status: 'STOPPED',
        startTime: null,
        pid: null
      },
      {
        id: 'checkout-portal',
        name: 'Checkout Portal',
        script: path.join(rootDir, 'apps/checkout-portal/src/index.js'),
        port: Number(process.env.CHECKOUT_PORTAL_PORT || 7000),
        healthPath: '/health',
        child: null,
        status: 'STOPPED',
        startTime: null,
        pid: null
      },
      {
        id: 'merchant-admin',
        name: 'Merchant Admin Dashboard',
        script: path.join(rootDir, 'apps/merchant-admin/src/index.js'),
        port: Number(process.env.MERCHANT_ADMIN_PORT || 6001),
        healthPath: '/health',
        child: null,
        status: 'STOPPED',
        startTime: null,
        pid: null
      },
      {
        id: 'gmail-observer',
        name: 'Gmail Payment Observer',
        script: path.join(rootDir, 'apps/gmail-observer/src/index.js'),
        port: Number(process.env.GMAIL_OBSERVER_PORT || 6003),
        healthPath: '/health',
        child: null,
        status: 'STOPPED',
        startTime: null,
        pid: null
      },
      {
        id: 'sms-observer',
        name: 'Google Messages / SMS Observer (Legacy)',
        script: path.join(rootDir, 'apps/sms-observer/src/index.js'),
        port: Number(process.env.SMS_OBSERVER_PORT || 6002),
        healthPath: '/health',
        child: null,
        status: 'STOPPED',
        startTime: null,
        pid: null
      },
      {
        id: 'coin-wallet-store',
        name: 'YOUPI Showcase Store (Demo)',
        script: path.join(rootDir, 'apps/coin-wallet-store/src/index.js'),
        port: Number(process.env.COIN_STORE_PORT || 5000),
        healthPath: '/health',
        child: null,
        status: 'STOPPED',
        startTime: null,
        pid: null
      }
    ];

    this.logs = []; // Circular buffer of log entries
    this.maxLogs = 500;
  }

  appendLog(serviceId, stream, text) {
    const lines = text.toString().split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      const entry = {
        timestamp: new Date().toISOString(),
        serviceId,
        stream,
        line: line.trim()
      };
      this.logs.push(entry);
      if (this.logs.length > this.maxLogs) {
        this.logs.shift();
      }
      this.emit('log', entry);
    }
  }

  getService(id) {
    return this.services.find(s => s.id === id) || null;
  }

  getServicesStatus() {
    return this.services.map(s => ({
      id: s.id,
      name: s.name,
      port: s.port,
      status: s.status,
      pid: s.pid,
      uptimeSeconds: s.startTime ? Math.floor((Date.now() - s.startTime) / 1000) : 0
    }));
  }

  /**
   * Starts a managed service by spawning a native Node.js child process.
   * @param {string} id
   */
  async startService(id) {
    const svc = this.getService(id);
    if (!svc) throw new Error(`Unknown service: ${id}`);
    if (svc.stopPromise) await svc.stopPromise;
    if (svc.status === 'RUNNING' && svc.child) return svc;

    svc.status = 'STARTING';
    this.emit('status_change', { id: svc.id, status: svc.status });

    const envFile = path.join(rootDir, '.env');
    const freshEnv = {};
    if (fs.existsSync(envFile)) {
      try {
        const raw = fs.readFileSync(envFile, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx !== -1) {
            const key = trimmed.slice(0, idx).trim();
            let val = trimmed.slice(idx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            freshEnv[key] = val;
          }
        }
      } catch {}
    }
    const supervisorOverrides = {};
    if (process.env.NODE_ENV) supervisorOverrides.NODE_ENV = process.env.NODE_ENV;
    if (process.env.YOUPI_MODE) supervisorOverrides.YOUPI_MODE = process.env.YOUPI_MODE;
    // Re-apply the shared .env file as a child-process argument unless the caller already
    // supplied one. Without this declaration the fork() below referenced an undefined
    // variable and crashed every service start (ReferenceError: execArgv is not defined).
    const hasEnvArg = process.execArgv.some(arg => String(arg).startsWith('--env-file'));
    const execArgv = (!hasEnvArg && fs.existsSync(envFile)) ? [`--env-file=${envFile}`] : [];

    const child = fork(svc.script, [], {
      execArgv: [...process.execArgv, ...execArgv],
      env: { ...freshEnv, ...process.env, ...supervisorOverrides, PORT: svc.port.toString() },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    svc.child = child;
    svc.pid = child.pid;
    svc.startTime = Date.now();
    svc.status = 'RUNNING';

    child.stdout?.on('data', data => this.appendLog(svc.id, 'stdout', data));
    child.stderr?.on('data', data => this.appendLog(svc.id, 'stderr', data));

    child.on('exit', (code, signal) => {
      this.appendLog(svc.id, 'system', `Process exited with code ${code} (signal: ${signal})`);
      if (svc.child !== child) return;
      svc.status = 'STOPPED';
      svc.child = null;
      svc.pid = null;
      svc.startTime = null;
      this.emit('status_change', { id: svc.id, status: svc.status });
    });

    this.appendLog(svc.id, 'system', `Started ${svc.name} on PID ${svc.pid} (port ${svc.port})`);
    this.emit('status_change', { id: svc.id, status: svc.status });

    return svc;
  }

  /**
   * Stops a managed service gracefully.
   * @param {string} id
   */
  async stopService(id) {
    const svc = this.getService(id);
    if (!svc) throw new Error(`Unknown service: ${id}`);
    if (svc.stopPromise) {
      await svc.stopPromise;
      return svc;
    }
    if (!svc.child) {
      svc.status = 'STOPPED';
      return svc;
    }

    this.appendLog(svc.id, 'system', `Stopping ${svc.name} (PID ${svc.pid})...`);

    const child = svc.child;
    // Retain ownership until exit: kill() only sends a signal. A fixed restart
    // delay can otherwise overlap children and let an old exit detach the new one.
    const stopping = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(killTimer);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const killTimer = setTimeout(() => {
        this.appendLog(svc.id, 'system', `Graceful shutdown timed out; killing PID ${child.pid}`);
        try { child.kill('SIGKILL'); } catch (err) { onError(err); }
      }, this.stopTimeoutMs);
      killTimer.unref();
      child.once('exit', onExit);
      child.once('error', onError);
      try { child.kill('SIGTERM'); } catch (err) { onError(err); }
    });
    svc.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (svc.stopPromise === stopping) svc.stopPromise = null;
    }

    return svc;
  }

  async restartService(id) {
    await this.stopService(id);
    return await this.startService(id);
  }

  /**
   * Starts all managed services.
   */
  async startAll() {
    for (const svc of this.services) {
      if (svc.legacy && process.env.ENABLE_LEGACY_CHROME_OBSERVERS !== 'true') {
        continue;
      }
      try {
        await this.startService(svc.id);
      } catch (err) {
        this.appendLog(svc.id, 'error', `Failed to start: ${err.message}`);
      }
    }
  }

  /**
   * Stops all managed services.
   * INVARIANT: Never stops or terminates the Control Center itself!
   */
  async stopAll() {
    for (const svc of this.services) {
      if (svc.child) {
        await this.stopService(svc.id);
      }
    }
  }
}
