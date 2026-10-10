import type { ConnectionState } from 'livekit-client';
import { toast } from 'svelte-sonner';

import { m } from '$lib/paraglide/messages.js';
import {
  spracheKamera,
  spracheKameraSeite,
  spracheLautstaerken,
  spracheMikrofon,
  spracheTaub,
  spracheZustand
} from '$lib/platform/iosSprache';
import type { VoiceParticipant } from './livekit.svelte';

/** Was der native Weg am Voice-Store liest und schreibt — dessen öffentliche
 *  Felder und Befehle. */
export interface NativerWirt {
  state: ConnectionState;
  error: string | null;
  micEnabled: boolean;
  deafened: boolean;
  isCameraOn: boolean;
  cameraFacing: 'user' | 'environment';
  participants: VoiceParticipant[];
  localSpeaking: boolean;
  audioBlocked: boolean;
  audioBlockGrund: string;
  channelId: string | null;
  channelName: string | null;
  toggleMic(): void;
  toggleDeafen(): void;
  disconnect(opts: { reason?: 'user' }): Promise<void>;
}

/** Die privaten Haken des Voice-Stores, die der native Weg braucht. */
export interface NativeHaken {
  /** Stand an den Gateway melden UND den Eintrag fürs Wiederaufnehmen
   *  schreiben (`#publishSelfState`). */
  melden(): void;
  /** Alles abräumen wie nach einem Abbruch (`#teardown`). */
  abbauen(): void;
  wachHalten(): void;
  vorTaubSetzen(mikroVorher: boolean): void;
  /** Gehört dieser Beitritt noch dem Store (`gen === #connectGen`)? */
  aktuell(gen: number): boolean;
}

/**
 * Die Befehle des nativen Wegs an die Hülle — Mikrofon, Taub, Kamera,
 * Lautstärken. Abgespalten aus `nativerRaum.svelte.ts` (Grössen-Policy,
 * `PLAN.md` §12.1); dort steht, wann ein Raum steht, hier, was man in ihm
 * schaltet. **Ohne Runes** — die Datei ist schlichtes `.ts` (s. CLAUDE.md:
 * eine Rune ausserhalb von `.svelte(.ts)` reisst zur Laufzeit die Route ab).
 */
export class NativeBefehle {
  #wirt: NativerWirt;
  #haken: NativeHaken;
  /** Nur die Antwort des JÜNGSTEN Mikrofon-Befehls zählt — eine ältere,
   *  später eintreffende überschriebe sonst den neueren Wunsch. */
  #mikroGen = 0;
  #lautWunsch: { je: Record<string, number>; gesamt: number } | null = null;
  #lautLaeuft = false;

  constructor(wirt: NativerWirt, haken: NativeHaken) {
    this.#wirt = wirt;
    this.#haken = haken;
  }

  /**
   * Mikrofon schalten.
   *
   * **Scheitert die Hülle, gilt danach ihr Stand, nicht der Wunsch.** Bis zum
   * 2026-10-11 blieb `micEnabled` auf dem Wunsch, und der Gateway meldete
   * allen ein offenes Mikrofon, das niemand hörte (Bughunt E3) — im Simulator
   * belegt (`-4010`), am Gerät die verweigerte Erlaubnis.
   */
  async mikrofon(on: boolean): Promise<void> {
    const w = this.#wirt;
    const gen = ++this.#mikroGen;
    const vorher = w.micEnabled;
    w.micEnabled = on;
    try {
      const z = await spracheMikrofon(on);
      if (gen === this.#mikroGen && z) w.micEnabled = z.mikro;
    } catch (e) {
      console.error('[Sprache] Mikrofon schalten fehlgeschlagen', e);
      if (gen !== this.#mikroGen) return;
      const z = await spracheZustand().catch(() => null);
      w.micEnabled = z?.mikro ?? vorher;
      w.error = m.livekit_microphone_access_failed();
      toast.error(m.livekit_microphone_access_failed());
    }
    // Ohne diese Meldung erfährt der Gateway nichts — die anderen sähen ein
    // falsches Stumm-Zeichen. Die eigene Kachel kommt über `teilnehmer`.
    if (gen === this.#mikroGen) this.#haken.melden();
  }

  /** Mithören aus. Die `<audio>`-Elemente des Web-Wegs gibt es hier nicht —
   *  das Stellen der Lautstärken übernimmt die Hülle. */
  taub(on: boolean): void {
    void spracheTaub(on).catch((e: unknown) => {
      console.error('[Sprache] Taubstellen fehlgeschlagen', e);
    });
  }

  async kamera(on: boolean): Promise<void> {
    const w = this.#wirt;
    const vorher = w.isCameraOn;
    w.isCameraOn = on;
    const z = await spracheKamera(on).catch((e: unknown) => {
      // Laut scheitern: sonst sieht der Knopf geschaltet aus, und es kommt
      // kein Bild.
      console.error('[Sprache] Kamera schalten fehlgeschlagen', e);
      w.isCameraOn = vorher;
      if (e instanceof Error) toast.error(m.livekit_camera_failed(), { description: e.message });
      return null;
    });
    if (z?.kamera !== undefined) w.isCameraOn = z.kamera;
  }

  /** Front ↔ Rück. Die Hülle stellt den Aufnehmer um, ohne neu zu
   *  veröffentlichen — dieselbe Absicht wie `restartTrack` im Web-Weg. */
  async kameraWechseln(): Promise<void> {
    const w = this.#wirt;
    const z = await spracheKameraSeite(w.cameraFacing !== 'user').catch((e: unknown) => {
      console.error('[Sprache] Kamera wechseln fehlgeschlagen', e);
      if (e instanceof Error) toast.error(m.livekit_camera_failed(), { description: e.message });
      return null;
    });
    if (z?.kameraVorn !== undefined) w.cameraFacing = z.kameraVorn ? 'user' : 'environment';
  }

  /**
   * Lautstärke je Nutzer und gesamt an die Hülle (Bughunt M4 — die Regler
   * gingen bis dahin an `<audio>`-Elemente, die es hier nicht gibt).
   *
   * **Höchstens ein Befehl unterwegs, der letzte Wunsch gewinnt.** Ein Regler
   * feuert beim Ziehen Dutzende Male pro Sekunde, und die Brücke ist EINE
   * serielle Warteschlange — ihre Verstopfung hat am 2026-10-10 die App
   * einfrieren lassen. Eine ältere Hülle kennt den Befehl nicht; das wird
   * geschluckt, der Regler tut dort dann eben nichts (wie bisher).
   */
  lautstaerken(je: Record<string, number>, gesamt: number): void {
    this.#lautWunsch = { je, gesamt };
    if (!this.#lautLaeuft) void this.#lautSenden();
  }

  async #lautSenden(): Promise<void> {
    this.#lautLaeuft = true;
    try {
      while (this.#lautWunsch) {
        const wunsch = this.#lautWunsch;
        this.#lautWunsch = null;
        await spracheLautstaerken(wunsch.je, wunsch.gesamt).catch(() => undefined);
      }
    } finally {
      this.#lautLaeuft = false;
    }
  }
}
