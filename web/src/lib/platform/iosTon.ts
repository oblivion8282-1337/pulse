import { isCapacitorIOS } from './runtime';
import {
  iosJetztLaeuft,
  iosJetztLaeuftAus,
  iosPlaybackModus,
  iosUnterbrechungen,
  iosWegWechsel,
  iosVoiceAktiv
} from './iosAudioSession';
import { zielModus, type TonModus } from './tonModus';

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

async function anwenden(): Promise<void> {
  if (!isCapacitorIOS()) return;
  const ziel = zielModus(voiceQuellen.size > 0, wiedergaben.size);
  if (ziel === angewandt) return;
  angewandt = ziel;
  const vorher = systemFiltert;
  if (ziel === 'voice') {
    systemFiltert = (await iosVoiceAktiv(true, hqFunk)) === 'voiceChat';
  } else if (ziel === 'wiedergabe') {
    await iosPlaybackModus();
    systemFiltert = false;
  } else {
    await iosVoiceAktiv(false);
    systemFiltert = false;
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
  iosWegWechsel(() => {
    if (voiceQuellen.size === 0) return; // ohne Mikrofon ist der Weg einerlei
    angewandt = 'aus';
    void anwenden();
  });
}

/**
 * Eine Voice-Quelle an- oder abmelden.
 *
 * `kennung` unterscheidet die Verbraucher (`'sprachkanal'`, `'anruf'`). Ohne
 * sie würde der eine dem anderen die Session wegnehmen — Begründung an
 * `voiceQuellen`.
 */
export function tonVoice(kennung: string, aktiv: boolean): void {
  unterbrechungenBeobachten();
  if (aktiv) voiceQuellen.add(kennung);
  else voiceQuellen.delete(kennung);
  void anwenden();
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
}

/** Der zuletzt angewandte Modus — für Anzeige und Tests. */
export function tonModusJetzt(): TonModus {
  return angewandt;
}
