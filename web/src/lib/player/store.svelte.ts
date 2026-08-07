/**
 * Svelte-5-Runes-Zustand fuer den nativen HQ-Player: die Opt-in-Einstellung
 * (`useNativePlayer`, persistiert wie `stream/settings.svelte.ts`) und eine
 * Sitzungs-Klasse, die den `<video>`-freien Wiedergabepfad abbildet.
 *
 * Anders als `hqStreamManager.svelte.ts` haelt eine `NativePlayerSession`
 * KEINE eigene Verbindung zum Ton — der laeuft unveraendert ueber den
 * bestehenden `hqStreams`-Manager weiter (dessen Video-Element bleibt
 * dauerhaft stumm, der Ton kommt aus dem Web-Audio-Graphen, siehe
 * `hqStreamManager.svelte.ts`). Diese Sitzung ersetzt nur das BILD durch das
 * native Fenster.
 *
 * Registry-Muster (ensure/get/close/closeExcept) spiegelt `hqStreams` in
 * `hqStreamManager.svelte.ts`: `closeExcept()` ist die schliessende Haelfte von
 * `hqStreams.reconcile()` und wird von `HqStreamKeepAlive.svelte` direkt danach
 * aufgerufen. Das Oeffnen bleibt Sache von `WhepPlayer.svelte` (gated auf
 * `useNativePlayer` + `isPlayerAvailable()`) — die Kachel weiss, wann sie den
 * nativen Weg WILL; der Keep-Alive weiss nur, wann eine Kachel weg ist.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import { chatApi } from '$lib/api/chat';
import { hqStreams } from '$lib/stream/hqStreamManager.svelte';
import { getStreamVolume, setStreamVolume } from '$lib/stream/streamVolume';
import { loadAll, saveAll } from '$lib/stream/persistence';
import {
  closePlayer,
  focusPlayer,
  onPlayerEvent,
  onPlayerOptionEvent,
  onPlayerWindowRequest,
  openPlayer,
  setPlayerOptions,
  type PlayerStateEvent,
} from './client';

// ── Einstellungen (beide ohne UI, s. `pulse-stream.json`) ──────────────────

export const playerSettings = $state({
  /** Erlaubnis fuer das eigene Fenster ueberhaupt. Default aus. */
  useNativePlayer: false,
  /**
   * Nur 10-bit-Streams ins eigene Fenster lassen — der Zustand bis 2026-07-28.
   *
   * Damals war mehr als 8 bit der EINZIGE bekannte Vorteil, und der Rueckfall
   * ins `<video>` kostete scheinbar nichts. Inzwischen ist gemessen, dass er
   * doch etwas kostet, und zwar unabhaengig von der Bittiefe: ueber dieselbe
   * echte Leitung und an EINEM Sendedurchlauf lag der native Weg 30-47 ms vorn
   * (H.264 8 bit), und vor allem lief die Browser-Latenz IM Lauf weg
   * (177 -> 232 ms in rund 20 s, in drei von drei Laeufen), waehrend der native
   * Weg flach blieb. Dazu die GPU: Chromium nutzt auf Linux/NVIDIA kein NVDEC,
   * dieser Player schon.
   *
   * Deshalb steht das Tor jetzt fuer jeden Codec und jede Bittiefe offen. Der
   * Schalter bleibt als Rueckweg — ein Schalter ohne Rueckweg ist eine
   * Festlegung, keine Einstellung.
   *
   * **Bedingung, die dazugehoert und beim Oeffnen NICHT gemessen war** (am
   * 2026-07-28 nachgeholt, `verlust-2026-07-28-browser-gegen-nativ.json`): Die
   * Ueberlegenheit gilt fuer eine SAUBERE Leitung. Unter 1 % Paketverlust dreht
   * es sich um — der Browser verschlechtert sich gleichmaessig auf rund 85 ms,
   * der native Weg wird unberechenbar (Mediane 369 / 38 / 190 ms ueber drei
   * identische Laeufe, Ausschlag in jedem Lauf zwischen 366 und 539 ms). Grund:
   * nach jeder Luecke wartet der Decoder auf den naechsten Einstiegspunkt, und
   * der kommt nur alle zwei Sekunden; Chromium dekodiert stattdessen weiter.
   *
   * Heute ohne Folgen, weil `useNativePlayer` per Vorgabe aus ist und keine
   * Oberflaeche hat. Aber: **als Vorgabe fuer Zuschauer taugt der native Weg
   * nicht, solange das so ist.** Wer den Schalter je zur Vorgabe machen will,
   * muss vorher das Verhalten bei Verlust loesen.
   */
  onlyTenBit: false,
  loaded: false,
});

