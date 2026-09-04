import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 1. Load validation functions
const {
  isPrivateIPv4,
  isPrivateIPv6,
  validateUrlForDownload,
} = await import('../src/lib/validation.ts');

const {
  killProcessTree,
  runCommandWithLifecycle
} = await import('../src/lib/process-manager.ts');

const {
  getCookiesPath,
  cleanupCookiesFile
} = await import('../src/lib/utils.ts');

const {
  createFileStreamResponse
} = await import('../src/lib/stream-helper.ts');

test('1. SSRF URL and IP Classification Tests', async (t) => {
  await t.test('IPv4 Private & Reserved CIDRs are rejected', () => {
    // 0.0.0.0/8
    assert.equal(isPrivateIPv4('0.0.0.1'), true);
    // 10.0.0.0/8
    assert.equal(isPrivateIPv4('10.0.0.1'), true);
    assert.equal(isPrivateIPv4('10.255.255.255'), true);
    // 100.64.0.0/10
    assert.equal(isPrivateIPv4('100.64.0.1'), true);
    assert.equal(isPrivateIPv4('100.127.255.255'), true);
    assert.equal(isPrivateIPv4('100.128.0.1'), false);
    // 127.0.0.0/8
    assert.equal(isPrivateIPv4('127.0.0.1'), true);
    assert.equal(isPrivateIPv4('127.255.255.255'), true);
    // 169.254.0.0/16
    assert.equal(isPrivateIPv4('169.254.169.254'), true);
    // 172.16.0.0/12
    assert.equal(isPrivateIPv4('172.16.0.1'), true);
    assert.equal(isPrivateIPv4('172.31.255.255'), true);
    assert.equal(isPrivateIPv4('172.32.0.1'), false);
    // 192.0.0.0/24
    assert.equal(isPrivateIPv4('192.0.0.1'), true);
    // 192.0.2.0/24
    assert.equal(isPrivateIPv4('192.0.2.1'), true);
    // 192.168.0.0/16
    assert.equal(isPrivateIPv4('192.168.1.1'), true);
    assert.equal(isPrivateIPv4('192.168.255.255'), true);
    // 198.18.0.0/15
    assert.equal(isPrivateIPv4('198.18.0.1'), true);
    assert.equal(isPrivateIPv4('198.19.255.255'), true);
    // 198.51.100.0/24
    assert.equal(isPrivateIPv4('198.51.100.1'), true);
    // 203.0.113.0/24
    assert.equal(isPrivateIPv4('203.0.113.1'), true);
    // 224.0.0.0/4 (Multicast)
    assert.equal(isPrivateIPv4('224.0.0.1'), true);
    assert.equal(isPrivateIPv4('239.255.255.255'), true);
    // 240.0.0.0/4 (Reserved)
    assert.equal(isPrivateIPv4('240.0.0.1'), true);
    assert.equal(isPrivateIPv4('255.255.255.255'), true);
    // Public IPv4
    assert.equal(isPrivateIPv4('8.8.8.8'), false);
    assert.equal(isPrivateIPv4('1.1.1.1'), false);
  });

  await t.test('IPv6 Private & Reserved CIDRs are rejected', () => {
    // ::/128
    assert.equal(isPrivateIPv6('::'), true);
    // ::1/128
    assert.equal(isPrivateIPv6('::1'), true);
    // fc00::/7
    assert.equal(isPrivateIPv6('fc00::1'), true);
    assert.equal(isPrivateIPv6('fd12:3456:789a::1'), true);
    // fe80::/10
    assert.equal(isPrivateIPv6('fe80::1'), true);
    // ff00::/8
    assert.equal(isPrivateIPv6('ff02::1'), true);
    // 2001:db8::/32
    assert.equal(isPrivateIPv6('2001:db8::1'), true);
    // IPv4-mapped IPv6
    assert.equal(isPrivateIPv6('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIPv6('::ffff:192.168.1.1'), true);
    assert.equal(isPrivateIPv6('::ffff:10.0.0.1'), true);
    assert.equal(isPrivateIPv6('::ffff:8.8.8.8'), false);
    // Public IPv6
    assert.equal(isPrivateIPv6('2607:f8b0:4005:805::200e'), false);
  });

  await t.test('validateUrlForDownload rejects internal and loopback URLs', async () => {
    const internalUrls = [
      'http://127.0.0.1',
      'http://127.0.0.1:8080/path',
      'http://localhost',
      'http://localhost:3000',
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://192.168.1.1',
      'http://169.254.169.254',
      'http://[::1]',
      'http://[fc00::1]',
      'http://[fe80::1]',
      'http://[::ffff:192.168.1.1]',
      'http://[::ffff:127.0.0.1]',
    ];

    for (const url of internalUrls) {
      const result = await validateUrlForDownload(url);
      assert.equal(result.valid, false, `Expected ${url} to be rejected`);
      assert.match(result.error || '', /safely resolved|forbidden/i);
    }
  });

  await t.test('validateUrlForDownload allows valid public hostnames', async () => {
    const publicUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = await validateUrlForDownload(publicUrl);
    assert.equal(result.valid, true);
    assert.ok(result.normalizedUrl);
  });

  await t.test('validateUrlForDownload safely handles DNS lookup failures', async () => {
    const invalidDomain = 'http://this-domain-does-not-exist-at-all-nexusload-12345.com';
    const result = await validateUrlForDownload(invalidDomain);
    assert.equal(result.valid, false);
    assert.equal(result.error, 'URL host could not be safely resolved.');
  });
});

test('2. Process Management Lifecycle & Termination Tests', async (t) => {
  await t.test('killProcessTree ignores invalid or parent PID', () => {
    // Must safely return without throwing or signaling parent
    killProcessTree(undefined);
    killProcessTree(0);
    killProcessTree(-1);
    killProcessTree(1);
    killProcessTree(process.pid);
  });

  await t.test('runCommandWithLifecycle abort signal terminates cleanly', async () => {
    const controller = new AbortController();
    const startTime = Date.now();

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);

    const isWin = os.platform() === 'win32';
    const cmd = isWin ? 'ping' : 'sleep';
    const args = isWin ? ['-n', '5', '127.0.0.1'] : ['5'];

    await assert.rejects(
      runCommandWithLifecycle(cmd, args, {
        timeoutMs: 10000,
        clientSignal: controller.signal,
      }),
      (err) => {
        assert.equal(err.code, 'ECONNABORTED');
        return true;
      }
    );

    assert.ok(Date.now() - startTime < 3000, 'Process aborted promptly');
  });

  await t.test('runCommandWithLifecycle timeout terminates cleanly', async () => {
    const isWin = os.platform() === 'win32';
    const cmd = isWin ? 'ping' : 'sleep';
    const args = isWin ? ['-n', '5', '127.0.0.1'] : ['5'];

    const startTime = Date.now();
    await assert.rejects(
      runCommandWithLifecycle(cmd, args, {
        timeoutMs: 200,
      }),
      (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        return true;
      }
    );

    assert.ok(Date.now() - startTime < 3000, 'Process timed out promptly');
  });
});

test('3. Temporary Cookie File Security Tests', async (t) => {
  await t.test('getCookiesPath creates file with restrictive permissions and cleanup works', () => {
    const sampleCookie = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tSampleSecretSession\n';
    process.env.YT_COOKIES = sampleCookie;

    const cookiePath = getCookiesPath();
    assert.ok(cookiePath, 'Cookies path should be returned');
    assert.ok(fs.existsSync(cookiePath), 'Cookies file should exist');

    const stat = fs.statSync(cookiePath);
    if (os.platform() !== 'win32') {
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, 'Cookie file mode should be 0600 on POSIX');
    }

    // Verify cleanup
    cleanupCookiesFile(cookiePath);
    assert.equal(fs.existsSync(cookiePath), false, 'Cookie file should be unlinked after cleanup');
    delete process.env.YT_COOKIES;
  });
});

