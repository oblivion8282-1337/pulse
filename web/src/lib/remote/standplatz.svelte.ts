/**
 * Fernsteuerung — **Dauerfreigabe am Standplatz-Gerät** (Stufe 1 aus
 * `docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`,
 * seit 2026-08-20 durch `docs/superpowers/specs/2026-08-20-geraeteverwaltung-design.md`
 * abgelöst — siehe dort für die aktuelle Aufteilung Server/Gerät).
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
 * ## Wo die Liste liegt, seit 2026-08-20 — und was am Gerät bleibt
 *
 * **Korrigiert 2026-08-20:** die Freigabeliste selbst liegt seither auf dem
 * Server (`chat.device_grants`), nicht mehr nur hier im Geräte-Speicher.
 * Schreiben und Lesen darf **ausschliesslich der Besitzer** — auch
 * `MANAGE_GUILD` nicht. Der ursprüngliche Einwand von Stufe 1 bleibt dabei
 * gewahrt, nur der Riegel hat sich verschoben: nicht mehr „die Liste existiert
 * nicht auf dem Server", sondern „niemand ausser dem Besitzer darf sie
 * ändern" — ein Admin kann fremde Rechner damit weiterhin nicht
 * fernaktivieren. Aufgelöst wird die Liste vom Gateway (dadurch werden Rollen
 * erstmals möglich, siehe unten), der das Ergebnis als Feld `freigabe` an
 * `remote_request` anhängt; **die Zustimmung selbst erteilt weiterhin dieses
 * Gerät** (`selbsttaetigRegel.ts`). Was am Gerät bleibt, ist der lokale
 * Hauptschalter `aktiv` — steht er auf „aus", stimmt der Rechner nie
 * selbsttätig zu, unabhängig davon, was der Server sagt. Ein Gerät, das offline
 * ist, stimmt weiterhin nie zu.
 *
 * Der einmalige Umzug der alten, rein lokalen Liste (`nutzer`/`jeder`) auf den
 * Server steht in `#umziehenEinmal` weiter unten in dieser Datei.
 *
 * ## Rollen — waren hier bewusst aussen vor, sind es jetzt nicht mehr
 *
 * Stufe 1 trug nur die beiden Achsen, die dieser Client sicher kennt —
 * einzelne Nutzer und „jeder, der überhaupt anfragen darf". Rollen sauber
 * aufzulösen hätte verlangt, die Rollen des Anfragenden in der Community des
 * Standplatzes zu kennen, auch wenn man selbst gerade woanders steht — das
 * konnte der Client nicht, ohne zu raten. **Erledigt seit 2026-08-20**: die
 * Auflösung liegt jetzt beim Server (`device_grants.py`), der genau das kann,
 * was der Client nie konnte — er kennt `resolve_permissions` für jede
 * Community, nicht nur die gerade geöffnete. Rollen-Freigaben stehen deshalb
 * nicht in dieser Datei, sondern serverseitig.
 *
 * **Der Ort bleibt gebunden** (Bughunt 2026-08-16, unverändert gültig):
 * „gilt für das GERÄT, egal aus welchem Kanal" war ein Loch. Wer in seiner
 * eigenen Community `REMOTE_CONTROL` hat, schickte `remote_request` mit deren
 * Kanalkennung, und eine ortslose Freigabe stimmte zu, obwohl er am Standplatz
 * nichts darf. Jede Freigabe trägt deshalb ihren Ort: einzelne Nutzer den
 * Kanal, in dem sie freigegeben wurden, und „jeder" den Standplatz des
 * Geräts, den der Aufrufer beisteuert (`geraeteanbindung.ts`).
 */

import { m } from '$lib/paraglide/messages.js';
import { loadAll, saveAll } from '$lib/stream/persistence';
import { selbsttaetig } from './selbsttaetigRegel';
import { umziehenNoetig, serverBereitsUmgezogen } from './umzugRegel';
import { freigaben } from '$lib/devices/freigaben.svelte';
import { dedupliziertLaden } from '$lib/devices/ladeWaechter';
import type { GrantEingabe } from '$lib/api/devices';

