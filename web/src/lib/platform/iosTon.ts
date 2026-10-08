import { isCapacitorIOS } from './runtime';
import {
  iosJetztLaeuft,
  iosJetztLaeuftAus,
  iosPlaybackModus,
  iosUnterbrechungen,
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

let voiceAktiv = false;
const wiedergaben = new Set<string>();
let angewandt: TonModus = 'aus';

async function anwenden(): Promise<void> {
  if (!isCapacitorIOS()) return;
  const ziel = zielModus(voiceAktiv, wiedergaben.size);
  if (ziel === angewandt) return;
  angewandt = ziel;
  if (ziel === 'voice') await iosVoiceAktiv(true);
  else if (ziel === 'wiedergabe') await iosPlaybackModus();
  else await iosVoiceAktiv(false);
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
}

/** Sprachkanal betreten (`true`) oder verlassen (`false`). */
export function tonVoice(aktiv: boolean): void {
  unterbrechungenBeobachten();
  voiceAktiv = aktiv;
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
  voiceAktiv = false;
  wiedergaben.clear();
  angewandt = 'aus';
}

/** Der zuletzt angewandte Modus — für Anzeige und Tests. */
export function tonModusJetzt(): TonModus {
  return angewandt;
}
