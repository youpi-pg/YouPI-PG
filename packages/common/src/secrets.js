import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved from this file, not cwd: every service must read the same files.
const SECRETS_DIR = path.resolve(__dirname, '../../../data/.secrets');

const cache = new Map();

/**
 * Resolves a service secret: explicit env var first, else a random value
 * generated once and persisted under data/.secrets/ (shared by all local services).
 * @param {string} name file-safe secret name
 * @param {string} [envVar] env var that overrides the file
 * @returns {string}
 */
export function resolveSecret(name, envVar) {
  const fromEnv = envVar ? (process.env[envVar] || '').trim() : '';
  if (fromEnv) return fromEnv;
  if (cache.has(name)) return cache.get(name);

  const file = path.join(SECRETS_DIR, name);
  let value = '';
  try { value = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!value) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    const fresh = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, fresh, { flag: 'wx', mode: 0o600 });
      value = fresh;
    } catch {
      // Another process created it first: use theirs.
      value = fs.readFileSync(file, 'utf8').trim();
    }
  }
  // Harden permissions for pre-existing stores as well as freshly generated keys.
  // chmod can be unavailable on some hosts (e.g. Windows), so fail best-effort here.
  try { fs.chmodSync(SECRETS_DIR, 0o700); } catch {}
  try { fs.chmodSync(file, 0o600); } catch {}
  cache.set(name, value);
  return value;
}

/** Constant-time string comparison (length-independent via hashing). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const getAdminToken = () => resolveSecret('admin_api_token', 'ADMIN_API_TOKEN');
export const getObserverToken = () => resolveSecret('observer_api_token', 'OBSERVER_API_TOKEN');
export const getCoinStoreWebhookSecret = () => resolveSecret('coin_store_webhook_secret', 'COIN_STORE_WEBHOOK_SECRET');

/**
 * Shared credential proving a request originated from a co-located service (server-side render
 * proxies) rather than a browser. A plain `X-Internal-Render: true` header is attacker-settable,
 * so the header is only honoured together with this secret.
 */
export const getInternalServiceToken = () => resolveSecret('internal_service_token', 'INTERNAL_SERVICE_TOKEN');

/**
 * Key used to sign device credentials and device challenges.
 *
 * Deliberately separate from the internal service token: that token is transmitted by the
 * checkout portal on every internal render, so sharing a key with it would mean a leaked
 * internal token could be used to mint a valid device credential for any device id.
 */
export const getDeviceCredentialKey = () => resolveSecret('device_credential_key', 'DEVICE_CREDENTIAL_KEY');

/**
 * Key used to index high-entropy secrets for lookup (session tokens, device tokens).
 * Separate from the internal service token so a leaked internal token cannot be used to
 * compute stored indexes.
 */
export const getBlindIndexKey = () => resolveSecret('blind_index_key', 'BLIND_INDEX_KEY');

