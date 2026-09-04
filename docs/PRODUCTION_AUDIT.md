# NexusLoad — Production Baseline Audit & Safety Lock Report

**Date**: September 2026  
**Status**: Baseline Established & Safety Locked  
**Phase**: Phase 1 (Audit & Safety Baseline)  
**Target Environment**: Node.js 20+ / Next.js 16.2.11 (Turbopack) / Windows (Dev) & Linux Nixpacks (Production / Render)

---

## Executive Summary

NexusLoad is a web application designed to extract and download high-definition media (video and audio) from YouTube and other video platforms. The application is built on **Next.js 16 (App Router)**, **React 19**, **Tailwind CSS v4**, and **Framer Motion**, backed by **yt-dlp** (via `youtube-dl-exec` and `child_process.execFile`) and **FFmpeg** (via `fluent-ffmpeg` and `ffmpeg-static`).

This audit report documents the current architecture, complete end-to-end download flows, verified baseline test/build/lint statuses, confirmed and suspected bugs, and comprehensive security and operational risks. **No destructive changes, UI redesigns, or architectural replacements were made in this phase.**

---

## 1. Repository Inventory & Component Inspection

| File / Component | Purpose | Key Dependencies & Integrations | Critical Observations |
| :--- | :--- | :--- | :--- |
| `package.json` | Project configuration & scripts | Next 16.2.11, React 19.2.4, Tailwind v4, youtube-dl-exec ^3.1.9, fluent-ffmpeg ^2.1.3, ffmpeg-static ^5.3.0, @distube/ytdl-core ^4.16.12 | No test runner configured (Jest/Vitest missing). ESLint v9 flat config. |
| `next.config.ts` | Next.js configuration | `NextConfig` type | Empty default config (`{}`). No custom webpack/turbopack binary externals configured. |
| `tsconfig.json` | TypeScript configuration | ES2017 target, bundler resolution | Strict mode enabled; path alias `@/*` -> `./src/*`. |
| `nixpacks.toml` | Production build spec (Render/Railway) | Nix packages: nodejs, ffmpeg, curl | Pulls latest Linux `yt-dlp` binary from GitHub directly into `node_modules/youtube-dl-exec/bin/yt-dlp` during build. |
| `src/lib/utils.ts` | Shared utilities | `fs`, `path`, `os`, `process.env` | Handles parsing `YT_COOKIES` (Raw Netscape, Base64, or JSON) into a temporary disk file. Logs cookie metrics. Contains `cleanupCookiesFile`. |
| `src/app/layout.tsx` | Root layout | `next/font/google` (Geist Sans, Geist Mono) | Standard root HTML wrapper with metadata. |
| `src/app/page.tsx` | Main user interface (Client Component) | React hooks, Framer Motion, fetch API | Handles URL input, extraction triggering, format selection cards, simulated + actual download progress modal, and in-browser Blob conversion. |
| `src/app/api/extract/route.ts` | Video metadata & format resolution | `youtube-dl-exec`, `@distube/ytdl-core`, `child_process.execFile` | Uses `yt-dlp --dump-single-json` in production and `youtubedl` in dev. Fallback to `@distube/ytdl-core`. Generates format download URLs. |
| `src/app/api/download/route.ts` | Media acquisition, muxing & streaming | `youtube-dl-exec`, `fluent-ffmpeg`, `ffmpeg-static`, `fs`, `os` | Downloads audio/video streams to a per-request temp folder in `os.tmpdir()`, muxes via FFmpeg (if video), reads entire file into memory buffer, and returns it. |

---

## 2. End-to-End Download Flow

### Detailed Step-by-Step Execution Diagram

```
[User enters URL in UI]
         │
         ▼
[POST /api/extract] ─── (Parses YT_COOKIES to tmpfile)
         │
         ├─── Primary: yt-dlp --dump-single-json (--extractor-args player_client)
         └─── Fallback (on error): @distube/ytdl-core.getInfo()
         │
         ▼
[Extract formats, sort heights descending, estimate combined file sizes]
         │
         ▼
[Return JSON with format cards: quality, size, type, /api/download?... URL]
         │
         ▼
[User clicks Format Card in UI]
         │
         ▼
[Client initiates simulated progress animation (0% -> 99% over 38s)]
         │
         ▼
[GET /api/download?url=...&format=...&title=...]
         │
         ├─── Generates temporary directory: os.tmpdir()/ytdl_<timestamp>_<rand>
         ├─── Writes temporary cookies file
         │
         ├─── Case A: Audio Only
         │      ├─── yt-dlp downloads audio to tmpDir/audio.%(ext)s
         │      └─── Scans tmpDir, loads entire audio file via fs.readFileSync()
         │
         └─── Case B: Video + Audio
                ├─── yt-dlp downloads video to tmpDir/video.mp4
                ├─── yt-dlp downloads audio to tmpDir/audio.m4a (Sequential download)
                ├─── fluent-ffmpeg muxes both streams: -c:v copy -c:a copy -movflags +faststart -> merged.mp4
                └─── Loads entire merged.mp4 via fs.readFileSync()
         │
         ▼
[safeCleanup(tmpDir)] (Attempts rmSync; on lock error, schedules 5s retry)
         │
         ▼
[NextResponse(buffer, { headers: Content-Type, Content-Disposition, Content-Length })]
         │
         ▼
[Client Browser fetch() receives response body stream]
         │
         ├─── Browser ReadableStream reader tracks actual bytes received
         ├─── Updates progress bar to 100%
         ├─── Buffers chunks into in-memory Blob: new Blob(chunks, { type })
         ├─── Generates object URL: URL.createObjectURL(blob)
         ├─── Triggers invisible <a> anchor download click
         └─── URL.revokeObjectURL(blobUrl)
```

### Data Lifecycles & Resource Allocations

1. **Subprocesses**:
   - `extract/route.ts`: Spawns 1 `yt-dlp` process (`execFile` in prod, `youtube-dl-exec` in dev).
   - `download/route.ts`: Spawns 1 `yt-dlp` process for audio-only, OR 2 sequential `yt-dlp` processes (video then audio) + 1 `ffmpeg` process for video muxing.
2. **Filesystem Creation & Deletion**:
   - Cookies file: created in `os.tmpdir()/yt_cookies_<timestamp>.txt`, deleted in `finally` via `cleanupCookiesFile`.
   - Media directory: created in `os.tmpdir()/ytdl_<timestamp>_<random>/`. Holds `.part`, intermediate `.mp4`/`.m4a`, and `merged.mp4`.
   - Cleanup: `safeCleanup` invokes `fs.rmSync(dir, { recursive: true, force: true })`.
3. **Data Buffering & Memory Copies**:
   - Disk -> Node.js heap: `fs.readFileSync(mergedFile)` loads the complete video (e.g. 500MB – 2GB) as a single V8 `Buffer`.
   - Node.js heap -> HTTP Network socket: `new NextResponse(buf)` copies or chunks the buffer to the HTTP response.
   - Network socket -> Browser memory: `reader.read()` pushes array of `Uint8Array` chunks into `chunks: BlobPart[]` in JavaScript heap.
   - Browser heap -> Browser Blob storage: `new Blob(chunks)` duplicates media in browser memory before disk writing.

---

## 3. Baseline Verification Results

The following test, build, and lint checks were executed directly against the clean workspace:

### A. TypeScript Typecheck
- **Command**: `node ./node_modules/typescript/bin/tsc --noEmit`
- **Result**: **PASS** (Exit Code: `0`)
- **Diagnostic**: Zero compile errors. Strict type rules satisfied for all internal code signatures.

