import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ChildProcess, execFile } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';

// Resolve physical absolute path to ffmpeg-static binary to avoid Next.js virtual ROOT path
const localFfmpeg = path.join(
  process.cwd(),
  'node_modules',
  'ffmpeg-static',
  os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
);
export const resolvedFfmpegPath = fs.existsSync(localFfmpeg) ? localFfmpeg : 'ffmpeg';
if (fs.existsSync(localFfmpeg)) {
  ffmpeg.setFfmpegPath(localFfmpeg);
} else {
  ffmpeg.setFfmpegPath('ffmpeg');
}

import { acquireDownloadSlot, releaseDownloadSlot, checkDiskSpace } from './concurrency';
import {
  runCommandWithLifecycle,
  killProcessTree,
  TIMEOUT_CONFIG,
  calculateDownloadTimeout,
  getDownloadTimeoutDetails,
  getDownloadStallTimeoutMs,
  getConcurrentFragments,
  getDownloadBufferSize,
  parseYtDlpProgress,
  DEFAULT_CONCURRENT_FRAGMENTS,
  DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS,
} from './process-manager';
import { safeCleanupDirectory, getCookiesPath, cleanupCookiesFile } from './utils';
import { ValidatedFormat, sanitizeMetadata } from './validation';
import { logOperationalEvent, sanitizeUrlForLogging } from './logger';

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface JobMetrics {
  startTime: number;
  downloadDurationMs?: number;
  processingDurationMs?: number;
  totalDurationMs?: number;
  fileSizeBytes?: number;
  outputThroughputBps?: number;
  lastSpeedBps?: number;
  retryCount: number;
}

export interface DownloadJob {
  id: string; // Cryptographic capability token (192-bit hex)
  status: JobStatus;
  progress: number | null;
  stage: string;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;

  // File metadata upon completion
  filePath?: string;
  fileName: string;
  fileSizeBytes?: number;
  contentType: string;
  actualHeight?: number;
  actualContainer?: string;

  // Size-aware timeout tracking
  estimatedSizeBytes?: number;
  downloadTimeoutMs?: number;

  // Optional media metadata for ID3 tagging
  metadata?: {
    title?: string;
    artist?: string;
    album?: string;
    date?: string;
    duration?: number;
  };

  // Bounded observability metrics
  metrics: JobMetrics;

  // Active stream tracking for TTL race safety
  activeStreams: number;
  cleanupPending: boolean;

  // Working temporary directory
  tmpDir: string;
  slotAcquired: boolean;

  // Cancellation and process tracking
  abortController: AbortController;
  activePid?: number;

  // Error details (sanitized, safe for client)
  error?: {
    code: string;
    message: string;
  };
}

// Global in-memory job store persistent across HMR in dev
interface NexusJobState {
  __nexusload_job_store?: Map<string, DownloadJob>;
  __nexusload_ttl_timer?: NodeJS.Timeout;
}

const nexusGlobal = globalThis as unknown as NexusJobState;
if (!nexusGlobal.__nexusload_job_store) {
  nexusGlobal.__nexusload_job_store = new Map<string, DownloadJob>();
}

export const jobStore = nexusGlobal.__nexusload_job_store;

// Configuration
const DEFAULT_JOB_TTL = 15 * 60 * 1000; // 15 minutes
export const MAX_STORED_JOBS = 100;
export const MAX_DOWNLOAD_RETRIES = 1;

export function getJobTtlMs(): number {
  const parsed = parseInt(process.env.DOWNLOAD_JOB_TTL || '', 10);
  return isNaN(parsed) || parsed <= 0 ? DEFAULT_JOB_TTL : parsed;
}

/**
 * Generates a cryptographically strong 192-bit opaque capability token.
 */
export function generateJobCapabilityId(): string {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Validates whether a value conforms strictly to the 192-bit hex capability identifier format.
 */
export function isValidJobId(jobId: unknown): jobId is string {
  return typeof jobId === 'string' && /^[a-f0-9]{48}$/i.test(jobId);
}

/**
 * Retrieves a job by its capability ID.
 */
export function getJob(jobId: string): DownloadJob | undefined {
  if (!isValidJobId(jobId)) {
    return undefined;
  }
  return jobStore.get(jobId);
}

/**
 * Transitions job status using strict terminal state guards.
 * Prevents race conditions like cancelled -> ready or failed -> ready.
 */
function transitionStatus(job: DownloadJob, nextStatus: JobStatus): boolean {
  const terminalStates: JobStatus[] = ['ready', 'failed', 'cancelled', 'expired'];

  // If already in a terminal failure/cancelled/expired state, never transition to ready
  if (terminalStates.includes(job.status)) {
    if (nextStatus === 'ready' && job.status !== 'ready') {
      console.warn(`[job-manager] Rejecting transition to 'ready' because job is already in terminal state: ${job.status}`);
      return false;
    }
  }

  job.status = nextStatus;
  return true;
}

/**
 * Lightweight MP3 container and frame validation.
 * Checks for ID3v2 tag (bytes 0..2 === "ID3") or MPEG audio frame sync (11 bits set: 0xFF + top 3 bits of byte 1 === 0xE0).
 * Validates layer bits to ensure it is Layer III (MP3) and not reserved.
 */
export function validateMp3Integrity(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < 128) return false;

    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(10);
    try {
      const readBytes = fs.readSync(fd, header, 0, 10, 0);
      if (readBytes < 10) return false;

      let syncOffset = 0;
      // Check ID3v2 tag: "ID3" (0x49 0x44 0x33)
      if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
        // Tag size is stored as 4 synchsafe 7-bit bytes
        const tagSize =
          ((header[6] & 0x7f) << 21) |
          ((header[7] & 0x7f) << 14) |
          ((header[8] & 0x7f) << 7) |
          (header[9] & 0x7f);
        syncOffset = 10 + tagSize;
        // If footer flag is set (bit 4 of byte 5), add 10 bytes footer
        if (header[5] & 0x10) syncOffset += 10;
      }

      if (syncOffset >= stat.size) return false;

      const frameHeader = Buffer.alloc(4);
      const frameRead = fs.readSync(fd, frameHeader, 0, 4, syncOffset);
      if (frameRead < 2) return false;

      // Sync word: 11 bits set to 1 (0xFF and top 3 bits of byte 1)
      if (frameHeader[0] !== 0xff || (frameHeader[1] & 0xe0) !== 0xe0) {
        return false;
      }

      // Layer check: bits 1..2 cannot be 00 (reserved)
      if ((frameHeader[1] & 0x06) === 0x00) {
        return false;
      }

      // Version check: bits 3..4 cannot be 01 (reserved)
      if ((frameHeader[1] & 0x18) === 0x08) {
        return false;
      }

      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Performs lightweight container sanity validation by inspecting magic headers.
 * Validates MP4/M4A ('ftyp' box at bytes 4-7), WebM (EBML header 0x1A 0x45 0xDF 0xA3), and MP3 frames.
 */
export function validateMediaFileIntegrity(
  filePath: string,
  expectedContainer: 'mp4' | 'm4a' | 'webm' | 'mp3'
): boolean {
  if (expectedContainer === 'mp3') {
    return validateMp3Integrity(filePath);
  }

  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < 16) return false;

    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    try {
      fs.readSync(fd, buffer, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }

    if (expectedContainer === 'webm') {
      // WebM EBML header: 0x1A 0x45 0xDF 0xA3
      return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
    }

    if (expectedContainer === 'mp4' || expectedContainer === 'm4a') {
      // ISO BMFF: bytes 4-7 contain "ftyp"
      const magic = buffer.toString('ascii', 4, 8);
      return magic === 'ftyp';
    }

    return false;
  } catch {
    return false;
  }
}