/** True when a socket remoteAddress is loopback (IPv4 or IPv6). */
function isLoopbackRemoteAddress(remoteAddress) {
  // Fail closed: an absent or malformed address is NOT loopback. Returning true here would
  // let any request that hides its peer address satisfy the internal-service check.
  if (!remoteAddress || typeof remoteAddress !== 'string') return false;
  const addr = remoteAddress.trim().toLowerCase();
  if (!addr) return false;
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  // 127.0.0.0/8
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/** True only when the caller proves it is a trusted co-located internal service. */
export function isInternalServiceRequest(req) {
  if (!isLoopbackRemoteAddress(req?.socket?.remoteAddress)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(req?.headers?.['authorization'] || '');
  const presented = (match ? match[1].trim() : '') || (req?.headers?.['x-internal-token'] || '');
  return Boolean(presented) && safeEqual(presented, getInternalServiceToken());
}

/**
 * Mints a server-signed device credential bound to a specific `deviceId`.
 * Format: `devtok_<deviceId>.<nonce>.<issuedAt>.<hmac>`
 * @param {string} deviceId
 * @returns {string}
 */
export function issueDeviceCredential(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error('deviceId is required to issue a device credential');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = String(Date.now());
  const mac = crypto
    .createHmac('sha256', getDeviceCredentialKey())
    .update(`devcred:v1:${deviceId}:${nonce}:${issuedAt}`)
    .digest('hex');
  return `devtok_${deviceId}.${nonce}.${issuedAt}.${mac}`;
}

/**
 * Verifies in constant time that a presented `deviceToken` is a genuine server-signed
 * credential issued for `deviceId`.
 * @param {string} deviceId
 * @param {string} token
 * @returns {boolean}
 */
export function verifyDeviceCredential(deviceId, token) {
  if (!deviceId || typeof deviceId !== 'string' || !token || typeof token !== 'string') {
    return false;
  }
  const prefix = `devtok_${deviceId}.`;
  if (!token.startsWith(prefix)) return false;
  const rest = token.slice(prefix.length);
  const parts = rest.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, presentedMac] = parts;
  if (!nonce || !issuedAt || !presentedMac) return false;
  const expectedMac = crypto
    .createHmac('sha256', getDeviceCredentialKey())
    .update(`devcred:v1:${deviceId}:${nonce}:${issuedAt}`)
    .digest('hex');
  return safeEqual(presentedMac, expectedMac);
}

const DEVICE_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const consumedDeviceChallenges = new Map();

function deviceChallengeMac(deviceId, nonce, expiresAt) {
  return crypto
    .createHmac('sha256', getDeviceCredentialKey())
    .update(`devchal:v1:${deviceId}:${nonce}:${expiresAt}`)
    .digest('hex');
}

/**
 * Mints a short-lived, single-use challenge bound to a registered `deviceId` for
 * challenge-response token re-issuance.
 * @param {string} deviceId
 * @returns {string}
 */
export function createDeviceChallenge(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error('deviceId is required to create a device challenge');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = String(Date.now() + DEVICE_CHALLENGE_TTL_MS);
  const mac = deviceChallengeMac(deviceId, nonce, expiresAt);
  return `devchal_${deviceId}.${nonce}.${expiresAt}.${mac}`;
}

/**
 * Verifies and consumes a single-use device challenge bound to `deviceId`.
 * @param {string} challenge
 * @param {string} deviceId
 * @returns {boolean}
 */
export function consumeDeviceChallenge(challenge, deviceId) {
  if (typeof challenge !== 'string' || typeof deviceId !== 'string' || !deviceId) return false;
  const prefix = `devchal_${deviceId}.`;
  if (!challenge.startsWith(prefix)) return false;
  const parts = challenge.slice(prefix.length).split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiresAt, mac] = parts;
  if (!nonce || !expiresAt || !mac) return false;
  if (!safeEqual(mac, deviceChallengeMac(deviceId, nonce, expiresAt))) return false;
  const now = Date.now();
  if (!(Number(expiresAt) > now)) return false;
  for (const [k, exp] of consumedDeviceChallenges) {
    if (exp <= now) consumedDeviceChallenges.delete(k);
  }
  const key = `${deviceId}:${nonce}`;
  if (consumedDeviceChallenges.has(key)) return false;
  consumedDeviceChallenges.set(key, Number(expiresAt));
  return true;
}

/** Literal that older builds seeded into databases; must never be trusted. */
export const LEGACY_DEFAULT_WEBHOOK_SECRET = 'merchant_webhook_secret_for_wallet_store';

/**
 * Master key for encrypting data at rest (merchant webhook secrets, OTPs).
 * Generated once and persisted alongside the other local secrets.
 */
export const getEncryptionMasterKey = () => resolveSecret('encryption_master_key', 'ENCRYPTION_MASTER_KEY');

/** Envelope prefix marking a stored value as AES-256-GCM ciphertext. */
const ENC_PREFIX = 'enc:v1:';

/** True when a stored value is in the ciphertext envelope. */
export function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Encrypts a value for storage. Values are idempotent: an already-encrypted value is
 * returned unchanged so callers can wrap reads and writes without tracking state.
 */
export function encryptAtRest(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncryptedValue(plaintext)) return plaintext;
  return ENC_PREFIX + encrypt(String(plaintext), getEncryptionMasterKey());
}

/**
 * Decrypts a stored value, transparently passing through values written before encryption
 * existed (plaintext) so existing databases keep working and get re-encrypted on next write.
 */
export function decryptAtRest(stored) {
  if (!isEncryptedValue(stored)) return stored;
  try {
    return decrypt(stored.slice(ENC_PREFIX.length), getEncryptionMasterKey());
  } catch {
    // A value encrypted under a different/lost key must not silently become plaintext.
    return null;
  }
}

/**
 * Keyed digest for high-entropy secrets that are only ever looked up, never read back
 * (session tokens, device tokens). Unlike a plain hash this is not brute-forceable from a
 * database dump, because the key lives outside the database.
 *
 * The key is dedicated to this purpose rather than shared with the internal service token:
 * that token travels in a request header on every internal render, so a shared key would
 * leak the indexing secret wherever those headers are logged.
 */
export function blindIndex(value, namespace = 'token') {
  if (value === null || value === undefined || value === '') return null;
  const digest = crypto.createHmac('sha256', getBlindIndexKey())
    .update(`${namespace}:${value}`)
    .digest('hex');
  return `${namespace}_v1_${digest}`;
}

/**
 * Compares a presented secret against a stored blind index in constant time.
 *
 * Rows written before the key was separated were indexed with the internal service token,
 * so that key is still accepted for existing rows; the row is re-indexed on first use.
 */