/** Einmalig: persistierte Einstellungen laden. Idempotent. */
export async function loadPlayerSettings(): Promise<void> {
  if (playerSettings.loaded) return;
  const data = await loadAll();
  if (typeof data.useNativePlayer === 'boolean') {
    playerSettings.useNativePlayer = data.useNativePlayer;
  }
  if (typeof data.nativePlayerOnlyTenBit === 'boolean') {
    playerSettings.onlyTenBit = data.nativePlayerOnlyTenBit;
  }
  playerSettings.loaded = true;
}

export function setUseNativePlayer(v: boolean): void {
  playerSettings.useNativePlayer = v;
  void saveAll({ useNativePlayer: v });
}

export function setNativePlayerOnlyTenBit(v: boolean): void {
  playerSettings.onlyTenBit = v;
  void saveAll({ nativePlayerOnlyTenBit: v });
}

// ── Anforderung „ins eigene Fenster" ────────────────────────────────────────

const keyOf = (channelId: string, userId: string, slot: number): string =>
  `${channelId}:${userId}:${slot}`;

/**
 * Welche Kacheln der Zuschauer ins eigene Fenster geschickt hat — je
 * *(channel, user, slot)*, wie bei `detachedStreams`.
 *
 * WARUM NEBEN `playerSettings.useNativePlayer`: Der Schalter ist eine
 * **Vorgabe für alle** Streams; das hier ist eine **Entscheidung fuer einen**.
 * Seit der Abkoppel-Knopf unter Electron das eigene Fenster oeffnet (statt
 * eines zweiten Chromium-Fensters), ist das der uebliche Weg — der Nutzer
 * waehlt pro Stream, nicht ein fuer alle Mal.
 *
 * Zurueckgenommen wird sie an zwei Stellen: beim `closed` der Sitzung (Fenster
 * zugemacht → Bild zurueck in die Kachel) und beim Schliessen-Knopf im Fenster
 * (dann zusaetzlich die Kachel weg). Ohne das Erste hing die Kachel dauerhaft
 * im Zustand `connecting` ohne Bild, obwohl Verbindung und Ton weiterliefen.
 */
const requests = new SvelteSet<string>();

/**
 * „Chat aufmachen" aus dem Player-Fenster — ein Zaehler je Stream.
 *
 * Ein Zaehler statt eines Ja/Nein: der Nutzer kann den Knopf mehrfach
 * druecken, und beim zweiten Mal muss die Kachel wieder reagieren. Ein `true`,
 * das schon `true` war, loest keinen Effect aus.
 */
const chatWuensche = new SvelteMap<string, number>();

export const nativeChatRequests = {
  /** Wie oft der Chat fuer diesen Stream angefordert wurde. */
  count(channelId: string, userId: string, slot = 0): number {
    return chatWuensche.get(keyOf(channelId, userId, slot)) ?? 0;
  },
  bump(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    chatWuensche.set(k, (chatWuensche.get(k) ?? 0) + 1);
  },
};

export const nativeWindowRequests = {
  has(channelId: string, userId: string, slot = 0): boolean {
    return requests.has(keyOf(channelId, userId, slot));
  },
  request(channelId: string, userId: string, slot = 0): void {
    requests.add(keyOf(channelId, userId, slot));
  },
  release(channelId: string, userId: string, slot = 0): void {
    requests.delete(keyOf(channelId, userId, slot));
  },
};

// ── Sitzung ─────────────────────────────────────────────────────────────────

export class NativePlayerSession {
  readonly channelId: string;
  readonly userId: string;
  readonly slot: number;

  phase = $state<PlayerStateEvent['state']>('connecting');
  error = $state<string | null>(null);
  /** Der Stream ist 8 bit — dafuer lohnt das eigene Fenster nicht, die Kachel
   *  bleibt beim `<video>`-Weg. KEIN Fehler: es wird nie ein Fenster geoeffnet,
   *  und der Aufrufer (`useNativePlayback`) schaltet still zurueck. */
  skipped = $state(false);

