import { execFile, ChildProcess, type ExecFileOptions } from 'child_process';
import os from 'os';

const isWin = os.platform() === 'win32';

/**
 * Safe integer parsing for environment configuration variables.
 * Rejects NaN, Infinity, negative numbers, floats, and out-of-bounds values.
 */
export function parseBoundedIntEnv(
  val: string | undefined,
  fallback: number,
  minVal: number,
  maxVal: number
): number {
  if (typeof val !== 'string' || !val.trim()) return fallback;
  const num = Number(val.trim());
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < minVal || num > maxVal) {
    return fallback;
  }
  return num;
}

// Timeout constants & policies (milliseconds)
export const DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS = 180_000; // 3 minutes
export const DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (1,800,000 ms)
export const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (300,000 ms)
export const DEFAULT_DOWNLOAD_ESTIMATED_BPS = 2_500_000; // 2.5 MB/s (~20 Mbps)
export const DOWNLOAD_SAFETY_MULTIPLIER = 2.5;

export function getMinDownloadTimeoutMs(): number {
  return parseBoundedIntEnv(
    process.env.NEXUS_DOWNLOAD_MIN_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS,
    10_000,
    3_600_000
  );
}

export function getMaxDownloadTimeoutMs(): number {
  const min = getMinDownloadTimeoutMs();
  return parseBoundedIntEnv(
    process.env.NEXUS_DOWNLOAD_MAX_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS,
    min,
    7_200_000
  );
}

export function getDownloadStallTimeoutMs(): number {
  return parseBoundedIntEnv(
    process.env.NEXUS_DOWNLOAD_STALL_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
    5_000,
    1_800_000
  );
}

export function getEstimatedDownloadBps(): number {
  return parseBoundedIntEnv(
    process.env.NEXUS_DOWNLOAD_ESTIMATED_BPS,
    DEFAULT_DOWNLOAD_ESTIMATED_BPS,
    50_000,
    1_000_000_000
  );
}

// Safe default timeouts (in milliseconds)
export const TIMEOUT_CONFIG = {
  get MAX_EXTRACTION_TIME() {
    return parseInt(process.env.MAX_EXTRACTION_TIME || '45000', 10);
  },
  get MAX_DOWNLOAD_TIME() {
    return parseInt(process.env.MAX_DOWNLOAD_TIME || '180000', 10);
  },
  get MAX_CONVERSION_TIME() {
    return parseInt(process.env.MAX_CONVERSION_TIME || '90000', 10);
  },
};

/**
 * Calculates a production-safe, size-aware download timeout bounded between
 * MIN_TIMEOUT_MS and MAX_TIMEOUT_MS.
 *
 * Formula:
 * estimatedSeconds = sizeBytes / BYTES_PER_SECOND_ESTIMATE
 * rawTimeoutMs = estimatedSeconds * SAFETY_MULTIPLIER * 1000
 * timeoutMs = min(max(MIN_TIMEOUT_MS, rawTimeoutMs), MAX_TIMEOUT_MS)
 *
 * Safe bounds:
 * - Rejects NaN, Infinity, -Infinity, negative, string, null, undefined, zero -> returns MIN_TIMEOUT_MS
 * - Upper ceiling strictly capped at MAX_TIMEOUT_MS
 */
export function calculateDownloadTimeout(sizeBytes?: unknown): number {
  const minTimeout = getMinDownloadTimeoutMs();
  const maxTimeout = getMaxDownloadTimeoutMs();
  const bps = getEstimatedDownloadBps();

  if (
    typeof sizeBytes !== 'number' ||
    !Number.isFinite(sizeBytes) ||
    isNaN(sizeBytes) ||
    sizeBytes <= 0
  ) {
    return minTimeout;
  }

  const estimatedSeconds = sizeBytes / bps;
  const rawTimeoutMs = estimatedSeconds * DOWNLOAD_SAFETY_MULTIPLIER * 1000;
  const timeoutMs = Math.round(Math.min(Math.max(minTimeout, rawTimeoutMs), maxTimeout));

  return timeoutMs;
}

export type SizeSourceType = 'exact' | 'approximate' | 'combined' | 'unknown';

