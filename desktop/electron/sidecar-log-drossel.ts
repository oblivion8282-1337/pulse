/**
 * Überlastschutz für die `sidecar.log` — begrenzt, wie viele Zeilen je Sekunde
 * überhaupt geschrieben werden.
 *
 * **Warum das gebraucht wird.** `sidecar-log-noise.ts` dünnt gezielt die
 * fps-Zeilen aus und lässt `err`/`lifecycle` ausdrücklich in Ruhe, mit der
 * Begründung, die seien „rar und tragen im Fehlerfall die Begründung". Das war
 * richtig, als es geschrieben wurde, und es stimmt für den Regelfall weiter —
 * aber nicht für den Fehlerfall, um den es geht: am 2026-08-07 stand im echten
 * Log eine FFmpeg-Fehlerflut mit rund **4400 Zeilen je Sekunde** (drei
 * Meldungen im Wechsel, je verworfenem Paket). Und jede dieser Zeilen kostet
 * auf der Electron-Seite drei synchrone Dateisystem-Zugriffe auf dem
 * Hauptfaden. Die Diagnose bremst dann genau das, was sie messen soll.
 *
 * **Warum eine Drossel und keine Entdopplung.** Die naheliegende Lösung wäre,
 * gleiche Zeilen zusammenzufassen. Sie greift hier nicht: die Flut bestand aus
 * DREI verschiedenen Meldungen im Wechsel („No sequence header available",
 * „Failed to read unit 0", „Failed to read packet"), und ein Vergleich mit der
 * jeweils vorigen Zeile fängt davon keine einzige. Eine Drossel ist gegen jede
 * Form von Flut unempfindlich, weil sie nicht auf den Inhalt sieht.
 *
 * **Warum ein Eimer und keine feste Obergrenze je Sekunde.** Die ersten Zeilen
 * einer Flut sind die wertvollen — dort steht, was zuerst schiefging. Der Eimer
 * lässt einen ganzen Schwall sofort durch (`burst`) und drosselt erst danach
 * auf eine Dauerrate. Eine feste Obergrenze würde stattdessen gleichmäßig
 * ausdünnen und den Anfang zerreißen.
 *
 * **Ausgelassene Zeilen werden gezählt und gemeldet**, nicht verschwiegen. Ein
 * Log, das stillschweigend Zeilen verliert, ist schlimmer als eines, das
 * rauscht: es sieht vollständig aus. Genau dieser Fehler steckte im
 * Ausgabe-Takt des Players (dort fielen Bilder ungezählt weg) und hat einen
 * halben Tag gekostet.
 *
 * Bewusst ohne Uhr-Zugriff (`now` kommt herein) und ohne `electron`-Import —
 * damit als reine Funktion testbar, wie die Rausch-Politik nebenan.
 */

/** Dauerrate in Zeilen je Sekunde, wenn der Vorrat aufgebraucht ist. */
export const DROSSEL_RATE = 20;

/** Wie viele Zeilen ohne jede Bremse durchgehen, bevor gedrosselt wird. */
export const DROSSEL_SCHWALL = 200;

export interface Drossel {
  /** `true` = schreiben. `false` = fallenlassen (wird gezählt). */
  darf(now: number): boolean;
  /**
   * Eine Zusammenfassung der ausgelassenen Zeilen, sobald wieder Luft ist —
   * sonst `null`. Vor der nächsten echten Zeile schreiben.
   */
  nachtrag(now: number): string | null;
}

export function createDrossel(
  rate: number = DROSSEL_RATE,
  schwall: number = DROSSEL_SCHWALL,
): Drossel {
  let vorrat = schwall;
  // `null` statt `0`: mit einer bei 0 beginnenden Uhr (Test, monotone Quelle)
  // wäre `0` nicht von „schon einmal aufgefüllt" zu unterscheiden. Derselbe
  // Grund wie bei `lastFpsLogged` in `sidecar-log-noise.ts`.
  let zuletzt: number | null = null;
  let ausgelassen = 0;

  const auffuellen = (now: number): void => {
    if (zuletzt === null) {
      zuletzt = now;
      return;
    }
    const dt = Math.max(0, now - zuletzt);
    zuletzt = now;
    vorrat = Math.min(schwall, vorrat + (dt * rate) / 1000);
  };

  return {
    darf(now) {
      auffuellen(now);
      if (vorrat >= 1) {
        vorrat -= 1;
        return true;
      }
      ausgelassen += 1;
      return false;
    },
    nachtrag(now) {
      if (ausgelassen === 0) return null;
      auffuellen(now);
      // Erst melden, wenn wieder Platz ist — sonst verdrängt die Meldung
      // selbst die nächste echte Zeile, und bei anhaltender Flut entstünde
      // eine zweite Flut aus Meldungen.
      if (vorrat < 1) return null;
      vorrat -= 1;
      const n = ausgelassen;
      ausgelassen = 0;
      return `[drossel] ${n} Zeilen wegen Ueberlast ausgelassen (Grenze ${rate}/s nach ${schwall} am Stueck)`;
    },
  };
}
