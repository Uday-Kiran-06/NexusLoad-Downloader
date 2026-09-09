import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const isWin = os.platform() === 'win32';
const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const localYtDlp = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binName);

if (fs.existsSync(localYtDlp)) {
  try {
    const res = spawnSync(localYtDlp, ['-U'], { stdio: 'inherit', timeout: 30000 });
    if (res.status === 0) {
      console.log('[ensure-ytdlp] yt-dlp binary is up to date.');
    }
  } catch {
    // Gracefully handle network unavailability during offline builds
    console.log('[ensure-ytdlp] Note: Offline or unable to check for yt-dlp self-update.');
  }
}
