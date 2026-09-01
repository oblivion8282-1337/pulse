/**
 * Langes Datum für Changelog-Toast und Passkey-Zeile:
 *   style 'long'  → „1. September 2026" (langer Monat, Tag ohne Null)
 *   style 'short' → „01. Sep. 2026"     (kurzer Monat, zweistelliger Tag)
 * Müll/leer → '' — die Aufrufer rendern dann ihren eigenen Fallback.
 * Importfrei, damit Tests die Datei direkt prüfen können.
 */
export function formatLangDatum(
  iso: string | null | undefined,
  style: 'long' | 'short' = 'long'
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('de-DE', {
    day: style === 'short' ? '2-digit' : 'numeric',
    month: style === 'short' ? 'short' : 'long',
    year: 'numeric'
  });
}
