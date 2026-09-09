import dns from 'dns';
import net from 'net';

const MAX_URL_LENGTH = parseInt(process.env.MAX_URL_LENGTH || '2048', 10);
const MAX_FILENAME_LENGTH = parseInt(process.env.MAX_FILENAME_LENGTH || '100', 10);

export const SUPPORTED_VIDEO_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320] as const;
export type SupportedHeight = (typeof SUPPORTED_VIDEO_HEIGHTS)[number];

export const SUPPORTED_MP3_BITRATES = ['128k', '192k', '256k', '320k'] as const;
export type SupportedMp3Bitrate = (typeof SUPPORTED_MP3_BITRATES)[number];

export interface ValidatedFormat {
  valid: boolean;
  isAudioOnly: boolean;
  isBestQuality?: boolean;
  isMp3?: boolean;
  mp3Bitrate?: SupportedMp3Bitrate;
  height?: number;
  videoSelector?: string;
  audioSelector?: string;
  error?: string;
}

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, multicast,
 * or reserved/non-public address range (RFC 1918, RFC 3927, RFC 5737, etc.).
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed / non-standard IP treated as unsafe
  }
  const [a, b, c] = parts;

  // 0.0.0.0/8 (Current network / "this host")
  if (a === 0) return true;
  // 10.0.0.0/8 (Private-Use)
  if (a === 10) return true;
  // 100.64.0.0/10 (Shared Address Space / CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-Local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private-Use)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.168.0.0/16 (Private-Use)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved / Broadcast)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address is in a private, loopback, link-local, multicast,
 * ULA, documentation, or non-public address range (RFC 4291, RFC 4193, etc.).
 * Also converts and checks IPv4-mapped and IPv4-compatible IPv6 addresses.
 */
