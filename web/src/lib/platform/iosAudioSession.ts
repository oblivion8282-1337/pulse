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

/**
 * Ein gemeldeter Wechsel des Ausgabewegs.
 *
 * `weg` ist die Einteilung der Huelle (`eingebaut`/`kabel`/`funk`) — und der
 * einzige Teil, an dem haengt, ob die Session neu eingerichtet werden muss.
 * `aktuell` ist der genaue Porttyp und nur fuer die Anzeige gedacht: ein
 * Wechsel von Lautsprecher auf Hoermuschel aendert ihn, den Tonweg nicht.
 */
export interface WegWechsel {
  aktuell: string;
  aktuellName: string;
  weg: string;
}

/** Telefonanruf, Siri, Wecker. */
export interface Unterbrechung {
  art: 'begonnen' | 'beendet';
  /** Nur bei `beendet`: iOS haelt ein Fortsetzen fuer angebracht. */
  weiterMoeglich?: boolean;
}

interface AudioSessionPlugin {
  setVoiceActive(
    options: { aktiv: boolean; hqFunk: boolean }
  ): Promise<{ modus: string; weg: string }>;
  setPlaybackMode(): Promise<void>;
  routen(): Promise<TonWege>;
  routeSetzen(options: { id: string }): Promise<void>;
  jetztLaeuft(options: { titel: string; zeile2: string }): Promise<void>;
  jetztLaeuftAus(): Promise<void>;
  airplayWaehler(): Promise<void>;
  addListener(
    name: 'unterbrechung',
    cb: (e: Unterbrechung) => void
  ): Promise<{ remove: () => void }>;
  addListener(
    name: 'routeGewechselt',
    cb: (e: WegWechsel) => void
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

/**
 * Voice-Modus an/aus. Liefert den Modus, den die Hülle gewählt hat.
 *
 * **Der Rückgabewert trägt die halbe Entscheidung über die Tonqualität.**
 * `voiceChat` heisst: Apple filtert schon (Echo, Rauschen, Pegel) — dann darf
 * RNNoise NICHT zusätzlich laufen. `default` heisst: Apple filtert nicht
 * (Hochqualitäts-Route über Bluetooth) — dann ist RNNoise der einzige Filter.
 * Die Rechnung dazu steht geprüft in `voice/filterwahl.ts`.
 *
 * `unbekannt`, wenn die Hülle nicht antwortet (älterer Bau ohne das Feld):
 * dann bleibt es beim Wunsch des Nutzers, also beim bisherigen Verhalten.
 */
export async function iosVoiceAktiv(
  aktiv: boolean,
  hqFunk = false
): Promise<{ modus: string; weg: string | null }> {
  if (!isCapacitorIOS()) return { modus: 'unbekannt', weg: null };
  const p = plugin();
  if (!p) return { modus: 'unbekannt', weg: null };
  const antwort = await p.setVoiceActive({ aktiv, hqFunk }).catch((e: unknown) => {
    // **Nicht stillschweigend verschlucken.** Scheitert das Einrichten, ist
    // die Session nicht aktiv — der Sprachkanal steht dann verbunden da und
    // ist stumm. Am 2026-10-10 am Geraet gesehen; der Fehlschlag war in der
    // Oberflaeche an nichts erkennbar. Der Rueckfall bleibt derselbe, aber er
    // ist jetzt sichtbar.
    console.error('[Ton] setVoiceActive fehlgeschlagen', e);
    return undefined;
  });
  // `weg: null` heisst „nicht erfahren", nicht „kein Weg" — der Aufrufer darf
  // daraus keinen Wegwechsel ableiten.
  return { modus: antwort?.modus ?? 'unbekannt', weg: antwort?.weg ?? null };
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
/**
 * **Ohne Hoerer seit dem 2026-10-10 — und das ist Absicht.**
 *
 * Der Binder bleibt, der Aufrufer ist weg: wer auf eine beendete
 * Unterbrechung hin die eigene Session wieder aktiviert, unterbricht damit
 * WebKit und raeumt dessen laufende Aufnahme ab (Messung an der Stelle in
 * `iosTon.ts`, wo der Hoerer sass). Die Huelle meldet weiter und schreibt es
 * ins Geraetelog; wer hier wieder zuhoert, braucht vorher eine Messung, dass
 * ueberhaupt etwas kaputtgeht.
 */
export function iosUnterbrechungen(cb: (e: Unterbrechung) => void): () => void {
  if (!isCapacitorIOS()) return () => undefined;
  const p = plugin();
  if (!p) return () => undefined;
  const griff = p.addListener('unterbrechung', cb);
  return () => void griff.then((h) => h.remove()).catch(() => undefined);
}

/** Wegwechsel melden (Headset rein/raus, AirPods verbunden). */
export function iosWegWechsel(cb: (e: WegWechsel) => void): () => void {
  if (!isCapacitorIOS()) return () => undefined;
  const p = plugin();
  if (!p) return () => undefined;
  // **Die Nutzlast wird durchgereicht, nicht verworfen.** Sie war von Anfang
  // an da (`routeGewechselt` in `AudioSessionPlugin.swift`); dass dieser
  // Binder sie wegwarf, hat `iosTon.ts` monatelang zu einer Zeitfrist
  // gezwungen, wo ein Vergleich genuegt.
  const griff = p.addListener('routeGewechselt', cb);
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

/**
 * Öffnet Apples AirPlay-Auswahl (Punkt 30 der iOS-Liste).
 *
 * Gibt `false` zurück, wenn der Dialog nicht aufgeht — dann gehört ein
 * Hinweis auf das Kontrollzentrum in die Oberfläche. Das Plugin kann das
 * nicht garantieren (Begründung dort an der Methode), und ein Knopf, der
 * still nichts tut, wäre die schlechtere Antwort.
 */
export async function iosAirplayWaehler(): Promise<boolean> {
  if (!isCapacitorIOS()) return false;
  const p = plugin();
  if (!p) return false;
  return p
    .airplayWaehler()
    .then(() => true)
    .catch((e) => {
      console.warn('[iosAudioSession] AirPlay-Auswahl nicht erreichbar', e);
      return false;
    });
}
