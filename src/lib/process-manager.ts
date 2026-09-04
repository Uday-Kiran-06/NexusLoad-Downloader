import { execFile, ChildProcess, type ExecFileOptions } from 'child_process';
import os from 'os';

const isWin = os.platform() === 'win32';

// Safe default timeouts (in milliseconds)
export const TIMEOUT_CONFIG = {
  get MAX_EXTRACTION_TIME() {
    return parseInt(process.env.MAX_EXTRACTION_TIME || '45000', 10);
  },
  get MAX_DOWNLOAD_TIME() {
    return parseInt(process.env.MAX_DOWNLOAD_TIME || '180000', 10);
  },
  get MAX_CONVERSION_TIME() {
    return parseInt(process.env.MAX_CONVERSION_TIME || '90000', 10);
  },
};

/**
 * Platform-aware process tree termination.
 * On Windows: Uses taskkill /T /F to forcibly terminate the entire process tree.
 * On Linux: Sends SIGTERM to process group, escalating to SIGKILL after a grace period.
 */
export function killProcessTree(pid: number | undefined): void {
  // Guard against invalid PID or accidentally killing the parent Node.js process
  if (!pid || pid <= 1 || pid === process.pid) return;

  if (isWin) {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
        if (err && (err as unknown as { code?: number }).code !== 128) {
          // Error code 128 indicates process has already exited
          console.warn(`[process-manager] taskkill on PID ${pid} warning:`, err.message);
        }
      });
    } catch {
      // Ignore failure if process already terminated
    }
  } else {
    // POSIX: Process group termination using negative PID (since spawned with detached: true)
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (err: unknown) {
      // If process group doesn't exist or already exited, fall back to direct PID
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Process already dead
        }
      }
    }

    // Escalate to SIGKILL after the existing grace period
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already dead
        }
      }
    }, 1500);
  }
}

/**
 * Executes a command with timeout and client abort handling, guaranteeing
 * clean subprocess termination and preventing orphan processes.
 */
export function runCommandWithLifecycle(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    clientSignal?: AbortSignal;
    maxBuffer?: number;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;
    let isTerminated = false;

    const timeoutLimit = typeof options?.timeoutMs === 'number' ? options.timeoutMs : TIMEOUT_CONFIG.MAX_DOWNLOAD_TIME;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options?.clientSignal) {
        options.clientSignal.removeEventListener('abort', onAbort);
      }
    };

    const terminate = (reason: 'timeout' | 'abort') => {
      if (isTerminated) return;
      isTerminated = true;

      const pid = child?.pid;
      if (pid) {
        console.log(`[process-manager] Terminating process tree (PID ${pid}) due to ${reason}`);
        killProcessTree(pid);
      }

      cleanup();

      if (reason === 'timeout') {
        const timeoutErr = Object.assign(
          new Error(`Command exceeded timeout limit of ${timeoutLimit}ms`),
          { code: 'ETIMEDOUT' }
        );
        reject(timeoutErr);
      } else {
        const abortErr = Object.assign(
          new Error('Operation aborted by client'),
          { code: 'ECONNABORTED' }
        );
        reject(abortErr);
      }
    };

    const onAbort = () => terminate('abort');

    // Check if client signal is already aborted
    if (options?.clientSignal?.aborted) {
      return terminate('abort');
    }

    if (options?.clientSignal) {
      options.clientSignal.addEventListener('abort', onAbort, { once: true });
    }

    // Set timeout timer
    if (timeoutLimit > 0) {
      timer = setTimeout(() => terminate('timeout'), timeoutLimit);
    }

    try {
      child = execFile(
        command,
        args,
        {
          maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
          windowsHide: true,
          detached: !isWin,
        } as ExecFileOptions & { detached?: boolean; windowsHide?: boolean },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          cleanup();
          if (isTerminated) return; // Already rejected via timeout/abort

          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
          } else {
            resolve({
              stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf-8'),
              stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf-8'),
            });
          }
        }
      );

      // Stream stdout lines if requested (splits on \n or \r to handle terminal progress)
      if (options.onStdoutLine && child.stdout) {
        let stdoutBuf = '';
        child.stdout.on('data', (chunk: Buffer | string) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split(/[\r\n]+/);
          stdoutBuf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) options.onStdoutLine!(line);
          }
        });
      }

      // Stream stderr lines if requested
      if (options.onStderrLine && child.stderr) {
        let stderrBuf = '';
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split(/[\r\n]+/);
          stderrBuf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) options.onStderrLine!(line);
          }
        });
      }
    } catch (spawnError) {
      cleanup();
      reject(spawnError);
    }
  });
}
