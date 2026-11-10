// Test cleanup that also works on Windows, where a file another process still has open
// cannot be deleted, and a killed process lets go of its files only after it has exited.
// So stop a process and wait for it to be gone, then remove its folder.
import { rm } from 'node:fs/promises';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Stop a process this test started and wait until it has exited. */
export async function stopProcess(pid, timeoutMs = 5000) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await pause(50);
  }
}

/** Remove a temporary folder, retrying while Windows still holds a file in it. */
export const removeDir = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