### B. Production Build
- **Command**: `npm run build` (`next build` with Turbopack)
- **Result**: **PASS** (Exit Code: `0`)
- **Build Output**:
  - `○ /` (Static prerender)
  - `○ /_not-found` (Static)
  - `ƒ /api/download` (Dynamic server route)
  - `ƒ /api/extract` (Dynamic server route)
  - `○ /icon.png` (Static)
- **Compiled successfully in ~2.9s**, 5 static pages generated.

### C. Linter Baseline
- **Command**: `npm run lint` (`eslint`)
- **Result**: **FAIL** (Exit Code: `1`) — **19 Errors, 6 Warnings**
- **Breakdown**:
  1. `src/app/page.tsx:100:30` — `Error: Cannot call impure function during render` (`react-hooks/purity`). ESLint flagged `Date.now()` inside component body helper setup.
  2. `src/app/page.tsx:78, 154` — `Unexpected any` (`@typescript-eslint/no-explicit-any`).
  3. `src/app/page.tsx:232, 373` — `Using <img> could result in slower LCP` (`@next/next/no-img-element`).
  4. `src/app/api/extract/route.ts` — 14 occurrences of `Unexpected any` (`@typescript-eslint/no-explicit-any`).
  5. `src/app/api/download/route.ts` — 2 occurrences of `Unexpected any` (`@typescript-eslint/no-explicit-any`) and 4 unused variable warnings (`isProduction`, `e`, `retryError`, `desktopUserAgent`).

### D. Automated Test Suite
- **Command**: N/A
- **Result**: **NOT CONFIGURED**
- **Finding**: No test runner (Jest, Vitest, Playwright, Cypress) or test scripts exist in `package.json`.

---

## 4. Production Risks & Vulnerability Analysis

### High & Critical Severity Risks

#### 1. Unbounded Server Memory Usage (Buffer Blowup) — [CONFIRMED]
- **Mechanism**: `fs.readFileSync(mergedFile)` in `src/app/api/download/route.ts:160` (and line 107 for audio) reads the entire media file synchronously into Node.js heap memory.
- **Impact**: A 1080p 60fps or 4K video of 1–2 GB causes immediate V8 heap exhaustion (`ERR_BUFFER_TOO_LARGE` or `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`).
- **Concurrency Risk**: Just 2 concurrent users downloading standard 500 MB videos consume >1 GB of RAM solely for buffer allocation, crashing micro/small cloud instances (Render standard 512MB RAM tier).

#### 2. Unbounded Client Browser Memory Usage — [CONFIRMED]
- **Mechanism**: `src/app/page.tsx:126, 143` pushes stream chunks into a JS array `chunks: BlobPart[]` and constructs `new Blob(chunks)`.
- **Impact**: Mobile devices or low-RAM laptops downloading multi-gigabyte videos experience browser tab crashes (OOM) before the file is handed to the browser download manager.

#### 3. Request Timeouts on Cloud Hosting (Zero-Byte Stall) — [CONFIRMED]
- **Mechanism**: For high-resolution or long videos, `yt-dlp` download + FFmpeg muxing can take 60 to 180 seconds. During this entire time, zero HTTP response headers or bytes are sent to the client.
- **Impact**: Cloud proxies (Render default timeout: 100s, Cloudflare: 100s, Vercel Serverless: 15–60s) terminate the connection with `504 Gateway Timeout` or `502 Bad Gateway`.

#### 4. SSRF & Arbitrary Remote Resource Probing — [CONFIRMED]
- **Mechanism**: `POST /api/extract` and `GET /api/download` accept any arbitrary `url` string without hostname validation.
- **Impact**: Attackers can submit `http://169.254.169.254/latest/meta-data/` (cloud metadata service) or internal VPC endpoints (`http://10.0.0.x`, `http://localhost:8080`). `yt-dlp` will attempt extraction/download on these internal endpoints.

#### 5. Arbitrary Format String Exposure — [CONFIRMED]
- **Mechanism**: In `GET /api/download`, the query parameter `format` is read directly: `const format = searchParams.get('format') || 'best'`. In audio-only mode, it checks `format.includes('bestaudio')`. In video mode, regex matches `height<=(\d+)`.
- **Impact**: While the parameter is partially parsed, if user input alters format evaluation logic or if future code passes `format` directly to `yt-dlp`, arbitrary format selectors can be injected.

#### 6. Temporary File & Disk Space Leaks — [CONFIRMED]
- **Mechanism**: Temporary folders are created under `os.tmpdir()/ytdl_*`. If the client disconnects halfway through a download, or if Node.js experiences an uncaught rejection, `safeCleanup` in the `try/catch` is either not reached or the process terminates.
- **Impact**: Disk partition eventually reaches 100% capacity (`ENOSPC`), causing the entire server to crash.

#### 7. Subprocess Orphan Leaks — [CONFIRMED]
- **Mechanism**: Neither `execFileAsync` nor `youtubedl` nor `ffmpeg` are linked to an `AbortSignal` or request lifecycle listener (`req.signal`).
- **Impact**: When a user closes their browser tab or cancels a download, the backend continues downloading gigabytes of data and executing FFmpeg muxing to completion, wasting CPU, network, and disk.

---

### Medium Severity Risks

#### 8. Sensitive Error / Path Leakage in HTTP Responses — [CONFIRMED]
- **Mechanism**: `src/app/api/download/route.ts:180-181`:
  ```ts
  const msg = error?.stderr || error?.message || String(error);
  return new NextResponse('Failed: ' + msg, { status: 500 });
  ```
- **Impact**: Internal file paths (e.g., `C:\Users\ASUS\AppData\Local\Temp\...` or `/tmp/ytdl_...`), command arguments, proxy addresses, and operating system usernames are directly leaked to the client in HTTP 500 response bodies.

#### 9. Misleading Frontend Progress UX — [CONFIRMED]
- **Mechanism**: `src/app/page.tsx:94-110` runs a hardcoded `fakeTimer` with fixed durations (18s video, 10s audio, 6s merge) up to 99%.
- **Impact**: On fast connections or short clips, the fake progress is slower than actual processing. On slow servers or long videos, progress sits at 99% for minutes, confusing users into thinking the download is stuck or frozen.

#### 10. Mismatched Content-Type and Audio Extension — [CONFIRMED]
- **Mechanism**:
  - In `src/app/api/download/route.ts:112`, audio downloads set `Content-Type: audio/mp4`.
  - In `src/app/page.tsx:147`, client forces `.mp3` extension:
    ```ts
    a.download = `...${opt.type === "audio" ? "mp3" : "mp4"}`;
    ```
- **Impact**: The actual downloaded file is an AAC/M4A stream in an MP4 container, but saved as `.mp3`. Some media players (especially in cars or hardware players) will fail to play it due to codec/container mismatch.

---

## 5. Bugs & Hypotheses Classification

### Confirmed Bugs

| ID | Location | Summary | Evidence / Proof |
| :--- | :--- | :--- | :--- |
| **BUG-01** | `api/download/route.ts:160` | OOM Crash on large downloads due to `fs.readFileSync` | Loading 1GB file loads 1GB Buffer into V8 heap, exceeding default memory limits. |
| **BUG-02** | `api/download/route.ts:181` | Server environment disclosure via stderr output | Error response returns raw OS temp paths and process details to client. |
| **BUG-03** | `page.tsx:147` | Mislabeled audio file extension (`.mp3` for `.m4a`/AAC) | yt-dlp downloads `ext=m4a`, server serves `audio/mp4`, client saves as `.mp3`. |
| **BUG-04** | `page.tsx:100` | React Hook purity violation in linter | Calling `Date.now()` during render lifecycle triggers `react-hooks/purity` failure. |
| **BUG-05** | `api/extract/route.ts:70` | Buffer overflow risk in `execFileAsync` | `maxBuffer: 50 * 1024 * 1024` can be exceeded on complex playlists or long channel extractions. |
| **BUG-06** | Windows DASH Fragmentation | Concurrent fragment downloads fail with `[Errno 2]` | Lack of OS file locking on Windows deletes/moves `.part-Frag` before thread access (mitigated in dev via sequential download and single fragments). |

