import { NextResponse } from 'next/server';
import { getJob, isValidJobId } from '@/lib/job-manager';
import { createApiError } from '@/lib/errors';
import { checkRateLimit, getClientIdentifier } from '@/lib/rate-limiter';
import { logOperationalEvent } from '@/lib/logger';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{
    jobId: string;
  }>;
}

/**
 * GET /api/download/[jobId]/status
 * Lightweight polling endpoint for download job state and progress.
 */
export async function GET(req: Request, context: RouteContext) {
  const { jobId } = await context.params;

  if (!isValidJobId(jobId)) {
    return createApiError('INVALID_REQUEST', 'Invalid download job capability identifier.', 400);
  }

  // Rate Limiting: status polling bucket
  const rateLimit = checkRateLimit(req, 'status');
  if (!rateLimit.allowed) {
    logOperationalEvent({
      event: 'rate_limit_rejected',
      clientIp: getClientIdentifier(req),
      jobId,
      reason: 'Status polling rate limit exceeded.',
      status: 429,
      limit: rateLimit.limit,
      remaining: rateLimit.remaining,
    });
    return createApiError(
      'RATE_LIMITED',
      `Status polling rate limit exceeded. Please retry in ${rateLimit.retryAfterSec} seconds.`,
      429,
      { 'Retry-After': String(rateLimit.retryAfterSec) }
    );
  }

  const job = getJob(jobId);
  if (!job) {
    return createApiError('JOB_NOT_FOUND', 'The requested download job was not found or has expired.', 404);
  }

  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      ready: job.status === 'ready',
      fileName: job.status === 'ready' ? job.fileName : undefined,
      fileSizeBytes: job.status === 'ready' ? job.fileSizeBytes : undefined,
      downloadUrl: job.status === 'ready' ? `/api/download/${job.id}` : undefined,
      actualHeight: job.status === 'ready' ? job.actualHeight : undefined,
      actualContainer: job.status === 'ready' ? job.actualContainer : undefined,
      metrics: {
        durationMs: job.metrics?.totalDurationMs || (Date.now() - (job.metrics?.startTime || job.createdAt)),
        fileSizeBytes: job.metrics?.fileSizeBytes,
        outputThroughputBps: job.metrics?.outputThroughputBps,
        retryCount: job.metrics?.retryCount || 0,
      },
      error: job.error,
    },
    {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'X-Frame-Options': 'SAMEORIGIN',
      },
    }
  );
}
