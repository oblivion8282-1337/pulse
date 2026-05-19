/**
 * Hysteresis-Speaking-State-Machine. Linear-RMS-Samples reinfeeden, gefiltertes
 * boolean kommt via Callback raus.
 *
 * Schwellen in dBFS, weil das Signal logarithmisch wahrgenommen wird — und die
 * Idee ist "lampe leuchtet wenn was hörbar durchgeht": Trigger sitzt ~5 dB
 * über der RNNoise-Gate-Default-Schwelle (-45 dB), Release deutlich darunter
 * + Hold gegen Wort-Lücken-Flackern.
 */
const DEFAULT_ON_DB = -40;
const DEFAULT_OFF_DB = -55;
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