export interface MediaStreamsInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  raw?: string;
}

/**
 * Inspects media streams using FFmpeg banner output without buffering the entire media file into memory.
 * Accurately detects presence of video stream and audio stream, along with their respective codecs.
 */
export function inspectMediaStreams(filePath: string): Promise<MediaStreamsInfo> {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) {
      return resolve({ hasVideo: false, hasAudio: false });
    }
    execFile(
      resolvedFfmpegPath,
      ['-hide_banner', '-i', filePath],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        let hasVideo = false;
        let hasAudio = false;
        let videoCodec: string | undefined;
        let audioCodec: string | undefined;

        const videoMatch = output.match(/Stream #\d+:\d+.*?: Video: ([a-zA-Z0-9_-]+)/i);
        if (videoMatch) {
          hasVideo = true;
          videoCodec = videoMatch[1].toLowerCase();
        }

        const audioMatch = output.match(/Stream #\d+:\d+.*?: Audio: ([a-zA-Z0-9_-]+)/i);
        if (audioMatch) {
          hasAudio = true;
          audioCodec = audioMatch[1].toLowerCase();
        }

        resolve({ hasVideo, hasAudio, videoCodec, audioCodec, raw: output });
      }
    );
  });
}

/**
 * Classifies whether a failure is a transient network/connection error suitable for 1 bounded retry.
 * Explicitly rejects client cancellations, format errors, bot checks, and 403 Forbidden.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string; stderr?: string; stdout?: string };
  const text = `${e.code || ''} ${e.message || ''} ${e.stderr || ''} ${e.stdout || ''}`.toLowerCase();

  // Explicit non-retryable conditions
  if (
    text.includes('econnaborted') ||
    text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('sign in to confirm') ||
    text.includes('bot') ||
    text.includes('private video') ||
    text.includes('403') ||
    text.includes('requested format is not available') ||
    text.includes('unsupported') ||
    text.includes('invalid') ||
    text.includes('exceeded timeout limit')
  ) {
    return false;
  }

  // Transient retryable network errors
  return (
    text.includes('etimedout') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('enotfound') ||
    text.includes('502') ||
    text.includes('503') ||
    text.includes('504') ||
    text.includes('network is unreachable') ||
    text.includes('connection reset') ||
    text.includes('temporary failure in name resolution')
  );
}

/**
 * Safely prunes the oldest finished terminal job that has no active streams.
 * Never prunes active jobs (queued, downloading, processing) or jobs being streamed.
 */
function tryPruneSafeTerminalJobs(): boolean {
  const candidates: string[] = [];
  for (const [id, job] of jobStore.entries()) {
    if (job.activeStreams > 0) continue;
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
      candidates.push(id);
    } else if (job.status === 'ready') {
      if (job.completedAt && Date.now() - job.completedAt > 60000) {
        candidates.push(id);
      }
    }
  }

  if (candidates.length === 0) return false;

  // Sort oldest first
  candidates.sort((a, b) => (jobStore.get(a)?.createdAt || 0) - (jobStore.get(b)?.createdAt || 0));

  const pruneId = candidates[0];
  const targetJob = jobStore.get(pruneId);
  if (targetJob) {
    cleanupJobResources(targetJob);
    jobStore.delete(pruneId);
    return true;
  }
  return false;
}

/**
 * Deletes completed and intermediate files for a job idempotently.
 * Respects activeStreams: if client is actively streaming, defers deletion.
 */
