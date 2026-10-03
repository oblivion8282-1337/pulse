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

// ---------------------------------------------------------------------------
// tcpProbe
// ---------------------------------------------------------------------------

/**
 * Port-Offen-Check (TCP-Connect) — für Dienste ohne HTTP-Health-Endpunkt
 * (Garnet/Redis, weed, LiveKit-RPC). Gibt true zurück, wenn sich innerhalb
 * von `timeoutMs` eine Verbindung aufbauen lässt.
 */
export async function tcpProbe(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}
