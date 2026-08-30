/**
 * Issue-Flow-Orchestrator (DE 11 Block 1.H).
 *
 * Wird nach erfolgreichem Login aufgerufen. Entscheidet ob ein neues
 * Ed25519-Keypair generiert werden muss, holt das initiale
 * Profile-Statement und veroeffentlicht die Schluesselbuendel.
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
import { profileStatementStore, parseStatementClaims } from './profile-statement.svelte';
import type { ProfileStatement } from './profile-statement.svelte';
import { getProfileStatement } from '$lib/api/credentials';
import { veroeffentlicheSchluessel } from '$lib/krypto/veroeffentlichen';

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
  statement: ProfileStatement | null;
  /** true = neues Keypair generiert; false = existierendes genutzt */
  keypairCreated: boolean;
}

/**
 * Orchestriert die Geraete-Anmeldung nach dem Login (Weg A — ohne Zertifikat).
 *
 * Algorithmus:
 *  1. Lokales Keypair laden
 *  2. Falls kein Keypair: generieren + speichern
 *  3. Profile-Statement holen
 *  4. Statement speichern, Schluesselbuendel veroeffentlichen
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

  // --- 3: Profile-Statement holen (best-effort) — die REST-Route ist auf dem
  // Weg-A-Stand nicht mehr gebaut, der WS-Weg (`profile_statement`) liefert
  // das Statement ohnehin nach. ---
  let statement: ProfileStatement | null = null;
  try {
    const stmtResp = await getProfileStatement();
    const stmtClaims = parseStatementClaims(stmtResp.token);
    if (stmtClaims) {
      statement = { raw: stmtResp.token, claims: stmtClaims };
      await profileStatementStore.setStatement(statement);
    }
  } catch {
    // Kein Abbruch: Statement ist Zusatz, die Schluessel-Veröffentlichung ist
    // der Kern dieses Flusses.
  }

  // --- 4: E2E-DM-Schluessel veroeffentlichen ---
  // Best-effort und bewusst NACH dem Statement-Store-Write: die
  // Geraetekennung kommt aus dem lokalen Geraete-Pubkey
  // (`krypto/geraeteKennung.ts`). Ein Fehlschlag hier darf
  // Login/Registrierung nicht abbrechen — der naechste Login versucht es
  // erneut.
  try {
    await veroeffentlicheSchluessel();
  } catch (fehler) {
    // Nicht rethrowen — Login/Profil haengt nicht daran. Aber SICHTBAR
    // warnen: ein stummer Fehlschlag waere ein unsichtbares Fehlen der
    // Geraete-Buendel (Befund aus dem Hetzner-Zwei-Geraete-Lauf).
    console.warn('[krypto] Schluessel-Veroeffentlichung fehlgeschlagen:', fehler instanceof Error ? fehler.message : fehler);
  }

  return { statement, keypairCreated };
}

// ---------------------------------------------------------------------------
// Single-Flight: setUser- und Hydrate-Hook feuern beide beim Login. Ohne
// Kapselung rennen zwei Laeufe parallel und erzeugen zwei Keypairs — zwei
// Bündel fuer denselben Account, das Empfaenger-Faechern waere damit kaputt.
// Der zweite Aufrufer wartet auf denselben Lauf.
// ---------------------------------------------------------------------------

let lauf: Promise<void> | null = null;
let fertig = false;

/** Startet den Flow genau einmal pro Seitenleben; weitere Aufrufe warten auf
 *  denselben Lauf. Fehler gehen an alle Aufrufer, der naechste Login versucht
 *  es erneut (Lauf und fertig werden zurueckgesetzt). */
export function starteGeraeteAnmeldung(): Promise<void> {
  if (fertig && lauf) return lauf;
  if (lauf) return lauf;
  lauf = (async () => {
    await runIssueFlow();
    fertig = true;
  })().catch((fehler) => {
    lauf = null;
    fertig = false;
    console.warn('[krypto] Geraete-Anmeldung fehlgeschlagen:', fehler instanceof Error ? fehler.message : fehler);
    throw fehler;
  });
  return lauf;
}
