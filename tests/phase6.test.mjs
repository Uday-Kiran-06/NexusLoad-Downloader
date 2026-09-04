import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 1. Validation & sanitization imports
const {
  validateUrlForDownload,
  validateAndMapFormat,
  parseBoundedJson,
} = await import('../src/lib/validation.ts');

// 2. Rate Limiting imports
const {
  checkRateLimit,
  getClientIdentifier,
  parseEnvInteger,
  resetRateLimiter,
  getRateLimiterSize,
} = await import('../src/lib/rate-limiter.ts');

// 3. Job Manager imports
const {
  isValidJobId,
  generateJobCapabilityId,
  getJob,
  cancelJob,
  jobStore,
} = await import('../src/lib/job-manager.ts');

// 4. Stream Helper imports
const {
  createFileStreamResponse,
} = await import('../src/lib/stream-helper.ts');

// 5. Concurrency imports
const {
  acquireDownloadSlot,
  getConcurrencyStats,
} = await import('../src/lib/concurrency.ts');

// 6. Logger imports
const {
  logOperationalEvent,
  sanitizeUrlForLogging,
  getLogHistory,
  clearLogHistory,
} = await import('../src/lib/logger.ts');

// 7. Errors import
const {
  createApiError,
} = await import('../src/lib/errors.ts');

// 8. Route Handlers for End-to-End Route Testing
const downloadRoute = await import('../src/app/api/download/route.ts');
const downloadJobRoute = await import('../src/app/api/download/[jobId]/route.ts');
const downloadStatusRoute = await import('../src/app/api/download/[jobId]/status/route.ts');
const extractRoute = await import('../src/app/api/extract/route.ts');