export function cleanupJobResources(job: DownloadJob): void {
  if (job.activeStreams > 0) {
    job.cleanupPending = true;
    console.log(`[job-manager] Cleanup deferred for job ${job.id}: ${job.activeStreams} active stream(s).`);
    return;
  }

  if (job.filePath) {
    try {
      if (fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
    } catch {
      // Ignore
    }
  }

  if (job.tmpDir) {
    safeCleanupDirectory(job.tmpDir);
  }
}

/**
 * Explicit user cancellation. Forcibly aborts subprocesses, cleans temp files,
 * releases concurrency slot, and updates job state to 'cancelled'.
 */
export function cancelJob(jobId: string): { success: boolean; alreadyTerminal?: boolean; error?: string } {
  if (!isValidJobId(jobId)) {
    return { success: false, error: 'INVALID_JOB_ID' };
  }

  const job = getJob(jobId);
  if (!job) {
    return { success: false, error: 'JOB_NOT_FOUND' };
  }

  if (job.status === 'cancelled' || job.status === 'expired') {
    return { success: true, alreadyTerminal: true };
  }

  console.log(`[job-manager] Explicit cancellation requested for job ${job.id}`);
  transitionStatus(job, 'cancelled');
  job.stage = 'Cancelled by user.';

  // Forcibly abort the worker
  job.abortController.abort();
  if (job.activePid) {
    killProcessTree(job.activePid);
  }

  // Release backend concurrency slot immediately
  if (job.slotAcquired) {
    releaseDownloadSlot();
    job.slotAcquired = false;
  }

  cleanupJobResources(job);

  logOperationalEvent({
    event: 'job_cancelled',
    jobId: job.id,
  });

  return { success: true };
}

/**
 * Executes a yt-dlp command with real-time progress parsing and bounded transient network retries.
 */
async function runYtDlpWithRetry(
  job: DownloadJob,
  cmd: string,
  args: string[],
  baseProgress: number,
  progressScale: number
): Promise<{ stdout: string; stderr: string }> {
  let lastSpeedSampleTime = 0;
  const SPEED_SAMPLE_INTERVAL_MS = 5000;

  const onProgressLine = (line: string) => {
    const parsed = parseYtDlpProgress(line, job.estimatedSizeBytes);
    if (parsed?.percent !== undefined && !isNaN(parsed.percent)) {
      const computed = Math.round(baseProgress + (parsed.percent / 100) * progressScale);
      job.progress = Math.min(100, Math.max(0, computed));
      // Refresh TTL while download is actively making progress to prevent premature sweeping of large downloads
      const remainingTimeout = job.downloadTimeoutMs || DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS;
      job.expiresAt = Math.max(job.expiresAt, Date.now() + remainingTimeout + getJobTtlMs());
    }

    if (parsed?.bytesPerSecond !== undefined && parsed.bytesPerSecond > 0) {
      job.metrics.lastSpeedBps = parsed.bytesPerSecond;
      const now = Date.now();
      if (now - lastSpeedSampleTime >= SPEED_SAMPLE_INTERVAL_MS) {
        lastSpeedSampleTime = now;
        logOperationalEvent({
          event: 'download_speed_sample',
          jobId: job.id,
          bytesPerSecond: parsed.bytesPerSecond,
          megabytesPerSecond:
            parsed.megabytesPerSecond ?? Math.round((parsed.bytesPerSecond / (1024 * 1024)) * 100) / 100,
          progressPercent: parsed.percent,
          downloadedBytes: parsed.downloadedBytes,
        });
      }
    }
  };

  const timeoutMs = job.downloadTimeoutMs || calculateDownloadTimeout(job.estimatedSizeBytes);
  const stallTimeoutMs = getDownloadStallTimeoutMs();

  try {
    return await runCommandWithLifecycle(cmd, args, {
      timeoutMs,
      stallTimeoutMs,
      clientSignal: job.abortController.signal,
      onStdoutLine: onProgressLine,
      onStderrLine: onProgressLine,
    });
  } catch (err: unknown) {
    if (job.abortController.signal.aborted || (job.status as JobStatus) === 'cancelled') {
      throw err;
    }

    if (isRetryableNetworkError(err) && job.metrics.retryCount < MAX_DOWNLOAD_RETRIES) {
      job.metrics.retryCount++;
      console.warn(
        `[job-manager] Transient network failure detected on job ${job.id}. Attempting bounded retry (1/${MAX_DOWNLOAD_RETRIES})...`
      );
      job.stage = 'Transient network issue, retrying download (attempt 2)...';

      logOperationalEvent({
        event: 'download_retry',
        jobId: job.id,
        retryCount: job.metrics.retryCount,
      });

      // Adaptive concurrency: on transient network failure, reduce concurrency back toward 8
      const retryArgs = [...args];
      const fragIdx = retryArgs.indexOf('--concurrent-fragments');
      if (fragIdx !== -1 && fragIdx + 1 < retryArgs.length) {
        const currentVal = parseInt(retryArgs[fragIdx + 1], 10);
        if (currentVal > DEFAULT_CONCURRENT_FRAGMENTS) {
          retryArgs[fragIdx + 1] = String(DEFAULT_CONCURRENT_FRAGMENTS);
        }
      }

      // Clean up partial downloads in tmpDir before retrying
      try {
        const partialFiles = fs
          .readdirSync(job.tmpDir)
          .filter((f) => f.endsWith('.part') || f.endsWith('.ytdl'));
        for (const pf of partialFiles) {
          try {
            fs.unlinkSync(path.join(job.tmpDir, pf));
          } catch {}
        }
      } catch {}

      // Safe bounded backoff
      await new Promise((r) => setTimeout(r, 1000));
      if (job.abortController.signal.aborted || (job.status as JobStatus) === 'cancelled') {
        throw err;
      }

      return await runCommandWithLifecycle(cmd, retryArgs, {
        timeoutMs,
        stallTimeoutMs,
        clientSignal: job.abortController.signal,
        onStdoutLine: onProgressLine,
        onStderrLine: onProgressLine,
      });
    }

    throw err;
  }
}

/**
 * Background worker executing yt-dlp download, container checking, and FFmpeg remuxing.
 * Top-level error boundary ensures no unhandled rejections.
 */
export async function executeJobWorker(
  job: DownloadJob,
  validUrl: string,
  formatValidation: ValidatedFormat,
  ytDlpPath: string,
  isProduction: boolean
): Promise<void> {
  const cookiesPath = getCookiesPath();

  try {
    if (job.abortController.signal.aborted || job.status === 'cancelled') {
      return;
    }

    transitionStatus(job, 'downloading');
    job.stage = 'Initializing download streams...';

    // Calculate production-safe size-aware timeout and emit structured event
    const timeoutDetails = getDownloadTimeoutDetails(job.estimatedSizeBytes);
    job.downloadTimeoutMs = timeoutDetails.timeoutMs;
    job.expiresAt = Math.max(job.expiresAt, Date.now() + timeoutDetails.timeoutMs + getJobTtlMs());

    logOperationalEvent({
      event: 'download_timeout_calculated',
      jobId: job.id,
      estimatedSizeBytes: timeoutDetails.sizeBytes,
      calculatedTimeoutMs: timeoutDetails.timeoutMs,
      sizeSource: timeoutDetails.sizeSource,
    });

    logOperationalEvent({
      event: 'download_started',
      jobId: job.id,
    });

    const extractorArgs =
      process.env.YT_EXTRACTOR_ARGS ||
      (isProduction
        ? 'youtube:player_client=default,-android_sdkless'
        : 'youtube:player_client=all');

    const proxy = process.env.YT_PROXY || process.env.HTTP_PROXY || process.env.http_proxy;

    const concurrentFragments = getConcurrentFragments();
    const bufferSize = getDownloadBufferSize();

    const commonCliArgs = [
      '--no-warnings',
      '--extractor-args', extractorArgs,
      '--retries', '10',
      '--fragment-retries', '10',
      '--file-access-retries', '5',
      '--concurrent-fragments', String(concurrentFragments),
      '--buffer-size', bufferSize,
      '--socket-timeout', '30',
      '--newline',
    ];

    if (process.env.NEXUS_USE_ARIA2C === 'true') {
      commonCliArgs.push('--external-downloader', 'aria2c');
      commonCliArgs.push('--external-downloader-args', 'aria2c:-s 16 -x 16 -k 1M');
    }

    if (proxy) commonCliArgs.push('--proxy', proxy);
    if (cookiesPath) commonCliArgs.push('--cookies', cookiesPath);

    if (formatValidation.isAudioOnly) {
      if (formatValidation.isMp3) {
        // ── MP3 Audio Transcoding Pipeline ──────────────────────────────────
        job.stage = 'Downloading native audio source...';
        job.progress = 10;

        const sourceOutputPattern = path.join(job.tmpDir, `${job.id}.source.%(ext)s`);
        const audioArgs = [
          ...commonCliArgs,
          '-o', sourceOutputPattern,
          '-f', formatValidation.audioSelector || 'bestaudio[ext=m4a]/bestaudio/best',
          validUrl,
        ];

        await runYtDlpWithRetry(job, ytDlpPath, audioArgs, 10, 50);

        if ((job.status as JobStatus) === 'cancelled' || job.abortController.signal.aborted) return;

        // Locate downloaded native source file
        const sourceFiles = fs
          .readdirSync(job.tmpDir)
          .filter(
            (f) =>
              f.startsWith(`${job.id}.source.`) &&
              !f.endsWith('.part') &&
              !f.endsWith('.ytdl')
          );

        if (sourceFiles.length === 0) {
          throw Object.assign(new Error('Audio source download completed but output file not found.'), {
            code: 'MP3_OUTPUT_MISSING',
          });
        }

        const sourceAudioPath = path.join(job.tmpDir, sourceFiles[0]);
        const sourceStat = fs.statSync(sourceAudioPath);
        if (sourceStat.size === 0) {
          throw Object.assign(new Error('Downloaded audio source file is empty.'), {
            code: 'MP3_OUTPUT_INVALID',
          });
        }

        // Proactive Disk Space Check for MP3: source size * 2 + 50MB reserve
        const requiredSpace = sourceStat.size * 2 + 50 * 1024 * 1024;
        const diskCheck = await checkDiskSpace(requiredSpace);
        if (!diskCheck.ok) {
          try {
            fs.unlinkSync(sourceAudioPath);
          } catch {}
          throw Object.assign(new Error('Insufficient disk space for MP3 transcoding.'), {
            code: 'DISK_SPACE',
          });
        }

        // Transcoding via FFmpeg
        transitionStatus(job, 'processing');
        job.stage = 'Transcoding audio to MP3...';
        job.progress = 60;

        const targetBitrate = formatValidation.mp3Bitrate || '192k';
        const tempMp3Path = path.join(job.tmpDir, `${job.id}.mp3.tmp`);
        const finalMp3Path = path.join(job.tmpDir, `final_${job.id}.mp3`);
        const finalFileName = `${job.fileName}.mp3`;

        logOperationalEvent({
          event: 'mp3_transcode_started',
          jobId: job.id,
          bitrate: targetBitrate,
        });

        // Metadata extraction & safety
        const metadataArgs: string[] = [];
        const titleVal = job.metadata?.title || job.fileName;
        if (titleVal) {
          const cleanTitle = sanitizeMetadata(titleVal, 500);
          if (cleanTitle) metadataArgs.push('-metadata', `title=${cleanTitle}`);
        }
        if (job.metadata?.artist) {
          const cleanArtist = sanitizeMetadata(job.metadata.artist, 500);
          if (cleanArtist) metadataArgs.push('-metadata', `artist=${cleanArtist}`);
        }
        if (job.metadata?.album) {
          const cleanAlbum = sanitizeMetadata(job.metadata.album, 500);
          if (cleanAlbum) metadataArgs.push('-metadata', `album=${cleanAlbum}`);
        }
        if (job.metadata?.date) {
          const cleanDate = sanitizeMetadata(job.metadata.date, 32);
          if (cleanDate) metadataArgs.push('-metadata', `date=${cleanDate}`);
        }

        const onFfmpegProgressLine = (line: string) => {
          const timeMatch = line.match(/out_time_us=([0-9]+)/);
          if (timeMatch) {
            const outTimeUs = parseInt(timeMatch[1], 10);
            const outTimeSec = outTimeUs / 1000000;
            // Map 60% -> 99% progress
            const transcodePct = Math.min(99, Math.max(60, 60 + Math.round((outTimeSec / 60) * 39)));
            job.progress = transcodePct;
          }
        };

        const ffmpegArgs = [
          '-i', sourceAudioPath,
          '-map', '0:a:0',
          '-vn',
          '-c:a', 'libmp3lame',
          '-b:a', targetBitrate,
          '-id3v2_version', '3',
          '-write_id3v1', '1',
          ...metadataArgs,
          '-progress', 'pipe:1',
          '-nostats',
          '-f', 'mp3',
          '-y',
          tempMp3Path,
        ];

        try {
          await runCommandWithLifecycle(resolvedFfmpegPath, ffmpegArgs, {
            timeoutMs: TIMEOUT_CONFIG.MAX_CONVERSION_TIME,
            clientSignal: job.abortController.signal,
            onStdoutLine: onFfmpegProgressLine,
            onStderrLine: onFfmpegProgressLine,
          });
        } catch (ffmpegErr: unknown) {
          try { if (fs.existsSync(tempMp3Path)) fs.unlinkSync(tempMp3Path); } catch {}
          try { if (fs.existsSync(sourceAudioPath)) fs.unlinkSync(sourceAudioPath); } catch {}

          const errText = `${(ffmpegErr as Error)?.message || ''} ${(ffmpegErr as { stderr?: string })?.stderr || ''}`;
          if (errText.includes('matches no streams') || errText.includes('does not contain any stream')) {
            throw Object.assign(new Error('Audio stream not found in source file.'), { code: 'MP3_NO_AUDIO_STREAM' });
          }
          throw ffmpegErr;
        }

        if ((job.status as JobStatus) === 'cancelled' || job.abortController.signal.aborted) {
          try { if (fs.existsSync(tempMp3Path)) fs.unlinkSync(tempMp3Path); } catch {}
          try { if (fs.existsSync(sourceAudioPath)) fs.unlinkSync(sourceAudioPath); } catch {}
          return;
        }

        // Validate output existence and size
        if (!fs.existsSync(tempMp3Path)) {
          try { if (fs.existsSync(sourceAudioPath)) fs.unlinkSync(sourceAudioPath); } catch {}
          throw Object.assign(new Error('MP3 transcode finished but output file is missing.'), {
            code: 'MP3_OUTPUT_MISSING',
          });
        }

        const tempStat = fs.statSync(tempMp3Path);
        if (tempStat.size === 0) {
          try { fs.unlinkSync(tempMp3Path); } catch {}
          try { if (fs.existsSync(sourceAudioPath)) fs.unlinkSync(sourceAudioPath); } catch {}
          throw Object.assign(new Error('MP3 output file is empty.'), {
            code: 'MP3_OUTPUT_INVALID',
          });
        }

        // Validate MP3 container / sync frames
        const isMp3Valid = validateMp3Integrity(tempMp3Path);
        if (!isMp3Valid) {
          try { fs.unlinkSync(tempMp3Path); } catch {}
          try { if (fs.existsSync(sourceAudioPath)) fs.unlinkSync(sourceAudioPath); } catch {}
          throw Object.assign(new Error('MP3 output validation failed: invalid audio frames or signature.'), {
            code: 'MP3_OUTPUT_INVALID',
          });
        }

        // Atomic finalization
        fs.renameSync(tempMp3Path, finalMp3Path);

        // Delete temporary source audio file
        try {
          if (fs.existsSync(sourceAudioPath)) fs.unlinkSync(sourceAudioPath);
        } catch {}

        const finalStat = fs.statSync(finalMp3Path);

        job.filePath = finalMp3Path;
        job.fileName = finalFileName;
        job.fileSizeBytes = finalStat.size;
        job.contentType = 'audio/mpeg';
        job.actualContainer = 'mp3';
        job.completedAt = Date.now();
        job.expiresAt = Date.now() + getJobTtlMs();
        job.progress = 100;
        job.stage = 'Download ready.';

        const elapsedTotal = Date.now() - job.metrics.startTime;
        job.metrics.totalDurationMs = elapsedTotal;
        job.metrics.fileSizeBytes = finalStat.size;
        job.metrics.outputThroughputBps = Math.round(finalStat.size / Math.max(0.1, elapsedTotal / 1000));

        if (job.slotAcquired) {
          releaseDownloadSlot();
          job.slotAcquired = false;
        }

        transitionStatus(job, 'ready');
        console.log(`[job-manager] Job ${job.id} READY (MP3: ${finalStat.size} bytes, ${targetBitrate}). Concurrency slot released.`);

        logOperationalEvent({
          event: 'mp3_transcode_completed',
          jobId: job.id,
          durationMs: elapsedTotal,
          outputBytes: finalStat.size,
          bitrate: targetBitrate,
        });
        return;
      }

      // ── Native Audio Only Path ──────────────────────────────────────────
      job.stage = 'Downloading audio stream...';
      job.progress = 10;

      const audioOutputPattern = path.join(job.tmpDir, 'audio.%(ext)s');
      const audioArgs = [
        ...commonCliArgs,
        '-o', audioOutputPattern,
        '-f', formatValidation.audioSelector!,
        validUrl,
      ];

      await runYtDlpWithRetry(job, ytDlpPath, audioArgs, 10, 80);

      if ((job.status as JobStatus) === 'cancelled' || job.abortController.signal.aborted) return;

      const files = fs.readdirSync(job.tmpDir).filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
      if (files.length === 0) {
        throw new Error('Audio download completed but output file not found.');
      }

      const tempOut = path.join(job.tmpDir, files[0]);
      const rawExt = path.extname(files[0]).replace('.', '').toLowerCase() || 'm4a';
      const isWebm = rawExt === 'webm' || rawExt === 'opus';
      const containerExt = isWebm ? 'webm' : 'm4a';
      const outputMime = isWebm ? 'audio/webm' : 'audio/mp4';
      const finalFileName = `${job.fileName}.${containerExt}`;
      const finalFilePath = path.join(job.tmpDir, `final_${job.id}.${containerExt}`);

      // Atomic rename to mark final ready file
      fs.renameSync(tempOut, finalFilePath);
      const stat = fs.statSync(finalFilePath);
      if (stat.size === 0) {
        throw new Error('Downloaded audio file is empty.');
      }

      // Container integrity check
      const isContainerValid = validateMediaFileIntegrity(finalFilePath, isWebm ? 'webm' : 'm4a');
      if (!isContainerValid) {
        throw new Error(`Audio container integrity check failed for ${containerExt}.`);
      }

      job.filePath = finalFilePath;
      job.fileName = finalFileName;
      job.fileSizeBytes = stat.size;
      job.contentType = outputMime;
      job.actualContainer = containerExt;
      job.completedAt = Date.now();
      job.expiresAt = Date.now() + getJobTtlMs();
      job.progress = 100;
      job.stage = 'Download ready.';

      // Record final bounded metrics
      const elapsedTotal = Date.now() - job.metrics.startTime;
      job.metrics.downloadDurationMs = elapsedTotal;
      job.metrics.totalDurationMs = elapsedTotal;
      job.metrics.fileSizeBytes = stat.size;
      job.metrics.outputThroughputBps = Math.round(stat.size / Math.max(0.1, elapsedTotal / 1000));

      // Release concurrency slot immediately once file is ready on disk
      if (job.slotAcquired) {
        releaseDownloadSlot();
        job.slotAcquired = false;
      }

      transitionStatus(job, 'ready');
      console.log(`[job-manager] Job ${job.id} READY (Audio: ${stat.size} bytes, ${containerExt}). Concurrency slot released.`);
      return;

    } else {
      // ── Video + Audio Path ───────────────────────────────────────────────
      const targetHeightLabel = formatValidation.isBestQuality ? 'best' : `${formatValidation.height}p`;
      job.stage = `Downloading video stream (${targetHeightLabel})...`;
      job.progress = 10;

      const videoOutputPattern = path.join(job.tmpDir, 'video.%(ext)s');
      const audioOutputPattern = path.join(job.tmpDir, 'audio.%(ext)s');

      const videoArgs = [
        ...commonCliArgs,
        '-o', videoOutputPattern,
        '-f', formatValidation.videoSelector!,
        validUrl,
      ];

      await runYtDlpWithRetry(job, ytDlpPath, videoArgs, 10, 45);

      if ((job.status as JobStatus) === 'cancelled' || job.abortController.signal.aborted) return;

      // 1. Inspect temporary directory after video download completes
      const postVideoFiles = fs
        .readdirSync(job.tmpDir)
        .filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));

      let actualVideoFile: string | null = null;
      let videoStreamInfo: MediaStreamsInfo | null = null;

      // Candidate ordering: prioritize files starting with 'video'
      const videoCandidates = postVideoFiles
        .filter((f) => f.startsWith('video'))
        .concat(postVideoFiles.filter((f) => !f.startsWith('video')));

      for (const file of videoCandidates) {
        const fullPath = path.join(job.tmpDir, file);
        const info = await inspectMediaStreams(fullPath);
        if (info.hasVideo) {
          actualVideoFile = fullPath;
          videoStreamInfo = info;
          break;
        }
      }

      if (!actualVideoFile || !videoStreamInfo?.hasVideo) {
        throw new Error('Video stream download failed: no valid video stream found on disk.');
      }

      console.log(
        `[job-manager] Job ${job.id} verified video file: ${path.basename(actualVideoFile)} (codec: ${videoStreamInfo.videoCodec || 'unknown'})`
      );

      // 2. Check if actualVideoFile ALREADY contains an audio stream
      let actualAudioFile: string | null = null;
      let audioStreamInfo: MediaStreamsInfo | null = null;

      if (videoStreamInfo.hasAudio) {
        console.log(
          `[job-manager] Job ${job.id} video stream already contains audio track (${videoStreamInfo.audioCodec || 'unknown'}).`
        );
        actualAudioFile = actualVideoFile;
        audioStreamInfo = videoStreamInfo;
      } else {
        // Video file does not contain audio; attempt downloading separate audio stream
        job.stage = 'Downloading audio stream...';
        job.progress = 55;

        const audioArgs = [
          ...commonCliArgs,
          '-o', audioOutputPattern,
          '-f', formatValidation.audioSelector!,
          validUrl,
        ];

        try {
          await runYtDlpWithRetry(job, ytDlpPath, audioArgs, 55, 25);
        } catch (audioErr) {
          console.warn(
            `[job-manager] Job ${job.id} audio stream download completed or failed:`,
            audioErr instanceof Error ? audioErr.message : audioErr
          );
        }

        if ((job.status as JobStatus) === 'cancelled' || job.abortController.signal.aborted) return;

        // Inspect temporary directory after audio download completes
        const postAudioFiles = fs
          .readdirSync(job.tmpDir)
          .filter(
            (f) => !f.endsWith('.part') && !f.endsWith('.ytdl') && path.join(job.tmpDir, f) !== actualVideoFile
          );

        // Prioritize files starting with 'audio'
        const audioCandidates = postAudioFiles
          .filter((f) => f.startsWith('audio'))
          .concat(postAudioFiles.filter((f) => !f.startsWith('audio')));

        for (const file of audioCandidates) {
          const fullPath = path.join(job.tmpDir, file);
          const info = await inspectMediaStreams(fullPath);
          if (info.hasAudio && !info.hasVideo) {
            actualAudioFile = fullPath;
            audioStreamInfo = info;
            break;
          }
        }

        // Fallback check among any files with audio
        if (!actualAudioFile) {
          for (const file of audioCandidates) {
            const fullPath = path.join(job.tmpDir, file);
            const info = await inspectMediaStreams(fullPath);
            if (info.hasAudio) {
              actualAudioFile = fullPath;
              audioStreamInfo = info;
              break;
            }
          }
        }
      }

      const downloadEnd = Date.now();
      job.metrics.downloadDurationMs = downloadEnd - job.metrics.startTime;

      const hasAudioTrack = Boolean(actualAudioFile && audioStreamInfo?.hasAudio);
      if (hasAudioTrack) {
        console.log(
          `[job-manager] Job ${job.id} verified audio file: ${path.basename(actualAudioFile!)} (codec: ${audioStreamInfo?.audioCodec || 'unknown'})`
        );
      } else {
        console.log(
          `[job-manager] Job ${job.id} video has no audio stream (silent/muted media). Processing video-only output.`
        );
      }

      // Container compatibility detection
      // Rule: For MP4 requests (default), final output MUST be .mp4 with video/mp4.
      const isVideoWebm = path.extname(actualVideoFile).toLowerCase() === '.webm';
      const isAudioWebm =
        hasAudioTrack &&
        (path.extname(actualAudioFile!).toLowerCase() === '.webm' || audioStreamInfo?.audioCodec === 'opus');
      const requestedWebm = formatValidation.videoSelector?.includes('ext=webm');
      const isWebm = requestedWebm || (isVideoWebm && isAudioWebm && !formatValidation.videoSelector?.includes('ext=mp4'));

      const containerExt = isWebm ? 'webm' : 'mp4';
      const outputMime = isWebm ? 'video/webm' : 'video/mp4';
      const workingMergedFile = path.join(job.tmpDir, `merged_work_${job.id}.${containerExt}`);
      const finalFilePath = path.join(job.tmpDir, `final_${job.id}.${containerExt}`);

      transitionStatus(job, 'processing');
      job.stage = hasAudioTrack
        ? `Merging video and audio into ${containerExt.toUpperCase()}...`
        : `Finalizing ${containerExt.toUpperCase()} video...`;
      job.progress = 85;

      // FFmpeg muxing
      const ffmpegStart = Date.now();
      await new Promise<void>((resolve, reject) => {
        let isDone = false;
        let ffmpegTimer: NodeJS.Timeout | null = null;
        let ffmpegProc: ChildProcess | null = null;

        const onAbort = () => {
          if (isDone) return;
          isDone = true;
          if (ffmpegTimer) clearTimeout(ffmpegTimer);
          try {
            command.kill('SIGKILL');
            if (ffmpegProc?.pid) killProcessTree(ffmpegProc.pid);
          } catch {}
          const err = Object.assign(new Error('FFmpeg conversion aborted by client.'), {
            code: 'ECONNABORTED',
          });
          reject(err);
        };

        if (job.abortController.signal.aborted || (job.status as JobStatus) === 'cancelled') {
          return onAbort();
        }
        job.abortController.signal.addEventListener('abort', onAbort, { once: true });

        if (TIMEOUT_CONFIG.MAX_CONVERSION_TIME > 0) {
          ffmpegTimer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            job.abortController.signal.removeEventListener('abort', onAbort);
            try {
              command.kill('SIGKILL');
              if (ffmpegProc?.pid) killProcessTree(ffmpegProc.pid);
            } catch {}
            const err = Object.assign(
              new Error(`FFmpeg conversion exceeded timeout of ${TIMEOUT_CONFIG.MAX_CONVERSION_TIME}ms.`),
              { code: 'ETIMEDOUT' }
            );
            reject(err);
          }, TIMEOUT_CONFIG.MAX_CONVERSION_TIME);
        }

        const command = ffmpeg();
        command.input(actualVideoFile!);

        const isAudioAac = audioStreamInfo?.audioCodec === 'aac';
        const outputOptions: string[] = [];

        if (!hasAudioTrack) {
          // Video-only (silent / muted media)
          outputOptions.push('-c:v copy');
          if (containerExt === 'mp4') {
            outputOptions.push('-movflags +faststart');
          }
        } else if (actualVideoFile === actualAudioFile) {
          outputOptions.push('-c:v copy');
          if (containerExt === 'mp4') {
            if (isAudioAac) {
              outputOptions.push('-c:a copy');
            } else {
              outputOptions.push('-c:a aac', '-b:a 192k');
            }
            outputOptions.push('-movflags +faststart');
          } else {
            outputOptions.push('-c:a copy');
          }
        } else {
          command.input(actualAudioFile!);
          outputOptions.push('-map 0:v:0', '-map 1:a:0', '-c:v copy');
          if (containerExt === 'mp4') {
            if (isAudioAac) {
              outputOptions.push('-c:a copy');
            } else {
              outputOptions.push('-c:a aac', '-b:a 192k');
            }
            outputOptions.push('-movflags +faststart');
          } else {
            outputOptions.push('-c:a copy');
          }
        }

        command
          .outputOptions(outputOptions)
          .output(workingMergedFile)
          .on('start', () => {
            ffmpegProc = (command as unknown as { ffmpegProc?: ChildProcess }).ffmpegProc || null;
            job.activePid = ffmpegProc?.pid;
          })
          .on('end', () => {
            if (isDone) return;
            isDone = true;
            if (ffmpegTimer) clearTimeout(ffmpegTimer);
            job.abortController.signal.removeEventListener('abort', onAbort);
            resolve();
          })
          .on('error', (err) => {
            if (isDone) return;
            isDone = true;
            if (ffmpegTimer) clearTimeout(ffmpegTimer);
            job.abortController.signal.removeEventListener('abort', onAbort);
            reject(err);
          });

        command.run();
      });

      if ((job.status as JobStatus) === 'cancelled' || job.abortController.signal.aborted) return;

      job.metrics.processingDurationMs = Date.now() - ffmpegStart;

      // Stream verification on working merged file before finalizing
      const finalStreamCheck = await inspectMediaStreams(workingMergedFile);
      if (!finalStreamCheck.hasVideo || (hasAudioTrack && !finalStreamCheck.hasAudio)) {
        try { fs.unlinkSync(workingMergedFile); } catch {}
        throw new Error(
          `Merged media file validation failed: missing required streams (hasVideo: ${finalStreamCheck.hasVideo}, hasAudio: ${finalStreamCheck.hasAudio}).`
        );
      }

      // Atomic rename of finalized output
      fs.renameSync(workingMergedFile, finalFilePath);

      // Clean up intermediate raw stream files immediately to minimize disk usage
      const allFiles = fs.readdirSync(job.tmpDir);
      for (const f of allFiles) {
        const full = path.join(job.tmpDir, f);
        if (full !== finalFilePath && !f.endsWith('.part') && !f.endsWith('.ytdl')) {
          try { fs.unlinkSync(full); } catch {}
        }
      }

      const stat = fs.statSync(finalFilePath);
      if (stat.size === 0) {
        throw new Error('Merged media file is empty.');
      }

      // Container integrity check
      const isContainerValid = validateMediaFileIntegrity(finalFilePath, isWebm ? 'webm' : 'mp4');
      if (!isContainerValid) {
        throw new Error(`Merged media file container integrity check failed for ${containerExt}.`);
      }

      job.filePath = finalFilePath;
      job.fileName = `${job.fileName}.${containerExt}`;
      job.fileSizeBytes = stat.size;
      job.contentType = outputMime;
      job.actualContainer = containerExt;
      job.actualHeight = formatValidation.height;
      job.completedAt = Date.now();
      job.expiresAt = Date.now() + getJobTtlMs();
      job.progress = 100;
      job.stage = 'Download ready.';

      // Record final metrics
      const elapsedTotal = Date.now() - job.metrics.startTime;
      job.metrics.totalDurationMs = elapsedTotal;
      job.metrics.fileSizeBytes = stat.size;
      job.metrics.outputThroughputBps = Math.round(stat.size / Math.max(0.1, elapsedTotal / 1000));

      // Release concurrency slot immediately once file is ready on disk
      if (job.slotAcquired) {
        releaseDownloadSlot();
        job.slotAcquired = false;
      }

      transitionStatus(job, 'ready');
      console.log(`[job-manager] Job ${job.id} READY (${stat.size} bytes, ${containerExt}). Concurrency slot released.`);

      logOperationalEvent({
        event: 'download_completed',
        jobId: job.id,
        durationMs: elapsedTotal,
        outputBytes: stat.size,
        format: containerExt,
      });
    }
  } catch (error: unknown) {
    if ((job.status as JobStatus) === 'cancelled') {
      return;
    }

    const err = error as { code?: string; message?: string };
    console.error(`[job-manager] Worker error on job ${job.id}:`, err?.message || error);

    transitionStatus(job, 'failed');

    if (err?.code === 'ETIMEDOUT') {
      job.error = {
        code: 'DOWNLOAD_TIMEOUT',
        message: 'Download or conversion exceeded maximum execution time.',
      };
    } else if (err?.code === 'ESTALL') {
      job.error = {
        code: 'DOWNLOAD_STALLED',
        message: 'Download stalled: no progress received for configured stall duration.',
      };
    } else if (err?.code === 'ECONNABORTED') {
      job.error = {
        code: 'CANCELLED',
        message: 'Operation was cancelled.',
      };
    } else if (err?.code === 'DISK_SPACE') {
      job.error = {
        code: 'DISK_SPACE',
        message: 'Insufficient temporary storage space on server to process this download.',
      };
    } else if (
      err?.code === 'MP3_NO_AUDIO_STREAM' ||
      err?.code === 'MP3_OUTPUT_INVALID' ||
      err?.code === 'MP3_OUTPUT_MISSING' ||
      err?.code === 'MP3_TRANSCODE_FAILED'
    ) {
      job.error = {
        code: 'CONVERSION_FAILED',
        message: 'Audio conversion to MP3 failed.',
      };
    } else {
      job.error = {
        code: 'DOWNLOAD_FAILED',
        message: 'The download could not be completed.',
      };
    }

    // Always release slot on error
    if (job.slotAcquired) {
      releaseDownloadSlot();
      job.slotAcquired = false;
    }

    cleanupJobResources(job);

    logOperationalEvent({
      event: 'job_failed',
      jobId: job.id,
      reason: job.error?.message,
    });
  } finally {
    cleanupCookiesFile(cookiesPath);
  }
}

