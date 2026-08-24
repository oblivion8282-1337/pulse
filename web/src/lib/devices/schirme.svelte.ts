/**
 * Standplatz-Geräte — **welche Bildschirme es gibt und wie man einen holt**.
 *
 * Herausgelöst, weil es seit dem Menü im Player-Fenster **zwei** Stellen gibt,
 * an denen jemand einen Bildschirm anfordert:
 *
 * * die Geräteansicht in der App (`DeviceView.svelte`) — vor dem Übernehmen,
 * * das Menü am Griff im Player-Fenster (`overlay/fernbedienung.rs`) — während
 *   man steuert, denn dort schaut der Steuernde gerade hin.
 *
 * Beide brauchen dieselbe Entscheidung: läuft dieser Schirm schon, hol sein
 * Fenster nach vorne; läuft er nicht, wecke ihn und öffne das Fenster, sobald
 * das Bild da ist. Ein zweiter Nachbau davon liefe unweigerlich auseinander —
 * und zwar an der unauffälligsten Stelle, dem Erkennen, ob ein Schirm schon
 * läuft.
 *
 * **Das Player-Fenster entscheidet nichts selbst.** Es kennt weder das Gerät
 * noch die Sitzung beim Server; es meldet nur „der Nutzer hat Bildschirm 2
 * gewählt". Dasselbe Muster wie beim Chat-Knopf und bei „Fernsteuerung
 * beenden".
 */

import type { Device, DeviceMonitor } from '$lib/api/devices';
import { geraetWecken } from './wecken';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { stromPasstZuMonitor } from '$lib/stream/settingsCatalog';
import { openedTiles } from '$lib/stream/openedTiles.svelte';
import { hqTileId } from '$lib/stream/hqTile';
import { nativeWindowRequests } from '$lib/player/wuensche.svelte';
import { nativePlayerSessions } from '$lib/player/store.svelte';
import { remoteSession } from '$lib/remote/session.svelte';
import { darfFernsteuern } from '$lib/remote/darfSteuern';
import { activeServer } from '$lib/stores/active-server.svelte';
import { m } from '$lib/paraglide/messages.js';

/**
 * Wie lange auf das erste Bild gewartet wird.
 *
 * Grosszügig: der Rechner muss den Encoder hochfahren, und auf einer
 * ausgelasteten Maschine dauert das. Zu kurz gewählt hiesse, dass die
 * Oberfläche „hat nicht geantwortet" sagt, während der Stream gerade anläuft —
 * der schlechteste Zeitpunkt für eine Absage.
 */
const WARTEN_MS = 25_000;

/** Ein Bildschirm samt der einen Angabe, die beide Oberflächen brauchen. */
export interface SchirmStand extends DeviceMonitor {
  /** Läuft er schon in einem Fenster? */
  open: boolean;
}

/** Alle Ströme des Besitzers in diesem Standplatz — von Hand gestartete wie
 *  geweckte. */
function stroemeVon(device: Device) {
  return streamPresence
    .streamsIn(device.channel_id)
    .filter((s) => s.user_id === device.owner_user_id);
}

/** Ein einzelner Strom, wie `stroemeVon` ihn liefert. */
type Strom = ReturnType<typeof stroemeVon>[number];

/**
 * Zeigt dieser Strom diesen Bildschirm?
 *
 * **Die Nummer gewinnt, wenn sie da ist** (`monitor_index`, die Bildschirm-
 * Nummer, die das Gerät beim Start wirklich aufgenommen hat) — die reine Regel
 * dazu sitzt in `settingsCatalog.ts::stromPasstZuMonitor`, importfrei und
 * daher für Nodes eingebauten Testläufer erreichbar (diese Datei zieht Stores
 * und ist es nicht). Nur Klienten, die die Nummer noch nicht mitschicken,
 * fallen auf den **Namen** zurück, den das Gerät beim Start mitgeschickt hat
 * (`stream/starten.ts` nimmt ihn aus der wirklich aufgenommenen Quelle);
 * **verglichen wird dort nachsichtig** (Rand und Gross-/Kleinschreibung egal),
 * weil ein Unterschied hier nicht auffällt, sondern still das Falsche tut: der
 * Schirm gälte als frei und stünde erneut zur Wahl.
 */
