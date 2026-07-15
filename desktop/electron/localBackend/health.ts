/**
 * Health-Probe-Hilfsfunktionen für den lokalen Self-Host-Orchestrator.
 *
 * Zwei Bausteine:
 *   httpHealth — GET + AbortController; prüft HTTP-200.
 *   waitFor   — Poll-Schleife bis check() true ist oder Timeout.
 *
 * Keine externen Dependencies — nur Node-Builtins.
 */

import { setTimeout as sleep } from 'node:timers/promises';

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

// ---------------------------------------------------------------------------
// waitFor
// ---------------------------------------------------------------------------

/**
 * Pollt `check()` alle `intervalMs` Millisekunden bis es `true` zurückgibt.
 * Wirft einen Error mit "timed out" wenn `totalMs` abgelaufen ist.
 */
export async function waitFor(
  check: () => Promise<boolean>,
  totalMs: number,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
  }
  throw new Error(`waitFor: timed out after ${totalMs}ms`);
}
