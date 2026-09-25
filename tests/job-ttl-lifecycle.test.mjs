import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  jobStore,
  sweepExpiredJobs,
  createJob,
  getJob,
  getJobTtlMs,
  generateJobCapabilityId,
  cleanupJobResources,
} from '../src/lib/job-manager.ts';

import {
  DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS,
  calculateDownloadTimeout,
} from '../src/lib/process-manager.ts';

import {
  getActiveDownloads,
  acquireDownloadSlot,
  releaseDownloadSlot,
} from '../src/lib/concurrency.ts';

test('Job TTL & Lifecycle Protection Suite', async (t) => {
  // ── 1. createJob calculates initial expiresAt based on estimated size + TTL ──
  await t.test('1. createJob calculates expiresAt using size-aware timeout + TTL', () => {
    // 3 GB file (~3,221,225,472 bytes)
    const threeGb = 3 * 1024 * 1024 * 1024;
    const timeoutMs = calculateDownloadTimeout(threeGb);
    const ttlMs = getJobTtlMs();

    const formatValidation = {
      valid: true,
      isAudioOnly: false,
      isBestQuality: false,
      height: 1080,
      videoSelector: 'bestvideo+bestaudio',
    };

    const res = createJob({
      validUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      formatValidation,
      safeTitle: 'test_large_file',
      estimatedSizeBytes: threeGb,
      ytDlpPath: 'yt-dlp',
      isProduction: false,
    });

    assert.ok(res.job);
    const job = res.job;
    try {
      assert.strictEqual(job.estimatedSizeBytes, threeGb);
      // expiresAt must be at least Date.now() + timeoutMs + ttlMs
      const expectedMinExpiresAt = job.createdAt + timeoutMs + ttlMs - 1000;
      assert.ok(
        job.expiresAt >= expectedMinExpiresAt,
        `Expected expiresAt (${job.expiresAt}) >= expectedMinExpiresAt (${expectedMinExpiresAt})`
      );
    } finally {
      job.abortController.abort();
      if (job.slotAcquired) {
        releaseDownloadSlot();
        job.slotAcquired = false;
      }
      cleanupJobResources(job);
      jobStore.delete(job.id);
    }
  });

  // ── 2. Active in-flight download job is NOT swept by static TTL ───────────
  await t.test('2. Active in-flight download job is NOT swept by sweepExpiredJobs even if past creation TTL', () => {
    const jobId = generateJobCapabilityId();
    const tempDir = path.join(os.tmpdir(), `test_ttl_active_${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    acquireDownloadSlot();
    const job = {
      id: jobId,
      status: 'downloading',
      stage: 'Downloading video stream...',
      progress: 90,
      // Created 20 minutes ago (past default 15 min TTL)
      createdAt: Date.now() - 20 * 60 * 1000,
      // Suppose expiresAt was expired
      expiresAt: Date.now() - 5000,
      fileName: 'active_large_video.mp4',
      contentType: 'video/mp4',
      downloadTimeoutMs: 30 * 60 * 1000, // 30 min budget
      metrics: { startTime: Date.now() - 20 * 60 * 1000, retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: true,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);

    try {
      // Run the sweeper
      sweepExpiredJobs();

      // Job MUST NOT be deleted from jobStore
      const retrieved = getJob(jobId);
      assert.ok(retrieved, 'Active job was preserved in jobStore');
      assert.strictEqual(retrieved.status, 'downloading', 'Job remained in downloading status');
      assert.strictEqual(retrieved.slotAcquired, true, 'Concurrency slot remained acquired');
      assert.ok(fs.existsSync(tempDir), 'Temporary workspace was not deleted');
    } finally {
      job.abortController.abort();
      releaseDownloadSlot();
      cleanupJobResources(job);
      jobStore.delete(jobId);
    }
  });

  // ── 3. Completed ready job has expiresAt reset to completedAt + TTL ────────
  await t.test('3. Completed ready job expiresAt is set to completedAt + TTL', () => {
    const jobId = generateJobCapabilityId();
    const tempDir = path.join(os.tmpdir(), `test_ttl_ready_${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const job = {
      id: jobId,
      status: 'ready',
      stage: 'Download ready.',
      progress: 100,
      createdAt: Date.now() - 20 * 60 * 1000,
      completedAt: Date.now(),
      expiresAt: Date.now() + getJobTtlMs(),
      fileName: 'test_video.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now() - 20 * 60 * 1000, retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: false,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);

    try {
      // Sweeper runs while expiresAt is still in the future
      sweepExpiredJobs();
      assert.ok(getJob(jobId), 'Ready job within TTL was not swept');

      // Now simulate TTL expiration for this ready job
      job.expiresAt = Date.now() - 1000;
      sweepExpiredJobs();
      assert.strictEqual(getJob(jobId), undefined, 'Ready job past TTL was swept cleanly');
    } finally {
      cleanupJobResources(job);
      jobStore.delete(jobId);
    }
  });

  // ── 4. Zombie active job exceeding hard execution ceiling is safely aborted ──
  await t.test('4. Zombie active job exceeding hard ceiling is aborted and slot released', () => {
    const jobId = generateJobCapabilityId();
    const tempDir = path.join(os.tmpdir(), `test_ttl_zombie_${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const initialActive = getActiveDownloads();
    acquireDownloadSlot();
    assert.strictEqual(getActiveDownloads(), initialActive + 1);

    const job = {
      id: jobId,
      status: 'downloading',
      stage: 'Downloading...',
      progress: 50,
      // Created 35 minutes ago, exceeds 30m ceiling + 2m buffer
      createdAt: Date.now() - 35 * 60 * 1000,
      downloadTimeoutMs: 30 * 60 * 1000,
      expiresAt: Date.now() - 5000,
      fileName: 'zombie_video.mp4',
      contentType: 'video/mp4',
      metrics: { startTime: Date.now() - 35 * 60 * 1000, retryCount: 0 },
      activeStreams: 0,
      cleanupPending: false,
      tmpDir: tempDir,
      slotAcquired: true,
      abortController: new AbortController(),
    };

    jobStore.set(jobId, job);

    try {
      sweepExpiredJobs();

      // Job should be aborted and marked failed
      assert.strictEqual(job.status, 'failed');
      assert.strictEqual(job.slotAcquired, false);
      assert.strictEqual(getActiveDownloads(), initialActive, 'Slot was released on zombie abort');
      assert.strictEqual(job.abortController.signal.aborted, true, 'AbortController was triggered');
      assert.strictEqual(job.error?.code, 'DOWNLOAD_TIMEOUT');
    } finally {
      cleanupJobResources(job);
      jobStore.delete(jobId);
    }
  });
});
