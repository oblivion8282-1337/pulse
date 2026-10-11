/**
 * Die Weiche zum nativen Anrufweg auf iOS (Etappe 4): trägt der installierte
 * App-Bau den Anruf-Raum, oder läuft ein Anruf über WebKit wie bisher?
 *
 * **Mit `.ts`-Endungen in den Importen**, damit Nodes Läufer die Datei ganz
 * lädt — samt echtem `@capacitor/core` (`test/anruf-nativ-weiche.test.ts`).
 * Dieselbe Begründung wie bei `iosSpracheWeiche.ts`: die Antwort ist die
 * teuerste Zeile des Wegs, und eine Prüfung, die nur ihre Annahmen nachstellt,
 * hat das schon einmal übersehen (Bughunt 2026-10-11, K1).
 */

import { ANRUF_RAUM_METHODEN } from './anrufNativ.ts';
import { huellenBefund } from './huelleKann.ts';
import { nativerSprachwegBefund } from './iosSpracheWeiche.ts';

/**
 * Nativer Anrufweg — ja oder nein.
 *
 * **Nur zusammen mit dem nativen Sprachweg.** Die beiden teilen sich eine
 * Audio-Session, und deren Übergabe (`AnrufSitzung.swift`) rechnet mit einem
 * KANAL, der nativ läuft und sich anhalten lässt. Ein Kanal über WebKit neben
 * einem nativen Anruf wäre wieder eine zweite Partei an der Session — genau
 * die Lage, aus der der Umbau herausführt. Der Notschalter des Sprachwegs
 * (`NATIVER_SPRACHWEG_AN`) gilt damit für beide.
 *
 * **Und nur mit ALLEN Methoden** (`ANRUF_RAUM_METHODEN`): eine Hülle mit dem
 * alten `Anruf`-Plugin (ankommen, beenden, voipToken) bleibt vollständig beim
 * Web-Weg — ein halber nativer Anruf sähe verbunden aus und wäre stumm.
 */
export function nativerAnrufwegDa(): boolean {
  if (!nativerSprachwegBefund().nativ) return false;
  return huellenBefund('Anruf', ANRUF_RAUM_METHODEN).da;
}
