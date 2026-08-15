/**
 * Fernsteuerung — **Dauerfreigabe am Standplatz-Gerät** (Stufe 1 aus
 * `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`).
 *
 * Ein Rechner, vor dem niemand sitzt, kann den Zustimmungsdialog nicht
 * beantworten: er verfällt nach 30 s, und das Aussitzen zählt als Absage — der
 * unbeaufsichtigte Rechner sperrt den Anfragenden anschliessend auch noch aus
 * (`remote_registry.py::REMOTE_PENDING_TIMEOUT_S`). Statt die Zustimmung
 * abzuschaffen, wird sie **vorverlegt**: jemand sitzt einmal körperlich an dem
 * Gerät und gibt es frei; danach beantwortet dieser Client die Anfrage
 * selbsttätig.
 *
 * ## Warum das nichts am Protokoll ändert
 *
 * Der Gateway sieht eine ganz gewöhnliche Zustimmung, nur nach 20 ms statt nach
 * vier Sekunden. `ws_remote_handlers.py`, `remote_registry.py` und der
 * Drahtvertrag bleiben wortgleich, und der gesamte Schutzapparat bleibt in
 * Kraft: Rechteprüfung, Rechte-Wache im 30-s-Takt, Sitzungsdeckel, eine Sitzung
 * je Host, Abbau bei Rauswurf und Bann. Diese Datei entscheidet nur, **ob der
 * Dialog überhaupt jemandem vorgelegt wird**.
 *
 * ## Warum der Schalter am Gerät sitzt und nicht auf dem Server
 *
 * Ein serverseitiger Schalter wäre von einem Admin fernaktivierbar — und „ein
 * Admin schaltet fremde Rechner scharf" ist genau das, was diese Zustimmung
 * verhindern soll. Gespeichert wird deshalb dort, wo auch die Stream-Geheimnisse
 * liegen: `desktop/electron/store.ts` (`pulse-stream.json`, unter Linux
 * chmod 600), über den vorhandenen Zwei-Wege-Wrapper `stream/persistence.ts`.
 * Der Server darf später erfahren, **dass** ein Gerät selbsttätig annimmt;
 * setzen darf er es nie.
 *
 * ## Was hier bewusst NICHT steht
 *
 * **Rollen.** Der Entwurf nennt „Rolle und/oder einzelne Nutzer im
 * Standplatz-Kanal". Rollen sauber aufzulösen heisst, die Rollen des
 * Anfragenden in der Community des Standplatzes zu kennen — der Client hat sie
 * nur für die gerade geöffnete Community, und eine Anfrage kommt auch herein,
 * während man woanders steht. Eine halb aufgelöste Rolle wäre hier die
 * schlechteste Antwort: sie sähe nach einer Regel aus und träfe zufällig. Stufe
 * 1 trägt deshalb die beiden Achsen, die der Client sicher kennt — einzelne
 * Nutzer und „jeder, der überhaupt anfragen darf" —, und die Rollen kommen mit
 * dem serverseitigen Standplatz (Stufe 2), wo `resolve_permissions` sie ohnehin
 * schon auflöst.
 *
 * **Der Ort.** Aus demselben Grund gilt die Freigabe vorerst für das GERÄT und
 * nicht je Kanal: den Standplatz gibt es als Begriff erst in Stufe 2. Die
 * Rechteprüfung des Servers engt weiterhin ein — wer in dem Kanal kein
 * `REMOTE_CONTROL` hat, kommt gar nicht bis hierher.
 */

import { loadAll, saveAll } from '$lib/stream/persistence';

/** Wie lange eine erteilte Freigabe gilt. */
export type Geltung = 'neustart' | 'acht_stunden' | 'dauerhaft';

/** Acht Stunden in Millisekunden — dieselbe Spanne wie der absolute
 *  Sitzungsdeckel des Gateways (`REMOTE_MAX_SESSION_S`), damit ein Gerät nicht
 *  länger scharf steht, als eine Sitzung überhaupt dauern darf. */
