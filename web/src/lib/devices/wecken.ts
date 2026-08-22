/**
 * Standplatz-Geräte — **Übertragung auf Abruf, ein Bildschirm nach dem anderen**.
 *
 * Ein Gerät überträgt nicht rund um die Uhr: ein Rechner, der für niemanden
 * encodiert, verbraucht Strom und Rechenzeit für nichts. Es fängt an, wenn
 * jemand es wecken will.
 *
 * ## Warum das nicht die Fernsteuer-Anfrage selbst tut
 *
 * Naheliegend wäre, `remote_request` als Weckruf zu nehmen. Dagegen spricht ein
 * konkreter Fehlerfall (Entwurf §8): dann hinge eine **Sitzungszusage an einer
 * Encoder-Initialisierung**. Scheitert die — kein Monitor angeschlossen,
 * Encoder belegt, Startverweigerung wegen HDR —, stünde eine
 * aktive Fernsteuer-Sitzung ohne Bild da, und der Fehler wäre nicht lesbar.
 *
 * Deshalb zwei Vorgänge: **wecken → übertragen → dann die unveränderte
 * `remote_request`**.
 *
 * ## Mehrere Bildschirme
 *
 * Wie bei Parsec: der erste Weckruf holt den **Hauptbildschirm**, die weiteren
 * schaltet der Steuernde in der laufenden Sitzung dazu — je Bildschirm eine
 * eigene Übertragung, also eine eigene Kachel und ein eigenes Player-Fenster.
 * Das ist nicht nur bequemer als „alles in einem Bild", es ist auf Windows der
 * einzige Weg: Windows Graphics Capture nimmt immer genau einen Schirm auf
 * (`ops/start.rs::parse_capture`).
 *
 * Gezielt wird trotzdem richtig, ohne dass hier etwas dafür zu tun wäre: der
 * Drahtvertrag trägt die Platznummer in JEDER Eingabe-Nachricht, und der
 * Sidecar rechnet die Anteile in das Rechteck des jeweils gemeinten Schirms
 * (`remote_input/zuordnung.rs`). Eine Sitzung kann deshalb mehrere Bildschirme
 * bedienen — es braucht keine zweite.
 *
 * ## Der Ton geht genau einmal hinaus
 *
 * Der **erste** Bildschirm einer Sitzung trägt den Systemton, jeder
 * dazugeschaltete ist stumm. Sonst käme derselbe Ton zwei- oder dreifach beim
 * Steuernden an, leicht gegeneinander versetzt — das klingt schlechter als gar
 * keiner, und es kostet je Strom eine eigene Tonspur.
 */

import { gatewayForServer } from '$lib/ws/connection';
import { geraeteAnmeldung } from './anmeldung.svelte';
import { HAUPTBILDSCHIRM, standplatzProfil } from './profil.svelte';
import { streamStarten } from '$lib/stream/starten';
import { MAX_STREAM_SLOTS, runningStreamSlots } from '$lib/stream/state.svelte';
import { stopSlot } from '$lib/stream/slotControl.svelte';
import { MONITOR_CAPTURE_PREFIX } from '$lib/stream/settingsCatalog';
import { streamSettings } from '$lib/stream/settingsState.svelte';
import { gegenstelle } from '$lib/remote/gegenstelle';
import { remoteProtokoll } from '$lib/remote/protokoll.svelte';
import { remoteSession } from '$lib/remote/session.svelte';

/**
 * Welcher Platz welchen Bildschirm überträgt — nur auf dem GERÄT geführt.
 *
 * Verhindert das eine, was sonst leicht passiert: ein zweiter Weckruf für
 * denselben Schirm (Doppelklick, oder der Steuernde drückt nochmal, weil das
 * Bild noch nicht da ist) startet eine zweite Übertragung desselben Inhalts.
 * Gegen die laufenden Plätze abgeglichen statt selbst aufgeräumt — ein Platz,
 * der nicht mehr läuft, zählt damit von selbst nicht mehr.
 */
const platzFuerQuelle = new Map<number, string>();

/**
 * Welcher Platz zu welchem Protokoll-Eintrag gehört.
 *
 * Ein Weckruf ist der Punkt, an dem ein unbeaufsichtigter Rechner anfängt, sein
 * Bild herzugeben — und bis zum Bughunt 2026-08-16 hinterliess genau der keine
 * Spur, solange keine Übernahme daraus wurde (`remote/protokoll.svelte.ts`).
 * Der Eintrag wird beim Start geöffnet und beim Einschlafen geschlossen; seine
 * Dauer ist damit die Zeit, die der Rechner wirklich übertragen hat.
 */
