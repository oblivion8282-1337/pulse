/**
 * Welche Einstellungs-Reiter dieser Client gerade zeigt — die eine Rechnung
 * fuer alle drei Orte.
 *
 * **Warum ein eigenes Modul.** Seit dem Mobil-Umbau gibt es die Einstellungen
 * an drei Stellen: als Reiter im Dialog (`SettingsDialog`), als Liste im
 * Du-Bereich (`MeSectionList`) und als aufgeschobenen Bildschirm
 * (`/app/me/[section]`, der pruefen muss, ob die Kennung aus der Adresse hier
 * ueberhaupt angeboten wird). Alle drei stellten dieselben vier Bedingungen
 * zusammen — wortgleich, in drei Dateien, mit denselben neun Importen. Kommt
 * eine fuenfte Bedingung dazu, faellt sie an zwei der drei Stellen still
 * durch, und zwar in die gefaehrliche Richtung: ein Reiter, der hier nichts
 * tun kann, stuende trotzdem da.
 *
 * **Getrennt von `settingsTabs.ts`**, weil dort die reinen Daten und die
 * reine Filterfunktion wohnen (ohne Runen, ohne Stores, damit beide Seiten sie
 * gleich aufrufen koennen). Hier haengen die Stores dran, also gehoert es in
 * eine `.svelte.ts` daneben.
 *
 * **Ohne eigene Runen.** Beide Funktionen lesen die Stores beim AUFRUF; der
 * Aufrufer packt sie in sein eigenes `$derived` bzw. `$effect` und bekommt
 * damit dieselbe Reaktivitaet wie vorher an Ort und Stelle.
 */
import { deviceStore } from '$lib/devices/store.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { isCapacitorAndroid, isElectron } from '$lib/platform/runtime';
import { viewport } from '$lib/stores/viewport.svelte';
import { sichtbareReiter, type SettingsTabDef } from '$lib/components/settingsTabs';

/**
 * Die unter den aktuellen Bedingungen sichtbaren Reiter.
 *
 * Die vier Bedingungen im Einzelnen:
 *
 * * **`imBrowser`** — in der Electron-App / im Android-Wrapper ausgeblendet:
 *   dort ist die App schon installiert, Download-Links waeren sinnlos.
 * * **`istDesktopApp`** — jede Desktop-App, egal welche Plattform. Im Browser
 *   gibt es keinen lokalen Sidecar und keine `sidecar.log`, dort gaebe es also
 *   nichts einzustellen. **Hier stand bis 2026-08-06 `linuxOnly`**, aus der
 *   Zeit, als der Reiter nur den Rust-Linux-Sidecar umschaltete. Seit der
 *   Diagnose-Schalter im „Experimental"-Reiter sitzt, war das ein stiller
 *   Ausschluss: Windows- und macOS-Nutzer sahen den Reiter nicht, konnten die
 *   Einwilligung also gar nicht geben — und es kam nie ein einziger Bericht
 *   von dort an. Der Upload-Weg selbst war die ganze Zeit plattformneutral
 *   (`sidecar-log.ts` kennt den Windows-Pfad ausdruecklich), es fehlte allein
 *   der Schalter.
 * * **`istMobil`** — blendet die reinen Rechner-Reiter aus.
 *
 * Der Standplatz hatte hier bis zum 2026-09-09 eine vierte Bedingung
 * (`zeigtStandplatz`, s. `$lib/devices/reiterSichtbar.ts`); mit dem Reiter
 * ist auch sie in die Rail gewandert (`StandplatzRailButton`).
 */
export function sichtbareReiterJetzt(tabs: SettingsTabDef[]): SettingsTabDef[] {
  return sichtbareReiter(tabs, {
    istMobil: viewport.isMobile,
    imBrowser: !isElectron() && !isCapacitorAndroid(),
    istDesktopApp: isElectron(),
  });
}

/**
 * Geraete fuer ALLE Communitys vorladen — Rumpf fuer den `$effect` des
 * Aufrufers, der seine eigene Bedingung davorsetzt (der Dialog nur bei
 * geoeffnetem Dialog, die Liste immer).
 *
 * Ohne das kennt `deviceStore.eigene()` nur die Community, deren
 * Kanalliste zuletzt offen war, und die Standplatz-Sichtbarkeit bliebe
 * dauerhaft falsch,
 * wenn das eigene Geraet woanders steht oder die Einstellungen aus einer
 * Ansicht ohne aktive Community geoeffnet werden (DM/Freunde, mobile Bereiche).
 * Der einzige bisherige Nachlade-Pfad (`SettingsStandplatzGeraete`) lag HINTER
 * genau der Sichtbarkeitsentscheidung, die er beheben sollte — ein
 * Henne-Ei-Problem ohne Selbstheilung (Fix-Runde 1, 2026-08-20).
 *
 * `ensureLoaded` ist intern idempotent (bereits geladene Communitys werden
 * nicht neu geholt) — ein zweites Oeffnen loest also keine neuen Anfragen aus.
 * Blockiert nicht: die Reiter richten sich reaktiv nach, sobald die Daten da
 * sind. `queueMicrotask` wie beim Vorbild in `app/+layout.svelte`, wegen des
 * Svelte-Effect-Depth-Guards.
 */
export function alleGeraeteVorladen(): void {
  const guildIds = guilds.list.map((g) => g.id);
  queueMicrotask(() => {
    for (const id of guildIds) void deviceStore.ensureLoaded(id);
  });
}