test('4. Streaming & Backpressure Tests', async (t) => {
  const tmpMedia = path.join(os.tmpdir(), `stream_test_${Date.now()}.mp4`);
  // Create a 64KB synthetic test file
  const testData = Buffer.alloc(64 * 1024, 0x42);
  fs.writeFileSync(tmpMedia, testData);

  const mockJob = {
    id: 'test-job-stream',
    filePath: tmpMedia,
    fileName: 'test_media.mp4',
    contentType: 'video/mp4',
    activeStreams: 0,
    cleanupPending: false,
  };

  await t.test('Full file stream (200 OK)', async () => {
    const req = new Request('http://localhost/api/download/test-job-stream');
    const res = createFileStreamResponse(req, mockJob);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Length'), String(testData.length));
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');

    const reader = res.body.getReader();
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
    }
    assert.equal(received, testData.length);
    assert.equal(mockJob.activeStreams, 0);
  });

  await t.test('Single byte range bytes=0-0 (206 Partial Content)', async () => {
    const req = new Request('http://localhost/api/download/test-job-stream', {
      headers: { range: 'bytes=0-0' },
    });
    const res = createFileStreamResponse(req, mockJob);
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), `bytes 0-0/${testData.length}`);
    assert.equal(res.headers.get('Content-Length'), '1');

    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.equal(value.length, 1);
    assert.equal(value[0], 0x42);
    const finish = await reader.read();
    assert.equal(finish.done, true);
    assert.equal(mockJob.activeStreams, 0);
  });

  await t.test('Last byte range bytes=last-last (206 Partial Content)', async () => {
    const lastByte = testData.length - 1;
    const req = new Request('http://localhost/api/download/test-job-stream', {
      headers: { range: `bytes=${lastByte}-${lastByte}` },
    });
    const res = createFileStreamResponse(req, mockJob);
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), `bytes ${lastByte}-${lastByte}/${testData.length}`);
    assert.equal(res.headers.get('Content-Length'), '1');

    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.equal(value.length, 1);
    const finish = await reader.read();
    assert.equal(finish.done, true);
    assert.equal(mockJob.activeStreams, 0);
  });

  await t.test('Node stream error handles failure without controller.close()', async () => {
    // Create an invalid/unreadable file situation or destroy early
    const errJob = {
      id: 'test-job-err',
      filePath: tmpMedia,
      fileName: 'test_err.mp4',
      contentType: 'video/mp4',
      activeStreams: 0,
      cleanupPending: false,
    };

    const req = new Request('http://localhost/api/download/test-job-err');
    const res = createFileStreamResponse(req, errJob);
    const reader = res.body.getReader();

    // Cause an error on the stream by calling cancel/error
    await reader.cancel('simulated client error');
    assert.equal(errJob.activeStreams, 0);
  });

  await t.test('Prefix range bytes=5000- (206 Partial Content)', async () => {
    const req = new Request('http://localhost/api/download/test-job-stream', {
      headers: { range: 'bytes=5000-' },
    });
    const res = createFileStreamResponse(req, mockJob);
    assert.equal(res.status, 206);
    const expectedLen = testData.length - 5000;
    assert.equal(res.headers.get('Content-Length'), String(expectedLen));
    assert.equal(res.headers.get('Content-Range'), `bytes 5000-${testData.length - 1}/${testData.length}`);

    const reader = res.body.getReader();
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
    }
    assert.equal(received, expectedLen);
    assert.equal(mockJob.activeStreams, 0);
  });

  await t.test('Suffix range bytes=-100 (206 Partial Content)', async () => {
    const req = new Request('http://localhost/api/download/test-job-stream', {
      headers: { range: 'bytes=-100' },
    });
    const res = createFileStreamResponse(req, mockJob);
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Length'), '100');
    assert.equal(res.headers.get('Content-Range'), `bytes ${testData.length - 100}-${testData.length - 1}/${testData.length}`);

    const reader = res.body.getReader();
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
    }
    assert.equal(received, 100);
    assert.equal(mockJob.activeStreams, 0);
  });

  await t.test('Inverted range bytes=500-100 returns 416 Range Not Satisfiable', async () => {
    const req = new Request('http://localhost/api/download/test-job-stream', {
      headers: { range: 'bytes=500-100' },
    });
    const res = createFileStreamResponse(req, mockJob);
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('Content-Range'), `bytes */${testData.length}`);
  });

  await t.test('Zero suffix bytes=-0 returns 416 Range Not Satisfiable', async () => {
    const req = new Request('http://localhost/api/download/test-job-stream', {
      headers: { range: 'bytes=-0' },
    });
    const res = createFileStreamResponse(req, mockJob);
    assert.equal(res.status, 416);
  });

  await t.test('Client stream cancellation releases activeStreams cleanly', async () => {
    const req = new Request('http://localhost/api/download/test-job-stream');
    const res = createFileStreamResponse(req, mockJob);
    const reader = res.body.getReader();

    // Read initial chunk then cancel
    const chunk = await reader.read();
    assert.ok(chunk.value.length > 0);
    assert.equal(mockJob.activeStreams, 1);

    await reader.cancel();
    assert.equal(mockJob.activeStreams, 0);
  });

  fs.unlinkSync(tmpMedia);
});

test('5. Download Route Integration Tests (SSRF Rejection before Job Creation)', async (t) => {
  const { POST } = await import('../src/app/api/download/route.ts');

  const dangerousUrls = [
    'http://127.0.0.1/test',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:8080/test',
    'http://[::1]/test',
    'http://10.0.0.1/exploit',
    'http://192.168.1.1/admin',
    'http://this-does-not-exist-123987123987.com/test',
  ];

  for (const url of dangerousUrls) {
    await t.test(`POST /api/download rejects dangerous URL: ${url}`, async () => {
      const req = new Request('http://localhost:3000/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type: 'video', quality: '360' }),
      });
      const res = await POST(req);
      const json = await res.json();
      assert.equal(res.status, 400);
      assert.equal(json.error, 'INVALID_URL');
      assert.match(json.message, /safely resolved|forbidden/i);
    });
  }
});