function passt(strom: { label?: string; monitor_index?: number }, mon: DeviceMonitor): boolean {
  // Ohne Nummer und ohne Namen ist nichts zuzuordnen — dann passt dieser Strom
  // zu keinem Bildschirm. Genau dieser Fall greift unten den Hauptbildschirm auf.
  return stromPasstZuMonitor(strom, mon);
}

/**
 * Die Bildschirme, die dieses Gerät hat.
 *
 * Meldet es keine (nie verbunden oder ältere Fassung), bleibt genau ein Eintrag
 * übrig: sein Hauptbildschirm. Das ist ehrlicher als eine erfundene Liste — und
 * der eine Knopf tut, was er immer getan hat.
 */
function monitorListe(device: Device): DeviceMonitor[] {
  if (device.monitors.length > 0) return device.monitors;
  return [{ index: 0, name: m.device_view_screen_primary(), primary: true }];
}

/**
 * Welcher Strom zeigt welchen Bildschirm — die **eine** Zuordnung, an der beide
 * Fragen hängen: „läuft der schon?" und „welchen Strom mache ich auf, wenn
 * jemand zusehen will?".
 *
 * Beide getrennt zu beantworten hiesse, dass ein Bildschirm als laufend gilt,
 * dessen Strom sich nicht finden lässt — dann steht ein Knopf da, der wortlos
 * nichts tut. Genau diese Sorte Fehler soll hier verschwinden.
 *
 * **Der Hauptbildschirm bekommt zusätzlich einen Strom des Geräts zugeordnet,
 * dessen Name zu keinem Schirm passt** (Bughunt 2026-08-17). Der Grund steht in
 * `wecken.ts::quelleFuerMonitor`: der Haupt-Knopf („Übernehmen")
 * schickt **keine** Nummer mit, das Gerät nimmt dann die Quelle seines
 * Standplatz-Profils — und das ist per Vorgabe sein Hauptbildschirm. Trägt
 * dieser erste Strom einen Namen, der nicht trifft (Profil auf eine andere
 * Quelle gestellt, Bildschirmliste seit dem Start verändert, allgemeiner
 * Ersatzname), galt der Hauptbildschirm als frei und wurde erneut angeboten.
 * Ein Klick darauf lief dann ins Nichts: das Gerät erkennt die schon laufende
 * Quelle und verwirft den Ruf (`wecken.ts`), es ging kein zweites Fenster auf,
 * und für den Steuernden sah es aus, als sei der Player verschwunden.
 *
 * **Nur Ströme des Geräts zählen dafür** (`device.stream_slots`, dieselbe
 * Quelle wie in `darstellung.ts::stromGehoertGeraet`): was der Besitzer von
 * Hand überträgt — ein Fenster, eine Anwendung — sagt nichts über seine
 * Bildschirme. Meldet ein Gerät seine Plätze nicht (ältere Fassung), bleibt es
 * beim reinen Namensvergleich.
 *
 * **Annahme, die falsch sein kann:** dass ein namenlos zugeordneter Gerätestrom
 * der Hauptbildschirm ist. Steht im Profil ausdrücklich ein anderer Schirm, ist
 * er es nicht — dann fehlt der Hauptbildschirm in der Auswahl, obwohl er zu
 * holen wäre. Das ist die harmlosere Hälfte: ein Eintrag zu wenig fällt auf,
 * ein Eintrag, der wortlos nichts tut, fällt nicht auf.
 */
function zuordnung(device: Device): Map<number, Strom> {
  const stroeme = stroemeVon(device);
  const liste = monitorListe(device);
  const karte = new Map<number, Strom>();
  for (const mon of liste) {
    const treffer = stroeme.find((s) => passt(s, mon));
    if (treffer) karte.set(mon.index, treffer);
  }
  const geraetePlaetze = new Set(device.stream_slots ?? []);
  // Ein Strom MIT Nummer ist nie "namenlos" — auch dann nicht, wenn seine
  // Nummer zu keinem aktuell gemeldeten Schirm passt (Profil auf eine
  // inzwischen verschwundene Quelle gestellt). Er darf über diesen Notbehelf
  // nie einem anderen Bildschirm zugeschlagen werden: die Nummer ist eine
  // ausdrueckliche, verlaessliche Angabe, kein Ratefall wie ein fehlender Name.
  const namenlos = stroeme.find(
    (s) =>
      s.monitor_index === undefined &&
      geraetePlaetze.has(s.slot) &&
      !liste.some((mon) => passt(s, mon)),
  );
  const haupt = liste.find((mon) => mon.primary);
  // Einen Schirm, der schon seinen eigenen Strom hat, nicht überschreiben:
  // der zugeordnete ist der genauere.
  if (namenlos && haupt && !karte.has(haupt.index)) karte.set(haupt.index, namenlos);
  return karte;
}

