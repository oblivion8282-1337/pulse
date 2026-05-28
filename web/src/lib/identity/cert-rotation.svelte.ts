/**
 * Background-Task für automatische Cert-Rotation (DE 11 Block 1.H / A.1).
 *
 * Strategie:
 *  - Beim Boot + täglich: prüfe Cert-Expiry
 *  - Wenn < 30 Tage verbleiben: trigger POST /credentials/issue mit aktuellem Pubkey
 *    (idempotent — bekommt aktualisiertes Cert mit neuem `exp` wenn Backend so
 *     konfiguriert; bei 365-Tage-Certs ist das der Renewal-Pfad)
 *  - Intervall: 24h (täglicher Check)
 *  - Beim Logout: stopCertRotation() aufrufen
 */

import { certStore, isCertExpiringSoon, parseCertClaims } from './cert.svelte';
import type { IdentityCert } from './cert.svelte';
import { loadKeypair, exportPublicKey } from './keypair.svelte';
import { issueCert } from '$lib/api/credentials';

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/** Rotation-Schwelle: 30 Tage vor Ablauf. */
const ROTATION_THRESHOLD_SECS = 30 * 24 * 3600;
/** Täglicher Check-Intervall. */
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
/** Minimales Intervall bei Fehler (1h). */
const ERROR_RETRY_MS = 3600 * 1000;

// ---------------------------------------------------------------------------
// Interner State
// ---------------------------------------------------------------------------

let _timerId: ReturnType<typeof setTimeout> | null = null;
let _running = false;

// ---------------------------------------------------------------------------
// Core-Logik
// ---------------------------------------------------------------------------

async function doRotation(): Promise<void> {
  const cert = certStore.cert;
  if (!cert) return;

  if (!isCertExpiringSoon(cert, ROTATION_THRESHOLD_SECS)) return;

  const keypair = await loadKeypair();
  if (!keypair) return;

  try {
    const pubkeyB64 = await exportPublicKey(keypair);
    // Device-Label aus bestehendem Cert übernehmen
    const label = cert.claims.device_label ?? 'Renewed Device';
    const resp = await issueCert(pubkeyB64, label);
    const claims = parseCertClaims(resp.cert);
    if (!claims) return;
    const renewed: IdentityCert = { raw: resp.cert, claims };
    await certStore.setCert(renewed);
  } catch {
    // Best-effort — nächster täglicher Check versucht es nochmal
  }
}

function scheduleNext(delayMs: number): void {
  if (!_running) return;
  if (_timerId !== null) {
    clearTimeout(_timerId);
    _timerId = null;
  }

  _timerId = setTimeout(async () => {
    try {
      await doRotation();
      scheduleNext(CHECK_INTERVAL_MS);
    } catch {
      scheduleNext(ERROR_RETRY_MS);
    }
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Startet den Cert-Rotation-Task. Sicher mehrfach aufrufbar.
 *
 * Beim Boot: prüft sofort ob Rotation nötig, dann täglich.
 */
export async function startCertRotation(): Promise<void> {
  stopCertRotation();
  _running = true;

  // Sofortiger Check beim Boot
  try {
    await doRotation();
  } catch {
    // Ignorieren — täglicher Retry
  }

  scheduleNext(CHECK_INTERVAL_MS);
}

/**
 * Stoppt den Cert-Rotation-Task. Beim Logout aufrufen.
 */
export function stopCertRotation(): void {
  _running = false;
  if (_timerId !== null) {
    clearTimeout(_timerId);
    _timerId = null;
  }
}

/**
 * Gibt true zurück wenn der Task läuft.
 */
export function isCertRotationRunning(): boolean {
  return _running;
}