export function blindIndexMatches(value, storedIndex, namespace = 'token') {
  if (!value || !storedIndex) return false;
  const candidate = blindIndex(value, namespace);
  if (candidate && safeEqual(candidate, storedIndex)) return true;
  // Legacy index produced with the previous key.
  const legacy = crypto.createHmac('sha256', getInternalServiceToken())
    .update(`${namespace}:${value}`)
    .digest('hex');
  return safeEqual(`${namespace}_v1_${legacy}`, storedIndex);
}

/** True when the request's `Authorization: Bearer` value matches any of the given tokens. */
export function hasBearer(req, ...tokens) {
  const match = /^Bearer\s+(.+)$/i.exec(req?.headers?.['authorization'] || '');
  if (!match) return false;
  const presented = match[1].trim();
  return tokens.some(t => safeEqual(presented, t));
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data'
]);

/**
 * Checks whether an IPv4 address (a.b.c.d) belongs to any private, loopback,
 * link-local, CGNAT, multicast, documentation or reserved range.
 */
function isPrivateIpv4(a, b, c, d) {
  // Current network (0.0.0.0/8)
  if (a === 0) return true;
  // Private-use (10.0.0.0/8)
  if (a === 10) return true;
  // Loopback (127.0.0.0/8)
  if (a === 127) return true;
  // Shared Address Space / CGNAT (100.64.0.0/10)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Link-Local / Cloud metadata (169.254.0.0/16)
  if (a === 169 && b === 254) return true;
  // Private-use (172.16.0.0/12)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // IETF Protocol Assignments (192.0.0.0/24)
  if (a === 192 && b === 0 && c === 0) return true;
  // TEST-NET-1 (192.0.2.0/24)
  if (a === 192 && b === 0 && c === 2) return true;
  // 6to4 relay anycast (192.88.99.0/24)
  if (a === 192 && b === 88 && c === 99) return true;
  // Private-use (192.168.0.0/16)
  if (a === 192 && b === 168) return true;
  // Benchmark testing (198.18.0.0/15)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // TEST-NET-2 (198.51.100.0/24)
  if (a === 198 && b === 51 && c === 100) return true;
  // TEST-NET-3 (203.0.113.0/24)
  if (a === 203 && b === 0 && c === 113) return true;
  // Multicast (224.0.0.0/4) & Reserved (240.0.0.0/4, includes 255.255.255.255)
  if (a >= 224) return true;
  return false;
}

/**
 * Parses a normalized IPv6 string into an array of 8 16-bit integers.
 * Supports standard shorthand notation ('::') and embedded IPv4 suffixes.
 * @param {string} str
 * @returns {number[] | null}
 */
function parseIpv6(str) {
  let clean = str.toLowerCase();
  const zoneIndex = clean.indexOf('%');
  if (zoneIndex !== -1) clean = clean.slice(0, zoneIndex);

  // Expand embedded IPv4 suffix if present (e.g. ::ffff:192.168.1.1)
  const lastColon = clean.lastIndexOf(':');
  if (lastColon !== -1) {
    const afterColon = clean.slice(lastColon + 1);
    const v4 = afterColon.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
      const p = v4.slice(1).map(Number);
      if (p.some(n => n > 255)) return null;
      const hi = ((p[0] << 8) | p[1]).toString(16);
      const lo = ((p[2] << 8) | p[3]).toString(16);
      clean = clean.slice(0, lastColon) + ':' + hi + ':' + lo;
    }
  }

  const parts = clean.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').map(h => parseInt(h, 16)) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').map(h => parseInt(h, 16)) : [];
  if (left.some(isNaN) || right.some(isNaN)) return null;
  const pad = 8 - (left.length + right.length);
  if (pad < 0) return null;
  return [...left, ...new Array(pad).fill(0), ...right];
}

/**
 * Checks whether an IPv6 address belongs to any private, loopback, link-local,
 * unique-local, multicast, translated, documentation or reserved range.
 */
function isPrivateIpv6(words) {
  if (!words || words.length !== 8) return false;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // Unspecified address (::)
  if (words.every(w => w === 0)) return true;

  // Loopback (::1)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) return true;

  // IPv4-mapped IPv6 (::ffff:0:0/96)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return isPrivateIpv4(w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff);
  }

  // IPv4-compatible IPv6 (::0:0/96, deprecated RFC 4291)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && (w6 !== 0 || w7 > 1)) {
    return isPrivateIpv4(w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff);
  }

  // 6to4 translation (2002::/16) - embeds IPv4 in w1 and w2
  if (w0 === 0x2002) {
    return isPrivateIpv4(w1 >> 8, w1 & 0xff, w2 >> 8, w2 & 0xff);
  }

  // NAT64 well-known prefix (64:ff9b::/96)
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return isPrivateIpv4(w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff);
  }

  // Unique Local Address ULA (fc00::/7)
  if ((w0 & 0xfe00) === 0xfc00) return true;

  // Link-Local Unicast (fe80::/10)
  if ((w0 & 0xffc0) === 0xfe80) return true;

  // Multicast (ff00::/8)
  if ((w0 & 0xff00) === 0xff00) return true;

  // Discard prefix (100::/64, RFC 6666)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true;

  // Documentation (2001:db8::/32)
  if (w0 === 0x2001 && w1 === 0x0db8) return true;

  // Benchmarking (2001:20::/28)
  if (w0 === 0x2001 && (w1 & 0xfff0) === 0x0020) return true;

  return false;
}