/** Ist die Zuordnung Strom → Bildschirm fuer dieses Geraet eindeutig?
 *
 *  Unklar wird sie, wenn ein Strom OHNE Nummer auf mehr als einen Bildschirm
 *  passen wuerde — zwei baugleiche Monitore beim Host und ein Klient, der die
 *  Nummer noch nicht mitschickt. Teil 2 behauptet dann kein „du bist hier":
 *  ein fehlender Hinweis faellt auf und ist harmlos, ein falscher faellt nicht
 *  auf.
 *
 *  Rechnet ueber dieselben Bausteine wie `zuordnung()` (`stroemeVon`,
 *  `monitorListe`, `passt`) — keine zweite Aufloesung daneben, sonst liefen
 *  beide auseinander. Ein Strom MIT Nummer gilt immer als eindeutig — genau
 *  deshalb wurde sie eingefuehrt. */
export function zuordnungEindeutig(device: Device): boolean {
  const stroeme = stroemeVon(device);
  const liste = monitorListe(device);
  return stroeme.every((s) => {
    if (s.monitor_index !== undefined) return true;
    return liste.filter((mon) => passt(s, mon)).length <= 1;
  });
}

/** Die Bildschirme eines Geräts, jeder mit „läuft schon". */
export function schirmeVon(device: Device): SchirmStand[] {
  const karte = zuordnung(device);
  return monitorListe(device).map((mon) => ({ ...mon, open: karte.has(mon.index) }));
}

/** Der laufende Strom eines Bildschirms, oder `undefined`. */
function stromFuer(device: Device, mon: DeviceMonitor) {
  return zuordnung(device).get(mon.index);
}

/**
 * Das Fenster eines laufenden Stroms öffnen (oder nach vorne holen).
 *
 * **Beides gehört hier zusammen** (2026-08-16): die Kachel aufmachen *und* sie
 * ins eigene Player-Fenster schicken. Ein Gerät weckt man, um es zu übernehmen
 * — und die Fernsteuerung gibt es ausschliesslich im nativen Fenster
 * (Zeigerfang, rohe Scancodes, der Anfrage-Knopf). Bis hierher öffnete der
 * Weckruf nur die Kachel; das Fenster kam erst über den Abkoppel-Knopf oder
 * über `playerSettings.useNativePlayer`, eine Vorgabe ohne Oberfläche, die per
 * Vorgabe aus ist. Der Weckruf endete also im `<video>`-Weg — ohne
 * Übernahme-Weg und ohne die Latenzmassnahmen des Fern-Modus.
 *
 * Fehlt das Player-Binary (Browser, unfertiger Bau), ist die Anforderung
 * folgenlos: `useNativePlayback` prüft zusätzlich `isPlayerAvailable()` und
 * bleibt sonst beim `<video>`. Der Zuschauer kann sie danach jederzeit mit dem
 * Abkoppel-Knopf zurücknehmen — `zugemacht` gewinnt gegen diese Anforderung,
 * bis der nächste Weckruf kommt.
 */
function fensterOeffnen(device: Device, slot: number, uebernahme = true): void {
  openedTiles.open('hq', device.channel_id, hqTileId(device.owner_user_id, slot));
  nativeWindowRequests.request(device.channel_id, device.owner_user_id, slot);
  // **Und nach vorne damit** (Bughunt 2026-08-16). Modulkopf und der Vertrag
  // im Player (`overlay/typen.rs`) versprechen beides — „hol sein Fenster nach
  // vorne" —, aber die Anforderung oben ist für ein schon offenes Fenster ein
  // No-op: sie ist bereits erfüllt. Wer aus der Geräteansicht oder aus dem Menü
  // am Griff einen laufenden Bildschirm wählte, sah deshalb gar nichts
  // passieren, obwohl das Fenster hinter der App lag.
  nativePlayerSessions.get(device.channel_id, device.owner_user_id, slot)?.focus();
  if (uebernahme) uebernehmen(device, slot);
}

