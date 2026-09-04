import { NextResponse } from 'next/server';
import ytdl from '@distube/ytdl-core';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { getCookiesPath, cleanupCookiesFile } from '@/lib/utils';
import { validateUrl, sanitizeFilename, parseBoundedJson } from '@/lib/validation';
import { createApiError } from '@/lib/errors';
import { runCommandWithLifecycle, TIMEOUT_CONFIG } from '@/lib/process-manager';

// Binary path resolution
const isWin = os.platform() === 'win32';
const localYtDlp = path.join(
  process.cwd(),
  'node_modules',
  'youtube-dl-exec',
  'bin',
  isWin ? 'yt-dlp.exe' : 'yt-dlp'
);
const ytDlpPath = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';
const isProduction = process.env.NODE_ENV === 'production';

interface YtDlpFormat {
  vcodec?: string;
  acodec?: string;
  height?: number;
  abr?: number;
  filesize?: number;
  filesize_approx?: number;
}

interface YtDlpInfo {
  title?: string;
  thumbnail?: string;
  formats?: YtDlpFormat[];
}

export async function POST(req: Request) {
  const cookiesPath = getCookiesPath();

  try {
    const parseResult = await parseBoundedJson<Record<string, unknown>>(req);
    if (parseResult.error) {
      return createApiError(parseResult.error.code, parseResult.error.message, parseResult.error.status);
    }

    const body = parseResult.data || {};

    // Strict allowlist: only 'url' is accepted
    for (const key of Object.keys(body)) {
      if (key !== 'url') {
        return createApiError('INVALID_REQUEST', `Unexpected field '${key}' in request body.`, 400);
      }
    }

    const { url } = body;

    // 1. Server-side URL Validation
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid || !urlValidation.normalizedUrl) {
      return createApiError('INVALID_URL', urlValidation.error || 'Invalid URL provided.', 400);
    }

    const validUrl = urlValidation.normalizedUrl;
    let info: YtDlpInfo | undefined;

    // 2. Primary Extraction via yt-dlp with timeout and client abort handling
    const playerClient = isProduction
      ? 'youtube:player_client=default,-android_sdkless'
      : 'youtube:player_client=all';

    const proxy = process.env.YT_PROXY || process.env.HTTP_PROXY || process.env.http_proxy;

    const cliArgs = [
      '--dump-single-json',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '--ignore-no-formats-error',
      '--extractor-args',
      playerClient,
    ];

    if (!isProduction) {
      cliArgs.push(
        '--add-header',
        'User-Agent:Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
        '--add-header',
        'Referer:https://www.youtube.com/'
      );
    }

    if (proxy) {
      cliArgs.push('--proxy', proxy);
    }
    if (cookiesPath) {
      cliArgs.push('--cookies', cookiesPath);
    }
    cliArgs.push(validUrl);

    console.log('[extract] Starting media extraction job...');

    try {
      const { stdout } = await runCommandWithLifecycle(ytDlpPath, cliArgs, {
        timeoutMs: TIMEOUT_CONFIG.MAX_EXTRACTION_TIME,
        clientSignal: req.signal,
        maxBuffer: 50 * 1024 * 1024,
      });

      info = JSON.parse(stdout);
    } catch (primaryErr: unknown) {
      const pErr = primaryErr as { code?: string };
      if (req.signal.aborted || pErr?.code === 'ECONNABORTED') {
        return createApiError('CANCELLED', 'Extraction aborted by client.', 499);
      }
      if (pErr?.code === 'ETIMEDOUT') {
        return createApiError('DOWNLOAD_TIMEOUT', 'Media extraction timed out.', 504);
      }

      console.warn('[extract] Primary extraction via yt-dlp failed. Attempting fallback via ytdl-core...');

      // 3. Fallback extraction via @distube/ytdl-core
      try {
        const ytdlInfo = await ytdl.getInfo(validUrl);
        const title = sanitizeFilename(ytdlInfo.videoDetails.title || 'Video', 'video');
        const thumbnail =
          ytdlInfo.videoDetails.thumbnails?.[ytdlInfo.videoDetails.thumbnails.length - 1]?.url || null;

        const encodedUrl = encodeURIComponent(validUrl);
        const encodedTitle = encodeURIComponent(title);
        const options = [];
        let idCounter = 1;

        const videoHeights = new Set<number>();
        (ytdlInfo.formats || []).forEach((f) => {
          if (f.hasVideo && f.height) {
            videoHeights.add(f.height);
          }
        });

        const sortedHeights = Array.from(videoHeights).sort((a, b) => b - a);

        for (const height of sortedHeights) {
          const formatStr = encodeURIComponent(
            `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
          );
          options.push({
            id: idCounter++,
            quality: `${height}p`,
            format: 'MP4',
            size: '—',
            type: 'video',
            url: `/api/download?url=${encodedUrl}&type=video&quality=${height}p&format=${formatStr}&title=${encodedTitle}`,
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
            url: `/api/download?url=${encodedUrl}&type=video&quality=best&format=${formatStr}&title=${encodedTitle}`,
          });
        }

        const audioFormatStr = encodeURIComponent('bestaudio[ext=m4a]/bestaudio');
        options.push({
          id: idCounter++,
          quality: 'Audio Only',
          format: 'M4A',
          size: '—',
          type: 'audio',
          url: `/api/download?url=${encodedUrl}&type=audio&format=${audioFormatStr}&title=${encodedTitle}`,
        });
        options.push({
          id: idCounter++,
          quality: 'MP3 (192 kbps)',
          format: 'MP3',
          size: '—',
          type: 'audio',
          url: `/api/download?url=${encodedUrl}&type=audio&format=mp3&bitrate=192k&title=${encodedTitle}`,
        });

        console.log('[extract] Fallback extraction succeeded.');
        return NextResponse.json({
          title,
          thumbnail,
          options,
        });
      } catch {
        // Both primary and fallback failed; sanitize client error message
        return createApiError('EXTRACTION_FAILED', 'Failed to extract media information from URL.', 500);
      }
    }

    if (!info) {
      return createApiError('EXTRACTION_FAILED', 'Failed to extract media information from URL.', 500);
    }

    const safeTitle = sanitizeFilename(info.title || 'video', 'video');
    const encodedUrl = encodeURIComponent(validUrl);
    const encodedTitle = encodeURIComponent(safeTitle);
    const options = [];
    let idCounter = 1;

    // Parse video formats and deduplicate by height
    const formats: YtDlpFormat[] = info?.formats || [];
    const videoHeights = new Set<number>();
    formats.forEach((f: YtDlpFormat) => {
      if (f.vcodec && f.vcodec !== 'none' && f.height) {
        videoHeights.add(f.height);
      }
    });

    const sortedHeights = Array.from(videoHeights).sort((a, b) => b - a);

    // Audio size estimation
    const bestAudio = formats
      .filter((f: YtDlpFormat) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a: YtDlpFormat, b: YtDlpFormat) => (b.abr || 0) - (a.abr || 0))[0];
    const audioSizeBytes = bestAudio?.filesize || bestAudio?.filesize_approx || 0;

    for (const height of sortedHeights) {
      const videoSample = formats
        .filter((f: YtDlpFormat) => f.height === height && f.vcodec && f.vcodec !== 'none')
        .sort((a: YtDlpFormat, b: YtDlpFormat) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];

      const videoSizeBytes = videoSample?.filesize || videoSample?.filesize_approx || 0;
      const totalBytes = videoSizeBytes + audioSizeBytes;
      const sizeMB = totalBytes > 0 ? `~${(totalBytes / (1024 * 1024)).toFixed(0)} MB` : '—';

      const formatStr = encodeURIComponent(`bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`);

      options.push({
        id: idCounter++,
        quality: `${height}p`,
        format: 'MP4',
        size: sizeMB,
        type: 'video',
        url: `/api/download?url=${encodedUrl}&type=video&quality=${height}p&format=${formatStr}&title=${encodedTitle}`,
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
        url: `/api/download?url=${encodedUrl}&type=video&quality=best&format=${formatStr}&title=${encodedTitle}`,
      });
    }

    const audioFormatStr = encodeURIComponent('bestaudio[ext=m4a]/bestaudio');
    options.push({
      id: idCounter++,
      quality: 'Audio Only',
      format: 'M4A',
      size: audioSizeBytes > 0 ? `~${(audioSizeBytes / (1024 * 1024)).toFixed(0)} MB` : '—',
      type: 'audio',
      url: `/api/download?url=${encodedUrl}&type=audio&format=${audioFormatStr}&title=${encodedTitle}`,
    });
    options.push({
      id: idCounter++,
      quality: 'MP3 (192 kbps)',
      format: 'MP3',
      size: audioSizeBytes > 0 ? `~${(audioSizeBytes / (1024 * 1024)).toFixed(0)} MB` : '—',
      type: 'audio',
      url: `/api/download?url=${encodedUrl}&type=audio&format=mp3&bitrate=192k&title=${encodedTitle}`,
    });

    console.log('[extract] Media metadata extracted successfully.');
    return NextResponse.json({
      title: safeTitle,
      thumbnail: info.thumbnail || null,
      options,
    });
  } catch {
    return createApiError('INTERNAL_ERROR', 'An unexpected error occurred during extraction.', 500);
  } finally {
    cleanupCookiesFile(cookiesPath);
  }
}