export interface DownloadTimeoutDetails {
  timeoutMs: number;
  sizeBytes: number | null;
  sizeSource: SizeSourceType;
}

export function getDownloadTimeoutDetails(
  sizeBytes?: unknown,
  sourceHint?: SizeSourceType
): DownloadTimeoutDetails {
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isFinite(sizeBytes) ||
    isNaN(sizeBytes) ||
    sizeBytes <= 0
  ) {
    return {
      timeoutMs: calculateDownloadTimeout(sizeBytes),
      sizeBytes: null,
      sizeSource: 'unknown',
    };
  }

  return {
    timeoutMs: calculateDownloadTimeout(sizeBytes),
    sizeBytes: Math.round(sizeBytes),
    sizeSource: sourceHint || 'exact',
  };
}

/**
 * Platform-aware process tree termination.
 * On Windows: Uses taskkill /T /F to forcibly terminate the entire process tree.
 * On Linux: Sends SIGTERM to process group, escalating to SIGKILL after a grace period.
 */
export function killProcessTree(pid: number | undefined): void {
  // Guard against invalid PID or accidentally killing the parent Node.js process
  if (!pid || pid <= 1 || pid === process.pid) return;

  if (isWin) {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
        if (err && (err as unknown as { code?: number }).code !== 128) {
          // Error code 128 indicates process has already exited
          console.warn(`[process-manager] taskkill on PID ${pid} warning:`, err.message);
        }
      });
    } catch {
      // Ignore failure if process already terminated
    }
  } else {
    // POSIX: Process group termination using negative PID (since spawned with detached: true)
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (err: unknown) {
      // If process group doesn't exist or already exited, fall back to direct PID
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
    }

    // Escalate to SIGKILL after the existing grace period
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already dead
        }
      }
    }, 1500);
  }
}

/**
 * Executes a command with timeout, stall protection, and client abort handling,
 * guaranteeing clean subprocess termination and preventing orphan processes.
 */
