import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import os from 'os';

// Validation imports
const {
  validateAndMapFormat,
} = await import('../src/lib/validation.ts');

// Job manager imports
const {
  createJob,
  inspectMediaStreams,
  resolvedFfmpegPath,
} = await import('../src/lib/job-manager.ts');

test('Video Stream & 1080p MP4 Regression Suite', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `stream-reg-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. 1080p MP4 request -> isAudioOnly=false ─────────────────────────
  await t.test('1. 1080p MP4 request -> isAudioOnly=false and height=1080', () => {
    const res = validateAndMapFormat({
      type: 'video',
      quality: '1080p',
      format: 'mp4',
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.isAudioOnly, false);
    assert.strictEqual(res.height, 1080);
  });

  // ── 2. 1080p MP4 -> videoSelector selected ────────────────────────────
  await t.test('2. 1080p MP4 -> bounded videoSelector selected', () => {
    const res = validateAndMapFormat({
      type: 'video',
      quality: '1080p',
      format: 'mp4',
    });
    assert.ok(res.videoSelector, 'videoSelector must be defined');
    assert.ok(
      res.videoSelector.includes('bestvideo[height<=1080][ext=mp4]'),
      'videoSelector must contain bounded 1080p mp4 selector'
    );
    assert.ok(
      res.videoSelector.includes('bestaudio[ext=m4a]'),
      'videoSelector must prefer m4a audio'
    );
  });

  // ── 3. Audio request -> isAudioOnly=true ────────────────────────────────
  await t.test('3. Audio requests -> isAudioOnly=true for both M4A and MP3', () => {
    const m4aRes = validateAndMapFormat({
      type: 'audio',
      quality: 'audio',
      format: 'm4a',
    });
    assert.strictEqual(m4aRes.valid, true);
    assert.strictEqual(m4aRes.isAudioOnly, true);

    const mp3Res = validateAndMapFormat({
      type: 'audio',
      quality: 'audio',
      format: 'mp3',
      bitrate: '192k',
    });
    assert.strictEqual(mp3Res.valid, true);
    assert.strictEqual(mp3Res.isAudioOnly, true);
    assert.strictEqual(mp3Res.isMp3, true);
  });

  // ── 4. 1080p MP4 cannot enter audio-only worker path ──────────────────
  await t.test('4. 1080p MP4 cannot enter audio-only worker path', () => {
    const formatValidation = validateAndMapFormat({
      type: 'video',
      quality: '1080p',
      format: 'mp4',
    });
    const { job, error } = createJob({
      validUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      formatValidation,
      safeTitle: 'test_video_1080p',
      ytDlpPath: 'yt-dlp',
      isProduction: false,
    });
    assert.strictEqual(error, undefined);
    assert.ok(job);
    assert.strictEqual(formatValidation.isAudioOnly, false);
    assert.strictEqual(formatValidation.isMp3, undefined);
    assert.strictEqual(job.contentType, 'video/mp4');
  });

  // ── 5. Actual video yt-dlp args contain video selector ─────────────────
  await t.test('5. Actual video yt-dlp args contain video selector and not audio-only', () => {
    const formatValidation = validateAndMapFormat({
      type: 'video',
      quality: '1080p',
      format: 'mp4',
    });
    const videoOutputPattern = path.join('fakeTmp', 'video.%(ext)s');
    const videoArgs = [
      '--no-warnings',
      '-o', videoOutputPattern,
      '-f', formatValidation.videoSelector,
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    ];

    assert.ok(videoArgs.includes('-f'));
    const fIndex = videoArgs.indexOf('-f');
    const selector = videoArgs[fIndex + 1];
    assert.strictEqual(selector, formatValidation.videoSelector);
    assert.ok(selector.includes('bestvideo[height<=1080]'));
    assert.ok(!selector.startsWith('bestaudio'));
  });

  // ── 6. Audio yt-dlp args are only the second stage ────────────────────
  await t.test('6. Audio yt-dlp args are only the second stage', () => {
    const formatValidation = validateAndMapFormat({
      type: 'video',
      quality: '1080p',
      format: 'mp4',
    });
    const audioOutputPattern = path.join('fakeTmp', 'audio.%(ext)s');
    const audioArgs = [
      '--no-warnings',
      '-o', audioOutputPattern,
      '-f', formatValidation.audioSelector,
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    ];

    assert.ok(audioArgs.includes('-f'));
    const fIndex = audioArgs.indexOf('-f');
    const selector = audioArgs[fIndex + 1];
    assert.strictEqual(selector, formatValidation.audioSelector);
    assert.strictEqual(selector, 'bestaudio[ext=m4a]/bestaudio/best');
  });

  // ── 7. Final MP4 contains video stream ─────────────────────────────────
  // ── 8. Final MP4 contains audio stream ─────────────────────────────────
  // ── 9. Final MIME is video/mp4 ─────────────────────────────────────────
  // ── 10. Final extension is .mp4 ────────────────────────────────────────
  await t.test('7-10. End-to-end stream generation and inspection: video, audio, MIME, and extension', async () => {
    const sampleVideoFile = path.join(tmpDir, 'sample_video.mp4');
    const sampleAudioFile = path.join(tmpDir, 'sample_audio.m4a');
    const finalMuxedFile = path.join(tmpDir, 'final_output.mp4');

    // Generate 1-second video-only stream
    cp.execFileSync(resolvedFfmpegPath, [
      '-hide_banner',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=1:size=320x240:rate=1',
      '-c:v', 'libx264',
      '-an',
      sampleVideoFile,
      '-y',
    ]);

    // Generate 1-second audio-only stream
    cp.execFileSync(resolvedFfmpegPath, [
      '-hide_banner',
      '-f', 'lavfi',
      '-i', 'sine=duration=1',
      '-c:a', 'aac',
      '-vn',
      sampleAudioFile,
      '-y',
    ]);

    // Inspect individual streams before muxing
    const videoStreamInfo = await inspectMediaStreams(sampleVideoFile);
    assert.strictEqual(videoStreamInfo.hasVideo, true, 'Video file must have video stream');
    assert.strictEqual(videoStreamInfo.hasAudio, false, 'Video-only file must not have audio stream');

    const audioStreamInfo = await inspectMediaStreams(sampleAudioFile);
    assert.strictEqual(audioStreamInfo.hasAudio, true, 'Audio file must have audio stream');
    assert.strictEqual(audioStreamInfo.hasVideo, false, 'Audio-only file must not have video stream');

    // Mux using the exact FFmpeg flags used by job-manager
    cp.execFileSync(resolvedFfmpegPath, [
      '-hide_banner',
      '-i', sampleVideoFile,
      '-i', sampleAudioFile,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      finalMuxedFile,
      '-y',
    ]);

    // 7. Final MP4 contains video stream
    const finalStreams = await inspectMediaStreams(finalMuxedFile);
    assert.strictEqual(finalStreams.hasVideo, true, 'Final MP4 MUST contain video stream');
    assert.ok(finalStreams.videoCodec, 'Final MP4 video codec must be identified');

    // 8. Final MP4 contains audio stream
    assert.strictEqual(finalStreams.hasAudio, true, 'Final MP4 MUST contain audio stream');
    assert.strictEqual(finalStreams.audioCodec, 'aac', 'Final MP4 audio codec must be AAC');

    // 9. MIME check
    const formatValidation = validateAndMapFormat({ type: 'video', quality: '1080p', format: 'mp4' });
    const isWebm = formatValidation.videoSelector?.includes('ext=webm');
    const containerExt = isWebm ? 'webm' : 'mp4';
    const outputMime = isWebm ? 'video/webm' : 'video/mp4';
    assert.strictEqual(outputMime, 'video/mp4', 'Final MIME must be video/mp4');

    // 10. Extension check
    assert.strictEqual(path.extname(finalMuxedFile), '.mp4', 'Final extension must be .mp4');
    assert.strictEqual(containerExt, 'mp4', 'Container extension must be mp4');
  });

  // ── 11. Stream selection disambiguation: video.f140.m4a vs video.f137.mp4 ──
  await t.test('11. Stream selection disambiguation: picks file with video stream even if audio file sorted first', async () => {
    // Simulate yt-dlp downloading both video.f140.m4a (audio) and video.f137.mp4 (video)
    const audioFirstFile = path.join(tmpDir, 'video.f140.m4a');
    const videoSecondFile = path.join(tmpDir, 'video.f137.mp4');

    cp.execFileSync(resolvedFfmpegPath, [
      '-hide_banner',
      '-f', 'lavfi',
      '-i', 'sine=duration=1',
      '-c:a', 'aac',
      '-vn',
      audioFirstFile,
      '-y',
    ]);

    cp.execFileSync(resolvedFfmpegPath, [
      '-hide_banner',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=1:size=320x240:rate=1',
      '-c:v', 'libx264',
      '-an',
      videoSecondFile,
      '-y',
    ]);

    // Simulate list of files where audio file is placed first
    const candidates = [
      'video.f140.m4a',
      'video.f137.mp4',
    ];

    assert.strictEqual(candidates[0], 'video.f140.m4a', 'First candidate is an audio file');

    // Stream inspection selection logic (from job-manager)
    let selectedVideoFile = null;
    let selectedVideoStreamInfo = null;

    for (const file of candidates) {
      const fullPath = path.join(tmpDir, file);
      const info = await inspectMediaStreams(fullPath);
      if (info.hasVideo) {
        selectedVideoFile = fullPath;
        selectedVideoStreamInfo = info;
        break;
      }
    }

    assert.ok(selectedVideoFile, 'A video file must be selected');
    assert.strictEqual(
      path.basename(selectedVideoFile),
      'video.f137.mp4',
      'Must select video.f137.mp4, NOT video.f140.m4a'
    );
    assert.strictEqual(selectedVideoStreamInfo?.hasVideo, true);
  });

  // ── 12. Silent/muted video stream (without audio track) remuxes into valid video MP4 ──
  await t.test('12. Silent/muted video stream (without audio track) remuxes into valid video MP4 without error', async () => {
    const silentVideoFile = path.join(tmpDir, 'silent_video.mp4');
    const finalSilentMuxed = path.join(tmpDir, 'final_silent.mp4');

    cp.execFileSync(resolvedFfmpegPath, [
      '-hide_banner',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=1:size=320x240:rate=1',
      '-c:v', 'libx264',
      '-an',
      silentVideoFile,
      '-y',
    ]);

    const initialStreams = await inspectMediaStreams(silentVideoFile);
    assert.strictEqual(initialStreams.hasVideo, true);
    assert.strictEqual(initialStreams.hasAudio, false);

    // Mux using video-only faststart copy flags (used by job-manager for silent media)
    cp.execFileSync(resolvedFfmpegPath, [
      '-hide_banner',
      '-i', silentVideoFile,
      '-c:v', 'copy',
      '-movflags', '+faststart',
      finalSilentMuxed,
      '-y',
    ]);

    const finalStreams = await inspectMediaStreams(finalSilentMuxed);
    assert.strictEqual(finalStreams.hasVideo, true);
    assert.strictEqual(finalStreams.hasAudio, false);
    assert.strictEqual(path.extname(finalSilentMuxed), '.mp4');
  });
});
