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
  keypairStore,
  type WebCryptoKeypair,
} from './keypair.svelte';
import { certStore, parseCertClaims } from './cert.svelte';
import type { IdentityCert } from './cert.svelte';
import { profileStatementStore, parseStatementClaims } from './profile-statement.svelte';
import type { ProfileStatement } from './profile-statement.svelte';
import { issueCert, listCerts, getProfileStatement, getBackup } from '$lib/api/credentials';
import { onboardingState } from '$lib/stores/onboardingState.svelte';

/**
 * Signalisiert dass kein lokaler Keypair existiert, aber mindestens ein
 * Cloud-Backup für diesen User auf dem Server liegt. Caller (login/register-
 * Page) sollen den User in den Recover-Flow lenken statt blind ein neues
 * Cert auszustellen.
 */
export class RecoveryAvailableError extends Error {
  certId: string;
  deviceLabel: string;
  constructor(certId: string, deviceLabel: string) {
    super('RECOVERY_AVAILABLE');
    this.name = 'RecoveryAvailableError';
    this.certId = certId;
    this.deviceLabel = deviceLabel;
  }
}

const DECLINE_LS_KEY = 'pulse.recovery_declined';

/** User hat im Recover-Dialog "Neues Gerät" gewählt — runIssueFlow soll
 *  beim nächsten Aufruf nicht erneut auf den Recover-Flow umleiten. */
export function declineRecovery(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(DECLINE_LS_KEY, '1'); } catch { /* ignore */ }
}

/** Reset des Decline-Flags (z.B. nach erfolgreichem Recover oder Sign-Out). */
export function resetRecoveryDecline(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(DECLINE_LS_KEY); } catch { /* ignore */ }
}

function isRecoveryDeclined(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try { return localStorage.getItem(DECLINE_LS_KEY) === '1'; } catch { return false; }
}

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
 *  2. Falls kein Keypair: generieren + speichern → Issue-Request
 *  3. Falls Keypair vorhanden: Server-Liste checken
 *     a. Passende cert_id gefunden → existierendes Cert nehmen
 *     b. Nicht gefunden (Cache geleert, Pub-Key noch da) → neues Issue
 *  4. Profile-Statement holen
 *  5. Cert + Statement in Stores speichern
 *
 * Wirft bei Netzwerk- oder Cookie-Auth-Fehlern (caller zeigt Toast).
 */
/**
 * Stellt sicher, dass ein **backup-fähiges (exportierbares)** Ed25519-Keypair
 * vorliegt — Voraussetzung fürs Cloud-Backup (das den privaten Schlüssel
 * exportieren + verschlüsseln muss).
 *
 * Hintergrund: Keypairs werden bewusst `extractable:false` erzeugt (XSS-Schutz),
 * und der Issue-Flow generiert sie non-extractable. Will der User Backup
 * aktivieren, braucht es einmalig ein exportierbares Keypair. Dieser Helfer
 * erzeugt es (`forBackup:true`) UND stellt das Geräte-Cert mit dem neuen Pubkey
 * neu aus (das alte läuft regulär aus). Ist das aktuelle Keypair bereits
 * exportierbar, ist das ein No-op (gibt es unverändert zurück).
 *
 * Wirft bei Issue-/Cookie-Auth-Fehlern (Caller zeigt Fehlermeldung).
 */
export async function ensureBackupCapableKeypair(): Promise<WebCryptoKeypair> {
  const existing = await loadKeypair();
  if (existing && existing.privateKey.extractable) return existing;

  const label = buildDeviceLabel();
  const kp = await generateKeypair({ forBackup: true });
  await saveKeypair(kp);
  await keypairStore.load(); // reaktiven Store aktualisieren

  const pubkeyB64 = await exportPublicKey(kp);
  const issueResp = await issueCert(pubkeyB64, label);
  const claims = parseCertClaims(issueResp.cert);
  if (!claims) throw new Error('SERVER_RETURNED_INVALID_CERT_JWT');
  await certStore.setCert({ raw: issueResp.cert, claims });
  return kp;
}

export async function runIssueFlow(): Promise<IssueFlowResult> {
  const label = buildDeviceLabel();

  // --- 1+2: Keypair laden oder generieren ---
  let keypair = await loadKeypair();
  let keypairCreated = false;

  if (!keypair) {
    // Bevor wir blind einen neuen Pubkey generieren + ausstellen: Check ob
    // der User auf einem anderen Gerät ein Cloud-Backup hinterlegt hat.
    // Sonst hat ein Login auf einem neuen Browser zur Folge, dass die
    // Backup-Identity nie wiederhergestellt wird und der User unbemerkt mit
    // einem Zweit-Device-Cert weiterläuft — die Backup-Funktion wäre
    // effektiv unnutzbar.
    if (!isRecoveryDeclined()) {
      try {
        const list = await listCerts();
        const restorable = list.devices.find((d) => d.has_backup);
        if (restorable) {
          throw new RecoveryAvailableError(restorable.cert_id, restorable.device_label);
        }
      } catch (err) {
        if (err instanceof RecoveryAvailableError) throw err;
        // Netzwerk-/Auth-Fehler im list-Call: still degradiert in den
        // Generate-Pfad (User würde sonst auf der Login-Page kleben).
      }
    }
    keypair = await generateKeypair();
    await saveKeypair(keypair);
    keypairCreated = true;
  }

  const pubkeyB64 = await exportPublicKey(keypair);

  // --- 3: Cert auflösen ---
  let certJwt: string;

  // Idempotenter Issue-Call — gibt bestehendes Cert zurück wenn Pubkey matcht
  const issueResp = await issueCert(pubkeyB64, label);
  certJwt = issueResp.cert;

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

  // --- 5: Backup-Onboarding prüfen (best-effort, kein Fehler bei Netzwerkproblem) ---
  // init() synct den Backend-State (max. 3 s Timeout, LS-Fallback bei Fehler)
  // und befüllt hasDecided() korrekt bevor wir den Check machen.
  await onboardingState.init();

  if (!onboardingState.hasDecided()) {
    try {
      const existing = await getBackup(claims.cert_id);
      if (existing !== null) {
        // Backup schon vorhanden — als "configured" markieren, kein Dialog nötig.
        await onboardingState.markDecided('configured');
      } else {
        onboardingState.triggerIfNeeded();
      }
    } catch {
      // Netzwerkfehler → Dialog überspringen, User kann es in Settings nachholen.
    }
  }

  return { cert, statement, keypairCreated };
}