export function runCommandWithLifecycle(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    stallTimeoutMs?: number;
    clientSignal?: AbortSignal;
    maxBuffer?: number;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    onProgress?: () => void;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let isTerminated = false;

    const timeoutLimit = typeof options?.timeoutMs === 'number' ? options.timeoutMs : TIMEOUT_CONFIG.MAX_DOWNLOAD_TIME;
    const stallLimit = typeof options?.stallTimeoutMs === 'number' ? options.stallTimeoutMs : 0;
    let lastProgressTimestamp = Date.now();

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (stallTimer) {
        clearInterval(stallTimer);
        stallTimer = null;
      }
      if (options?.clientSignal) {
        options.clientSignal.removeEventListener('abort', onAbort);
      }
    };

    const terminate = (reason: 'timeout' | 'abort' | 'stall') => {
      if (isTerminated) return;
      isTerminated = true;

      const pid = child?.pid;
      if (pid) {
        console.log(`[process-manager] Terminating process tree (PID ${pid}) due to ${reason}`);
        killProcessTree(pid);
      }

      cleanup();

      if (reason === 'timeout') {
        const timeoutErr = Object.assign(
          new Error(`Command exceeded timeout limit of ${timeoutLimit}ms`),
          { code: 'ETIMEDOUT' }
        );
        reject(timeoutErr);
      } else if (reason === 'stall') {
        const stallErr = Object.assign(
          new Error(`Download stalled: no progress received for ${stallLimit}ms`),
          { code: 'ESTALL' }
        );
        reject(stallErr);
      } else {
        const abortErr = Object.assign(
          new Error('Operation aborted by client'),
          { code: 'ECONNABORTED' }
        );
        reject(abortErr);
      }
    };

    const onAbort = () => terminate('abort');

    // Check if client signal is already aborted
    if (options?.clientSignal?.aborted) {
      return terminate('abort');
    }

    if (options?.clientSignal) {
      options.clientSignal.addEventListener('abort', onAbort, { once: true });
    }

    // Set hard ceiling timeout timer
    if (timeoutLimit > 0) {
      timer = setTimeout(() => terminate('timeout'), timeoutLimit);
    }

    // Set progress-aware stall timer
    if (stallLimit > 0) {
      const checkInterval = Math.max(25, Math.min(1000, Math.floor(stallLimit / 2)));
      stallTimer = setInterval(() => {
        if (Date.now() - lastProgressTimestamp >= stallLimit) {
          terminate('stall');
        }
      }, checkInterval);
    }

    // Progress-aware detection: reset stall timer ONLY on actual yt-dlp [download] progress
    // or stream destination initialization, keeping general process output separate.
    const isDownloadProgressLine = (line: string): boolean => {
      return (
        /\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/i.test(line) ||
        /\[download\]\s+Destination:/i.test(line) ||
        /\[download\]\s+100%/i.test(line)
      );
    };

    const registerDownloadProgress = (line: string) => {
      if (isDownloadProgressLine(line)) {
        lastProgressTimestamp = Date.now();
        if (options.onProgress) {
          options.onProgress();
        }
      }
    };

    try {
      child = execFile(
        command,
        args,
        {
          maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
          windowsHide: true,
          detached: !isWin,
        } as ExecFileOptions & { detached?: boolean; windowsHide?: boolean },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          cleanup();
          if (isTerminated) return; // Already rejected via timeout/abort/stall

          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
          } else {
            resolve({
              stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf-8'),
              stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf-8'),
            });
          }
        }
      );

      // Stream stdout lines if requested (splits on \n or \r to handle terminal progress)
      if (child.stdout) {
        let stdoutBuf = '';
        child.stdout.on('data', (chunk: Buffer | string) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split(/[\r\n]+/);
          stdoutBuf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) {
              registerDownloadProgress(line);
              if (options.onStdoutLine) options.onStdoutLine(line);
            }
          }
        });
      }

      // Stream stderr lines if requested
      if (child.stderr) {
        let stderrBuf = '';
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split(/[\r\n]+/);
          stderrBuf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) {
              registerDownloadProgress(line);
              if (options.onStderrLine) options.onStderrLine(line);
            }
          }
        });
      }
    } catch (spawnError) {
      cleanup();
      reject(spawnError);
    }
  });
}

// ── Phase 6.2: Download Speed Optimization & Throughput Observability ──────────

export const DEFAULT_CONCURRENT_FRAGMENTS = 8;
export const MIN_CONCURRENT_FRAGMENTS = 1;
export const MAX_CONCURRENT_FRAGMENTS = 16;

/**
 * Safely parses concurrent fragments setting from environment.
 * Rejects NaN, Infinity, zero, negative numbers, and non-integer strings.
 * Safe default: 8. Capped at 16.
 */
export function getConcurrentFragments(envVal?: string): number {
  const raw = envVal !== undefined ? envVal : process.env.NEXUS_CONCURRENT_FRAGMENTS;
  if (typeof raw !== 'string' || !raw.trim()) {
    return DEFAULT_CONCURRENT_FRAGMENTS;
  }
  const trimmed = raw.trim();
  // Strictly allow only valid integer strings (reject Infinity, NaN, decimals, alphas)
  if (!/^-?\d+$/.test(trimmed)) {
    return DEFAULT_CONCURRENT_FRAGMENTS;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || isNaN(num) || num <= 0) {
    return DEFAULT_CONCURRENT_FRAGMENTS;
  }
  if (num > MAX_CONCURRENT_FRAGMENTS) {
    return MAX_CONCURRENT_FRAGMENTS;
  }
  if (num < MIN_CONCURRENT_FRAGMENTS) {
    return MIN_CONCURRENT_FRAGMENTS;
  }
  return num;
}

export const DEFAULT_DOWNLOAD_BUFFER_SIZE = '4M';
export const SUPPORTED_BUFFER_SIZES = ['512K', '1M', '2M', '4M', '8M', '16M'] as const;
export type SupportedBufferSize = (typeof SUPPORTED_BUFFER_SIZES)[number];

/**
 * Validates and returns yt-dlp buffer size setting.
 * Only accepts whitelisted sizes (512K, 1M, 2M, 4M, 8M, 16M) to prevent CLI injection.
 * Default: '4M'.
 */
