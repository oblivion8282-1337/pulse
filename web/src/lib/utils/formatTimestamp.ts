import { currentLocale } from '$lib/i18n';

/**
 * Vollständiger Zeitstempel für Listen („01.02.2026, 13:37").
 * Bewusst nicht `kurzeUhrzeit`/`formatRelative`: Audit-Logs und Moderations-
 * listen brauchen den absoluten Zeitpunkt, keine Relativangabe.
 *
 * Default ist die App-Sprache (Bughunt Runde 14: englische Nutzer lasen
 * deutsche Daten); die bewusst deutsche Admin-Fläche pinnt 'de-DE'.
 */
export function formatTimestamp(iso: string, locale: string = currentLocale()): string {
  return new Date(iso).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
