import { isCapacitorIOS } from './runtime';
import {
  iosJetztLaeuft,
  iosJetztLaeuftAus,
  iosPlaybackModus,
  iosUnterbrechungen,
  iosWegWechsel,
  iosVoiceAktiv
} from './iosAudioSession';
import { audioSessionTyp, zielModus, type AudioSessionTyp, type TonModus } from './tonModus';

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
 * **Bewusst ohne Änderung am Swift-Plugin:** `aus` fährt über
 * `setVoiceActive(false)`, das genau das tut (Session deaktivieren,
 * `notifyOthersOnDeactivation`). Eine eigene `setInactive`-Methode wäre
 * sauberer benannt, verlangte aber einen nativen Neubau auf jedem Gerät —
 * für denselben Effekt. Wer das Plugin ohnehin anfasst, kann es nachziehen.
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
 * Filtert das Betriebssystem im Sendeweg? In der iOS-Hülle: ja, immer.
 *
 * **Früher kam dieser Wert aus der Antwort unseres Plugins** — es meldete
 * zurück, welchen Modus es gesetzt hatte. Am 2026-10-10 am Gerät gemessen:
 * das ist die falsche Quelle. Das Mikrofon nimmt die Session der WebView auf
 * (`com.apple.WebKit`, `has started recording`), nicht unsere; der
 * systemweite Modus war `VideoChat`, und Apples Verarbeitung lief sichtbar
 * (655× `AUVoiceIO`, 594× `EchoCancellation`). Unser Plugin stellte eine
 * Session ein, die gar nichts aufnimmt.
 *
 * WebKit öffnet das Mikrofon IMMER in einem Sprach-Modus — es gibt dort
 * nichts zu unterscheiden. Damit ist die Antwort eine Eigenschaft der
 * Plattform und keine Rückmeldung: in der Hülle filtert Apple, überall sonst
 * nicht. Die ganze Herleitung steht an der Einstellung `bluetoothHq`
 * (`settings-registry/sections/audio.ts`).
 *
 * Folge: der frühere Beobachter auf Änderungen dieses Werts ist entfallen —
 * ein konstanter Wert ändert sich nicht.
 */

/** Will der Nutzer die Hochqualitäts-Route über Bluetooth? Wird von aussen
 *  gesetzt (Einstellung), damit dieses Modul nichts über Einstellungen
 *  wissen muss. */
let hqFunk = false;

export function tonHqFunkSetzen(an: boolean): void {
  if (hqFunk === an) return;
  hqFunk = an;
  // Die Route wird beim nächsten Einrichten gewählt — also jetzt neu
  // einrichten, sonst wirkt die Einstellung erst beim nächsten Beitritt.
  angewandt = 'aus';
  void anwenden();
}

/**
 * **TESTLAUF 2026-10-10 — auf `false` zurück, sobald gehört.**
 *
 * Läuft auf iOS unsere eigene Sendekette (RNNoise) statt Apples Verarbeitung?
 *
 * Der Anlass ist ein Hörbefund: die Stimme vom iPhone klingt dumpf. Verdacht
 * ist Apples Sprachverarbeitung — ein Telefonie-Prozessor, der für schnelle,
 * zuverlässige Echo-Auslöschung die Höhen opfert.
 *
 * **Das Paket ist unteilbar.** Apples Rauschunterdrückung steckt in derselben
 * Einheit wie die Echo-Auslöschung; wer die eine abschaltet, schaltet beide
 * ab. Dieser Schalter tut deshalb ZWEIERLEI: er lässt `filterwahl.ts` wieder
 * RNNoise aufbauen UND erzwingt `echoCancellation: false` in den
 * Aufnahme-Vorgaben (`voice/livekit.svelte.ts`).
 *
 * **Nur mit Kopfhörern brauchbar.** Ohne sie hört das Gegenüber sich selbst —
 * Echo kann zuverlässig nur das Betriebssystem auslöschen, weil nur es weiss,
 * was der Lautsprecher gerade ausgibt.
 *
 * Fällt der Hörtest gut aus, wird daraus keine Einstellung, sondern eine
 * Entscheidung nach Ausgabeweg (Kopfhörer → eigene Kette, Lautsprecher →
 * Apples Paket). Dafür fehlt der App heute die Kenntnis des Wegs; die kennt
 * nur die Hülle und müsste sie mitschicken.
 */
