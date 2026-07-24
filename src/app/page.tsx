"use client";

import { useState } from "react";

type MediaOption = { id: number; quality: string; format: string; size: string; type: string; url: string };

function Bubble({ size, top, left, delay, color }: { size: number; top: string; left: string; delay: string; color: string }) {
  return (
    <div
      className="absolute rounded-full pointer-events-none animate-pulse"
      style={{
        width: size, height: size,
        top, left,
        background: color,
        filter: `blur(${Math.round(size / 3)}px)`,
        animationDelay: delay,
        opacity: 0.18,
      }}
    />
  );
}

const SITES = [
  { name: "YouTube", icon: "▶️", color: "#ff0000", desc: "Videos, Shorts, Playlists" },
  { name: "Instagram", icon: "📸", color: "#e1306c", desc: "Reels, Posts, Stories" },
  { name: "TikTok", icon: "🎵", color: "#010101", desc: "Videos, Sounds" },
  { name: "Twitter/X", icon: "🐦", color: "#1da1f2", desc: "Videos, GIFs" },
  { name: "Facebook", icon: "👤", color: "#1877f2", desc: "Videos, Reels" },
  { name: "Twitch", icon: "🎮", color: "#9146ff", desc: "VODs, Clips" },
  { name: "Reddit", icon: "🤖", color: "#ff4500", desc: "Videos, GIFs" },
  { name: "Vimeo", icon: "🎬", color: "#1ab7ea", desc: "HD Videos" },
  { name: "Dailymotion", icon: "📹", color: "#0066dc", desc: "Videos" },
  { name: "Pinterest", icon: "📌", color: "#e60023", desc: "Videos, GIFs" },
  { name: "LinkedIn", icon: "💼", color: "#0a66c2", desc: "Videos" },
  { name: "Snapchat", icon: "👻", color: "#fffc00", desc: "Stories, Spotlight" },
  { name: "SoundCloud", icon: "🎧", color: "#ff5500", desc: "Audio Tracks" },
  { name: "Bandcamp", icon: "🎸", color: "#1da0c3", desc: "Music, Albums" },
  { name: "Bilibili", icon: "📺", color: "#fb7299", desc: "Videos" },
  { name: "Niconico", icon: "🇯🇵", color: "#252525", desc: "Videos" },
  { name: "Rumble", icon: "📡", color: "#85c742", desc: "Videos" },
  { name: "Odysee", icon: "🌊", color: "#ef1970", desc: "Videos" },
  { name: "9GAG", icon: "😂", color: "#000000", desc: "GIFs, Videos" },
  { name: "ESPN", icon: "🏆", color: "#d00", desc: "Sports Clips" },
  { name: "Ted", icon: "💡", color: "#e62b1e", desc: "Talks" },
  { name: "700+ More", icon: "🌐", color: "#7c3aed", desc: "Powered by yt-dlp" },
];

