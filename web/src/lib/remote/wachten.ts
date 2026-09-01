/**
 * Fernsteuerung — die Wachten einer Sitzung.
 *
 * Drei kleine Aufpasser, die der Session-Store (`session.svelte.ts`) je nach
 * Phase an- und abschaltet. Sie liegen hier, weil sie zusammen mehr Platz
 * einnehmen als die Zustandsmaschine selbst, und weil keiner von ihnen etwas
 * über die Zustandsmaschine wissen muss: jeder bekommt seine Verbindung und
 * seinen Rückruf herein und gibt seinen Abbruch zurück.
 *
 * Alle drei arbeiten auf einer FESTGEHALTENEN Verbindung (`GatewayConnection`),
 * nicht auf dem `gateway`-Proxy: eine Sitzung gehört zu genau dem Server, auf
 * dem sie zustande kam — der Proxy zeigt dagegen immer auf den gerade aktiven
 * (Begründung ausführlich im Store bei `#conn`).
 */

import type { GatewayConnection } from '$lib/ws/connection';
import { CLIENT_GRACE_MS, Gnadenfrist } from './gnadenfrist';

/** Jede Wacht liefert die Funktion, die sie wieder abstellt. Zweimal gerufen
 *  ist folgenlos. */
export type Abbruch = () => void;

/**
 * Platz für genau EINE laufende Wacht.
 *
 * Der Store schaltet jede seiner Wachten je nach Phase mehrfach an und aus.
 * Ohne diesen Halter braucht jede ein eigenes Feld plus ein An/Aus-Paar, das
 * dreimal wortgleich dasselbe tut: die vorige abstellen, die neue merken.
 *
 * [`an`] stellt die vorige ab, BEVOR es die neue startet — nicht danach. Sonst
 * liefen zwei Wachten kurz nebeneinander, und bei einer, die sich beim Start
 * irgendwo einträgt (`fehlerWacht`), hinge die Reihenfolge des Ab- und
 * Anmeldens am Innenleben des Abonnements.
 */
export class WachtSchalter {
  #ab: Abbruch | null = null;

  an(starten: () => Abbruch): void {
    this.aus();
    this.#ab = starten();
  }

  aus(): void {
    this.#ab?.();
    this.#ab = null;
  }
}

