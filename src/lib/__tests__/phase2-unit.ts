import assert from 'assert';
import { validateUrl, validateAndMapFormat, sanitizeFilename } from '../validation';
import { acquireDownloadSlot, releaseDownloadSlot, getActiveDownloads, checkDiskSpace } from '../concurrency';
import { runCommandWithLifecycle } from '../process-manager';

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res && typeof (res as Promise<void>).then === 'function') {
      return (res as Promise<void>)
        .then(() => {
          console.log(`  ✓ ${name}`);
          passed++;
        })
        .catch((err) => {
          console.error(`  ✗ ${name}:`, err.message);
          failed++;
        });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error(`  ✗ ${name}:`, e?.message);
    failed++;
  }
}

async function runTests() {
  console.log('=== PHASE 2 SECURITY & VALIDATION TESTS ===\n');

  console.log('--- 1. URL Validation Tests ---');
  it('accepts valid YouTube URL', () => {
    const res = validateUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('accepts valid supported source (TikTok, Vimeo, SoundCloud)', () => {
    assert.strictEqual(validateUrl('https://vimeo.com/76979871').valid, true);
    assert.strictEqual(validateUrl('https://soundcloud.com/user/track').valid, true);
    assert.strictEqual(validateUrl('http://tiktok.com/@user/video/123').valid, true);
  });

  it('rejects empty URL', () => {
    assert.strictEqual(validateUrl('').valid, false);
    assert.strictEqual(validateUrl('   ').valid, false);
    assert.strictEqual(validateUrl(null).valid, false);
  });

  it('rejects malformed URL', () => {
    assert.strictEqual(validateUrl('not-a-url').valid, false);
    assert.strictEqual(validateUrl('htp://invalid').valid, false);
  });

  it('rejects javascript: scheme', () => {
    const res = validateUrl('javascript:alert(1)');
    assert.strictEqual(res.valid, false);
  });

  it('rejects file:/// scheme', () => {
    const res = validateUrl('file:///etc/passwd');
    assert.strictEqual(res.valid, false);
  });

  it('rejects data: scheme', () => {
    const res = validateUrl('data:text/plain;base64,SGVsbG8=');
    assert.strictEqual(res.valid, false);
  });

  it('rejects unsupported ftp: protocol', () => {
    const res = validateUrl('ftp://example.com/file.mp4');
    assert.strictEqual(res.valid, false);
  });

  it('rejects URL longer than MAX_URL_LENGTH limit (2048)', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2100);
    const res = validateUrl(longUrl);
    assert.strictEqual(res.valid, false);
    assert.ok(res.error?.includes('exceeds maximum permitted length'));
  });

  console.log('\n--- 2. Format & Quality Validation Tests ---');
  it('accepts valid video qualities', () => {
    for (const height of [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320]) {
      const res = validateAndMapFormat({ quality: `${height}p` });
      assert.strictEqual(res.valid, true, `Height ${height}p should be valid`);
      assert.strictEqual(res.isAudioOnly, false);
      assert.strictEqual(res.videoSelector, `bestvideo[height<=${height}]/bestvideo`);
    }
  });

  it('accepts valid audio format request', () => {
    const res1 = validateAndMapFormat({ type: 'audio' });
    assert.strictEqual(res1.valid, true);
    assert.strictEqual(res1.isAudioOnly, true);
    assert.strictEqual(res1.audioSelector, 'bestaudio[ext=m4a]/bestaudio/best');

    const res2 = validateAndMapFormat({ format: 'bestaudio[ext=m4a]/bestaudio' });
    assert.strictEqual(res2.valid, true);
    assert.strictEqual(res2.isAudioOnly, true);
  });

  it('rejects unknown format identifier', () => {
    const res = validateAndMapFormat({ format: 'random_custom_format' });
    assert.strictEqual(res.valid, false);
  });

  it('rejects arbitrary yt-dlp selector with shell injection / command options', () => {
    const res1 = validateAndMapFormat({ format: '--exec rm -rf /' });
    assert.strictEqual(res1.valid, false);

    const res2 = validateAndMapFormat({ quality: '1080; echo pwned' });
    assert.strictEqual(res2.valid, false);

    const res3 = validateAndMapFormat({ format: 'bestvideo[height<=1080]&touch hack.txt' });
    assert.strictEqual(res3.valid, false);
  });

  it('rejects negative or invalid heights', () => {
    assert.strictEqual(validateAndMapFormat({ quality: '-1080' }).valid, false);
    assert.strictEqual(validateAndMapFormat({ quality: '99999' }).valid, false);
    assert.strictEqual(validateAndMapFormat({ quality: 'abc' }).valid, false);
  });

  console.log('\n--- 3. Filename Sanitization Tests ---');
  it('strips directory traversal (..)', () => {
    const res = sanitizeFilename('../../etc/passwd');
    assert.strictEqual(res.includes('..'), false);
    assert.strictEqual(res.includes('/'), false);
    assert.strictEqual(res, 'etc_passwd');
  });

  it('strips Windows path separators and invalid characters', () => {
    const res = sanitizeFilename('C:\\Windows\\System32\\calc.exe');
    assert.strictEqual(res.includes('\\'), false);
    assert.strictEqual(res.includes(':'), false);
  });

  it('strips CR and LF injection characters', () => {
    const res = sanitizeFilename("malicious\r\nContent-Type: text/html\r\n");
    assert.strictEqual(res.includes('\r'), false);
    assert.strictEqual(res.includes('\n'), false);
  });

  it('strips control characters', () => {
    const res = sanitizeFilename("test\x00\x1f\x7fvideo");
    assert.strictEqual(res, 'testvideo');
  });

  it('protects Windows reserved device names', () => {
    assert.strictEqual(sanitizeFilename('CON'), 'CON_file');
    assert.strictEqual(sanitizeFilename('PRN'), 'PRN_file');
    assert.strictEqual(sanitizeFilename('NUL'), 'NUL_file');
    assert.strictEqual(sanitizeFilename('COM1'), 'COM1_file');
  });

  it('enforces maximum filename length', () => {
    const long = 'A'.repeat(200);
    const res = sanitizeFilename(long);
    assert.ok(res.length <= 100);
  });

  it('provides safe fallback if empty', () => {
    assert.strictEqual(sanitizeFilename(''), 'media_download');
    assert.strictEqual(sanitizeFilename('   '), 'media_download');
    assert.strictEqual(sanitizeFilename('...'), 'media_download');
  });

  console.log('\n--- 4. Concurrency Semaphore Tests ---');
  it('enforces concurrency limit and slot acquisition', () => {
    // Current active should start at 0
    assert.strictEqual(getActiveDownloads(), 0);

    // Acquire up to default limit (3)
    assert.strictEqual(acquireDownloadSlot(), true);
    assert.strictEqual(acquireDownloadSlot(), true);
    assert.strictEqual(acquireDownloadSlot(), true);
    assert.strictEqual(getActiveDownloads(), 3);

    // 4th slot should be rejected
    assert.strictEqual(acquireDownloadSlot(), false);
    assert.strictEqual(getActiveDownloads(), 3);

    // Release slots
    releaseDownloadSlot();
    assert.strictEqual(getActiveDownloads(), 2);
    releaseDownloadSlot();
    releaseDownloadSlot();
    assert.strictEqual(getActiveDownloads(), 0);

    // Guard against negative values
    releaseDownloadSlot();
    assert.strictEqual(getActiveDownloads(), 0);
  });

  console.log('\n--- 5. Disk Space Check ---');
  await (async () => {
    const disk = await checkDiskSpace();
    assert.strictEqual(typeof disk.ok, 'boolean');
    assert.ok(disk.freeBytes > 0 || disk.freeBytes === -1);
    console.log(`  ✓ Disk check passed: ${Math.round(disk.freeBytes / 1024 / 1024)} MB available`);
    passed++;
  })();

  console.log('\n--- 6. Process Lifecycle & Timeout Tests ---');
  await (async () => {
    // Test command timeout
    let timedOut = false;
    try {
      // Ping localhost with 5 second duration, but with 200ms timeout
      const pingCmd = process.platform === 'win32' ? 'ping' : 'sleep';
      const pingArgs = process.platform === 'win32' ? ['127.0.0.1', '-n', '5'] : ['5'];
      await runCommandWithLifecycle(pingCmd, pingArgs, { timeoutMs: 200 });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'ETIMEDOUT') {
        timedOut = true;
      }
    }
    assert.strictEqual(timedOut, true, 'Command should be killed and reject with ETIMEDOUT');
    console.log('  ✓ Command timeout correctly terminated subprocess and rejected with ETIMEDOUT');
    passed++;
  })();

  await (async () => {
    // Test client abort signal
    let aborted = false;
    const controller = new AbortController();
    try {
      const pingCmd = process.platform === 'win32' ? 'ping' : 'sleep';
      const pingArgs = process.platform === 'win32' ? ['127.0.0.1', '-n', '5'] : ['5'];
      const promise = runCommandWithLifecycle(pingCmd, pingArgs, {
        timeoutMs: 5000,
        clientSignal: controller.signal,
      });
      // Abort after 150ms
      setTimeout(() => controller.abort(), 150);
      await promise;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'ECONNABORTED') {
        aborted = true;
      }
    }
    assert.strictEqual(aborted, true, 'Command should be killed and reject with ECONNABORTED');
    console.log('  ✓ Client abort signal correctly terminated subprocess and rejected with ECONNABORTED');
    passed++;
  })();

  console.log(`\n========================================`);
  console.log(`Total tests passed: ${passed}, failed: ${failed}`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
