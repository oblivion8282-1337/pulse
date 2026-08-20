/**
 * Werte-Katalog der Stream-Einstellungen — Codec-/Auflösungs-/Ton-Listen und
 * die reinen Helfer darauf.
 *
 * Aus `settings.svelte.ts` herausgelöst, weil hier nichts vom Zustand abhängt:
 * keine Runes, kein Sidecar, keine Persistenz. Die Datei ist die gemeinsame
 * Grundlage, die sowohl der Zustand (`settingsState.svelte.ts`) als auch die
 * Quellenwahl (`captureSource.ts`) braucht — sie zuunterst zu halten ist das,
 * was den Import-Ring zwischen den dreien verhindert.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type AudioMode = 'Aus' | 'Desktop' | 'Mikrofon' | 'Desktop + Mikrofon';

export interface OverrideSet {
  codec?: string;
  /** Farbtiefe je Kanal: 8 (Standard) oder 10. Nur der Linux-Rust-Sidecar
   *  versteht das Feld und nur mit AV1 — ältere Sidecars ignorieren es
   *  stillschweigend, und der Linux-Sidecar schiebt einen unerfüllbaren Wunsch
   *  selbst auf 8 bit zurück. Deshalb ist es hier ungefährlich mitzuschicken.
   *  In der Oberfläche ist es mit dem Codec zu EINEM Feld verbunden, s.
   *  [`VIDEO_MODES`]. */
  bit_depth?: number;
  bitrate_kbps?: number;
  fps?: number;
  resolution?: string;
  /**
   * Rollender Intra-Refresh statt periodischer Vollbilder. Fehlt das Feld,
   * entscheidet der Sidecar über `PULSE_INTRA_REFRESH` — deshalb wird es nur
   * gesetzt, wenn die Oberfläche wirklich eine Wahl getroffen hat.
   */
  intra_refresh?: boolean;
  /**
   * HDR senden — der Bildschirminhalt wird in seinem vollen Helligkeitsumfang
   * aufgenommen und als PQ/BT.2020 encodiert.
   *
   * **Anders als `bit_depth` kein Wunsch, der still zurückgenommen wird.**
   * Kann der Sidecar HDR nicht liefern — Schirm läuft in SDR, falscher Codec,
   * falscher Encode-Weg —, bricht er den Start mit einer Meldung ab. Das ist
   * Absicht: 10 bit weniger als bestellt sieht man höchstens an einem Verlauf,
   * SDR statt HDR sieht man am ganzen Bild.
   *
   * Setzt 10 bit voraus (PQ in 8 bit wäre in jedem Verlauf geringelt) und
   * damit AV1; die Oberfläche erzwingt beides beim Anhaken.
   */
  hdr?: boolean;
}

// Hard caps for the HQ-stream bitrate. MediaMTX fans out WHEP copies to every
// viewer, so an unbounded value can saturate the VPS uplink very fast.
export const HQ_BITRATE_MIN_KBPS = 1000;
export const HQ_BITRATE_MAX_KBPS = 10_000;

// Codec values the GSR `-k` flag accepts. The UI only offers H.264 (universal
// browser compat) and AV1 (~half the bitrate at the same quality); the sidecar
// still understands the HEVC / 10-bit / HDR variants, we just don't surface
// them (this also matches the Flatpak GSR build, which only ships h264 + av1).
export const CODEC_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'av1', label: 'AV1' },
];

/**
 * Was im Codec-Feld steht. Codec, Bittiefe und HDR sind für den Nutzer EINE
 * Entscheidung — mehrere Felder daraus zu machen hiesse, ihm Kopplungen zu
 * erklären, die der Sidecar ohnehin erzwingt: 10 bit gibt es nur mit AV1 (die
 * H.264-Variante wäre `High 10`, die kein Browser dekodiert), und HDR gibt es
 * nur mit 10 bit (PQ in 8 bit wäre in jedem Verlauf sichtbar geringelt,
 * `encode/hdr.rs`).
 *
 * **HDR war bis zum 2026-08-07 ein eigenes Kästchen**, das beim Anhaken das
 * Codec-Feld von sich aus auf „AV1 10 bit" zog. Das ist derselbe Fall, den die
 * Bittiefe am 2026-08-02 schon hatte, und er wird hier aus demselben Grund
 * gleich gelöst: **zwei gekoppelte Bedienelemente zu erklären ist mehr Aufwand
 * als eine Liste, in der die unmögliche Kombination gar nicht vorkommt.** Ein
 * Kästchen, das ein anderes Feld umstellt, ist eine Fernwirkung, die niemand
 * erwartet.
 *
 * `bit_depth` geht nur bei 10 mit auf die Leitung, `hdr` nur bei `true`. Ein
 * `bit_depth: 8` bzw. `hdr: false` wäre gleichbedeutend mit „fehlt", würde aber
 * in jeder persistierten Einstellung mitgeschleppt.
 */