export const IOS_EIGENE_SENDEKETTE = true;
// **Zweiter Testlauf, 2026-10-10.** Der erste brach ab, bevor etwas zu hoeren
// war: mit `true` kam das iPhone nicht mehr in den Sprachkanal (Token erteilt,
// dann `participant_connection_aborted`). Ursache war nicht der Klang, sondern
// dass der Aufbau von RNNoise im Verbindungsweg ABGEWARTET wurde. Das ist
// seither unkritisch — `#filterOhneBlockade` in `voice/livekit.svelte.ts` gibt
// ihm eine Frist und geht danach weiter. Erst damit laesst sich die eigentliche
// Frage ueberhaupt hoeren.

export function tonSystemFiltert(): boolean {
  return isCapacitorIOS() && !IOS_EIGENE_SENDEKETTE;
}

/** Zuletzt an WebKit gemeldeter Typ — eigener Merker, weil der Web-Teil
 *  auch dort gilt, wo der native gar nicht laeuft (Safari am iPhone). */
let webTyp: AudioSessionTyp | null = null;

/**
 * WebKit die Absicht nennen (W3C Audio Session API).
 *
 * **Absichtlich VOR dem Capacitor-Gate und ohne es.** Die Schnittstelle ist
 * Web-Standard, kein Huellen-Zusatz: sie wirkt in Safari am iPhone genauso
 * wie in unserer App, und beide haben dasselbe Problem — WebKit waehlt die
 * AVAudioSession nach dem, was es auf der Seite sieht, und weiss ohne diese
 * Zeile nichts von unserer Absicht. Fehlt die Schnittstelle (Chromium, Safari
 * vor iOS 17), geschieht nichts; das ist der richtige Rueckfall, denn dort
 * gibt es auch keine Session zu beeinflussen.
 *
 * Der Merker ist von `angewandt` getrennt: dieses wird beim Wiederherstellen
 * nach einer Unterbrechung absichtlich auf `aus` zurueckgesetzt, damit die
 * NATIVE Einrichtung erneut laeuft — die Absichtserklaerung an WebKit muss
 * deswegen aber nicht neu geschrieben werden.
 */
/**
 * **AUS, seit dem 2026-10-10 am Geraet.** Das Setzen des Typs liess die App
 * haengen: `navigator.audioSession.type` konfiguriert die AVAudioSession, und
 * unser `AudioSessionPlugin` tut dasselbe — beide gleichzeitig, auf derselben
 * Session. Der Verdacht ist damit noch nicht bewiesen, aber eine haengende App
 * ist nicht der Zustand, in dem man weitersucht.
 *
 * **Am 2026-10-10 gemessen, nachdem die Rueckkopplung behoben war** — der
 * erste Fehlschlag war also nicht zwangslaeufig der Schnittstelle
 * anzulasten. Ergebnis trotzdem negativ:
 *
 * - Kosten: die Kategorie-Wechsel kehrten zurueck, Spitzen von 9 pro
 *   Sekunde, wo es mit abgeschaltetem Schalter NULL in 45 s waren. Die
 *   Schnittstelle ist damit eine dritte Partei im Streit um dieselbe
 *   Session, nicht dessen Schlichtung.
 * - Nutzen: keiner messbar. Die Modus-Verteilung blieb im selben
 *   Verhaeltnis (videochat rund 70 % von default, in beiden Laeufen),
 *   WebKit reagierte auf die Ansage also nicht erkennbar.
 *
 * Grenzen der Messung, damit niemand mehr hineinliest als drin steht: je ein
 * Lauf, unterschiedlich lange gesprochen, und 219 Kabelabrisse im zweiten.
 * Die Kostenseite ist dennoch unzweideutig (0 gegen Spitzen von 9/s).
 *
 * Die Abbildung bleibt stehen (samt Tests): die Luecke ist echt, WebKit kennt
 * unsere Absicht weiterhin nicht. Was fehlt, ist das WIE — und nach dieser
 * Messung ist die naechste Frage nicht „wie setzen wir den Typ", sondern ob
 * unsere Huelle ueberhaupt noch eine eigene Session einrichten sollte.
 */
const WEB_AUDIO_SESSION_AN = false;

