import fs from 'fs';
import { NextResponse } from 'next/server';
import { DownloadJob, cleanupJobResources, jobStore } from './job-manager';
import { createApiError } from './errors';
import { logOperationalEvent } from './logger';
import { parseEnvInteger } from './rate-limiter';

// Stream concurrency bounds
const MAX_STREAMS_PER_JOB = parseEnvInteger(process.env.NEXUS_MAX_STREAMS_PER_JOB, 10);
const MAX_SERVER_STREAMS = parseEnvInteger(process.env.NEXUS_MAX_SERVER_STREAMS, 50);

interface NexusStreamGlobal {
  __nexusload_global_active_streams?: number;
}
const streamGlobal = globalThis as unknown as NexusStreamGlobal;
if (typeof streamGlobal.__nexusload_global_active_streams !== 'number') {
  streamGlobal.__nexusload_global_active_streams = 0;
}

export function getGlobalActiveStreams(): number {
  return streamGlobal.__nexusload_global_active_streams ?? 0;
}

/**
 * Creates an incremental streaming response for a ready job.
 * Enforces bounded memory (no full-file buffer), active stream reference counting,
 * stream abuse prevention, and HTTP Range (206 Partial Content) support.
 */
export function createFileStreamResponse(req: Request, job: DownloadJob): NextResponse {
  if (!job.filePath || !fs.existsSync(job.filePath)) {
    return createApiError('INTERNAL_ERROR', 'The requested media file is no longer available.', 404);
  }

  // Stream abuse protection: reject if per-job or server-wide stream limits are reached
  if (job.activeStreams >= MAX_STREAMS_PER_JOB) {
    logOperationalEvent({
      event: 'stream_rejected',
      jobId: job.id,
      activeStreams: job.activeStreams,
      reason: 'Maximum concurrent streams for job reached.',
      status: 429,
    });
    return createApiError(
      'SERVER_BUSY',
      'Too many concurrent download streams for this job. Please wait for an active stream to complete.',
      429
    );
  }

  if (getGlobalActiveStreams() >= MAX_SERVER_STREAMS) {
    logOperationalEvent({
      event: 'stream_rejected',
      jobId: job.id,
      activeStreams: getGlobalActiveStreams(),
      reason: 'Maximum server-wide active streams reached.',
      status: 503,
    });
    return createApiError(
      'SERVER_BUSY',
      'Server is currently processing maximum concurrent streams. Please try again shortly.',
      503
    );
  }

  let totalSize = 0;
  try {
    const stat = fs.statSync(job.filePath);
    totalSize = stat.size;
  } catch {
    return createApiError('INTERNAL_ERROR', 'Failed to inspect media file.', 500);
  }

  if (totalSize === 0) {
    return createApiError('INTERNAL_ERROR', 'Media file is empty.', 500);
  }

  // Parse HTTP Range header if present
  const rangeHeader = req.headers.get('range');
  let start = 0;
  let end = totalSize - 1;
  let isRangeRequest = false;

  if (rangeHeader && rangeHeader.startsWith('bytes=')) {
    const parts = rangeHeader.replace('bytes=', '').trim().split('-');
    if (parts.length !== 2) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const rawStart = parts[0]?.trim();
    const rawEnd = parts[1]?.trim();

    if (!rawStart && !rawEnd) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    if (rawStart && rawEnd) {
      start = parseInt(rawStart, 10);
      end = parseInt(rawEnd, 10);
    } else if (rawStart && !rawEnd) {
      start = parseInt(rawStart, 10);
      end = totalSize - 1;
    } else if (!rawStart && rawEnd) {
      // Suffix range e.g. -500 (last 500 bytes)
      const suffixLength = parseInt(rawEnd, 10);
      if (isNaN(suffixLength) || suffixLength <= 0) {
        return new NextResponse(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${totalSize}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }
      start = Math.max(0, totalSize - suffixLength);
      end = totalSize - 1;
    }

    // Validate range bounds
    if (isNaN(start) || isNaN(end) || start < 0 || end >= totalSize || start > end) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    isRangeRequest = true;
  }

  const chunkLength = end - start + 1;

  // Stream reference counting for stream/TTL race protection
  job.activeStreams++;
  streamGlobal.__nexusload_global_active_streams = (streamGlobal.__nexusload_global_active_streams ?? 0) + 1;
  let isCleanedUp = false;

  const onStreamFinished = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    job.activeStreams = Math.max(0, job.activeStreams - 1);
    streamGlobal.__nexusload_global_active_streams = Math.max(
      0,
      (streamGlobal.__nexusload_global_active_streams ?? 1) - 1
    );
    if (job.cleanupPending && job.activeStreams === 0) {
      console.log(`[stream-helper] Active streams reached 0 for expired job ${job.id}. Cleaning up.`);
      cleanupJobResources(job);
      jobStore.delete(job.id);
    }
  };

  const nodeStream = fs.createReadStream(job.filePath, { start, end });
  const iterator = nodeStream[Symbol.asyncIterator]();

  let isPulling = false;
  let isCancelled = false;
  let isErrored = false;
  let isClosed = false;

  // Web ReadableStream wrapper providing incremental pull-based backpressured streaming
  const webStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (isCancelled || isErrored || isClosed) {
        return;
      }
      // Guard: prevent multiple concurrent calls from executing iterator.next() simultaneously
      if (isPulling) {
        return;
      }
      isPulling = true;

      try {
        const { value, done } = await iterator.next();
        if (isCancelled || isErrored || isClosed) {
          return;
        }

        if (done) {
          isClosed = true;
          onStreamFinished();
          controller.close();
          return;
        }

        if (value) {
          const buf = typeof value === 'string' ? Buffer.from(value) : value;
          controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        }
      } catch (err) {
        if (!isCancelled && !isClosed && !isErrored) {
          isErrored = true;
          console.warn(`[stream-helper] Node stream error on job ${job.id}:`, (err as Error)?.message);
          onStreamFinished();
          try {
            nodeStream.destroy();
          } catch {
            // Ignore error on destroy
          }
          controller.error(err);
        }
      } finally {
        isPulling = false;
      }
    },
    async cancel() {
      if (isCancelled) return;
      isCancelled = true;
      try {
        if (typeof iterator.return === 'function') {
          await iterator.return();
        }
      } catch {
        // Ignore iterator cancel error
      }
      try {
        nodeStream.destroy();
      } catch {
        // Ignore destroy error
      }
      onStreamFinished();
    },
  });

  // RFC-5987 / ASCII-safe filename formatting
  const asciiFileName = job.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const encodedFileName = encodeURIComponent(job.fileName);

  const headers = new Headers();
  headers.set('Content-Type', job.contentType || 'application/octet-stream');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(chunkLength));
  headers.set(
    'Content-Disposition',
    `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-Frame-Options', 'SAMEORIGIN');

  if (isRangeRequest) {
    headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    return new NextResponse(webStream as unknown as ReadableStream, {
      status: 206,
      headers,
    });
  }

  return new NextResponse(webStream as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}
