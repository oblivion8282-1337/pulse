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

