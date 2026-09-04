import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Creates a temporary cookies file from the YT_COOKIES environment variable
 * to authenticate yt-dlp requests and bypass data center blocks.
 * Redacts all secret values and session keys from logs.
 */
export function getCookiesPath(): string | null {
  const cookiesContent = process.env.YT_COOKIES;
  if (!cookiesContent) {
    return null;
  }

  let trimmed = cookiesContent.trim();

  // Check if base64 encoded
  if (
    !trimmed.startsWith('#') &&
    !trimmed.startsWith('[') &&
    !trimmed.startsWith('{') &&
    /^[a-zA-Z0-9+/=]+$/.test(trimmed.replace(/\s/g, ''))
  ) {
    try {
      trimmed = Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString('utf-8').trim();
    } catch {
      console.error('[cookies] Failed to decode base64 cookies configuration.');
      return null;
    }
  }

  // Detect and convert JSON cookies to Netscape format
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const jsonCookies = JSON.parse(trimmed);
      const cookieArray = Array.isArray(jsonCookies) ? jsonCookies : [jsonCookies];

      let netscapeContent = '# Netscape HTTP Cookie File\n# Converted from JSON\n\n';

      for (const c of cookieArray) {
        if (!c.domain || !c.name) continue;

        const domain = c.domain;
        const subdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const cookiePath = c.path || '/';
        const secure = c.secure ? 'TRUE' : 'FALSE';
        const expiry = c.expirationDate
          ? Math.round(c.expirationDate).toString()
          : Math.round(Date.now() / 1000 + 86400 * 365).toString();
        const name = c.name;
        const value = c.value || '';

        netscapeContent += `${domain}\t${subdomains}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${value}\n`;
      }

      trimmed = netscapeContent;
    } catch {
      console.error('[cookies] Failed to parse JSON cookies format.');
      return null;
    }
  }

  // Normalize line endings to LF (\n) for Unix/Linux/Render compatibility
  trimmed = trimmed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Ensure mandatory Netscape header is at the top
  if (!trimmed.startsWith('# HTTP Cookie File') && !trimmed.startsWith('# Netscape HTTP Cookie File')) {
    trimmed = `# Netscape HTTP Cookie File\n# Normalized for yt-dlp\n\n${trimmed}`;
  }

  try {
    const tempCookiesPath = path.join(os.tmpdir(), `yt_cookies_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tempCookiesPath, trimmed, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(tempCookiesPath, 0o600);
    } catch {
      // Windows or non-POSIX filesystems may not support chmod 0o600; ignore safely
    }
    return tempCookiesPath;
  } catch {
    console.error('[cookies] Failed to write temporary cookies file safely.');
    return null;
  }
}

/**
 * Cleans up a temporary cookies file if it exists. Idempotent.
 */
export function cleanupCookiesFile(filePath: string | null): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Silent catch to prevent crash during cleanup
  }
}

/**
 * Cleans up a temporary directory safely and idempotently.
 * Handles Windows EBUSY/EPERM locks by retrying after a short grace period.
 */
export function safeCleanupDirectory(dir: string | null | undefined): void {
  if (!dir) return;

  const tryRemove = () => {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err: unknown) {
      // If busy or locked (common on Windows with recently closed handles), retry once after delay
      const code = (err as { code?: string })?.code;
      if (code === 'EBUSY' || code === 'EPERM') {
        setTimeout(() => {
          try {
            if (fs.existsSync(dir)) {
              fs.rmSync(dir, { recursive: true, force: true });
            }
          } catch {
            // Ignore retry failure
          }
        }, 3000);
      }
    }
  };

  tryRemove();
}
