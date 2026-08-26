/**
 * Aufnahmequelle je Stream-Slot (Windows + macOS).
 *
 * Ein Nutzer kann mehrere HQ-Streams gleichzeitig fahren, typischerweise einen
 * je Bildschirm. Welche Quelle zu welchem Stream gehört, entscheidet sich hier
 * — und zwar für JEDEN Slot einzeln.
 *
 * **Bis zum 2026-08-12 gab es nur zwei Merkfelder**, eines für Slot 0 und eines
 * für Slot 1. Alles darüber las und schrieb still das Feld von Slot 0: wer beim
 * dritten Stream einen Monitor wählte, stellte damit die Quelle des ersten um,
 * ohne es zu sehen.
 *
 * Linux kommt hier nicht vor: dort öffnet der Wayland-Portal-Dialog bei jedem
 * Start neu und der Nutzer wählt den Schirm dort. Es gibt nichts zu merken, die
 * Quelle bleibt `'portal'`.
 */

import { isMac, isWindows } from '$lib/platform/runtime';
import { quelleFuerStart, vorgabeFuerPlatz, wahlBleibt } from './monitorZuordnung';
import { gsr } from './gsr';
import { streamSettings } from './settingsState.svelte';
import {
  APP_AUDIO_PREFIX,
  MONITOR_CAPTURE_PREFIX,
  WINDOW_CAPTURE_PREFIX,
} from './settingsCatalog';

/**
 * Die GEMERKTE Wahl dieses Platzes (0 = erster Stream).
 *
 * Bewusst die gemerkte und nicht die gerade mögliche: fehlt ihr Bildschirm
 * gerade, soll der Nutzer trotzdem sehen, was er gewählt hat. Womit wirklich
 * aufgenommen wird, sagt {@link aktiveQuelleFuerSlot}.
 */
export function captureSourceForSlot(slot: number): string {
  if (slot <= 0) return streamSettings.capture_source;
  return (
    streamSettings.capture_sources[String(slot)] ??
    vorgabeFuerPlatz(slot, streamSettings.available_monitors)
  );
}

/**
 * Womit dieser Platz JETZT aufnimmt — und ob das die gewählte Quelle ist.
 *
 * Der Unterschied zur gemerkten Wahl fällt genau dann an, wenn ein Bildschirm
 * gerade fehlt. Dann wird für DIESEN Start ausgewichen, ohne die Wahl
 * anzutasten; kommt der Bildschirm zurück, greift sie wieder. Der Start und
 * die Beschriftung müssen beide hierher gehen — eine Nummer, die es nicht
 * gibt, liefe im Sidecar auf einen Fehler, und beim Zuschauer stünde eine
 * Beschriftung, die nicht zum Bild passt.
 */
export function aktiveQuelleFuerSlot(slot: number): { quelle: string; ausweichend: boolean } {
  return quelleFuerStart(
    captureSourceForSlot(slot),
    Math.max(slot, 0),
    streamSettings.available_monitors,
    streamSettings.available_windows.map((w) => w.id),
  );
}

/** Set the capture source for a given stream slot. */
export function setCaptureSourceForSlot(slot: number, value: string): void {
  if (slot <= 0) {
    streamSettings.capture_source = value;
    return;
  }
  // Direkt in die Karte geschrieben, nicht ersetzt: `capture_sources` liegt in
  // `$state`, ist also ein tiefer Proxy — auch ein NEUER Schlüssel meldet sich
  // bei jedem `$derived`, das ihn gelesen hat.
  streamSettings.capture_sources[String(slot)] = value;
}

/**
 * Linux: alle Slots zurück auf den Portal-Dialog.
 *
 * Nicht nur Kosmetik — die Einstellungen können von einer Windows-Sitzung
 * desselben Nutzers stammen (gleiches Konto, anderer Rechner). Ein dort
 * gemerkter `Monitor: 2` läge hier sonst weiter in den gespeicherten Werten,
 * wo er nichts bedeutet.
 */
