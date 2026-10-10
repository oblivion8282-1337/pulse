// Gemerkte Einladung — der Rückweg nach Anmeldung, Registrierung und
// E-Mail-Bestätigung. Importfrei bis auf den Nachbarn (Node-Unit-Tests).
//
// Warum nicht über die Adresse (`/login?redirect=…`): die Registrierung führt
// nach /app, das App-Layout von dort zur Sperrseite „E-Mail bestätigen“, und
// der Bestätigungslink wieder nach /app. Auf jedem dieser Wege ginge der
// Zusammenhang verloren. Der Eintrag im Browser übersteht alle drei, und das
// App-Layout greift ihn auf, sobald der Nutzer angemeldet und bestätigt ist.
import { istGueltigerCode, istGueltigerHandle, istGueltigerHost, type Ziel } from './einladungsLink.ts';

export const SPEICHER_SCHLUESSEL = 'pulse.einladung.gemerkt';
export const HALTBARKEIT_MS = 24 * 60 * 60 * 1000;

/** Fenster-Ereignis „eine Einladung wurde gerade gemerkt“ — der Dialog liest
 *  den Speicher sonst nur, wenn sich die Anmeldung ändert. */
export const EREIGNIS_GEMERKT = 'pulse:einladung-gemerkt';

export type Speicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, oder null, wenn schon der Zugriff wirft (Privatmodus,
 *  gesperrte Website-Daten). Ohne Speicher fällt nur der Rückweg weg. */
export function browserSpeicher(): Speicher | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function einladungMerken(s: Speicher | null, z: Ziel, jetzt: number): void {
  if (!s) return;
  try {
    s.setItem(SPEICHER_SCHLUESSEL, JSON.stringify({ ...z, gemerktAm: jetzt }));
  } catch {
    /* voll oder gesperrt — dann eben ohne Rückweg */
  }
}

export function gemerkteEinladungVerwerfen(s: Speicher | null): void {
  if (!s) return;
  try {
    s.removeItem(SPEICHER_SCHLUESSEL);
  } catch {
    /* gesperrt — es gibt nichts zu tun */
  }
}

/** Die gemerkte Einladung, geprüft wie ein frischer Link. Alles Ungültige
 *  (kaputt, fremd, abgelaufen, aus der Zukunft) wird dabei gelöscht. */
export function gemerkteEinladung(s: Speicher | null, jetzt: number): Ziel | null {
  if (!s) return null;
  let roh: string | null;
  try {
    roh = s.getItem(SPEICHER_SCHLUESSEL);
  } catch {
    return null;
  }
  if (roh === null) return null;
  const e = lesen(roh, jetzt);
  if (!e) gemerkteEinladungVerwerfen(s);
  return e;
}

function lesen(roh: string, jetzt: number): Ziel | null {
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const { code, handle, host, gemerktAm } = d as Record<string, unknown>;
  if (host !== null && (typeof host !== 'string' || !istGueltigerHost(host))) return null;
  if (typeof gemerktAm !== 'number') return null;
  const alter = jetzt - gemerktAm;
  if (!(alter >= 0 && alter < HALTBARKEIT_MS)) return null;
  // Einträge aus Etappe 1 tragen nur `code` — sie bleiben Einladungen.
  if (typeof handle === 'string') return istGueltigerHandle(handle) ? { handle, host } : null;
  if (typeof code === 'string' && istGueltigerCode(code)) return { code, host };
  return null;
}