function webAudioSession(ziel: TonModus): void {
  if (!WEB_AUDIO_SESSION_AN) return;
  const typ = audioSessionTyp(ziel);
  if (typ === webTyp) return;
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (!nav.audioSession) return;
  try {
    nav.audioSession.type = typ;
    webTyp = typ;
  } catch {
    // Ein nicht angenommener Wert darf nichts weiter nach sich ziehen; den
    // Merker NICHT setzen, damit der naechste Anlauf es erneut versucht.
  }
}

/**
 * Wann wir zuletzt selbst an der Session gedreht haben.
 *
 * **Gegen eine Rückkopplung, die am 2026-10-10 am Gerät gemessen wurde.**
 * `setCategory`/`setActive` LÖSEN einen Routenwechsel aus — und der
 * Routenwechsel löste hier wieder ein Einrichten aus. Im Gerätelog standen
 * dadurch 4–10 Kategorie-Wechsel pro Sekunde, durchgehend, und über
 * 850.000 Zeilen allein aus `audiomxd` in wenigen Minuten. Die Folge war
 * nicht nur Last: jeder weitere Session-Ruf stand in dieser Schlange, die
 * Oberfläche fror ein, und das Mikrofon reagierte nicht mehr.
 *
 * Das Ereignis aus der Hülle trägt keine Nutzlast — JS kann also nicht
 * sehen, OB sich die Route wirklich geändert hat. Deshalb die Zeit als
 * Ersatz: ein Wechsel kurz nach dem eigenen Einrichten ist dessen Folge.
 * Sauberer wäre, die Hülle den Weg mitschicken zu lassen (`Tonweg` kennt
 * sie bereits) und nur bei echtem Wechsel neu einzurichten — das braucht
 * aber einen nativen Neubau.
 */
let zuletztAngewandt = 0;
/** Wie lange nach eigenem Einrichten ein Routenwechsel als dessen Folge gilt. */
const EIGENE_FOLGE_MS = 1500;
/** Ruhe, bevor ein echter Wechsel beantwortet wird — bündelt Schwälle. */
const WEG_RUHE_MS = 400;
let wegGriff: ReturnType<typeof setTimeout> | null = null;

/**
 * **Richtet die Hülle noch eine eigene Audio-Session ein? Nein — seit dem
 * 2026-10-10, und das ist der Kern der Sache.**
 *
 * In einer WebView gehört der Ton WebKit. Am Gerät gemessen: das Mikrofon
 * hängt an dessen Session, unsere führt keinen Ton. Zwei Sessions auf einem
 * Gerät überschreiben sich aber gegenseitig — im Mitschnitt standen
 * 4–10 Kategorie-Wechsel pro Sekunde, über 850.000 Protokollzeilen allein
 * aus `audiomxd` in Minuten, eine eingefrorene Oberfläche und ein Mikrofon,
 * das nicht reagierte. Drei Fehler, eine Ursache.
 *
 * Was WebKit von sich aus richtig macht, sobald ein Mikrofon offen ist:
 * `PlayAndRecord`, Sprach-Modus mit Apples Echo- und Rauschunterdrückung,
 * Lautsprecher als Vorgabe, 48 kHz. Genau das, was wir mühsam nachbauten.
 *
 * Was NUR nativ geht, bleibt und ist davon unberührt: die Ausgabe-Wahl über
 * Apples eigenen Dialog (`AVRoutePickerView`), die Sperrbildschirm-Anzeige,
 * und das Mithören von Unterbrechungen und Routenwechseln. Das sind
 * Benachrichtigungen und Bedienelemente — dafür braucht niemand eine eigene
 * Session.
 *
 * Der Schalter bleibt als Rückweg stehen. Was beim Einschalten zu erwarten
 * ist, steht oben; wer ihn umlegt, misst zuerst (`idevicesyslog`, Zeilen mit
 * `cmsSetCategoryOnPVMAndAudioDevice` zählen).
 *
 * **Offen und ungeprüft:** ob nach einer Unterbrechung (Telefonanruf, Siri)
 * WebKit seine Session von selbst zurückholt. Früher tat das unser Plugin für
 * seine eigene — die niemand hörte. Der Beobachter dafür läuft weiter und
 * ruft hier herein; mit abgeschaltetem Einrichten bleibt das wirkungslos.
 */
const EIGENE_SESSION_EINRICHTEN = false;

