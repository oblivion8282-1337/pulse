import { isCapacitorIOS } from './runtime';

/**
 * iOS-Audio-Session-Steuerung (Hülle) — natives Gegenstück zu
 * `setVoiceActive` auf Android (audioRoute.ts).
 *
 * WARUM: iOS killt die Audio-Session beim Sperren des Displays, und der
 * `voiceChat`-Modus (iOS-eigenes Echo-Auslösen + Bluetooth-Mikrofon) wird
 * vom Browser-Stack nicht gesetzt. Das native Plugin (App/AudioSession-
 * Plugin.swift, im App-Target auto-registriert) steuert die Prozess-Session.
 *
 * Browser und Electron: No-op.
 */

/** Ein waehlbarer Ausgabeweg. `id` ist `speaker`, `earpiece` oder die UID
 *  eines echten Geraets (AirPods, Autoradio, Kabel-Headset). */
export interface TonWeg {
  id: string;
  /** iOS-Porttyp (`BluetoothHFP`, `HeadphonesBT`, `Speaker`, …) bzw. die
   *  beiden festen Werte `speaker`/`earpiece`. */
  art: string;
  name: string;
}

export interface TonWege {
  /** Porttyp des AKTIVEN Ausgangs — nicht zwingend eine `id` aus `geraete`. */
  aktuell: string;
  aktuellName: string;
  geraete: TonWeg[];
}

/** Telefonanruf, Siri, Wecker. */
export interface Unterbrechung {
  art: 'begonnen' | 'beendet';
  /** Nur bei `beendet`: iOS haelt ein Fortsetzen fuer angebracht. */
  weiterMoeglich?: boolean;
}

interface AudioSessionPlugin {
  setVoiceActive(options: { aktiv: boolean }): Promise<void>;
  setPlaybackMode(): Promise<void>;
  routen(): Promise<TonWege>;
  routeSetzen(options: { id: string }): Promise<void>;
  jetztLaeuft(options: { titel: string; zeile2: string }): Promise<void>;
  jetztLaeuftAus(): Promise<void>;
  addListener(
    name: 'unterbrechung',
    cb: (e: Unterbrechung) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    name: 'routeGewechselt',
    cb: (e: { aktuell: string; aktuellName: string }) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    name: 'fernbefehl',
    cb: (e: { befehl: 'laut' | 'stumm' }) => void
  ): Promise<{ remove: () => void }>;
}

function plugin(): AudioSessionPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (cap?.Plugins?.AudioSessionPlugin as AudioSessionPlugin | undefined) ?? null;
}

/** Voice-Modus (Mikro + Echo-Auslösen + Bluetooth) an/aus. */
export async function iosVoiceAktiv(aktiv: boolean): Promise<void> {
  if (!isCapacitorIOS()) return;
  const p = plugin();
  if (!p) return;
  await p.setVoiceActive({ aktiv }).catch(() => undefined);
}

/** Playback-Modus (Watch-/Stream-Ton ohne Mikro). */
export async function iosPlaybackModus(): Promise<void> {
  if (!isCapacitorIOS()) return;
  const p = plugin();
  if (!p) return;
  await p.setPlaybackMode().catch(() => undefined);
}

/**
 * Die verfuegbaren Ausgabewege. Leere Liste ausserhalb der Huelle.
 *
 * **iOS waehlt anders als Android**: dort pinnt man ein Ausgabegeraet, hier
 * waehlt man den Eingang und der Ausgang folgt (bei einem Bluetooth-Headset
 * ist beides dasselbe Geraet). Lautsprecher und Hoermuschel sind kein
 * Eingang, sondern eine Uebersteuerung — sie stehen deshalb als feste
 * Eintraege in der Liste.
 */
export async function iosTonWege(): Promise<TonWege | null> {
  if (!isCapacitorIOS()) return null;
  const p = plugin();
  if (!p) return null;
  return p.routen().catch(() => null);
}

/** Einen Ausgabeweg erzwingen. `false`, wenn er nicht (mehr) da ist. */
export async function iosTonWegSetzen(id: string): Promise<boolean> {
  if (!isCapacitorIOS()) return false;
  const p = plugin();
  if (!p) return false;
  return p
    .routeSetzen({ id })
    .then(() => true)
    .catch(() => false);
}

/** Unterbrechungen melden (Telefonanruf, Siri, Wecker). Rueckgabe = Abriss. */
export function iosUnterbrechungen(cb: (e: Unterbrechung) => void): () => void {
  if (!isCapacitorIOS()) return () => undefined;
  const p = plugin();
  if (!p) return () => undefined;
  const griff = p.addListener('unterbrechung', cb);
  return () => void griff.then((h) => h.remove()).catch(() => undefined);
}

/** Wegwechsel melden (Headset rein/raus, AirPods verbunden). */
export function iosWegWechsel(cb: () => void): () => void {
  if (!isCapacitorIOS()) return () => undefined;
  const p = plugin();
  if (!p) return () => undefined;
  const griff = p.addListener('routeGewechselt', () => cb());
  return () => void griff.then((h) => h.remove()).catch(() => undefined);
}

/** Was gerade läuft, auf Sperrbildschirm und Kontrollzentrum anzeigen. */
export async function iosJetztLaeuft(titel: string, zeile2: string): Promise<void> {
  if (!isCapacitorIOS()) return;
  await plugin()?.jetztLaeuft({ titel, zeile2 }).catch(() => undefined);
}

/** Anzeige wieder abräumen. */
export async function iosJetztLaeuftAus(): Promise<void> {
  if (!isCapacitorIOS()) return;
  await plugin()?.jetztLaeuftAus().catch(() => undefined);
}

/** Knopfdrücke vom Sperrbildschirm (`laut`/`stumm`). Rückgabe = Abriss. */
export function iosFernbefehle(cb: (befehl: 'laut' | 'stumm') => void): () => void {
  if (!isCapacitorIOS()) return () => undefined;
  const p = plugin();
  if (!p) return () => undefined;
  const griff = p.addListener('fernbefehl', (e) => cb(e.befehl));
  return () => void griff.then((h) => h.remove()).catch(() => undefined);
}