export const VIDEO_MODES: ReadonlyArray<{
  value: string;
  label: string;
  codec: string;
  tenBit: boolean;
  hdr?: boolean;
}> = [
  { value: 'h264', label: 'H.264', codec: 'h264', tenBit: false },
  { value: 'av1', label: 'AV1 8 bit', codec: 'av1', tenBit: false },
  { value: 'av1-10', label: 'AV1 10 bit', codec: 'av1', tenBit: true },
  { value: 'av1-10-hdr', label: 'AV1 10 bit HDR', codec: 'av1', tenBit: true, hdr: true },
];

/** Welcher Eintrag zu den aktuellen Overrides passt. */
export function videoModeOf(o: OverrideSet): string {
  const codec = o.codec ?? 'h264';
  if (codec !== 'av1' || o.bit_depth !== 10) return codec;
  return o.hdr === true ? 'av1-10-hdr' : 'av1-10';
}

/**
 * Auswahl zurück in Codec, Bittiefe und HDR übersetzen.
 *
 * **`hdr` wird bei jedem anderen Eintrag ENTFERNT**, nicht bloss nicht gesetzt.
 * Sonst überlebte ein `hdr: true` den Wechsel auf H.264 in der gespeicherten
 * Einstellung, und der Sidecar bräche den Start ab („HDR verlangt, aber H.264
 * kann hier kein 10 bit") — für eine Kombination, die der Nutzer im Feld gar
 * nicht mehr sieht.
 */
export function applyVideoMode(o: OverrideSet, value: string): OverrideSet {
  const mode = VIDEO_MODES.find((m) => m.value === value) ?? VIDEO_MODES[0];
  const next: OverrideSet = { ...o, codec: mode.codec };
  if (mode.tenBit) next.bit_depth = 10;
  else delete next.bit_depth;
  if (mode.hdr) next.hdr = true;
  else delete next.hdr;
  return next;
}

// Eine Stufe ist eine BOX, in die das Bild aspektwahrend eingepasst wird — NIE
// hochskaliert (`fit_within_box` im Sidecar), 'Native' = gar nicht skalieren.
// Eine Box größer als die Quelle bewirkt darum nichts; welche Stufen für die
// gewählte Quelle wirklich verkleinern, filtert `resolution.ts` für die UI.
export const RESOLUTION_VALUES: ReadonlyArray<string> = [
  'Native',
  '4K',
  '1440p',
  '1080p',
  '720p',
  '480p',
];

// Resolution ordering is descending in size (index 0 = biggest, 'Native' =
// uncapped source). The admin-set ``hq_resolution_max`` is a *ceiling*: only
// values at or below it (index >= its index) are allowed. 'Native' as a max
// means "no cap". Helpers below back both the admin/stream UI (filter the
// option list) and buildStartArgs (clamp a chosen value).

/** The resolutions allowed under a given ceiling (max first → smallest). */
export function allowedResolutions(maxRes: string): ReadonlyArray<string> {
  const maxIdx = RESOLUTION_VALUES.indexOf(maxRes);
  if (maxIdx < 0) return RESOLUTION_VALUES; // unknown ceiling → don't filter
  return RESOLUTION_VALUES.filter((_, i) => i >= maxIdx);
}

/** Clamp a chosen resolution down to the ceiling (bigger choices → the max). */
export function clampResolution(res: string, maxRes: string): string {
  const maxIdx = RESOLUTION_VALUES.indexOf(maxRes);
  const idx = RESOLUTION_VALUES.indexOf(res);
  if (maxIdx < 0 || idx < 0) return res;
  return idx >= maxIdx ? res : maxRes;
}

// ── Bildraten-Stufen ────────────────────────────────────────────────────────

