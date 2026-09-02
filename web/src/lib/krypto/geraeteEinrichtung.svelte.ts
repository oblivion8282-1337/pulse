/**
 * Die Verkabelung der Geraete-Einrichtung an `$state`, den gewoehnlichen
 * Geraete-Anmelde-Fluss und das Schloss — die Rechnung steht importfrei
 * daneben in `geraeteEinrichtung.ts`, samt Begruendung (B11, 2026-09-02).
 *
 * Der Lauf ist `starteGeraeteAnmeldung` — derselbe Weg, den der Login schon
 * Feuer-und-Vergessen anstoesst (`auth.svelte.ts`), derselbe Einmallauf mit
 * Warteschlange. Seit B11 wirft `runIssueFlow` das Scheitern der
 * Schluessel-Veroeffentlichung WEITER, sodass es hier ankommt und die Wand
 * es zeigt, statt es in der Konsole zu begraben.
 */
import { auth } from '../stores/auth.svelte';
import { geraeteEinrichtungErzeugen } from './geraeteEinrichtung';
import { schloss } from './schloss.svelte';

const stand = $state({ laeuft: false, fehlgeschlagen: false });

const einrichtung = geraeteEinrichtungErzeugen(
  async () => {
    const { starteGeraeteAnmeldung } = await import('$lib/identity/issue-flow');
    await starteGeraeteAnmeldung();
  },
  () => schloss.erneutFragen(auth.user?.id ?? ''),
  stand
);

export const geraeteEinrichtung = {
  get laeuft(): boolean {
    return stand.laeuft;
  },
  get fehlgeschlagen(): boolean {
    return stand.fehlgeschlagen;
  },
  /** Der Handlauf hinter dem Wand-Knopf: `true`, wenn die Einrichtung den
   *  eigenen Stand auf `verschluesselbar` gehoben hat (die Wand verschwindet
   *  dann von selbst), `false` bei Fehlschlag (der bleibt sichtbar). */
  starten: einrichtung.starten,
  /** Beim Erscheinen der Wand in App-Kontexten selbst anstossen — einmal je
   *  Seitenaufruf, s. `geraeteEinrichtung.ts`. */
  automatischAnstossen: einrichtung.automatischAnstossen
};
