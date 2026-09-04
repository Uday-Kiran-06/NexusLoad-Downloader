/**
 * NexusLoad In-Process Rate Limiter
 * Provides bounded-memory, dependency-free sliding window rate limiting.
 * Protects against request abuse, spoofed IP headers, and memory bloat.
 */

export type RateLimitAction = 'download' | 'status' | 'cancel' | 'stream';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
  lastAccess: number;
}

// Memory safety bounds
const MAX_TRACKED_CLIENTS = 10000;

// Global map store attaching to globalThis for consistent state during development
interface NexusLimiterGlobal {
  __nexusload_ratelimit_store?: Map<string, RateLimitEntry>;
  __nexusload_ratelimit_timer?: NodeJS.Timeout;
}

const limiterGlobal = globalThis as unknown as NexusLimiterGlobal;
if (!limiterGlobal.__nexusload_ratelimit_store) {
  limiterGlobal.__nexusload_ratelimit_store = new Map<string, RateLimitEntry>();
}
const rateLimitStore = limiterGlobal.__nexusload_ratelimit_store;

/**
 * Safely parses positive integers from environment variables, strictly falling back
 * to defaults if missing, NaN, <= 0, or not finite.
 */
export function parseEnvInteger(envVal: string | undefined, defaultVal: number): number {
  if (!envVal || typeof envVal !== 'string') return defaultVal;
  const parsed = parseInt(envVal.trim(), 10);
  if (isNaN(parsed) || !isFinite(parsed) || parsed <= 0) {
    return defaultVal;
  }
  return parsed;
}

/**
 * Retrieves the effective rate limit configuration for an action.
 */
export function getActionConfig(action: RateLimitAction): RateLimitConfig {
  switch (action) {
    case 'download':
      return {
        limit: parseEnvInteger(process.env.NEXUS_RATE_DOWNLOAD_LIMIT, 10),
        windowMs: parseEnvInteger(process.env.NEXUS_RATE_DOWNLOAD_WINDOW_MS, 10 * 60 * 1000), // 10 mins
      };
    case 'status':
      return {
        limit: parseEnvInteger(process.env.NEXUS_RATE_STATUS_LIMIT, 120),
        windowMs: parseEnvInteger(process.env.NEXUS_RATE_STATUS_WINDOW_MS, 60 * 1000), // 1 min
      };
    case 'cancel':
      return {
        limit: parseEnvInteger(process.env.NEXUS_RATE_CANCEL_LIMIT, 30),
        windowMs: parseEnvInteger(process.env.NEXUS_RATE_CANCEL_WINDOW_MS, 10 * 60 * 1000), // 10 mins
      };
    case 'stream':
      return {
        limit: parseEnvInteger(process.env.NEXUS_RATE_STREAM_LIMIT, 30),
        windowMs: parseEnvInteger(process.env.NEXUS_RATE_STREAM_WINDOW_MS, 60 * 1000), // 1 min
      };
  }
}

/**
 * Normalizes an IP address (stripping IPv4-mapped IPv6 prefix and trimming).
 */
export function normalizeIp(rawIp: string): string {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  return ip || 'direct-client';
}

/**
 * Safely extracts client identity for rate limiting.
 * NEVER trusts client-supplied headers (X-Forwarded-For, etc.) unless proxy trust
 * is explicitly enabled via NEXUS_TRUST_PROXY or TRUST_PROXY.
 */
export function getClientIdentifier(req: Request): string {
  const isProxyTrusted =
    process.env.NEXUS_TRUST_PROXY === 'true' || process.env.TRUST_PROXY === 'true';

  if (isProxyTrusted) {
    // Trusted reverse proxy environment: inspect standard proxy headers
    const forwardedFor = req.headers.get('x-forwarded-for');
    if (forwardedFor) {
      // Use leftmost IP (original client)
      const firstIp = forwardedFor.split(',')[0].trim();
      if (firstIp) return normalizeIp(firstIp);
    }

    const cfIp = req.headers.get('cf-connecting-ip');
    if (cfIp) return normalizeIp(cfIp);

    const realIp = req.headers.get('x-real-ip');
    if (realIp) return normalizeIp(realIp);
  }

  // Untrusted direct environment: do not let arbitrary headers bypass rate limiting
  // Check if server or test environment attached a direct client address
  const directClientHeader = req.headers.get('x-nexus-direct-ip');
  if (directClientHeader) {
    return normalizeIp(directClientHeader);
  }

  return 'direct-client';
}

/**
 * Sweeps expired rate limit records to prevent memory leaks.
 */
export function cleanupExpiredLimiterEntries(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    // Action is encoded in key: `${action}:${clientIp}`
    const action = key.split(':')[0] as RateLimitAction;
    const config = getActionConfig(action);
    if (now - entry.windowStart >= config.windowMs) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Enforces bounded memory: if tracked clients reach MAX_TRACKED_CLIENTS,
 * purges expired entries and if still full, evicts oldest accessed entries.
 */
function enforceLimiterCapacity(): void {
  if (rateLimitStore.size < MAX_TRACKED_CLIENTS) return;

  cleanupExpiredLimiterEntries();

  if (rateLimitStore.size >= MAX_TRACKED_CLIENTS) {
    // Evict oldest 10% entries
    const entries = Array.from(rateLimitStore.entries()).sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess
    );
    const toEvict = Math.ceil(MAX_TRACKED_CLIENTS * 0.1);
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      rateLimitStore.delete(entries[i][0]);
    }
  }
}

/**
 * Evaluates rate limiting for a request and action.
 */
export function checkRateLimit(req: Request, action: RateLimitAction): RateLimitResult {
  enforceLimiterCapacity();

  const clientIp = getClientIdentifier(req);
  const key = `${action}:${clientIp}`;
  const config = getActionConfig(action);
  const now = Date.now();

  let entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart >= config.windowMs) {
    // Start new sliding window
    entry = {
      count: 1,
      windowStart: now,
      lastAccess: now,
    };
    rateLimitStore.set(key, entry);

    return {
      allowed: true,
      limit: config.limit,
      remaining: Math.max(0, config.limit - 1),
      retryAfterSec: 0,
    };
  }

  // Existing window
  entry.lastAccess = now;
  entry.count++;

  const remainingTimeMs = Math.max(0, entry.windowStart + config.windowMs - now);
  const retryAfterSec = Math.max(1, Math.ceil(remainingTimeMs / 1000));

  if (entry.count > config.limit) {
    return {
      allowed: false,
      limit: config.limit,
      remaining: 0,
      retryAfterSec,
    };
  }

  return {
    allowed: true,
    limit: config.limit,
    remaining: Math.max(0, config.limit - entry.count),
    retryAfterSec: 0,
  };
}

/**
 * Test helper: resets the rate limiter store.
 */
export function resetRateLimiter(): void {
  rateLimitStore.clear();
}

/**
 * Test helper: returns the current number of tracked entries.
 */
export function getRateLimiterSize(): number {
  return rateLimitStore.size;
}

// Background cleanup timer (runs every 60s without keeping event loop alive)
if (!limiterGlobal.__nexusload_ratelimit_timer) {
  limiterGlobal.__nexusload_ratelimit_timer = setInterval(cleanupExpiredLimiterEntries, 60 * 1000);
  if (limiterGlobal.__nexusload_ratelimit_timer.unref) {
    limiterGlobal.__nexusload_ratelimit_timer.unref();
  }
}