  // Bewusst KEINE Messwerte hier: Bildrate, Bitrate und alles andere zeigt das
  // Overlay IM Fenster (`streaming/pulse-player/src/overlay.rs`), das die Zahlen
  // ohne Umweg hat. Eine Abfrage von hier aus waere eine JSON-RPC-Runde durch
  // zwei Prozesse je Sekunde und Kachel — fuer Werte, die niemand anzeigt.

  #session: number | null = null;
  #unlisten: (() => void) | null = null;
  #unlistenOptions: (() => void) | null = null;
  #unlistenWindow: (() => void) | null = null;
  /**
   * Wird gerufen, wenn im Fenster „Schliessen" gedrueckt wurde — die Kachel
   * soll weg. Als Rueckruf statt eines Imports, damit dieses Modul nichts von
   * der Kachel-Registry wissen muss (und in Tests ohne sie laeuft).
   */
  onCloseTile: ((channelId: string, userId: string, slot: number) => void) | null = null;
  #disposed = false;

  constructor(channelId: string, userId: string, slot = 0, title?: string) {
    this.channelId = channelId;
    this.userId = userId;
    this.slot = slot;
    this.#unlisten = onPlayerEvent((ev) => this.#onEvent(ev));
    this.#unlistenOptions = onPlayerOptionEvent((ev) => this.#onOptionEvent(ev));
    this.#unlistenWindow = onPlayerWindowRequest((kind, session) => {
      if (session !== this.#session) return;
      if (kind === 'chat') {
        nativeChatRequests.bump(this.channelId, this.userId, this.slot);
        return;
      }
      // Schliessen: Anforderung zuruecknehmen UND die Kachel schliessen. Nur
      // Ersteres wuerde bei erzwungenem Fenster (10 bit) sofort ein neues
      // oeffnen — genau der Zustand, den dieser Knopf beheben soll. Die Kachel
      // schliesst `onCloseTile`, weil dieses Modul die Kachel-Registry nicht
      // kennen soll.
      nativeWindowRequests.release(this.channelId, this.userId, this.slot);
      this.onCloseTile?.(this.channelId, this.userId, this.slot);
    });
    void this.#open(title);
  }

  async #open(title?: string): Promise<void> {
    if (this.#disposed) return;
    this.phase = 'connecting';
    this.error = null;
    try {
      const { whep_url, ten_bit } = await chatApi.getWhepUrl(
        this.channelId,
        this.userId,
        this.slot,
      );
      if (this.#disposed) return;
      // Bis 2026-07-28 endete jeder 8-bit-Stream hier: mehr als 8 bit galt als
      // der einzige Grund fuer das eigene Fenster. Gemessen sind inzwischen zwei
      // weitere, die von der Bittiefe unabhaengig sind — Latenz und GPU
      // (Begruendung samt Zahlen bei `playerSettings.onlyTenBit`). Der Rueckweg
      // bleibt als Einstellung erhalten.
      //
      // Die Bittiefe reist trotzdem weiter in der WHEP-Antwort mit: waere sie
      // erst nach dem Dekodieren bekannt, muesste das Fenster schon offen sein,
      // um die Frage ueberhaupt stellen zu koennen.
      if (playerSettings.onlyTenBit && ten_bit !== true) {
        this.skipped = true;
        return;
      }
      // Der Player gibt den Ton aus, nicht die App — sonst liefe er doppelt
      // (s. `ManagedHqStream.nativeAudio`). Mit der Lautstärke starten, die für
      // diesen Streamer gespeichert ist, damit das Fenster nicht laut aufgeht.
      const session = await openPlayer(whep_url, {
        title,
        options: { volume: getStreamVolume(this.userId) / 100 },
        // Bei 10 bit gibt es kein Zurueck in die Kachel — Chromium legt seinen
        // Puffer immer als 8 bit an. Die Leiste im Fenster laesst den Knopf
        // dann weg, statt ihn ins Leere zeigen zu lassen.
        canReattach: ten_bit !== true,
      });
      if (this.#disposed) {
        if (session !== null) void closePlayer(session);
        return;
      }
      if (session === null) {
        this.phase = 'failed';
        this.error = 'native player: open fehlgeschlagen';
        return;
      }
      this.#session = session;
      this.#setAudioOwner(true);
    } catch (e) {
      if (this.#disposed) return;
      this.phase = 'failed';
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Ein Event ohne `session` (main-seitiger Prozessabsturz, siehe
   *  `player.ts`'s `exit`-Handler) betrifft JEDE offene Sitzung. */
  #onEvent(ev: PlayerStateEvent): void {
    if (this.#disposed) return;
    if (ev.session !== undefined && ev.session !== this.#session) return;
    this.phase = ev.state;
    if (ev.error) this.error = ev.error;
    if (ev.state === 'closed' || ev.state === 'failed') {
      // Fenster weg → der Ton muss zurück in die App, sonst ist der Stream
      // stumm (die Kachel fällt gleichzeitig auf den `<video>`-Weg zurück).
      this.#setAudioOwner(false);
    }
    if (ev.state === 'closed') {
      // Der Nutzer hat das Fenster zugemacht — das ist die Rücknahme der
      // Anforderung, und ohne sie bliebe die Kachel stumm dabei stehen: sie
      // zeigt absichtlich kein Bild, solange das Fenster zustaendig ist.
      // `failed` bleibt aussen vor, das faengt `useNativePlayback` als
      // Stoerfall ab (und merkt sich ihn bis zum naechsten Mount).
      nativeWindowRequests.release(this.channelId, this.userId, this.slot);
    }
  }

  /**
   * Im FENSTER geregelt: Wert übernehmen, damit er die Sitzung überlebt.
   *
   * Bewusst über den Manager: der hält den angezeigten Wert und schreibt ihn je
   * Streamer fort (`streamVolume.ts`). Zurück ins Fenster geht dabei nichts —
   * sonst entstünde eine Schleife aus Meldung und Antwort.
   */
  #onOptionEvent(ev: { session: number; volume?: number }): void {
    if (this.#disposed || ev.session !== this.#session || ev.volume === undefined) return;
    const percent = Math.round(ev.volume * 100);
    const mgr = hqStreams.get(this.channelId, this.userId, this.slot);
    if (mgr) mgr.setVolume(percent);
    else setStreamVolume(this.userId, percent);
  }

  /** Lautstärke ins Fenster (0-100 wie in der App, Verstärkung über 100 %
   *  eingeschlossen — der Player rechnet in 0..1+). */
  setVolume(percent: number): void {
    if (this.#session === null) return;
    void setPlayerOptions(this.#session, { volume: percent / 100 });
  }

  /** Fenster nach vorne holen (Knopf in der Kachel). */
  focus(): void {
    if (this.#session === null) return;
    void focusPlayer(this.#session);
  }

  /** Wer gibt den Ton aus — Fenster oder App? Genau einer von beiden. */
  #setAudioOwner(native: boolean): void {
    hqStreams.get(this.channelId, this.userId, this.slot)?.setNativeAudio(native);
  }

  close(): void {
    this.#disposed = true;
    this.#setAudioOwner(false);
    this.#unlisten?.();
    this.#unlisten = null;
    this.#unlistenOptions?.();
    this.#unlistenOptions = null;
    this.#unlistenWindow?.();
    this.#unlistenWindow = null;
    if (this.#session !== null) void closePlayer(this.#session);
    this.#session = null;
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

// **Reaktiv, und daran haengt die Abklemmung der Browser-Verbindung.**
// `HqStreamKeepAlive` entscheidet ueber `get(...)?.phase === 'playing'`, ob eine
// Kachel ihre WHEP-Verbindung behalten darf. Mit einer gewoehnlichen `Map` lief
// dieser Effect beim Mount, fand noch GAR KEINE Sitzung (die oeffnet der
// `WhepPlayer` erst danach) und las damit nie ein `phase` — also entstand auch
// keine Abhaengigkeit darauf. Ging das Fenster spaeter auf `playing`, lief er
// nie wieder, und die Verbindung blieb fuer immer offen. Genau das war am
// 2026-08-02 zu sehen: das Abklemmen war gebaut und wirkte trotzdem nicht.
// Mit `SvelteMap` weckt schon das EINFUEGEN der Sitzung den Effect, der dann
// `phase` liest und beim Wechsel auf `playing` erneut laeuft.
const registry = new SvelteMap<string, NativePlayerSession>();

/**
 * Wie oft eine Sitzung ersetzt werden darf, bevor `ensure` aufgibt — und in
 * welchem Zeitfenster gezaehlt wird.
 *
 * **Warum es diese Bremse gibt.** Das Ersetzen unten ist gewollt, aber es
 * ergibt zusammen mit einem aeusseren Schliesser eine Endlosschleife: schliessen
 * → ersetzen → oeffnen → schliessen. Am 2026-08-07 ist genau das passiert
 * (`HqStreamKeepAlive` schloss jedes Fenster zum EIGENEN Stream, weil es eine
 * fuer die Browser-Verbindung gefilterte Liste benutzte). Jede Runde holte eine
 * neue WHEP-Adresse vom Server und baute eine volle WebRTC-Verbindung auf; die
 * App war danach nur noch durch Beenden zu retten.
 *
 * Die Ursache ist behoben. Diese Bremse steht trotzdem hier, weil die Bauart
 * — „wer schliesst" und „wer oeffnet" sind absichtlich getrennt — dieselbe
 * Schleife jederzeit wieder hergeben kann. Aus einem Absturz der Bedienung
 * wird damit ein Rueckfall auf `<video>` samt Logzeile.
 */
const ERSATZ_MAX = 5;
const ERSATZ_FENSTER_MS = 10_000;

/** Je Kachel: Zeitpunkte der letzten Ersetzungen (s. [`ERSATZ_MAX`]). */
const ersetzt = new Map<string, number[]>();

/** `true`, wenn fuer diese Kachel gerade zu oft ersetzt wurde. */
function zuOftErsetzt(k: string, jetzt: number): boolean {
  const bisher = (ersetzt.get(k) ?? []).filter((t) => jetzt - t < ERSATZ_FENSTER_MS);
  bisher.push(jetzt);
  ersetzt.set(k, bisher);
  return bisher.length > ERSATZ_MAX;
}

export const nativePlayerSessions = {
  /**
   * Bestehende Sitzung holen oder neu anlegen (idempotent).
   *
   * Eine bereits gescheiterte oder geschlossene Sitzung wird dabei NICHT
   * wiederverwendet, sondern verworfen und ersetzt. Ohne das blieb eine tote
   * Sitzung dauerhaft in der Registry: der naechste Mount bekam sie zurueck,
   * setzte sofort wieder `nativeFailed` und die Kachel hing endgueltig im
   * `<video>`-Rueckfall fest — obwohl der Rueckfall ausdruecklich nur bis zum
   * naechsten Mount gelten soll.
   *
   * **Ausser es geht zu schnell hintereinander** — dann bleibt die tote Sitzung
   * liegen, und die Kachel faellt auf `<video>` zurueck (s. [`ERSATZ_MAX`]).
   */
  ensure(channelId: string, userId: string, slot = 0, title?: string): NativePlayerSession {
    const k = keyOf(channelId, userId, slot);
    let s = registry.get(k);
    if (s && (s.phase === 'failed' || s.phase === 'closed')) {
      if (zuOftErsetzt(k, Date.now())) {
        console.warn(
          `[player] Fenster fuer ${k} wurde ${ERSATZ_MAX}x in ${
            ERSATZ_FENSTER_MS / 1000
          }s geschlossen und neu geoeffnet — gebe auf, Rueckfall auf <video>.`,
        );
        return s;
      }
      void s.close();
      registry.delete(k);
      s = undefined;
    }
    if (!s) {
      s = new NativePlayerSession(channelId, userId, slot, title);
      registry.set(k, s);
    }
    return s;
  },

  get(channelId: string, userId: string, slot = 0): NativePlayerSession | null {
    return registry.get(keyOf(channelId, userId, slot)) ?? null;
  },

  close(channelId: string, userId: string, slot = 0): void {
    const k = keyOf(channelId, userId, slot);
    const s = registry.get(k);
    if (s) {
      s.close();
      registry.delete(k);
    }
  },

  /** Schliesst jede Sitzung, deren Schluessel NICHT in `wanted` steht — die
   *  schliessende Haelfte von `hqStreams.reconcile()`, ohne dessen oeffnende
   *  Haelfte: geoeffnet wird ausschliesslich vom `WhepPlayer`-Effect, gated auf
   *  `useNativePlayer` + `isPlayerAvailable()`. */
  closeExcept(wanted: { channelId: string; userId: string; slot: number }[]): void {
    const wantedKeys = new Set(wanted.map((w) => keyOf(w.channelId, w.userId, w.slot)));
    for (const k of [...registry.keys()]) {
      if (!wantedKeys.has(k)) {
        registry.get(k)!.close();
        registry.delete(k);
      }
    }
  },
};
