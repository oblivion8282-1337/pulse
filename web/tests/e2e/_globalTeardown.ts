import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

function killTree(pid: number): void {
  // Kill the process and its children. `uv run` spawns a child python/uvicorn
  // process that must also be stopped — killing only the wrapper PID leaves the
  // server running on its port and blocks the next test setup.
  try {
    const children = execSync(`pgrep -P ${pid}`, { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    for (const child of children.split(/\s+/).filter(Boolean)) {
      try { process.kill(Number(child), 'SIGTERM'); } catch { /* already gone */ }
    }
  } catch { /* pgrep exits 1 when no children found */ }
  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

export default async function globalTeardown() {
  const pidFile = resolve(ROOT, 'node_modules/.dcc-e2e-pids.json');
  let pids: number[] = [];
  try {
    pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    // No pid file — nothing to kill.
    return;
  }
  for (const pid of pids) {
    killTree(pid);
  }
  // Clear the pid file so the next setup knows there are no stale test processes.
  try {
    writeFileSync(pidFile, '[]');
  } catch { /* best-effort */ }
}
