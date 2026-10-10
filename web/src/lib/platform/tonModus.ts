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

/** Was wir WebKit sagen — die Werte der W3C Audio Session API. */
export type AudioSessionTyp = 'play-and-record' | 'playback' | 'auto';

/**
 * Derselbe Entschluss, an die zweite Partei gerichtet.
 *
 * **Warum es eine zweite Partei gibt.** In einer WebView gehoert die
 * AVAudioSession nicht uns, sondern WebKit: es waehlt Kategorie und Modus
 * danach, was die Seite gerade tut (offenes Mikrofon → PlayAndRecord). Unser
 * `AudioSessionPlugin` stellt dieselbe Session daneben ein — zwei Parteien,
 * ein Geraet, und bis zum 2026-10-10 ohne jede Absprache: `navigator
 * .audioSession` kam im ganzen Projekt nicht vor. Diese Schnittstelle IST die
 * Absprache; sie ist der vorgesehene Weg, WebKit die Absicht zu nennen, und
 * kein Umweg um eine Regel herum.
 *
 * Was daran haengt (Safari ab iOS 17): ob der Ton am Klingelton-Schalter
 * vorbeigeht, und ob die Seite als aktive Audio-Sitzung gilt — Letzteres
 * entscheidet mit, ob WebKit sie im Hintergrund weiterlaufen laesst.
 *
 * `auto` ist bewusst nicht `ambient`: ohne Ton wollen wir keine Aussage
 * treffen, sondern die Vorgabe zurueckgeben — eine falsche Aussage waere
 * schlechter als keine.
 */
export function audioSessionTyp(modus: TonModus): AudioSessionTyp {
  if (modus === 'voice') return 'play-and-record';
  if (modus === 'wiedergabe') return 'playback';
  return 'auto';
}

/** Was auf einen gemeldeten Wegwechsel zu tun ist. */
export type WegAntwort = 'ignorieren' | 'uebernehmen' | 'neu-einrichten';

/**
 * Entscheidet, ob ein gemeldeter Wegwechsel eine neue Einrichtung braucht.
 *
 * **Warum das eine eigene Funktion ist.** Bis zum 2026-10-10 beantwortete
 * `iosTon.ts` dieselbe Frage mit einer Zeitfrist („ein Wechsel kurz nach dem
 * eigenen Einrichten ist dessen Folge"), weil der Binder die Nutzlast des
 * Ereignisses wegwarf. Das verlangsamte die Rueckkopplung, statt sie zu
 * beenden: am Geraet nachgemessen blieb eine Einrichtung alle 2,4–2,9 s
 * uebrig, mitten in den Beitritt hinein. Mit dem Tonweg im Ereignis ist es
 * ein Vergleich — und ein Vergleich laesst sich pruefen, eine Frist nicht.
 *
 * - `voiceAktiv === false`: ohne Mikrofon richtet sich die Session nicht nach
 *   dem Weg. Nur mitschreiben (`uebernehmen`), damit der naechste Beitritt
 *   nicht grundlos neu einrichtet.
 * - `angewandt === null`: der Ausgangszustand ist unbekannt. Ein unbekannter
 *   Zustand ist kein Wechsel — uebernehmen, nicht einrichten.
 * - gleicher Weg: Folge der eigenen Einrichtung. `setCategory`/`setActive`
 *   loesen selbst Routenwechsel aus; die duerfen keine weitere ausloesen.
 */
export function wegAntwort(
  voiceAktiv: boolean,
  gemeldet: string,
  angewandt: string | null
): WegAntwort {
  if (!voiceAktiv) return 'uebernehmen';
  if (angewandt === null) return 'uebernehmen';
  return gemeldet === angewandt ? 'ignorieren' : 'neu-einrichten';
}
