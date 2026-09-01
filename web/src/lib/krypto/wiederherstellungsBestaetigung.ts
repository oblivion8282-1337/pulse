/**
 * Reine Prüfung für die Bestätigungsabfrage beim ersten Zeigen des
 * Wiederherstellungs-Codes (E4, Aufgabe 4): „tippe die dritte Gruppe ab",
 * damit niemand den Code wegklickt, ohne ihn wirklich notiert zu haben.
 *
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`), damit diese
 * Rechnung ohne Svelte-Kompilierung prüfbar ist — `WiederherstellungCodeZeigen.svelte`
 * ist die einzige Aufruferin.
 */

const TRENNER = /[\s-]+/;

/** Zerlegt die Anzeigeform (z. B. "AB12-CD34-...") in ihre Vierergruppen. */
export function gruppen(code: string): string[] {
	return code.trim().split(TRENNER).filter((g) => g.length > 0);
}

/** Die Gruppe an `index` (0-basiert) — `undefined`, wenn der Code weniger Gruppen hat. */
export function gruppeAn(code: string, index: number): string | undefined {
	return gruppen(code)[index];
}

/**
 * Vergleicht grosszügig — Gross-/Kleinschreibung und umgebender Leerraum sind
 * egal, dieselbe Nachsicht, mit der `wiederherstellungsCode.ts::normalisiere`
 * den ganzen Code liest. Eine leere Eingabe passt nie, auch wenn die
 * gesuchte Gruppe aus irgendeinem Grund selbst leer wäre.
 */
export function bestaetigungPasst(code: string, eingabe: string, index: number): boolean {
	const soll = gruppeAn(code, index);
	const ist = eingabe.trim();
	if (!soll || !ist) return false;
	return soll.toUpperCase() === ist.toUpperCase();
}