export function resetCaptureSourcesToPortal(): void {
  streamSettings.capture_source = 'portal';
  streamSettings.capture_sources = {};
}

/**
 * Ton passend zur gewählten Quelle vorauswählen: Bildschirm → Systemton,
 * Fenster → Ton genau dieser Anwendung.
 *
 * Bewusst eine feste Kopplung ohne Ausnahmen — wer ein Fenster teilt, meint
 * fast immer dessen Ton, und die Auswahl steht sichtbar im Dialog, bevor der
 * Stream startet. Wer etwas anderes will (oder gar keinen Ton), stellt es
 * danach um; das überlebt, weil hier NUR beim aktiven Klick auf eine Quelle
 * aufgerufen wird — nicht aus `verfalleneWahlErsetzen`, das beim Öffnen des
 * Dialogs läuft und sonst jedes Mal die gespeicherte Ton-Wahl überschriebe.
 *
 * Der Prozessname passt ohne Übersetzung: `list_windows` liefert `app`
 * ("chrome.exe"), die Audio-Seite erwartet `App: chrome.exe`. Dass die App
 * gerade still ist, stört nicht — der Sidecar löst den Namen beim Start über
 * alle laufenden Prozesse auf, nicht nur über aktive Audio-Sitzungen.
 * Ohne ermittelbaren Prozessnamen bleibt der Ton unangetastet.
 *
 * **Jeder weitere Stream-Slot → Ton aus.** Zwei gleichzeitige Streams würden
 * sonst denselben Ton doppelt übertragen; der Zuschauer, der beide Kacheln
 * offen hat, hört alles zweimal. Der Ton ist eine EINZIGE, geteilte Einstellung
 * für alle Slots (s. `buildStartArgs`) — „aus" gilt hier also global, nicht nur
 * für den gerade eingestellten Slot. In der Praxis passt das, weil der erste
 * Stream typischerweise schon läuft (ein laufender Stream übernimmt spätere
 * Änderungen nicht mehr). Wer den Ton doch am zweiten Stream will, stellt ihn
 * danach wieder ein.
 */
export function applyAudioForCaptureSource(value: string, slot = 0): void {
  if (slot !== 0) {
    streamSettings.audio_mode = 'Aus';
    return;
  }
  if (value.startsWith(MONITOR_CAPTURE_PREFIX)) {
    streamSettings.audio_mode = 'Desktop';
    return;
  }
  if (!value.startsWith(WINDOW_CAPTURE_PREFIX)) return;
  const id = Number(value.slice(WINDOW_CAPTURE_PREFIX.length));
  const app = streamSettings.available_windows.find((w) => w.id === id)?.app?.trim();
  if (!app) return;
  streamSettings.audio_app = app;
  streamSettings.audio_mode = APP_AUDIO_PREFIX + app;
}

/**
 * Eine Wahl, die endgültig ins Leere zeigt, durch die Vorgabe ersetzen.
 *
 * **Das betrifft nur Fenster.** Ein geschlossenes Fenster kommt nicht wieder —
 * seine Kennung wird vom Betriebssystem neu vergeben und zeigte sonst
 * irgendwann auf ein fremdes. Eine Bildschirm-Wahl dagegen bleibt stehen, auch
 * wenn ihr Bildschirm gerade fehlt; die Begründung steht bei
 * `monitorZuordnung.wahlBleibt`, und sie ist der Kern der Meldung vom
 * 2026-08-26: hier wurde die Wahl weggeschrieben, sobald die Liste einmal
 * unvollständig war — und beim Aufwachen aus der Bildschirmsperre ist sie das.
 */
function verfalleneWahlErsetzen(slot: number): void {
  const current = captureSourceForSlot(slot);
  if (wahlBleibt(current)) return;
  const wins = streamSettings.available_windows;
  if (wins.some((w) => `${WINDOW_CAPTURE_PREFIX}${w.id}` === current)) return;
  setCaptureSourceForSlot(slot, vorgabeFuerPlatz(slot, streamSettings.available_monitors));
}