const vorgangFuerPlatz = new Map<number, string>();

/**
 * Plätze, die vergeben, aber noch nicht am Laufen sind.
 *
 * **Der Grund** (Bughunt 2026-08-16): `nextFreeStreamSlot()` schaut nur, was
 * schon LÄUFT. Zwei Weckrufe kurz hintereinander — „Monitor 2", eine halbe
 * Sekunde später „Monitor 3" — bekamen deshalb denselben Platz, bevor der
 * erste anlief. Einer der beiden Bildschirme blieb aus oder verdrängte den
 * anderen, und weil beide sich für den ersten hielten, führten auch beide den
 * Systemton: genau die doppelte, versetzte Tonspur, die dieses Modul verhindern
 * soll. Ein Platz gilt deshalb ab der Vergabe als belegt, nicht erst ab dem
 * ersten Bild.
 */
const reserviert = new Set<number>();

/**
 * Wie lange eine Vergabe höchstens gilt.
 *
 * **Der Grund** (Bughunt 2026-08-16): die Vergabe endet im `finally` des
 * Startversuchs — und damit gar nicht, wenn `streamStarten` nie zurückkommt.
 * Der Ruf geht über stdio-JSON-RPC in den Sidecar; hängt der (Encoder-Init auf
 * einer blockierten GPU, Sidecar im Halbtoten), bliebe der Platz für den Rest
 * der Laufzeit vergeben. Auf einem unbeaufsichtigten Rechner heisst „für den
 * Rest der Laufzeit" Wochen, und mit jedem hängengebliebenen Versuch wäre ein
 * Bildschirm weniger weckbar. Grosszügig gewählt: ein langsamer Start soll
 * nicht in eine zweite Vergabe desselben Schirms laufen.
 */
const VERGABE_FRIST_MS = 60_000;

/** Der nächste Platz, der weder läuft noch vergeben ist. */
function naechsterPlatz(): number {
  const belegt = new Set([...runningStreamSlots(), ...reserviert]);
  for (let i = 0; i < MAX_STREAM_SLOTS; i++) {
    if (!belegt.has(i)) return i;
  }
  return -1;
}

/**
 * Aufnahmequelle für eine Bildschirmnummer; ohne Nummer die des Profils.
 *
 * **Ohne Nummer heisst „nimm den, den du für richtig hältst"** — und das ist
 * die Quelle aus dem Standplatz-Profil. Der Haupt-Knopf beim Steuernden
 * („Übernehmen") schickt deshalb bewusst keine Nummer mit; erst die
 * Bildschirmliste tut es. Bis zum Bughunt 2026-08-16 schickte auch der
 * Haupt-Knopf die Nummer des gemeldeten Hauptbildschirms, und damit war die
 * Einstellung im Profil bei jedem online gemeldeten Gerät wirkungslos: sie
 * wurde nur gelesen, wenn keine Nummer kam, und es kam immer eine.
 *
 * **Der Hauptbildschirm wird dabei auf seine Nummer aufgelöst**, sobald der
 * Rechner seine Schirme kennt. Ohne das hiesse die Quelle schlicht „monitor",
 * und daran hängen zwei Dinge, die dann nicht mehr stimmen: der Name der
 * Kachel beim Steuernden (er hiesse „Stream 1" statt „Monitor 1"), und die
 * Erkennung, ob dieser Schirm schon läuft — ein Weckruf mit ausdrücklicher
 * Nummer 1 wäre sonst eine andere Quelle als derselbe Schirm ohne Nummer und
 * startete ihn ein zweites Mal.
 */
function quelleFuerMonitor(monitor: number | undefined): string {
  if (monitor !== undefined) return `${MONITOR_CAPTURE_PREFIX}${monitor}`;
  const eigene = standplatzProfil.profil.quelle;
  if (eigene !== HAUPTBILDSCHIRM) return eigene;
  const haupt = streamSettings.available_monitors.find((mon) => mon.primary);
  return haupt ? `${MONITOR_CAPTURE_PREFIX}${haupt.index}` : eigene;
}

/**
 * Läuft diese Quelle schon — **oder läuft sie gerade an**?
 *
 * **Die zweite Hälfte fehlte** (Bughunt 2026-08-16): gefragt wurde nur, was
 * schon LÄUFT. Zwei Weckrufe für denselben Schirm kurz hintereinander — ein
 * Doppelklick, oder der Steuernde drückt nochmal, weil das Bild noch nicht da
 * ist — fielen beide durch, solange der Encoder des ersten hochlief. Danach
 * übertrugen zwei Plätze denselben Bildschirm: doppelte Rechenzeit, doppelte
 * Bandbreite, und beim Steuernden zwei gleich aussehende Kacheln. Genau das,
 * wogegen [`platzFuerQuelle`] gebaut ist.
 */