/**
 * Die Bildraten-Stufen des FPS-Felds (bis 2026-08-20 ein Freifeld).
 *
 * **25 gehört hinein, auch wenn es im Produktionsbetrieb selten ist:**
 * PAL-Material (europäisches TV, ältere Aufnahmen) läuft mit 25 Bildern/s —
 * wer das streamen will, hatte sonst keine passende Stufe.
 *
 * Die Liste endet bei **144**, nicht bei 165/240: über 144 hinaus gibt es
 * keine Kombination mehr, die auf Zuschauer-Seite verlässlich ankommt (s. die
 * Last-Grenze unten), und Monitore mit mehr Takt streamen ohnehin mit
 * Quell-Raten, die kein gewöhnlicher Decoder mitnimmt.
 */
export const FPS_VALUES: ReadonlyArray<number> = [25, 30, 60, 90, 120, 144];

/**
 * Was „Standard" im FPS-Feld bedeutet: die Vorgabe der Sidecars, wenn die
 * Oberfläche `fps` nicht mitgibt. Alle vier Sidecars stehen auf 60
 * (`gsr-sidecar/profiles.py`, `linux-hq-sidecar/src/profiles.rs`,
 * `win-hq-sidecar/src/profiles.rs`, macOS analog) — deshalb trägt das
 * Etikett die Zahl.
 *
 * Die Vorgabe wird wie eine Stufe GEPRÜFT, nicht automatisch durchgewinkt:
 * wäre 60 in der gewählten Kombination nicht erlaubt (4K in 10 bit), fällt
 * der „Standard"-Eintrag weg und der Wert wird auf die höchste erlaubte
 * Stufe festgenagelt. Sonst wäre die Vorgabe der einzige Weg, die Last-Grenze
 * unbemerkt zu unterlaufen.
 */
export const FPS_STANDARD = 60;

/**
 * Last-Grenze für 10 bit: Auflösung × Bildrate in Bildpunkten je Sekunde.
 *
 * **Warum es sie gibt (Vorfall 2026-08-20):** 2560×1440 bei 144 Bildern/s in
 * AV1 8 bit lief bei einem Zuschauer auf Linux/AMD problemlos — dieselbe
 * Kombination in 10 bit brachte die Videoeinheit seiner GPU zum Hängen
 * (Kernel-Reset des Videorings; auf älterem Treiberunterbau stirbt dabei der
 * ganze Player-Prozess). Die Decoder-Hardware gewöhnlicher Karten ist auf
 * etwa „4K60" (~500 Mpix/s) ausgelegt, und 10 bit kostet die Einheit das
 * 1,5- bis 2-fache an Zyklen pro Bildpunkt — der Strom war also effektiv bei
 * 800–1000 Mpix/s angekommen. Der Sender kann die Zuschauer-Hardware nicht
 * kennen; die einzige Stelle, an der sich das verhindern lässt, ist die
 * Auswahl im Editor.
 *
 * **Warum ~300:** die Hälfte der Faustregel-Decke. Sie lässt 1080p bis 144
 * (299 Mpix/s) und 1440p bis 60 (221) zu, sperrt aber genau die Kombination,
 * die den Vorfall machte (1440p×144 = 531). Es ist eine bewusst grobe,
 * konservative Zahl aus einem gemessenen Fall — die saubere Lösung wäre
 * messen statt raten (Lastmessung im Player), bis es die gibt, grenzt dieser
 * Wert das Risiko ein.
 *
 * In 8 bit wird NICHT begrenzt: derselbe Strom lief in 8 bit durch, und
 * H.264 ist auf jeder Karte der billige Weg.
 */
export const HQ_TEN_BIT_MAX_PIXELS_PER_SEC = 300_000_000;

/** Größe, die bei der gewählten Auflösung tatsächlich gesendet wird.
 *  `null` = unbekannt (Linux-Portal: Quelle steht erst beim Start fest) —
 *  dann bleibt die Last unbestimmt und die Liste ungeschmälert; das Netz
 *  ist die Begrenzung im Sidecar (`lastgrenze`), der die echte Größe nach
 *  der Portal-Verhandlung kennt. */
export type SendSize = { width: number; height: number } | null;

/** Ist diese Bildrate in dieser Kombination erlaubt? */
export function fpsAllowed(
  fps: number,
  tenBit: boolean,
  size: SendSize,
  min: number,
  max: number,
): boolean {
  if (fps < min || fps > max) return false;
  if (!tenBit || !size) return true;
  return size.width * size.height * fps <= HQ_TEN_BIT_MAX_PIXELS_PER_SEC;
}

