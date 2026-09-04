import { NextResponse } from 'next/server';
import { getJob, cancelJob, isValidJobId } from '@/lib/job-manager';
import { createFileStreamResponse } from '@/lib/stream-helper';
import { createApiError, ApiErrorCode } from '@/lib/errors';
import { checkRateLimit, getClientIdentifier } from '@/lib/rate-limiter';
import { logOperationalEvent } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'SAMEORIGIN',
};

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

/**
 * GET /api/download/[jobId]
 * Streams the completed file incrementally if ready, or returns job status if in progress.
 */
export async function GET(req: Request, context: RouteContext) {
  const { jobId } = await context.params;

  if (!isValidJobId(jobId)) {
    return createApiError('INVALID_REQUEST', 'Invalid download job capability identifier.', 400);
  }

  const { searchParams } = new URL(req.url);
  const wantsStatus = searchParams.get('status') === 'true';

  // Rate Limiting: separate buckets for polling status vs. file streaming
  const rateLimitAction = wantsStatus ? 'status' : 'stream';
  const rateLimit = checkRateLimit(req, rateLimitAction);
  if (!rateLimit.allowed) {
    logOperationalEvent({
      event: 'rate_limit_rejected',
      clientIp: getClientIdentifier(req),
      jobId,
      reason: `${rateLimitAction} rate limit exceeded.`,
      status: 429,
      limit: rateLimit.limit,
      remaining: rateLimit.remaining,
    });
    return createApiError(
      'RATE_LIMITED',
      `Rate limit exceeded for ${rateLimitAction}. Please retry in ${rateLimit.retryAfterSec} seconds.`,
      429,
      { 'Retry-After': String(rateLimit.retryAfterSec) }
    );
  }

  const job = getJob(jobId);
  if (!job) {
    return createApiError('JOB_NOT_FOUND', 'The requested download job was not found or has expired.', 404);
  }

  // If client explicitly requests status or job is not yet ready, return status payload
  if (wantsStatus) {
    return NextResponse.json(
      {
        jobId: job.id,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        ready: job.status === 'ready',
        error: job.error,
      },
      {
        headers: SECURITY_HEADERS,
      }
    );
  }

  switch (job.status) {
    case 'ready':
      return createFileStreamResponse(req, job);

    case 'queued':
    case 'downloading':
    case 'processing':
      return NextResponse.json(
        {
          jobId: job.id,
          status: job.status,
          stage: job.stage,
          progress: job.progress,
          ready: false,
        },
        {
          status: 202,
          headers: SECURITY_HEADERS,
        }
      );

    case 'failed':
      return createApiError(
        (job.error?.code as ApiErrorCode) || 'DOWNLOAD_FAILED',
        job.error?.message || 'Download failed.',
        500
      );

    case 'cancelled':
      return createApiError('CANCELLED', 'The download job was cancelled.', 410);

    case 'expired':
      return createApiError('JOB_EXPIRED', 'The download job has expired.', 410);

    default:
      return createApiError('INTERNAL_ERROR', 'Unknown job state.', 500);
  }
}

/**
 * DELETE /api/download/[jobId]
 * Explicit user cancellation endpoint. Forcibly terminates subprocesses and cleans files.
 */
export async function DELETE(req: Request, context: RouteContext) {
  const { jobId } = await context.params;

  if (!isValidJobId(jobId)) {
    return createApiError('INVALID_REQUEST', 'Invalid download job capability identifier.', 400);
  }

  // Rate Limiting: cancellation bucket
  const rateLimit = checkRateLimit(req, 'cancel');
  if (!rateLimit.allowed) {
    logOperationalEvent({
      event: 'rate_limit_rejected',
      clientIp: getClientIdentifier(req),
      jobId,
      reason: 'Cancel rate limit exceeded.',
      status: 429,
      limit: rateLimit.limit,
      remaining: rateLimit.remaining,
    });
    return createApiError(
      'RATE_LIMITED',
      `Cancellation rate limit reached. Please retry in ${rateLimit.retryAfterSec} seconds.`,
      429,
      { 'Retry-After': String(rateLimit.retryAfterSec) }
    );
  }

  const result = cancelJob(jobId);
  if (!result.success) {
    return createApiError('JOB_NOT_FOUND', 'Download job not found.', 404);
  }

  return NextResponse.json(
    {
      jobId,
      cancelled: true,
      alreadyTerminal: result.alreadyTerminal || false,
    },
    {
      headers: SECURITY_HEADERS,
    }
  );
}