/** Wie lange eine erteilte Freigabe gilt. */
/**
 * Wie lange eine Freigabe gilt.
 *
 * **Seit 2026-08-16 nur noch zwei Fälle**: eine frei eingetragene Spanne
 * (`befristet`, die Länge steht in `gueltigBis`) oder `dauerhaft`. Vorher gab
 * es feste Stufen — „bis zum Neustart" und „acht Stunden" —, und beide waren
 * die falsche Art von Zusage: die erste hing an einem Ereignis, das auf einem
 * Rechner, der wochenlang durchläuft, nie eintritt, die zweite passte auf genau
 * einen Arbeitstag und sonst auf nichts.
 *
 * Alte Speicherstände werden beim Lesen umgesetzt (`ausSpeicher`).
 */
export type Geltung = 'befristet' | 'dauerhaft';

/** Die Einheiten der Spanne — mehr braucht es nicht, und Minuten wären für
 *  einen Rechner, den man freigibt, eine Scheingenauigkeit. */
export type Einheit = 'stunden' | 'tage' | 'wochen';

/** Eine Spanne in Millisekunden. Bewusst hier und nicht in der Oberfläche: die
 *  Umrechnung entscheidet, wann eine Freigabe endet, und das ist keine
 *  Anzeigefrage. */
export function spanneMs(menge: number, einheit: Einheit): number {
  const stunde = 60 * 60 * 1000;
  const faktor = einheit === 'wochen' ? 7 * 24 * stunde : einheit === 'tage' ? 24 * stunde : stunde;
  return Math.max(1, Math.round(menge)) * faktor;
}

/** Die Zahl, mit der `spanneMs` rechnet: ein geleertes Zahlenfeld liefert über
 *  `bind:value` ein `null` — ungeklemmt würde daraus ein Ablauf in der
 *  Vergangenheit. Klemmt die Oberfläche deshalb VOR dem Speichern, nicht erst
 *  im Speicher. */
export function klemmeMenge(menge: number): number {
  return Number.isFinite(Number(menge)) && Number(menge) > 0 ? Number(menge) : 1;
}

/** Die Wahlen der Geltung/Einheit für die Auswahloberflächen — bewusst die
 *  label-Funktionen, damit die Beschriftung erst beim Rendern die aktuelle
 *  Sprache trifft. Standen wortgleich in `DeviceFreigabenGeltung` und
 *  `SettingsStandplatz`. */
export const geltungen: { id: Geltung; label: () => string }[] = [
  { id: 'befristet', label: m.standplatz_settings_duration_limited },
  { id: 'dauerhaft', label: m.standplatz_settings_duration_permanent },
];
export const einheiten: { id: Einheit; label: () => string }[] = [
  { id: 'stunden', label: m.standplatz_settings_unit_hours },
  { id: 'tage', label: m.standplatz_settings_unit_days },
  { id: 'wochen', label: m.standplatz_settings_unit_weeks },
];

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
  /**
   * **Und mit Kanal** (Bughunt 2026-08-16): der Standplatz, an dem freigegeben
   * wurde. Ohne ihn galt die Freigabe aus JEDEM Kanal, in dem der Freigegebene
   * `REMOTE_CONTROL` hat — auch aus seiner eigenen Community, wo er mit diesem
   * Gerät nichts zu tun hat.
   */
  channelId: string;
  userId: string;
}

/** Acht Stunden in Millisekunden — dieselbe Spanne wie der absolute
 *  Sitzungsdeckel des Gateways (`REMOTE_MAX_SESSION_S`), damit ein Gerät nicht
 *  länger scharf steht, als eine Sitzung überhaupt dauern darf. */
const STUNDE_MS = 60 * 60 * 1000;

/** Schlüssel im Geräte-Speicher. Punktiert wie die übrigen Fremdschlüssel des
 *  Blobs, damit er nicht mit den Stream-Feldern verwechselt wird. */
const SPEICHER_SCHLUESSEL = 'remote.standplatz';