/**
 * Verbindung weg = Gnadenfrist, nicht sofort Sitzung weg.
 *
 * **Bis 2026-08-19 beendete der Gateway jede Sitzung eines abgerissenen
 * Sockets sofort und ohne Schonfrist** (`cleanup_remote_on_disconnect`) — nur
 * erfuhr genau die Seite, deren Socket abriss, davon nichts mehr. Auf dem
 * gemeinsamen Remote-Dev-Stack (Electron → lokales Vite als Umweg → Internet
 * → Hetzner) reisst ein Socket alle paar Minuten ab, unabhängig davon, was
 * gerade getan wird — jeder Backend-Sync dort lädt `uvicorn --reload` neu und
 * trennt dabei JEDEN angeschlossenen Socket, gemessen bis zu 8 s bei zwei
 * Reload-Läufen kurz hintereinander. Eine echte, funktionierende Sitzung
 * starb an genau so einem Wackler nach 37 Sekunden (Bughunt 2026-08-19).
 *
 * Seit dem gilt: die Verbindung darf bis zu [`CLIENT_GRACE_MS`] weg sein, ohne
 * dass etwas passiert. Kommt sie in der Frist zurück (ein `ready`-Frame auf
 * DERSELBEN `GatewayConnection`, s. Moduldoc oben — dieselbe Verbindung
 * reconnectet selbst, mit eigenem Backoff), schickt diese Wacht ein
 * `remote_reclaim` und wartet auf die Bestätigung — der Server hält die
 * Sitzung serverseitig genauso lang offen (`remote_reconnect_registry.py`,
 * mit etwas Vorsprung für den Client, s. `gnadenfrist.ts`). Bleibt sie aus,
 * scheitert der Reclaim ausdrücklich, oder läuft die Frist ab: erst DANN
 * `beiEndgueltigemVerlust`, wie früher `beiVerlust` sofort.
 *
 * **Wiederholte Abrisse verlängern die Frist**, statt die alte auslaufen zu
 * lassen (`Gnadenfrist`) — eine flatternde Verbindung bekommt so bei jedem
 * Versuch die volle Frist.
 *
 * **Ereignis statt Takt**, wie zuvor: der Host spielt womöglich im Vollbild,
 * das Pulse-Fenster ist verdeckt oder minimiert, und Chromium drosselt dort
 * jeden Zeitgeber auf höchstens einen Lauf pro Minute — der Zeitgeber HIER
 * ist nur das Netz für die Frist selbst (deren Ablauf darf ruhig etwas
 * spät bemerkt werden), der Regelweg bleibt `conn.onClose`/`conn.on('ready')`.
 *
 * Der Zustand wird zusätzlich EINMAL sofort geprüft: die Verbindung kann
 * bereits weg sein, wenn die Wacht startet — dann käme nie ein Ereignis mehr,
 * und es gibt nichts zu retten. `beiEndgueltigemVerlust` läuft in dem Fall
 * noch aus diesem Ruf heraus (der Aufrufer, `WachtSchalter.an`, verträgt das).
 *
 * **`beiWiederhergestellt` feuert bei einem geglückten Reclaim** — und nur
 * dann (Bughunt 2026-08-19, zweite Runde, Befund 5/6): der Aufrufer behauptet
 * darüber alles noch Gehaltene erneut (Hello + `nachziehBuendel`, wie beim
 * Rückfall Kanal→Serverweg). Ohne das blieb eine vom Steuernden gehaltene
 * Taste nach einem Reclaim am fernen Rechner hängen — vor der Gnadenfrist
 * erledigte das `#reset()` → `eingabeFreigeben()` beim Sofort-Ende; die Frist
 * hat diesen Aufräumer ersetzt, ohne ihn zu ersetzen.
 */
