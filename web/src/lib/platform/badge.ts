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
let _debugGezeigt = false;

let _debugDiv: HTMLDivElement | null = null;

// TEMP-DEBUG (Gerätetest 2026-10-06): sichtbare Zeile in der App — zeigt
// Gate, Zähler und Plugin-Ergebnis. NACH DEM TEST ENTFERNEN.
function debugAnzeigen(text: string): void {
  if (typeof document === 'undefined') return;
  if (!_debugDiv || !_debugDiv.isConnected) {
    _debugDiv = document.createElement('div');
    _debugDiv.style.cssText =
      'position:fixed;top:60px;left:8px;right:8px;z-index:99999;background:#b00;color:#fff;padding:8px;font-size:15px;font-weight:bold;';
    document.body.appendChild(_debugDiv);
  }
  _debugDiv.textContent = text;
}

export async function badgeSetzen(anzahlGespraeche: number): Promise<void> {
  debugAnzeigen(`gate: iOS=${isCapacitorIOS()}`);
  if (!isCapacitorIOS()) return;
  debugAnzeigen(`badge: count=${anzahlGespraeche} — setze…`);
  try {
    // iOS-Konvention: Anzahl der UNGELESENEN GESPRÄCHE, nicht der Nachrichten
    // (wie Mail/Discord). 0 räumt das Badge ab.
    if (anzahlGespraeche > 0) {
      await Badge.set({ count: anzahlGespraeche });
      debugAnzeigen(`badge gesetzt: ${anzahlGespraeche}`);
    } else {
      await Badge.clear();
      debugAnzeigen('badge geräumt (0 ungelesen)');
    }
  } catch (e) {
    debugAnzeigen(`FEHLER: ${String(e).slice(0, 120)}`);
  }
}
