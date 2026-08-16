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

/**
 * Ein einzeln Freigegebener.
 *
 * **Mit Server, nicht nur mit Nutzerkennung** (Bughunt 2026-08-16): der
 * Speicher liegt am GERÄT, und dasselbe Gerät kann in der Cloud und auf einem
 * Self-Host eingetragen sein. Kennungen werden je Instanz vergeben — dieselbe
 * Zahl kann auf zwei Servern zwei verschiedene Menschen sein. Ohne den Server
 * daneben gälte eine Freigabe, die jemandem in der Cloud gilt, unter Umständen
 * einem Fremden auf einem anderen Server.
 */
export interface Freigegebener {
  serverId: string;
  userId: string;
}

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
  /** Wer ohne Rückfrage übernehmen darf — je Eintrag Server UND Nutzer. */
  nutzer: Freigegebener[];
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

/** Doppelte Einträge entfernen — Server UND Nutzer müssen übereinstimmen. */
function eindeutig(liste: Freigegebener[]): Freigegebener[] {
  const gesehen = new Set<string>();
  return liste.filter((n) => {
    const k = `${n.serverId}\u0000${n.userId}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
}

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
    ? o.nutzer.filter(
        (n): n is Freigegebener =>
          !!n &&
          typeof n === 'object' &&
          typeof (n as Freigegebener).serverId === 'string' &&
          typeof (n as Freigegebener).userId === 'string' &&
          (n as Freigegebener).userId.length > 0,
      )
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
  nutzer = $state<Freigegebener[]>([]);
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
  async laden(vorgeladen?: Record<string, unknown>): Promise<void> {
    // `vorgeladen` ist der schon gelesene Speicher: drei Module lesen beim
    // Start denselben Blob, und unter Electron ist jeder Griff ein eigener
    // IPC-Umlauf über die ganze Datei. Der Aufrufer liest einmal und reicht
    // durch (`app/+layout`); ohne Argument liest dieses Modul selbst.
    let stand: Gespeichert;
    try {
      const alle = vorgeladen ?? (await loadAll());
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
    if (verfallen && (stand.jeder || stand.nutzer.length > 0)) await this.#sichern();
  }

  /**
   * Freigabe erteilen. Der eine Weg hinein — bewusst mit allen drei Angaben auf
   * einmal, damit es keinen Zwischenzustand „scharf, aber für niemanden" gibt.
   */
  async freigeben(opts: {
    nutzer: Freigegebener[];
    jeder: boolean;
    geltung: Geltung;
  }): Promise<void> {
    // Eine Freigabe ohne Empfänger ist keine — sie sähe im Schalterbild nur so
    // aus, als stünde das Gerät bereit, und niemand käme durch.
    if (!opts.jeder && opts.nutzer.length === 0) {
      await this.zuruecknehmen();
      return;
    }
    this.#uebernehmen({
      aktiv: true,
      nutzer: eindeutig(opts.nutzer),
      jeder: opts.jeder,
      geltung: opts.geltung,
      gueltigBis: opts.geltung === 'acht_stunden' ? Date.now() + ACHT_STUNDEN_MS : null,
    });
    await this.#sichern();
  }

  /**
   * Nur die Freigabeliste ändern — **ohne den Ein/Aus-Schalter anzufassen**.
   *
   * Der Weg für „einen Namen streichen". Über [`freigeben`] zu gehen wäre der
   * naheliegende Kurzschluss und war ein Loch (Bughunt 2026-08-16): `freigeben`
   * schaltet die Freigabe ausdrücklich SCHARF, also machte das Streichen eines
   * von zwei Namen aus einer zurückgenommenen Freigabe wieder eine geltende —
   * ein Klick, der laut Beschriftung nur einen Namen löscht, hob eine bewusste
   * Sicherheitsentscheidung auf.
   *
   * Bleibt niemand übrig und gilt auch nicht „jeder", wird eine GELTENDE
   * Freigabe zurückgenommen: scharf ohne Empfänger wäre eine Anzeige, die lügt.
   */
  async nutzerSetzen(nutzer: Freigegebener[]): Promise<void> {
    this.nutzer = eindeutig(nutzer);
    if (this.aktiv && !this.jeder && this.nutzer.length === 0) {
      await this.zuruecknehmen();
      return;
    }
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
  darfOhneRueckfrage(serverId: string | null, vonUserId: string | null | undefined): boolean {
    if (!this.geladen || !this.aktiv || !vonUserId || !serverId) return false;
    if (this.gueltigBis !== null && this.gueltigBis <= Date.now()) {
      // Abgelaufen: still abschalten und ablehnen. Das Zurückschreiben läuft
      // nebenher — die Entscheidung hängt nicht daran.
      void this.zuruecknehmen();
      return false;
    }
    return (
      this.jeder ||
      this.nutzer.some((n) => n.serverId === serverId && n.userId === vonUserId)
    );
  }

  /** Wie lange die Freigabe noch gilt (ms), `null` = ohne Ablauf, `0` = nicht
   *  aktiv. */
  restMs(): number | null {
    if (!this.aktiv) return 0;
    if (this.gueltigBis === null) return null;
    return Math.max(0, this.gueltigBis - Date.now());
  }

  /**
   * Dasselbe in ganzen Stunden, `null` = ohne Ablauf oder nicht aktiv.
   *
   * Die Rundung gehört zum Wert und nicht in die Ansicht: sie beantwortet
   * „reicht das noch für heute", nicht „wie viele Minuten". Eine minutengenaue
   * Anzeige bräuchte einen Zeitgeber, und Chromium drosselt den in verdeckten
   * Fenstern auf einen Lauf je Minute (dieselbe Falle wie in `wachten.ts`).
   */
  restStunden(): number | null {
    const rest = this.restMs();
    return rest === null || rest === 0 ? null : Math.max(1, Math.round(rest / 3_600_000));
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
