import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { validateUrlForDownload, validateAndMapFormat, sanitizeFilename, sanitizeMetadata, parseBoundedJson, SUPPORTED_MP3_BITRATES } from '@/lib/validation';
import { checkDiskSpace } from '@/lib/concurrency';
import { createApiError, ApiErrorCode } from '@/lib/errors';
import { createJob } from '@/lib/job-manager';
import { checkRateLimit, getClientIdentifier } from '@/lib/rate-limiter';
import { logOperationalEvent } from '@/lib/logger';

// Binary path resolution
const isWin = os.platform() === 'win32';
const isProduction = process.env.NODE_ENV === 'production';

const localYtDlp = path.join(
  process.cwd(),
  'node_modules',
  'youtube-dl-exec',
  'bin',
  isWin ? 'yt-dlp.exe' : 'yt-dlp'
);
const ytDlpPath = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';

export const dynamic = 'force-dynamic';

const ALLOWED_DOWNLOAD_KEYS = new Set([
  'url',
  'type',
  'quality',
  'format',
  'formatId',
  'title',
  'bitrate',
  'artist',
  'album',
  'date',
  'sizeBytes',
  'estimatedSizeBytes',
]);

async function handleDownloadJobCreation(
  req: Request,
  params: {
    rawUrl: unknown;
    rawType: unknown;
    rawQuality: unknown;
    rawFormat: unknown;
    rawFormatId?: unknown;
    rawTitle: unknown;
    rawBitrate?: unknown;
    rawArtist?: unknown;
    rawAlbum?: unknown;
    rawDate?: unknown;
    rawSizeBytes?: unknown;
  }
): Promise<NextResponse> {
  // 1. Rate Limiting Check
  const rateLimit = checkRateLimit(req, 'download');
  if (!rateLimit.allowed) {
    logOperationalEvent({
      event: 'rate_limit_rejected',
      clientIp: getClientIdentifier(req),
      reason: 'Download rate limit exceeded.',
      status: 429,
      limit: rateLimit.limit,
      remaining: rateLimit.remaining,
    });
    return createApiError(
      'RATE_LIMITED',
      `Download request limit reached. Please try again in ${rateLimit.retryAfterSec} seconds.`,
      429,
      { 'Retry-After': String(rateLimit.retryAfterSec) }
    );
  }

  // 2. Strict Input Type & Value Validation
  const { rawUrl, rawType, rawQuality, rawFormat, rawFormatId, rawTitle, rawBitrate, rawArtist, rawAlbum, rawDate } = params;

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return createApiError('INVALID_REQUEST', 'Missing or invalid required parameter: url.', 400);
  }
  if (rawUrl.length > 2048) {
    return createApiError('INVALID_URL', 'URL exceeds maximum length of 2048 characters.', 400);
  }

  if (rawType !== undefined && rawType !== null) {
    if (typeof rawType !== 'string' || (rawType !== 'audio' && rawType !== 'video')) {
      return createApiError('INVALID_REQUEST', "Invalid 'type' value. Allowed: 'audio' or 'video'.", 400);
    }
  }

  if (rawFormatId !== undefined && rawFormatId !== null) {
    if (typeof rawFormatId !== 'string') {
      return createApiError('INVALID_REQUEST', "Parameter 'formatId' must be a string.", 400);
    }
    if (rawFormatId.length > 64) {
      return createApiError('INVALID_REQUEST', "Parameter 'formatId' exceeds maximum length of 64 characters.", 400);
    }
  }

  if (rawBitrate !== undefined && rawBitrate !== null) {
    if (typeof rawBitrate !== 'string' || !(SUPPORTED_MP3_BITRATES as readonly string[]).includes(rawBitrate.toLowerCase())) {
      return createApiError(
        'INVALID_FORMAT',
        `Invalid or unsupported MP3 bitrate. Supported: ${SUPPORTED_MP3_BITRATES.join(', ')}.`,
        400
      );
    }
  }

  for (const [name, val, maxLen] of [
    ['title', rawTitle, 500],
    ['artist', rawArtist, 500],
    ['album', rawAlbum, 500],
    ['date', rawDate, 32],
  ] as const) {
    if (val !== undefined && val !== null) {
      if (typeof val !== 'string') {
        return createApiError('INVALID_REQUEST', `Parameter '${name}' must be a string.`, 400);
      }
      if (val.length > maxLen) {
        return createApiError('INVALID_REQUEST', `Parameter '${name}' exceeds maximum length of ${maxLen} characters.`, 400);
      }
    }
  }

  // 3. Server-side URL Validation with DNS-aware SSRF protection
  // PROXY POLICY: Direct downloads reject private/internal IP ranges. Outbound proxy
  // configuration (YT_PROXY / HTTP_PROXY) remains server-administered and untrusted from clients.
  const urlValidation = await validateUrlForDownload(rawUrl);
  if (!urlValidation.valid || !urlValidation.normalizedUrl) {
    logOperationalEvent({
      event: 'ssrf_rejected',
      clientIp: getClientIdentifier(req),
      reason: urlValidation.error || 'SSRF check failed.',
      status: 400,
    });
    return createApiError('INVALID_URL', urlValidation.error || 'Invalid URL provided.', 400);
  }
  const validUrl = urlValidation.normalizedUrl;

  // 4. Format & Quality Validation
  logOperationalEvent({
    event: 'download_format_requested',
    type: typeof rawType === 'string' ? rawType : undefined,
    quality: typeof rawQuality === 'string' ? rawQuality : undefined,
    format: typeof rawFormat === 'string' ? rawFormat : undefined,
    formatId: typeof rawFormatId === 'string' ? rawFormatId : undefined,
    sizeBytes: params.rawSizeBytes ? Number(params.rawSizeBytes) : undefined,
  });

  const formatValidation = validateAndMapFormat({
    type: typeof rawType === 'string' ? rawType : null,
    quality: typeof rawQuality === 'string' ? rawQuality : null,
    format: typeof rawFormat === 'string' ? rawFormat : null,
    formatId: typeof rawFormatId === 'string' ? rawFormatId : null,
    bitrate: typeof rawBitrate === 'string' ? rawBitrate : null,
  });
  if (!formatValidation.valid) {
    return createApiError('INVALID_FORMAT', formatValidation.error || 'Invalid format requested.', 400);
  }

  // 5. Safe Filename and Metadata Handling
  const safeTitle = sanitizeFilename(rawTitle, 'media_download');
  const safeArtist = sanitizeMetadata(rawArtist, 500) || undefined;
  const safeAlbum = sanitizeMetadata(rawAlbum, 500) || undefined;
  const safeDate = sanitizeMetadata(rawDate, 32) || undefined;

  // 6. Proactive Disk Space Check
  const disk = await checkDiskSpace();
  if (!disk.ok) {
    return createApiError(
      'DISK_SPACE',
      'Insufficient temporary storage space on server to process this download.',
      507
    );
  }

  // Parse and validate estimated size if provided
  let estimatedSizeBytes: number | undefined;
  if (params.rawSizeBytes !== undefined && params.rawSizeBytes !== null) {
    const parsedSize = Number(params.rawSizeBytes);
    if (Number.isFinite(parsedSize) && parsedSize > 0 && parsedSize <= 100 * 1024 * 1024 * 1024) {
      estimatedSizeBytes = Math.round(parsedSize);
    }
  }

  // 7. Job Creation & Concurrency Slot Acquisition
  const { job, error } = createJob({
    validUrl,
    formatValidation,
    safeTitle,
    ytDlpPath,
    isProduction,
    estimatedSizeBytes,
    metadata: {
      title: safeTitle,
      artist: safeArtist,
      album: safeAlbum,
      date: safeDate,
    },
  });

  if (error || !job) {
    return createApiError(
      (error?.code as ApiErrorCode) || 'SERVER_BUSY',
      error?.message || 'Server is currently busy. Please try again later.',
      error?.status || 429
    );
  }

  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      downloadUrl: `/api/download/${job.id}`,
      statusUrl: `/api/download/${job.id}/status`,
    },
    {
      status: 202,
      headers: {
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}

/**
 * POST /api/download
 * Creates a background download job with bounded memory execution.
 */
export async function POST(req: Request) {
  // Bounded JSON parsing: rejects oversized body (> 16KB), non-JSON content-types, and malformed syntax early
  const parseResult = await parseBoundedJson<Record<string, unknown>>(req);
  if (parseResult.error) {
    return createApiError(parseResult.error.code, parseResult.error.message, parseResult.error.status);
  }

  const body = parseResult.data || {};

  // Strict allowlist: reject any unexpected / unrecognized parameters
  for (const key of Object.keys(body)) {
    if (!ALLOWED_DOWNLOAD_KEYS.has(key)) {
      return createApiError('INVALID_REQUEST', `Unexpected field '${key}' in request body.`, 400);
    }
  }

  const { searchParams } = new URL(req.url);

  return handleDownloadJobCreation(req, {
    rawUrl: body?.url || searchParams.get('url'),
    rawType: body?.type || searchParams.get('type'),
    rawQuality: body?.quality || searchParams.get('quality'),
    rawFormat: body?.format || searchParams.get('format'),
    rawFormatId: body?.formatId || searchParams.get('formatId'),
    rawTitle: body?.title || searchParams.get('title'),
    rawBitrate: body?.bitrate || searchParams.get('bitrate'),
    rawArtist: body?.artist || searchParams.get('artist'),
    rawAlbum: body?.album || searchParams.get('album'),
    rawDate: body?.date || searchParams.get('date'),
    rawSizeBytes:
      body?.sizeBytes ??
      body?.estimatedSizeBytes ??
      searchParams.get('sizeBytes') ??
      searchParams.get('estimatedSizeBytes'),
  });
}

/**
 * GET /api/download
 * Direct GET route that creates a background download job for backwards compatibility.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // Validate allowed query keys
  for (const key of searchParams.keys()) {
    if (!ALLOWED_DOWNLOAD_KEYS.has(key)) {
      return createApiError('INVALID_REQUEST', `Unexpected query parameter '${key}'.`, 400);
    }
  }

  return handleDownloadJobCreation(req, {
    rawUrl: searchParams.get('url'),
    rawType: searchParams.get('type'),
    rawQuality: searchParams.get('quality'),
    rawFormat: searchParams.get('format'),
    rawFormatId: searchParams.get('formatId'),
    rawTitle: searchParams.get('title'),
    rawBitrate: searchParams.get('bitrate'),
    rawArtist: searchParams.get('artist'),
    rawAlbum: searchParams.get('album'),
    rawDate: searchParams.get('date'),
    rawSizeBytes: searchParams.get('sizeBytes') ?? searchParams.get('estimatedSizeBytes'),
  });
}