/**
 * Die Fernsteuerung anfordern, sobald das Bild da ist.
 *
 * **Warum das hier selbsttätig geschieht und nicht am Knopf des Zuschauers**
 * (Änderung 2026-08-16): bei einem Standplatz-Gerät heisst der eine Knopf
 * „Übernehmen", und genau das soll er tun. Die Zustimmung ist bei
 * diesen Geräten **vorverlegt** — sie steht als Dauerfreigabe, lange bevor
 * jemand klickt. Ein zweiter Knopf „Fernsteuerung anfragen" fragte also etwas,
 * das schon beantwortet ist, und liesse den Steuernden vor einem Bild sitzen,
 * das er nicht bedienen kann.
 *
 * **Nach dem Bild, nicht davor.** Der Grund aus `wecken.ts` bleibt unberührt:
 * eine Sitzungszusage darf nicht an einer Encoder-Initialisierung hängen.
 * Deshalb weiterhin zwei Vorgänge — wecken, warten, und erst wenn das Fenster
 * aufgeht, die unveränderte `remote_request`. Scheitert das Wecken, gab es nie
 * eine Anfrage.
 *
 * Zwei Fälle, die von selbst richtig laufen: ein **zweiter Bildschirm** fordert
 * nichts nach (`request()` springt bei laufender Sitzung früh zurück, und der
 * Drahtvertrag trägt die Platznummer in jeder Nachricht — eine Sitzung bedient
 * alle Schirme), und **ohne `REMOTE_CONTROL`** wird gar nicht erst gefragt: der
 * Gateway wiese es mit 4051 ab, der Besitzer sähe vorher noch einen
 * Zustimmungs-Dialog für nichts.
 *
 * Der Knopf an der Kachel bleibt bestehen — er ist danach das „Beenden" und der
 * Weg zurück, wenn die Anfrage doch einmal ins Leere lief.
 */
function uebernehmen(device: Device, slot: number): void {
  if (!darfFernsteuern(device.channel_id, device.owner_user_id)) return;
  // **Nicht dazwischenfunken** (2026-08-16): steuert schon jemand, ist der
  // Gateway ohnehin dagegen (4054, eine Sitzung je Gerät) — der Zuschauer bekäme
  // für einen Klick, mit dem er nur zusehen wollte, eine Fehlermeldung. Steuert
  // man selbst, springt `request()` bei laufender Sitzung früh zurück; dieser
  // Riegel meint also genau den Fall „ein anderer hat ihn".
  if (device.state === 'busy') return;
  remoteSession.request(device.channel_id, device.owner_user_id, slot);
}

/**
 * Einem laufenden Bildschirm **nur zusehen** — ohne Übernahme-Anfrage.
 *
 * Der zweite der beiden Wege, die es an einem Gerät gibt, und der leisere:
 * Zusehen braucht nur das Recht, den Kanal zu sehen, Übernehmen braucht
 * `REMOTE_CONTROL` und eine Zustimmung. Sie zu vermischen hiess, dass ein
 * Dritter mit dem Recht eine Sitzung anfragte, obwohl er bloss das Bild wollte
 * — und dass einer ohne das Recht gar nicht an das Bild kam, das im Kanal für
 * jeden offen liegt.
 *
 * Läuft der Bildschirm nicht, geschieht nichts: was niemand überträgt, kann
 * man nicht ansehen, und wecken darf hier bewusst nur, wer auch übernehmen darf.
 */
export function zusehen(device: Device, mon: DeviceMonitor): void {
  const laufend = stromFuer(device, mon);
  if (!laufend) return;
  fensterOeffnen(device, laufend.slot, false);
}