/**
 * Creates and registers a new download job. Acquires concurrency slot and starts worker.
 */
export function createJob(params: {
  validUrl: string;
  formatValidation: ValidatedFormat;
  safeTitle: string;
  ytDlpPath: string;
  isProduction: boolean;
  estimatedSizeBytes?: number;
  metadata?: {
    title?: string;
    artist?: string;
    album?: string;
    date?: string;
    duration?: number;
  };
}): { job?: DownloadJob; error?: { code: string; message: string; status: number } } {
  // 1. Job store capacity guard
  if (jobStore.size >= MAX_STORED_JOBS) {
    tryPruneSafeTerminalJobs();
    if (jobStore.size >= MAX_STORED_JOBS) {
      return {
        error: {
          code: 'SERVER_BUSY',
          message: 'Server job capacity limit reached. Active downloads are protected; please try again shortly.',
          status: 503,
        },
      };
    }
  }

  // 2. Concurrency slot acquisition
  if (!acquireDownloadSlot()) {
    return {
      error: {
        code: 'SERVER_BUSY',
        message: 'The server is currently processing the maximum number of concurrent downloads. Please try again shortly.',
        status: 429,
      },
    };
  }

  const id = generateJobCapabilityId();
  const tmpDir = path.join(os.tmpdir(), `ytdl_${Date.now()}_${id}`);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    releaseDownloadSlot();
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create job workspace.',
        status: 500,
      },
    };
  }

  const estimatedTimeoutMs = params.estimatedSizeBytes
    ? calculateDownloadTimeout(params.estimatedSizeBytes)
    : calculateDownloadTimeout(undefined);
  const ttlMs = getJobTtlMs();

  const job: DownloadJob = {
    id,
    status: 'queued',
    progress: 5,
    stage: 'Job queued...',
    createdAt: Date.now(),
    expiresAt: Date.now() + estimatedTimeoutMs + ttlMs,
    fileName: params.safeTitle,
    contentType: params.formatValidation.isMp3
      ? 'audio/mpeg'
      : params.formatValidation.isAudioOnly
      ? 'audio/mp4'
      : 'video/mp4',
    estimatedSizeBytes:
      typeof params.estimatedSizeBytes === 'number' &&
      Number.isFinite(params.estimatedSizeBytes) &&
      params.estimatedSizeBytes > 0
        ? Math.round(params.estimatedSizeBytes)
        : undefined,
    metadata: params.metadata,
    activeStreams: 0,
    cleanupPending: false,
    tmpDir,
    slotAcquired: true,
    abortController: new AbortController(),
    metrics: {
      startTime: Date.now(),
      retryCount: 0,
    },
  };

  jobStore.set(id, job);

  logOperationalEvent({
    event: 'job_created',
    jobId: id,
    urlHost: sanitizeUrlForLogging(params.validUrl),
    format: params.formatValidation.isMp3
      ? 'mp3'
      : params.formatValidation.isAudioOnly
      ? 'audio'
      : 'video',
    bitrate: params.formatValidation.mp3Bitrate,
  });

  // Launch background worker without awaiting it
  executeJobWorker(
    job,
    params.validUrl,
    params.formatValidation,
    params.ytDlpPath,
    params.isProduction
  ).catch((err) => {
    console.error(`[job-manager] Top-level worker rejection on job ${id}:`, err);
  });

  return { job };
}

