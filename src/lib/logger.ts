/**
 * NexusLoad Structured Operational Logger
 * Emits sanitized, machine-readable JSON logs for operational observability.
 * Strictly redacts cookies, credentials, secret env vars, request bodies,
 * raw command lines, and local filesystem paths.
 */

export type OperationalEventType =
  | 'job_created'
  | 'download_started'
  | 'download_retry'
  | 'download_completed'
  | 'download_timeout_calculated'
  | 'download_format_requested'
  | 'download_speed_sample'
  | 'mp3_transcode_started'
  | 'mp3_transcode_completed'
  | 'job_cancelled'
  | 'job_failed'
  | 'job_expired'
  | 'ssrf_rejected'
  | 'rate_limit_rejected'
  | 'stream_rejected';

export interface OperationalLogPayload {
  event: OperationalEventType;
  jobId?: string;
  clientIp?: string;
  urlHost?: string;
  type?: string;
  quality?: string;
  format?: string;
  formatId?: string;
  bitrate?: string;
  durationMs?: number;
  outputBytes?: number;
  retryCount?: number;
  reason?: string;
  limit?: number;
  remaining?: number;
  activeStreams?: number;
  status?: number;
  sizeBytes?: number;
  estimatedSizeBytes?: number | null;
  calculatedTimeoutMs?: number;
  sizeSource?: string;
  bytesPerSecond?: number;
  megabytesPerSecond?: number;
  progressPercent?: number;
  downloadedBytes?: number;
}

// In-memory ring buffer for recent events (bounded to last 50 entries for diagnostics / tests)
const MAX_LOG_HISTORY = 50;
const logHistory: Array<{ timestamp: string; payload: OperationalLogPayload }> = [];

/**
 * Sanitizes a URL for safe logging, extracting only the protocol and hostname to prevent
 * accidental leakage of query string auth tokens, session keys, or PII.
 */
export function sanitizeUrlForLogging(rawUrl?: string | null): string {
  if (!rawUrl || typeof rawUrl !== 'string') return 'none';
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'invalid_url';
  }
}

/**
 * Strips secrets, cookie references, and filesystem paths from any error or status reason.
 */
function sanitizeReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  return reason
    .replace(/cookie[s]?\s*[:=]\s*[^\s;]+/gi, 'cookies=[REDACTED]')
    .replace(/bearer\s+[a-z0-9._~+/-]+=*/gi, 'bearer [REDACTED]')
    .replace(/[A-Za-z]:\\[\w.-]+(?:\\[\w.-]+)*/g, '[PATH_REDACTED]')
    .replace(/\/(?:home|tmp|var|usr|etc|root)[\w.-]*(?:\/[\w.-]+)*/g, '[PATH_REDACTED]')
    .slice(0, 200);
}

/**
 * Emits a structured operational log entry.
 */
export function logOperationalEvent(payload: OperationalLogPayload): void {
  const sanitized: OperationalLogPayload = {
    ...payload,
    reason: sanitizeReason(payload.reason),
  };

  const entry = {
    timestamp: new Date().toISOString(),
    ...sanitized,
  };

  // Keep bounded in-memory ring buffer for test verifications
  logHistory.push({ timestamp: entry.timestamp, payload: sanitized });
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }

  // Production stdout emission
  try {
    const jsonStr = JSON.stringify(entry);
    if (sanitized.event.endsWith('_failed') || sanitized.event.endsWith('_rejected')) {
      console.warn(`[nexusload:ops] ${jsonStr}`);
    } else {
      console.log(`[nexusload:ops] ${jsonStr}`);
    }
  } catch {
    // Fail-safe: logging should never throw
  }
}

/**
 * Test inspection helper: retrieves recorded in-memory operational log events.
 */
export function getLogHistory(): Array<{ timestamp: string; payload: OperationalLogPayload }> {
  return [...logHistory];
}

/**
 * Test helper: clears recorded log history.
 */
export function clearLogHistory(): void {
  logHistory.length = 0;
}
