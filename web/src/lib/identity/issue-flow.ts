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

/**
 * Baut einen lesbaren Geräte-Label aus dem User-Agent.
 * Kürzt auf 64 Zeichen (Backend-Limit).
 *
 * Beispiel: "Chrome 130 · Linux" oder "Electron / Linux"
 */
function buildDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown Device';
  const ua = navigator.userAgent;

  // Electron-Erkennung
  if (ua.includes('Electron')) {
    const electronMatch = ua.match(/Electron\/(\d+)/);
    const ver = electronMatch ? ` ${electronMatch[1]}` : '';
    const os = ua.includes('Linux') ? 'Linux' : ua.includes('Win') ? 'Windows' : 'macOS';
    return `Pulse Desktop${ver} · ${os}`.slice(0, 64);
  }

  // Browser-Erkennung (vereinfacht — nur zur Lesbarkeit)
  let browser = 'Browser';
  let version = '';
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const firefoxMatch = ua.match(/Firefox\/(\d+)/);
  const safariMatch = ua.match(/Version\/(\d+).*Safari/);
  if (firefoxMatch) {
    browser = 'Firefox';
    version = firefoxMatch[1];
  } else if (chromeMatch) {
    browser = 'Chrome';
    version = chromeMatch[1];
  } else if (safariMatch) {
    browser = 'Safari';
    version = safariMatch[1];
  }

  const os = ua.includes('Linux')
    ? 'Linux'
    : ua.includes('Windows')
      ? 'Windows'
      : ua.includes('Mac')
        ? 'macOS'
        : ua.includes('Android')
          ? 'Android'
          : ua.includes('iPhone') || ua.includes('iPad')
            ? 'iOS'
            : 'Unknown OS';

  return `${browser}${version ? ' ' + version : ''} · ${os}`.slice(0, 64);
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