/**
 * Die anbietbaren Stufen — erst nach Instanz-/Community-Grenzen, dann nach
 * der Last-Grenze.
 *
 * **Die Liste ist nie leer.** Leert die Last-Grenze alles (Riesenquelle in
 * 10 bit — selbst 25 Bilder/s bleiben über der Grenze), bleibt die kleinste
 * stufen-gültige Stufe stehen: ein leeres Dropdown wäre schlimmer als eine
 * offiziell langsame Wahl, und die Grenze ist eine Führung, kein Verbot —
 * wer bei 5K in 10 bit streamen will, hat ein anderes Problem als die
 * Bildrate.
 */
export function allowedFpsSteps(
  tenBit: boolean,
  size: SendSize,
  min: number,
  max: number,
): ReadonlyArray<number> {
  const nachGrenzen = FPS_VALUES.filter((f) => f >= min && f <= max);
  // Auch die Admin-Grenzen können alles streichen (min über der höchsten
  // Stufe) — der Boden gilt darum schon hier, nicht erst nach der Last-Grenze.
  const mitBoden = nachGrenzen.length ? nachGrenzen : [FPS_VALUES[0]];
  if (!tenBit || !size) return mitBoden;
  const nachLast = mitBoden.filter((f) => fpsAllowed(f, true, size, min, max));
  return nachLast.length ? nachLast : [mitBoden[0]];
}

/**
 * Eine gespeicherte Bildrate auf die Stufenliste biegen. Die größte erlaubte
 * Stufe UNTER dem bisherigen Wert — wer 144 gewählt hatte und auf 10 bit/1440p
 * wechselt, landet auf 60, nicht auf 25; wer 25 (PAL) gewählt hatte, behält
 * 25. Gibt es keine kleinere, die kleinste erlaubte (der Wert war zu NIEDRIG
 * für die Grenzen, also wird angehoben).
 */
export function snapFps(current: number, steps: ReadonlyArray<number>): number {
  if (steps.includes(current)) return current;
  // Die Stufenliste ist aufsteigend: die letzte Stufe UNTER dem Wert ist
  // zugleich die größte.
  const darunter = steps.findLast((f) => f < current);
  return darunter ?? steps[0];
}

export const AUDIO_MODES: ReadonlyArray<AudioMode> = [
  'Aus',
  'Desktop',
  'Mikrofon',
  'Desktop + Mikrofon',
];



/** Prefix the sidecar uses to recognise "capture this app's audio" — the
 *  on-the-wire `audio.mode` for app capture is `"App: <name>"`, which the
 *  sidecar maps to GSR's `-a "app:<name>"`. (Mirrors `APP_LABEL_PREFIX` in
 *  `streaming/gsr-sidecar/profiles.py`.) */
export const APP_AUDIO_PREFIX = 'App: ';

/** Prefix for a per-monitor capture source. The on-the-wire `capture` value is
 *  `"Monitor: <index>"` (1-based); the Windows sidecar resolves it via
 *  `Monitor::from_index` (see `ops/start.rs::parse_capture`). Windows-only —
 *  on Linux `capture_source` stays `'portal'` (the Wayland portal dialog picks
 *  the screen). */
export const MONITOR_CAPTURE_PREFIX = 'Monitor: ';
/** capture_source token for a single window (Windows + macOS): `window:<id>`
 *  — id is the HWND on Windows, the CoreGraphics window id on macOS. */
export const WINDOW_CAPTURE_PREFIX = 'window:';

export function isAppAudioMode(mode: string): boolean {
  return mode.startsWith(APP_AUDIO_PREFIX);
}

export function appFromAudioMode(mode: string): string {
  return isAppAudioMode(mode) ? mode.slice(APP_AUDIO_PREFIX.length) : '';
}

export function audioModeUsesDesktop(mode: string): boolean {
  return mode === 'Desktop' || mode === 'Desktop + Mikrofon';
}

/** True iff the GPU's reported `video_codecs` mention AV1 (i.e. AV1 encode is
 *  available). Heuristic: any codec string containing "av1", case-insensitive.
 *  Each sidecar reports the *actual* hardware codec set (Linux GSR, Windows
 *  adapter probe, macOS VideoToolbox), so this gates the codec choice to what
 *  the machine can really encode — RTX 40xx/M3+ get AV1, older GPUs / M2 don't. */
export function gpuHasAv1(codecs: ReadonlyArray<string> | undefined): boolean {
  return (codecs ?? []).some((c) => /av1/i.test(c));
}