/**
 * Sweeper running every 60 seconds to clean up expired jobs and stale files.
 */
export function sweepExpiredJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobStore.entries()) {
    try {
      const isActive =
        job.status === 'queued' ||
        job.status === 'downloading' ||
        job.status === 'processing';

      // Active jobs are supervised by runCommandWithLifecycle and must not be swept by static creation TTL
      if (isActive) {
        // Failsafe: only abort if job has genuinely exceeded hard execution ceiling AND expiresAt
        const maxLifetimeMs = (job.downloadTimeoutMs || DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS) + 120_000;
        if (now - job.createdAt > maxLifetimeMs && now > job.expiresAt) {
          console.warn(`[job-manager] Active job ${id} exceeded maximum execution ceiling. Forcing abort.`);
          job.abortController.abort();
          if (job.activePid) {
            killProcessTree(job.activePid);
          }
          transitionStatus(job, 'failed');
          job.error = {
            code: 'DOWNLOAD_TIMEOUT',
            message: 'Download exceeded maximum execution time.',
          };
          if (job.slotAcquired) {
            releaseDownloadSlot();
            job.slotAcquired = false;
          }
          cleanupJobResources(job);
          job.expiresAt = now + 60_000;
        }
        continue;
      }

      if (now > job.expiresAt) {
        if (job.status !== 'expired') {
          console.log(`[job-manager] TTL expired for job ${id}`);
          transitionStatus(job, 'expired');
          if (job.slotAcquired) {
            releaseDownloadSlot();
            job.slotAcquired = false;
          }

          logOperationalEvent({
            event: 'job_expired',
            jobId: id,
          });
        }

        // Check if client is currently streaming
        if (job.activeStreams > 0) {
          job.cleanupPending = true;
        } else {
          cleanupJobResources(job);
          jobStore.delete(id);
        }
      }
    } catch (sweepErr) {
      console.warn(`[job-manager] Error while sweeping job ${id}:`, sweepErr);
    }
  }
}

// Start periodic TTL sweeper if not already running
if (!nexusGlobal.__nexusload_ttl_timer) {
  nexusGlobal.__nexusload_ttl_timer = setInterval(sweepExpiredJobs, 60 * 1000);
  if (nexusGlobal.__nexusload_ttl_timer.unref) {
    nexusGlobal.__nexusload_ttl_timer.unref();
  }
}