export function getDownloadBufferSize(envVal?: string): SupportedBufferSize {
  const raw = envVal !== undefined ? envVal : process.env.NEXUS_DOWNLOAD_BUFFER_SIZE;
  if (typeof raw !== 'string' || !raw.trim()) {
    return DEFAULT_DOWNLOAD_BUFFER_SIZE;
  }
  const normalized = raw.trim().toUpperCase();
  if ((SUPPORTED_BUFFER_SIZES as readonly string[]).includes(normalized)) {
    return normalized as SupportedBufferSize;
  }
  return DEFAULT_DOWNLOAD_BUFFER_SIZE;
}

/**
 * Calculates approximate throughput in bytes/sec and MB/sec.
 */
export function calculateThroughput(
  downloadedBytes: number,
  durationMs: number
): { bytesPerSecond: number; megabytesPerSecond: number } {
  if (!Number.isFinite(downloadedBytes) || downloadedBytes <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { bytesPerSecond: 0, megabytesPerSecond: 0 };
  }
  const seconds = durationMs / 1000;
  const bytesPerSecond = Math.round(downloadedBytes / seconds);
  const megabytesPerSecond = Math.round((bytesPerSecond / (1024 * 1024)) * 100) / 100;
  return { bytesPerSecond, megabytesPerSecond };
}

export interface YtDlpProgressSample {
  percent?: number;
  bytesPerSecond?: number;
  megabytesPerSecond?: number;
  downloadedBytes?: number;
}

/**
 * Parses yt-dlp `--newline` progress lines for percentage, speed, and size.
 */
export function parseYtDlpProgress(
  line: string,
  estimatedTotalBytes?: number
): YtDlpProgressSample | null {
  if (!line || !line.includes('[download]')) return null;

  let percent: number | undefined;
  let bytesPerSecond: number | undefined;
  let megabytesPerSecond: number | undefined;
  let downloadedBytes: number | undefined;

  // Percentage match: e.g. [download]  42.5%
  const pctMatch = line.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/i);
  if (pctMatch) {
    percent = parseFloat(pctMatch[1]);
  }

  // Explicit speed match: e.g. "at  2.50MiB/s", "at 500.00KiB/s", "at 1.20MB/s"
  const speedMatch = line.match(/at\s+([0-9]+(?:\.[0-9]+)?)\s*([KMGTkmgt]i?B|[Bb])\/s/i);
  if (speedMatch) {
    const val = parseFloat(speedMatch[1]);
    const unit = speedMatch[2].toUpperCase();
    let multiplier = 1;
    if (unit.startsWith('K')) multiplier = 1024;
    else if (unit.startsWith('M')) multiplier = 1024 * 1024;
    else if (unit.startsWith('G')) multiplier = 1024 * 1024 * 1024;
    else if (unit.startsWith('T')) multiplier = 1024 * 1024 * 1024 * 1024;

    bytesPerSecond = Math.round(val * multiplier);
    megabytesPerSecond = Math.round((bytesPerSecond / (1024 * 1024)) * 100) / 100;
  }

  // Size match: e.g. "of ~ 100.00MiB" or "of 255.48MiB"
  const sizeMatch = line.match(/of\s+~?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTkmgt]i?B|[Bb])/i);
  if (sizeMatch && percent !== undefined) {
    const val = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toUpperCase();
    let multiplier = 1;
    if (unit.startsWith('K')) multiplier = 1024;
    else if (unit.startsWith('M')) multiplier = 1024 * 1024;
    else if (unit.startsWith('G')) multiplier = 1024 * 1024 * 1024;
    const total = val * multiplier;
    downloadedBytes = Math.round((percent / 100) * total);
  } else if (percent !== undefined && estimatedTotalBytes && estimatedTotalBytes > 0) {
    downloadedBytes = Math.round((percent / 100) * estimatedTotalBytes);
  }

  if (percent === undefined && bytesPerSecond === undefined && downloadedBytes === undefined) {
    return null;
  }

  return { percent, bytesPerSecond, megabytesPerSecond, downloadedBytes };
}
