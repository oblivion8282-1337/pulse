/**
 * Ein Tor, das aufgeht, sobald die erste Health-Abfrage des Sidecars durch ist.
 *
 * **Wofür das gut ist.** `stream.fernsteuerbar` (aus `health.gsr.remote_input`)
 * ist nach dem Start eine Weile schlicht **unbekannt** — es steht auf `false`,
 * weil noch niemand gefragt hat, nicht weil der Rechner es nicht könnte. Wer in
 * diesem Fenster `darfStandplatzSein()` fragt, bekommt „nein" und hält es für
 * eine Antwort.
 *
 * **Genau daran ist die Standplatz-Anmeldung gescheitert** (gefunden am
 * 2026-08-26): `initStream()` läuft im Layout asynchron und muss dafür erst den
 * Sidecar starten — der wird lazy beim ersten `gsr:call` gespawnt. Die
 * WebSocket-Verbindung braucht keinen Prozessstart und ist deshalb regelmässig
 * früher da. Beim `ready`-Rahmen stand `fernsteuerbar` also noch auf `false`,
 * die Anmeldung unterblieb — **und es gab kein Nachmelden**. Folge: das Gerät
 * stand für alle anderen dauerhaft auf „offline", und weil `anmelden()` auch
 * die Bildschirmliste holt, blieb `available_monitors` leer. Im Reiter
 * „Remote-Rechner" stand dann statt der Schirme nur der Ersatz-Eintrag
 * „Hauptbildschirm" — ein Rechner mit zwei Monitoren sah aus wie einer mit
 * einem.
 *
 * **Warum ein Tor und kein Zeitlimit.** Eine Frist wäre geraten: der Sidecar
 * startet auf einer trägen Maschine langsamer als auf einer schnellen, und die
 * Zahl, die heute reicht, reicht morgen nicht. Das Tor wartet auf das
 * Ereignis selbst. Bleibt es zu — Sidecar startet nie, Browser ohne Electron —,
 * unterbleibt die Anmeldung, und der Rechner steht als offline. **Das ist die
 * richtige Richtung:** ein angebotener Standplatz, den niemand übernehmen kann,
 * ist schlimmer als gar keiner (dieselbe Begründung wie in
 * `remote/darfStandplatzSein.ts`).
 *
 * Deshalb muss `oeffnen()` an **jedem** Rückgabepfad von `initStream()` stehen,
 * auch an den erfolglosen — ein vergessener Pfad meldet kein falsches Gerät an,
 * er lässt ein richtiges verschwinden.
 *
 * Importfrei gehalten, damit Nodes Testläufer die Datei direkt nehmen kann
 * (Muster wie `remote/darfStandplatzSeinPruefung.ts`).
 */

export type GesundheitTor = {
  /** Aufgehen lassen. Mehrfach aufrufbar; jeder weitere Aufruf tut nichts. */
  oeffnen: () => void;
  /** Erfüllt sich, sobald das Tor offen ist. Danach sofort erfüllt. */
  bekannt: () => Promise<void>;
  /** Nur für Tests und Diagnose — ist das Tor schon offen? */
  offen: () => boolean;
};

/**
 * Ein neues Tor. Als Fabrik, damit ein Test mehrere unabhängige Tore prüfen
 * kann — ein Modul-Singleton liesse sich nur ein einziges Mal schliessen.
 */
export function macheGesundheitTor(): GesundheitTor {
  let freigeben: (() => void) | null = null;
  let istOffen = false;
  const warten = new Promise<void>((aufloesen) => {
    freigeben = aufloesen;
  });
  return {
    oeffnen: () => {
      if (istOffen) return;
      istOffen = true;
      freigeben?.();
      freigeben = null;
    },
    bekannt: () => warten,
    offen: () => istOffen,
  };
}

/** Das Tor dieser Anwendung. `initStream()` öffnet es, `ready.ts` wartet darauf. */
export const gesundheitTor = macheGesundheitTor();