### Suspected Bugs (Needs Validation)

| ID | Target Component | Hypothesis | Validation Method Required |
| :--- | :--- | :--- | :--- |
| **SUSP-01** | `nixpacks.toml` | `curl -L https://github.com/yt-dlp/.../yt-dlp` may fail or be rate-limited by GitHub API during rapid redeploys. | Test repeated container rebuilds under restricted network conditions. |
| **SUSP-02** | `lib/utils.ts` | Base64 cookie detection regex `/^[a-zA-Z0-9+/=]+$/` may misclassify raw Netscape cookies if they have no tabs or comments on early lines. | Unit test with various real-world cookie exports from popular browser extensions. |
| **SUSP-03** | `api/download/route.ts` | When yt-dlp outputs VP9/Opus in WebM container instead of MP4, fluent-ffmpeg with `-c:v copy -c:a copy` into `merged.mp4` might produce invalid MP4 container. | Test format extraction on YouTube 4K HDR and Opus-only streams. |
| **SUSP-04** | `api/extract/route.ts` | `@distube/ytdl-core` fallback frequently encounters YouTube `Sign in to confirm you're not a bot` or 403 Forbidden without authenticated cookies. | Trigger fallback by deliberately inducing yt-dlp error and inspect response. |

---

## 6. Architecture & Platform Compatibility

### Platform Nuances (Windows Localhost vs Linux Production)

```
┌─────────────────────────────────┬────────────────────────────────────────────────────────┐
│ Dimension                       │ Status & Behavioral Difference                         │
├─────────────────────────────────┼────────────────────────────────────────────────────────┤
│ OS Platform                     │ Local: win32 (Windows)                                 │
│                                 │ Production: linux (Nixpacks / Debian container)        │
├─────────────────────────────────┼────────────────────────────────────────────────────────┤
│ Binary Resolution               │ Local: yt-dlp.exe / ffmpeg.exe (local bin or system)   │
│                                 │ Production: yt-dlp ELF / ffmpeg nix package            │
├─────────────────────────────────┼────────────────────────────────────────────────────────┤
│ YouTube Extractor Strategy      │ Local: youtube:player_client=all (residential IP)       │
│                                 │ Production: default,-android_sdkless (datacenter IP)   │
├─────────────────────────────────┼────────────────────────────────────────────────────────┤
│ File System Locks               │ Windows locks open files (causing EBUSY on cleanup);   │
│                                 │ Linux unlinks immediately upon `unlinkSync`            │
└─────────────────────────────────┴────────────────────────────────────────────────────────┘
```

---

## 7. Strategic Recommendations for Subsequent Phases

1. **Phase 2: True Streaming Architecture (Zero Heap Buffering)**:
   - Replace `fs.readFileSync` with Node.js stream pipelining (`fs.createReadStream(filePath)`) directly into `NextResponse` or standard Web `ReadableStream`.
   - Implement client-side direct saving or progressive stream consumption to eliminate browser memory spikes.

2. **Phase 3: Subprocess Lifecycle & Cancellation**:
   - Bind `req.signal` (AbortSignal) to `yt-dlp` and `fluent-ffmpeg` subprocesses using `child_process.spawn`.
   - If the user aborts, immediately send `SIGTERM`/`SIGKILL` to prevent orphan process leaks.

3. **Phase 4: Security Hardening & Input Sanitization**:
   - Introduce strict URL whitelist validation (e.g. valid YouTube, Instagram, TikTok, Twitter domain regex).
   - Sanitize error messages returned to clients; log full traces on the server only.
   - Enforce an allowlist of quality formats (e.g. `1080p`, `720p`, `480p`, `audio`) rather than arbitrary format query strings.

4. **Phase 5: Background Cleanup & Disk Quotas**:
   - Add a scheduled cleanup routine or startup sweeper to remove orphaned `ytdl_*` directories older than 1 hour in `os.tmpdir()`.
   - Prevent disk exhaustion by setting a maximum download size threshold.

---

## 8. Files Slated for Modification in Later Phases

- `src/app/api/download/route.ts` — Streaming pipeline, AbortController cancellation, format sanitization, safe error reporting.
- `src/app/api/extract/route.ts` — SSRF domain guard, structured format typing, robust fallback error handling.
- `src/app/page.tsx` — Real server-sent event or header-based progress, correct audio extension labeling, React compiler lint fixes.
- `src/lib/utils.ts` — Sanitized cookie logs, directory sweepers.

---

## 9. Phase 1 Safety Lock Declaration

- **Codebase Integrity**: Preserved. No destructive edits, redesigns, or dependency replacements were performed.
- **Baseline Confirmed**: Typecheck passes (`0` errors), Production Build passes (`0` errors).
- **Audit Deliverable**: Completed and stored at `docs/PRODUCTION_AUDIT.md`.
- **Status**: Completed.

---

## 10. Phase 2 — Implemented Protections

**Status**: Implemented & Verified  
**Date**: September 2026

### 1. Server-Side URL Validation (`src/lib/validation.ts`)
- **Native URL Parsing**: Enforced using the standard WHATWG `URL` parser (`new URL()`).
- **Protocol Restriction**: Only `http:` and `https:` schemes are permitted. Dangerous and unsupported schemes (`javascript:`, `file:`, `data:`, `ftp:`, etc.) are rejected with `400 INVALID_URL`.
- **Length Ceiling**: Configurable via `MAX_URL_LENGTH` (default: 2048 characters).
- **No Shell Expansion**: URLs are passed as discrete array arguments to child process execution functions without shell invocation.
- **Broad Compatibility**: Does not artificially restrict hostnames, maintaining support for all 1000+ yt-dlp supported extractors.

### 2. Format & Quality Validation (`src/lib/validation.ts`)
- **Arbitrary yt-dlp Input Stripped**: Client cannot submit raw selector expressions (`--exec`, `;`, `|`, `&&`, shell interpolation, or format options).
- **Controlled Internal Representation**: Routes accept structured types (`video` or `audio`) and numeric qualities.
- **Trusted Selector Mapping**: Strict validation against supported resolutions (`144`, `240`, `360`, `480`, `720`, `1080`, `1440`, `2160`, `4320` and `best`). Any value outside this whitelist or containing illegal characters is rejected with `400 INVALID_FORMAT`.

### 3. Safe Filename Sanitization (`src/lib/validation.ts`)
- **Path Traversal Prevention**: Strips `..`, `/`, and `\`.
- **CR/LF & Control Stripping**: Eliminates `\r`, `\n` to prevent HTTP response header splitting / injection, and strips ASCII control characters.
- **Cross-Platform Safety**: Removes invalid characters on both Windows and Linux (`< > : " / \ | ? *`), handles reserved Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), enforces `MAX_FILENAME_LENGTH` (100 chars), and guarantees a safe fallback (`media_download`).

### 4. Process-Local Concurrency Control (`src/lib/concurrency.ts`)
- **In-Memory Semaphore**: Controlled by `MAX_CONCURRENT_DOWNLOADS` (default: 3).
- **Saturated Protection**: Rejects excess requests immediately with `429 SERVER_BUSY`.
- **Guaranteed Slot Release**: Handled via `finally` blocks across all completion, failure, abort, and timeout branches. The counter uses non-negative clamping to prevent drift.

