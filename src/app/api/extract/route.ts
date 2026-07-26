import { NextResponse } from 'next/server';
import { create } from 'youtube-dl-exec';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { getCookiesPath, cleanupCookiesFile } from '@/lib/utils';

const execFileAsync = promisify(execFile);

// Explicitly construct the path to the binary because Next.js webpack mangles __dirname
const isWin = os.platform() === 'win32';

const localYtDlp = path.join(
  process.cwd(),
  'node_modules',
  'youtube-dl-exec',
  'bin',
  isWin ? 'yt-dlp.exe' : 'yt-dlp'
);
// Use local binary if it exists (on Render, nixpacks build downloads the latest
// yt-dlp here), otherwise fall back to system PATH.
const ytDlpPath = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';
const youtubedl = create(ytDlpPath);

// isProduction used to pick the right player client per environment
const isProduction = process.env.NODE_ENV === 'production';

export async function POST(req: Request) {
  const cookiesPath = getCookiesPath();
  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json({ error: 'URL provided is empty.' }, { status: 400 });
    }


    let info: any;


    if (isProduction) {
      // On production (Render datacenter IP), use execFile directly to pass raw CLI flags.
      // android_vr (YouTube VR) and tv_embedded clients bypass datacenter IP blocks
      // and do not require PO tokens or bot sign-in verification.
      const desktopUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const playerClient = 'youtube:player_client=android_vr,tv_embedded,ios,mweb';

      const proxy = process.env.YT_PROXY || process.env.HTTP_PROXY || process.env.http_proxy;

      const cliArgs = [
        '--dump-single-json',
        '--format', 'best',
        '--no-check-formats',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '--extractor-args', playerClient,
        '--user-agent', desktopUserAgent,
        '--referer', 'https://www.youtube.com/',
      ];
      if (proxy) {
        cliArgs.push('--proxy', proxy);
      }
      if (cookiesPath) {
        cliArgs.push('--cookies', cookiesPath);
      }
      cliArgs.push(url);

      console.log(`[extract] Running: ${ytDlpPath} ${cliArgs.slice(0, -1).join(' ')} <url>`);
      const { stdout, stderr } = await execFileAsync(ytDlpPath, cliArgs, {
        maxBuffer: 50 * 1024 * 1024, // 50MB
      });
      if (stderr) console.warn('[extract] yt-dlp stderr:', stderr);
      info = JSON.parse(stdout);
    } else {
      // On localhost, use youtube-dl-exec wrapper — player_client=all works fine
      // on residential IPs without needing --no-check-formats.
      const args: any = {
        dumpSingleJson: true,
        noWarnings: true,
        extractorArgs: 'youtube:player_client=all',
        addHeader: [
          'User-Agent:Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
          'Referer:https://www.youtube.com/',
        ],
      };
      if (cookiesPath) args.cookies = cookiesPath;
      info = await youtubedl(url, args) as any;
    }

    const encodedUrl = encodeURIComponent(url);
    const encodedTitle = encodeURIComponent(info.title || 'video');
    const options = [];
    let idCounter = 1;

    // Parse real video formats and deduplicate by resolution
    const formats: any[] = info.formats || [];

    // Get all unique heights that have video formats
    const videoHeights = new Set<number>();
    formats.forEach((f: any) => {
      if (f.vcodec && f.vcodec !== 'none' && f.height) {
        videoHeights.add(f.height);
      }
    });

    // Sort heights descending (4K → 1080p → 720p → 480p → 360p)
    const sortedHeights = Array.from(videoHeights).sort((a, b) => b - a);

    // Find best audio format to add its size to the estimate
    const bestAudio = formats
      .filter((f: any) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a: any, b: any) => (b.abr || 0) - (a.abr || 0))[0];
    const audioSizeBytes = bestAudio?.filesize || bestAudio?.filesize_approx || 0;

    for (const height of sortedHeights) {
      // Find the best video-only format at this exact height for size estimation
      const videoSample = formats
        .filter((f: any) => f.height === height && f.vcodec && f.vcodec !== 'none')
        .sort((a: any, b: any) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];

      const videoSizeBytes = videoSample?.filesize || videoSample?.filesize_approx || 0;
      // Combined size = video + audio (both streams get merged)
      const totalBytes = videoSizeBytes + audioSizeBytes;
      const sizeMB = totalBytes > 0 ? `~${(totalBytes / (1024 * 1024)).toFixed(0)} MB` : '—';

      // CRITICAL: Encode '+' as '%2B' so URL parsers don't treat it as a space!
      const formatStr = encodeURIComponent(`bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`);

      options.push({
        id: idCounter++,
        quality: `${height}p`,
        format: 'MP4',
        size: sizeMB,
        type: 'video',
        url: `/api/download?url=${encodedUrl}&format=${formatStr}&title=${encodedTitle}`,
      });
    }

    // If no video formats found, fall back to generic best
    if (options.length === 0) {
      const formatStr = encodeURIComponent('bestvideo+bestaudio/best');
      options.push({
        id: idCounter++,
        quality: 'Best Available',
        format: 'MP4',
        size: '—',
        type: 'video',
        url: `/api/download?url=${encodedUrl}&format=${formatStr}&title=${encodedTitle}`,
      });
    }

    // Audio Only — encode the format to be safe
    const audioFormatStr = encodeURIComponent('bestaudio[ext=m4a]/bestaudio');
    options.push({
      id: idCounter++,
      quality: 'Audio Only',
      format: 'MP3',
      size: audioSizeBytes > 0 ? `~${(audioSizeBytes / (1024 * 1024)).toFixed(0)} MB` : '—',
      type: 'audio',
      url: `/api/download?url=${encodedUrl}&format=${audioFormatStr}&title=${encodedTitle}`,
    });

    return NextResponse.json({
      title: info.title || 'Unknown Video',
      thumbnail: info.thumbnail || null,
      options
    });

  } catch (error: any) {
    console.error('Extraction error (yt-dlp) details:', {
      message: error?.message,
      stderr: error?.stderr,
      stdout: error?.stdout,
      code: error?.code,
    });
    return NextResponse.json({ error: `Failed to extract media: ${error?.message || error?.stderr || 'Unknown error'}` }, { status: 500 });
  } finally {
    cleanupCookiesFile(cookiesPath);
  }
}