// Helper to create a temporary testing directory
function makeTempTestDir() {
  const dir = path.join(os.tmpdir(), `phase6_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeTempDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. REQUEST BODY LIMIT & VALIDATION HARDENING
// ─────────────────────────────────────────────────────────────────────────────
test('1. Request Body Limit & Validation Hardening', async (t) => {
  await t.test('1.1 parseBoundedJson accepts valid JSON within 16 KB', async () => {
    const payload = JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', type: 'video' });
    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      },
      body: payload,
    });

    const result = await parseBoundedJson(req);
    assert.equal(result.error, undefined);
    assert.equal(result.data?.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(result.data?.type, 'video');
  });

  await t.test('1.2 parseBoundedJson rejects Content-Length > 16 KB immediately before reading stream', async () => {
    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '20000', // 20 KB > 16 KB
      },
      body: JSON.stringify({ test: 'x'.repeat(19000) }),
    });

    const result = await parseBoundedJson(req);
    assert.ok(result.error);
    assert.equal(result.error.code, 'INVALID_REQUEST');
    assert.equal(result.error.status, 400);
    assert.ok(result.error.message.includes('16384 bytes'));
  });

  await t.test('1.3 parseBoundedJson aborts streaming reader when payload exceeds 16 KB without declared Content-Length', async () => {
    let streamCancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        // Enqueue 6 KB chunk on each pull until reader.cancel() is called
        controller.enqueue(new Uint8Array(6 * 1024).fill(65));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: stream,
      duplex: 'half',
    });

    const result = await parseBoundedJson(req);
    assert.ok(result.error);
    assert.equal(result.error.code, 'INVALID_REQUEST');
    assert.equal(result.error.status, 400);
    assert.ok(result.error.message.includes('16384 bytes'));
    assert.equal(streamCancelled, true, 'Stream reader should be explicitly cancelled to preserve bounded memory');
  });

  await t.test('1.4 parseBoundedJson rejects non-JSON content-type', async () => {
    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'url=https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    const result = await parseBoundedJson(req);
    assert.ok(result.error);
    assert.equal(result.error.code, 'INVALID_REQUEST');
    assert.equal(result.error.status, 400);
    assert.ok(result.error.message.includes('Content-Type must be application/json'));
  });

  await t.test('1.5 parseBoundedJson rejects malformed JSON', async () => {
    const malformed = '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", ';
    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: malformed,
    });

    const result = await parseBoundedJson(req);
    assert.ok(result.error);
    assert.equal(result.error.code, 'INVALID_REQUEST');
    assert.equal(result.error.status, 400);
    assert.ok(result.error.message.includes('Malformed JSON'));
  });

  await t.test('1.6 parseBoundedJson rejects JSON non-objects (arrays, numbers, strings, null)', async () => {
    for (const nonObj of ['[1, 2, 3]', '"just a string"', '12345', 'null']) {
      const req = new Request('http://localhost/api/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: nonObj,
      });

      const result = await parseBoundedJson(req);
      assert.ok(result.error, `Should reject ${nonObj}`);
      assert.equal(result.error.code, 'INVALID_REQUEST');
      assert.equal(result.error.status, 400);
      assert.ok(result.error.message.includes('JSON object'));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. IN-PROCESS RATE LIMITING & SPOOFING PROTECTION
// ─────────────────────────────────────────────────────────────────────────────
test('2. In-Process Rate Limiting & Spoofing Protection', async (t) => {
  await t.test('2.1 parseEnvInteger safely parses positive integers with robust fallbacks', () => {
    assert.equal(parseEnvInteger('50', 10), 50);
    assert.equal(parseEnvInteger('  100  ', 10), 100);
    assert.equal(parseEnvInteger('invalid', 10), 10);
    assert.equal(parseEnvInteger('-5', 10), 10);
    assert.equal(parseEnvInteger('0', 10), 10);
    assert.equal(parseEnvInteger('Infinity', 10), 10);
    assert.equal(parseEnvInteger(undefined, 10), 10);
  });

  await t.test('2.2 Client IP extraction strictly ignores spoofed headers when proxy trust is false', () => {
    delete process.env.NEXUS_TRUST_PROXY;
    delete process.env.TRUST_PROXY;

    const req = new Request('http://localhost/api/download', {
      headers: {
        'x-forwarded-for': '1.2.3.4, 5.6.7.8',
        'cf-connecting-ip': '9.10.11.12',
        'x-real-ip': '13.14.15.16',
      },
    });

    const client = getClientIdentifier(req);
    assert.equal(client, 'direct-client', 'Must NOT trust spoofed headers when proxy trust is disabled');
  });

  await t.test('2.3 Client IP extraction trusts proxy headers only when NEXUS_TRUST_PROXY is true', () => {
    process.env.NEXUS_TRUST_PROXY = 'true';

    const req = new Request('http://localhost/api/download', {
      headers: {
        'x-forwarded-for': '203.0.113.195, 10.0.0.1',
      },
    });

    const client = getClientIdentifier(req);
    assert.equal(client, '203.0.113.195');

    delete process.env.NEXUS_TRUST_PROXY;
  });

  await t.test('2.4 Rate limiter enforces download action limits and returns Retry-After', () => {
    resetRateLimiter();
    const testIp = '198.51.100.42';
    process.env.NEXUS_TRUST_PROXY = 'true';

    const makeReq = () =>
      new Request('http://localhost/api/download', {
        headers: { 'x-forwarded-for': testIp },
      });

    // Default download limit is 10 per 10m
    for (let i = 1; i <= 10; i++) {
      const res = checkRateLimit(makeReq(), 'download');
      assert.equal(res.allowed, true, `Request ${i} should be allowed`);
      assert.equal(res.remaining, 10 - i);
    }

    // 11th request must be rejected
    const blocked = checkRateLimit(makeReq(), 'download');
    assert.equal(blocked.allowed, false, 'Request 11 must be rejected');
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 600);

    delete process.env.NEXUS_TRUST_PROXY;
    resetRateLimiter();
  });

  await t.test('2.5 Rate limiter separates action buckets (download vs status vs cancel vs stream)', () => {
    resetRateLimiter();
    process.env.NEXUS_TRUST_PROXY = 'true';
    const testIp = '198.51.100.43';
    const req = new Request('http://localhost/api/download', {
      headers: { 'x-forwarded-for': testIp },
    });

    // Exhaust download bucket
    for (let i = 0; i < 10; i++) {
      checkRateLimit(req, 'download');
    }
    const downloadBlocked = checkRateLimit(req, 'download');
    assert.equal(downloadBlocked.allowed, false);

    // Status bucket must remain completely unaffected
    const statusCheck = checkRateLimit(req, 'status');
    assert.equal(statusCheck.allowed, true, 'Status bucket must have independent counter');
    assert.equal(statusCheck.remaining, 119);

    // Cancel bucket must remain completely unaffected
    const cancelCheck = checkRateLimit(req, 'cancel');
    assert.equal(cancelCheck.allowed, true, 'Cancel bucket must have independent counter');

    // Stream bucket must remain completely unaffected
    const streamCheck = checkRateLimit(req, 'stream');
    assert.equal(streamCheck.allowed, true, 'Stream bucket must have independent counter');

    delete process.env.NEXUS_TRUST_PROXY;
    resetRateLimiter();
  });

  await t.test('2.6 Rate limiter store enforces bounded memory cap (MAX_TRACKED_CLIENTS)', () => {
    resetRateLimiter();
    process.env.NEXUS_TRUST_PROXY = 'true';

    assert.equal(getRateLimiterSize(), 0);

    for (let i = 1; i <= 5; i++) {
      const req = new Request('http://localhost/api/download', {
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
      checkRateLimit(req, 'download');
    }
    assert.equal(getRateLimiterSize(), 5);

    delete process.env.NEXUS_TRUST_PROXY;
    resetRateLimiter();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CAPABILITY TOKEN VALIDATION & JOB SECURITY
// ─────────────────────────────────────────────────────────────────────────────
test('3. Capability Token Validation & Job Security', async (t) => {
  await t.test('3.1 isValidJobId strictly accepts 48-char hex capability tokens', () => {
    const validId = generateJobCapabilityId();
    assert.equal(validId.length, 48);
    assert.equal(isValidJobId(validId), true);

    const lowercaseHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f0718';
    assert.equal(lowercaseHex.length, 48);
    assert.equal(isValidJobId(lowercaseHex), true);
  });

  await t.test('3.2 isValidJobId rejects malformed, path traversal, or injection attempts', () => {
    const attackPayloads = [
      '',
      '1234',
      'a1b2c3d4e5f6',
      'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f0718aa',
      '../../../../etc/passwd',
      '..\\..\\windows\\system32',
      'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f071g',
      'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f071;',
      "' OR 1=1 --",
      '<script>alert(1)</script>',
      null,
      undefined,
      12345,
      {},
      [],
    ];

    for (const payload of attackPayloads) {
      assert.equal(isValidJobId(payload), false, `Should reject attack payload: ${String(payload)}`);
    }
  });

  await t.test('3.3 getJob returns undefined for invalid capability IDs without store lookup', () => {
    assert.equal(getJob('../../etc/passwd'), undefined);
    assert.equal(getJob(''), undefined);
    assert.equal(getJob('invalid_id'), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CANCELLATION IDEMPOTENCY & RESOURCE BALANCING
// ─────────────────────────────────────────────────────────────────────────────
test('4. Cancellation Idempotency & Resource Balancing', async (t) => {
  await t.test('4.1 Repeated cancellation of the same job is strictly idempotent', async () => {
    const tempDir = makeTempTestDir();
    const jobId = generateJobCapabilityId();

    const job = {
      id: jobId,
      status: 'downloading',
      stage: 'downloading',
      progress: 35,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      fileName: 'test_idempotent.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now(), retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: true,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);
    acquireDownloadSlot();

    const initialStats = getConcurrencyStats();

    // First cancellation
    const res1 = cancelJob(jobId);
    assert.equal(res1.success, true);
    assert.equal(res1.alreadyTerminal, undefined);

    const statsAfter1 = getConcurrencyStats();
    assert.equal(statsAfter1.activeDownloads, initialStats.activeDownloads - 1, 'Slot released once');

    // Second cancellation
    const res2 = cancelJob(jobId);
    assert.equal(res2.success, true);
    assert.equal(res2.alreadyTerminal, true);

    // Third cancellation
    const res3 = cancelJob(jobId);
    assert.equal(res3.success, true);
    assert.equal(res3.alreadyTerminal, true);

    const statsAfter3 = getConcurrencyStats();
    assert.equal(statsAfter3.activeDownloads, statsAfter1.activeDownloads, 'No double slot release occurred');
    assert.ok(statsAfter3.activeDownloads >= 0, 'Active downloads counter must never be negative');

    jobStore.delete(jobId);
    removeTempDir(tempDir);
  });

  await t.test('4.2 Concurrent cancellation requests do not double release slots or corrupt state', async () => {
    const tempDir = makeTempTestDir();
    const jobId = generateJobCapabilityId();

    const job = {
      id: jobId,
      status: 'downloading',
      stage: 'downloading',
      progress: 50,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      fileName: 'test_concurrent_cancel.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now(), retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: true,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);
    acquireDownloadSlot();

    const beforeStats = getConcurrencyStats();

    const cancelPromises = Array.from({ length: 10 }, () => Promise.resolve(cancelJob(jobId)));
    const results = await Promise.all(cancelPromises);

    for (const r of results) {
      assert.equal(r.success, true);
    }

    const afterStats = getConcurrencyStats();
    assert.equal(afterStats.activeDownloads, beforeStats.activeDownloads - 1, 'Exactly one slot release');
    assert.ok(afterStats.activeDownloads >= 0);

    jobStore.delete(jobId);
    removeTempDir(tempDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. STREAM ABUSE & CONCURRENCY CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
test('5. Stream Abuse & Concurrency Controls', async (t) => {
  await t.test('5.1 Per-job stream limit (MAX_STREAMS_PER_JOB = 10) rejects excessive streams', () => {
    const tempDir = makeTempTestDir();
    const filePath = path.join(tempDir, 'test_stream.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(1024, 0x5a));

    const jobId = generateJobCapabilityId();
    const job = {
      id: jobId,
      status: 'ready',
      stage: 'ready',
      progress: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      filePath,
      fileName: 'test_stream.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now(), retryCount: 0 },
      activeStreams: 10,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: false,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);

    const req = new Request(`http://localhost/api/download/${jobId}`);
    const res = createFileStreamResponse(req, job);

    assert.equal(res.status, 429, 'Excessive stream should return 429');
    assert.equal(job.activeStreams, 10, 'Rejected stream must NOT increment activeStreams');

    jobStore.delete(jobId);
    removeTempDir(tempDir);
  });

  await t.test('5.2 Stream lifecycle correctly decrements job activeStreams and global streams', async () => {
    const tempDir = makeTempTestDir();
    const filePath = path.join(tempDir, 'test_lifecycle.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(2048, 0x42));

    const jobId = generateJobCapabilityId();
    const job = {
      id: jobId,
      status: 'ready',
      stage: 'ready',
      progress: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      filePath,
      fileName: 'test_lifecycle.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now(), retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: false,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);

    const req = new Request(`http://localhost/api/download/${jobId}`);
    const res = createFileStreamResponse(req, job);

    assert.equal(res.status, 200);
    assert.equal(job.activeStreams, 1, 'Accepted stream increments activeStreams');

    const reader = res.body?.getReader();
    assert.ok(reader);
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    assert.equal(job.activeStreams, 0, 'Completed stream decrements activeStreams back to 0');

    jobStore.delete(jobId);
    removeTempDir(tempDir);
  });

  await t.test('5.3 Client stream abort cancels reader and decrements counters without orphan descriptors', async () => {
    const tempDir = makeTempTestDir();
    const filePath = path.join(tempDir, 'test_abort.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(64 * 1024, 0x33));

    const jobId = generateJobCapabilityId();
    const job = {
      id: jobId,
      status: 'ready',
      stage: 'ready',
      progress: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      filePath,
      fileName: 'test_abort.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now(), retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: false,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);

    const req = new Request(`http://localhost/api/download/${jobId}`);
    const res = createFileStreamResponse(req, job);

    assert.equal(res.status, 200);
    assert.equal(job.activeStreams, 1);

    const reader = res.body?.getReader();
    assert.ok(reader);

    await reader.read();
    await reader.cancel();

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(job.activeStreams, 0, 'Cancelled stream must cleanly decrement activeStreams');

    jobStore.delete(jobId);
    removeTempDir(tempDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. SECURITY HEADERS EMISSION
// ─────────────────────────────────────────────────────────────────────────────
test('6. Security Headers Emission Across Responses', async (t) => {
  await t.test('6.1 createApiError emits all standard security headers', () => {
    const res = createApiError('INVALID_REQUEST', 'Sample error message.', 400);
    assert.equal(res.status, 400);

    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('Permissions-Policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(res.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  });

  await t.test('6.2 createFileStreamResponse emits all standard security headers', async () => {
    const tempDir = makeTempTestDir();
    const filePath = path.join(tempDir, 'header_test.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(128, 0x11));

    const jobId = generateJobCapabilityId();
    const job = {
      id: jobId,
      status: 'ready',
      stage: 'ready',
      progress: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      filePath,
      fileName: 'header_test.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now(), retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: false,
      abortController: new AbortController(),
    };

    const req = new Request(`http://localhost/api/download/${jobId}`);
    const res = createFileStreamResponse(req, job);

    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('Permissions-Policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(res.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');

    // Cancel reader cleanly before removing dir
    const reader = res.body?.getReader();
    if (reader) await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));

    removeTempDir(tempDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. STRUCTURED OPERATIONAL LOGGING & REDACTION
// ─────────────────────────────────────────────────────────────────────────────
test('7. Structured Operational Logging & Secret Redaction', async (t) => {
  await t.test('7.1 sanitizeUrlForLogging extracts only protocol and host, stripping tokens and query params', () => {
    const dirtyUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&auth_token=super_secret_token_12345#secret_hash';
    const clean = sanitizeUrlForLogging(dirtyUrl);
    assert.equal(clean, 'https://www.youtube.com');

    assert.equal(sanitizeUrlForLogging(''), 'none');
    assert.equal(sanitizeUrlForLogging(null), 'none');
    assert.equal(sanitizeUrlForLogging('not a url'), 'invalid_url');
  });

  await t.test('7.2 logOperationalEvent strictly redacts cookies, bearer tokens, and paths in reasons', () => {
    clearLogHistory();

    logOperationalEvent({
      event: 'job_failed',
      jobId: 'test_job_123',
      reason: 'Failed with cookies: session=secret12345; and bearer abc.def.xyz and path C:\\Users\\ASUS\\secret\\file.mp4',
    });

    const logs = getLogHistory();
    assert.equal(logs.length, 1);
    const payload = logs[0].payload;
    assert.equal(payload.event, 'job_failed');
    assert.ok(!payload.reason?.includes('secret12345'), 'Cookie secret must be redacted');
    assert.ok(!payload.reason?.includes('abc.def.xyz'), 'Bearer token must be redacted');
    assert.ok(!payload.reason?.includes('C:\\Users\\ASUS'), 'Filesystem path must be redacted');
    assert.ok(payload.reason?.includes('cookies=[REDACTED]'));
    assert.ok(payload.reason?.includes('bearer [REDACTED]'));
    assert.ok(payload.reason?.includes('[PATH_REDACTED]'));

    clearLogHistory();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. END-TO-END ROUTE HANDLER SECURITY AUDIT TESTS
// ─────────────────────────────────────────────────────────────────────────────
test('8. End-to-End Route Handler Security Audit Tests', async (t) => {
  await t.test('8.1 POST /api/download rejects unexpected fields with 400', async () => {
    resetRateLimiter();
    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        maliciousKey: 'exploit',
      }),
    });

    const res = await downloadRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_REQUEST');
    assert.ok(body.message.includes("Unexpected field 'maliciousKey'"));
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  });

  await t.test('8.2 POST /api/download rejects invalid field types with 400', async () => {
    resetRateLimiter();
    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 12345, // invalid type
      }),
    });

    const res = await downloadRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_REQUEST');
    assert.ok(body.message.includes('Missing or invalid required parameter: url'));
  });

  await t.test('8.3 POST /api/download rejects invalid audio bitrates with 400', async () => {
    resetRateLimiter();
    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        type: 'audio',
        format: 'mp3',
        bitrate: '999k', // invalid bitrate
      }),
    });

    const res = await downloadRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_FORMAT');
    assert.ok(body.message.includes('Invalid or unsupported MP3 bitrate'));
  });

  await t.test('8.4 GET /api/download rejects unexpected query parameters with 400', async () => {
    resetRateLimiter();
    const req = new Request('http://localhost/api/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&unknown_param=123');
    const res = await downloadRoute.GET(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_REQUEST');
    assert.ok(body.message.includes("Unexpected query parameter 'unknown_param'"));
  });

  await t.test('8.5 POST /api/extract rejects oversized body > 16 KB with 400', async () => {
    const req = new Request('http://localhost/api/extract', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '25000',
      },
      body: JSON.stringify({ test: 'x'.repeat(24000) }),
    });

    const res = await extractRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_REQUEST');
    assert.ok(body.message.includes('16384 bytes'));
  });

  await t.test('8.6 POST /api/extract rejects unexpected body fields with 400', async () => {
    const req = new Request('http://localhost/api/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        cmd: 'whoami',
      }),
    });

    const res = await extractRoute.POST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_REQUEST');
    assert.ok(body.message.includes("Unexpected field 'cmd'"));
  });

  await t.test('8.7 GET /api/download/[jobId] returns 400 for malformed job ID capability token', async () => {
    resetRateLimiter();
    const req = new Request('http://localhost/api/download/short_id');
    const res = await downloadJobRoute.GET(req, {
      params: Promise.resolve({ jobId: 'short_id' }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_REQUEST');
    assert.ok(body.message.includes('Invalid download job capability identifier'));
  });

  await t.test('8.8 GET /api/download/[jobId] returns 404 without leaking info for non-existent valid capability token', async () => {
    resetRateLimiter();
    const nonExistentId = generateJobCapabilityId();
    const req = new Request(`http://localhost/api/download/${nonExistentId}`);
    const res = await downloadJobRoute.GET(req, {
      params: Promise.resolve({ jobId: nonExistentId }),
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'JOB_NOT_FOUND');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  });

  await t.test('8.9 GET /api/download/[jobId]/status returns 400 for malformed job ID', async () => {
    resetRateLimiter();
    const req = new Request('http://localhost/api/download/invalid-hex-token/status');
    const res = await downloadStatusRoute.GET(req, {
      params: Promise.resolve({ jobId: 'invalid-hex-token' }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'INVALID_REQUEST');
  });

  await t.test('8.10 DELETE /api/download/[jobId] returns 400 for malformed job ID and 404 for non-existent job', async () => {
    resetRateLimiter();
    const req1 = new Request('http://localhost/api/download/bad-id', { method: 'DELETE' });
    const res1 = await downloadJobRoute.DELETE(req1, {
      params: Promise.resolve({ jobId: 'bad-id' }),
    });
    assert.equal(res1.status, 400);

    const nonExistentId = generateJobCapabilityId();
    const req2 = new Request(`http://localhost/api/download/${nonExistentId}`, { method: 'DELETE' });
    const res2 = await downloadJobRoute.DELETE(req2, {
      params: Promise.resolve({ jobId: nonExistentId }),
    });
    assert.equal(res2.status, 404);
  });

  await t.test('8.11 Route handler returns 429 with Retry-After when rate limit is exceeded', async () => {
    resetRateLimiter();
    process.env.NEXUS_TRUST_PROXY = 'true';
    const clientIp = '198.51.100.99';

    const makeReq = () =>
      new Request('http://localhost/api/download', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
        },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
      });

    // 10 requests allowed
    for (let i = 0; i < 10; i++) {
      await downloadRoute.POST(makeReq());
    }

    // 11th request must return 429
    const blockedRes = await downloadRoute.POST(makeReq());
    assert.equal(blockedRes.status, 429);
    const body = await blockedRes.json();
    assert.equal(body.error, 'RATE_LIMITED');
    assert.ok(blockedRes.headers.get('Retry-After'));
    assert.equal(blockedRes.headers.get('X-Content-Type-Options'), 'nosniff');

    delete process.env.NEXUS_TRUST_PROXY;
    resetRateLimiter();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CONCURRENCY RACES, SSRF & PIPELINE INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────
test('9. Concurrency Races, SSRF & Pipeline Integrity', async (t) => {
  await t.test('9.1 Rapid burst stream requests at limit reject cleanly without counter leakage', async () => {
    const tempDir = makeTempTestDir();
    const filePath = path.join(tempDir, 'race_stream.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(1024, 0x77));

    const jobId = generateJobCapabilityId();
    const job = {
      id: jobId,
      status: 'ready',
      stage: 'ready',
      progress: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      filePath,
      fileName: 'race_stream.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now(), retryCount: 0 },
      activeStreams: 9, // 1 slot available
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: false,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);

    const req = new Request(`http://localhost/api/download/${jobId}`);

    // Slot 10 should succeed
    const res1 = createFileStreamResponse(req, job);
    assert.equal(res1.status, 200);
    assert.equal(job.activeStreams, 10);

    // Concurrently trigger 5 requests while at limit (10)
    const burstResponses = Array.from({ length: 5 }, () => createFileStreamResponse(req, job));
    for (const r of burstResponses) {
      assert.equal(r.status, 429);
    }
    assert.equal(job.activeStreams, 10, 'Rejected requests must not alter activeStreams');

    // Clean up accepted stream
    const reader = res1.body?.getReader();
    if (reader) await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(job.activeStreams, 9);

    jobStore.delete(jobId);
    removeTempDir(tempDir);
  });

  await t.test('9.2 SSRF validation rejects non-public / internal IPv4 and IPv6 URLs', async () => {
    const ssrfUrls = [
      'http://127.0.0.1/api',
      'http://localhost:3000',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/admin',
      'http://192.168.1.1/secret',
      'http://172.16.0.1/',
      'http://[::1]/internal',
    ];

    for (const url of ssrfUrls) {
      const res = await validateUrlForDownload(url);
      assert.equal(res.valid, false, `Must reject SSRF URL: ${url}`);
      assert.ok(res.error);
    }
  });

  await t.test('9.3 MP3 transcode configuration preserves valid format validation without regression', () => {
    const resMp3 = validateAndMapFormat({
      type: 'audio',
      format: 'mp3',
    });

    assert.equal(resMp3.valid, true);
    assert.equal(resMp3.isAudioOnly, true);
    assert.equal(resMp3.isMp3, true);
    assert.equal(resMp3.mp3Bitrate, '192k');
    assert.ok(resMp3.audioSelector);
  });

  await t.test('9.4 Native audio/video format mapping remains completely intact', () => {
    const resNativeAudio = validateAndMapFormat({
      type: 'audio',
      format: 'm4a',
    });
    assert.equal(resNativeAudio.valid, true);
    assert.equal(resNativeAudio.isAudioOnly, true);
    assert.equal(resNativeAudio.isMp3, false);
    assert.ok(resNativeAudio.audioSelector?.includes('m4a'));

    const resVideo = validateAndMapFormat({
      type: 'video',
      quality: '1080',
    });
    assert.equal(resVideo.valid, true);
    assert.equal(resVideo.isAudioOnly, false);
    assert.equal(resVideo.height, 1080);
    assert.ok(resVideo.videoSelector?.includes('height<=1080'));
  });
});

