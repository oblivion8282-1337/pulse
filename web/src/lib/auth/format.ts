/**
 * Helpers for formatting authenticator codes in the UI.
 *
 *  - TOTP codes are 6-digit numeric. We *display* them as `123 456` (single
 *    space after the third digit) to make them easier to read while typing,
 *    but the wire-format expected by the server is the bare 6-digit string.
 *  - Backup codes are short, hyphenated alphanumeric tokens (server-defined
 *    shape — we don't constrain length here). UI normalizes them to
 *    uppercase + trims surrounding whitespace before sending.
 */

const TOTP_DISPLAY_SPLIT = 3;

/** Strip the display-only space (and any other non-digit garbage) so we can
 *  ship a clean 6-digit string to the server. Empty input → empty output. */
export function stripTotpFormatting(s: string): string {
  return s.replace(/\D/g, '');
}

/** Insert a single space between the first three and the last three digits.
 *  Caller is responsible for clamping to at most 6 digits beforehand. */
export function formatTotpDisplay(digits: string): string {
  if (digits.length <= TOTP_DISPLAY_SPLIT) return digits;
  return `${digits.slice(0, TOTP_DISPLAY_SPLIT)} ${digits.slice(TOTP_DISPLAY_SPLIT)}`;
}

/** Normalize a backup code for transmission: trim, uppercase, drop interior
 *  whitespace. Empty result indicates "user didn't type anything". */
export function normalizeBackupCode(s: string): string {
  return s.trim().replace(/\s+/g, '').toUpperCase();
}
