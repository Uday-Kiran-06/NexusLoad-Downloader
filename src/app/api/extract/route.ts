import { NextResponse } from 'next/server';
import { create } from 'youtube-dl-exec';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Explicitly construct the path to the binary because Next.js webpack mangles __dirname
const isWin = os.platform() === 'win32';
const localYtDlp = path.join(
  process.cwd(),
  'node_modules',
  'youtube-dl-exec',
  'bin',
  isWin ? 'yt-dlp.exe' : 'yt-dlp'
);
const ytDlpPath = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';
const youtubedl = create(ytDlpPath);

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url) {
      return NextResponse.json({ error: 'URL provided is empty.' }, { status: 400 });
    }

    // Fetch video info using yt-dlp — returns full format list
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      extractorArgs: 'youtube:player_client=all',
    } as any) as any;

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
    console.error('Extraction error (yt-dlp):', error);
    return NextResponse.json({ error: 'Failed to extract media. The video might be private or geo-restricted.' }, { status: 500 });
  }
}
