import { Badge } from '@capawesome/capacitor-badge';
import { isCapacitorIOS } from './runtime';

/**
 * Ungelesene Nachrichten als Zahl auf dem App-Icon (iOS-Hülle).
 *
 * Quelle ist derselbe Stand wie der ●-Titelpunkt — dieselbe Rechnung, zwei
 * Oberflächen (Desktop-Browser: Titel; Handy-Hülle: Icon-Badge). iOS 16+
 * setzt die Zahl über UNUserNotificationCenter auch dann, wenn die App im
 * Hintergrund ist; beim Öffnen zählt die App intern neu und die Zahl
 * korrigiert sich selbst.
 *
 * Browser und Electron: No-op (der Titel-Punkt bleibt dort die Oberfläche).
 */
export async function badgeSetzen(anzahlGespraeche: number): Promise<void> {
  if (!isCapacitorIOS()) return;
  try {
    // iOS-Konvention: Anzahl der UNGELESENEN GESPRÄCHE, nicht der Nachrichten
    // (wie Mail/Discord). 0 räumt das Badge ab.
    if (anzahlGespraeche > 0) {
      await Badge.set({ count: anzahlGespraeche }).catch(() => undefined);
    } else {
      await Badge.clear().catch(() => undefined);
    }
  } catch {
    /* Plugin fehlt (Web/Electron) — still */
  }
}
