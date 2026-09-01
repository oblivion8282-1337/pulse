/**
 * Dateigroessen fuer die Anzeige — die eine Stelle.
 *
 * Stand bis zum 2026-09-01 dreimal wortgleich in Komponenten
 * (`DateiablageAnsicht.svelte`, `CommunityDateiablage.svelte`,
 * `routes/app/ablage/+page.svelte`). Das ist wenig Code, aber es sind drei
 * Stellen, an denen dieselbe Datei unterschiedlich gross heissen kann,
 * sobald jemand eine davon anfasst — und die drei Ansichten zeigen zum Teil
 * dieselben Dateien.
 *
 * **1024, nicht 1000, und die Einheiten heissen trotzdem KB/MB.** Das ist
 * streng genommen falsch (SI sagt kB = 1000, IEC sagt KiB = 1024), bleibt
 * aber so: es ist die Schreibweise, die alle drei Ansichten seit ihrer
 * Entstehung zeigen, und eine stille Umstellung liesse jede Datei ploetzlich
 * anders gross aussehen, ohne dass sich etwas geaendert haette.
 *
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`).
 */

/** Bytes als kurze Anzeige: `B` ganzzahlig, darueber `KB`/`MB` mit einer
 *  Nachkommastelle. Negative Werte kommen nicht vor (Dateigroessen); ein
 *  solcher Wert faellt in den `B`-Zweig und wird unveraendert gezeigt. */
export function groesseText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