/**
 * Schlüssel, unter dem der Umzug der alten lokalen Liste auf den Server
 * vermerkt wird — **je Server, nicht global** (Bughunt 2026-08-20,
 * Fix-Runde 3: dasselbe Gerät kann in der Cloud UND auf einem Self-Host
 * eingetragen sein, `Freigegebener.serverId`; ein einzelner Merker liess den
 * Umzug für den zweiten Server dauerhaft ausfallen, sobald der erste erledigt
 * war). Der gespeicherte Wert ist ein Array der bereits erledigten
 * Server-IDs; die alte Form (ein blosses `true`) bleibt lesbar und heisst
 * „alles bisher Bekannte erledigt" (Begründung `umzugRegel.ts::serverBereitsUmgezogen`).
 * Seit 2026-08-20 entscheidet der Server (`device_grants` / `freigabe`-Feld an
 * `remote_request`), nicht mehr `nutzer`/`jeder` hier — die Werte unten sind ab
 * diesem Zeitpunkt nur noch der Vorrat für `versucheUmzug`, keine Quelle der
 * Wahrheit mehr.
 */
const UMZUG_SCHLUESSEL = 'remote.standplatz.umgezogen';

/** Was auf der Platte liegt. Bewusst schmal: alles, was sich ausrechnen lässt,
 *  wird ausgerechnet. */
interface Gespeichert {
  aktiv: boolean;
  /**
   * **Seit 2026-08-20 nicht mehr die Wahrheit.** Die Entscheidung „ohne
   * Rückfrage übernehmen" trifft der Server (`device_grants`, Feld `freigabe`
   * an `remote_request`) — dieses Feld ist nur noch der EINMALIGE Vorrat für
   * den Umzug (`#umziehenEinmal`). Es lebt nicht mehr als reaktives Feld auf
   * der Klasse, sondern nur noch als privater Instanz-Zustand
   * (`#umzugAltbestand`), der beim Sichern unangetastet zurückgeschrieben
   * wird — ein Zurücknehmen/Freigeben zwischen Laden und erfolgtem Umzug darf
   * den Altbestand nicht löschen, sonst hat ein späterer Umzugsversuch nichts
   * mehr zu lesen.
   */
  nutzer: Freigegebener[];
  /** Wie `nutzer`: nur noch Vorrat für den Umzug, keine Quelle der Wahrheit
   *  und kein reaktives Feld mehr. Siehe Kommentar dort. */
  jeder: boolean;
  geltung: Geltung;
  /** Bis wann die Freigabe gilt (ms seit Epoche), `null` = ohne Ablauf. */
  gueltigBis: number | null;
}

const LEER: Gespeichert = {
  aktiv: false,
  nutzer: [],
  jeder: false,
  geltung: 'befristet',
  gueltigBis: null,
};

function istGeltung(wert: unknown): wert is Geltung {
  return wert === 'befristet' || wert === 'dauerhaft';
}

/** Das Gespeicherte prüfen, statt ihm zu glauben. Die Datei ist von Hand
 *  editierbar, und ein kaputtes Feld darf hier nicht dazu führen, dass ein
 *  Gerät scharf steht, das niemand freigegeben hat — im Zweifel [`LEER`]. */
function ausSpeicher(roh: unknown): Gespeichert {
  if (!roh || typeof roh !== 'object') return { ...LEER };
  const o = roh as Record<string, unknown>;
  // **Ein Eintrag ohne Kanal wird verworfen, nicht ergänzt** (Bughunt
  // 2026-08-16). Freigaben aus der Zeit vor der Ortsbindung wissen nicht, wo
  // sie erteilt wurden — sie blind weitergelten zu lassen hiesse, genau das
  // Loch offenzulassen, gegen das der Kanal eingeführt wurde. Der Preis ist ein
  // Gang zum Gerät und ein neuer Haken; der andere Preis wäre der Rechner.
  const nutzer = Array.isArray(o.nutzer)
    ? o.nutzer.filter(
        (n): n is Freigegebener =>
          !!n &&
          typeof n === 'object' &&
          typeof (n as Freigegebener).serverId === 'string' &&
          typeof (n as Freigegebener).channelId === 'string' &&
          (n as Freigegebener).channelId.length > 0 &&
          typeof (n as Freigegebener).userId === 'string' &&
          (n as Freigegebener).userId.length > 0,
      )
    : [];
  return {
    aktiv: o.aktiv === true,
    nutzer,
    jeder: o.jeder === true,
    // Alte Stände: „acht_stunden" war befristet und trägt sein Ende in
    // `gueltigBis`; „neustart" verfällt ohnehin beim Laden (s. `laden`).
    geltung: istGeltung(o.geltung) ? o.geltung : o.geltung === 'dauerhaft' ? 'dauerhaft' : 'befristet',
    gueltigBis: typeof o.gueltigBis === 'number' && Number.isFinite(o.gueltigBis)
      ? o.gueltigBis
      : null,
  };
}

