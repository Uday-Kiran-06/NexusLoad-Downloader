import { NextResponse } from 'next/server';
import { create } from 'youtube-dl-exec';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getCookiesPath, cleanupCookiesFile } from '@/lib/utils';

// Construct all binary paths dynamically depending on target OS, with fallback to global installations
const isWin = os.platform() === 'win32';

const localYtDlp = path.join(
  process.cwd(),
  'node_modules',
  'youtube-dl-exec',
  'bin',
  isWin ? 'yt-dlp.exe' : 'yt-dlp'
);
// On Linux/Render, prioritize the global Nix-installed 'yt-dlp' package which is kept up-to-date
const ytDlpPath = isWin
  ? (fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp')
  : 'yt-dlp';

const localFfmpeg = path.join(
  process.cwd(),
  'node_modules',
  'ffmpeg-static',
  isWin ? 'ffmpeg.exe' : 'ffmpeg'
);
const ffmpegPath = fs.existsSync(localFfmpeg) ? localFfmpeg : 'ffmpeg';

const youtubedl = create(ytDlpPath);
ffmpeg.setFfmpegPath(ffmpegPath);

export const dynamic = 'force-dynamic';

// Helper to clean up temp directories safely, handling EBUSY lock errors by retrying after a short delay
function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[download] Initial cleanup of ${dir} failed (resource busy/locked). Retrying in 5s...`);
    setTimeout(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[download] Delayed cleanup of ${dir} succeeded.`);
      } catch (retryError) {
        // Ignore silent failure on retry to prevent crashing
      }
    }, 5000);
  }
}

export async function GET(req: Request) {
  const cookiesPath = getCookiesPath();
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  const format = searchParams.get('format') || 'best';
  const title = searchParams.get('title') || 'media_download';

  if (!url) return new NextResponse('Invalid URL', { status: 400 });

  const isAudioOnly = format.includes('bestaudio') && !format.includes('bestvideo');
  const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const tmpDir = path.join(os.tmpdir(), `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const commonArgs: any = {
      noWarnings: true,
      extractorArgs: 'youtube:player_client=all',
      concurrentFragments: 8,   // download 8 DASH fragments in parallel
      bufferSize: '16K',        // larger read buffer for faster streaming
    };
    if (cookiesPath) {
      commonArgs.cookies = cookiesPath;
    }

    if (isAudioOnly) {
      // ── Audio only: single download, no merge needed ──────────────────────
      const audioFile = path.join(tmpDir, 'audio.%(ext)s');
      await youtubedl(url, { ...commonArgs, output: audioFile, format: 'bestaudio[ext=m4a]/bestaudio' });

      const files = fs.readdirSync(tmpDir).filter(f => !f.endsWith('.part'));
      if (files.length === 0) throw new Error('Audio download failed — no file created');

      const outPath = path.join(tmpDir, files[0]);
      const ext = path.extname(files[0]).replace('.', '') || 'm4a';
      const buf = fs.readFileSync(outPath);
      safeCleanup(tmpDir);

      return new NextResponse(buf, {
        headers: {
          'Content-Type': 'audio/mp4',
          'Content-Disposition': `attachment; filename="${safeTitle}.${ext}"`,
          'Content-Length': String(buf.length),
        },
      });

    } else {
      // ── Video: download streams separately, merge with fluent-ffmpeg ───────

      // Parse height from format string e.g. "bestvideo[height<=1080]+bestaudio/..."
      const heightMatch = format.match(/height<=(\d+)/);
      const height = heightMatch ? heightMatch[1] : '1080';

      const videoFile = path.join(tmpDir, 'video.mp4');
      const audioFile = path.join(tmpDir, 'audio.m4a');
      const mergedFile = path.join(tmpDir, 'merged.mp4');

      console.log(`[download] Downloading video (${height}p) and audio separately...`);

      // Download video-only and audio-only streams in parallel
      await Promise.all([
        youtubedl(url, { ...commonArgs, output: videoFile, format: `bestvideo[height<=${height}][ext=mp4]/bestvideo[height<=${height}]` }),
        youtubedl(url, { ...commonArgs, output: audioFile, format: 'bestaudio[ext=m4a]/bestaudio' }),
      ]);

      // Find the actual downloaded video file (yt-dlp may change the filename)
      const videoFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('video') && !f.endsWith('.part'));
      const audioFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('audio') && !f.endsWith('.part'));

      if (videoFiles.length === 0) throw new Error('Video stream download failed');
      if (audioFiles.length === 0) throw new Error('Audio stream download failed');

      const actualVideoFile = path.join(tmpDir, videoFiles[0]);
      const actualAudioFile = path.join(tmpDir, audioFiles[0]);

      console.log(`[download] Merging: ${videoFiles[0]} + ${audioFiles[0]}`);

      // Merge with fluent-ffmpeg (uses our local ffmpeg-static binary)
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(actualVideoFile)
          .input(actualAudioFile)
          .outputOptions(['-c:v copy', '-c:a copy', '-movflags +faststart']) // copy audio — no re-encode, near-instant
          .output(mergedFile)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      const buf = fs.readFileSync(mergedFile);
      safeCleanup(tmpDir);

      return new NextResponse(buf, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="${safeTitle}.mp4"`,
          'Content-Length': String(buf.length),
        },
      });
    }

  } catch (error: any) {
    safeCleanup(tmpDir);
    const msg = error?.stderr || error?.message || String(error);
    console.error('Download route error:', msg);
    return new NextResponse('Failed: ' + msg, { status: 500 });
  } finally {
    cleanupCookiesFile(cookiesPath);
  }
}


