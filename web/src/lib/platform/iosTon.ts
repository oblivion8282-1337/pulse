import { isCapacitorIOS } from './runtime';
import {
  iosJetztLaeuft,
  iosJetztLaeuftAus,
  iosPlaybackModus,
  iosWegWechsel,
  iosVoiceAktiv
} from './iosAudioSession';
import { NACH_NATIVEM_RAUM, tonSchritt, wegAntwort, zielModus, type TonModus } from './tonModus';
import { webAudioSession, webAudioSessionVergessen } from './iosTonWebkit';

/**
 * Der eine Ort, der die iOS-Audio-Session schaltet.
 *
 * Vorher sprachen zwei Stellen unabhängig mit dem Plugin: der Sprachkanal
 * schaltete `voiceChat` an und beim Verlassen die Session komplett AUS — und
 * riss damit den Ton eines gleichzeitig laufenden Streams mit, weil die
 * Session prozessweit gilt. Die Entscheidung, welche Betriebsart gerade
 * stimmt, steht deshalb an einer Stelle (`tonModus.ts`, geprüft) und wird
 * hier angewandt.
 *
 * **Wiedergaben werden als MENGE geführt, nicht als Zähler.** Ein
 * Stream-Manager meldet seinen Ton beim Anhängen des Stroms an — und das
 * passiert bei einem Wiederaufbau erneut für denselben Strom. Ein Zähler
 * liefe davon nach oben weg und die Session bliebe nach dem letzten Stream
 * für immer aktiv; eine Menge ist von sich aus idempotent.
 *
 * `aus` fährt über `setVoiceActive(false)` (Session deaktivieren,
 * `notifyOthersOnDeactivation`) — eine eigene `setInactive`-Methode verlangte
 * einen nativen Neubau für denselben Effekt.
 *
 * **Eine Ausnahme: der native Sprachraum.** Solange die Hülle ihn hält,
 * gehört die Session LiveKit, und hier wird nichts angefasst
 * (`tonNativerRaum`).
 *
 * Browser, Electron und Android: No-op (`isCapacitorIOS`-Gate in der
 * Plugin-Schicht; Android hat mit `audioRoute.ts` sein eigenes Gegenstück).
 */

/**
 * Die VOICE-Quellen, nicht ein Schalter.
 *
 * Bis zum 2026-10-08 stand hier ein `boolean`, und das ging gut, solange es
 * genau einen Voice-Verbraucher gab (den Sprachkanal). Mit den Anrufen gibt es
 * zwei, und sie laufen unabhängig: ein Anruf fasst den Sprachkanal nicht an,
 * man kann also in einem Kanal sitzen und telefonieren. Mit einem Schalter
 * hätte das Auflegen die Session des Kanals mit abgeräumt — genau die
 * Fehlerklasse, vor der der Kopf dieser Datei warnt („wer sie unabhängig
 * schaltet, reisst dem anderen den Ton weg"), nur eine Ebene höher.
 *
 * Eine Menge statt eines Zählers, aus demselben Grund wie bei den
 * Wiedergaben: sie ist von sich aus idempotent.
 */
const voiceQuellen = new Set<string>();
const wiedergaben = new Set<string>();
let angewandt: TonModus = 'aus';

/**
 * Filtert das Betriebssystem gerade im Sendeweg?
 *
 * Das ist nicht dasselbe wie „Voice-Modus läuft": die Hülle richtet die
 * Session nach dem AUSGABEWEG ein, und auf der Hochqualitäts-Route über
 * Bluetooth (`mode: .default`) filtert Apple NICHT. Nur die Hülle weiss das,
 * deshalb kommt der Wert von dort zurück.
 */
let systemFiltert = false;
/** Wer auf einen Wechsel reagieren muss — heute der Sendefilter. */
const filterHoerer = new Set<() => void>();

/** Will der Nutzer die Hochqualitäts-Route über Bluetooth? Wird von aussen
 *  gesetzt (Einstellung), damit dieses Modul nichts über Einstellungen
 *  wissen muss. */
let hqFunk = false;

export function tonHqFunkSetzen(an: boolean): void {
  if (hqFunk === an) return;
  hqFunk = an;
  // Die Route wird beim nächsten Einrichten gewählt — also jetzt neu
  // einrichten, sonst wirkt die Einstellung erst beim nächsten Beitritt.
  erzwingen = true;
  void anwenden();
}

