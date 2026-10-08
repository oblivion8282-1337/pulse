/**
 * Welche Audio-Betriebsart die App gerade braucht — die reine Entscheidung.
 *
 * **Warum es überhaupt eine Entscheidung gibt:** Auf iOS gibt es EINE
 * Audio-Session je Prozess, aber zwei Verbraucher — ein Sprachkanal
 * (Mikrofon, Echo-Auslösen, Bluetooth) und der Ton eines angesehenen Streams
 * oder einer Watch-Party (nur Wiedergabe). Wer beide unabhängig voneinander
 * an- und abschaltet, baut genau den Fehler, den der Review am 2026-10-08
 * gefunden hat: Das Verlassen eines Sprachkanals rief `setActive(false)` und
 * riss damit den laufenden Stream-Ton mit, weil die Session prozessweit gilt.
 *
 * **Voice gewinnt**, und zwar nicht aus Vorliebe: `playAndRecord`+`voiceChat`
 * kann Wiedergabe mit, `playback` aber kein Mikrofon. Die stärkere Betriebsart
 * ist die, die beides trägt.
 *
 * Importfrei, damit Nodes Testläufer die Entscheidung prüfen kann (s.
 * `pnpm test:unit`-Falle im CLAUDE.md); die Verdrahtung ans Plugin steht
 * daneben in `iosTon.ts`.
 */

export type TonModus = 'voice' | 'wiedergabe' | 'aus';

export function zielModus(voiceAktiv: boolean, anzahlWiedergaben: number): TonModus {
  if (voiceAktiv) return 'voice';
  if (anzahlWiedergaben > 0) return 'wiedergabe';
  return 'aus';
}
