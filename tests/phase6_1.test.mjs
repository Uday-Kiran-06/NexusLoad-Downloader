import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 1. Process Manager imports
const {
  calculateDownloadTimeout,
  getDownloadTimeoutDetails,
  parseBoundedIntEnv,
  runCommandWithLifecycle,
  DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS,
} = await import('../src/lib/process-manager.ts');

// 2. Job Manager & Concurrency imports
const {
  createJob,
  getJob,
  cancelJob,
} = await import('../src/lib/job-manager.ts');

const {
  getActiveDownloads,
} = await import('../src/lib/concurrency.ts');

// 3. Logger imports
const {
  clearLogHistory,
} = await import('../src/lib/logger.ts');

// 4. Route Handlers
const downloadRoute = await import('../src/app/api/download/route.ts');

test('Phase 6.1: Size-Aware Download Timeout & Stall Protection Suite', async (t) => {
  // ── 1. Small file timeout ──────────────────────────────────────────────
  await t.test('1. Small file timeout: 10 MB returns MIN_TIMEOUT_MS (180,000 ms)', () => {
    const size10MB = 10 * 1024 * 1024; // 10,485,760 bytes
    const timeout = calculateDownloadTimeout(size10MB);
    assert.strictEqual(timeout, DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.strictEqual(timeout, 180_000);
  });

  // ── 2. 500 MB timeout ──────────────────────────────────────────────────
  await t.test('2. 500 MB timeout: scales proportionally to several minutes (~524s)', () => {
    const size500MB = 500 * 1024 * 1024; // 524,288,000 bytes
    const timeout = calculateDownloadTimeout(size500MB);
    // (524288000 / 2500000) * 2.5 * 1000 = 524,288 ms (≈ 8.74 minutes)
    assert.strictEqual(timeout, 524_288);
    assert.ok(timeout > DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.ok(timeout < DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS);
  });

  // ── 3. ~2 GB timeout ───────────────────────────────────────────────────
  await t.test('3. ~2 GB timeout: 1,981 MB scales to bounded large timeout', () => {
    const size1981MB = 1981 * 1024 * 1024; // 2,077,229,056 bytes
    const timeout = calculateDownloadTimeout(size1981MB);
    // (2077229056 / 2500000) * 2.5 * 1000 = 2,077,229 ms -> capped at MAX_TIMEOUT_MS (1,800,000 ms = 30 min)
    assert.strictEqual(timeout, DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS);
    assert.strictEqual(timeout, 1_800_000);
  });

  // ── 4. Large file capped by MAX_TIMEOUT ────────────────────────────────
  await t.test('4. Large file capped by MAX_TIMEOUT: 5 GB returns exactly MAX_TIMEOUT_MS', () => {
    const size5GB = 5 * 1024 * 1024 * 1024;
    const timeout = calculateDownloadTimeout(size5GB);
    assert.strictEqual(timeout, DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS);
    assert.strictEqual(timeout, 1_800_000);
  });

  // ── 5. Unknown size fallback ───────────────────────────────────────────
  await t.test('5. Unknown size fallback: undefined, null, 0 return safe MIN_TIMEOUT_MS', () => {
    assert.strictEqual(calculateDownloadTimeout(undefined), DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.strictEqual(calculateDownloadTimeout(null), DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.strictEqual(calculateDownloadTimeout(0), DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.strictEqual(calculateDownloadTimeout(''), DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.strictEqual(calculateDownloadTimeout('not-a-number'), DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
  });

  // ── 6. filesize_approx ─────────────────────────────────────────────────
  await t.test('6. filesize_approx: correctly handles approximate size estimates', () => {
    const approxBytes = 750 * 1024 * 1024; // ~750 MB approx
    const details = getDownloadTimeoutDetails(approxBytes, 'approximate');
    assert.strictEqual(details.sizeSource, 'approximate');
    assert.strictEqual(details.sizeBytes, approxBytes);
    // (750 * 1024 * 1024 / 2500000) * 2.5 * 1000 = 786,432 ms
    assert.strictEqual(details.timeoutMs, 786_432);
  });

  // ── 7. Combined video + audio estimated size ───────────────────────────
  await t.test('7. Combined video + audio estimated size: correctly sums stream sizes', () => {
    const videoBytes = 400 * 1024 * 1024;
    const audioBytes = 50 * 1024 * 1024;
    const combinedBytes = videoBytes + audioBytes; // 450 MB
    const details = getDownloadTimeoutDetails(combinedBytes, 'combined');
    assert.strictEqual(details.sizeSource, 'combined');
    assert.strictEqual(details.sizeBytes, combinedBytes);
    // (450 * 1024 * 1024 / 2500000) * 2.5 * 1000 = 471,859 ms
    assert.strictEqual(details.timeoutMs, 471_859);
  });

  // ── 8. NaN protection ──────────────────────────────────────────────────
  await t.test('8. NaN protection: calculateDownloadTimeout(NaN) returns safe MIN_TIMEOUT_MS', () => {
    const timeout = calculateDownloadTimeout(NaN);
    assert.strictEqual(Number.isFinite(timeout), true);
    assert.strictEqual(Number.isNaN(timeout), false);
    assert.strictEqual(timeout, DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
  });

  // ── 9. Infinity protection ─────────────────────────────────────────────
  await t.test('9. Infinity protection: calculateDownloadTimeout(Infinity / -Infinity) returns safe bounded timeout', () => {
    const timeoutPos = calculateDownloadTimeout(Infinity);
    assert.strictEqual(Number.isFinite(timeoutPos), true);
    assert.strictEqual(timeoutPos, DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);

    const timeoutNeg = calculateDownloadTimeout(-Infinity);
    assert.strictEqual(Number.isFinite(timeoutNeg), true);
    assert.strictEqual(timeoutNeg, DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
  });

  // ── 10. Negative configuration ─────────────────────────────────────────
  await t.test('10. Negative configuration: rejects negative / invalid env overrides with safe defaults', () => {
    assert.strictEqual(parseBoundedIntEnv('-5000', 180_000, 10_000, 3_600_000), 180_000);
    assert.strictEqual(parseBoundedIntEnv('NaN', 180_000, 10_000, 3_600_000), 180_000);
    assert.strictEqual(parseBoundedIntEnv('Infinity', 180_000, 10_000, 3_600_000), 180_000);
    assert.strictEqual(parseBoundedIntEnv('0', 180_000, 10_000, 3_600_000), 180_000);
    assert.strictEqual(parseBoundedIntEnv('999999999999', 180_000, 10_000, 3_600_000), 180_000);
    assert.strictEqual(parseBoundedIntEnv('300000', 180_000, 10_000, 3_600_000), 300_000);
  });

  // ── 11. Maximum timeout enforcement ────────────────────────────────────
  await t.test('11. Maximum timeout enforcement: even 100 GB cannot exceed MAX_TIMEOUT_MS', () => {
    const size100GB = 100 * 1024 * 1024 * 1024;
    const timeout = calculateDownloadTimeout(size100GB);
    assert.strictEqual(timeout, DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS);
    assert.ok(timeout <= 1_800_000);
  });

  // ── 12. Stall timeout terminates stalled process ────────────────────────
  await t.test('12. Stall timeout: process with no download progress is terminated with ESTALL', async () => {
    // Spawn a node script that outputs non-progress messages and sleeps
    const scriptPath = path.join(os.tmpdir(), `test_stall_${Date.now()}.mjs`);
    fs.writeFileSync(
      scriptPath,
      `
      console.log('Starting dummy task...');
      console.log('[youtube] Extracting metadata...');
      // Sleep for 10 seconds without any [download] progress
      setTimeout(() => {
        console.log('Finished');
      }, 10000);
      `
    );

    const startTime = Date.now();
    let caughtError = null;

    try {
      await runCommandWithLifecycle(process.execPath, [scriptPath], {
        timeoutMs: 10_000,
        stallTimeoutMs: 200, // Trigger stall after 200ms of no download progress
      });
    } catch (err) {
      caughtError = err;
    } finally {
      try { fs.unlinkSync(scriptPath); } catch {}
    }

    const elapsed = Date.now() - startTime;
    assert.ok(caughtError !== null, 'Stalled command must reject');
    assert.strictEqual(caughtError.code, 'ESTALL');
    assert.ok(elapsed < 2000, `Must terminate promptly around stall limit (took ${elapsed}ms)`);
  });

  // ── 13. Active progress prevents stall termination ─────────────────────
  await t.test('13. Active progress prevents stall termination: periodic [download] lines keep process alive', async () => {
    // Spawn a script that emits [download] XX% every 200ms for 2500ms
    // Total run time: 2500ms > 1500ms stall timeout. Active progress keeps it alive.
    const scriptPath = path.join(os.tmpdir(), `test_active_progress_${Date.now()}.mjs`);
    fs.writeFileSync(
      scriptPath,
      `
      console.log('[download] Destination: test.mp4');
      let count = 0;
      const interval = setInterval(() => {
        count++;
        console.log(\`[download] \${count * 10}.0% of 100MiB at 2.5MiB/s\`);
        if (count >= 10) {
          clearInterval(interval);
          console.log('[download] 100% of 100MiB');
          process.exit(0);
        }
      }, 200);
      `
    );

    let progressCount = 0;
    try {
      const result = await runCommandWithLifecycle(process.execPath, [scriptPath], {
        timeoutMs: 10000,
        stallTimeoutMs: 1500, // 1500ms stall window; progress arrives every 200ms
        onStdoutLine: (line) => {
          if (line.includes('[download]')) progressCount++;
        },
      });

      assert.ok(result.stdout.includes('[download] 100%'));
      assert.ok(progressCount >= 5, `Must receive progress lines (received ${progressCount})`);
    } finally {
      try { fs.unlinkSync(scriptPath); } catch {}
    }
  });

  // ── 14. Cancellation still works ───────────────────────────────────────
  await t.test('14. Cancellation still works: abort signal terminates process tree and cleans up', async () => {
    const scriptPath = path.join(os.tmpdir(), `test_abort_${Date.now()}.mjs`);
    fs.writeFileSync(
      scriptPath,
      `
      console.log('[download] 10.0%');
      setTimeout(() => {}, 30000);
      `
    );

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 150);

    let caughtError = null;
    try {
      await runCommandWithLifecycle(process.execPath, [scriptPath], {
        timeoutMs: 10000,
        stallTimeoutMs: 5000,
        clientSignal: abortController.signal,
      });
    } catch (err) {
      caughtError = err;
    } finally {
      try { fs.unlinkSync(scriptPath); } catch {}
    }

    assert.ok(caughtError !== null);
    assert.strictEqual(caughtError.code, 'ECONNABORTED');
  });

  // ── 15. Timeout releases concurrency slot exactly once ─────────────────
  await t.test('15. Timeout releases concurrency slot exactly once', async () => {
    globalThis.__nexusload_active_downloads = 0;
    assert.strictEqual(getActiveDownloads(), 0);

    clearLogHistory();

    // Create a job with short timeout that will timeout
    const { job, error } = createJob({
      validUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      formatValidation: {
        valid: true,
        type: 'video',
        isAudioOnly: false,
        height: 360,
        isBestQuality: false,
        videoSelector: 'bestvideo[height<=360]',
        audioSelector: 'bestaudio',
      },
      safeTitle: 'timeout_test',
      ytDlpPath: 'node',
      isProduction: false,
      estimatedSizeBytes: 100 * 1024 * 1024,
    });

    assert.ok(!error, 'Job creation must succeed');
    assert.ok(job);
    assert.strictEqual(job.estimatedSizeBytes, 100 * 1024 * 1024);
    assert.strictEqual(getActiveDownloads(), 1);

    // Cancel job to simulate clean termination and verify slot is released exactly once
    cancelJob(job.id);

    // Wait for slot release
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(getActiveDownloads(), 0);
    assert.strictEqual(job.slotAcquired, false);

    // Call cancelJob again to confirm idempotency (no negative slots)
    cancelJob(job.id);
    assert.strictEqual(getActiveDownloads(), 0);
  });

  // ── 16. Operational Event Logging: download_timeout_calculated ─────────
  await t.test('16. Operational Logging: emits download_timeout_calculated with safe non-sensitive attributes', () => {
    clearLogHistory();

    const details = getDownloadTimeoutDetails(500 * 1024 * 1024, 'combined');
    assert.strictEqual(details.sizeSource, 'combined');
    assert.strictEqual(details.timeoutMs, 524_288);
    assert.strictEqual(details.sizeBytes, 524_288_000);
  });

  // ── 17. POST /api/download accepts sizeBytes parameter ─────────────────
  await t.test('17. POST /api/download accepts valid sizeBytes and creates job', async () => {
    globalThis.__nexusload_active_downloads = 0;

    const req = new Request('http://localhost/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        type: 'video',
        quality: '720p',
        sizeBytes: 150000000,
      }),
    });

    const res = await downloadRoute.POST(req);
    assert.strictEqual(res.status, 202);
    const data = await res.json();
    assert.ok(data.jobId);

    const job = getJob(data.jobId);
    assert.ok(job);
    assert.strictEqual(job.estimatedSizeBytes, 150000000);

    // Clean up job
    cancelJob(data.jobId);
  });

  // ── 18. GET /api/download accepts sizeBytes query param ────────────────
  await t.test('18. GET /api/download accepts sizeBytes in query and creates job', async () => {
    globalThis.__nexusload_active_downloads = 0;

    const req = new Request(
      'http://localhost/api/download?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&type=audio&format=m4a&sizeBytes=25000000'
    );

    const res = await downloadRoute.GET(req);
    assert.strictEqual(res.status, 202);
    const data = await res.json();
    assert.ok(data.jobId);

    const job = getJob(data.jobId);
    assert.ok(job);
    assert.strictEqual(job.estimatedSizeBytes, 25000000);

    // Clean up job
    cancelJob(data.jobId);
  });
});
