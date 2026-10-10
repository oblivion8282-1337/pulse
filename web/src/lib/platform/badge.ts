import { Badge } from '@capawesome/capacitor-badge';
import { badgeAnwenden } from './badgeAnwenden';
import { isCapacitorIOS } from './runtime';

/** Zuletzt gewünschte Zahl — für `badgeNachziehen`. */
let gewuenscht: number | null = null;

/**
 * Ungelesene Nachrichten als Zahl auf dem App-Icon (iOS-Hülle).
 *
 * Quelle ist derselbe Stand wie der ●-Titelpunkt — dieselbe Rechnung, zwei
 * Oberflächen (Desktop-Browser: Titel; Handy-Hülle: Icon-Badge).
 *
 * **Fragt nie nach der Erlaubnis.** Ohne erteilte Mitteilungs-Erlaubnis tut
 * der Aufruf nichts — das Plugin würde sonst den einmaligen System-Dialog
 * öffnen, beim ersten Start und ohne Vorerklärung (Begründung in
 * `badgeAnwenden.ts`).
 *
 * **Diese Funktion allein hält das Icon NICHT aktuell.** Im Hintergrund ist
 * die JS-Engine eingefroren, der `$effect` läuft also nicht — ein Push, der
 * bei geschlossener App ankommt, bewegt die Zahl hier nicht. Dafür trägt der
 * Server die Zahl im Push selbst (`aps.badge`, s. `fcm.py::_build_dm_message`
 * und `badgezaehler.py`); dieser Aufruf ist die Korrektur, sobald die App
 * wieder wach ist. Der Weg, auf dem der Klient dem Server seinen exakten Stand
 * meldet, liegt daneben in `badgeMelden.ts`.
 *
 * Browser und Electron: No-op (der Titel-Punkt bleibt dort die Oberfläche).
 */
export async function badgeSetzen(anzahlNachrichten: number): Promise<void> {
  if (!isCapacitorIOS()) return;
  gewuenscht = anzahlNachrichten;
  try {
    await badgeAnwenden(Badge, anzahlNachrichten);
  } catch {
    // Kein Plugin in dieser Hülle, oder es meldet einen Fehler — still.
  }
}

/** Die zuletzt gewünschte Zahl erneut anlegen. Gerufen, sobald die
 *  Mitteilungs-Erlaubnis gerade erteilt wurde (`fcm.ts`): bis dahin hat
 *  `badgeSetzen` nichts getan, und der `$effect` darüber läuft erst bei der
 *  nächsten Änderung des Standes wieder. */
export function badgeNachziehen(): void {
  if (gewuenscht !== null) void badgeSetzen(gewuenscht);
}