/**
 * Hält die Hülle gerade einen nativen Sprachraum? Dann gehört die Session
 * LiveKit, und hier wird sie NICHT angefasst — weder umgestellt noch
 * deaktiviert (Begründung an `tonSchritt` in `tonModus.ts`). Gesetzt allein
 * aus `platform/iosSprache.ts`, zusammen mit WebKits `ambient`.
 *
 * **Sofort gesetzt, nicht in der Kette:** ein schon wartender Schritt soll
 * beim Anlaufen sehen, dass der Raum steht. Das Zurücksetzen von `angewandt`
 * beim Ende läuft dagegen IN der Kette — ein Schritt, der gerade noch
 * arbeitet, würde es sonst überschreiben.
 */
export function tonNativerRaum(an: boolean): void {
  if (nativerRaum === an) return;
  nativerRaum = an;
  if (an) return;
  kette = kette.then(() => {
    angewandt = NACH_NATIVEM_RAUM;
    wegAngewandt = null;
  });
  void anwenden();
}

/**
 * Auf Wechsel des System-Filters hören. Rückgabe meldet ab.
 *
 * Gebraucht, weil der Wechsel NICHT von einer Nutzeraktion kommt: es genügt,
 * die AirPods einzusetzen. Ohne diesen Weg liefe danach entweder zweimal
 * gefiltert oder gar nicht.
 */
export function tonSystemFilterBeobachten(cb: () => void): () => void {
  filterHoerer.add(cb);
  return () => filterHoerer.delete(cb);
}

export function tonSystemFiltert(): boolean {
  return systemFiltert;
}

/**
 * Fuer welchen Tonweg die Session zuletzt eingerichtet wurde.
 *
 * **Das ersetzt eine Zeitfrist, die das Problem nur verlangsamt hat.** Bis zum
 * 2026-10-10 stand hier ein Zeitfenster: `setCategory`/`setActive` LOESEN
 * einen Routenwechsel aus, und der loeste wieder ein Einrichten aus — eine
 * Rueckkopplung, die im Geraetelog 4–10 Kategorie-Wechsel pro Sekunde
 * erzeugte. Das Fenster (1,5 s) brach den Schwall, aber nicht den Kreis: am
 * Geraet nachgemessen blieb EIN Durchlauf alle 2,4–2,9 s uebrig, also 1–2
 * zusaetzliche Einrichtungen mitten in jeden Beitritt hinein — genau in das
 * Zeitfenster, in dem LiveKit das Mikrofon holt und veroeffentlicht.
 *
 * Der Grund fuer die Fristkonstruktion war die Annahme, das Ereignis trage
 * keine Nutzlast. Es trug sie immer (`routeGewechselt` schickt den Porttyp,
 * seit demselben Tag auch den Tonweg) — nur der Binder in
 * `iosAudioSession.ts` warf sie weg. Jetzt wird verglichen: gleicher Tonweg =
 * Folge der eigenen Einrichtung, nichts zu tun. Kein Zeitgeber, kein Fenster,
 * keine Vermutung.
 *
 * **Verglichen wird der Tonweg, nicht der Port.** Die Huelle richtet die
 * Session nach `eingebaut`/`kabel`/`funk` ein; Lautsprecher und Hoermuschel
 * sind derselbe Fall und brauchen kein Neueinrichten. Die Einteilung liegt
 * deshalb nativ (`Tonweg.kennung`) und nicht hier.
 *
 * `null` heisst „nicht bekannt" — dann wird der gemeldete Weg uebernommen,
 * ohne neu einzurichten. Ein unbekannter Ausgangszustand ist kein Wechsel.
 */
let wegAngewandt: string | null = null;

/** Steht ein nativer Sprachraum? S. `tonNativerRaum`. */
let nativerRaum = false;
/** Gleiches Ziel, aber neu einrichten (Weg oder Bluetooth-Wahl geändert). */
let erzwingen = false;

/**
 * **Die Schritte laufen der Reihe nach.** Bis zum 2026-10-11 setzte jeder
 * Aufruf `angewandt` VOR dem `await` — damit zwei schnelle Aufrufe nicht
 * doppelt einrichteten. Der Preis: scheiterte die Hülle, galt die Betriebsart
 * trotzdem als angewandt und wurde nie wieder versucht (Bughunt G2). Jetzt
 * wird erst NACH dem Gelingen gemerkt, und die Kette sorgt dafür, dass kein
 * zweiter Schritt über einen laufenden hinwegliest.
 */
let kette: Promise<void> = Promise.resolve();

function anwenden(): Promise<void> {
  const lauf = kette.then(schritt);
  kette = lauf.catch(() => undefined);
  return lauf;
}