### 5. Storage & Disk Space Protection (`src/lib/concurrency.ts`)
- **Proactive Storage Check**: Inspects temporary partition space using `fs.promises.statfs(os.tmpdir())` before starting resource-heavy operations.
- **Threshold**: Rejects downloads if free storage is below `MIN_FREE_DISK_BYTES` (default: 500 MB) with `507 DISK_SPACE`.

### 6. Subprocess Lifecycle, Timeouts & Platform-Aware Termination (`src/lib/process-manager.ts`)
- **Configurable Safety Ceilings**:
  - `MAX_EXTRACTION_TIME` (default: 45s)
  - `MAX_DOWNLOAD_TIME` (default: 180s)
  - `MAX_CONVERSION_TIME` (default: 90s)
- **Client Disconnection Handling**: Wired directly to `req.signal`. When a user disconnects or cancels, active `yt-dlp` and `FFmpeg` subprocesses are terminated immediately.
- **Platform-Aware Tree Termination**:
  - **Windows**: Executes `taskkill /pid <PID> /T /F` to ensure all child processes (Python/yt-dlp, ffmpeg) are terminated, preventing orphan leaks.
  - **Linux**: Escalates process group signals (`SIGTERM` -> `SIGKILL`).
- **Idempotent Cleanup**: Directory cleanup handles temporary lock contention (`EBUSY`/`EPERM` on Windows) via non-blocking delayed retries.

### 7. Structured Errors & Zero Information Leakage (`src/lib/errors.ts`)
- **Consistent Response Schema**: Standard JSON envelope across all failure scenarios:
  ```json
  {
    "error": "ERROR_CODE",
    "message": "Sanitized human-readable message."
  }
  ```
- **Error Codes**: `INVALID_URL`, `INVALID_FORMAT`, `INVALID_REQUEST`, `SERVER_BUSY`, `DOWNLOAD_TIMEOUT`, `EXTRACTION_FAILED`, `DOWNLOAD_FAILED`, `CONVERSION_FAILED`, `CANCELLED`, `DISK_SPACE`, `INTERNAL_ERROR`.
- **Zero Information Leakage**: Neither `stderr`, local filesystem paths (`C:\Users\...` or `/tmp/...`), command-line strings, cookies, nor stack traces are returned to clients.

### 8. Secure Logging (`src/lib/utils.ts`)
- **Redacted Credentials**: Removed logging of cookie lines, session tokens, and keys. Only high-level operational status is logged.

### 9. Known Limitations & Architecture Notes
- **Process-Local Concurrency**: The concurrency semaphore protects jobs within the local Node.js process instance. Multi-instance cluster scaling will require distributed state in future phases.
- **Pre-Phase-3 HTTP Architecture**: In Phase 2, the HTTP request still waits synchronously for disk muxing to complete before returning data. The full streaming/job queue architecture is scheduled for Phase 3.
- **Windows Fragment Collisions**: High-concurrency DASH fragment locking remains an inherent Windows OS file locking nuance when running multi-threaded fragments; sequential single-thread fragment fetching and unique temporary job folders mitigate this for standard flows.
- **Audio Format Handling**: The audio path serves AAC/M4A in an MP4 container. The client file extension has been corrected to `.m4a` to prevent player mismatches; dedicated MP3 re-encoding is deferred to Phase 5.

---

## 11. Phase 3 — Streaming & Job Architecture

**Status**: Implemented & Empirically Verified  
**Date**: September 2026

### 1. Architectural Transformation
The legacy synchronous full-file buffering pipeline has been replaced with an asynchronous, bounded-memory background job architecture:

```
[Browser Client]
       │
       │ 1. POST /api/download (URL, quality, type, title)
       ▼
[Job Manager] ──────────────────────┐
       │ 2. Acquires Concurrency    │
       │    Slot & Starts Worker    │
       ▼                            ▼
[Return { jobId, status }]   [Worker executes yt-dlp & FFmpeg]
       │                            │ (Writes to unique job tmp directory)
       │                            │ (Container-aware stream muxing)
       │ 3. Polls status every 1.5s │
       ▼                            ▼
[GET /api/download/:id/status]   [Worker completes & atomically renames file]
       │                            │ (Releases Concurrency Slot immediately)
       │ status === "ready"         │ (Status -> "ready", starts TTL timer)
       ▼                            ▼
[Native Browser Download] ───► [GET /api/download/:id]
       │                        (Streamed via fs.createReadStream -> Web ReadableStream)
       │                        (Supports HTTP Range 206 Partial Content)
       ▼                        (Zero full-file buffering)
[Saved directly to Disk]
```

### 2. Job Lifecycle & State Transitions
- **Capability Tokens**: Every job is identified by a cryptographically secure 192-bit capability token (`crypto.randomBytes(24).toString('hex')`).
- **State Machine**:
  - `queued` → `downloading` → `processing` → `ready`
  - Failure branch: `failed`
  - Cancellation branch: `cancelled`
  - Expiration branch: `expired`
- **Race Protection**: Terminal states (`ready`, `failed`, `cancelled`, `expired`) cannot be overridden by subsequent asynchronous callbacks.
- **Atomic Finalization**: The worker processes media into temporary working paths and only renames to the final output after writing completes and file size is verified.

### 3. Concurrency Slot Lifecycle Optimization
The Phase 2 concurrency slot is held **only during heavy backend computation**:
- Slot acquired at job creation.
- Slot **released immediately upon reaching `ready`** (when file is finalized on disk).
- Concurrency slots are **never held** while slow client browsers stream the completed file.
- Slots are guaranteed to release exactly once upon success, failure, cancellation, or timeout.

### 4. Bounded-Memory Streaming & Zero Full-File Buffering
- **Eliminated**:
  - `fs.readFileSync` — completely removed from the download path (0 matches in `src/`).
  - `fs.promises.readFile` — completely removed (0 matches).
  - `Buffer.concat` — completely removed (0 matches).
  - `new Blob(chunks)` & client chunk accumulator — completely removed (0 matches).
- **Implementation**: The streaming endpoint creates a Web `ReadableStream` wrapping Node.js `fs.createReadStream`, emitting backpressured 64 KB chunks directly to the HTTP socket.
- **Empirical Memory Benchmark Results (200.0 MB File Stream)**:
  - **File Size**: 200.0 MB (209,715,200 bytes)
  - **Heap Used Before**: 4.9 MB
  - **Heap Peak During**: 5.7 MB
  - **Heap Used After**: 5.2 MB
  - **Peak Heap Delta**: **+0.8 MB** (growth is independent of file size: `heap growth << file size`)
  - **RSS Memory**: Before=47.7 MB, Peak=66.9 MB, After=57.3 MB

### 5. HTTP Range Request Support (`206 Partial Content`)
- Fully supports single-byte ranges (`Range: bytes=start-end`, `bytes=start-`, `bytes=-suffix`).
- Returns `206 Partial Content` with `Accept-Ranges: bytes`, `Content-Range: bytes start-end/total`, and slice length.
- Rejects out-of-bounds or inverted ranges with `416 Range Not Satisfiable`.
- Verified via integration tests for first-byte slice (`bytes=0-99`) and middle slice (`bytes=1000-1999`).

