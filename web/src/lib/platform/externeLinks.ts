import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';

/**
 * Externe Links öffnen im System-Browser-Blatt statt im WebView-Fenster.
 *
 * `target="_blank"` ist in der Hülle wirkungslos: die WKWebView kennt kein
 * Fenstermanagement — der Klick tut entweder nichts oder ersetzt die App.
 * Der eine delegierte Fang am Dokument (Capture-Phase, vor allen anderen
 * Handlern) schneidet alle _blank-Anker ab — auch künftige — und öffnet sie
 * im SFSafariViewController-Blatt, das eigene Sessions mitbringt (wichtig
 * für Doku- und Anbieter-Logins, die der WebView selbst nicht sehen muss).
 *
 * In Browser und Electron ein No-op: dort arbeiten _blank-Anker wie gehabt.
 * Ebenso in einer Hülle OHNE Browser-Plugin — die ausgelieferten Android-Bauten
 * bringen es nicht mit. Dort darf nichts abgefangen werden: Capacitor schickt
 * eine fremde Adresse dann selbst per Intent in den System-Browser
 * (`Bridge.launchIntent`), und genau dieser Weg ginge mit dem
 * `preventDefault` verloren — der Link täte nichts (Bughunt 2026-10-11, T8).
 * Gefragt wird `isPluginAvailable`: es liest die Kopfzeilen, die allein die
 * Hülle einspielt (`Capacitor.PluginHeaders`). `Capacitor.Plugins.Browser`
 * taugt dafür nicht — den Eintrag schreibt `registerPlugin` beim Import des
 * Pakets selbst, ob die Hülle das Plugin hat oder nicht.
 * Installieren/Rückgabe wie `registriereZurueckTaste`: die Rückgabe ist der
 * Aufräum-Griff für onDestroy.
 */
export function installiereExterneLinks(): () => void {
  if (!isCapacitorIOS() && !isCapacitorAndroid()) return () => undefined;
  if (!Capacitor.isPluginAvailable('Browser')) return () => undefined;
  const fange = (e: MouseEvent) => {
    const anker = (e.target as Element | null)?.closest?.('a[target="_blank"]');
    if (!anker) return;
    const url = anker.getAttribute('href');
    if (!url || !/^https?:\/\//.test(url)) return;
    e.preventDefault();
    e.stopPropagation();
    void Browser.open({ url }).catch(() => undefined);
  };
  document.addEventListener('click', fange, { capture: true });
  return () => document.removeEventListener('click', fange, { capture: true });
}
