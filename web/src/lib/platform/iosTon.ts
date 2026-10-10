import { isCapacitorIOS } from './runtime';
import {
  iosJetztLaeuft,
  iosJetztLaeuftAus,
  iosPlaybackModus,
  iosUnterbrechungen,
  iosWegWechsel,
  iosVoiceAktiv
} from './iosAudioSession';
import {
  audioSessionTyp,
  wegAntwort,
  zielModus,
  type AudioSessionTyp,
  type TonModus
} from './tonModus';

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
  angewandt = 'aus';
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
 * **AUS — am 2026-10-10 am Geraet gemessen, mit Vorher/Nachher.**
 *
 * Die Vermutung war, diese Schnittstelle sei der Hebel auf WebKits eigene
 * Session: die Session, die den Sprachton wirklich abspielt, gehoert WebKits
 * Prozess, und unser natives `overrideOutputAudioPort` erreicht sie nicht —
 * es dreht unsere Session (die meldet danach brav `Receiver`), waehrend die
 * aktive Systemroute auf dem Lautsprecher bleibt. Daran scheitert die
 * Hoermuschel, und deshalb beweist der funktionierende Lautsprecher nichts:
 * dorthin geht WebKit von selbst.
 *
 * **Gemessen, mit und ohne diese Zeile, je drei Beitritte, iOS 26.6.2:**
 *
 * | | WebKits Session im Geraetelog |
 * |---|---|
 * | aus | `PlayAndRecord_WithBluetooth_DefaultToSpeaker/VideoChat` |
 * | an | dasselbe, plus einmal `…_DefaultToSpeaker/Default` |
 *
 * Die Zeile KOMMT also an — der Modus kippte sichtbar. **`DefaultToSpeaker`
 * bleibt trotzdem**, und genau darauf kam es an. Das deckt sich mit der
 * W3C-API: sie kennt die Typen `auto`/`playback`/`ambient`/`play-and-record`
 * und kein Gegenstueck zu `defaultToSpeaker` — eine Route waehlt man damit
 * nicht.
 *
 * Geblieben ist nur eine Nebenwirkung, und zwar eine unerwuenschte: in
 * `Default` statt `VideoChat` ist Apples Sprachverarbeitung AUS, waehrend
 * unsere Seite sie fuer an haelt (`tonSystemFiltert` liest unsere eigene
 * Session) — ein Fenster ohne jede Echo-Unterdrueckung. Beobachtet wurde es
 * beim Wechsel zwischen zwei Beitritten, nicht im laufenden Gespraech; ein
 * Risiko ohne Gegenwert bleibt es trotzdem.
 *
 * **Die Abbildung bleibt stehen** (samt Tests) und der Schalter auch, denn
 * eine Frage ist ungeprueft: ob diese Absichtserklaerung mitentscheidet, ob
 * WebKit die Seite bei gesperrtem Bildschirm weiterlaufen laesst. Wer das
 * messen will, hat hier den Schalter — und oben die Zahlen, gegen die er
 * vergleichen muss.
 *
 * **Was die Hoermuschel wirklich braucht:** dass der Sprachton nicht mehr von
 * WebKit abgespielt wird. Dafuer gibt es keine Abkuerzung aus dem Web heraus.
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

async function anwenden(): Promise<void> {
  const ziel = zielModus(voiceQuellen.size > 0, wiedergaben.size);
  webAudioSession(ziel);
  if (!isCapacitorIOS()) return;
  if (ziel === angewandt) return;
  angewandt = ziel;
  const vorher = systemFiltert;
  if (ziel === 'voice') {
    const antwort = await iosVoiceAktiv(true, hqFunk);
    systemFiltert = antwort.modus === 'voiceChat';
    wegAngewandt = antwort.weg;
  } else if (ziel === 'wiedergabe') {
    await iosPlaybackModus();
    systemFiltert = false;
    // Die Wiedergabe-Kategorie richtet sich nicht nach dem Weg — was gilt,
    // ist damit unbekannt. Nicht raten.
    wegAngewandt = null;
  } else {
    const antwort = await iosVoiceAktiv(false);
    systemFiltert = false;
    wegAngewandt = antwort.weg;
  }
  if (systemFiltert !== vorher) {
    // Kopie, weil ein Hörer sich im Ruf abmelden darf.
    for (const h of [...filterHoerer]) h();
  }
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
        angewandt = 'aus';
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
  webTyp = null;
  wegAngewandt = null;
}

/** Der zuletzt angewandte Modus — für Anzeige und Tests. */
export function tonModusJetzt(): TonModus {
  return angewandt;
}
