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
    console.log('[cookies] YT_COOKIES environment variable is not set or empty.');
    return null;
  }

  const trimmed = cookiesContent.trim();
  console.log('[cookies] YT_COOKIES length:', trimmed.length);
  
  // Simple validation checks without leaking credentials
  const lines = trimmed.split(/\r?\n/);
  console.log('[cookies] Number of lines:', lines.length);
  if (lines.length > 0) {
    const firstLine = lines[0];
    console.log('[cookies] First line starts with:', firstLine.substring(0, 50));
    console.log('[cookies] First line length:', firstLine.length);
    
    // Check if the cookie content might be Base64 encoded (often done to pass multiline env vars securely)
    if (!firstLine.startsWith('#') && /^[a-zA-Z0-9+/=]+$/.test(trimmed.replace(/\s/g, ''))) {
      console.log('[cookies] Detected potential Base64 encoding. Attempting to decode...');
      try {
        const decoded = Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString('utf-8');
        console.log('[cookies] Decoded length:', decoded.length);
        const decodedLines = decoded.split(/\r?\n/);
        console.log('[cookies] Decoded number of lines:', decodedLines.length);
        console.log('[cookies] Decoded first line starts with:', decodedLines[0].substring(0, 50));
        
        const tempCookiesPath = path.join(os.tmpdir(), `yt_cookies_${Date.now()}.txt`);
        fs.writeFileSync(tempCookiesPath, decoded.trim(), 'utf-8');
        return tempCookiesPath;
      } catch (err) {
        console.error('[cookies] Failed to decode base64 cookies:', err);
      }
    }
  }

  try {
    const tempCookiesPath = path.join(os.tmpdir(), `yt_cookies_${Date.now()}.txt`);
    fs.writeFileSync(tempCookiesPath, trimmed, 'utf-8');
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
