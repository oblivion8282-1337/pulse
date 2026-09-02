/**
 * Reine Entscheidung fuer `index.ts::verlaufSpeichernPflicht` — importfrei,
 * damit Nodes Testlaeufer sie direkt prueft, ohne `index.ts` zu importieren
 * (das haengt an `$lib/stores/directMessages.svelte`, dessen `$state()` beim
 * Modul-Top-Level mit „$state is not defined" scheitern wuerde, s. CLAUDE.md
 * „Die Falle").
 *
 * Bughunt 2026-08-28, FIX 1: `verlaufSpeichernPflicht` gab in zwei Faellen
 * `Promise.resolve(0)` OHNE Wurf zurueck (unbekannter DM-Kanal, keine
 * speicherbaren Saetze nach `baueSaetze`) — `krypto/quittierbareIds.ts`
 * wertet jeden nicht werfenden Aufruf als Erfolg und quittiert dann beim
 * Server, obwohl lokal nichts abgelegt wurde. Fuer die alleinigen Aufrufer
 * von `verlaufSpeichernPflicht` (`krypto/senden.ts`, `krypto/empfangen.ts`,
 * `krypto/gruppe/*`) ist jeder Kanal, den sie sehen, ein lokal gefuehrter
 * Kanal — Postfach-Zustellungen gibt es nur fuer DMs und private Gruppen.
 * `istLokalerKanal === false` heisst dort also nicht "kein DM/keine Gruppe,
 * ueberspringen" (das ist `verlaufSpeichern`s legitimer Fall), sondern immer
 * "dieser Kanal ist lokal noch nicht bekannt" — am haeufigsten die erste
 * Nachricht eines Gespraechs, bevor der `ready`-Rahmen/`dm_channel_created`
 * angekommen ist, bei Gruppen bevor `GET /gruppen` durch ist.
 * `pruefeSpeicherErgebnis` wirft deshalb in BEIDEN Faellen: weder verwerfen
 * (endgueltiger Datenverlust) noch stillschweigend gelten lassen (derselbe
 * Verlust, nur einen Schritt spaeter ueber die Quittung).
 *
 * **Der Parameter hiess bis Etappe G2 `istDmKanal`.** Umbenannt, weil er
 * seither auch fuer private Gruppen `true` sein muss — ein Name, der nur die
 * eine Kanalart nennt, waere an dieser Stelle eine falsche Behauptung.
 */

export class VerlaufSpeichernFehlgeschlagen extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerlaufSpeichernFehlgeschlagen';
  }
}

/** Wirft `VerlaufSpeichernFehlgeschlagen`, wenn nichts gespeichert wurde/wird
 *  — s. Modulkopf. Kehrt sonst ohne Rueckgabewert zurueck. */
export function pruefeSpeicherErgebnis(
  kanalId: string,
  istLokalerKanal: boolean,
  saetzeAnzahl: number
): void {
  if (!istLokalerKanal) {
    throw new VerlaufSpeichernFehlgeschlagen(
      `Kanal ${kanalId} ist lokal (noch) nicht als DM oder private Gruppe bekannt`
    );
  }
  if (saetzeAnzahl === 0) {
    throw new VerlaufSpeichernFehlgeschlagen(`keine speicherbaren Saetze fuer Kanal ${kanalId}`);
  }
}