export default function Home() {
  const [url, setUrl] = useState("");
  const [showSites, setShowSites] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadingLabel, setDownloadingLabel] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mediaOptions, setMediaOptions] = useState<MediaOption[] | null>(null);
  const [mediaInfo, setMediaInfo] = useState<{ title: string; thumbnail: string | null } | null>(null);

  const handleExtract = async () => {
    if (!url.trim()) return;
    setIsLoading(true);
    setMediaOptions(null);
    setMediaInfo(null);
    setError(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to extract video");
      setMediaInfo({ title: data.title, thumbnail: data.thumbnail });
      setMediaOptions(data.options);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFormatDownload = async (opt: MediaOption) => {
    setIsDownloading(true);
    setProgress(0);
    setProgressStage("Connecting to server...");
    setDownloadingLabel(`${opt.quality} ${opt.type === "audio" ? "Audio" : "Video"}`);

    // Simulate realistic server-side processing progress (download + merge takes time before bytes flow)
    let serverProgress = 0;
    const stages = [
      { target: 40, ms: 18000, label: "Downloading video stream..." },
      { target: 78, ms: 10000, label: "Downloading audio stream..." },
      { target: 94, ms: 6000, label: "Video and Audio Files Merging..." },
      { target: 99, ms: 4000, label: "Finalizing file..." },
    ];
    let si = 0, stageStart = Date.now(), stageBase = 0;
    const fakeTimer = setInterval(() => {
      if (si >= stages.length) return;
      const s = stages[si];
      const frac = Math.min((Date.now() - stageStart) / s.ms, 1);
      const eased = 1 - Math.pow(1 - frac, 2);
      serverProgress = stageBase + (s.target - stageBase) * eased;
      setProgress(Math.round(serverProgress));
      setProgressStage(s.label);
      if (frac >= 1) { si++; stageStart = Date.now(); stageBase = s.target; }
    }, 80);

    try {
      const response = await fetch(opt.url);
      clearInterval(fakeTimer);

      if (!response.ok) throw new Error("Server returned an error. Please try again.");
      if (!response.body) throw new Error("No response body received.");

      // Read the actual response bytes and track real download progress
      const contentLength = response.headers.get("content-length");
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as BlobPart);
        received += value?.length ?? 0;
        setProgressStage("Transferring file to browser...");
        setProgress(total > 0 ? Math.round((received / total) * 100) : 99);
      }

      setProgress(100);
      setProgressStage("Download complete! 🎉");

      // Combine chunks and trigger browser save dialog
      const contentType = response.headers.get("content-type") || "video/mp4";
      const blob = new Blob(chunks, { type: contentType });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${(mediaInfo?.title || "download").replace(/[^a-z0-9]/gi, "_")}.${opt.type === "audio" ? "mp3" : "mp4"}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);

      await new Promise((r) => setTimeout(r, 1200));
    } catch (err: any) {
      clearInterval(fakeTimer);
      setError(err.message || "Download failed.");
    } finally {
      setIsDownloading(false);
      setProgress(0);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f1115] text-slate-100 flex flex-col relative overflow-hidden">

      {/* Floating Bubble Background */}
      <Bubble size={420} top="-10%" left="-8%" delay="0s" color="radial-gradient(circle, #7c3aed, transparent)" />
      <Bubble size={300} top="60%" left="75%" delay="1.2s" color="radial-gradient(circle, #2563eb, transparent)" />
      <Bubble size={180} top="30%" left="58%" delay="0.6s" color="radial-gradient(circle, #db2777, transparent)" />
      <Bubble size={220} top="72%" left="12%" delay="2s" color="radial-gradient(circle, #0891b2, transparent)" />
      <Bubble size={140} top="12%" left="82%" delay="0.3s" color="radial-gradient(circle, #7c3aed, transparent)" />
      <Bubble size={100} top="88%" left="52%" delay="1.8s" color="radial-gradient(circle, #db2777, transparent)" />

      {/* Processing Overlay */}
      {isDownloading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md">
          <div className="glass-panel rounded-3xl p-10 flex flex-col items-center gap-7 max-w-sm w-full mx-4 shadow-2xl border border-purple-500/30">
            {/* Icon + title */}
            <div className="flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-purple-600 to-blue-500 flex items-center justify-center shadow-[0_0_24px_rgba(139,92,246,0.5)]">
                <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-white font-bold text-lg leading-tight">Processing Download</p>
                <p className="text-purple-300 text-sm mt-0.5">{downloadingLabel}</p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="w-full flex flex-col gap-2">
              <div className="flex justify-between items-center text-xs font-medium">
                <span className="text-slate-400">{progressStage}</span>
                <span className="text-white tabular-nums">{progress}%</span>
              </div>
              <div className="w-full h-3 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full relative overflow-hidden transition-all duration-300 ease-out"
                  style={{
                    width: `${progress}%`,
                    background: "linear-gradient(90deg, #7c3aed, #2563eb, #7c3aed)",
                    backgroundSize: "200% 100%",
                    animation: "shimmer 2s linear infinite",
                  }}
                >
                  {/* Shimmer shine */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse" />
                </div>
              </div>
            </div>

            {/* Hint */}
            <p className="text-slate-500 text-xs text-center leading-relaxed">
              Merging HD video &amp; audio on the server.<br />File saves automatically when ready.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="w-full p-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="NexusLoad Logo" className="w-8 h-8 rounded-lg object-cover shadow-[0_0_15px_rgba(168,85,247,0.4)]" />
          <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-blue-400">
            NexusLoad
          </span>
        </div>
        <nav className="hidden sm:flex gap-6 text-sm font-medium text-slate-400 relative">
          <button onClick={() => setShowSites(v => !v)} className="hover:text-white transition-colors flex items-center gap-1">
            Supported Sites
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-200 ${showSites ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <a href="#" className="hover:text-white transition-colors">FAQ</a>

          {/* Supported Sites Dropdown */}
          {showSites && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-30" onClick={() => setShowSites(false)} />
              <div className="absolute right-0 top-8 z-40 w-[480px] glass-panel rounded-2xl p-5 shadow-2xl border border-purple-500/20">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">Supported Platforms</p>
                <div className="grid grid-cols-3 gap-2">
                  {SITES.map((s) => (
                    <div key={s.name} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                      <span className="text-lg leading-none">{s.icon}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white truncate">{s.name}</p>
                        <p className="text-[10px] text-slate-500 truncate">{s.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-600 mt-3 text-center">Powered by yt-dlp — supports 1000+ sites</p>
              </div>
            </>
          )}
        </nav>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 z-10">
        <div className="max-w-2xl w-full flex flex-col items-center text-center gap-8">

          <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight leading-tight">
            Download Any Media <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400">
              Without Limits.
            </span>
          </h1>

          <p className="text-lg text-slate-400 max-w-lg -mt-4">
            Paste a link from YouTube, Instagram, Twitter, or TikTok and get high-quality videos and audio instantly.
          </p>

          {/* URL Input */}
          <div className="w-full max-w-xl">
            <div
              className={`relative glass-panel rounded-2xl p-2 flex flex-col sm:flex-row gap-2 transition-all duration-300 ${isHovering ? "shadow-[0_0_30px_rgba(168,85,247,0.15)] border-purple-500/30" : ""}`}
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={() => setIsHovering(false)}
            >
              <div className="relative flex-1 flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-4 text-slate-500">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <input
                  type="url"
                  placeholder="Paste a YouTube, TikTok, or Instagram link..."
                  className="w-full bg-transparent border-none outline-none text-white placeholder:text-slate-500 pl-12 pr-4 py-3"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleExtract()}
                />
              </div>
              <button
                onClick={handleExtract}
                disabled={isLoading}
                className="glow-effect rounded-xl bg-white text-black font-semibold px-6 py-3 sm:py-0 transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed min-w-[140px]"
              >
                {isLoading ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-black" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Fetching...
                  </>
                ) : (
                  <>
                    Analyse
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-2 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 max-w-xl w-full text-left flex items-center gap-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="text-sm">{error}</span>
            </div>
          )}

          {/* Format Options */}
          {mediaOptions && mediaInfo && (
            <div className="w-full max-w-xl flex flex-col gap-5 text-left">
              <div className="flex gap-4 items-center bg-white/5 p-3 rounded-2xl border border-white/5">
                {mediaInfo.thumbnail && (
                  <img src={mediaInfo.thumbnail} alt={mediaInfo.title} className="w-20 h-20 object-cover rounded-xl shadow-lg flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-bold text-slate-100 line-clamp-2">{mediaInfo.title}</h3>
                  <p className="text-xs text-slate-400 mt-1">Select a format to download</p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {mediaOptions.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => handleFormatDownload(opt)}
                    className="glass-panel p-4 rounded-xl flex flex-col gap-2 hover:bg-white/10 hover:border-purple-500/50 transition-all cursor-pointer group shadow-lg text-left"
                  >
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-base text-white">{opt.quality}</span>
                      <span className="text-[9px] uppercase tracking-wider font-bold px-2 py-1 bg-gradient-to-r from-purple-500/20 to-blue-500/20 text-purple-200 rounded-md border border-purple-500/20">
                        {opt.format}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-slate-400 text-xs mt-1">
                      <span>{opt.size}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:text-purple-400 group-hover:translate-y-0.5 transition-all duration-300">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Platform badges */}
          {!mediaOptions && (
            <div className="flex gap-3 mt-2 flex-wrap justify-center">
              {["YOUTUBE", "INSTAGRAM", "TIKTOK", "TWITTER"].map((p) => (
                <span key={p} className="text-xs font-bold tracking-widest text-slate-600 px-3 py-1 rounded-full border border-white/5">
                  {p}
                </span>
              ))}
            </div>
          )}

        </div>
      </main>

      {/* Footer */}
      <footer className="w-full p-5 text-center text-xs text-slate-600 border-t border-white/5 z-10">
        © {new Date().getFullYear()} NexusLoad — High Quality Media Downloader
      </footer>
    </div>
  );
}