### 6. Stream / TTL Expiration Race Safety
- **Active Stream Counter**: Every job tracks `activeStreams: number`.
- When a file stream begins, `activeStreams` is incremented; upon stream close/error/disconnect, it decrements.
- If the TTL timer (default: 15 minutes) expires while a stream is in progress:
  - Status transitions to `expired` and `cleanupPending = true`.
  - The physical file is **not deleted** while `activeStreams > 0`.
  - File deletion occurs automatically once all active streams complete.

### 7. Explicit User Cancellation & Frontend Behavior
- **Cancellation Endpoint**: `DELETE /api/download/[jobId]` terminates running `yt-dlp` and `FFmpeg` process trees, deletes working directories, releases the concurrency slot, and sets status to `cancelled`.
- **Frontend Disconnect Safety**: Closing the modal or unmounting the React component only cleans up the local polling timer; it does not kill the background job. Only clicking "Cancel Download" sends an explicit `DELETE`.
- **Native Browser Saving**: In `src/app/page.tsx`, when status reaches `ready`, a native browser download (`<a href="/api/download/[jobId]" download>`) is triggered, piping bytes directly to disk via the browser's download manager.

### 8. Container & Codec Compatibility
- The worker detects whether streams are WebM (VP9/Opus) or MP4 (H.264/AAC).
- If streams are WebM, FFmpeg remuxes into a native `.webm` container with `video/webm`.
- If streams are MP4, FFmpeg applies `-movflags +faststart` into `.mp4` with `video/mp4`.
- Prevents container corruption from forced MP4 muxing of incompatible Opus/VP9 streams without transcoding.

### 9. Deployment Assumptions & Known Limitations
- **Persistent Node Process**: The in-memory job store and background worker model require a persistent Node.js runtime (`next start`, Nixpacks Docker / Render container). It is not persistent across server restarts or multi-instance serverless scaling without a shared state store.
- **MP3 Transcoding**: High-quality AAC/M4A audio is preserved natively; MP3 re-encoding is deferred to Phase 5.

---

## Phase 4 — Reliability, Performance & Production Hardening

**Date**: September 2026  
**Status**: Completed & Verified  
**Scope**: Media pipeline reliability, deterministic format fallback, container sanity verification, bounded transient retry recovery, job store capacity limits, and performance observability.

### 1. Format Selection & Deterministic Fallback Policy
- **Strict Height Bounding**: When a user selects an explicit video resolution (144p, 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p, 4320p), the server-side selector strictly enforces `actual height <= requested height`.
  - Target selector pattern: `bestvideo[height<=${H}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${H}]+bestaudio/best[height<=${H}]`
  - **Zero Silent Upgrades**: Open-ended fallback `/bestvideo` was permanently removed. Requesting 1080p will select 1080p if available, or the highest available <= 1080p (e.g. 720p, 480p, 360p). It will **never** silently download 1440p or 4K.
- **Unrestricted Best Policy**: When `quality=best` is requested, an unconstrained selector (`bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`) is applied without arbitrary height caps.
- **Strict Parameter Validation**: Contradictory combinations (e.g. `type=audio` with `quality=1080p`, or `type=video` with `quality=audio`) and shell injections are rejected with `400 INVALID_FORMAT`.

### 2. Codec & Container Sanity Validation
- **MIME & Extension Agreement**:
  - `video/mp4` → `.mp4`
  - `video/webm` → `.webm`
  - `audio/mp4` → `.m4a`
  - `audio/webm` → `.webm`
  - Audio files are never mislabeled as `.mp3`.
- **Lightweight Header Inspection**: Before any job is marked `ready`, `validateMediaFileIntegrity()` reads the first 16 bytes:
  - MP4/M4A: Verifies ISO BMFF box `ftyp` at bytes 4–7 (`0x66 0x74 0x79 0x70`).
  - WebM: Verifies EBML header `0x1A 0x45 0xDF 0xA3` at bytes 0–3.
  - Rejects 0-byte or corrupted files with `DOWNLOAD_FAILED` or `CONVERSION_FAILED`.