class StandplatzFreigabe {
  aktiv = $state(false);
  geltung = $state<Geltung>('befristet');
  gueltigBis = $state<number | null>(null);
  /** Ist der gespeicherte Stand schon gelesen? Bis dahin wird **nichts**
   *  selbsttätig zugestimmt — ein Rennen zwischen einer hereinkommenden
   *  Anfrage und dem Laden darf nicht zugunsten der Anfrage ausgehen. */
  geladen = $state(false);
  /**
   * Riegel gegen das ZWEITE Laden (Bughunt 2026-08-16).
   *
   * `app/+layout` wird neu aufgebaut, wenn sich jemand ohne Neuladen ab- und
   * wieder anmeldet — und jeder dieser Aufbauten hätte hier den „Neustart"
   * ausgelöst: eine geltende Freigabe mit Geltung `neustart` verfiel still,
   * wurde zurückgeschrieben, und der Standplatz stand ab da tot da. Dieselbe
   * Sperre wie in `anmeldung.svelte.ts` und `protokoll.svelte.ts`, die sie von
   * Anfang an hatten.
   */
  #gelesen = false;
  /**
   * Der rohe Umzugs-Merker aus dem Speicher, unverändert — `true` (legacy)
   * oder eine Liste erledigter Server-IDs. Aus dem Speicher gelesen, in
   * `laden()` gesetzt; ausgewertet von [`umzugRegel.ts::serverBereitsUmgezogen`],
   * IMMER mit der Server-ID des jeweiligen Aufrufs — der Umzug ist je Server
   * gedacht (Bughunt 2026-08-20, Fix-Runde 3), nicht global.
   */
  #umzugMerker: unknown = false;
  /**
   * Der aus dem Speicher gelesene Altbestand der alten lokalen Freigabeliste
   * (`nutzer`/`jeder`) — **nur noch Vorrat für `#umziehenEinmal`**, kein
   * reaktives Feld mehr (Umbau 2026-08-20, Punkt 3: die beiden Oberflächen,
   * die noch daran hingen, schreiben inzwischen auf die Server-Liste). Beim
   * Sichern wird er unverändert zurückgeschrieben (`#sichern`) — ein
   * Zurücknehmen/Freigeben, das zwischen dem Laden und einem erfolgreichen
   * Umzug passiert, darf den Altbestand nicht löschen, sonst hat ein
   * späterer Umzugsversuch (z. B. nach einem Netzfehler) nichts mehr zu
   * lesen.
   */
  #umzugAltbestand: { nutzer: Freigegebener[]; jeder: boolean } = { nutzer: [], jeder: false };
  /** Schutz gegen ZWEI überlappende Umzugs-Läufe FÜR DENSELBEN SERVER
   *  (Bughunt 2026-08-20, Fix-Runde 2): ein WS-Reconnect löst ein zweites
   *  `ready` aus, bevor der erste Lauf seine HTTP-Anfragen aufgelöst hat —
   *  ein zweiter Aufruf wartet über [`dedupliziertLaden`] auf denselben
   *  Lauf, statt parallel einen eigenen zu starten. **Schlüssel ist die
   *  Server-ID, kein fester Wert** (Fix-Runde 3): Cloud-Hintergrundverbindung
   *  und aktiver Self-Host feuern je ein eigenes `ready` mit eigenem
   *  `eintrag` — ein fester Schlüssel liess den Umzug für den zweiten Server
   *  im laufenden Überlappungsfenster verschlucken (`dedupliziertLaden` gibt
   *  bei belegtem Schlüssel das VORHANDENE Versprechen zurück, ohne die
   *  übergebene Closure je aufzurufen). Es gibt also einen eigenen Umzug JE
   *  SERVER, nicht einen je Client. */
  #umzugLaufend = new Map<string, Promise<void>>();

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
    if (this.#gelesen) return;
    this.#gelesen = true;
    // `vorgeladen` ist der schon gelesene Speicher: drei Module lesen beim
    // Start denselben Blob, und unter Electron ist jeder Griff ein eigener
    // IPC-Umlauf über die ganze Datei. Der Aufrufer liest einmal und reicht
    // durch (`app/+layout`); ohne Argument liest dieses Modul selbst.
    let stand: Gespeichert;
    let alle: Record<string, unknown> = {};
    try {
      alle = vorgeladen ?? (await loadAll());
      stand = ausSpeicher(alle[SPEICHER_SCHLUESSEL]);
    } catch {
      stand = { ...LEER };
    }
    // Eine befristete Freigabe ohne Ende ist ein alter „bis zum Neustart"-Stand:
    // dieser Aufruf IST der Neustart, also verfällt sie.
    const verfallen =
      (stand.geltung === 'befristet' && stand.gueltigBis === null && stand.aktiv) ||
      (stand.gueltigBis !== null && stand.gueltigBis <= Date.now());
    if (verfallen) stand = { ...stand, aktiv: false, gueltigBis: null };
    // Altbestand VOR `#uebernehmen`/`#sichern` merken: der Umzug (`#umziehenEinmal`)
    // liest ihn ausschliesslich hier heraus, nicht mehr über reaktive Felder.
    this.#umzugAltbestand = { nutzer: stand.nutzer, jeder: stand.jeder };
    this.#uebernehmen(stand);
    this.geladen = true;
    // Zurückschreiben, wenn die Freigabe gerade verfallen ist: sonst behauptet
    // die Datei für immer eine Freigabe, die kein Start je wieder annimmt —
    // und wer sie liest (Support, der Nutzer selbst), liest etwas Falsches.
    if (verfallen && (stand.jeder || stand.nutzer.length > 0)) await this.#sichern();
    this.#umzugMerker = alle[UMZUG_SCHLUESSEL];
  }

