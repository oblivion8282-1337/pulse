import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

export default async function globalTeardown() {
  const pidFile = resolve(ROOT, 'node_modules/.dcc-e2e-pids.json');
  let pids: number[] = [];
  try {
    pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    // No pid file — nothing to kill (setup may not have run or already cleaned up).
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone — that's fine.
    }
  }
}