function laeuftSchon(quelle: string): boolean {
  const belegt = new Set([...runningStreamSlots(), ...reserviert]);
  for (const [slot, q] of platzFuerQuelle) {
    if (belegt.has(slot) && q === quelle) return true;
  }
  return false;
}

/**
 * Die Plätze, auf denen dieser Rechner **als Gerät** sendet.
 *
 * Also nur, was ein Weckruf gestartet hat — was der Besitzer von Hand
 * überträgt, steht nicht in [`platzFuerQuelle`] und gehört ihm, nicht dem
 * Gerät. Genau diese Trennung fehlte der Oberfläche bis 2026-08-16: sie hat
 * aus „hier steht ein Gerät dieses Besitzers" geschlossen, dass jeder Strom
 * dieses Kontos vom Gerät kommt — und das LIVE-Abzeichen an einen Standplatz
 * gehängt, der gar nichts tat.
 *
 * Gegen die laufenden Ströme gefiltert, nicht bloss aus der Karte gelesen: ein
 * Strom kann von sich aus enden (Encoder weg, Bildschirm abgesteckt), und die
 * Karte erfährt davon nichts.
 */
export function geraeteSlots(): number[] {
  const laufend = new Set(runningStreamSlots());
  return [...platzFuerQuelle.keys()].filter((slot) => laufend.has(slot)).sort();
}

/**
 * Einen Weckruf absetzen. `false` = nicht hinausgegangen (keine Verbindung);
 * eine Ablehnung des Gateways kommt dagegen als `op:'error'` zurück und wird
 * dort behandelt, wo auch die übrigen Fernsteuer-Fehler landen.
 *
 * `monitor` ist die Nummer aus der Bildschirmliste des Geräts; ohne Angabe
 * nimmt es seinen Hauptbildschirm.
 */
export function geraetWecken(
  serverId: string | null,
  deviceId: string,
  monitor?: number,
): boolean {
  const conn = serverId ? gatewayForServer(serverId) : null;
  if (!conn) return false;
  try {
    return conn.sendDeviceWake(deviceId, monitor);
  } catch {
    return false;
  }
}

/**
 * Wieder einschlafen: alle Übertragungen beenden, die ein Weckruf gestartet hat.
 *
 * **Warum das dazugehört** (Bughunt 2026-08-16): ohne diesen Weg überträgt ein
 * einmal geweckter Rechner für immer weiter — und verbraucht genau die
 * Bandbreite und Rechenzeit, die „erst auf Abruf" einsparen sollte. Gerufen am
 * Ende jeder Fernsteuerung dieses Geräts und von der Nachlauf-Wache unten.
 *
 * **Nur die selbst geweckten Plätze.** Was der Besitzer von Hand gestartet hat,
 * steht nicht in der Karte und bleibt unangetastet — es wäre sein Stream, nicht
 * unserer.
 *
 * **`grund` ist Pflicht, und zwar aus einem konkreten Anlass** (2026-08-17):
 * hier endet die Übertragung eines unbeaufsichtigten Rechners, und bis dahin
 * stand nirgends, dass und warum das geschah. Für den Steuernden sieht es aus
 * wie „das Bild ist weg"; im Protokoll war es von einem Abbruch nicht zu
 * unterscheiden. Es gibt vier Wege hierher — abgelaufene Nachlauf-Frist,
 * abgelehnte Anfrage, beendete Fernsteuerung, der Knopf des Besitzers —, und
 * welcher es war, beantwortet die Frage. Deshalb kein Vorgabewert: ein
 * Aufrufer, der nichts sagt, soll gar nicht erst durchkommen.
 */
