/**
 * Systemschriftgröße anwenden (iOS-Liste Punkt 38).
 *
 * Die Hülle meldet die ROHE Kategorie als `data-schriftkategorie` am
 * `<html>`-Element (`AppDelegate.schriftKategorieMelden`); die Umrechnung samt
 * Obergrenze steht geprüft in `schriftskala.ts`. Hier wird sie angewandt und
 * weiterverfolgt.
 *
 * **Angewandt wird `-webkit-text-size-adjust`, nicht die Wurzel-Schriftgröße** —
 * Begründung in `schriftskala.ts`: alle Größen dieser App stehen in `rem`, eine
 * größere Wurzel skalierte das ganze Layout mit, und dort gibt es harte
 * Zusagen (einzeilige Sprach-Knopfreihe, 48-dp-Trefferflächen).
 *
 * Außerhalb der Hülle ist alles No-op: das Attribut erscheint nie, und im
 * Browser folgt die Schrift ohnehin den Einstellungen des Browsers.
 */
import { skalaFuerKategorie } from './schriftskala';

const ATTRIBUT = 'data-schriftkategorie';

function anwenden(): void {
  const wurzel = document.documentElement;
  const skala = skalaFuerKategorie(wurzel.getAttribute(ATTRIBUT));
  // 100 % ausdrücklich setzen und nicht weglassen: ein Zurückstellen auf
  // „normal" muss eine vorherige Vergrößerung auch wieder zurücknehmen.
  wurzel.style.setProperty('-webkit-text-size-adjust', `${skala}%`);
}

let laeuft = false;

/** Einmal pro Fenster aufrufen (`app/+layout.svelte`). */
export function schriftGroesseVerfolgen(): void {
  if (laeuft || typeof document === 'undefined') return;
  laeuft = true;
  anwenden();
  // Das Attribut kann sich jederzeit ändern (Nutzer stellt die Schriftgröße
  // um, während die App läuft) — die Hülle schreibt es dann neu.
  new MutationObserver(anwenden).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTRIBUT]
  });
}
