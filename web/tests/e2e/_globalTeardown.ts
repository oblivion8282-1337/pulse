export default async function globalTeardown() {
  const pids = (process.env.__DCC_TEST_PIDS ?? '').split(',').filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid));
    } catch {
      // already gone
    }
  }
}
