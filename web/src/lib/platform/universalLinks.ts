import { App } from '@capacitor/app';
import { goto } from '$app/navigation';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { zielPfad } from './tiefenlink';

/**
 * Chat-Adressen von howispulse.com öffnen die App statt des Browsers.
 *
 * Die Hülle bekommt sie als `appUrlOpen`-Ereignis; welche Adressen überhaupt
 * ankommen, bestimmt Apple anhand von
 * `web/static/.well-known/apple-app-site-association` (nur Chat-Pfade,
 * Eigentümer-Entscheid 2026-10-08). **Auf diese Vorauswahl verlassen wir uns
 * nicht**: `zielPfad` prüft Herkunft und Pfad noch einmal selbst — das
 * Ereignis trägt auch eigene URL-Schemata, und es ist dieselbe Stelle, die
 * später ein QR-Code oder eine Share-Extension füttern würde.
 *
 * Browser und Electron: No-op. Installieren/Rückgabe wie
 * `installiereExterneLinks` — die Rückgabe ist der Aufräum-Griff für
 * `onDestroy`.
 */
export function installiereUniversalLinks(): () => void {
  if (!isCapacitorIOS() && !isCapacitorAndroid()) return () => undefined;
  const griff = App.addListener('appUrlOpen', ({ url }) => {
    const ziel = zielPfad(url);
    // Kein erkanntes Ziel: NICHTS tun. Die App ist durch das Ereignis ohnehin
    // schon im Vordergrund; irgendwohin zu springen wäre schlechter als da zu
    // bleiben, wo der Nutzer war.
    if (!ziel) return;
    void goto(ziel);
  });
  return () => {
    void griff.then((h) => h.remove()).catch(() => undefined);
  };
}