const ACHT_STUNDEN_MS = 8 * 60 * 60 * 1000;

/** Schlüssel im Geräte-Speicher. Punktiert wie die übrigen Fremdschlüssel des
 *  Blobs, damit er nicht mit den Stream-Feldern verwechselt wird. */
const SPEICHER_SCHLUESSEL = 'remote.standplatz';

/** Was auf der Platte liegt. Bewusst schmal: alles, was sich ausrechnen lässt,
 *  wird ausgerechnet. */
interface Gespeichert {
  aktiv: boolean;
  /** Nutzer-Kennungen, die ohne Rückfrage übernehmen dürfen (Snowflakes als
   *  Zeichenketten, wie überall über die API). */
  nutzer: string[];
  /** Jeder, der überhaupt anfragen darf. Die Rechteprüfung des Servers bleibt
   *  davor — das hier hebt nur den Dialog auf, nicht die Berechtigung. */
  jeder: boolean;
  geltung: Geltung;
  /** Bis wann die Freigabe gilt (ms seit Epoche), `null` = ohne Ablauf. */
  gueltigBis: number | null;
}

const LEER: Gespeichert = {
  aktiv: false,
  nutzer: [],
  jeder: false,
  geltung: 'neustart',
  gueltigBis: null,
};

function istGeltung(wert: unknown): wert is Geltung {
  return wert === 'neustart' || wert === 'acht_stunden' || wert === 'dauerhaft';
}

/** Das Gespeicherte prüfen, statt ihm zu glauben. Die Datei ist von Hand
 *  editierbar, und ein kaputtes Feld darf hier nicht dazu führen, dass ein
 *  Gerät scharf steht, das niemand freigegeben hat — im Zweifel [`LEER`]. */
function ausSpeicher(roh: unknown): Gespeichert {
  if (!roh || typeof roh !== 'object') return { ...LEER };
  const o = roh as Record<string, unknown>;
  const nutzer = Array.isArray(o.nutzer)
    ? o.nutzer.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];
  return {
    aktiv: o.aktiv === true,
    nutzer,
    jeder: o.jeder === true,
    geltung: istGeltung(o.geltung) ? o.geltung : 'neustart',
    gueltigBis: typeof o.gueltigBis === 'number' && Number.isFinite(o.gueltigBis)
      ? o.gueltigBis
      : null,
  };
}

class StandplatzFreigabe {
  aktiv = $state(false);
  nutzer = $state<string[]>([]);
  jeder = $state(false);
  geltung = $state<Geltung>('neustart');
  gueltigBis = $state<number | null>(null);
  /** Ist der gespeicherte Stand schon gelesen? Bis dahin wird **nichts**
   *  selbsttätig zugestimmt — ein Rennen zwischen einer hereinkommenden
   *  Anfrage und dem Laden darf nicht zugunsten der Anfrage ausgehen. */
  geladen = $state(false);

  /**
   * Beim Start des Clients einmal rufen (`app/+layout`).
   *
   * **Hier verfällt „bis Neustart".** Dass dieser Aufruf läuft, IST der
   * Neustart — ein frisch geladener Client hat die Freigabe des vorigen Laufs
   * nicht mehr. Der Irrtum geht damit in die sichere Richtung: ein
   * Renderer-Neustart ohne Neustart des Rechners löscht sie ebenfalls, und eine
   * zu früh erloschene Freigabe kostet einen Gang zum Gerät, eine zu lange
   * gültige den Rechner.
   */
  async laden(): Promise<void> {
    let stand: Gespeichert;
    try {
      const alle = await loadAll();
      stand = ausSpeicher(alle[SPEICHER_SCHLUESSEL]);
    } catch {
      stand = { ...LEER };
    }
    const verfallen =
      stand.geltung === 'neustart' ||
      (stand.gueltigBis !== null && stand.gueltigBis <= Date.now());
    if (verfallen) stand = { ...stand, aktiv: false, gueltigBis: null };
    this.#uebernehmen(stand);
    this.geladen = true;
    // Zurückschreiben, wenn die Freigabe gerade verfallen ist: sonst behauptet
    // die Datei für immer eine Freigabe, die kein Start je wieder annimmt —
    // und wer sie liest (Support, der Nutzer selbst), liest etwas Falsches.
    if (verfallen && stand.nutzer.length + Number(stand.jeder) > 0) await this.#sichern();
  }