  /**
   * Die alte gerätelokale Freigabeliste einmal auf den Server schieben.
   *
   * **Warum das nicht aus `laden()` läuft.** Der Umzug braucht zwei Dinge, die
   * beim Laden noch nicht vorliegen: eine stehende Verbindung (für
   * `freigaben.laden`/`freigaben.setzen`) und die Gewissheit, welches Gerät
   * dieser Rechner auf DIESEM Server ist. `laden()` läuft in `app/+layout`
   * ausdrücklich VOR `gateway.connect()` — zu diesem Zeitpunkt lieferte ein
   * Versuch, den Server aus dem WS-Dispatch-Zustand zu erraten
   * (`dispatchenderServer()`), garantiert `null`, und der Umzug liefe bei
   * JEDEM Start ins Leere, ohne dass es je auffiele (Fix-Runde 1,
   * 2026-08-20). Beides liegt zusammen erst vor, wo sich das Gerät nach dem
   * Verbindungsaufbau anmeldet (`ws/handlers/ready.ts`) — der Aufrufer reicht
   * die Eintragung deshalb ausdrücklich herein, statt sie zu erraten.
   *
   * **Warum die Server-Liste zuerst gelesen wird.** `freigaben.setzen()` ist
   * PUT-Semantik und ersetzt die GANZE Liste auf dem Server. Feuerte der
   * Umzug blind, überschriebe er eine Liste, die dort inzwischen von Hand
   * gepflegt wurde. Ist sie nicht leer, gilt der Umzug deshalb als erledigt
   * (Merker setzen, nichts senden) — die genaue Regel steht importfrei in
   * `umzugRegel.ts`.
   *
   * Bis der Schub gelungen ist, bleibt die Datei stehen — scheitert er (kein
   * Netz, Server älter), wird es beim nächsten Start erneut versucht. Ein
   * verlorener Umzug hiesse: eine Freigabe, die jemand erteilt hat, gilt
   * plötzlich nicht mehr, ohne dass es jemand merkt.
   */
  async versucheUmzug(eintrag: { serverId: string; guildId: string; deviceId: string }): Promise<void> {
    if (serverBereitsUmgezogen(this.#umzugMerker, eintrag.serverId)) return;
    // Schlüssel = Server-ID, nicht fest: ein zweiter Aufruf für DENSELBEN
    // Server während ein Lauf noch offen ist, bekommt DESSEN Versprechen
    // zurück und wartet mit (Fix-Runde 2) — ein Aufruf für einen ANDEREN
    // Server läuft unabhängig daneben, statt verschluckt zu werden
    // (Fix-Runde 3, Begründung an `#umzugLaufend`).
    await dedupliziertLaden(this.#umzugLaufend, eintrag.serverId, () => this.#umziehenEinmal(eintrag));
  }

  async #umziehenEinmal(eintrag: {
    serverId: string;
    guildId: string;
    deviceId: string;
  }): Promise<void> {
    // Erneut prüfen: während ein früherer, überlappender Aufruf für
    // DENSELBEN Server auf DIESEN Lauf wartete, könnte er inzwischen schon
    // erledigt sein.
    if (serverBereitsUmgezogen(this.#umzugMerker, eintrag.serverId)) return;
    // **Nach Server gefiltert.** `#umzugAltbestand.nutzer` trägt eine
    // Server-Zuordnung (`Freigegebener.serverId`) — dasselbe Gerät kann in
    // der Cloud UND auf einem Self-Host eingetragen sein, und nur die
    // Einträge DIESES Servers dürfen zu DIESEM Gerät wandern.
    // `#umzugAltbestand.jeder` trägt dagegen keine Server-Zuordnung und war
    // immer global gemeint — der Schalter gilt für jeden Server, den man
    // migriert, nicht nur für einen.
    const lokalDiesesServers = this.#umzugAltbestand.nutzer.filter(
      (n) => n.serverId === eintrag.serverId,
    );
    const lokalVorhanden = this.#umzugAltbestand.jeder || lokalDiesesServers.length > 0;
    if (!lokalVorhanden) return;
    let serverListeLeer: boolean;
    try {
      await freigaben.laden(eintrag.guildId, eintrag.deviceId);
      serverListeLeer = freigaben.fuer(eintrag.deviceId).length === 0;
    } catch {
      return; // Kein Netz — der nächste Start versucht es erneut.
    }
    if (
      !umziehenNoetig({
        lokalVorhanden,
        serverListeLeer,
        bereitsUmgezogen: serverBereitsUmgezogen(this.#umzugMerker, eintrag.serverId),
      })
    ) {
      await this.#markiereServerUmgezogen(eintrag.serverId);
      return;
    }
    // **`expires_at: null` — unbefristet** (Fix zu Prüfbefund W-2, 2026-08-20).
    // Im Altbestand liefen `nutzer`/`jeder` nie ab, nur die Scharfschaltung des
    // Hauptschalters tat das. `this.#endeIso()` wäre die Frist des Haupt-
    // schalters gewesen — bei einem aktiven Gerät mit z. B. 8-Stunden-Fenster
    // wären alle migrierten Freigaben in 8 Stunden verfallen, obwohl der
    // Server den Umzug längst als erledigt vermerkt und den Altbestand nie
    // wieder liest. Die Befristung bleibt allein am Hauptschalter.
    const grants: GrantEingabe[] = this.#umzugAltbestand.jeder
      ? [{ subject_type: 'everyone', subject_id: null, expires_at: null }]
      : lokalDiesesServers.map((n) => ({
          subject_type: 'user' as const,
          subject_id: n.userId,
          expires_at: null,
        }));
    try {
      await freigaben.setzen(eintrag.guildId, eintrag.deviceId, grants);
      await this.#markiereServerUmgezogen(eintrag.serverId);
    } catch {
      // Netzfehler beim Schreiben: Merker bleibt aus, der nächste Start
      // versucht denselben Umzug erneut.
    }
  }

  /** Diesen EINEN Server als erledigt vermerken — andere Server im Merker
   *  bleiben unangetastet (Bughunt 2026-08-20, Fix-Runde 3). */
  async #markiereServerUmgezogen(serverId: string): Promise<void> {
    const bisher =
      this.#umzugMerker === true
        ? [] // legacy „alles erledigt" — ab hier zählt die Liste
        : Array.isArray(this.#umzugMerker)
          ? this.#umzugMerker.filter((s): s is string => typeof s === 'string')
          : [];
    this.#umzugMerker = bisher.includes(serverId) ? bisher : [...bisher, serverId];
    try {
      await saveAll({ [UMZUG_SCHLUESSEL]: this.#umzugMerker });
    } catch {
      // Wie überall in der Persistenz: der Zustand im Speicher gilt weiter —
      // der Merker ist beim nächsten Start weg, und der Umzug für DIESEN
      // Server läuft dann erneut. Bei einer schon leeren lokalen Liste
      // (Regelfall nach dem ersten Erfolg) ist das folgenlos.
    }
  }

  /**
   * Freigabe erteilen — der Hauptschalter. WER ohne Rückfrage darf, entscheidet
   * seit 2026-08-20 der Server (`device_grants`); hier bleibt nur noch „ob
   * überhaupt" und „wie lange".
   */
  async freigeben(opts: {
    geltung: Geltung;
    /** Länge der Spanne bei `befristet`. Fehlt sie, gilt eine Stunde — die
     *  kürzeste sinnvolle Zusage, nicht die längste. */
    dauerMs?: number;
  }): Promise<void> {
    this.#uebernehmen({
      aktiv: true,
      geltung: opts.geltung,
      gueltigBis:
        opts.geltung === 'befristet' ? Date.now() + (opts.dauerMs ?? STUNDE_MS) : null,
    });
    await this.#sichern();
  }

  /** Freigabe zurücknehmen. */
  async zuruecknehmen(): Promise<void> {
    this.aktiv = false;
    this.gueltigBis = null;
    await this.#sichern();
  }

  /**
   * Der eine Entscheidungspunkt. Die Liste liegt seit 2026-08-20 auf dem
   * Server (`device_grants`); hier bleibt der Hauptschalter.
   */
  selbsttaetigZustimmen(freigabeVomServer: boolean): boolean {
    return selbsttaetig({
      geladen: this.geladen,
      aktiv: this.aktiv,
      freigabe: freigabeVomServer,
    });
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

  /** Das Ende der aktuellen Freigabe als ISO-Zeitstempel, `null` = ohne
   *  Ablauf — dieselbe Bedeutung wie `gueltigBis`, nur in der Wire-Form, die
   *  der Server für `expires_at` erwartet. */
  #endeIso(): string | null {
    return this.gueltigBis === null ? null : new Date(this.gueltigBis).toISOString();
  }

  #uebernehmen(stand: { aktiv: boolean; geltung: Geltung; gueltigBis: number | null }): void {
    this.aktiv = stand.aktiv;
    this.geltung = stand.geltung;
    this.gueltigBis = stand.gueltigBis;
  }

  async #sichern(): Promise<void> {
    // `nutzer`/`jeder` kommen unverändert aus `#umzugAltbestand` — dieser
    // Schreibpfad ist selbst nach dem Wegfall der reaktiven Felder noch der
    // einzige, der die Datei berührt, und er darf den Altbestand nicht
    // verlieren, solange `#umziehenEinmal` ihn noch nicht abgeholt hat.
    const stand: Gespeichert = {
      aktiv: this.aktiv,
      nutzer: this.#umzugAltbestand.nutzer,
      jeder: this.#umzugAltbestand.jeder,
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
