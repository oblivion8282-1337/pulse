/**
 * "vor 3h" / "gestern" / "vor 5 Tagen"-style relative-time formatter,
 * German UI strings. Local-only — no i18n layer yet in Pulse.
 *
 * Always renders in the past tense: sessions are server-side events, so
 * `last_used_at` is by definition <= now. Tiny clock-skew (a few seconds
 * either way) renders as "gerade eben" instead of crashing into a
 * confusing "in 3s" future label.
 */

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));

  if (secs < 45) return 'gerade eben';
  if (secs < 90) return 'vor 1 Min.';
  if (secs < HOUR) return `vor ${Math.round(secs / MIN)} Min.`;
  if (secs < 2 * HOUR) return 'vor 1 Std.';
  if (secs < DAY) return `vor ${Math.round(secs / HOUR)} Std.`;
  if (secs < 2 * DAY) return 'gestern';
  if (secs < WEEK) return `vor ${Math.round(secs / DAY)} Tagen`;
  if (secs < 2 * WEEK) return 'vor 1 Woche';
  if (secs < MONTH) return `vor ${Math.round(secs / WEEK)} Wochen`;
  if (secs < 2 * MONTH) return 'vor 1 Monat';
  if (secs < YEAR) return `vor ${Math.round(secs / MONTH)} Monaten`;
  if (secs < 2 * YEAR) return 'vor 1 Jahr';
  return `vor ${Math.round(secs / YEAR)} Jahren`;
}