/**
 * Gespeicherte Quellen gegen die aktuell vorhandenen Fenster prüfen
 * (Windows + macOS) — ein geschlossenes Fenster darf nicht als Auswahl stehen
 * bleiben. Eine Bildschirm-Wahl dagegen bleibt hier immer stehen, auch wenn ihr
 * Bildschirm gerade fehlt (`verfalleneWahlErsetzen` via `wahlBleibt`).
 *
 * **Der frühere Name `resolveMonitorCaptureSource` passte nicht mehr**: seit
 * dem 2026-08-26 fasst diese Funktion Bildschirm-Wahlen gar nicht mehr an, und
 * ein Name, der das Gegenteil ankündigt, führt beim nächsten Mal genau dorthin
 * zurück, wo der Fehler herkam.
 *
 * Durchgegangen werden Slot 0 (der hat immer einen gespeicherten Wert) und die
 * Slots, für die der Nutzer wirklich etwas gewählt hat. Alle übrigen holen ihre
 * Vorgabe ohnehin aus `vorgabeFuerPlatz`, das immer aus der aktuellen
 * Monitorliste rechnet und darum gar nicht veralten kann.
 */
export function verfalleneWahlenErsetzen(): void {
  verfalleneWahlErsetzen(0);
  for (const key of Object.keys(streamSettings.capture_sources)) {
    verfalleneWahlErsetzen(Number(key));
  }
}

/** Refresh the monitor list (Windows + macOS; called from the monitor picker).
 *  Re-resolves the capture source — a closed window's pick doesn't linger; a
 *  monitor pick is kept even while its monitor is briefly gone. */
export async function refreshMonitors(): Promise<void> {
  try {
    const r = await gsr.listMonitors();
    if (r?.ok) {
      streamSettings.available_monitors = r.monitors ?? [];
      verfalleneWahlenErsetzen();
    }
  } catch {
    // tolerate — keep the previous list
  }
}

/**
 * Die Monitorliste beschaffen, **falls noch keine da ist**.
 *
 * Für Ansichten, die Bildschirme anzeigen, ohne sie selbst zu holen. `loadCatalogs()`
 * hängt am HQ-Stream-Dialog und `refreshMonitors()` an dessen Knopf — wer keines
 * von beidem öffnet, sah bis zum 2026-08-26 eine leere Liste. Im Reiter
 * „Remote-Rechner" hiess das: statt der Schirme stand dort nur der Ersatz-Eintrag
 * „Hauptbildschirm", ein Rechner mit zwei Monitoren sah aus wie einer mit einem.
 *
 * **Nur wenn leer**, damit ein Aufruf aus einem `$effect` nicht bei jeder
 * Neuberechnung den Sidecar befragt; wer eine frische Liste WILL, nimmt
 * weiterhin `refreshMonitors()`. Linux bleibt aussen vor — dort wählt der
 * Wayland-Portal-Dialog beim Start, es gibt nichts aufzuzählen (gleiche
 * Bedingung wie in `settings.svelte.ts::loadCatalogs`).
 */
export async function monitoreSicherstellen(): Promise<void> {
  if (streamSettings.available_monitors.length > 0) return;
  if (!isWindows() && !isMac()) return;
  await refreshMonitors();
}

/** Refresh the capturable-window list (Windows + macOS; called from the source
 *  picker). Re-resolves the capture source so a now-closed window doesn't
 *  linger as the selection. */
export async function refreshWindows(): Promise<void> {
  try {
    const r = await gsr.listWindows();
    if (r?.ok) {
      streamSettings.available_windows = r.windows ?? [];
      verfalleneWahlenErsetzen();
    }
  } catch {
    // tolerate — keep the previous list
  }
}
