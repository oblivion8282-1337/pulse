/**
 * Health-Probe-Hilfsfunktionen für den lokalen Self-Host-Orchestrator.
 *
 * Zwei Bausteine:
 *   httpHealth — GET + AbortController; prüft HTTP-200.
 *
 * Keine externen Dependencies — nur Node-Builtins.
 */


// ---------------------------------------------------------------------------
// httpHealth
// ---------------------------------------------------------------------------

/**
 * Führt ein GET gegen `url` aus.
 * Gibt true zurück, wenn der HTTP-Status 2xx ist, sonst false.
 * Fehler (ECONNREFUSED, Timeout, …) → false.
 */
export async function httpHealth(url: string, timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Poll bis ``check`` true liefert (oder ``totalMs`` abläuft) — wirft bei
 *  Timeout. Frueher in der Ponytail-Passage eingespart, als der einzige
 *  Rufer sie inline trug; der Win/Mac-Container-Wartepfad (Merge
 *  feat/win-server-app-v2) braucht sie wieder als geteilten Helfer. */
export async function waitFor(
  check: () => Promise<boolean>,
  totalMs: number,
  intervalMs = 250,
): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
  }
  throw new Error(`waitFor: timed out after ${totalMs}ms`);
}
