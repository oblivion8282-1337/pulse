/**
 * Der unterscheidbare Ablauf eines verschluesselten Anhangs (gerettete Idee,
 * UEBERGABE-MOBILE §5): die Abrufadresse antwortet mit 410
 * `anhang_abgelaufen`, wenn die Frist der eigenen Zustellung vorueber ist —
 * neben der aelteren 410 `anhang_im_laufwerk`, die KEIN Fehler ist, sondern
 * den Verweis auf das eigene Archiv-Laufwerk. Der `detail`-Text ist der
 * Unterschied, der Status allein reicht nicht.
 *
 * Eigenes Modul, weil der Praedikat-Check ohne die Importkette von
 * `anhangHolen.ts` (API-, Store-, Svelte-Module) pruefbar bleiben soll —
 * derselbe Grund wie `kopplung/einloesFehler.ts`.
 */

/** Wie ein `ApiError` aus `api/client.ts` aussieht: Status oben, Rumpf
 *  unter `body`, Grund unter `body.detail`. `anhangHolen.ts` wirft den
 *  Fehler direkt durch (`throw`), die Oberfläche liest ententypisiert —
 *  ohne Klassenbezug, wie `kopplung/einloesFehler.ts`. */
export function istAnhangAbgelaufenFehler(fehler: unknown): boolean {
  const kandidat = fehler as { status?: unknown; body?: { detail?: unknown } } | null;
  return kandidat?.status === 410 && kandidat?.body?.detail === 'anhang_abgelaufen';
}
