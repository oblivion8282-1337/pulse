/**
 * "vor 3h" / "gestern" / "vor 5 Tagen" / "in 3 Monaten"-style relative-time
 * formatter, German UI strings. Local-only — no i18n layer yet in Pulse.
 *
 * Bidirektional: Past liefert "vor …", Future liefert "in …". Tiny clock-skew
 * (Δ < 45s in beide Richtungen) rendert als "gerade eben" statt eines
 * verwirrenden "in 3s" / "vor 3s".
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
  const diffMs = Date.now() - t;
  const secs = Math.floor(Math.abs(diffMs) / 1000);
  const future = diffMs < 0;
  const past = (s: string) => (future ? `in ${s}` : `vor ${s}`);

  if (secs < 45) return 'gerade eben';
  if (secs < 90) return past('1 Min.');
  if (secs < HOUR) return past(`${Math.round(secs / MIN)} Min.`);
  if (secs < 2 * HOUR) return past('1 Std.');
  if (secs < DAY) return past(`${Math.round(secs / HOUR)} Std.`);
  if (secs < 2 * DAY) return future ? 'morgen' : 'gestern';
  if (secs < WEEK) return past(`${Math.round(secs / DAY)} Tagen`);
  if (secs < 2 * WEEK) return past('1 Woche');
  if (secs < MONTH) return past(`${Math.round(secs / WEEK)} Wochen`);
  if (secs < 2 * MONTH) return past('1 Monat');
  if (secs < YEAR) return past(`${Math.round(secs / MONTH)} Monaten`);
  if (secs < 2 * YEAR) return past('1 Jahr');
  return past(`${Math.round(secs / YEAR)} Jahren`);
}
