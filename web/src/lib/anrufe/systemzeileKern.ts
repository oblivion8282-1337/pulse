/**
 * Ob ein beendetes 1:1-Telefonat eine Systemzeile im Chat hinterlässt — und
 * welche. Importfrei (Repo-Muster, s. `krypto/dmSendeSperre.ts`), damit der
 * Node-Testläufer sie prüfen kann.
 *
 * Zwei Regeln, die zusammen genau EINE Zeile je Anruf ergeben:
 *
 * * **Nur der Einleiter schreibt.** Beide Seiten erleben das Ende (der
 *   Auflegende lokal, die Gegenseite per `call_ende`) — schrieben beide,
 *   stünde die Zeile doppelt im gemeinsamen Verlauf. Der Einleiter ist die
 *   stabilere Wahl: beim E2EE-Weg trägt sein Client die verschlüsselte
 *   Nutzlast ohnehin über den Postfach-Pfad, die Zeile ist schlicht seine
 *   Nachricht.
 * * **Nur bei Ergebnis.** „Aufgelegt" ohne Dauer ist abgebrochenes Klingeln,
 *   ohne dass etwas zu dokumentieren wäre; jeder echte End-Grund des Servers
 *   (`verpasst`, `abgelehnt`) und jede echte Dauer zählt. Der Server rechnet
 *   die Dauer selbst (`routes/anrufe.py`, ab `verbunden_at`) — der lokale
 *   Ticker des Stores zählt dasselbe Intervall.
 */

export type AnrufZeilenSchluessel = 'verpasst' | 'abgelehnt' | 'dauer';

export interface AnrufSystemzeile {
  schluessel: AnrufZeilenSchluessel;
  dauerSek: number;
}

export function anrufSystemzeile(
  art: string,
  rolle: string,
  grund: string,
  dauerSek: number
): AnrufSystemzeile | null {
  if (art !== 'dm' || rolle !== 'ausgehend') return null;
  if (grund === 'verpasst') return { schluessel: 'verpasst', dauerSek: 0 };
  if (grund === 'abgelehnt') return { schluessel: 'abgelehnt', dauerSek: 0 };
  if (grund === 'aufgelegt' && dauerSek > 0) return { schluessel: 'dauer', dauerSek };
  return null;
}
