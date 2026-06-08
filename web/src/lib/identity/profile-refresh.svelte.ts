/**
 * Background-Timer für Profile-Statement-Refresh (DE 11 Block 1.H / A.2).
 *
 * Strategie:
 *  - Beim Boot: prüfe ob Statement-Expiry < 4h → sofortiger Refresh
 *  - Setze Timeout für nächsten Refresh: (Expiry - 4h) relativ zur jetzigen Zeit
 *  - Minimum-Intervall: 60s (verhindert Tight-Loop bei kaputtem Statement)
 *  - Beim Logout: stopTimer() aufrufen
 */

import { profileStatementStore, isStatementExpiringSoon, parseStatementClaims } from './profile-statement.svelte';
import type { ProfileStatement } from './profile-statement.svelte';
import { getProfileStatement } from '$lib/api/credentials';

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/** Refresh wenn < 4h verbleiben (= 14400 Sekunden). */
const REFRESH_THRESHOLD_SECS = 4 * 3600;
/** Minimales Warteintervall bis zum nächsten Refresh-Versuch (60s). */
const MIN_REFRESH_INTERVAL_MS = 60_000;
/** Maximales Intervall: 20h (sicher unter 24h-Expiry). */
const MAX_REFRESH_INTERVAL_MS = 20 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Interner State
// ---------------------------------------------------------------------------

let _timerId: ReturnType<typeof setTimeout> | null = null;
let _running = false;

// ---------------------------------------------------------------------------
// Core-Logik
// ---------------------------------------------------------------------------

async function doRefresh(): Promise<void> {
  try {
    const resp = await getProfileStatement();
    if (!_running) return; // Logout während des Netzwerk-Calls — Store-Write abbrechen
    const claims = parseStatementClaims(resp.token);
    if (!claims) return; // ungültiges JWT — ignorieren, next Tick versucht es nochmal
    const statement: ProfileStatement = { raw: resp.token, claims };
    await profileStatementStore.setStatement(statement);
  } catch {
    // Best-effort — nächster scheduled Tick versucht es erneut
  }
}

/** Sofortiger Force-Refresh, zum Beispiel direkt nach einem Username- oder
 *  Profile-Update. Bricht etwaige scheduled Timer NICHT ab — der nächste
 *  Tick läuft regulär weiter (oder wird via startProfileRefresh erneuert). */
export async function forceProfileRefresh(): Promise<void> {
  await doRefresh();
}

function scheduleNext(statement: ProfileStatement | null): void {
  if (!_running) return;
  if (_timerId !== null) {
    clearTimeout(_timerId);
    _timerId = null;
  }

  let delayMs: number;

  if (!statement) {
    // Kein Statement — kurz warten, dann nochmal versuchen
    delayMs = MIN_REFRESH_INTERVAL_MS;
  } else {
    const nowSec = Math.floor(Date.now() / 1000);
    const expiryInSec = statement.claims.exp - nowSec;
    // Refresh-Zeitpunkt: exp - 4h. Falls das in der Vergangenheit liegt, sofort.
    const waitSec = expiryInSec - REFRESH_THRESHOLD_SECS;
    delayMs = Math.max(waitSec * 1000, MIN_REFRESH_INTERVAL_MS);
    delayMs = Math.min(delayMs, MAX_REFRESH_INTERVAL_MS);
  }

  _timerId = setTimeout(async () => {
    await doRefresh();
    scheduleNext(profileStatementStore.statement);
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Startet den Refresh-Timer. Sicher mehrfach aufrufbar — laufender Timer
 * wird zuerst gestoppt.
 *
 * Beim ersten Boot: prüft ob das Statement bald abläuft und refreshed sofort.
 */
export async function startProfileRefresh(): Promise<void> {
  stopProfileRefresh();
  _running = true;

  const current = profileStatementStore.statement;

  // Sofortiger Refresh wenn Statement fehlt oder bald abläuft
  if (!current || isStatementExpiringSoon(current, REFRESH_THRESHOLD_SECS)) {
    await doRefresh();
  }

  scheduleNext(profileStatementStore.statement);
}

/**
 * Stoppt den Refresh-Timer. Beim Logout aufrufen.
 */
export function stopProfileRefresh(): void {
  _running = false;
  if (_timerId !== null) {
    clearTimeout(_timerId);
    _timerId = null;
  }
}

/**
 * Gibt true zurück wenn der Timer läuft.
 */
export function isProfileRefreshRunning(): boolean {
  return _running;
}
