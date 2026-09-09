import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAndMapFormat } from '../src/lib/validation.ts';

test('Contract & Security Regression: Server-Controlled Format Identifiers', async (t) => {
  await t.test('1. Valid semantic video and audio requests succeed', () => {
    // video + 240p
    const v240 = validateAndMapFormat({ type: 'video', quality: '240p', format: 'mp4' });
    assert.equal(v240.valid, true);
    assert.equal(v240.height, 240);
    assert.equal(v240.isAudioOnly, false);
    assert.ok(v240.videoSelector?.includes('height<=240'));

    // video + 360p
    const v360 = validateAndMapFormat({ type: 'video', quality: '360p', format: 'mp4' });
    assert.equal(v360.valid, true);
    assert.equal(v360.height, 360);
    assert.ok(v360.videoSelector?.includes('height<=360'));

    // video + 720p
    const v720 = validateAndMapFormat({ type: 'video', quality: '720p', format: 'mp4' });
    assert.equal(v720.valid, true);
    assert.equal(v720.height, 720);
    assert.ok(v720.videoSelector?.includes('height<=720'));

    // video + 1080p
    const v1080 = validateAndMapFormat({ type: 'video', quality: '1080p', format: 'mp4' });
    assert.equal(v1080.valid, true);
    assert.equal(v1080.height, 1080);
    assert.ok(v1080.videoSelector?.includes('height<=1080'));

    // audio + MP3
    const aMp3 = validateAndMapFormat({ type: 'audio', format: 'mp3' });
    assert.equal(aMp3.valid, true);
    assert.equal(aMp3.isAudioOnly, true);
    assert.equal(aMp3.isMp3, true);
    assert.equal(aMp3.mp3Bitrate, '192k');
    assert.ok(aMp3.audioSelector);

    // audio + MP3 with explicit bitrate
    const aMp3Explicit = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: '320k' });
    assert.equal(aMp3Explicit.valid, true);
    assert.equal(aMp3Explicit.mp3Bitrate, '320k');
  });

  await t.test('2. Valid formatId identifiers resolve to trusted selectors', () => {
    // formatId video_240p
    const fid240 = validateAndMapFormat({ formatId: 'video_240p' });
    assert.equal(fid240.valid, true);
    assert.equal(fid240.height, 240);
    assert.ok(fid240.videoSelector?.includes('height<=240'));

    // formatId video_720p
    const fid720 = validateAndMapFormat({ formatId: 'video_720p' });
    assert.equal(fid720.valid, true);
    assert.equal(fid720.height, 720);

    // formatId video_best
    const fidBest = validateAndMapFormat({ formatId: 'video_best' });
    assert.equal(fidBest.valid, true);
    assert.equal(fidBest.isBestQuality, true);

    // formatId audio_m4a
    const fidM4a = validateAndMapFormat({ formatId: 'audio_m4a' });
    assert.equal(fidM4a.valid, true);
    assert.equal(fidM4a.isAudioOnly, true);
    assert.equal(fidM4a.isMp3, false);

    // formatId audio_mp3
    const fidMp3 = validateAndMapFormat({ formatId: 'audio_mp3' });
    assert.equal(fidMp3.valid, true);
    assert.equal(fidMp3.isMp3, true);
    assert.equal(fidMp3.mp3Bitrate, '192k');

    // formatId audio_mp3_256k
    const fidMp3_256 = validateAndMapFormat({ formatId: 'audio_mp3_256k' });
    assert.equal(fidMp3_256.valid, true);
    assert.equal(fidMp3_256.mp3Bitrate, '256k');

    // UI client requests with friendly labels e.g. "MP3 (192 kbps)", "Audio Only", "Best Available"
    const uiMp3 = validateAndMapFormat({
      type: 'audio',
      quality: 'MP3 (192 kbps)',
      format: 'mp3',
      formatId: 'audio_mp3_192k',
    });
    assert.equal(uiMp3.valid, true);
    assert.equal(uiMp3.isAudioOnly, true);
    assert.equal(uiMp3.isMp3, true);
    assert.equal(uiMp3.mp3Bitrate, '192k');

    const uiM4a = validateAndMapFormat({
      type: 'audio',
      quality: 'Audio Only',
      format: 'm4a',
      formatId: 'audio_m4a',
    });
    assert.equal(uiM4a.valid, true);
    assert.equal(uiM4a.isAudioOnly, true);
    assert.equal(uiM4a.isMp3, false);

    const uiBest = validateAndMapFormat({
      quality: 'Best Available',
      formatId: 'video_best',
    });
    assert.equal(uiBest.valid, true);
    assert.equal(uiBest.isBestQuality, true);
  });

  await t.test('3. Raw yt-dlp selectors from client are rejected', () => {
    // Raw selector with brackets and comparisons
    const raw1 = validateAndMapFormat({
      format: 'bestvideo[height<=240]+bestaudio/best[height<=240]',
    });
    assert.equal(raw1.valid, false);
    assert.equal(raw1.error, 'Disallowed characters in format request.');

    // Raw selector with filters
    const raw2 = validateAndMapFormat({
      format: 'bestvideo[ext=mp4]+bestaudio',
    });
    assert.equal(raw2.valid, false);
  });

  await t.test('4. Shell injection and malicious inputs are strictly rejected', () => {
    const malicious = [
      'bestvideo | whoami',
      '$(whoami)',
      '`whoami`',
      ';whoami',
      '&&whoami',
      '../something',
      '--exec rm -rf /',
      'bestvideo; echo pwned',
      'bestvideo && echo pwned',
      'bestvideo > /tmp/hacked',
      'bestvideo < /etc/passwd',
    ];

    for (const input of malicious) {
      const resFormat = validateAndMapFormat({ format: input });
      assert.equal(resFormat.valid, false, `Expected '${input}' in format to be rejected`);

      const resQuality = validateAndMapFormat({ quality: input });
      assert.equal(resQuality.valid, false, `Expected '${input}' in quality to be rejected`);

      const resFid = validateAndMapFormat({ formatId: input });
      assert.equal(resFid.valid, false, `Expected '${input}' in formatId to be rejected`);
    }
  });

  await t.test('5. Arbitrary FFmpeg options and invalid bitrates are rejected', () => {
    const res1 = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: '-filter:a vol=2' });
    assert.equal(res1.valid, false);

    const res2 = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: '500k' });
    assert.equal(res2.valid, false);

    const res3 = validateAndMapFormat({ type: 'audio', format: 'mp3', bitrate: 'invalid' });
    assert.equal(res3.valid, false);
  });

  await t.test('6. Unknown format IDs and unknown qualities are rejected', () => {
    assert.equal(validateAndMapFormat({ formatId: 'video_999p' }).valid, false);
    assert.equal(validateAndMapFormat({ formatId: 'audio_flac' }).valid, false);
    assert.equal(validateAndMapFormat({ formatId: 'unknown_format' }).valid, false);

    assert.equal(validateAndMapFormat({ type: 'video', quality: '999p' }).valid, false);
    assert.equal(validateAndMapFormat({ type: 'video', quality: 'super_hd' }).valid, false);
    assert.equal(validateAndMapFormat({ format: 'random_custom_format' }).valid, false);
  });

  await t.test('7. Contradictory type/format combinations are rejected', () => {
    // Video type with MP3
    assert.equal(validateAndMapFormat({ type: 'video', format: 'mp3' }).valid, false);
    assert.equal(validateAndMapFormat({ type: 'video', quality: 'mp3' }).valid, false);
    assert.equal(validateAndMapFormat({ type: 'video', bitrate: '192k' }).valid, false);

    // Audio type with video quality
    assert.equal(validateAndMapFormat({ type: 'audio', quality: '1080p' }).valid, false);
    assert.equal(validateAndMapFormat({ type: 'audio', quality: '720p' }).valid, false);

    // Video type with audio quality
    assert.equal(validateAndMapFormat({ type: 'video', quality: 'audio' }).valid, false);

    // Video resolution with MP3 format
    assert.equal(validateAndMapFormat({ quality: '1080p', format: 'mp3' }).valid, false);
  });

  await t.test('8. Quality bounding strictly enforced (no silent upgrade)', () => {
    const res = validateAndMapFormat({ type: 'video', quality: '240p', format: 'mp4' });
    assert.equal(res.valid, true);
    assert.equal(res.height, 240);
    assert.ok(res.videoSelector?.includes('height<=240'));
    assert.ok(!res.videoSelector?.endsWith('/best'));
    assert.ok(!res.videoSelector?.endsWith('/bestvideo'));
  });
});
