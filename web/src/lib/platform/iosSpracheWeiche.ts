/**
 * Die Weiche zum nativen Sprachweg auf iOS: nimmt die Oberfläche den Raum der
 * Hülle (`iosSprache.ts`) oder bleibt sie beim Web-Weg?
 *
 * **Eigene Datei, und mit `.ts`-Endungen in den Importen**, damit sie unter
 * Nodes Läufer GANZ lädt — samt echtem `@capacitor/core`
 * (`test/ios-sprache-weiche.test.ts`). Die Entscheidung ist die teuerste
 * Zeile des ganzen Wegs: eine falsche Antwort nimmt einem Telefon die Sprache,
 * und eine Prüfung, die nur ihre Annahmen nachstellt, hat das schon einmal
 * übersehen (Bughunt 2026-10-11, K1). `iosSprache.ts` reicht beide
 * Funktionen weiter; kein Aufrufer muss seinen Import ändern.
 */

import { huellenBefund } from './huelleKann.ts';
import { SPRACHE_METHODEN } from './iosSpracheTypen.ts';
import { isCapacitorIOS } from './runtime.ts';

/**
 * **Notschalter. AN seit dem 2026-10-10** (Eigentümer-Entscheid: der native
 * Weg soll es werden, und zwar sauber).
 *
 * Er bleibt als Schalter stehen, weil die Web-App zentral ausgeliefert wird
 * und JEDES Telefon sofort erreicht: wer hier etwas kaputtmacht, nimmt allen
 * iOS-Nutzern die Sprache, bis ein neuer Bau draussen ist. Mit dem Schalter
 * ist der Rückweg eine Zeile.
 *
 * **Er hat an genau diesem Tag schon einmal Zeit gekostet:** auf `false`
 * gesetzt und dann vergessen, liefen vier Messläufe unbemerkt auf dem ALTEN
 * Weg — die Oberfläche sah richtig aus, nur die Zahlen gehörten zu etwas
 * anderem. Wer hier misst, prüft diesen Wert ZUERST (oder liest
 * `pulse.diag.weiche`, s. `connect` in `voice/livekit.svelte.ts`).
 */
const NATIVER_SPRACHWEG_AN = true;

/** Wie die Weiche entschieden hat — und warum. Landet als
 *  `pulse.diag.weiche` im Speicher. */
export type WeichenBefund =
  | { nativ: true }
  | { nativ: false; grund: 'abgeschaltet' | 'kein-ios' | 'kein-plugin' }
  | { nativ: false; grund: 'methoden-fehlen'; fehlen: string[] };

/**
 * Trägt diese App den nativen Weg — VOLLSTÄNDIG?
 *
 * **Gefragt wird die HÜLLE, nicht `Capacitor.Plugins`.** Bis zum 2026-10-11
 * stand hier `Plugins.SprachePlugin !== undefined` — und das war immer wahr:
 * `registerPlugin` in `iosSprache.ts` schreibt den Eintrag beim Import selbst
 * hinein, ob die Hülle das Plugin hat oder nicht (Bughunt 2026-10-11, K1).
 *
 * **Und es reicht nicht, dass das Plugin da ist.** Am selben Tag trug das
 * Telefon des Eigentümers ein `SprachePlugin` mit fünf Methoden
 * (`beitreten, verlassen, mikrofon, ausgabe, zustand`); die Oberfläche ruft
 * elf. Der Kern lehnt die fehlenden sofort ab (`UNIMPLEMENTED` — in Node
 * und im Simulator nachgestellt, s. `huelleKann.ts`; am Gerät nicht gesehen),
 * und die Aufrufer schlucken das: Taubstellen würde das Zeichen kippen und
 * allen „taub" melden, gehört würde weiter alles; die Kanalansicht ginge nie
 * auf, die Regler täten nichts. **Ein halber nativer Weg ist schlechter als der
 * alte Web-Weg** — er sieht funktionierend aus, wo er es nicht ist. Deshalb
 * gilt: alle Methoden aus `SPRACHE_METHODEN`, oder der Web-Weg, vollständig.
 */
export function nativerSprachwegBefund(): WeichenBefund {
  if (!NATIVER_SPRACHWEG_AN) return { nativ: false, grund: 'abgeschaltet' };
  if (!isCapacitorIOS()) return { nativ: false, grund: 'kein-ios' };
  const befund = huellenBefund('SprachePlugin', SPRACHE_METHODEN);
  if (befund.da) return { nativ: true };
  return befund.grund === 'methoden-fehlen'
    ? { nativ: false, grund: 'methoden-fehlen', fehlen: befund.fehlen }
    : { nativ: false, grund: 'kein-plugin' };
}

export function nativerSprachwegDa(): boolean {
  return nativerSprachwegBefund().nativ;
}