async function anwenden(): Promise<void> {
  const ziel = zielModus(voiceQuellen.size > 0, wiedergaben.size);
  webAudioSession(ziel);
  if (!isCapacitorIOS()) return;
  if (ziel === angewandt) return;
  angewandt = ziel;
  if (!EIGENE_SESSION_EINRICHTEN) return;
  // VOR dem nativen Ruf setzen, nicht erst danach: die Routenwechsel
  // entstehen WÄHREND er läuft.
  zuletztAngewandt = Date.now();
  if (ziel === 'voice') {
    await iosVoiceAktiv(true, hqFunk);
  } else if (ziel === 'wiedergabe') {
    await iosPlaybackModus();
  } else {
    await iosVoiceAktiv(false);
  }
  zuletztAngewandt = Date.now();
}

/**
 * Unterbrechungen (Telefonanruf, Siri, Wecker) — Roadmap-Punkt 26.
 *
 * **Warum das nicht ohne Zutun heilt:** iOS deaktiviert die Session zu Beginn
 * der Unterbrechung selbst. Danach steht sie auf tot, der Sprachkanal ist
 * stumm — und die Verbindung steht weiter, es sieht also nach „verbunden,
 * aber keiner hört mich" aus. Das Zurückschalten muss die App tun.
 *
 * **Und der Merker muss zurückgesetzt werden**, sonst passiert gar nichts:
 * `anwenden()` steigt aus, wenn das Ziel dem zuletzt Angewandten entspricht —
 * und das tut es hier, denn gewollt ist weiter `voice`. Die Session ist
 * trotzdem weg. Ohne diese eine Zeile wäre der ganze Beobachter wirkungslos.
 *
 * Der Abriss wird nicht gebraucht: der Beobachter lebt so lange wie die
 * Seite, und genauso lange gibt es eine Audio-Session zu reparieren.
 */
let beobachtet = false;

function unterbrechungenBeobachten(): void {
  if (beobachtet || !isCapacitorIOS()) return;
  beobachtet = true;
  iosUnterbrechungen((e) => {
    if (e.art === 'begonnen') {
      // iOS hat die Session schon abgeschaltet. Nur mitschreiben, damit das
      // Wiederherstellen unten greift.
      angewandt = 'aus';
      return;
    }
    // `weiterMoeglich` wird bewusst NICHT verlangt: iOS setzt es nicht
    // zuverlässig, und ein Sprachkanal, in dem jemand sitzt, soll zurück-
    // kommen. Scheitert das Aktivieren, bleibt es beim stillen No-op — wie
    // vorher, nur mit Versuch.
    angewandt = 'aus';
    void anwenden();
  });

  // **Wegwechsel richten die Session neu ein** (seit 2026-10-09). Die Hülle
  // wählt Kategorie und Modus nach dem AUSGABEWEG: am Lautsprecher mit
  // Apples Sprachverarbeitung, mit Kopfhörern im Ohr auf der
  // Hochqualitäts-Route. Dieser Wechsel kommt von KEINER Nutzeraktion — es
  // genügt, die AirPods einzusetzen. Ohne diesen Haken behielte die Session
  // die Konfiguration des alten Wegs, und mit ihr liefe entweder zweimal
  // gefiltert oder gar nicht.
  //
  // Auch hier muss der Merker fallen: gewollt ist weiter `voice`, nur die
  // Einrichtung dahinter ist eine andere (dieselbe Falle wie oben).
  iosWegWechsel(() => {
    if (voiceQuellen.size === 0) return; // ohne Mikrofon ist der Weg einerlei
    // Unsere eigene Einrichtung erzeugt Routenwechsel — die dürfen nicht die
    // nächste auslösen (s. `zuletztAngewandt`).
    if (Date.now() - zuletztAngewandt < EIGENE_FOLGE_MS) return;
    if (wegGriff) clearTimeout(wegGriff);
    wegGriff = setTimeout(() => {
      wegGriff = null;
      if (voiceQuellen.size === 0) return;
      if (Date.now() - zuletztAngewandt < EIGENE_FOLGE_MS) return;
      angewandt = 'aus';
      void anwenden();
    }, WEG_RUHE_MS);
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
  webTyp = null;
  zuletztAngewandt = 0;
  if (wegGriff) {
    clearTimeout(wegGriff);
    wegGriff = null;
  }
}

/** Der zuletzt angewandte Modus — für Anzeige und Tests. */
export function tonModusJetzt(): TonModus {
  return angewandt;
}
