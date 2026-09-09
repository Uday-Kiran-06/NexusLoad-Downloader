import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONCURRENT_FRAGMENTS,
  MAX_CONCURRENT_FRAGMENTS,
  getConcurrentFragments,
  DEFAULT_DOWNLOAD_BUFFER_SIZE,
  SUPPORTED_BUFFER_SIZES,
  getDownloadBufferSize,
  calculateThroughput,
  parseYtDlpProgress,
  getDownloadTimeoutDetails,
  DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS,
  runCommandWithLifecycle,
} from '../src/lib/process-manager.ts';

import {
  acquireDownloadSlot,
  releaseDownloadSlot,
  getActiveDownloads,
} from '../src/lib/concurrency.ts';

import {
  validateAndMapFormat,
  validateUrl,
  isPrivateOrNonPublicIp,
} from '../src/lib/validation.ts';

test('Phase 6.2: Download Speed Optimization & Regression Suite', async (t) => {
  // ── 1. Default concurrent fragments = 8 ──────────────────────────────────
  await t.test('1. Default concurrent fragments = 8 when unset or empty', () => {
    assert.strictEqual(getConcurrentFragments(undefined), 8);
    assert.strictEqual(getConcurrentFragments(''), 8);
    assert.strictEqual(getConcurrentFragments('   '), 8);
    assert.strictEqual(DEFAULT_CONCURRENT_FRAGMENTS, 8);
  });

  // ── 2. Valid NEXUS_CONCURRENT_FRAGMENTS configuration ───────────────────
  await t.test('2. Valid NEXUS_CONCURRENT_FRAGMENTS configuration parses integer correctly', () => {
    assert.strictEqual(getConcurrentFragments('4'), 4);
    assert.strictEqual(getConcurrentFragments('12'), 12);
    assert.strictEqual(getConcurrentFragments('16'), 16);
    assert.strictEqual(getConcurrentFragments('1'), 1);
  });

  // ── 3. Invalid configuration fallback ────────────────────────────────────
  await t.test('3. Invalid configuration fallback to default 8', () => {
    assert.strictEqual(getConcurrentFragments('invalid'), 8);
    assert.strictEqual(getConcurrentFragments('foo123'), 8);
    assert.strictEqual(getConcurrentFragments('8.5'), 8);
    assert.strictEqual(getConcurrentFragments('eight'), 8);
  });

  // ── 4. Negative configuration fallback ───────────────────────────────────
  await t.test('4. Negative configuration fallback and zero protection', () => {
    assert.strictEqual(getConcurrentFragments('-1'), 8);
    assert.strictEqual(getConcurrentFragments('-8'), 8);
    assert.strictEqual(getConcurrentFragments('0'), 8);
  });

  // ── 5. Infinity/NaN protection ───────────────────────────────────────────
  await t.test('5. Infinity/NaN protection falls back to default 8', () => {
    assert.strictEqual(getConcurrentFragments('Infinity'), 8);
    assert.strictEqual(getConcurrentFragments('-Infinity'), 8);
    assert.strictEqual(getConcurrentFragments('NaN'), 8);
  });

  // ── 6. Maximum concurrency capped at 16 ──────────────────────────────────
  await t.test('6. Maximum concurrency capped at 16', () => {
    assert.strictEqual(getConcurrentFragments('17'), 16);
    assert.strictEqual(getConcurrentFragments('32'), 16);
    assert.strictEqual(getConcurrentFragments('64'), 16);
    assert.strictEqual(getConcurrentFragments('1000'), 16);
    assert.strictEqual(MAX_CONCURRENT_FRAGMENTS, 16);
  });

  // ── 7. Default buffer = 4M ──────────────────────────────────────────────
  await t.test('7. Default buffer = 4M when unset or empty', () => {
    assert.strictEqual(getDownloadBufferSize(undefined), '4M');
    assert.strictEqual(getDownloadBufferSize(''), '4M');
    assert.strictEqual(getDownloadBufferSize('   '), '4M');
    assert.strictEqual(DEFAULT_DOWNLOAD_BUFFER_SIZE, '4M');
  });

  // ── 8. Invalid buffer configuration rejection ────────────────────────────
  await t.test('8. Invalid buffer configuration rejection and whitelist enforcement', () => {
    assert.strictEqual(getDownloadBufferSize('1024K; rm -rf'), '4M');
    assert.strictEqual(getDownloadBufferSize('arbitrary'), '4M');
    assert.strictEqual(getDownloadBufferSize('100M'), '4M');
    assert.strictEqual(getDownloadBufferSize('0M'), '4M');
    // Valid whitelisted options
    assert.strictEqual(getDownloadBufferSize('512K'), '512K');
    assert.strictEqual(getDownloadBufferSize('1M'), '1M');
    assert.strictEqual(getDownloadBufferSize('2m'), '2M');
    assert.strictEqual(getDownloadBufferSize('4M'), '4M');
    assert.strictEqual(getDownloadBufferSize('8M'), '8M');
    assert.strictEqual(getDownloadBufferSize('16M'), '16M');
    assert.deepStrictEqual(Array.from(SUPPORTED_BUFFER_SIZES), ['512K', '1M', '2M', '4M', '8M', '16M']);
  });

  // ── 9. Throughput calculation ────────────────────────────────────────────
  await t.test('9. Throughput calculation: bytes/sec', () => {
    // 10,485,760 bytes in 2000 ms = 5,242,880 B/s
    const tp = calculateThroughput(10485760, 2000);
    assert.strictEqual(tp.bytesPerSecond, 5242880);
    assert.strictEqual(calculateThroughput(0, 1000).bytesPerSecond, 0);
    assert.strictEqual(calculateThroughput(1000, 0).bytesPerSecond, 0);
  });

  // ── 10. MB/sec calculation ───────────────────────────────────────────────
  await t.test('10. MB/sec calculation accurately converts to megabytes/sec', () => {
    // 5,242,880 B/s = 5.00 MB/s
    const tp = calculateThroughput(10485760, 2000);
    assert.strictEqual(tp.megabytesPerSecond, 5.0);

    // Parse speed from sample yt-dlp progress line
    const parsed = parseYtDlpProgress('[download]  42.5% of ~ 100.00MiB at  2.50MiB/s ETA 00:23');
    assert.ok(parsed);
    assert.strictEqual(parsed.percent, 42.5);
    assert.strictEqual(parsed.megabytesPerSecond, 2.5);
    assert.strictEqual(parsed.bytesPerSecond, 2621440);
  });

  // ── 11. Progress updates refresh stall timer ──────────────────────────────
  await t.test('11. Progress updates refresh stall timer and prevent premature timeout', async () => {
    let progressCount = 0;
    // Total execution time ~600ms exceeds stallTimeoutMs (500ms).
    // If progress does not refresh the stall timer, process would be killed at 500ms.
    const script = "console.log('[download]  10.0%'); setTimeout(() => { console.log('[download]  50.0%'); setTimeout(() => { console.log('[download]  80.0%'); setTimeout(() => { console.log('[download] 100.0%'); }, 150); }, 150); }, 150);";

    const res = await runCommandWithLifecycle(process.execPath, ['-e', script], {
      timeoutMs: 5000,
      stallTimeoutMs: 500, // 500ms stall limit; total runtime is ~500-600ms with progress every 150ms
      onProgress: () => {
        progressCount++;
      },
    });

    assert.ok(res.stdout.includes('100.0%'));
    assert.ok(progressCount >= 3, 'Stall timer was refreshed on actual progress');
  });

  // ── 12. Stall timeout still works ────────────────────────────────────────
  await t.test('12. Stall timeout still terminates silent processes with ESTALL', async () => {
    await assert.rejects(
      async () => {
        await runCommandWithLifecycle(process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
          timeoutMs: 5000,
          stallTimeoutMs: 100, // Process stalls after 100ms
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'ESTALL');
        assert.ok(err.message.includes('stalled'));
        return true;
      }
    );
  });

  // ── 13. Absolute timeout still works ─────────────────────────────────────
  await t.test('13. Absolute timeout still terminates running process with ETIMEDOUT', async () => {
    // Emits continuous progress lines, but total duration exceeds absolute timeout
    const script = "setInterval(() => console.log('[download] 10%'), 20);";

    await assert.rejects(
      async () => {
        await runCommandWithLifecycle(process.execPath, ['-e', script], {
          timeoutMs: 80, // Hard ceiling timeout at 80ms
          stallTimeoutMs: 500, // High stall limit
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'ETIMEDOUT');
        assert.ok(err.message.includes('timeout limit'));
        return true;
      }
    );
  });

  // ── 14. Cancellation still works ─────────────────────────────────────────
  await t.test('14. Cancellation still works and terminates process tree with ECONNABORTED', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);

    await assert.rejects(
      async () => {
        await runCommandWithLifecycle(process.execPath, ['-e', 'setTimeout(() => {}, 10000);'], {
          timeoutMs: 5000,
          clientSignal: ac.signal,
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'ECONNABORTED');
        return true;
      }
    );
  });

  // ── 15. Concurrency slot released exactly once ───────────────────────────
  await t.test('15. Concurrency slot released exactly once and tracked accurately', () => {
    const initial = getActiveDownloads();
    assert.strictEqual(acquireDownloadSlot(), true);
    assert.strictEqual(getActiveDownloads(), initial + 1);

    releaseDownloadSlot();
    assert.strictEqual(getActiveDownloads(), initial);

    // Double release guard (never goes below zero)
    releaseDownloadSlot();
    assert.strictEqual(getActiveDownloads(), Math.max(0, initial));
  });

  // ── 16. Phase 6.1 timeout regression ─────────────────────────────────────
  await t.test('16. Phase 6.1 timeout regression: size-aware calculations remain intact', () => {
    const detailsSmall = getDownloadTimeoutDetails(10 * 1024 * 1024);
    assert.strictEqual(detailsSmall.timeoutMs, DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.strictEqual(detailsSmall.timeoutMs, 180_000);

    const detailsLarge = getDownloadTimeoutDetails(2000 * 1024 * 1024);
    assert.strictEqual(detailsLarge.timeoutMs, DEFAULT_DOWNLOAD_MAX_TIMEOUT_MS);
    assert.strictEqual(detailsLarge.timeoutMs, 1_800_000);

    const detailsDefault = getDownloadTimeoutDetails(undefined);
    assert.strictEqual(detailsDefault.timeoutMs, DEFAULT_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.strictEqual(detailsDefault.sizeSource, 'unknown');
  });

  // ── 17. Phase 6 security regression ──────────────────────────────────────
  await t.test('17. Phase 6 security regression: SSRF, DNS, and command injection protections', () => {
    assert.strictEqual(isPrivateOrNonPublicIp('127.0.0.1'), true);
    assert.strictEqual(isPrivateOrNonPublicIp('10.0.0.1'), true);
    assert.strictEqual(isPrivateOrNonPublicIp('192.168.1.1'), true);
    assert.strictEqual(isPrivateOrNonPublicIp('169.254.169.254'), true);
    assert.strictEqual(isPrivateOrNonPublicIp('8.8.8.8'), false);

    const badUrl = validateUrl('javascript:alert(1)');
    assert.strictEqual(badUrl.valid, false);

    const injectionFormat = validateAndMapFormat({
      type: 'video',
      quality: '1080p; rm -rf',
      format: 'mp4',
    });
    assert.strictEqual(injectionFormat.valid, false);
    assert.strictEqual(injectionFormat.error, 'Disallowed characters in format request.');
  });

  // ── 18. Phase 5 MP3 regression ───────────────────────────────────────────
  await t.test('18. Phase 5 MP3 regression: audio transcoding request mapped properly', () => {
    const mp3Res = validateAndMapFormat({
      type: 'audio',
      quality: 'audio',
      format: 'mp3',
      bitrate: '192k',
    });
    assert.strictEqual(mp3Res.valid, true);
    assert.strictEqual(mp3Res.isAudioOnly, true);
    assert.strictEqual(mp3Res.isMp3, true);
    assert.strictEqual(mp3Res.mp3Bitrate, '192k');
    assert.strictEqual(mp3Res.audioSelector, 'bestaudio[ext=m4a]/bestaudio/best');
  });

  // ── 19. 1080p MP4 video+audio regression ─────────────────────────────────
  await t.test('19. 1080p MP4 video+audio regression: produces video + audio streams', () => {
    const format = validateAndMapFormat({
      type: 'video',
      quality: '1080p',
      format: 'mp4',
    });
    assert.strictEqual(format.valid, true);
    assert.strictEqual(format.isAudioOnly, false);
    assert.strictEqual(format.height, 1080);
    assert.ok(format.videoSelector.includes('bestvideo[height<=1080][ext=mp4]'));
    assert.ok(format.videoSelector.includes('bestaudio[ext=m4a]'));
  });

  // ── 20. Resolution bounding regression ───────────────────────────────────
  await t.test('20. Resolution bounding regression: never upgrades to 1440p/4K', () => {
    for (const height of [1080, 720, 480, 360, 240, 144]) {
      const res = validateAndMapFormat({
        type: 'video',
        quality: `${height}p`,
        format: 'mp4',
      });
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.height, height);
      assert.ok(
        res.videoSelector.includes(`bestvideo[height<=${height}]`),
        `Selector for ${height}p must be strictly bounded with height<=${height}`
      );
      assert.ok(
        !res.videoSelector.endsWith('/bestvideo'),
        `Selector for ${height}p must not contain open-ended /bestvideo fallback`
      );
    }
  });
});
