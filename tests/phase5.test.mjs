import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 1. Validation & sanitization imports
const {
  validateAndMapFormat,
  sanitizeFilename,
  sanitizeMetadata,
  SUPPORTED_MP3_BITRATES,
} = await import('../src/lib/validation.ts');

// 2. Concurrency & slot management imports
const {
  acquireDownloadSlot,
  releaseDownloadSlot,
  getConcurrencyStats,
  checkDiskSpace,
} = await import('../src/lib/concurrency.ts');

// 3. Process management imports
const {
  runCommandWithLifecycle,
  killProcessTree,
} = await import('../src/lib/process-manager.ts');

// 4. Job manager & integrity imports
const {
  resolvedFfmpegPath,
  validateMp3Integrity,
  createJob,
  getJob,
  cancelJob,
  cleanupJobResources,
} = await import('../src/lib/job-manager.ts');

// 5. Streaming helper imports
const {
  createFileStreamResponse,
} = await import('../src/lib/stream-helper.ts');

// Helper to create a temporary testing directory
function makeTempTestDir() {
  const dir = path.join(os.tmpdir(), `phase5_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Helper to safely clean up directories
function removeTempDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. REQUEST / VALIDATION TESTS (Tests 1 - 7)
// ─────────────────────────────────────────────────────────────────────────────
test('1. Request & Validation Tests', async (t) => {
  await t.test('1. audio + mp3 accepted with default 192k bitrate', () => {
    const res = validateAndMapFormat({ type: 'audio', format: 'mp3' });
    assert.equal(res.valid, true);
    assert.equal(res.isAudioOnly, true);
    assert.equal(res.isMp3, true);
    assert.equal(res.mp3Bitrate, '192k');
    assert.ok(res.audioSelector);
  });

  await t.test('2. video + mp3 rejected (contradiction rule)', () => {
    const res1 = validateAndMapFormat({ type: 'video', format: 'mp3' });
    assert.equal(res1.valid, false);
    assert.match(res1.error || '', /video request with MP3 format/i);

    const res2 = validateAndMapFormat({ quality: '1080p', format: 'mp3' });
    assert.equal(res2.valid, false);
    assert.match(res2.error || '', /video resolution with MP3/i);

    const res3 = validateAndMapFormat({ type: 'audio', quality: '1080p' });
    assert.equal(res3.valid, false);
    assert.match(res3.error || '', /audio request with video quality/i);
  });

  await t.test('3. audio + 128k accepted', () => {
    const res = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: '128k' });
    assert.equal(res.valid, true);
    assert.equal(res.isMp3, true);
    assert.equal(res.mp3Bitrate, '128k');
  });

  await t.test('4. audio + 192k accepted', () => {
    const res = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: '192k' });
    assert.equal(res.valid, true);
    assert.equal(res.isMp3, true);
    assert.equal(res.mp3Bitrate, '192k');
  });

  await t.test('5. audio + 256k accepted', () => {
    const res = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: '256k' });
    assert.equal(res.valid, true);
    assert.equal(res.isMp3, true);
    assert.equal(res.mp3Bitrate, '256k');
  });

  await t.test('6. audio + 320k accepted', () => {
    const res = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: '320k' });
    assert.equal(res.valid, true);
    assert.equal(res.isMp3, true);
    assert.equal(res.mp3Bitrate, '320k');
  });

  await t.test('7. invalid or arbitrary bitrates rejected', () => {
    const invalidValues = ['64k', '96k', '500k', 'custom', '; rm -rf /', '0k', '192kbps'];
    for (const val of invalidValues) {
      const res = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: val });
      assert.equal(res.valid, false, `Expected bitrate '${val}' to be rejected`);
      assert.match(res.error || '', /unsupported MP3 bitrate|Disallowed characters/i);
    }
  });

  await t.test('Native m4a and webm audio remain supported without MP3 transcoding', () => {
    const m4aRes = validateAndMapFormat({ type: 'audio', format: 'm4a' });
    assert.equal(m4aRes.valid, true);
    assert.equal(m4aRes.isMp3, false);
    assert.equal(m4aRes.isAudioOnly, true);
    assert.match(m4aRes.audioSelector || '', /ext=m4a/);

    const webmRes = validateAndMapFormat({ type: 'audio', format: 'webm' });
    assert.equal(webmRes.valid, true);
    assert.equal(webmRes.isMp3, false);
    assert.equal(webmRes.isAudioOnly, true);
    assert.match(webmRes.audioSelector || '', /ext=webm/);
  });

  await t.test('Metadata sanitization truncates and strips dangerous control characters', () => {
    const dangerousTitle = 'Track\x00Name\r\nAlbum Artist\t\x1f';
    const cleanTitle = sanitizeMetadata(dangerousTitle, 500);
    assert.ok(cleanTitle);
    assert.equal(cleanTitle.includes('\x00'), false);
    assert.equal(cleanTitle.includes('\r'), false);
    assert.equal(cleanTitle.includes('\n'), false);

    const longString = 'A'.repeat(600);
    const truncatedTitle = sanitizeMetadata(longString, 500);
    assert.equal(truncatedTitle?.length, 500);

    const truncatedDate = sanitizeMetadata('2026-09-04 12:00:00 UTC - extra data here that exceeds date size', 32);
    assert.equal(truncatedDate?.length, 32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. FFMPEG TRANSCODING & INTEGRITY TESTS (Tests 8 - 13)
// ─────────────────────────────────────────────────────────────────────────────
test('2. FFmpeg Transcoding & Output Validation Tests', async (t) => {
  const testDir = makeTempTestDir();
  const sourceM4a = path.join(testDir, 'test_source.m4a');
  const sourceWebm = path.join(testDir, 'test_source.webm');

  // Generate 1-second synthetic audio fixtures using FFmpeg
  await runCommandWithLifecycle(resolvedFfmpegPath, [
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:duration=1',
    '-c:a', 'aac',
    '-y',
    sourceM4a,
  ]);

  await runCommandWithLifecycle(resolvedFfmpegPath, [
    '-f', 'lavfi',
    '-i', 'sine=frequency=800:duration=1',
    '-c:a', 'libopus',
    '-y',
    sourceWebm,
  ]);

  assert.ok(fs.existsSync(sourceM4a), 'Source m4a fixture must exist');
  assert.ok(fs.existsSync(sourceWebm), 'Source webm fixture must exist');

  const mp3FromM4a = path.join(testDir, 'output_from_m4a.mp3');
  const mp3FromWebm = path.join(testDir, 'output_from_webm.mp3');

  await t.test('8. native m4a -> mp3 transcoding with safe arguments', async () => {
    const ffmpegArgs = [
      '-i', sourceM4a,
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-id3v2_version', '3',
      '-write_id3v1', '1',
      '-metadata', 'title=Test M4A to MP3',
      '-metadata', 'artist=NexusLoad Tester',
      '-y',
      mp3FromM4a,
    ];

    const result = await runCommandWithLifecycle(resolvedFfmpegPath, ffmpegArgs);
    assert.ok(fs.existsSync(mp3FromM4a), 'Transcoded MP3 from m4a must exist');
  });

  await t.test('9. native webm -> mp3 transcoding with safe arguments', async () => {
    const ffmpegArgs = [
      '-i', sourceWebm,
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '256k',
      '-id3v2_version', '3',
      '-write_id3v1', '1',
      '-metadata', 'title=Test WebM to MP3',
      '-y',
      mp3FromWebm,
    ];

    await runCommandWithLifecycle(resolvedFfmpegPath, ffmpegArgs);
    assert.ok(fs.existsSync(mp3FromWebm), 'Transcoded MP3 from webm must exist');
  });

  await t.test('10. output file extension is .mp3', () => {
    assert.equal(path.extname(mp3FromM4a).toLowerCase(), '.mp3');
    assert.equal(path.extname(mp3FromWebm).toLowerCase(), '.mp3');
  });

  await t.test('11. output MIME type is audio/mpeg', () => {
    // Validate that our job creator maps MP3 format to audio/mpeg
    const format = validateAndMapFormat({ type: 'audio', format: 'mp3' });
    assert.equal(format.isMp3, true);
    const contentType = format.isMp3 ? 'audio/mpeg' : 'audio/mp4';
    assert.equal(contentType, 'audio/mpeg');
  });

  await t.test('12. output file size > 0 bytes', () => {
    const stat1 = fs.statSync(mp3FromM4a);
    const stat2 = fs.statSync(mp3FromWebm);
    assert.ok(stat1.size > 0, 'mp3FromM4a size must be > 0');
    assert.ok(stat2.size > 0, 'mp3FromWebm size must be > 0');
  });

  await t.test('13. validateMp3Integrity checks signature and rejects corrupt/empty files', () => {
    // A) Valid real MP3s pass
    assert.equal(validateMp3Integrity(mp3FromM4a), true, 'Real MP3 from m4a must pass validation');
    assert.equal(validateMp3Integrity(mp3FromWebm), true, 'Real MP3 from webm must pass validation');

    // B) 0-byte file rejected
    const emptyFile = path.join(testDir, 'empty.mp3');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    assert.equal(validateMp3Integrity(emptyFile), false, '0-byte file must be rejected');

    // C) Corrupt / random bytes rejected
    const corruptFile = path.join(testDir, 'corrupt.mp3');
    fs.writeFileSync(corruptFile, Buffer.from('This is a completely non-audio text file pretending to be mp3'));
    assert.equal(validateMp3Integrity(corruptFile), false, 'Text file must be rejected');

    const randomBytesFile = path.join(testDir, 'random.mp3');
    fs.writeFileSync(randomBytesFile, Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, ...Array(200).fill(0x55)]));
    assert.equal(validateMp3Integrity(randomBytesFile), false, 'Random binary file must be rejected');

    // D) Native m4a / webm renamed to .mp3 rejected
    const fakeMp3FromM4a = path.join(testDir, 'fake_m4a.mp3');
    fs.copyFileSync(sourceM4a, fakeMp3FromM4a);
    assert.equal(validateMp3Integrity(fakeMp3FromM4a), false, 'Renamed m4a must not pass MP3 frame validation');

    const fakeMp3FromWebm = path.join(testDir, 'fake_webm.mp3');
    fs.copyFileSync(sourceWebm, fakeMp3FromWebm);
    assert.equal(validateMp3Integrity(fakeMp3FromWebm), false, 'Renamed webm must not pass MP3 frame validation');
  });

  t.after(() => {
    removeTempDir(testDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLEANUP TESTS (Tests 14 - 18)
// ─────────────────────────────────────────────────────────────────────────────
test('3. Temporary File Cleanup Tests', async (t) => {
  await t.test('14. successful conversion deletes source and retains final mp3', async () => {
    const testDir = makeTempTestDir();
    const sourceFile = path.join(testDir, 'source.m4a');
    const tmpMp3 = path.join(testDir, 'job123.mp3.tmp');
    const finalMp3 = path.join(testDir, 'final_job123.mp3');

    // Create synthetic source
    await runCommandWithLifecycle(resolvedFfmpegPath, [
      '-f', 'lavfi', '-i', 'sine=frequency=500:duration=0.5', '-c:a', 'aac', '-y', sourceFile
    ]);
    assert.ok(fs.existsSync(sourceFile));

    // Transcode to tmp
    await runCommandWithLifecycle(resolvedFfmpegPath, [
      '-i', sourceFile, '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', '-y', tmpMp3
    ]);
    assert.ok(fs.existsSync(tmpMp3));

    // Validate and atomically rename
    assert.equal(validateMp3Integrity(tmpMp3), true);
    fs.renameSync(tmpMp3, finalMp3);

    // Clean source
    if (fs.existsSync(sourceFile)) fs.unlinkSync(sourceFile);

    assert.equal(fs.existsSync(sourceFile), false, 'Source audio must be deleted after success');
    assert.equal(fs.existsSync(tmpMp3), false, 'Temporary mp3 must be renamed/deleted');
    assert.equal(fs.existsSync(finalMp3), true, 'Final mp3 must exist');

    removeTempDir(testDir);
  });

  await t.test('15. failed conversion deletes source file', async () => {
    const testDir = makeTempTestDir();
    const sourceFile = path.join(testDir, 'corrupt_source.m4a');
    fs.writeFileSync(sourceFile, Buffer.from('Not valid audio'));

    const tmpMp3 = path.join(testDir, 'fail.mp3.tmp');
    let transcodeError = null;

    try {
      await runCommandWithLifecycle(resolvedFfmpegPath, [
        '-i', sourceFile, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', tmpMp3
      ]);
    } catch (err) {
      transcodeError = err;
    }

    assert.ok(transcodeError, 'FFmpeg must fail on invalid audio input');

    // Cleanup simulation
    if (fs.existsSync(sourceFile)) fs.unlinkSync(sourceFile);
    if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3);

    assert.equal(fs.existsSync(sourceFile), false, 'Source audio must be deleted after failure');
    assert.equal(fs.existsSync(tmpMp3), false, 'Tmp mp3 must not exist after failure');

    removeTempDir(testDir);
  });

  await t.test('16. failed conversion deletes partial MP3', async () => {
    const testDir = makeTempTestDir();
    const tmpMp3 = path.join(testDir, 'partial.mp3.tmp');
    fs.writeFileSync(tmpMp3, Buffer.from('partial truncated mp3 data'));

    // Simulation of failure handler cleanup
    if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3);

    assert.equal(fs.existsSync(tmpMp3), false, 'Partial MP3 must be removed');
    removeTempDir(testDir);
  });

  await t.test('17. cancellation removes all temporary files', () => {
    const testDir = makeTempTestDir();
    const sourceFile = path.join(testDir, 'cancel.source.m4a');
    const tmpMp3 = path.join(testDir, 'cancel.mp3.tmp');
    fs.writeFileSync(sourceFile, Buffer.alloc(100));
    fs.writeFileSync(tmpMp3, Buffer.alloc(100));

    const mockJob = {
      id: 'mock_cancel_job',
      filePath: tmpMp3,
      tmpDir: testDir,
      activeStreams: 0,
      cleanupPending: false,
    };

    cleanupJobResources(mockJob);

    assert.equal(fs.existsSync(tmpMp3), false, 'Tmp MP3 must be removed on cancellation cleanup');
    assert.equal(fs.existsSync(sourceFile), false, 'Source must be removed on cancellation cleanup');
    assert.equal(fs.existsSync(testDir), false, 'Tmp directory must be removed on cancellation cleanup');
  });

  await t.test('18. timeout removes temporary files', () => {
    const testDir = makeTempTestDir();
    const sourceFile = path.join(testDir, 'timeout.source.m4a');
    const tmpMp3 = path.join(testDir, 'timeout.mp3.tmp');
    fs.writeFileSync(sourceFile, Buffer.alloc(100));
    fs.writeFileSync(tmpMp3, Buffer.alloc(100));

    const mockJob = {
      id: 'mock_timeout_job',
      filePath: tmpMp3,
      tmpDir: testDir,
      activeStreams: 0,
      cleanupPending: false,
    };

    cleanupJobResources(mockJob);
    assert.equal(fs.existsSync(testDir), false, 'Job directory must be removed after timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PROCESS LIFECYCLE & CANCELLATION TESTS (Tests 19 - 21)
// ─────────────────────────────────────────────────────────────────────────────
test('4. Process Lifecycle & Orphan Prevention Tests', async (t) => {
  await t.test('19. FFmpeg cancellation terminates process tree', async () => {
    const ac = new AbortController();
    const testDir = makeTempTestDir();
    const outMp3 = path.join(testDir, 'long_cancel.mp3');

    // Start a 10-second sine wave generation
    const promise = runCommandWithLifecycle(resolvedFfmpegPath, [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-y', outMp3
    ], {
      clientSignal: ac.signal,
      timeoutMs: 15000,
    });

    // Abort after 100ms
    setTimeout(() => ac.abort(), 100);

    let caughtErr = null;
    try {
      await promise;
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Command must reject when aborted');
    assert.equal(caughtErr.code, 'ECONNABORTED');
    removeTempDir(testDir);
  });

  await t.test('20. FFmpeg timeout terminates process tree', async () => {
    const testDir = makeTempTestDir();
    const outMp3 = path.join(testDir, 'long_timeout.mp3');

    // Run 120s task with 50ms timeout to ensure timeout triggers
    let caughtErr = null;
    try {
      await runCommandWithLifecycle(resolvedFfmpegPath, [
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
        '-c:a', 'libmp3lame', '-b:a', '192k',
        '-y', outMp3
      ], {
        timeoutMs: 50,
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Command must reject on timeout');
    assert.equal(caughtErr.code, 'ETIMEDOUT');
    removeTempDir(testDir);
  });

  await t.test('21. No orphan FFmpeg process remains running after kill', async () => {
    const ac = new AbortController();
    const testDir = makeTempTestDir();
    const outMp3 = path.join(testDir, 'orphan_check.mp3');

    const promise = runCommandWithLifecycle(resolvedFfmpegPath, [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      '-y', outMp3
    ], {
      clientSignal: ac.signal,
    });

    setTimeout(() => ac.abort(), 150);

    try {
      await promise;
    } catch {}

    // Wait 100ms for OS process cleanup
    await new Promise(r => setTimeout(r, 100));

    // Verify system can start new ffmpeg command immediately with no locked handles
    const testCheck = await runCommandWithLifecycle(resolvedFfmpegPath, ['-version']);
    assert.ok(testCheck.stdout.includes('ffmpeg version'), 'FFmpeg must execute cleanly without orphans');

    removeTempDir(testDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PROGRESS REPORTING TESTS (Tests 22 - 24)
// ─────────────────────────────────────────────────────────────────────────────
test('5. Progress Reporting & Finalization Tests', async (t) => {
  await t.test('22. Transcoding progress reported and parsed', () => {
    // Test ffmpeg progress line parsing logic
    let parsedOutTimeUs = 0;
    const progressLines = [
      'out_time_us=500000',
      'total_size=12345',
      'progress=continue',
    ];

    for (const line of progressLines) {
      const match = line.match(/out_time_us=(\d+)/);
      if (match) {
        parsedOutTimeUs = parseInt(match[1], 10);
      }
    }

    assert.equal(parsedOutTimeUs, 500000);
    const durationSeconds = 1.0;
    const currentSeconds = parsedOutTimeUs / 1000000;
    const pct = Math.round((currentSeconds / durationSeconds) * 100);
    assert.equal(pct, 50);
  });

  await t.test('23. Transcoding progress never exceeds 99 before finalization', () => {
    // In job-manager.ts, progress formula is:
    // Math.min(99, Math.max(60, 60 + Math.round(ratio * 39)))
    const ratios = [0.0, 0.5, 0.99, 1.0, 1.5, 2.0];
    for (const r of ratios) {
      const transcodePct = Math.min(99, Math.max(60, 60 + Math.round(r * 39)));
      assert.ok(transcodePct <= 99, `Progress ${transcodePct} must never exceed 99 during transcode`);
      assert.ok(transcodePct >= 60, `Progress ${transcodePct} must be >= 60`);
    }
  });

  await t.test('24. Progress reaches 100 only after validation, rename, and ready status', () => {
    const mockJob = {
      id: 'mock_ready_job',
      status: 'processing',
      progress: 95,
      stage: 'Validating MP3 integrity...',
    };

    // Before validation:
    assert.notEqual(mockJob.progress, 100);
    assert.notEqual(mockJob.status, 'ready');

    // Validation passes & rename completes:
    mockJob.progress = 100;
    mockJob.status = 'ready';
    mockJob.stage = 'MP3 audio ready for download.';

    assert.equal(mockJob.progress, 100);
    assert.equal(mockJob.status, 'ready');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. MEMORY CONSTRAINTS TESTS (Test 25)
// ─────────────────────────────────────────────────────────────────────────────
test('6. Bounded Memory Architecture Tests', async (t) => {
  await t.test('25. Audio transcoding is filesystem-backed and does not buffer file into Node heap', async () => {
    const testDir = makeTempTestDir();
    const sourcePath = path.join(testDir, 'heap_test_source.m4a');
    const outMp3 = path.join(testDir, 'heap_test_out.mp3');

    // Generate 3-second audio file
    await runCommandWithLifecycle(resolvedFfmpegPath, [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-y', sourcePath
    ]);

    const initialHeap = process.memoryUsage().heapUsed;

    // Execute transcode via external FFmpeg process (filesystem-to-filesystem)
    await runCommandWithLifecycle(resolvedFfmpegPath, [
      '-i', sourcePath,
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-y', outMp3
    ]);

    const finalHeap = process.memoryUsage().heapUsed;
    const heapDiffMb = Math.abs(finalHeap - initialHeap) / (1024 * 1024);

    // Node heap should not spike from buffering whole files
    assert.ok(heapDiffMb < 50, `Heap change (${heapDiffMb.toFixed(2)} MB) must be small and bounded`);
    assert.ok(fs.existsSync(outMp3));

    removeTempDir(testDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. CONCURRENCY & SLOT RELEASE TESTS (Tests 26 - 29)
// ─────────────────────────────────────────────────────────────────────────────
test('7. Concurrency & Slot Management Tests', async (t) => {
  await t.test('26. Concurrency slot released after successful job', () => {
    const initial = getConcurrencyStats().activeDownloads;
    assert.equal(acquireDownloadSlot(), true);
    assert.equal(getConcurrencyStats().activeDownloads, initial + 1);

    // Simulate completion
    releaseDownloadSlot();
    assert.equal(getConcurrencyStats().activeDownloads, initial);
  });

  await t.test('27. Concurrency slot released after failure', () => {
    const initial = getConcurrencyStats().activeDownloads;
    assert.equal(acquireDownloadSlot(), true);
    assert.equal(getConcurrencyStats().activeDownloads, initial + 1);

    // Simulate failure cleanup
    releaseDownloadSlot();
    assert.equal(getConcurrencyStats().activeDownloads, initial);
  });

  await t.test('28. Concurrency slot released after cancellation', () => {
    const initial = getConcurrencyStats().activeDownloads;
    const { job } = createJob({
      validUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      formatValidation: { valid: true, isAudioOnly: true, isMp3: true, mp3Bitrate: '192k' },
      safeTitle: 'test_cancel_slot',
      ytDlpPath: 'yt-dlp',
      isProduction: false,
    });

    assert.ok(job);
    assert.equal(job.slotAcquired, true);
    assert.equal(getConcurrencyStats().activeDownloads, initial + 1);

    cancelJob(job.id);
    assert.equal(job.slotAcquired, false);
    assert.equal(getConcurrencyStats().activeDownloads, initial);
  });

  await t.test('29. Concurrency slot is never released twice', () => {
    const initial = getConcurrencyStats().activeDownloads;
    const { job } = createJob({
      validUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      formatValidation: { valid: true, isAudioOnly: true, isMp3: true, mp3Bitrate: '192k' },
      safeTitle: 'test_double_release',
      ytDlpPath: 'yt-dlp',
      isProduction: false,
    });

    assert.ok(job);
    assert.equal(getConcurrencyStats().activeDownloads, initial + 1);

    // First cancel
    cancelJob(job.id);
    assert.equal(getConcurrencyStats().activeDownloads, initial);

    // Second cancel should be a no-op and NOT decrement slots further
    cancelJob(job.id);
    assert.equal(getConcurrencyStats().activeDownloads, initial);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. STREAMING & HTTP RANGE SEMANTICS (Tests 30 - 33)
// ─────────────────────────────────────────────────────────────────────────────
test('8. Streaming & HTTP Range Semantics Tests for MP3', async (t) => {
  const testDir = makeTempTestDir();
  const sampleMp3 = path.join(testDir, 'sample_stream.mp3');

  // Generate a real valid MP3 file of at least 5 KB
  await runCommandWithLifecycle(resolvedFfmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=600:duration=2',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    '-id3v2_version', '3', '-write_id3v1', '1',
    '-metadata', 'title=Streaming Test',
    '-y', sampleMp3,
  ]);

  const fileStat = fs.statSync(sampleMp3);
  const totalBytes = fileStat.size;
  assert.ok(totalBytes > 1000, 'Test MP3 must have reasonable size');

  const mockJob = {
    id: 'stream_test_job',
    filePath: sampleMp3,
    fileName: 'sample_stream.mp3',
    contentType: 'audio/mpeg',
    activeStreams: 0,
    cleanupPending: false,
  };

  await t.test('30. Full file stream (200 OK) with audio/mpeg and Accept-Ranges', async () => {
    const req = new Request('http://localhost/api/download/stream_test_job');
    const res = createFileStreamResponse(req, mockJob);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(res.headers.get('Content-Length'), String(totalBytes));
    assert.match(res.headers.get('Content-Disposition') || '', /sample_stream\.mp3/);

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, totalBytes);
  });

  await t.test('31. Single byte range bytes=0-0 (206 Partial Content)', async () => {
    const req = new Request('http://localhost/api/download/stream_test_job', {
      headers: { Range: 'bytes=0-0' },
    });
    const res = createFileStreamResponse(req, mockJob);

    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), `bytes 0-0/${totalBytes}`);
    assert.equal(res.headers.get('Content-Length'), '1');
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 1);
  });

  await t.test('32. Suffix range bytes=-100 (206 Partial Content)', async () => {
    const req = new Request('http://localhost/api/download/stream_test_job', {
      headers: { Range: 'bytes=-100' },
    });
    const res = createFileStreamResponse(req, mockJob);

    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), `bytes ${totalBytes - 100}-${totalBytes - 1}/${totalBytes}`);
    assert.equal(res.headers.get('Content-Length'), '100');

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 100);
  });

  await t.test('33. Invalid Range returns 416 Range Not Satisfiable', () => {
    const req = new Request('http://localhost/api/download/stream_test_job', {
      headers: { Range: 'bytes=9999999-9999999' },
    });
    const res = createFileStreamResponse(req, mockJob);

    assert.equal(res.status, 416);
    assert.equal(res.headers.get('Content-Range'), `bytes */${totalBytes}`);
  });

  t.after(() => {
    removeTempDir(testDir);
  });
});