export function isPrivateIPv6(ip: string): boolean {
  let clean = ip.replace(/%.+$/, '').toLowerCase();

  // Check for IPv4 mapped at end e.g. ::ffff:192.168.1.1
  const v4Match = clean.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const v4Parts = v4Match[1].split('.').map((p) => parseInt(p, 10));
    if (v4Parts.length !== 4 || v4Parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const h1 = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const h2 = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    clean = clean.replace(v4Match[1], `${h1}:${h2}`);
  }

  const parts = clean.split('::');
  if (parts.length > 2) return true;

  let words: number[] = [];
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return true;
    words = [...left, ...Array(missing).fill('0'), ...right].map((w) => parseInt(w, 16));
  } else {
    words = clean.split(':').map((w) => parseInt(w, 16));
  }

  if (words.length !== 8 || words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96 or ::ffff:a.b.c.d)
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const v4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPrivateIPv4(v4);
  }

  // IPv4-compatible IPv6 (::a.b.c.d - deprecated)
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0 &&
    (words[6] !== 0 || words[7] > 1)
  ) {
    const v4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPrivateIPv4(v4);
  }

  // ::/128 (Unspecified)
  if (words.every((w) => w === 0)) return true;
  // ::1/128 (Loopback)
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  // fc00::/7 (Unique Local Addresses - ULA)
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (Link-Local Unicast)
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  // ff00::/8 (Multicast)
  if ((words[0] & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 (Documentation)
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;

  return false;
}

/**
 * Validates whether an IP address is private, loopback, or non-public.
 */
export function isPrivateOrNonPublicIp(ip: string): boolean {
  if (ip.includes('.') && !ip.includes(':')) {
    return isPrivateIPv4(ip);
  }
  return isPrivateIPv6(ip);
}

/**
 * Validates URLs using the native WHATWG URL parser.
 * Rejects non-HTTP(S), empty, oversized, and dangerous schemes.
 */
export function validateUrl(rawUrl: unknown): { valid: boolean; normalizedUrl?: string; error?: string } {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { valid: false, error: 'URL must not be empty.' };
  }

  const trimmed = rawUrl.trim();

  if (trimmed.length > MAX_URL_LENGTH) {
    return { valid: false, error: `URL exceeds maximum permitted length of ${MAX_URL_LENGTH} characters.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Malformed or invalid URL format.' };
  }

  // Reject unsupported protocols / dangerous schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: `Unsupported protocol '${parsed.protocol}'. Only http: and https: are allowed.`,
    };
  }

  // Must have a valid hostname
  if (!parsed.hostname || parsed.hostname.length === 0) {
    return { valid: false, error: 'URL must include a valid hostname.' };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

/**
 * DNS-aware URL validation for download requests (SSRF protection).
 *
 * PROXY POLICY:
 * - Direct downloads are strictly validated to prevent targeting private/internal network addresses.
 * - Outbound proxy behavior (e.g. YT_PROXY / HTTP_PROXY) must remain explicitly configured by the
 *   server administrator via environment variables. User-supplied proxy parameters are NEVER trusted.
 */
export async function validateUrlForDownload(
  rawUrl: unknown
): Promise<{
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}> {
  // 1. Initial syntax, scheme, and length checks
  const initial = validateUrl(rawUrl);
  if (!initial.valid || !initial.normalizedUrl) {
    return initial;
  }

  let parsed: URL;
  try {
    parsed = new URL(initial.normalizedUrl);
  } catch {
    return { valid: false, error: 'Malformed or invalid URL format.' };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').trim();
  if (!hostname) {
    return { valid: false, error: 'URL must include a valid hostname.' };
  }

  // If the hostname itself is directly an IP literal, evaluate immediately
  if (net.isIP(hostname)) {
    if (isPrivateOrNonPublicIp(hostname)) {
      return { valid: false, error: 'URL host could not be safely resolved.' };
    }
  }

  // 2. Resolve hostname via Node DNS lookup
  let addresses: { address: string; family: number }[] = [];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    // If DNS resolution fails or domain does not exist, reject safely
    return {
      valid: false,
      error: 'URL host could not be safely resolved.',
    };
  }

  if (!addresses || addresses.length === 0) {
    return {
      valid: false,
      error: 'URL host could not be safely resolved.',
    };
  }

  // 3. Reject if ANY resolved IP address is private or non-public
  for (const item of addresses) {
    if (isPrivateOrNonPublicIp(item.address)) {
      return {
        valid: false,
        error: 'URL host could not be safely resolved.',
      };
    }
  }

  return { valid: true, normalizedUrl: initial.normalizedUrl };
}

/**
 * Validates and maps client format requests to trusted server-side yt-dlp selectors.
 * Rejects arbitrary selector syntax, shell injection, invalid combinations, and unknown formats.
 */
export function validateAndMapFormat(params: {
  type?: string | null;
  quality?: string | null;
  format?: string | null;
  formatId?: string | null;
  bitrate?: string | null;
}): ValidatedFormat {
  let { type, quality, format, formatId, bitrate } = params;

  // Pre-normalize friendly client UI quality labels before injection checks
  // e.g. "MP3 (192 kbps)" -> type 'audio', format 'mp3', bitrate '192k'
  // e.g. "Audio Only" -> type 'audio', quality null
  // e.g. "Best Available" -> quality 'best'
  if (typeof quality === 'string') {
    const trimmedQ = quality.trim();
    const mp3DisplayMatch = trimmedQ.match(/^mp3(?:\s*\(\s*(\d+)\s*(?:k|kbps)?\s*\)|\s*(\d+)\s*(?:k|kbps)?)?$/i);
    if (mp3DisplayMatch) {
      type = type || 'audio';
      format = format || 'mp3';
      const extractedNumber = mp3DisplayMatch[1] || mp3DisplayMatch[2];
      if (extractedNumber) {
        bitrate = bitrate || `${extractedNumber}k`.toLowerCase();
      }
      quality = null;
    } else if (/^audio(?:\s+only)?$/i.test(trimmedQ)) {
      type = type || 'audio';
      quality = null;
    } else if (/^best(?:\s+available)?$/i.test(trimmedQ)) {
      quality = 'best';
    }
  }

  // Reject any obvious injection attempts or traversal across all parameters
  const dangerousPattern = /[;\|\&`\$\(\)\{\}\<\>\\"'!\n\r]|--|\.\./;
  if (
    (type && dangerousPattern.test(type)) ||
    (quality && dangerousPattern.test(quality)) ||
    (format && dangerousPattern.test(format)) ||
    (formatId && dangerousPattern.test(formatId)) ||
    (bitrate && dangerousPattern.test(bitrate))
  ) {
    return { valid: false, isAudioOnly: false, error: 'Disallowed characters in format request.' };
  }

  // Normalize string inputs
  type = typeof type === 'string' ? type.toLowerCase().trim() : null;
  quality = typeof quality === 'string' ? quality.toLowerCase().trim() : null;
  format = typeof format === 'string' ? format.toLowerCase().trim() : null;
  formatId = typeof formatId === 'string' ? formatId.toLowerCase().trim() : null;
  bitrate = typeof bitrate === 'string' ? bitrate.toLowerCase().trim() : null;

  // Type parameter validation if present
  if (type && type !== 'audio' && type !== 'video') {
    return { valid: false, isAudioOnly: false, error: `Invalid media type '${type}'. Only 'audio' or 'video' allowed.` };
  }

  // Resolve formatId into semantic quality/format/type if provided
  if (formatId) {
    if (formatId === 'video_best') {
      quality = quality || 'best';
      type = type || 'video';
      format = format || 'mp4';
    } else {
      const vidMatch = formatId.match(/^video_(\d+)p?$/);
      if (vidMatch) {
        quality = quality || `${vidMatch[1]}p`;
        type = type || 'video';
        format = format || 'mp4';
      } else if (formatId === 'audio_m4a') {
        type = type || 'audio';
        format = format || 'm4a';
        if (quality === 'audio' || quality === 'audio only') quality = null;
      } else if (formatId === 'audio_webm') {
        type = type || 'audio';
        format = format || 'webm';
        if (quality === 'audio' || quality === 'audio only') quality = null;
      } else if (formatId === 'audio_mp3') {
        type = type || 'audio';
        format = format || 'mp3';
        if (quality === 'audio' || quality === 'audio only') quality = null;
      } else {
        const mp3Match = formatId.match(/^audio_mp3_(\d+k)$/);
        if (mp3Match) {
          type = type || 'audio';
          format = format || 'mp3';
          bitrate = bitrate || mp3Match[1];
          if (quality === 'audio' || quality === 'audio only') quality = null;
        } else {
          return { valid: false, isAudioOnly: false, error: `Unknown or invalid format ID '${formatId}'.` };
        }
      }
    }
  }

  // Also resolve format if provided as a semantic identifier (e.g. video_240p, audio_mp3, etc.)
  if (format) {
    if (format === 'video_best') {
      quality = quality || 'best';
      type = type || 'video';
      format = 'mp4';
    } else {
      const vidMatch = format.match(/^video_(\d+)p?$/);
      if (vidMatch) {
        quality = quality || `${vidMatch[1]}p`;
        type = type || 'video';
        format = 'mp4';
      } else if (format === 'audio_m4a') {
        type = type || 'audio';
        format = 'm4a';
      } else if (format === 'audio_webm') {
        type = type || 'audio';
        format = 'webm';
      } else if (format === 'audio_mp3') {
        type = type || 'audio';
        format = 'mp3';
      } else {
        const mp3Match = format.match(/^audio_mp3_(\d+k)$/);
        if (mp3Match) {
          type = type || 'audio';
          format = 'mp3';
          bitrate = bitrate || mp3Match[1];
        }
      }
    }
  }

  // Reject video with MP3 or audio bitrate
  if (type === 'video' && (format === 'mp3' || quality === 'mp3')) {
    return { valid: false, isAudioOnly: false, error: 'Invalid format combination: video request with MP3 format.' };
  }
  if (type === 'video' && bitrate) {
    return { valid: false, isAudioOnly: false, error: 'Invalid format combination: video request with audio bitrate.' };
  }

  // Reject video quality requested with MP3 format or audio bitrate
  const isVideoQuality = quality && SUPPORTED_VIDEO_HEIGHTS.some((h) => quality === `${h}p` || quality === String(h));
  if (isVideoQuality && (format === 'mp3' || bitrate)) {
    return { valid: false, isAudioOnly: false, error: 'Invalid format combination: video resolution with MP3 format/bitrate.' };
  }

  function isSupportedMp3Bitrate(val: string): val is SupportedMp3Bitrate {
    return (SUPPORTED_MP3_BITRATES as readonly string[]).includes(val);
  }

  // Check if explicit bitrate was provided in params
  if (bitrate) {
    if (!isSupportedMp3Bitrate(bitrate)) {
      return {
        valid: false,
        isAudioOnly: false,
        error: `Invalid or unsupported MP3 bitrate '${bitrate}'. Supported: ${SUPPORTED_MP3_BITRATES.join(', ')}.`,
      };
    }
  }

  // Reject contradictory combinations (audio with video quality)
  if (type === 'audio' && quality && quality !== 'audio' && quality !== 'audio only' && quality !== 'best') {
    const isBitrate = isSupportedMp3Bitrate(quality);
    if (!isBitrate) {
      if (/^\d+k$/i.test(quality)) {
        return {
          valid: false,
          isAudioOnly: false,
          error: `Invalid or unsupported MP3 bitrate '${quality}'. Supported: ${SUPPORTED_MP3_BITRATES.join(', ')}.`,
        };
      }
      return { valid: false, isAudioOnly: false, error: 'Invalid format combination: audio request with video quality.' };
    }
  }
  if (type === 'video' && (quality === 'audio' || quality === 'audio only')) {
    return { valid: false, isAudioOnly: false, error: 'Invalid format combination: video request with audio quality.' };
  }

  // Case 1: MP3 Audio Transcoding Request
  const isMp3Explicit =
    format === 'mp3' ||
    quality === 'mp3' ||
    (type === 'audio' && quality && isSupportedMp3Bitrate(quality)) ||
    (type === 'audio' && Boolean(bitrate));

  if (isMp3Explicit) {
    let chosenBitrate: SupportedMp3Bitrate = '192k';
    if (bitrate && isSupportedMp3Bitrate(bitrate)) {
      chosenBitrate = bitrate as SupportedMp3Bitrate;
    } else if (quality && isSupportedMp3Bitrate(quality)) {
      chosenBitrate = quality as SupportedMp3Bitrate;
    }

    return {
      valid: true,
      isAudioOnly: true,
      isMp3: true,
      mp3Bitrate: chosenBitrate,
      audioSelector: 'bestaudio[ext=m4a]/bestaudio/best',
    };
  }

  // Case 2: Native Audio Only
  const isAudioExplicit =
    type === 'audio' ||
    quality === 'audio' ||
    quality === 'audio only' ||
    format === 'audio' ||
    format === 'm4a' ||
    format === 'webm';
  const isAudioLegacy =
    typeof format === 'string' &&
    (format === 'bestaudio[ext=m4a]/bestaudio' ||
      format === 'bestaudio[ext=m4a]/bestaudio/best' ||
      format === 'bestaudio' ||
      format === 'bestaudio[ext=webm]/bestaudio');

  if (isAudioExplicit || isAudioLegacy) {
    const selector = format === 'webm' || format === 'bestaudio[ext=webm]/bestaudio'
      ? 'bestaudio[ext=webm]/bestaudio/best'
      : 'bestaudio[ext=m4a]/bestaudio/best';

    return {
      valid: true,
      isAudioOnly: true,
      isMp3: false,
      audioSelector: selector,
    };
  }

  // Case 3: Video Request
  // Check for unrestricted 'best' quality
  const isBestQuality =
    quality === 'best' ||
    format === 'best' ||
    format === 'bestvideo+bestaudio/best' ||
    format === 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';

  if (isBestQuality) {
    return {
      valid: true,
      isAudioOnly: false,
      isBestQuality: true,
      videoSelector: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      audioSelector: 'bestaudio[ext=m4a]/bestaudio/best',
    };
  }

  // Explicit target height (e.g. 1080, 720, 360)
  let parsedHeight: number | null = null;

  if (quality) {
    const cleanQ = quality.replace(/p$/, '').trim();
    const num = parseInt(cleanQ, 10);
    if (!isNaN(num)) {
      parsedHeight = num;
    }
  }

  // Fallback check in legacy format string e.g. "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
  if (parsedHeight === null && format) {
    const heightMatch = format.match(/height<=(\d+)/);
    if (heightMatch) {
      parsedHeight = parseInt(heightMatch[1], 10);
    }
  }

  if (parsedHeight === null) {
    return {
      valid: false,
      isAudioOnly: false,
      error: 'Unspecified or unparseable video resolution.',
    };
  }

  // Validate height is strictly within supported set
  if (!SUPPORTED_VIDEO_HEIGHTS.includes(parsedHeight as SupportedHeight)) {
    return {
      valid: false,
      isAudioOnly: false,
      error: `Unsupported resolution '${parsedHeight}p'. Supported resolutions are: ${SUPPORTED_VIDEO_HEIGHTS.join(', ')}p.`,
    };
  }

  // Construct trusted, strictly bounded selector: actual height <= requested height
  // Prioritizes compatible MP4 (H.264 + AAC) pairs first, falling back to best streams <= parsedHeight.
  // NEVER includes open-ended /bestvideo at the end to prevent silent upgrades to 1440p/4K.
  return {
    valid: true,
    isAudioOnly: false,
    isBestQuality: false,
    height: parsedHeight,
    videoSelector: `bestvideo[height<=${parsedHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${parsedHeight}]+bestaudio/best[height<=${parsedHeight}]`,
    audioSelector: 'bestaudio[ext=m4a]/bestaudio/best',
  };
}

/**
 * Sanitizes client-provided titles for use in Content-Disposition headers and filenames.
 * Strips path separators, control characters, CR/LF injection, and Windows reserved names.
 */
export function sanitizeFilename(rawTitle: unknown, fallback = 'media_download'): string {
  if (typeof rawTitle !== 'string' || !rawTitle.trim()) {
    return fallback;
  }

  let sanitized = rawTitle
    // Strip control characters (0x00 - 0x1f, 0x7f)
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Strip CR and LF explicitly to prevent HTTP response header splitting
    .replace(/[\r\n]/g, '')
    // Strip directory traversal sequences
    .replace(/\.\./g, '')
    // Strip characters invalid in Windows and Linux filenames: < > : " / \ | ? *
    .replace(/[<>:"/\\|?*]/g, '_')
    // Replace multiple underscores or spaces with a single underscore
    .replace(/[\s_]+/g, '_')
    // Trim leading/trailing dots and underscores
    .replace(/^[._]+|[._]+$/g, '')
    .trim();

  // Enforce maximum length
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_FILENAME_LENGTH).replace(/[._]+$/, '');
  }

  // Check for reserved Windows device names
  const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reservedNames.test(sanitized)) {
    sanitized = `${sanitized}_file`;
  }

  return sanitized || fallback;
}

/**
 * Strips null and control characters, truncates to safe length, and removes newlines for FFmpeg metadata.
 */
export function sanitizeMetadata(raw: unknown, maxLength = 500): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\r\n]/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export const MAX_REQUEST_BODY_BYTES = 16 * 1024; // 16 KB

