/**
 * Ob und warum das Eingabefeld eines Direktgespraechs gesperrt ist —
 * importfrei, damit sie ohne Svelte/Runes-Kompilierung pruefbar ist
 * (s. CLAUDE.md „Zwei Fallen").
 *
 * Die Sperre 'ohne_app' (Spec §3a: ohne App-Geraet keine Direktnachrichten)
 * ist seit dem 2026-09-12 aufgehoben (Entscheidung des Eigentuemers): auch
 * reine Browser-Konten senden und empfangen. Der Schutz fuer BEIDE Seiten
 * war nie Krypto, sondern Haltbarkeit — er lebt als einmaliger Warnhinweis
 * im Browser weiter (`krypto/dmBrowserWarnung.ts`). Uebrig bleibt als
 * Sperrgrund nur der Kontakt (keine Freundschaft oder blockiert).
 */
export type DmSendeSperre = null | 'kontakt';

export function dmSendeSperre(darfSenden: boolean): DmSendeSperre {
  if (!darfSenden) return 'kontakt';
  return null;
}