  /**
   * Freigabe erteilen. Der eine Weg hinein — bewusst mit allen drei Angaben auf
   * einmal, damit es keinen Zwischenzustand „scharf, aber für niemanden" gibt.
   */
  async freigeben(opts: { nutzer: string[]; jeder: boolean; geltung: Geltung }): Promise<void> {
    // Eine Freigabe ohne Empfänger ist keine — sie sähe im Schalterbild nur so
    // aus, als stünde das Gerät bereit, und niemand käme durch.
    if (!opts.jeder && opts.nutzer.length === 0) {
      await this.zuruecknehmen();
      return;
    }
    this.#uebernehmen({
      aktiv: true,
      nutzer: [...new Set(opts.nutzer)],
      jeder: opts.jeder,
      geltung: opts.geltung,
      gueltigBis: opts.geltung === 'acht_stunden' ? Date.now() + ACHT_STUNDEN_MS : null,
    });
    await this.#sichern();
  }

  /** Freigabe zurücknehmen. Die Empfängerliste bleibt stehen, damit ein
   *  versehentliches Ausschalten nicht die ganze Einstellung kostet. */
  async zuruecknehmen(): Promise<void> {
    this.aktiv = false;
    this.gueltigBis = null;
    await this.#sichern();
  }

  /**
   * Darf dieser Anfragende ohne Dialog übernehmen?
   *
   * **Fail-closed an jeder Abzweigung:** ungeladener Stand, keine Freigabe,
   * abgelaufen, unbekannte Kennung — alles heisst „nein, den Dialog zeigen".
   * Ein „nein" kostet hier eine Rückfrage, ein falsches „ja" den Rechner.
   */
  darfOhneRueckfrage(vonUserId: string | null | undefined): boolean {
    if (!this.geladen || !this.aktiv || !vonUserId) return false;
    if (this.gueltigBis !== null && this.gueltigBis <= Date.now()) {
      // Abgelaufen: still abschalten und ablehnen. Das Zurückschreiben läuft
      // nebenher — die Entscheidung hängt nicht daran.
      void this.zuruecknehmen();
      return false;
    }
    return this.jeder || this.nutzer.includes(vonUserId);
  }

  /** Wie lange die Freigabe noch gilt (ms), `null` = ohne Ablauf, `0` = nicht
   *  aktiv. Für die Anzeige am Gerät. */
  restMs(): number | null {
    if (!this.aktiv) return 0;
    if (this.gueltigBis === null) return null;
    return Math.max(0, this.gueltigBis - Date.now());
  }

  #uebernehmen(stand: Gespeichert): void {
    this.aktiv = stand.aktiv;
    this.nutzer = stand.nutzer;
    this.jeder = stand.jeder;
    this.geltung = stand.geltung;
    this.gueltigBis = stand.gueltigBis;
  }

  async #sichern(): Promise<void> {
    const stand: Gespeichert = {
      aktiv: this.aktiv,
      nutzer: [...this.nutzer],
      jeder: this.jeder,
      geltung: this.geltung,
      gueltigBis: this.gueltigBis,
    };
    try {
      await saveAll({ [SPEICHER_SCHLUESSEL]: stand });
    } catch {
      // Wie überall in der Persistenz: der Zustand im Speicher gilt weiter.
      // Eine nicht geschriebene Freigabe ist beim nächsten Start weg — wieder
      // die sichere Richtung.
    }
  }
}

export const standplatz = new StandplatzFreigabe();
