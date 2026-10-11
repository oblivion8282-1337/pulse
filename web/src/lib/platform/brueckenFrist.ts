/**
 * Eine Frist für Rufe an die native Hülle.
 *
 * **Wozu.** Ein Brücken-Ruf, den die Hülle annimmt und nie beantwortet,
 * lässt sein Promise für immer offen — kein `.catch()` greift, und alles,
 * was darauf wartet, wartet mit. Capacitor selbst setzt keine Frist. Wer
 * darauf `await`et, hängt fest: ein `connect()`, das nie zurückkehrt, ein
 * Auflegen, das die Oberfläche nie räumt, eine Warteschlange, die keinen
 * zweiten Wunsch mehr annimmt.
 *
 * Die Frist ersetzt nicht die Prüfung VOR dem Ruf (`huelleKann.ts`) — die
 * verhindert, dass ein Ruf an eine Methode geht, die der Bau nicht hat. Die
 * Frist fängt ab, was jene nicht vorhersieht: eine Hülle, die einen Ruf
 * annimmt und dann in sich hängen bleibt.
 *
 * **Was sie NICHT tut:** den Ruf abbrechen. Die Hülle arbeitet weiter; eine
 * späte Antwort wird nur nicht mehr abgewartet. Wer danach den wahren Stand
 * braucht, fragt ihn neu ab oder hört auf die Ereignisse der Hülle.
 *
 * Importfrei (CLAUDE.md, `pnpm test:unit`).
 */

/** Die Hülle hat innerhalb der Frist nicht geantwortet. */
export class KeineAntwort extends Error {
  readonly befehl: string;
  readonly ms: number;

  constructor(befehl: string, ms: number) {
    super(`Hülle hat auf „${befehl}" nicht innerhalb von ${ms} ms geantwortet`);
    this.name = 'KeineAntwort';
    this.befehl = befehl;
    this.ms = ms;
  }
}

/**
 * `lauf`, aber spätestens nach `ms` abgelehnt (`KeineAntwort`). Was `lauf`
 * danach noch liefert — Wert oder Fehler —, verfällt still.
 */
export function mitFrist<T>(lauf: Promise<T>, ms: number, befehl: string): Promise<T> {
  return new Promise<T>((annehmen, ablehnen) => {
    const uhr = setTimeout(() => ablehnen(new KeineAntwort(befehl, ms)), ms);
    lauf.then(
      (wert) => {
        clearTimeout(uhr);
        annehmen(wert);
      },
      (fehler: unknown) => {
        clearTimeout(uhr);
        ablehnen(fehler);
      }
    );
  });
}

/**
 * **Wie lange der Sprachweg (`iosSprache.ts`) auf eine Antwort der Hülle
 * wartet.** Zwei Werte, weil die Befehle zwei Arten Wartezeit haben.
 *
 * `SPRACHE_FRIST_KETTE_MS` gilt für alles, was die Hülle in ihre Kette stellt
 * (`SpracheRaum.nacheinander`: Mikrofon, Taub, Kamera, Kameraseite,
 * Lautstärken). Ein solcher Befehl wartet auf das SDK und auf seine
 * Vorgänger. Die längste Wartezeit, die LiveKit einem einzelnen Befehl
 * selbst zugesteht, hat das Einschalten der Kamera: bis zum ersten Bild 10 s
 * (`defaultCaptureStart`), dann die Antwort auf die Spur-Anmeldung 10 s
 * (`defaultPublish`) — danach wirft das SDK, und das kommt sauber als
 * Ablehnung an. Die Frist liegt mit Abstand darüber, damit sie einer echten
 * Fehlermeldung nie zuvorkommt: was nach 30 s offen ist, hängt. Abgelesen
 * am SDK-Quelltext (`TimeInterval.swift`, `LocalParticipant._publish`),
 * nicht gemessen.
 *
 * **Hingenommen:** wer hinter einem langen Vorgänger ansteht — einem
 * Beitritt samt Erlaubnis-Dialog —, kann die Frist reissen, ohne zu hängen.
 * Der Spiegel bleibt trotzdem richtig: die Hülle meldet ihren Stand nach
 * jedem Befehl (`eigenerZustand`), auch wenn dessen Antwort verfallen ist.
 *
 * `SPRACHE_FRIST_SOFORT_MS` gilt für alles ausserhalb der Kette (Verlassen,
 * Ausgabe, Zustand, Ansicht): dort liegt keine SDK-Wartezeit, nur ein Sprung
 * auf den Hauptfaden oder das Trennen (`Room.disconnect` schickt das Abmelden
 * ab, ohne auf eine Antwort zu warten). Was nach 10 s nicht geantwortet hat,
 * steckt in einer blockierten Brücke, nicht in Arbeit.
 *
 * **`beitreten` hat KEINE Frist**, aus zwei Gründen: der Mikrofon-Dialog
 * beim ersten Beitritt wartet auf den Nutzer, so lange er will, und ein
 * hängender Aufbau hat schon einen Ausweg — Auflegen läuft an der Kette
 * vorbei und bricht ihn ab (`verlassen` in `SprachePlugin.swift`).
 */
export const SPRACHE_FRIST_KETTE_MS = 30_000;
export const SPRACHE_FRIST_SOFORT_MS = 10_000;
