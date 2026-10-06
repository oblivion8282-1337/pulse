import { Badge } from '@capawesome/capacitor-badge';
import { isCapacitorIOS } from './runtime';

/**
 * Ungelesene Nachrichten als Zahl auf dem App-Icon (iOS-Hülle).
 *
 * Quelle ist derselbe Stand wie der ●-Titelpunkt — dieselbe Rechnung, zwei
 * Oberflächen (Desktop-Browser: Titel; Handy-Hülle: Icon-Badge). Die Zahl
 * korrigiert sich beim Öffnen der App selbst — im Hintergrund ist die
 * JS-Engine eingefroren, der Resume-Refresh im App-Shell übernimmt.
 *
 * Browser und Electron: No-op (der Titel-Punkt bleibt dort die Oberfläche).
 */
export async function badgeSetzen(anzahlGespraeche: number): Promise<void> {
  if (!isCapacitorIOS()) return;
  try {
    // iOS-Konvention: Anzahl der UNGELESENEN GESPRÄCHE, nicht der Nachrichten
    // (wie Mail/Discord). 0 räumt das Badge ab.
    if (anzahlGespraeche > 0) {
      await Badge.set({ count: anzahlGespraeche });
    } else {
      await Badge.clear();
    }
  } catch {
    /* Plugin fehlt (Web/Electron) oder Berechtigung fehlt — still */
  }
}