/** True for loopback, RFC1918, link-local, CGNAT, multicast, translated and reserved IPv4/IPv6 ranges or private TLDs. */
function isPrivateAddress(hostname) {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(lower)) return true;

  // Special-use and private TLDs (RFC 6761, RFC 6762, RFC 8375)
  if (
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.lan') ||
    lower.endsWith('.home.arpa') ||
    lower.endsWith('.corp') ||
    lower.endsWith('.invalid') ||
    lower.endsWith('.test') ||
    lower.endsWith('.example')
  ) {
    return true;
  }

  // Single-label hostnames without dots or colons are internal/intranet names
  if (!lower.includes('.') && !lower.includes(':')) {
    return true;
  }

  if (net.isIPv4(lower)) {
    const parts = lower.split('.').map(Number);
    return isPrivateIpv4(parts[0], parts[1], parts[2], parts[3]);
  }

  if (net.isIPv6(lower)) {
    const words = parseIpv6(lower);
    return isPrivateIpv6(words);
  }

  return false;
}

/**
 * Self-hosted merchants legitimately deliver webhooks to a host on their own LAN or loopback,
 * so those are permitted only when explicitly opted in. Without the opt-in, private, loopback
 * and link-local targets (including the cloud metadata endpoint) are refused.
 */
function privateWebhooksAllowed() {
  return process.env.YOUPI_ALLOW_PRIVATE_WEBHOOKS === 'true';
}

/**
 * Validates an operator-supplied outbound webhook URL.
 * Rejects non-HTTP(S) schemes, embedded credentials and — unless explicitly opted in —
 * loopback/private/link-local hosts, so the gateway cannot be pointed at cloud metadata
 * endpoints or its own internal admin/control-plane services (SSRF).
 * @param {string} value
 * @returns {{ valid: boolean, error?: string, url?: URL }}
 */
export function validateOutboundWebhookUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { valid: false, error: 'Webhook URL is required.' };
  if (raw.length > 2048) return { valid: false, error: 'Webhook URL is too long.' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, error: 'Webhook URL must be a valid absolute URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { valid: false, error: 'Webhook URL must use http:// or https://' };
  }
  if (url.username || url.password) {
    return { valid: false, error: 'Webhook URL must not embed credentials.' };
  }
  const hostname = (url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) return { valid: false, error: 'Webhook URL must include a hostname.' };
  if (!privateWebhooksAllowed() && (BLOCKED_HOSTNAMES.has(hostname) || isPrivateAddress(hostname))) {
    return {
      valid: false,
      error: 'Webhook URL must not point to a loopback or private network address (set YOUPI_ALLOW_PRIVATE_WEBHOOKS=true for self-hosted LAN targets).'
    };
  }
  return { valid: true, url };
}

const STATE_WINDOW_MS = 10 * 60 * 1000;
const consumedStates = new Map();

function signStatePayload(payload) {
  return crypto.createHmac('sha256', getObserverToken()).update(`state:${payload}`).digest('hex');
}

/**
 * Creates a signed, expiring OAuth `state` value. Mint it only from an authenticated admin route:
 * the callback accepts nothing that was not minted there, which blocks login-CSRF account linking.
 */
export function createOAuthState() {
  const payload = `${crypto.randomBytes(16).toString('hex')}.${Date.now() + STATE_WINDOW_MS}`;
  return `${payload}.${signStatePayload(payload)}`;
}

/** Verifies signature and expiry, and accepts each state only once (per process). */
export function consumeOAuthState(state) {
  if (typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiresAt, mac] = parts;
  const expectedMac = signStatePayload(`${nonce}.${expiresAt}`);
  if (mac.length !== expectedMac.length || !crypto.timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expectedMac, 'utf8'))) {
    return false;
  }
  const now = Date.now();
  if (!(Number(expiresAt) > now)) return false;
  for (const [key, exp] of consumedStates) if (exp <= now) consumedStates.delete(key);
  if (consumedStates.has(nonce)) return false;
  consumedStates.set(nonce, Number(expiresAt));
  return true;
}
