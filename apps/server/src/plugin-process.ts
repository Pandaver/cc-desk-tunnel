import type { ChildProcess } from 'node:child_process';

// Ends a plugin's process and what it started: it was started detached, as a group of its own.
export function stop(child: ChildProcess) {
  if (process.platform === 'win32' || !child.pid) child.kill();
  else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
}
