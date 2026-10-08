/**
 * Wann zeigt die App „keine Verbindung"? — die reine Regel.
 *
 * **Warum es den Hinweis braucht.** Bis hierher gab es genau eine
 * Verbindungsanzeige: einen farbigen Punkt in der `GuildRail`. Die ist
 * Desktop-only — auf Handy und Tablet sagte nichts, dass die Liste stillsteht,
 * weil die Verbindung weg ist. Weiss blieb weiss.
 *
 * **Vier Regeln, und drei davon sind Zurückhaltung:**
 *
 *  1. Zustände mit eigenem Handlungsbedarf bekommen KEINEN generischen
 *     Hinweis. „Server zu alt", „gesperrt", „E-Mail nicht bestätigt",
 *     „Zweitfaktor fehlt" haben eigene Anzeigen mit einem Handgriff darin —
 *     ein „keine Verbindung" darüber wäre nicht nur überflüssig, es wäre die
 *     falsche Diagnose und schickt den Nutzer zum Router statt zur Ursache.
 *  2. Ein kurzer Abriss zeigt nichts. Ein Reconnect ist oft nach einer
 *     Sekunde durch; ein Banner, das dabei aufblitzt, erzieht dazu, Banner zu
 *     übersehen. Deshalb `GEDULD_MS`.
 *  3. Sagt das Gerät SELBST, dass es offline ist, gilt die Geduld nicht — das
 *     ist keine Vermutung mehr. Umgekehrt ist `navigator.onLine === true` kein
 *     Beweis für das Gegenteil (ein Hotelnetz mit Anmeldeseite ist „online"),
 *     deshalb entscheidet es nur in diese eine Richtung.
 *  4. „Verbindet gerade" und „keine Verbindung" sind zwei Aussagen. Die erste
 *     verlangt Warten, die zweite Nachsehen.
 *
 * **`seitMs` zählt den ABRISS, nicht den letzten Zustandswechsel** — und das
 * ist der Grund, warum diese Regel kein Gedächtnis braucht. Mit der Uhr am
 * Zustandswechsel flackerte der Streifen beim Wiederverbinden: rot stand da,
 * der Zustand sprang auf `connecting`, die Frist lief von neuem, also rot →
 * nichts → vier Sekunden später gelb. Gemessen wird deshalb die zusammen-
 * hängende Strecke, auf der die Verbindung NICHT offen ist (gesetzt in
 * `server-state.svelte.ts`); innerhalb dieser Strecke darf der Zustand
 * wechseln, ohne die Geduld zurückzusetzen. Die Geduld soll ein Aufblitzen
 * verhindern, nicht ein Verschwinden erzeugen.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

/** Wie lange ein Abriss anliegen muss, bevor etwas erscheint. */
export const GEDULD_MS = 4000;

/** Zustände, die ihre eigene Anzeige samt Handgriff haben (Regel 1).
 *  Gegenstück: `ConnectionState` in `gateway-connection.ts`. */
export const EIGENE_ANZEIGE: readonly string[] = [
  'incompatible',
  'updating',
  'starting',
  'mfa-required',
  'suspended',
  'email-unverified'
];

export type Hinweis = 'keiner' | 'verbindet' | 'offline';

export interface Hinweislage {
  /** Will der Klient überhaupt verbunden sein? Abgemeldet nicht. */
  gewuenscht: boolean;
  /** Aktueller `ConnectionState` der maßgeblichen Verbindung. */
  zustand: string;
  /** `navigator.onLine`. */
  netzOnline: boolean;
  /** Wie lange der aktuelle Zustand schon anliegt. */
  seitMs: number;
}

export function offlineHinweis(lage: Hinweislage): Hinweis {
  if (!lage.gewuenscht) return 'keiner';
  if (lage.zustand === 'open') return 'keiner';
  if (EIGENE_ANZEIGE.includes(lage.zustand)) return 'keiner';
  if (!lage.netzOnline) return 'offline';
  if (lage.seitMs < GEDULD_MS) return 'keiner';
  return lage.zustand === 'connecting' ? 'verbindet' : 'offline';
}