export async function wiederEinschlafen(grund: string): Promise<void> {
  if (nachlaufWecker) clearTimeout(nachlaufWecker);
  nachlaufWecker = null;
  const laufend = new Set(runningStreamSlots());
  const plaetze = [...platzFuerQuelle.keys()].filter((slot) => laufend.has(slot));
  platzFuerQuelle.clear();
  for (const [slot, vorgang] of vorgangFuerPlatz) {
    if (laufend.has(slot)) void remoteProtokoll.beenden(vorgang);
  }
  vorgangFuerPlatz.clear();
  // Fürs Entwickeln, wo die Renderer-Konsole offen ist — und für den Fall, dass
  // gar nichts mehr lief: dann geht unten kein Befehl hinaus und die
  // dauerhafte Spur unten entsteht nicht. Im verpackten Build ist diese Zeile
  // wertlos (Electrons Renderer-Konsole hat dort keinen Abnehmer), deshalb ist
  // sie NICHT die eigentliche Antwort.
  console.info(`[geraet] schlafen gelegt (${grund}) — ${plaetze.length} Übertragung(en)`);
  // **Die dauerhafte Spur.** Der Grund reist im `stop`-Befehl mit und steht
  // damit in der `sidecar.log`, in derselben Zeile wie der Stopp selbst — der
  // einzigen Datei, die der Diagnose-Upload überträgt. Genau diese eine Zeile
  // hat am 2026-08-17 gefehlt: dass der Sender aufhörte, war zu sehen, ob es
  // ihm jemand befohlen hatte, nicht.
  await Promise.all(plaetze.map((slot) => stopSlot(slot, `schlafen gelegt: ${grund}`)));
}

/**
 * Wie lange ein geweckter Rechner überträgt, ohne dass eine Fernsteuerung
 * daraus wird.
 *
 * Der reguläre Weg braucht zwei Fristen: bis zu 25 s auf das erste Bild
 * (`schirme.svelte.ts::WARTEN_MS`) und danach bis zu 40 s auf die Antwort auf
 * die Anfrage (`remote/session.svelte.ts::ANFRAGE_FRIST_MS`). Darüber, damit
 * die Wache nie einer Übernahme in den Rücken fällt, die noch zustande kommt.
 */
const NACHLAUF_MS = 90_000;

let nachlaufWecker: ReturnType<typeof setTimeout> | null = null;

/**
 * Der Gegenruf zum Weckruf: **ein Weckruf ohne folgende Sitzung darf nicht für
 * immer übertragen.**
 *
 * **Der Fehlerfall** (Bughunt 2026-08-16): [`wiederEinschlafen`] hing am Ende
 * einer Fernsteuer-Sitzung — und nur daran. Es gibt aber mehrere Wege zu einem
 * Weckruf, aus dem nie eine Sitzung wird: der Encoder braucht länger als die
 * Wartefrist des Steuernden, dem Steuernden fehlt `REMOTE_CONTROL` (die
 * Übernahme springt still zurück), oder die Anfrage wird abgelehnt bzw. läuft
 * ab. In allen dreien lief der Strom weiter, und zwar unbegrenzt. Das ist mehr
 * als verschwendete Bandbreite: ohne Sitzung greift auch der Sichtschutz nicht,
 * der unbeaufsichtigte Rechner überträgt also seinen ungeschützten Desktop an
 * jeden im Kanal.
 *
 * Gefragt wird die Sitzung selbst und nicht ein eigener Merker: nur sie weiss,
 * ob gerade wirklich jemand steuert. Läuft eine, endet die Übertragung über
 * ihren eigenen Ausgang (`remote/geraeteanbindung.ts`) — dann muss hier nichts
 * nachgestellt werden.
 */
function nachlaufWachen(): void {
  if (nachlaufWecker) clearTimeout(nachlaufWecker);
  nachlaufWecker = setTimeout(() => {
    nachlaufWecker = null;
    if (remoteSession.phase === 'active' && remoteSession.role === 'host') return;
    void wiederEinschlafen('Nachlauf-Frist abgelaufen, keine Übernahme zustande gekommen');
  }, NACHLAUF_MS);
}

/**
 * Das Gerät ist gemeint und soll anfangen zu übertragen.
 *
 * **Prüft zuerst, ob es wirklich um DIESEN Rechner geht.** Der Ruf kommt über
 * die eigene Verbindung herein und ist damit vertrauenswürdig, aber ein Fenster
 * desselben Kontos auf einem anderen Rechner darf sich davon nicht angesprochen
 * fühlen — sonst begänne der Laptop des Besitzers zu übertragen, weil jemand
 * den Werkstatt-PC wecken wollte.
 */
