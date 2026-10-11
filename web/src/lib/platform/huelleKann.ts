/**
 * Die dünne Hülle um `huellenKoepfe.ts`: fragt das laufende Capacitor.
 *
 * **Was ein fehlender Eintrag tatsächlich anrichtet** — am 2026-10-11 gegen
 * das echte `@capacitor/core` 8.4.0 nachgestellt (`test/huelle-kann.test.ts`)
 * und im Simulator gegen die echte Brücke bestätigt (Probeseite im heutigen
 * App-Bau; einmal unverändert, einmal mit auf fünf Methoden gekürztem Kopf):
 *
 * - Über `registerPlugin` gerufen, lehnt der Kern eine Methode, die im Kopf
 *   fehlt, SOFORT mit `UNIMPLEMENTED` ab; der Ruf erreicht die Hülle nie.
 *   Ein Hängen ist auf diesem Weg ausgeschlossen. Der Schaden ist ein
 *   anderer: eine Funktion, die nach aussen geschaltet aussieht und es nicht
 *   ist, wenn der Aufrufer die Ablehnung schluckt.
 * - Über das rohe `Capacitor.Plugins.X` gerufen (das Objekt legt die Hülle
 *   mit genau den Methoden IHRES Baus an — gelesen in `JSExport.exportJS`,
 *   nicht nachgestellt), ist die Methode schlicht `undefined`: ein
 *   `TypeError` am Aufrufort.
 * - Hängen bleibt ein Ruf nur, wenn er die Hülle ERREICHT und dort nie
 *   beantwortet wird. `CapacitorBridge.handleJSCall` kehrt bei unbekannter
 *   Methode ohne Antwort zurück — im Simulator: derselbe Name direkt an
 *   `Capacitor.nativePromise` war nach 3 s noch offen, die Hülle schrieb nur
 *   „No method found" ins Log. Eine angenommene Methode, die nie
 *   `resolve`/`reject` ruft, hängt ebenso. Dagegen steht `brueckenFrist.ts`,
 *   nicht diese Datei.
 *
 * Diese Datei beantwortet die Frage VOR dem Ruf, damit eine Weiche gar nicht
 * erst einen halben Weg wählt.
 */

import { Capacitor } from '@capacitor/core';

import { pluginBefund, type PluginBefund } from './huellenKoepfe.ts';

/**
 * Trägt der installierte Bau `plugin` mit allen `methoden`?
 *
 * **Nur für native Plugins ohne JS-Umsetzung** — also alle unsere eigenen.
 * Ein Plugin mit Web-Umsetzung für diese Plattform meldet
 * `isPluginAvailable` auch ohne Kopf; dort sagt der Kopf nichts über die
 * Methoden.
 */
export function huellenBefund(plugin: string, methoden: readonly string[]): PluginBefund {
  // Zuerst Capacitors eigene Antwort: ändert ein künftiger Kern, woran er ein
  // Plugin erkennt, folgt die Weiche ihm, statt an den Köpfen vorbeizusehen.
  if (!Capacitor.isPluginAvailable(plugin)) return { da: false, grund: 'kein-plugin' };
  const koepfe = (Capacitor as unknown as { PluginHeaders?: unknown }).PluginHeaders;
  return pluginBefund(koepfe, plugin, methoden);
}

/** Kennt der installierte Bau `plugin.methode`? */
export function huelleKennt(plugin: string, methode: string): boolean {
  return huellenBefund(plugin, [methode]).da;
}
