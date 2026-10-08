import { isCapacitorIOS } from './runtime';
import { iosPlaybackModus, iosVoiceAktiv } from './iosAudioSession';
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

/** Sprachkanal betreten (`true`) oder verlassen (`false`). */
export function tonVoice(aktiv: boolean): void {
  voiceAktiv = aktiv;
  void anwenden();
}

/**
 * Ton einer Wiedergabe an- oder abmelden. `kennung` identifiziert die Quelle
 * (Stream-Kachel, Watch-Party) — mehrfaches Anmelden derselben Kennung zählt
 * einmal, s. Modulkopf.
 */
export function tonWiedergabe(kennung: string, an: boolean): void {
  if (an) wiedergaben.add(kennung);
  else wiedergaben.delete(kennung);
  void anwenden();
}

/** Testhilfe / Abmeldung: alles zurück auf Anfang. */
export function tonZuruecksetzen(): void {
  voiceAktiv = false;
  wiedergaben.clear();
  angewandt = 'aus';
}
