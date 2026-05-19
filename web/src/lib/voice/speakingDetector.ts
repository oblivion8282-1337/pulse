/**
 * Hysteresis-Speaking-State-Machine. Linear-RMS-Samples reinfeeden, gefiltertes
 * boolean kommt via Callback raus.
 *
 * Schwellen in dBFS — Idee ist "Ring an = Listener hört wirklich was". Trigger
 * deshalb knapp über dem Opus-Decoder-Noise-Floor (digital-silente Pakete
 * landen bei ≤ -80 dBFS), nicht am Gate-Threshold orientiert: ein User der
 * sein Gate tief setzt oder Makeup auf 1× lässt sendet hörbares Sprechen bei
 * -50 dBFS, und das soll auslösen. Release noch weiter unten + Hold gegen
 * Wort-Lücken-Flackern.
 */
const DEFAULT_ON_DB = -55;
const DEFAULT_OFF_DB = -65;
const DEFAULT_HOLD_MS = 300;

export class SpeakingDetector {
  #onDb: number;
  #offDb: number;
  #holdMs: number;
  #onChange: (s: boolean) => void;
  #speaking = false;
  #lastAboveMs = 0;

  constructor(
    onChange: (s: boolean) => void,
    onDb: number = DEFAULT_ON_DB,
    offDb: number = DEFAULT_OFF_DB,
    holdMs: number = DEFAULT_HOLD_MS
  ) {
    this.#onChange = onChange;
    this.#onDb = onDb;
    this.#offDb = offDb;
    this.#holdMs = holdMs;
  }

  feed(rms: number): void {
    const db = rms > 0.0001 ? 20 * Math.log10(rms) : -120;
    const now = performance.now();
    if (this.#speaking) {
      if (db >= this.#offDb) this.#lastAboveMs = now;
      else if (now - this.#lastAboveMs > this.#holdMs) this.#set(false);
    } else if (db >= this.#onDb) {
      this.#lastAboveMs = now;
      this.#set(true);
    }
  }

  reset(): void {
    if (this.#speaking) this.#set(false);
    this.#lastAboveMs = 0;
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  #set(s: boolean): void {
    this.#speaking = s;
    this.#onChange(s);
  }
}
