import fs from 'fs';
import os from 'os';

// Configuration via environment variables with safe defaults
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MIN_FREE_DISK_BYTES = 500 * 1024 * 1024; // 500 MB

function getMaxConcurrentDownloads(): number {
  const parsed = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '', 10);
  return isNaN(parsed) || parsed <= 0 ? DEFAULT_MAX_CONCURRENT : parsed;
}

function getMinFreeDiskBytes(): number {
  const parsed = parseInt(process.env.MIN_FREE_DISK_BYTES || '', 10);
  return isNaN(parsed) || parsed <= 0 ? DEFAULT_MIN_FREE_DISK_BYTES : parsed;
}

// Attach semaphore to globalThis to maintain consistent count during development HMR
interface NexusGlobalState {
  __nexusload_active_downloads?: number;
}

const nexusGlobal = globalThis as unknown as NexusGlobalState;
if (typeof nexusGlobal.__nexusload_active_downloads !== 'number') {
  nexusGlobal.__nexusload_active_downloads = 0;
}

/**
 * Attempts to acquire a concurrent download slot.
 * Returns true if a slot was secured, false if the server is saturated.
 */
export function acquireDownloadSlot(): boolean {
  const max = getMaxConcurrentDownloads();
  const current = nexusGlobal.__nexusload_active_downloads ?? 0;

  if (current >= max) {
    console.warn(`[concurrency] Download slot rejected. Active: ${current}/${max}`);
    return false;
  }

  nexusGlobal.__nexusload_active_downloads = current + 1;
  console.log(`[concurrency] Slot acquired. Active downloads: ${nexusGlobal.__nexusload_active_downloads}/${max}`);
  return true;
}

/**
 * Releases an acquired download slot.
 * Ensures counter never becomes negative. Idempotent guard.
 */
export function releaseDownloadSlot(): void {
  const current = nexusGlobal.__nexusload_active_downloads ?? 0;
  nexusGlobal.__nexusload_active_downloads = Math.max(0, current - 1);
  console.log(
    `[concurrency] Slot released. Active downloads: ${nexusGlobal.__nexusload_active_downloads}/${getMaxConcurrentDownloads()}`
  );
}

/**
 * Returns current active download count.
 */
export function getActiveDownloads(): number {
  return nexusGlobal.__nexusload_active_downloads ?? 0;
}

/**
 * Returns concurrency statistics including active count and maximum allowed.
 */
export function getConcurrencyStats(): { activeDownloads: number; maxConcurrent: number } {
  return {
    activeDownloads: getActiveDownloads(),
    maxConcurrent: getMaxConcurrentDownloads(),
  };
}

/**
 * Inspects available disk space on the temporary storage partition.
 * Returns ok: false if available bytes fall below the safety threshold.
 */
export async function checkDiskSpace(
  minRequiredBytesOverride?: number
): Promise<{ ok: boolean; freeBytes: number; minRequiredBytes: number }> {
  const minRequiredBytes =
    typeof minRequiredBytesOverride === 'number' && minRequiredBytesOverride > 0
      ? minRequiredBytesOverride
      : getMinFreeDiskBytes();
  try {
    const tmpDir = os.tmpdir();
    const stats = await fs.promises.statfs(tmpDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);

    if (freeBytes < minRequiredBytes) {
      console.error(
        `[disk] Critical disk space warning: ${Math.round(freeBytes / 1024 / 1024)}MB free, required: ${Math.round(minRequiredBytes / 1024 / 1024)}MB`
      );
      return { ok: false, freeBytes, minRequiredBytes };
    }

    return { ok: true, freeBytes, minRequiredBytes };
  } catch (err) {
    // If statfs is unsupported or fails, log warning and allow operation with caution
    console.warn('[disk] Failed to query statfs on temp directory:', err);
    return { ok: true, freeBytes: -1, minRequiredBytes };
  }
}
