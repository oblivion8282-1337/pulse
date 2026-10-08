import { Badge } from '@capawesome/capacitor-badge';
import { isCapacitorIOS } from './runtime';

/**
 * Ungelesene Nachrichten als Zahl auf dem App-Icon (iOS-Hülle).
 *
 * Quelle ist derselbe Stand wie der ●-Titelpunkt — dieselbe Rechnung, zwei
 * Oberflächen (Desktop-Browser: Titel; Handy-Hülle: Icon-Badge).
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
  try {
    // 0 räumt das Badge ab — `set({count: 0})` lässt auf manchen iOS-Fassungen
    // eine leere Plakette stehen, `clear()` ist der dokumentierte Weg.
    if (anzahlNachrichten > 0) {
      await Badge.set({ count: anzahlNachrichten });
    } else {
      await Badge.clear();
    }
  } catch {
    // Keine Mitteilungserlaubnis / kein Plugin — still. Die Erlaubnis kann
    // nachträglich erteilt werden, der Resume-Refresh im App-Shell wiederholt
    // den Versuch dann von selbst.
  }
}