async function schritt(): Promise<void> {
  const ziel = zielModus(voiceQuellen.size > 0, wiedergaben.size);
  if (!nativerRaum) webAudioSession(ziel);
  if (!isCapacitorIOS()) return;
  if (tonSchritt({ ziel, angewandt, nativerRaum, erzwingen }) === 'nichts') return;
  const warErzwungen = erzwingen;
  erzwingen = false;
  const ergebnis = await einrichten(ziel);
  // Gescheitert: NICHT merken (auch nicht, dass neu eingerichtet werden
  // muss). Der nächste Anlass versucht es erneut — ein eigener
  // Wiederholungs-Takt wäre genau die Rückkopplung, die diese Datei am
  // 2026-10-10 an der Wurzel beseitigt hat.
  if (!ergebnis) {
    if (warErzwungen) erzwingen = true;
    return;
  }
  angewandt = ziel;
  wegAngewandt = ergebnis.weg;
  if (systemFiltert === ergebnis.filtert) return;
  systemFiltert = ergebnis.filtert;
  // Kopie, weil ein Hörer sich im Ruf abmelden darf.
  for (const h of [...filterHoerer]) h();
}

/** Die Hülle für `ziel` einrichten lassen. `null`, wenn sie scheitert. */
async function einrichten(
  ziel: TonModus
): Promise<{ filtert: boolean; weg: string | null } | null> {
  if (ziel === 'voice') {
    const antwort = await iosVoiceAktiv(true, hqFunk);
    return antwort.ok ? { filtert: antwort.modus === 'voiceChat', weg: antwort.weg } : null;
  }
  if (ziel === 'wiedergabe') {
    // Die Wiedergabe-Kategorie richtet sich nicht nach dem Weg — was gilt,
    // ist damit unbekannt. Nicht raten.
    return (await iosPlaybackModus()) ? { filtert: false, weg: null } : null;
  }
  const antwort = await iosVoiceAktiv(false);
  return antwort.ok ? { filtert: false, weg: antwort.weg } : null;
}

/**
 * Unterbrechungen (Telefonanruf, Siri, Wecker — Roadmap-Punkt 26) und
 * Wegwechsel. Auf Unterbrechungen wird seit dem 2026-10-10 bewusst NICHT mehr
 * reagiert; warum, steht im Rumpf.
 *
 * Der Abriss wird nicht gebraucht: der Beobachter lebt so lange wie die
 * Seite, und genauso lange gibt es eine Audio-Session zu reparieren.
 */
let beobachtet = false;

function unterbrechungenBeobachten(): void {
  if (beobachtet || !isCapacitorIOS()) return;
  beobachtet = true;
  // **Hier wurde bis zum 2026-10-10 auf Unterbrechungen reagiert — und genau
  // das hat das Mikrofon umgebracht.**
  //
  // Die Annahme war Apples Standardfall: iOS schaltet die Session zu Beginn
  // einer Unterbrechung ab, die App muss sie danach selbst wieder aktivieren.
  // Richtig fuer eine App, die ihren Ton selbst abspielt. Wir sind das nicht:
  // Aufnahme und Wiedergabe liegen bei WebKits eigenem Prozess, mit dessen
  // eigener, nicht mischbarer Session.
  //
  // Folge: jedes `setActive(true)` von uns UNTERBRICHT WebKit. Am Geraet
  // gemessen — unsere Session meldet 0,6 s nach jedem eigenen Aktivieren
  // selbst „Unterbrechung begonnen", und eine Sonde, die darauf antwortete,
  // drehte sich in einer Schleife im 2-Sekunden-Takt, minutenlang.
  //
  // Beim Zurueckkehren aus dem Hintergrund schickt iOS ein End-Interruption
  // (`Resumable:0`). Wer darauf die Session anfasst, raeumt WebKits laufende
  // Aufnahme ab. Drei Laeufe, drei Mal dasselbe: im Hintergrund nahm das
  // Telefon mit 100 % der Echtzeit auf, ab der Rueckkehr stand die Abtastung
  // still — und **kein Mute-Zyklus half**, denn die Spur war nicht beendet,
  // sondern lebendig und stumm. Ohne den Eingriff laeuft dieselbe Strecke
  // 90 s durch, mit 100 %, Mute-Zyklus eingeschlossen.
  //
  // Die Huelle meldet Unterbrechungen weiterhin und schreibt sie ins
  // Geraetelog (`unterbrechung` in `AudioSessionPlugin.swift`) — sie sind
  // wertvoll zum Mitlesen, nur nicht als Handlungsanweisung.
  //
  // **Was damit UNGEPRUEFT bleibt:** ein echter Telefonanruf. Ob WebKit nach
  // einer fremden Unterbrechung von selbst zurueckkommt, konnten wir nicht
  // automatisch pruefen. Falls nicht, gehoert die Reparatur auf die Ebene,
  // der die Aufnahme GEHOERT — `restartTrack()` auf der Mikrofonspur —, nicht
  // an unsere Session. Wer das angeht, misst zuerst, ob ueberhaupt etwas
  // kaputtgeht.

  // **Wegwechsel richten die Session neu ein** (seit 2026-10-09). Die Hülle
  // wählt Kategorie und Modus nach dem AUSGABEWEG: am Lautsprecher mit
  // Apples Sprachverarbeitung, mit Kopfhörern im Ohr auf der
  // Hochqualitäts-Route. Dieser Wechsel kommt von KEINER Nutzeraktion — es
  // genügt, die AirPods einzusetzen. Ohne diesen Haken behielte die Session
  // die Konfiguration des alten Wegs, und mit ihr liefe entweder zweimal
  // gefiltert oder gar nicht.
  //
  // `erzwingen`, weil gewollt weiter `voice` ist: bei gleichem Ziel stiege
  // `tonSchritt` sonst aus, obwohl die Einrichtung dahinter eine andere ist.
  iosWegWechsel((e) => {
    // Die Entscheidung selbst steht importfrei in `tonModus.ts` und ist dort
    // geprueft — sie ist der Kern dieses Hakens und darf nicht nur am Geraet
    // nachweisbar sein.
    switch (wegAntwort(voiceQuellen.size > 0, e.weg, wegAngewandt)) {
      case 'ignorieren':
        return;
      case 'uebernehmen':
        wegAngewandt = e.weg;
        return;
      case 'neu-einrichten':
        erzwingen = true;
        void anwenden();
        return;
    }
  });
}

