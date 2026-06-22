/**
 * Normalise a server hostname: trim, lowercase, strip trailing slash(es),
 * force HTTPS. `http://` is upgraded to `https://` — never accept a cleartext
 * self-host origin (TLS is mandatory for the cert model + WS origin check, and
 * stops session tokens travelling in the clear via a deep-link host param).
 */
export function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\/+$/, '');
  return `https://${trimmed.replace(/^https?:\/\//, '')}`;
}
