/**
 * Gemeinsame Pegel-Ballistik für alle Mikrofon-Meter (Eingangstest
 * `micTest.svelte.ts`, Sendemeter in `livekit.svelte.ts`, Lokal-Analyser
 * `localMicAnalyser.ts`). Reine Funktionen plus ein winziger Clip-Hold —
 * kein AudioContext-/Analyser-Handling, das bleibt bei den Verbrauchern.
 */

/** Unter dieser Amplitude ist alles Stille (−74 dBFS) — Meter bleibt auf 0. */
const SILENCE_THRESHOLD = 0.0005;

/** Decay des geglätteten RMS-Balkens je Frame (~250 ms Halbwertzeit @ 60 fps),
 *  damit der Balken nicht zwischen Silben strobt. */
export const LEVEL_DECAY = 0.85;

/** Decay der Peak-Hold-Linie je Frame (~800 ms Halbwertzeit), damit man
 *  ablesen kann, wo das lauteste Sample war. */
export const PEAK_DECAY = 0.97;

/** Clip ab roher Peak-Amplitude > ~−1 dBFS. */
export const CLIP_PEAK_THRESHOLD = 0.891;

/** Wie lange ein einzelner Clip-Peak sichtbar bleibt (ms). */
export const CLIP_HOLD_MS = 300;

/**
 * dBFS-Ballistik: mappt rohe 0..1-Amplitude auf einen −50..−5-dBFS-Balken
 * (0..1) — Mikrofonpegel sind logarithmisch wahrnehmbar, linearer RMS blieb
 * alles am unteren Ende gebündelt. Instant attack (Sprung nach oben), sonst
 * exponentielles Abklingen Richtung neuer Pegel mit `decay` je Frame.
 */
export function ballistics(raw: number, current: number, decay: number): number {
  let level = 0;
  if (raw > SILENCE_THRESHOLD) {
    const db = 20 * Math.log10(raw);
    level = Math.max(0, Math.min(1, (db + 50) / 45));
  }
  return level > current ? level : current * decay + level * (1 - decay);
}

/**
 * Clip-Hold mit 300-ms-Nachleuchten, damit ein einzelnes Knacken sichtbar
 * bleibt. Die Uhr wird nur gelesen, während ein Clip aktiv oder gerade
 * beginnt — der häufige leise Frame überspringt den Zeitstempel ganz.
 */
export class ClipHold {
  #untilMs = 0;
  #clipping = false;

  update(peak: number, now: number): boolean {
    if (peak >= CLIP_PEAK_THRESHOLD) {
      this.#untilMs = now + CLIP_HOLD_MS;
      this.#clipping = true;
    } else if (this.#clipping && now >= this.#untilMs) {
      this.#clipping = false;
    }
    return this.#clipping;
  }

  /** Whether the lamp currently burns (reset without re-firing the callback). */
  get clipping(): boolean {
    return this.#clipping;
  }

  reset(): void {
    this.#untilMs = 0;
    this.#clipping = false;
  }
}

/** RMS einer Time-Domain-Sonde (0..1-Amplitude). */
export function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}
