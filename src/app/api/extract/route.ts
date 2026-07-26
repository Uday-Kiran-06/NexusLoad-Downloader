import { NextResponse } from 'next/server';
import { create } from 'youtube-dl-exec';
import ytdl from '@distube/ytdl-core';
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
      // On production (Render datacenter IP), use android_vr and tv_embedded as primary clients
      // which bypass datacenter IP blocks. Avoid web client as first choice on datacenter IPs.
      const playerClient = 'youtube:player_client=android_vr,tv_embedded,ios,mweb';

      const proxy = process.env.YT_PROXY || process.env.HTTP_PROXY || process.env.http_proxy;

      const cliArgs = [
        '--dump-single-json',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '--extractor-args', playerClient,
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
    console.error('[extract] Primary extraction (yt-dlp) failed:', {
      message: error?.message,
      stderr: error?.stderr,
      code: error?.code,
    });

    console.log('[extract] Attempting fallback extraction via @distube/ytdl-core...');
    try {
      const { url } = await req.clone().json();
      const ytdlInfo = await ytdl.getInfo(url);

      const title = ytdlInfo.videoDetails.title || 'Video';
      const thumbnail = ytdlInfo.videoDetails.thumbnails?.[ytdlInfo.videoDetails.thumbnails.length - 1]?.url || null;

      const encodedUrl = encodeURIComponent(url);
      const encodedTitle = encodeURIComponent(title);
      const options = [];
      let idCounter = 1;

      const videoHeights = new Set<number>();
      (ytdlInfo.formats || []).forEach((f: any) => {
        if (f.hasVideo && f.height) {
          videoHeights.add(f.height);
        }
      });

      const sortedHeights = Array.from(videoHeights).sort((a, b) => b - a);

      for (const height of sortedHeights) {
        const formatStr = encodeURIComponent(`bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`);
        options.push({
          id: idCounter++,
          quality: `${height}p`,
          format: 'MP4',
          size: '—',
          type: 'video',
          url: `/api/download?url=${encodedUrl}&format=${formatStr}&title=${encodedTitle}`,
        });
      }

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

      const audioFormatStr = encodeURIComponent('bestaudio[ext=m4a]/bestaudio');
      options.push({
        id: idCounter++,
        quality: 'Audio Only',
        format: 'MP3',
        size: '—',
        type: 'audio',
        url: `/api/download?url=${encodedUrl}&format=${audioFormatStr}&title=${encodedTitle}`,
      });

      console.log('[extract] Fallback extraction (@distube/ytdl-core) succeeded!');
      return NextResponse.json({
        title,
        thumbnail,
        options,
      });

    } catch (fallbackError: any) {
      console.error('[extract] Fallback extraction (@distube/ytdl-core) also failed:', fallbackError?.message);
      return NextResponse.json({ error: `Failed to extract media: ${error?.message || error?.stderr || fallbackError?.message || 'Unknown error'}` }, { status: 500 });
    }
  } finally {
    cleanupCookiesFile(cookiesPath);
  }
}