export function verbindungsWachtMitGnadenfrist(
  conn: GatewayConnection | null,
  sessionId: string,
  reclaimSenden: () => boolean,
  beiWiederhergestellt: () => void,
  beiEndgueltigemVerlust: () => void,
): Abbruch {
  if (!conn || !istOffen(conn)) {
    beiEndgueltigemVerlust();
    return () => {};
  }
  const frist = new Gnadenfrist();
  let generation = 0;
  let zeitgeber: ReturnType<typeof setTimeout> | null = null;

  // Vorab deklariert (statt als `const` nach den beiden Anmeldungen unten),
  // weil sowohl der Zeitgeber als auch der Frame-Zuhörer sich selbst wieder
  // abmelden müssen, sobald sie endgültig aufgeben — beide brauchen `ab`
  // schon in ihrem eigenen Rumpf. Feuert erst, NACHDEM die Funktion unten
  // fertig durchlaufen ist, also längst zugewiesen.
  let ab: Abbruch = () => {};

  const zeitgeberAbraeumen = (): void => {
    if (zeitgeber !== null) clearTimeout(zeitgeber);
    zeitgeber = null;
  };

  const abClose = conn.onClose(() => {
    generation = frist.verloren(Date.now(), CLIENT_GRACE_MS);
    zeitgeberAbraeumen();
    zeitgeber = setTimeout(() => {
      // Doppelt geprüft, wie serverseitig in `_disconnect_grace_expired`: ein
      // spät auslösender Zeitgeber (Chromium-Drosselung im Hintergrund) darf
      // eine zwischenzeitlich verlängerte oder wiederhergestellte Frist nicht
      // mehr beenden.
      if (frist.abgelaufen(Date.now())) {
        ab();
        beiEndgueltigemVerlust();
      }
    }, CLIENT_GRACE_MS);
  });
  const abFrame = conn.on((evt) => {
    if (evt.op === 'ready') {
      // Verbindung wieder da — nur reklamieren, wenn gerade wirklich eine
      // Frist läuft (ein `ready` ohne vorherigen Abriss ist der Normalfall
      // bei jeder anderen Sitzung und geht diese Wacht nichts an).
      if (frist.aktiv) reclaimSenden();
      return;
    }
    if (evt.op !== 'remote_reclaimed' && evt.op !== 'remote_reclaim_failed') return;
    if (evt.session_id !== sessionId) return;
    if (evt.op === 'remote_reclaimed') {
      frist.wiederhergestellt(generation);
      // Nur feuern, wenn DIESER Aufruf die Frist wirklich beendet hat — ein
      // Echo zu einer bereits überholten Generation (s. `Gnadenfrist`) lässt
      // `aktiv` unverändert `true` und darf hier nichts auslösen.
      if (!frist.aktiv) beiWiederhergestellt();
      return;
    }
    // Ausdrücklich gescheitert (fremde Rolle/fremder Nutzer, Sitzung schon
    // weg, Frist serverseitig schon abgelaufen) — nicht auf den eigenen
    // Zeitgeber warten, der Server hat schon geantwortet.
    //
    // **Nur wirksam, wenn die Frist noch läuft** (Prüferbefund 2026-08-20):
    // `conn.on('ready')` oben schickt bei JEDEM `ready` auf dieser Verbindung
    // ein `remote_reclaim`, solange die Frist aktiv ist — nicht nur nach einem
    // echten Abriss. `requestResync()` (Serverwechsel zurück auf DIESE
    // Verbindung) löst beim Server ebenfalls ein frisches `ready` aus, OHNE
    // dass `conn.onClose` dazwischen gefeuert hätte. Zwei Reclaim-Anfragen
    // können so gleichzeitig unterwegs sein; die ERSTE Antwort gewinnt bei
    // Erfolg (`frist.wiederhergestellt` oben), und eine SPÄTER eintreffende
    // `remote_reclaim_failed` der zweiten, längst überholten Anfrage gehört
    // dann zu keiner laufenden Frist mehr — sie darf die gerade erst
    // wiederhergestellte, aktiv laufende Sitzung nicht mehr abbauen.
    if (!frist.aktiv) return;
    ab();
    beiEndgueltigemVerlust();
  });

  ab = () => {
    zeitgeberAbraeumen();
    abClose();
    abFrame();
  };
  return ab;
}

/** Ein Wurf zählt als „nicht offen": die Verbindung wurde abgeräumt (abgemeldet
 *  / Server-Eintrag entfernt), und das ist für die Sitzung dasselbe wie ein
 *  Abriss. */
function istOffen(conn: GatewayConnection | null): boolean {
  try {
    return conn?.state === 'open';
  } catch {
    return false;
  }
}

/** Frist für eine unbeantwortete Anfrage. */
export function anfrageFrist(ms: number, beiAblauf: () => void): Abbruch {
  const timer = setTimeout(beiAblauf, ms);
  return () => clearTimeout(timer);
}

/**
 * Die Fernsteuerungs-Fehler (`op:'error'`, Codes 4050–4059) der übergebenen
 * Verbindung.
 *
 * NUR dieser Bereich: ein beliebiger anderer `error`-Frame (fehlgeschlagener
 * Chat-Send, Rate-Limit) würde sonst im langen Warte-auf-Consent-Fenster die
 * Anfrage fälschlich abbrechen.
 */
export function fehlerWacht(
  conn: GatewayConnection | null,
  beiFehler: (code: number, msg: string) => void,
): Abbruch {
  const ab = conn?.on((evt) => {
    if (evt.op === 'error' && evt.code >= 4050 && evt.code <= 4059) {
      beiFehler(evt.code, evt.msg);
    }
  });
  return () => ab?.();
}
