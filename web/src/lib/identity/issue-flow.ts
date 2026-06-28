/**
 * Issue-Flow-Orchestrator (DE 11 Block 1.H).
 *
 * Wird nach erfolgreichem Login aufgerufen. Entscheidet ob ein neues
 * Ed25519-Keypair generiert werden muss, issued ein Cert, und holt
 * das initiale Profile-Statement.
 *
 * Aufruf-Reihenfolge:
 *   1. Login (Cookie wird vom Server gesetzt)
 *   2. runIssueFlow() ← dieser Modul
 *   3. Profile-Refresh-Timer + Cert-Rotation-Timer starten
 *
 * Cookie-Abhängigkeit: `pulse_session` muss bereits gesetzt sein —
 * `/credentials/issue` und `/credentials/profile-statement` nutzen
 * ausschließlich Cookie-Auth.
 */

import {
  loadKeypair,
  generateKeypair,
  saveKeypair,
  exportPublicKey,
} from './keypair.svelte';
import { certStore, parseCertClaims } from './cert.svelte';
import type { IdentityCert } from './cert.svelte';
import { profileStatementStore, parseStatementClaims } from './profile-statement.svelte';
import type { ProfileStatement } from './profile-statement.svelte';
import { issueCert, getProfileStatement } from '$lib/api/credentials';

// ---------------------------------------------------------------------------
// Gerätebeschriftung
// ---------------------------------------------------------------------------

/** Electron-OS-Fallback, wenn kein Hostname verfügbar ist (eigene Variante:
 *  `Win`-Match, kein Android/iOS, macOS als Default). */
function electronOsFallback(ua: string): string {
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Win')) return 'Windows';
  return 'macOS';
}

/** Browser-Name aus dem User-Agent (ohne Version — siehe buildDeviceLabel). */
function detectBrowser(ua: string): string {
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Version\/\d+.*Safari/.test(ua)) return 'Safari';
  return 'Browser';
}

/** Betriebssystem aus dem Browser-User-Agent. */
function detectOs(ua: string): string {
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return 'Unknown OS';
}

/**
 * Baut das menschenlesbare Geräte-Label fürs Cert (max. 64 Zeichen).
 *
 * BEWUSST OHNE Browser-/Electron-Versionsnummer: die ändert sich bei jedem
 * Auto-Update (Chrome 147→148→149…) und ließ denselben Browser immer wieder als
 * „neues Gerät" erscheinen. Stabil über Updates → das Backend erkennt ein
 * erneutes Login desselben Geräts am gleichen Label und ersetzt den alten Pass,
 * statt zu stapeln.
 *
 * Desktop: nutzt den ECHTEN Rechnernamen (Hostname, nur via Electron-Bridge
 * verfügbar) → zwei Desktops sind sauber getrennt. Browser können den Hostnamen
 * aus Privacy-Gründen nicht lesen → dort bleibt es bei „Browser · OS".
 */
function buildDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown Device';
  const ua = navigator.userAgent;

  // Electron: echter Rechnername, sonst OS als Fallback.
  if (ua.includes('Electron')) {
    const host = typeof window !== 'undefined' ? window.pulse?.deviceName?.trim() : '';
    return `Pulse Desktop · ${host || electronOsFallback(ua)}`.slice(0, 64);
  }

  return `${detectBrowser(ua)} · ${detectOs(ua)}`.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Haupt-Flow
// ---------------------------------------------------------------------------

export interface IssueFlowResult {
  cert: IdentityCert;
  statement: ProfileStatement;
  /** true = neues Keypair generiert; false = existierendes genutzt */
  keypairCreated: boolean;
}

/**
 * Orchestriert den Cert-Issue-Flow nach dem Login.
 *
 * Algorithmus:
 *  1. Lokales Keypair laden
 *  2. Falls kein Keypair: generieren + speichern
 *  3. Cert ausstellen (idempotent — gleicher Pubkey liefert bestehendes Cert)
 *  4. Profile-Statement holen
 *  5. Cert + Statement in Stores speichern
 *
 * Wirft bei Netzwerk- oder Cookie-Auth-Fehlern (caller zeigt Toast).
 */
export async function runIssueFlow(): Promise<IssueFlowResult> {
  const label = buildDeviceLabel();

  // --- 1+2: Keypair laden oder generieren ---
  let keypair = await loadKeypair();
  let keypairCreated = false;

  if (!keypair) {
    // Frischer Browser ohne IDB-Keypair: neues generieren + speichern.
    keypair = await generateKeypair();
    await saveKeypair(keypair);
    keypairCreated = true;
  }

  const pubkeyB64 = await exportPublicKey(keypair);

  // --- 3: Cert auflösen (idempotent) ---
  const issueResp = await issueCert(pubkeyB64, label);
  const certJwt = issueResp.cert;

  // --- Cert parsen + in Store speichern ---
  const claims = parseCertClaims(certJwt);
  if (!claims) {
    throw new Error('SERVER_RETURNED_INVALID_CERT_JWT');
  }
  const cert: IdentityCert = { raw: certJwt, claims };
  await certStore.setCert(cert);

  // --- 4: Profile-Statement holen ---
  const stmtResp = await getProfileStatement();
  const stmtClaims = parseStatementClaims(stmtResp.token);
  if (!stmtClaims) {
    throw new Error('SERVER_RETURNED_INVALID_STATEMENT_JWT');
  }
  const statement: ProfileStatement = { raw: stmtResp.token, claims: stmtClaims };
  await profileStatementStore.setStatement(statement);

  return { cert, statement, keypairCreated };
}
