/**
 * Vollständiger Zeitstempel für Listen („01.02.2026, 13:37"), de-DE.
 * Bewusst nicht `kurzeUhrzeit`/`formatRelative`: Audit-Logs und Moderations-
 * listen brauchen den absoluten Zeitpunkt, keine Relativangabe.
 */
export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
