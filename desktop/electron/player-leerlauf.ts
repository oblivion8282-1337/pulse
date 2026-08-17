/**
 * Wann der Player-Prozess ohne Fenster beendet wird.
 *
 * **Der Anlass** (2026-08-17): der Prozess wurde bis dahin nur beim App-Ende
 * beendet (`playerManager.shutdown()`, gebuendelt in `main.ts`). Ein Player,
 * dessen letztes Fenster zu ist, blieb damit fuer den Rest der Sitzung stehen —
 * gemessen rund **490 MB RSS ueber anderthalb Stunden** im `epoll_wait`, ohne
 * ein einziges Fenster. Decoder, wgpu-Device und die FFmpeg-Puffer geben ihren
 * Speicher nicht zurueck; nur der Prozess tut das.
 *
 * **Warum nicht sofort beim letzten `close`.** Ein Fensterwechsel ist kein
 * Ende: die App macht ein Fenster zu und kurz darauf ein anderes auf (anderer
 * Bildschirm, Kachel neu gemountet, Strom neu aufgebaut). Ein sofortiges
 * Beenden kostete dann jedes Mal einen vollen Prozessstart mitten in der
 * Bedienung. Deshalb eine Frist, und erst danach das Ende.
 *
 * **Warum das hier steht und nicht in `player.ts`.** Dieselbe Begruendung wie
 * bei `sidecar-log-drossel.ts`: ohne `electron`-Import und ohne eigenen Griff
 * zur Uhr ist es eine reine Funktion und damit pruefbar. Der Zeitgeber kommt
 * von aussen herein — im Betrieb `setTimeout`, im Test ein von Hand
 * ausgeloester.
 *
 * Was hier NICHT entschieden wird: wie beendet wird. Das bleibt der geordnete
 * `shutdown()`-Weg in `player.ts` (Protokoll-`shutdown`, stdin zu, SIGTERM,
 * SIGKILL) — ein roher `kill` liesse den GPU-Treiber im Zweifel mit halb
 * abgebauten Ressourcen zurueck.
 */

/**
 * Ein geplantes Ereignis abbestellen. Bewusst eine Funktion statt eines
 * Zeitgeber-Griffs: so muss dieses Modul weder `NodeJS.Timeout` noch den
 * Browser-Gegenpart kennen, und ein Test kann `planen` durch etwas ersetzen,
 * das gar keine Uhr braucht.
 */
export type Abbestellen = () => void;

/** Etwas nach `ms` ausfuehren; liefert die Abbestellung. */
export type Planen = (fn: () => void, ms: number) => Abbestellen;

export interface LeerlaufWacht {
  /** Ein Fenster ist aufgegangen. Eine laufende Frist faellt damit weg. */
  geoeffnet(session: number): void;
  /** Ein Fenster ist zu. War es das letzte, laeuft die Frist an. */
  geschlossen(session: number): void;
  /**
   * Der Prozess ist weg (Sturz oder gewolltes Ende) — Stand fallen lassen und
   * Frist absagen. Ohne das bliebe ein Eintrag stehen, und die Frist waere
   * fuer den naechsten Prozess dauerhaft entschaerft.
   */
  zuruecksetzen(): void;
  /** Wie viele Fenster gerade offen sind. Fuer Protokoll und Pruefung. */
  readonly offen: number;
}

const standardWecker: Planen = (fn, ms) => {
  const griff = setTimeout(fn, ms);
  return () => clearTimeout(griff);
};

/**
 * `beenden` wird gerufen, wenn die Frist ohne neues Fenster ablaeuft — genau
 * einmal je Leerlauf, nicht wiederholt.
 */
export function createLeerlaufWacht(
  fristMs: number,
  beenden: () => void,
  planen: Planen = standardWecker,
): LeerlaufWacht {
  const offen = new Set<number>();
  let abbestellen: Abbestellen | null = null;

  const fristAbsagen = (): void => {
    abbestellen?.();
    abbestellen = null;
  };

  return {
    get offen(): number {
      return offen.size;
    },

    geoeffnet(session): void {
      offen.add(session);
      fristAbsagen();
    },

    geschlossen(session): void {
      // Unbekannte Nummer: schon gebucht oder nie unsere. Beides darf die Frist
      // nicht anstossen — sonst beendete eine doppelte Meldung („die App
      // schliesst" plus „der Nutzer hat geschlossen") den Prozess, waehrend
      // noch ein anderes Fenster offen ist.
      if (!offen.delete(session)) return;
      if (offen.size > 0) return;
      fristAbsagen();
      abbestellen = planen(() => {
        abbestellen = null;
        // Zwischenzeitlich doch wieder ein Fenster: dann war es ein Wechsel,
        // kein Ende. Die Pruefung steht hier UND in `geoeffnet` — ein
        // Zeitgeber, der bereits feuert, laesst sich nicht mehr abbestellen.
        if (offen.size > 0) return;
        beenden();
      }, fristMs);
    },

    zuruecksetzen(): void {
      offen.clear();
      fristAbsagen();
    },
  };
}