/**
 * Eine Voice-Quelle an- oder abmelden.
 *
 * `kennung` unterscheidet die Verbraucher (`'sprachkanal'`, `'anruf'`). Ohne
 * sie würde der eine dem anderen die Session wegnehmen — Begründung an
 * `voiceQuellen`.
 *
 * **Gibt seit dem 2026-10-10 ein Promise zurück, und beim ANMELDEN muss darauf
 * gewartet werden.** LiveKits eigene iOS-Dokumentation verlangt, dass die
 * AVAudioSession mit `.playAndRecord`/`.voiceChat` eingerichtet UND aktiviert
 * ist, BEVOR ein Mikrofon veröffentlicht wird. Vorher stiess diese Funktion
 * die Einrichtung nur an (`void anwenden()`) und kehrte sofort zurück — das
 * Veröffentlichen konnte sie überholen. Auf Android steht die Regel seit
 * jeher daneben (`await setVoiceActive(true)`), mit derselben Begründung; die
 * iOS-Hälfte fehlte schlicht.
 *
 * Beim ABMELDEN ist Warten unnötig: danach kommt keine Spur mehr, die zu früh
 * sein könnte. Dort bleibt es bei `void` — wieder wie auf Android.
 */
export function tonVoice(kennung: string, aktiv: boolean): Promise<void> {
  unterbrechungenBeobachten();
  if (aktiv) voiceQuellen.add(kennung);
  else voiceQuellen.delete(kennung);
  return anwenden();
}

/**
 * Ton einer Wiedergabe an- oder abmelden. `kennung` identifiziert die Quelle
 * (Stream-Kachel, Watch-Party) — mehrfaches Anmelden derselben Kennung zählt
 * einmal, s. Modulkopf.
 */
export function tonWiedergabe(kennung: string, an: boolean, titel?: string): void {
  unterbrechungenBeobachten();
  const vorher = wiedergaben.size;
  if (an) wiedergaben.add(kennung);
  else wiedergaben.delete(kennung);
  void anwenden();
  // Sperrbildschirm-Anzeige hängt an der ERSTEN und der LETZTEN Wiedergabe,
  // nicht an jeder: bei zwei offenen Kacheln soll die zweite die Anzeige der
  // ersten nicht überschreiben und ihr Schliessen sie nicht abräumen.
  if (an && vorher === 0) {
    void iosJetztLaeuft(titel || 'Pulse', titel ? 'Pulse' : '');
  } else if (!an && wiedergaben.size === 0) {
    void iosJetztLaeuftAus();
  }
}

/** Testhilfe / Abmeldung: alles zurück auf Anfang. */
export function tonZuruecksetzen(): void {
  voiceQuellen.clear();
  wiedergaben.clear();
  angewandt = 'aus';
  webAudioSessionVergessen();
  wegAngewandt = null;
  nativerRaum = false;
  erzwingen = false;
}

/** Der zuletzt angewandte Modus — für Anzeige und Tests. */
export function tonModusJetzt(): TonModus {
  return angewandt;
}
