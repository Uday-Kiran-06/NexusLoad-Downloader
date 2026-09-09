import { NextResponse } from 'next/server';
import ytdl from '@distube/ytdl-core';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { getCookiesPath, cleanupCookiesFile } from '@/lib/utils';
import { validateUrlForDownload, sanitizeFilename, parseBoundedJson } from '@/lib/validation';
import { createApiError } from '@/lib/errors';
import { runCommandWithLifecycle, TIMEOUT_CONFIG } from '@/lib/process-manager';
import { logOperationalEvent, sanitizeUrlForLogging } from '@/lib/logger';

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'SAMEORIGIN',
};

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

    console.log('[extract] Request received for host:', sanitizeUrlForLogging(typeof url === 'string' ? url : undefined));

    // 1. Server-side URL Validation with SSRF & Private CIDR checks
    const urlValidation = await validateUrlForDownload(url);
    if (!urlValidation.valid || !urlValidation.normalizedUrl) {
      console.warn('[extract] URL validation failed:', urlValidation.error);
      logOperationalEvent({
        event: 'ssrf_rejected',
        reason: urlValidation.error || 'Invalid URL provided.',
        status: 400,
      });
      return createApiError('INVALID_URL', urlValidation.error || 'Invalid URL provided.', 400);
    }

    console.log('[extract] URL validation passed.');

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

    console.log('[extract] Extractor started via yt-dlp.');

    try {
      const { stdout } = await runCommandWithLifecycle(ytDlpPath, cliArgs, {
        timeoutMs: TIMEOUT_CONFIG.MAX_EXTRACTION_TIME,
        clientSignal: req.signal,
        maxBuffer: 50 * 1024 * 1024,
      });

      info = JSON.parse(stdout);
      console.log('[extract] Extractor completed successfully.');
    } catch (primaryErr: unknown) {
      const pErr = primaryErr as { code?: string };
      if (req.signal.aborted || pErr?.code === 'ECONNABORTED') {
        console.warn('[extract] Extraction aborted by client.');
        return createApiError('CANCELLED', 'Extraction aborted by client.', 499);
      }
      if (pErr?.code === 'ETIMEDOUT') {
        console.warn('[extract] Extraction timed out.');
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

        const videoHeights = new Set<number>();
        (ytdlInfo.formats || []).forEach((f) => {
          if (f.hasVideo && f.height) {
            videoHeights.add(f.height);
          }
        });

        const sortedHeights = Array.from(videoHeights).sort((a, b) => b - a);

        for (const height of sortedHeights) {
          options.push({
            id: `video_${height}p`,
            quality: `${height}p`,
            format: 'MP4',
            size: '—',
            type: 'video',
            url: `/api/download?url=${encodedUrl}&type=video&quality=${height}p&format=mp4&formatId=video_${height}p&title=${encodedTitle}`,
          });
        }

        if (options.length === 0) {
          options.push({
            id: 'video_best',
            quality: 'Best Available',
            format: 'MP4',
            size: '—',
            type: 'video',
            url: `/api/download?url=${encodedUrl}&type=video&quality=best&format=mp4&formatId=video_best&title=${encodedTitle}`,
          });
        }

        options.push({
          id: 'audio_m4a',
          quality: 'Audio Only',
          format: 'M4A',
          size: '—',
          type: 'audio',
          url: `/api/download?url=${encodedUrl}&type=audio&format=m4a&formatId=audio_m4a&title=${encodedTitle}`,
        });
        options.push({
          id: 'audio_mp3_192k',
          quality: 'MP3 (192 kbps)',
          format: 'MP3',
          bitrate: '192k',
          size: '—',
          type: 'audio',
          url: `/api/download?url=${encodedUrl}&type=audio&format=mp3&bitrate=192k&formatId=audio_mp3_192k&title=${encodedTitle}`,
        });

        if (options.length === 0) {
          console.warn('[extract] Fallback extraction produced 0 options.');
          return createApiError('EXTRACTION_FAILED', 'No downloadable formats were found for this URL.', 404);
        }

        console.log('[extract] Fallback extraction succeeded with', options.length, 'options.');
        console.log('[extract] Response returned with status 200.');
        return NextResponse.json(
          {
            title,
            thumbnail,
            options,
          },
          {
            headers: SECURITY_HEADERS,
          }
        );
      } catch {
        console.warn('[extract] Fallback extraction failed.');
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
      const sizeParam = totalBytes > 0 ? `&sizeBytes=${totalBytes}` : '';

      options.push({
        id: `video_${height}p`,
        quality: `${height}p`,
        format: 'MP4',
        size: sizeMB,
        sizeBytes: totalBytes > 0 ? totalBytes : undefined,
        type: 'video',
        url: `/api/download?url=${encodedUrl}&type=video&quality=${height}p&format=mp4&formatId=video_${height}p&title=${encodedTitle}${sizeParam}`,
      });
    }

    if (options.length === 0) {
      options.push({
        id: 'video_best',
        quality: 'Best Available',
        format: 'MP4',
        size: '—',
        type: 'video',
        url: `/api/download?url=${encodedUrl}&type=video&quality=best&format=mp4&formatId=video_best&title=${encodedTitle}`,
      });
    }

    const audioSizeParam = audioSizeBytes > 0 ? `&sizeBytes=${audioSizeBytes}` : '';

    options.push({
      id: 'audio_m4a',
      quality: 'Audio Only',
      format: 'M4A',
      size: audioSizeBytes > 0 ? `~${(audioSizeBytes / (1024 * 1024)).toFixed(0)} MB` : '—',
      sizeBytes: audioSizeBytes > 0 ? audioSizeBytes : undefined,
      type: 'audio',
      url: `/api/download?url=${encodedUrl}&type=audio&format=m4a&formatId=audio_m4a&title=${encodedTitle}${audioSizeParam}`,
    });
    options.push({
      id: 'audio_mp3_192k',
      quality: 'MP3 (192 kbps)',
      format: 'MP3',
      bitrate: '192k',
      size: audioSizeBytes > 0 ? `~${(audioSizeBytes / (1024 * 1024)).toFixed(0)} MB` : '—',
      sizeBytes: audioSizeBytes > 0 ? audioSizeBytes : undefined,
      type: 'audio',
      url: `/api/download?url=${encodedUrl}&type=audio&format=mp3&bitrate=192k&formatId=audio_mp3_192k&title=${encodedTitle}${audioSizeParam}`,
    });

    if (options.length === 0) {
      console.warn('[extract] Extractor produced 0 options.');
      return createApiError('EXTRACTION_FAILED', 'No downloadable formats were found for this URL.', 404);
    }

    console.log('[extract] Extractor completed successfully with', options.length, 'options.');
    console.log('[extract] Response returned with status 200.');
    return NextResponse.json(
      {
        title: safeTitle,
        thumbnail: info.thumbnail || null,
        options,
      },
      {
        headers: SECURITY_HEADERS,
      }
    );
  } catch (err: unknown) {
    console.error('[extract] Unexpected internal error during extraction:', err instanceof Error ? err.message : 'Unknown');
    return createApiError('INTERNAL_ERROR', 'An unexpected error occurred during extraction.', 500);
  } finally {
    cleanupCookiesFile(cookiesPath);
  }
}
