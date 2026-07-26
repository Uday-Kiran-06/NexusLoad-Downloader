import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Creates a temporary cookies file from the YT_COOKIES environment variable
 * to authenticate yt-dlp requests and bypass data center blocks.
 */
export function getCookiesPath(): string | null {
  const cookiesContent = process.env.YT_COOKIES;
  if (!cookiesContent) {
    return null;
  }

  try {
    const tempCookiesPath = path.join(os.tmpdir(), `yt_cookies_${Date.now()}.txt`);
    // Ensure content has correct formatting
    fs.writeFileSync(tempCookiesPath, cookiesContent.trim(), 'utf-8');
    return tempCookiesPath;
  } catch (err) {
    console.error('[cookies] Failed to write temporary cookies file:', err);
    return null;
  }
}

/**
 * Cleans up a temporary cookies file if it exists.
 */
export function cleanupCookiesFile(filePath: string | null) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn('[cookies] Failed to clean up temp cookies file:', err);
  }
}
