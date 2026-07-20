/**
 * Rausch-Politik für die `sidecar.log` — welche Protokollzeilen NICHT
 * mitgeschrieben werden.
 *
 * Warum das nötig ist: der Sidecar meldet einmal pro Sekunde und Stream
 * `{"ev":"fps",…}`. Ungefiltert waren das in einem echten Log ~94 % aller
 * Zeilen (~340 KB pro Stream-Stunde). Der Diagnose-Upload überträgt nur den
 * letzten 512-KiB-Ausschnitt der Datei — bei einem langen Stream besteht der
 * dann ausschließlich aus fps-Zeilen, und genau die Zeilen, die einen Fehler
 * erklären (Sidecar-Start mit Version, Import-Versuch pro Render-Node,
 * gewählter Encode-Pfad, FFmpegs av_log-Ausgabe), sind herausgedrängt.
 *
 * Ganz wegwerfen wäre zu grob: ob überhaupt Frames entstanden sind, ist bei
 * Capture-Fehlern die halbe Diagnose. Deshalb eine Stichprobe pro Minute.
 *
 * Bewusst ohne `electron`-Import und ohne Uhr-Zugriff (`now` kommt herein):
 * so ist die Politik als reine Funktion testbar — `sidecar-log.ts` selbst ist
 * es nicht, weil es `app.getPath()` braucht.
 */

/** Abstand zwischen zwei mitgeschriebenen fps-Stichproben. */
export const FPS_SAMPLE_MS = 60_000;

export type NoiseFilter = (stream: string, text: string, now: number) => boolean;

/**
 * Baut den Filter. Rückgabe `true` = diese Zeile unterdrücken.
 *
 * Der Zustand (wann zuletzt ein fps durchgelassen wurde) steckt im Closure,
 * damit mehrere Aufrufer sich nicht gegenseitig stören und ein Test bei null
 * anfängt.
 */
export function createNoiseFilter(sampleMs: number = FPS_SAMPLE_MS): NoiseFilter {
  // `null` = seit dem letzten Abschnitt noch keine Stichprobe. Bewusst nicht
  // `0` als Ersatz: das hieße „bei Zeitstempel 0 geloggt" und würde die erste
  // Zeile nur deshalb durchlassen, weil `Date.now()` zufällig eine große Zahl
  // ist — mit einer bei 0 beginnenden Uhr (Test, monotone Quelle) fiele sie weg.
  let lastFpsLogged: number | null = null;

  return (stream, text, now) => {
    // Nur der stdout-Protokollstrom rauscht; stderr/lifecycle sind rar und
    // tragen im Fehlerfall die Begründung — die nie unterdrücken.
    if (stream !== 'out') return false;

    // Ein State-Übergang beginnt einen neuen Stream-Abschnitt: die nächste
    // fps-Zeile wieder mitnehmen, damit auch ein Stream, der keine volle
    // Minute läuft, seinen Beleg über produzierte Frames hinterlässt.
    if (text.includes('"ev":"state"')) {
      lastFpsLogged = null;
      return false;
    }

    // Erkennung per Substring statt JSON.parse: das läuft 60×/s pro Stream.
    if (!text.includes('"ev":"fps"')) return false;

    if (lastFpsLogged !== null && now - lastFpsLogged < sampleMs) return true;
    lastFpsLogged = now;
    return false;
  };
}
