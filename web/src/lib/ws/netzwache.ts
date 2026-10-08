/**
 * Netzwache — holt die WebSocket-Verbindungen zurück, sobald es einen Anlass
 * gibt, statt auf die nächste Backoff-Stufe zu warten.
 *
 * **Das Problem, das sie löst, ist ein Mobil-Problem.** Der Reconnect staffelt
 * sich bis 300 s auseinander, und das ist gegen einen abweisenden Server
 * richtig. Auf einem Telefon ist es die falsche Zahl: Tunnel, Flugmodus,
 * WLAN→Mobilfunk, Bildschirm zehn Minuten aus — danach stand die App bis zu
 * fünf Minuten still, ohne dass irgendetwas kaputt war. Was fehlte, war nicht
 * ein kürzerer Takt, sondern der ANLASS.
 *
 * Drei Anlässe, und alle drei braucht es:
 *   - `online` — das Netz meldet sich zurück. Sagt nichts darüber, ob es
 *     TRÄGT (ein Hotelnetz mit Anmeldeseite ist „online"), deshalb ist es ein
 *     Anlass und kein Beweis.
 *   - `visibilitychange` → sichtbar. Deckt den Browser und jeden Tab ab; in
 *     einer Hülle feuert es beim Zurückholen der App mit.
 *   - Capacitor `appStateChange` → `isActive`. **Nicht überflüssig neben dem
 *     zweiten:** iOS friert eine App im Hintergrund ein, und ob die WebView
 *     beim Auftauen zuverlässig `visibilitychange` nachliefert, ist nicht
 *     belegt — gemessen habe ich es nicht. Der Zusatz kostet einen Haken, und
 *     zwei Anlässe gleichzeitig verpuffen ohnehin (Mindestabstand in
 *     `wachentscheid.ts`).
 *
 * Die eigentliche Entscheidung („verbinden, pingen oder nichts") steht geprüft
 * in `wachentscheid.ts`; hier stehen nur die Anlässe.
 */
import { App as CapApp } from '@capacitor/app';
import { isCapacitorAndroid, isCapacitorIOS } from '$lib/platform/runtime';
import { gatewayPool } from './gateway-pool.svelte';

let laeuft = false;

/** Einmal pro Fenster aufrufen (`app/+layout.svelte`). Mehrfachaufrufe sind
 *  wirkungslos — die Haken hängen am Fenster, nicht an einer Komponente, und
 *  würden sich sonst stapeln. */
export function netzwacheStarten(): void {
  if (laeuft || typeof window === 'undefined') return;
  laeuft = true;

  const wecken = () => gatewayPool.alleWachPruefen();

  window.addEventListener('online', wecken);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wecken();
  });

  if (isCapacitorIOS() || isCapacitorAndroid()) {
    // Kein `await`: der Haken darf nachträglich scharf werden, die ersten
    // Millisekunden nach dem Start deckt der normale Verbindungsaufbau ab.
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) wecken();
    });
  }
}