/**
 * Der Schlüssel eines Wunsches: **Gerät UND Bildschirm**.
 *
 * **Der Grund** (Bughunt 2026-08-16): geschlüsselt war nur nach Gerät, während
 * die Knöpfe je Bildschirm freigegeben sind. Wer Monitor 2 anforderte und kurz
 * darauf Monitor 3, überschrieb damit den ersten Wunsch — für einen der beiden
 * ging nie ein Fenster auf, und sein Zeitgeber lief ins Leere. Genau der
 * Ablauf, für den die Bildschirmliste gebaut ist.
 */
function schluessel(deviceId: string, index: number): string {
  return `${deviceId}:${index}`;
}

/**
 * Worauf gerade gewartet wird — je Gerät und Bildschirm ein Wunsch.
 *
 * Als Modul-Zustand und nicht in der Komponente, weil die Anforderung aus dem
 * Player-Fenster kommen kann, während die Geräteansicht gar nicht gemountet
 * ist. Die Wartezeit läuft dann trotzdem, und das Fenster geht auf, sobald das
 * Bild da ist. Der Preis dafür steht in [`reset`]: was einen Serverwechsel
 * überdauern kann, muss dort auch fallen gelassen werden.
 */
class SchirmWarten {
  /** `deviceId:index` → Bildschirm, auf den gewartet wird. */
  offen = $state<Record<string, DeviceMonitor>>({});
  /**
   * `deviceId:index` → welche Plätze beim Anfordern schon liefen.
   *
   * **Der Grund** (Bughunt 2026-08-16): das Netz in [`einloesen`] nahm
   * irgendeinen Strom dieses Geräts, falls der Name nicht traf — und beim
   * Dazuschalten eines zweiten Bildschirms lief immer schon einer. Das Netz
   * griff also sofort, löste den Wunsch mit dem BEREITS offenen Fenster ein und
   * räumte ihn ab. Der dazugeschaltete Bildschirm bekam nie ein Fenster; der
   * Knopf sah aus, als hätte er nichts getan. Nur ein Strom, der beim
   * Anfordern noch nicht lief, kann der gemeinte sein.
   */
  readonly #vorher = new Map<string, Set<number>>();
  readonly #wecker = new Map<string, ReturnType<typeof setTimeout>>();
  /** Letzter Fehlschlag je Gerät, für die Anzeige. Bewusst nach Gerät und nicht
   *  nach Bildschirm: die Geräteansicht hat eine Fehlerzeile, keine je Knopf. */
  fehler = $state<Record<string, string>>({});

  /** Irgendein offener Wunsch dieses Geräts — für „wird geweckt…" am
   *  Haupt-Knopf, der keinen bestimmten Bildschirm meint. */
  wartetAuf(deviceId: string): DeviceMonitor | null {
    const treffer = Object.entries(this.offen).find(([k]) => k.startsWith(`${deviceId}:`));
    return treffer ? treffer[1] : null;
  }

  /** Wartet gerade jemand auf GENAU diesen Bildschirm? */
  wartetAufSchirm(deviceId: string, index: number): boolean {
    return schluessel(deviceId, index) in this.offen;
  }