- **Absolute Binary Path Resolution**: Resolves physical executable paths (`node_modules/ffmpeg-static/ffmpeg.exe` and `node_modules/youtube-dl-exec/bin/yt-dlp.exe`) via `process.cwd()`, preventing Next.js Turbopack virtual `\ROOT\` path errors in production.

### 3. Subprocess Execution & Bounded Transient Retry Policy
- **Transient Failure Classification (`isRetryableNetworkError`)**:
  - **Retryable (`MAX_DOWNLOAD_RETRIES = 1`)**: Socket resets (`ECONNRESET`), timeouts (`ETIMEDOUT`), HTTP 502/503/504, and DNS resolution failures.
  - **Non-Retryable (Fails immediately)**: Invalid URLs, invalid formats, HTTP 403 Forbidden, YouTube bot-checks, private videos, internal execution timeouts, and client cancellations.
- **Clean Recovery Loop**: Before a retry occurs, any partial `.part` / `.ytdl` files in `job.tmpDir` are unlinked, stale handles released, and a 1000ms backoff applied.
- **Real-Time Progress Streaming**: yt-dlp is executed with `--newline`, parsing progress lines (`[download]  XX.X%`) from both `stdout` and `stderr` streams, clamped strictly between `0` and `100`. If indeterminate, `progress = null` is emitted and rendered as an animated shimmer without displaying "null%".

### 4. Job Store Memory & Capacity Protection
- **Capacity Cap (`MAX_STORED_JOBS = 100`)**: The in-memory job store strictly caps active entries to 100.
- **Safe Terminal Pruning**: If capacity is reached, only inactive terminal jobs (`failed`, `cancelled`, `expired`, or completed `ready` jobs with `activeStreams === 0` aged over 60s) are pruned. Jobs currently in `queued`, `downloading`, `processing`, or with `activeStreams > 0` are strictly protected.
- **Capacity Rejection**: If 100 active jobs are present and none can be safely pruned, new requests receive `503 SERVER_BUSY` ("Server job capacity limit reached").
- **Zero Log Retention**: Raw subprocess `stdout`/`stderr` buffers are never retained in job memory.

### 5. Platform-Specific Behavior (Windows vs. Linux)
- **Windows Sequential Fragments**: Concurrent fragment downloading is deliberately kept disabled on Windows to completely avoid Windows file-locking collisions (`[Errno 2] audio.m4a.part-FragXXX`).
- **Process Termination**: Windows uses `taskkill /pid <PID> /T /F` to ensure entire process trees (including Python, yt-dlp, and FFmpeg) are terminated upon cancellation or timeout.

### 6. Observability & Safe Bounded Metrics
- Every job records safe execution metrics:
  - `durationMs`: Total duration from creation to ready.
  - `fileSizeBytes`: Final verified file size on disk.
  - `outputThroughputBps`: Computed as `finalFileSize / totalDuration` (explicitly documented as output throughput, not raw network speed).
  - `retryCount`: Number of transient network retries (0 or 1).
- No cookies, tokens, filesystem paths, or subprocess arguments are exposed in API responses or logs.

### 7. Empirical Performance & Memory Measurements
- **Large-File Bounded Memory Benchmark (200.0 MB File Stream)**:
  - **File Size**: 200.0 MB (209,715,200 bytes)
  - **Heap Before**: 14.0 MB
  - **Peak Heap During**: 14.0 MB
  - **Heap After**: 11.5 MB
  - **Peak Heap Delta**: **+0.0 MB** (`heap growth << file size` strictly verified)
  - **RSS Memory**: Before=78.6 MB, Peak=115.3 MB, After=89.9 MB
- **Live Video Download & Muxing Benchmark (YouTube 360p)**:
  - **Duration**: 7,170 ms (Download + FFmpeg remux + atomic finalization)
  - **Final Output**: 309,157 bytes (`Me_at_the_zoo_360p.mp4`)
  - **Output Throughput**: ~42.1 KB/s
  - **Range Streaming**: Slices (`bytes=0-499`) served with `206 Partial Content` in < 5ms.
- **Live Audio Download Benchmark (YouTube M4A)**:
  - **Duration**: 3,827 ms
  - **Final Output**: 309,288 bytes (`.m4a`)
  - **Output Throughput**: ~78.9 KB/s

### 8. Verification Matrix & Test Status
| Category | Test Description | Result |
| :--- | :--- | :--- |
| **Format Selection** | Bounded height <= requested height without `/bestvideo` silent upgrade | **PASSED** |
| **Format Selection** | Unrestricted `quality=best` policy without artificial caps | **PASSED** |
| **Format Validation** | Rejection of type/quality contradictions (audio + 1080p) & injection | **PASSED** |
| **Container Integrity** | MP4/M4A `ftyp` magic header validation | **PASSED** |
| **Container Integrity** | WebM EBML `0x1A 0x45 0xDF 0xA3` magic header validation | **PASSED** |
| **Container Integrity** | Rejection of 0-byte and truncated/corrupted files | **PASSED** |
| **Retry Classification** | Retryable network dropouts (ETIMEDOUT, ECONNRESET, 502/503/504) | **PASSED** |
| **Retry Classification** | Non-retryable permanent errors (403, bot checks, client abort, format errors) | **PASSED** |
| **Job Capacity** | 100-job capacity cap & protection of active jobs/streams | **PASSED** |
| **HTTP Range (206)** | Edge cases: `bytes=0-0`, `bytes=last-last`, `bytes=-100`, `bytes=5000-` | **PASSED** |
| **HTTP Range (416)** | Error cases: `bytes=500-100`, `bytes=50000-`, `bytes=-0`, `bytes=-` | **PASSED** |
| **Memory Benchmark** | 200.0 MB file stream with +0.0 MB heap delta | **PASSED** |
| **Live Integration** | YouTube audio download (M4A) via POST 202 -> polling -> stream -> 206 Range | **PASSED** |
| **Live Integration** | YouTube video download (360p) + FFmpeg remux -> MP4 -> stream -> 206 Range | **PASSED** |
| **Live Integration** | Resolution fallback on 240p max video when requesting 1080p (no silent upgrade) | **PASSED** |
| **Live Integration** | Explicit cancellation (`DELETE /api/download/[jobId]`) & slot release | **PASSED** |
| **Static Audit** | Zero matches for `fs.readFileSync`, `fs.promises.readFile`, `Buffer.concat`, `new Blob(`, `reader.read(` | **PASSED** |
| **TypeScript** | `node ./node_modules/typescript/bin/tsc --noEmit` (0 errors) | **PASSED** |
| **Build** | `next build` Turbopack compilation (Exit code 0) | **PASSED** |
| **Lint** | `eslint` (0 errors, 2 image element warnings from layout) | **PASSED** |

### 9. Deployment Assumptions & Phase 5 Deferred Scope
- **Persistent Node Process**: NexusLoad runs as a persistent Node.js process (`next start` / Nixpacks container). In-memory state is non-persistent across container restarts.
- **Phase 5 Deferred Items**: True MP3 transcoding via FFmpeg audio re-encoding (`-c:a libmp3lame`) remains strictly deferred to Phase 5. No fake MP3 files or re-labeling of AAC streams as MP3 are permitted in Phase 4.

---

## 11. Phase 4.1 Production Hardening (Linux Process Groups, Strict Cookies, Pull Stream Backpressure & SSRF Protection)

### 1. Linux Process-Tree Termination
- **Process Group Isolation**: Child processes in `process-manager.ts` are spawned with `{ detached: !isWin }`, placing POSIX subprocesses into a dedicated process group where `PGID == child.pid`.
- **Termination Discipline**: `killProcessTree(pid)` guards against `!pid || pid <= 1 || pid === process.pid` to prevent signaling the parent Node.js runtime.
- **POSIX Signal Escalation**: Sends `SIGTERM` to `-pid` first. After the existing 1,500 ms grace period, escalates to `SIGKILL` on `-pid`. Safe ESRCH fallback terminates direct `pid` if process group leader has exited.
- **Child Ref Retention**: `child.unref()` is strictly omitted so Node.js runtime tracks active subprocess lifecycles reliably.

### 2. Restrictive Temporary Cookie File Permissions
- **Mode 0o600 Atomic Creation**: `fs.writeFileSync(tempCookiesPath, trimmed, { encoding: 'utf8', mode: 0o600 })` guarantees restrictive owner-only read/write permissions upon creation.
- **Explicit chmodSync**: Followed by `try { fs.chmodSync(tempCookiesPath, 0o600); } catch {}` for POSIX compliance, while preserving Windows compatibility.
- **Zero Exposure**: Cookie content is never logged or exposed in client error payloads.

### 3. Pull-Based Web Stream Backpressure
- **Async Iterator Bridge**: Replaced the previous event-driven `nodeStream.on('data', ...)` with `nodeStream[Symbol.asyncIterator]()` consumed inside `pull(controller)`.
- **True Downstream Backpressure**: Data is only pulled on-demand from the OS filesystem when the downstream HTTP client or reader requests a chunk.
- **Pull Concurrency Guard**: Added `isPulling` guard ensuring overlapping `pull()` calls cannot invoke `iterator.next()` concurrently.
- **Single Cleanup Guarantee**: `onStreamFinished()` uses an atomic `isCleanedUp` guard ensuring reference counts and TTL cleanups fire exactly once.
- **Safe Error & Cancellation**: On client abort, `iterator.return()` and `nodeStream.destroy()` are called, `activeStreams` is decremented, and `controller.close()` is never invoked after `controller.error()`.

### 4. DNS-Aware SSRF Protection
- **Comprehensive CIDR Classification**: Implemented `isPrivateIPv4()` and `isPrivateIPv6()` enforcing rejection of:
  - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`.
  - IPv6: `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, and IPv4-mapped IPv6 (`::ffff:a.b.c.d`).
- **Pre-Slot Resolution Validation**: `validateUrlForDownload(rawUrl)` resolves hostnames via `dns.promises.lookup(hostname, { all: true, verbatim: true })` and evaluates all resolved addresses.
- **Integrated Before Subprocess Execution**: POST `/api/download` awaits `validateUrlForDownload` before disk space checks, before slot acquisition, and before executing yt-dlp or FFmpeg.
- **Information Leakage Prevention**: DNS resolution failures and forbidden IPs return generic safe error messages (`"URL host could not be safely resolved."`).
- **Proxy Policy Documented**: Direct downloads strictly reject private IP spaces. Outbound proxies (`YT_PROXY` / `HTTP_PROXY`) remain explicitly server-configured; user-supplied proxy parameters are never accepted.

---

## 12. Phase 5 — True MP3 Audio Transcoding

### 1. Architectural Scope & Pipeline
Phase 5 implements genuine MP3 audio transcoding for NexusLoad without altering Phase 4/4.1 video or native audio behavior. Native `m4a` and `webm` downloads continue to stream without transcoding when MP3 is not requested.

```text
User Request (type=audio + format=mp3 + optional bitrate)
          │
          ▼
[Format & Bitrate Validation] ─── Server allowlist (128k, 192k [default], 256k, 320k)
          │
          ▼
[Disk Space Check] ─── sourceAudioSize * 2 + 50 MB reserve
          │
          ▼
[yt-dlp Native Download] ─── <job-id>.source.<ext> (best available native stream)
          │
          ▼
[FFmpeg Transcode via Child Process]
-map 0:a:0 -vn -c:a libmp3lame -b:a <bitrate> -id3v2_version 3 -write_id3v1 1
-progress pipe:1 -nostats -f mp3 <job-id>.mp3.tmp
          │
          ▼
[Output & Container Integrity Validation] ─── validateMp3Integrity()
          │
          ▼
[Atomic Rename] ─── <job-id>.mp3.tmp -> final_<job-id>.mp3
          │
          ▼
[Cleanup Source Audio] ─── delete <job-id>.source.<ext>
          │
          ▼
[Release Concurrency Slot] ─── releaseDownloadSlot() exactly once
          │
          ▼
[Job Status = READY (100%)] ─── Streamed via existing stream-helper with HTTP Range (200 / 206)
```

### 2. Request & Contradiction Validation
- **Bitrate Allowlist**: Strictly restricted to `['128k', '192k', '256k', '320k']`. All arbitrary, unlisted, or command-injection values are rejected.
- **Contradiction Guards**:
  - `type=audio` + `format=mp3` -> VALID (defaults to 192k if unspecified).
  - `type=video` + `format=mp3` -> INVALID (rejected).
  - `type=video` + `bitrate` -> INVALID (rejected).
  - `quality=1080p` + `format=mp3` -> INVALID (rejected).
  - `type=audio` + `quality=1080p` -> INVALID (rejected).
  - `type=audio` + `format=m4a` / `format=webm` -> Native audio behavior preserved unchanged.
- **Client Metadata Sanitization**: Title, artist, and album are capped at 500 characters; date is capped at 32 characters. Null bytes (`\x00`), control characters, and line breaks are stripped before passing to FFmpeg argument arrays.

### 3. Process Lifecycle & Concurrency
- **Lifecycle Guarantees**: FFmpeg runs through `runCommandWithLifecycle`, wired to the job's `AbortController.signal` and an isolated POSIX process group. If the client cancels or the command times out, `killProcessTree` terminates FFmpeg without leaving orphan processes.
- **Single Slot Occupancy**: The download slot is acquired once at job creation and held across both yt-dlp download and FFmpeg transcode phases. An atomic `job.slotAcquired` guard ensures the slot is released exactly once on success, failure, timeout, or cancellation.
- **Proactive Disk Space Guard**: Before transcoding commences, disk space is verified against `sourceAudioStat.size * 2 + 50MB` to accommodate both source audio and partial MP3 simultaneously.

### 4. Output Validation & Atomic Finalization
- **Strict Integrity Checks**: Exit code 0 alone is not trusted. `validateMp3Integrity` inspects the initial bytes:
  - Parses ID3v2 tag header (`ID3` magic bytes, flags, and 7-bit synchsafe tag length).
  - Scans for MPEG audio frame synchronization words (`0xFF` with 3 top bits set).
  - Validates MPEG version (rejection of reserved 01) and layer bits (Layer III / MP3).
  - Rejects empty (0-byte), corrupted, non-audio, or renamed M4A/WebM files.
- **Atomic Promotion**: The file is transcoded as `<job-id>.mp3.tmp` with `-f mp3` muxer specification and only promoted via `fs.renameSync` after `validateMp3Integrity` passes. The job status is only transitioned to `ready` with `progress = 100` after promotion.

### 5. Verification Matrix (Phase 5)
| Test ID | Category | Test Description | Result |
| :--- | :--- | :--- | :--- |
| **1–7** | **Validation** | Bitrates (128k, 192k, 256k, 320k), invalid bitrate rejection, contradiction checks | **PASSED** |
| **8–13** | **FFmpeg Transcode** | Native m4a/webm -> mp3, `.mp3` extension, `audio/mpeg` MIME, `validateMp3Integrity` | **PASSED** |
| **14–18** | **Cleanup** | Source removed on success/failure, partial MP3 removed, cleanup on cancel/timeout | **PASSED** |
| **19–21** | **Process Lifecycle** | FFmpeg abort signal termination, timeout termination, no orphan process handles | **PASSED** |
| **22–24** | **Progress** | Real-time `out_time_us` parsing, clamped <= 99% during transcode, 100% only at ready | **PASSED** |
| **25** | **Memory** | Filesystem-backed processing, zero whole-file heap buffering | **PASSED** |
| **26–29** | **Concurrency** | 1 slot held, released after success/failure/cancellation, slot not released twice | **PASSED** |
| **30–33** | **Streaming** | Full 200 stream with `audio/mpeg`, Range 206 (`bytes=0-0`, `bytes=-100`), 416 invalid | **PASSED** |
| **Live** | **End-to-End** | Live YouTube download & transcode to MP3, 44.1kHz stereo 192 kbps, HTTP 200 & 206 | **PASSED** |
| **Static** | **TypeScript** | `tsc --noEmit` (0 errors) | **PASSED** |
| **Static** | **ESLint** | `eslint` on all project sources (0 errors, 0 warnings) | **PASSED** |
| **Build** | **Next.js Build** | `next build` Turbopack compilation (Exit code 0) | **PASSED** |
| **Suite** | **Test Suites** | `tests/phase4_1.test.mjs` (30/30) + `tests/phase5.test.mjs` (43/43) = 73 tests | **PASSED (73/73)** |

---

## 13. Phase 6 — API Security, Abuse Protection & Production Operations

### 1. Request Validation Hardening (Bounded Memory)
- **16 KB Body Size Limit**: Enforced before unbounded JSON parsing or memory retention via `parseBoundedJson()` in `src/lib/validation.ts`.
  - Content-Length header is checked first; payloads declaring `> 16384 bytes` are rejected immediately with HTTP 400 `INVALID_REQUEST` before streaming any bytes into memory.
  - Chunked or unannounced payloads are streamed through a `ReadableStreamDefaultReader` with byte accounting; the moment cumulative bytes exceed 16 KB, `reader.cancel()` is immediately called to sever downstream transfer, and HTTP 400 is returned without accumulating unbounded chunks.
- **Content-Type Validation**: Requests must provide `application/json` (case-insensitive substring check). Non-JSON content types (e.g. `text/plain`, `multipart/form-data`) are rejected with HTTP 400.
- **Strict Parameter Allowlists**:
  - `POST /api/download`: Only `['url', 'type', 'quality', 'format', 'title', 'bitrate', 'artist', 'album', 'date']` permitted. Unexpected fields are rejected with HTTP 400.
  - `GET /api/download`: Same query parameter allowlist enforced.
  - `POST /api/extract`: Only `['url']` permitted. Unexpected fields rejected with HTTP 400.
- **Type, Length & Enum Constraints**:
  - URL must be string, non-empty, <= 2048 characters.
  - Title, artist, and album must be string, <= 500 characters.
  - Date must be string, <= 32 characters.
  - `type` restricted strictly to `'audio' | 'video'`.
  - `bitrate` restricted strictly to `['128k', '192k', '256k', '320k']`.

### 2. In-Process Sliding Window Rate Limiting
- **Zero External Dependencies**: Implemented in `src/lib/rate-limiter.ts` using an in-process, bounded-memory sliding window Map (`rateLimitStore`). Does not introduce Redis or external databases.
- **Separate Bucket Configuration**:
  - `download` (POST / GET `/api/download`): Default 10 requests / 10 minutes (`NEXUS_RATE_DOWNLOAD_LIMIT=10`, `NEXUS_RATE_DOWNLOAD_WINDOW_MS=600000`).
  - `status` (GET `/api/download/[jobId]/status` and status queries): Default 120 requests / 1 minute (`NEXUS_RATE_STATUS_LIMIT=120`, `NEXUS_RATE_STATUS_WINDOW_MS=60000`).
  - `cancel` (DELETE `/api/download/[jobId]`): Default 30 requests / 10 minutes (`NEXUS_RATE_CANCEL_LIMIT=30`, `NEXUS_RATE_CANCEL_WINDOW_MS=600000`).
  - `stream` (GET `/api/download/[jobId]` file streaming): Default 30 requests / 1 minute (`NEXUS_RATE_STREAM_LIMIT=30`, `NEXUS_RATE_STREAM_WINDOW_MS=60000`).
- **HTTP 429 & Retry-After**: When a client exceeds their action limit, a structured HTTP 429 `RATE_LIMITED` response is returned with the standard `Retry-After: <seconds>` header indicating the duration until window reset.
- **Safe Environment Variable Parsing**: `parseEnvInteger()` parses numeric environment variables with strict fallback to safe defaults if missing, NaN, non-finite, or <= 0.
- **Client Identity & Anti-Spoofing Security**:
  - `getClientIdentifier()` extracts direct connection client IP by default.
  - Client-supplied forwarding headers (`X-Forwarded-For`, `CF-Connecting-IP`, `X-Real-IP`) are strictly ignored unless proxy trust is explicitly enabled via `NEXUS_TRUST_PROXY === 'true'` or `TRUST_PROXY === 'true'`.
  - IPv4-mapped IPv6 addresses (`::ffff:x.x.x.x`) are normalized to standard IPv4.
- **Bounded Memory & Eviction Policy**:
  - Hard cap of 10,000 tracked clients (`MAX_TRACKED_CLIENTS = 10000`).
  - Automatic LRU / oldest entry eviction when the store reaches maximum capacity.
  - Background periodic sweeper running every 60 seconds (`unref()` timer) to purge expired client records.

### 3. Capability Token Authorization & Integrity
- **Canonical Format Verification**: Validated strictly by `isValidJobId()` against `/^[a-f0-9]{48}$/i`. Derived directly from the real 192-bit cryptographic capability token generator (`crypto.randomBytes(24).toString('hex')`).
- **Pre-Lookup Guard**: Malformed, non-hex, path-traversal (`../`), or injection strings are rejected with HTTP 400 `INVALID_REQUEST` before performing any memory store lookups or filesystem queries.
- **Information Leakage Prevention**:
  - Non-existent capability IDs return HTTP 404 `JOB_NOT_FOUND`.
  - Expired jobs return HTTP 410 `JOB_EXPIRED`.
  - Internal temporary directory paths, process IDs, and stack traces are never exposed in error responses.

### 4. Cancellation Idempotency & Resource Balancing
- **Strict Idempotency**: Calling `DELETE /api/download/[jobId]` multiple times sequentially or concurrently on the same job is strictly idempotent.
- **Zero Double-Release**: `job.slotAcquired` atomic boolean guard guarantees that concurrency download slots are released exactly once.
- **Non-Negative Guard**: Concurrency counter `activeDownloads` is clamped at `>= 0`.
- **Targeted Scope**: Cancelling a job exclusively terminates that specific job's subprocess tree and temporary resources without impacting any concurrent jobs.

### 5. Stream Abuse & Concurrency Controls
- **Per-Job Stream Limiting**: Bounded by `MAX_STREAMS_PER_JOB = 10`. If a job reaches 10 concurrent active streams, subsequent stream requests return HTTP 429 `SERVER_BUSY`.
- **Server-Wide Stream Limiting**: Bounded by `MAX_SERVER_STREAMS = 50`. Global active streams exceeding capacity return HTTP 503 `SERVER_BUSY`.
- **Precise Stream Accounting**:
  - Rejected streams do NOT increment `job.activeStreams`.
  - Accepted streams increment `job.activeStreams` and global stream counter by 1.
  - On stream completion, client abort, or transmission error, `job.activeStreams` and global stream counters are decremented exactly once via an atomic `isCleanedUp` guard.
- **HTTP Range Streaming Preservation**: Supports HTTP 200 (full file), HTTP 206 (single-byte and suffix byte ranges), and HTTP 416 (Range Not Satisfiable for inverted or out-of-bounds ranges).
- **Header Injection Defense**: `Content-Disposition` filenames are sanitized with RFC-5987 UTF-8 encoding and ASCII-safe replacements, preventing CRLF response splitting.

### 6. Security Headers
- Standard security headers emitted across all responses (application routes, streaming media, and error payloads):
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `X-Frame-Options: SAMEORIGIN`
- Globally wired via `next.config.ts` headers configuration and directly attached on programmatic `createApiError` and `createFileStreamResponse` handlers.

### 7. Structured Operational Logging & Secret Redaction
- **Machine-Readable JSON Logs**: Implemented in `src/lib/logger.ts` emitting `[nexusload:ops] { timestamp, event, ... }` to stdout.
- **Covered Operational Events**:
  - `job_created`, `download_started`, `download_retry`, `download_completed`
  - `mp3_transcode_started`, `mp3_transcode_completed`
  - `job_cancelled`, `job_failed`, `job_expired`
  - `ssrf_rejected`, `rate_limit_rejected`, `stream_rejected`
- **Strict Redaction Guarantees**:
  - URLs logged only as protocol + host via `sanitizeUrlForLogging()` (query parameters, auth tokens, and session identifiers stripped).
  - Cookie strings redacted to `cookies=[REDACTED]`.
  - Bearer tokens redacted to `bearer [REDACTED]`.
  - Absolute filesystem paths (Windows drive letters and Unix paths) redacted to `[PATH_REDACTED]`.
  - Request bodies, raw command lines, and environment secrets are never logged.

### 8. Verification Matrix (Phase 6)
| Test Category | Covered Scenarios | Result |
| :--- | :--- | :--- |
| **Request Validation** | 16 KB body limit, early stream abort, non-JSON rejection, malformed syntax, non-objects, unexpected fields, invalid types | **PASSED** |
| **Rate Limiting** | 10/10m download, 120/1m status, 30/10m cancel, 30/1m stream, Retry-After header, proxy spoofing protection, store bounds | **PASSED** |
| **Capability Tokens** | 48-hex lowercase validation, traversal rejection, injection rejection, safe 400/404/410 responses | **PASSED** |
| **Cancellation Idempotency** | Repeat cancellation, concurrent cancellation, single slot release, non-negative active slot counters | **PASSED** |
| **Stream Protection** | Max 10 streams/job limit, reject without increment, single decrement on complete/abort, HTTP Range 200/206/416 | **PASSED** |
| **Security Headers** | `nosniff`, `strict-origin`, `Permissions-Policy`, `SAMEORIGIN` across API errors, streams, and status | **PASSED** |
| **Operational Logging** | JSON emission, event tracking, URL query stripping, cookie redaction, token redaction, path redaction | **PASSED** |
| **Route Audits** | End-to-end testing of `download`, `download/[jobId]`, `status`, and `extract` handlers | **PASSED** |
| **Race Conditions & SSRF** | Burst stream limit races, SSRF IP/CIDR rejection, format mapping regressions | **PASSED** |
| **TypeScript Audit** | `npx tsc --noEmit` (0 errors) | **PASSED** |
| **Lint Audit** | `npm run lint` (0 errors) | **PASSED** |
| **Build Audit** | `next build` Turbopack compilation (Exit code 0) | **PASSED** |
| **Test Suites** | `tests/phase4_1.test.mjs` (30/30) + `tests/phase5.test.mjs` (43/43) + `tests/phase6.test.mjs` (48/48) = 121 tests | **PASSED (121/121)** |






