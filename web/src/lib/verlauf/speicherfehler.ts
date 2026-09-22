/**
 * Deutet einen beim lokalen Verlauf aufgetretenen Fehler — importfrei, damit
 * Nodes Testläufer die Rechnung direkt prüft (kein erweiterungsloser
 * Laufzeit-Import möglich, s. CLAUDE.md „Die Falle").
 *
 * Absichtlich GETRENNT von `zustand.svelte.ts`: dieses Modul hier bleibt
 * reine Funktion, `zustand.svelte.ts` nutzt `$state` — und `$state()` ist
 * ein Svelte-Compiler-Symbol, kein echter globaler Export. Ausserhalb einer
 * Svelte-Kompilierung (also unter Nodes `--test`) wirft jeder Aufruf sofort
 * `$state is not defined`. Ein Test, der `zustand.svelte.ts` direkt
 * importiert, würde also schon am Modul-Top-Level scheitern, bevor er
 * `deuteSpeicherfehler` überhaupt erreicht — deshalb liegt die geprüfte
 * Rechnung hier, im importfreien Nachbarmodul (Muster: `satz.ts` neben
 * `db.ts`, `monitorZuordnung.ts` neben seinem `.svelte.ts`-Verbraucher).
 */

/** Die vier Lagen — Reihenfolge der Prüfung ist irrelevant, die Mengen sind
 *  disjunkt. `zu_neu` (2026-09-22): der gespeicherte Bestand trägt eine
 *  HÖHERE Fassung als der Code — nur möglich in Profilen, die einmal einen
 *  Experimentier-Zweig mit jüngerer Fassung geladen haben. */
export type SpeicherLage = 'nicht_verfuegbar' | 'voll' | 'zu_neu' | 'fehler';

export type GedeuteterFehler = {
  art: SpeicherLage;
};

/** Firefox verweigert IndexedDB im privaten Modus mit `SecurityError`, Safari
 *  mit `InvalidStateError`. Beides ist eine Lage, kein Defekt der App. */
const NICHT_VERFUEGBAR_NAMEN = new Set(['SecurityError', 'InvalidStateError']);

/** `QuotaExceededError` — der Browser hat das Speicherlimit erreicht. */
const VOLL_NAMEN = new Set(['QuotaExceededError']);

/** `VersionError` — der Bestand ist jünger als die laufende App-Fassung. */
const ZU_NEU_NAMEN = new Set(['VersionError']);

/**
 * fail-loud: alles, was sich keiner der bekannten Lagen zuordnen lässt, gilt
 * als echter Fehler — nicht als „wird schon nichts Ernstes sein".
 */
export function deuteSpeicherfehler(err: unknown): GedeuteterFehler {
  const name = err instanceof Error ? err.name : undefined;
  if (name && NICHT_VERFUEGBAR_NAMEN.has(name)) return { art: 'nicht_verfuegbar' };
  if (name && VOLL_NAMEN.has(name)) return { art: 'voll' };
  if (name && ZU_NEU_NAMEN.has(name)) return { art: 'zu_neu' };
  return { art: 'fehler' };
}