  /**
   * Einen Bildschirm anfordern.
   *
   * Läuft er schon, geht sein Fenster sofort auf — ohne Weckruf. Der wäre zwar
   * harmlos (das Gerät verwirft ihn), aber der Umweg über „warten" liesse den
   * Knopf ohne Grund eine Sekunde lang beschäftigt aussehen.
   *
   * `ausdruecklich` trennt die beiden Wege, die hier zusammenlaufen: die
   * Bildschirmliste meint einen bestimmten Schirm und nennt seine Nummer, der
   * Haupt-Knopf („Übernehmen") meint dagegen „den, den du herzeigen
   * willst" und nennt keine — dort entscheidet das Standplatz-Profil des
   * Geräts (Begründung in `wecken.ts::quelleFuerMonitor`).
   */
  holen(device: Device, mon: DeviceMonitor, ausdruecklich = true): void {
    delete this.fehler[device.id];
    const laufend = stromFuer(device, mon);
    if (laufend) {
      fensterOeffnen(device, laufend.slot);
      return;
    }
    // `index: 0` ist der Ersatz-Eintrag ohne Bildschirmliste — dann ebenfalls
    // ohne Nummer wecken, und das Gerät nimmt, was sein Profil sagt.
    const nummer = ausdruecklich ? mon.index || undefined : undefined;
    // Der Server des Geräts ist der aktive: der Geräte-Speicher wird beim
    // Serverwechsel geleert (`stores/multi-server-reset.ts`), ein Gerät in der
    // Hand gehört also immer zur aktiven Verbindung.
    if (!geraetWecken(activeServer.serverId, device.id, nummer)) {
      this.fehler[device.id] = m.device_view_wake_failed();
      return;
    }
    const k = schluessel(device.id, mon.index);
    this.offen[k] = mon;
    this.#vorher.set(
      k,
      new Set(
        streamPresence
          .streamsIn(device.channel_id)
          .filter((s) => s.user_id === device.owner_user_id)
          .map((s) => s.slot),
      ),
    );
    const alt = this.#wecker.get(k);
    if (alt) clearTimeout(alt);
    this.#wecker.set(
      k,
      setTimeout(() => {
        this.#aufraeumen(k);
        this.fehler[device.id] = m.device_view_wake_failed();
      }, WARTEN_MS),
    );
  }

  /**
   * Prüfen, ob ein erwartetes Bild da ist — aus einem Effect gerufen, weil die
   * Ströme asynchron erscheinen und der Klick noch nicht weiss, wann.
   *
   * Geht über ALLE offenen Wünsche dieses Geräts: es können mehrere sein, und
   * sie werden nicht der Reihe nach fertig.
   *
   * Liefert `true`, wenn mindestens ein Fenster geöffnet wurde.
   */
  einloesen(device: Device): boolean {
    let geoeffnet = false;
    for (const k of Object.keys(this.offen)) {
      if (!k.startsWith(`${device.id}:`)) continue;
      const ziel = this.offen[k];
      const vorher = this.#vorher.get(k) ?? new Set<number>();
      const strom =
        stromFuer(device, ziel) ??
        // Netz für den Fall, dass der Name nicht trifft: ein NEUER Strom dieses
        // Geräts ist besser als gar keiner. Neu heisst: er lief beim Anfordern
        // noch nicht — sonst löste das Netz den Wunsch sofort mit dem Bildschirm
        // ein, der ohnehin schon offen war (s. `#vorher`).
        streamPresence
          .streamsIn(device.channel_id)
          .find((s) => s.user_id === device.owner_user_id && !vorher.has(s.slot));
      if (!strom) continue;
      this.#aufraeumen(k);
      // Diesen Platz für die übrigen Wünsche DESSELBEN Geräts verbrauchen,
      // sonst löste ihr Netz sie mit demselben Strom ein — und der zweite
      // angeforderte Bildschirm bekäme wieder kein eigenes Fenster. Nur
      // dieses Gerät: Plätze sind je Übertragendem gezählt, bei einem anderen
      // Gerät verdeckte dieselbe Nummer einen fremden, gültigen Strom.
      for (const [rk, rest] of this.#vorher) {
        if (rk.startsWith(`${device.id}:`)) rest.add(strom.slot);
      }
      fensterOeffnen(device, strom.slot);
      geoeffnet = true;
    }
    return geoeffnet;
  }

  /**
   * Alles fallen lassen — Abmelden und Serverwechsel.
   *
   * **Warum das gebraucht wird** (Bughunt 2026-08-16): dieser Zustand ist ein
   * Modul-Singleton und überlebt beides. Ohne Rücknahme liefen die Zeitgeber
   * eines Wunsches weiter, schrieben danach eine Fehlermeldung zu einem Gerät,
   * das der nächste Nutzer gar nicht kennt — und die Meldung blieb dort stehen,
   * denn gelöscht wird sie erst beim nächsten Klick auf dasselbe Gerät.
   */
  reset(): void {
    for (const w of this.#wecker.values()) clearTimeout(w);
    this.#wecker.clear();
    this.#vorher.clear();
    this.offen = {};
    this.fehler = {};
  }

  #aufraeumen(k: string): void {
    const w = this.#wecker.get(k);
    if (w) clearTimeout(w);
    this.#wecker.delete(k);
    this.#vorher.delete(k);
    delete this.offen[k];
  }
}

export const schirmWarten = new SchirmWarten();
