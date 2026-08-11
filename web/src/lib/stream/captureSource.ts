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

import type { GsrMonitor } from './gsr';
import { gsr } from './gsr';
import { streamSettings } from './settingsState.svelte';
import {
  APP_AUDIO_PREFIX,
  MONITOR_CAPTURE_PREFIX,
  WINDOW_CAPTURE_PREFIX,
} from './settingsCatalog';

/**
 * Die Monitore in der Reihenfolge, in der sie an die Slots verteilt werden:
 * Hauptmonitor zuerst, danach die übrigen so, wie der Sidecar sie meldet.
 */
function monitorOrder(): GsrMonitor[] {
  const mons = streamSettings.available_monitors;
  const primary = mons.find((mon) => mon.primary) ?? mons[0];
  if (!primary) return [];
  return [primary, ...mons.filter((mon) => mon !== primary)];
}

/**
 * Die Vorgabe für einen Slot, für den der Nutzer noch nichts gewählt hat: der
 * N-te Monitor der Reihe. Ein Nutzer mit zwei Schirmen bekommt so ohne Zutun je
 * einen Stream pro Schirm.
 *
 * Gehen die Monitore aus, fängt die Reihe von vorn an (Slot 2 auf zwei Schirmen
 * landet wieder auf dem Hauptmonitor). Doppelt geht nicht anders — mehr Streams
 * als Schirme sind erlaubt —, und reihum verteilt es sich wenigstens
 * gleichmäßig, statt alle überzähligen Streams auf denselben Schirm zu legen.
 * Ohne gemeldeten Monitor bleibt es beim Portal-Wert.
 *
 * Bewusst beim LESEN gerechnet statt beim Laden in die Einstellungen
 * geschrieben: sonst stünden für jeden möglichen Slot Einträge in der
 * gespeicherten Datei, auch für die 90-plus, die nie jemand benutzt.
 */
function defaultCaptureSourceForSlot(slot: number): string {
  const order = monitorOrder();
  if (order.length === 0) return 'portal';
  return `${MONITOR_CAPTURE_PREFIX}${order[slot % order.length].index}`;
}

/** The capture source for a given stream slot (0 = primary stream). */
export function captureSourceForSlot(slot: number): string {
  if (slot <= 0) return streamSettings.capture_source;
  return streamSettings.capture_sources[String(slot)] ?? defaultCaptureSourceForSlot(slot);
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
 * aufgerufen wird — nicht aus `resolveSlotCaptureSource`, das beim Öffnen des
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
 * Windows + macOS: resolve one slot's capture source to a concrete target from
 * the enumerated sources. A persisted choice wins if it still matches a live
 * window (`window:<id>`) or monitor (`Monitor: <n>`); otherwise fall back to
 * this slot's default — which is `'portal'` when no monitor is enumerated.
 */
function resolveSlotCaptureSource(slot: number): void {
  const current = captureSourceForSlot(slot);
  // A still-valid window pick wins — don't snap a chosen app back to a monitor.
  const wins = streamSettings.available_windows;
  if (wins.some((w) => `${WINDOW_CAPTURE_PREFIX}${w.id}` === current)) return;

  const m = /^Monitor: (\d+)$/.exec(current);
  if (m && streamSettings.available_monitors.some((mon) => mon.index === Number(m[1]))) return;
  setCaptureSourceForSlot(slot, defaultCaptureSourceForSlot(slot));
}

/**
 * Gespeicherte Quellen gegen die aktuell vorhandenen Monitore und Fenster
 * prüfen (Windows + macOS) — ein abgestecktes Kabel oder ein geschlossenes
 * Fenster darf nicht als Auswahl stehen bleiben.
 *
 * Durchgegangen werden Slot 0 (der hat immer einen gespeicherten Wert) und die
 * Slots, für die der Nutzer wirklich etwas gewählt hat. Alle übrigen holen ihre
 * Vorgabe ohnehin aus `defaultCaptureSourceForSlot`, das immer aus der
 * aktuellen Monitorliste rechnet und darum gar nicht veralten kann.
 */
export function resolveMonitorCaptureSource(): void {
  resolveSlotCaptureSource(0);
  for (const key of Object.keys(streamSettings.capture_sources)) {
    resolveSlotCaptureSource(Number(key));
  }
}

/** Refresh the monitor list (Windows + macOS; called from the monitor picker).
 *  Re-resolves the capture source so a now-unplugged monitor doesn't linger. */
export async function refreshMonitors(): Promise<void> {
  try {
    const r = await gsr.listMonitors();
    if (r?.ok) {
      streamSettings.available_monitors = r.monitors ?? [];
      resolveMonitorCaptureSource();
    }
  } catch {
    // tolerate — keep the previous list
  }
}

/** Refresh the capturable-window list (Windows + macOS; called from the source
 *  picker). Re-resolves the capture source so a now-closed window doesn't
 *  linger as the selection. */
export async function refreshWindows(): Promise<void> {
  try {
    const r = await gsr.listWindows();
    if (r?.ok) {
      streamSettings.available_windows = r.windows ?? [];
      resolveMonitorCaptureSource();
    }
  } catch {
    // tolerate — keep the previous list
  }
}