/**
 * Safely parses a JSON request body with bounded memory.
 * Rejects:
 * 1. Non-JSON Content-Type
 * 2. Content-Length header exceeding maxBytes before reading
 * 3. Streaming body exceeding maxBytes (cancels stream reader immediately)
 * 4. Malformed JSON syntax
 * 5. Non-object JSON (arrays, primitives, null)
 */
export async function parseBoundedJson<T = Record<string, unknown>>(
  req: Request,
  maxBytes = MAX_REQUEST_BODY_BYTES
): Promise<{ data?: T; error?: { code: 'INVALID_REQUEST'; message: string; status: number } }> {
  // 1. Validate Content-Type header if provided
  const contentType = req.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Content-Type must be application/json.',
        status: 400,
      },
    };
  }

  // 2. Reject early if Content-Length exceeds maxBytes before reading
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(contentLength) && contentLength > maxBytes) {
      return {
        error: {
          code: 'INVALID_REQUEST',
          message: `Request body exceeds maximum allowed size of ${maxBytes} bytes.`,
          status: 400,
        },
      };
    }
  }

  // 3. Read body chunks incrementally to guard against chunked or unannounced oversized payloads
  if (!req.body) {
    return { data: {} as T };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  if (typeof req.body.getReader === 'function') {
    const reader = req.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch {}
            return {
              error: {
                code: 'INVALID_REQUEST',
                message: `Request body exceeds maximum allowed size of ${maxBytes} bytes.`,
                status: 400,
              },
            };
          }
          chunks.push(value);
        }
      }
    } catch {
      return {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Failed to read request body stream.',
          status: 400,
        },
      };
    }
  } else {
    // Fallback if reader not supported in environment
    try {
      const text = await req.text();
      if (Buffer.byteLength(text) > maxBytes) {
        return {
          error: {
            code: 'INVALID_REQUEST',
            message: `Request body exceeds maximum allowed size of ${maxBytes} bytes.`,
            status: 400,
          },
        };
      }
      if (!text.trim()) return { data: {} as T };
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Request body must be a valid JSON object.',
            status: 400,
          },
        };
      }
      return { data: parsed as T };
    } catch {
      return {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Malformed JSON in request body.',
          status: 400,
        },
      };
    }
  }

  if (chunks.length === 0 || totalBytes === 0) {
    return { data: {} as T };
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) {
    return { data: {} as T };
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request body must be a valid JSON object.',
          status: 400,
        },
      };
    }
    return { data: parsed as T };
  } catch {
    return {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Malformed JSON in request body.',
        status: 400,
      },
    };
  }
}