export async function weckrufBehandeln(
  serverId: string | null,
  deviceId: string,
  channelId: string,
  vonUserId: string | null,
  monitor?: number,
): Promise<void> {
  const eintrag = geraeteAnmeldung.fuerServer(serverId);
  if (!eintrag || eintrag.deviceId !== deviceId) return;

  const quelle = quelleFuerMonitor(monitor);
  if (laeuftSchon(quelle)) {
    // **Verworfen wird weiterhin — aber nicht mehr stumm** (2026-08-17). Dieses
    // frühe Zurückspringen ist richtig: eine zweite Übertragung derselben
    // Quelle kostet Rechenzeit und Bandbreite für dasselbe Bild. Für den
    // Steuernden ist es aber ununterscheidbar von „nichts passiert" — er wartet
    // 25 s (`schirme.svelte.ts::WARTEN_MS`) und bekommt dann „hat nicht
    // geantwortet". Am 2026-08-17 hat genau das eine halbe Stunde Fehlersuche
    // gekostet, weil auf beiden Seiten nichts darüber im Protokoll stand.
    //
    // Die Auswahl beim Steuernden blendet schon laufende Schirme aus
    // (`devices/schirme.svelte.ts`), hierher kommt also nur, wessen Zuordnung
    // dort nicht getroffen hat — und dann ist diese Zeile der einzige Hinweis
    // darauf, dass der Ruf ankam und bewusst verfiel.
    console.info(`[geraet] Weckruf verworfen — "${quelle}" überträgt bereits`);
    return;
  }

  // Der erste Bildschirm trägt den Ton, jeder weitere ist stumm (s. Modulkopf).
  // **Vergebene Plätze zählen mit**, sonst hielte sich ein zweiter Weckruf
  // ebenfalls für den ersten und brächte eine zweite Tonspur mit.
  const erster = runningStreamSlots().length === 0 && reserviert.size === 0;
  const slot = naechsterPlatz();
  if (slot < 0) return;
  reserviert.add(slot);
  platzFuerQuelle.set(slot, quelle);
  // Notbremse für einen Sidecar-Ruf, der nie zurückkommt (s. VERGABE_FRIST_MS).
  const vergabeFrist = setTimeout(() => reserviert.delete(slot), VERGABE_FRIST_MS);
  try {
    // **Mit dem Standplatz-Profil, nicht mit den Einstellungen des Besitzers:**
    // der Rechner überträgt hier für jemand anderen und zu einem anderen Zweck
    // als beim Vorführen (Begründung in `profil.svelte.ts`).
    const r = await streamStarten(channelId, slot, {
      quelle,
      uebersteuerung: standplatzProfil.alsUebersteuerung(),
      ton: erster ? 'Desktop' : 'Aus',
    });
    // Scheitert der Start, gehört der Platz nicht diesem Schirm — sonst hielte
    // die Karte ihn für belegt, und ein zweiter Versuch liefe ins Leere.
    if (!r.ok) {
      platzFuerQuelle.delete(slot);
      return;
    }
    // Ab hier gibt der Rechner wirklich Bild her — beides hängt genau daran:
    // die Spur im Protokoll und die Wache, die ihn wieder einschlafen lässt.
    protokollieren(slot, vonUserId, quelle);
    nachlaufWachen();
  } finally {
    // Die Vergabe endet mit dem Startversuch, egal wie er ausging: läuft der
    // Strom, hält ihn `runningStreamSlots()`; lief er nicht an, ist der Platz
    // wieder frei.
    clearTimeout(vergabeFrist);
    reserviert.delete(slot);
  }
}

/**
 * Den Weckruf ins Geräte-Protokoll eintragen.
 *
 * **Der Name ist der Anzeigename, notfalls die Kennung.** Auf einem Rechner,
 * vor dem niemand sitzt, ist der Nutzer-Zwischenspeicher meist leer — und
 * „Unbekannt" wäre in einem Protokoll die nutzloseste aller Auskünfte. Die
 * Kennung steht ohnehin daneben; sie ist die harte Zuordnung.
 *
 * `selbsttaetig: true`, weil ein Weckruf nie bestätigt wird: er kommt herein
 * und wird ausgeführt. Genau darum gehört er ins Protokoll.
 */
function protokollieren(slot: number, vonUserId: string | null, quelle: string): void {
  const g = gegenstelle(vonUserId);
  const id = `weckruf:${slot}:${Date.now()}`;
  // Einen Vorgang, der noch auf diesem Platz offen steht, zuerst schliessen:
  // hat der Besitzer den Strom von Hand beendet, kam nie ein Einschlafen
  // dazwischen — und ein überschriebener Eintrag bliebe für immer „läuft noch".
  const alt = vorgangFuerPlatz.get(slot);
  if (alt) void remoteProtokoll.beenden(alt);
  vorgangFuerPlatz.set(slot, id);
  void remoteProtokoll.beginnen(
    id,
    vonUserId ?? '',
    `${g.bekannt ? g.anzeige : (vonUserId ?? g.anzeige)} · ${quelle}`,
    true,
    'weckruf',
  );
}
