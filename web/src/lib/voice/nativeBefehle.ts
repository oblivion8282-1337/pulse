import type { ConnectionState } from 'livekit-client';
import { toast } from 'svelte-sonner';

import { m } from '$lib/paraglide/messages.js';
import { KeineAntwort } from '$lib/platform/brueckenFrist';
import {
  spracheKamera,
  spracheKameraSeite,
  spracheLautstaerken,
  spracheMikrofon,
  spracheTaub,
  spracheZustand
} from '$lib/platform/iosSprache';
import { LetzterWunsch } from './letzterWunsch';
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

/** Unter die Fehlermeldung: dass die Hülle schwieg, statt abzulehnen. */
function fristText(e: unknown): string | undefined {
  return e instanceof KeineAntwort ? m.livekit_native_no_answer() : undefined;
}

/**
 * Die Befehle des nativen Wegs an die Hülle — Mikrofon, Taub, Kamera,
 * Lautstärken. Abgespalten aus `nativerRaum.svelte.ts` (Grössen-Policy,
 * `PLAN.md` §12.1); dort steht, wann ein Raum steht, hier, was man in ihm
 * schaltet. **Ohne Runes** — die Datei ist schlichtes `.ts` (s. CLAUDE.md:
 * eine Rune ausserhalb von `.svelte(.ts)` reisst zur Laufzeit die Route ab).
 *
 * **Wo die Kette liegt, die hängen kann.** Hier wartet nur die Lautstärke auf
 * ihre Vorgängerin (`LetzterWunsch`); die übrigen Befehle laufen in diesem
 * Modul unabhängig voneinander. In EINE Reihe stellt sie die Hülle
 * (`SpracheRaum.nacheinander`): bleibt dort ein Schritt im SDK stecken,
 * wartet jeder spätere Befehl mit — Stummschalten inklusive. Jeder Ruf trägt
 * deshalb eine Frist (`iosSprache.ts` → `brueckenFrist.ts`); danach gilt er
 * als gescheitert, und hier steht, was dann sichtbar wird.
 */
export class NativeBefehle {
  #wirt: NativerWirt;
  #haken: NativeHaken;
  /** Nur die Antwort des JÜNGSTEN Mikrofon-Befehls zählt — eine ältere,
   *  später eintreffende überschriebe sonst den neueren Wunsch. */
  #mikroGen = 0;
  /** Wie `#mikroGen`, für das Taubstellen. */
  #taubGen = 0;
  #laut = new LetzterWunsch<{ je: Record<string, number>; gesamt: number }>((w) =>
    spracheLautstaerken(w.je, w.gesamt).catch((e: unknown) => {
      // Ohne Hinweis am Bildschirm: was der Regler bewirkt, hört man selbst,
      // und beim Ziehen kämen die Meldungen im Takt der Frist. Die Konsole
      // landet im Diagnose-Gedächtnis (`diagnose/konsole.ts`).
      console.error('[Sprache] Lautstärken setzen fehlgeschlagen', e);
    })
  );

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
      toast.error(m.livekit_microphone_access_failed(), { description: fristText(e) });
    }
    // Ohne diese Meldung erfährt der Gateway nichts — die anderen sähen ein
    // falsches Stumm-Zeichen. Die eigene Kachel kommt über `teilnehmer`.
    if (gen === this.#mikroGen) this.#haken.melden();
  }

  /**
   * Mithören aus. Die `<audio>`-Elemente des Web-Wegs gibt es hier nicht —
   * das Stellen der Lautstärken übernimmt die Hülle.
   *
   * **Scheitert es, gilt der Stand der Hülle, und es wird gesagt** — dieselbe
   * Regel wie beim Mikrofon. Bis zum 2026-10-11 stand hier nur eine Zeile in
   * der Konsole — scheiterte der Ruf, blieb das Zeichen auf „taub", der
   * Gateway meldete es allen, und gehört wurde weiter alles. Genau das Bild,
   * gegen das das Taubstellen auf die Brücke kam (`spracheTaub`).
   */
  taub(on: boolean): void {
    const gen = ++this.#taubGen;
    void spracheTaub(on).catch(async (e: unknown) => {
      console.error('[Sprache] Taubstellen fehlgeschlagen', e);
      if (gen !== this.#taubGen) return;
      toast.error(m.livekit_deafen_failed(), { description: fristText(e) });
      const z = await spracheZustand().catch(() => null);
      const w = this.#wirt;
      if (gen !== this.#taubGen || z?.taub === undefined || z.taub === w.deafened) return;
      w.deafened = z.taub;
      this.#haken.melden();
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
      if (e instanceof Error) {
        toast.error(m.livekit_camera_failed(), { description: fristText(e) ?? e.message });
      }
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
      if (e instanceof Error) {
        toast.error(m.livekit_camera_failed(), { description: fristText(e) ?? e.message });
      }
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
   * einfrieren lassen (`LetzterWunsch`). Eine Hülle, die den Befehl nicht
   * kennt, kommt hier nicht mehr an: die Weiche lässt sie beim Web-Weg.
   */
  lautstaerken(je: Record<string, number>, gesamt: number): void {
    this.#laut.wuenschen({ je, gesamt });
  }
}
