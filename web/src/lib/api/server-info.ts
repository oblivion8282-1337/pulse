/**
 * Pre-Check-Client für `.well-known/pulse-server-info` — Phase 4.3.
 *
 * Wird vom AddServerDialog aufgerufen, BEVOR ein ServerEntry angelegt wird.
 * Cross-Origin-Fetch direkt gegen die Self-Host-Origin — kein Auth, kein
 * Bearer-Token. Liefert ServerInfo oder einen typisierten Error-Code, den
 * der Dialog in eine deutsche Fehlermeldung übersetzt.
 *
 * Antwort-Shape (siehe services/chat-gateway/.../routes/server_info.py):
 *   { server_version, pulse_oidc_issuer, instance_id, capabilities[] }
 */

import { MIN_SERVER_VERSION } from './constants';

export type ServerInfo = {
  server_version: string;
  pulse_oidc_issuer: string;
  instance_id: string | null;
  capabilities: string[];
};

export type PreCheckOk = { ok: true; info: ServerInfo; hostname: string };
export type PreCheckErr = {
  ok: false;
  /** 'unreachable' | 'too-old' | 'bad-response' | 'cors' */
  reason: 'unreachable' | 'too-old' | 'bad-response' | 'cors';
  details?: string;
};
export type PreCheckResult = PreCheckOk | PreCheckErr;

/** Semver-Compare (a vs b) — duplicated from gateway-connection.ts but
 *  scoped to module-private; das doppelt-implementieren ist OK weil 8
 *  Zeilen Helper und nicht reuseable cross-feature ohne neuen Public-Wrap. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Normalisiert Hostname (lowercase, strip trailing slash, HTTPS-Prefix). */
function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\/+$/, '');
  if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Validiert URL-Form + ruft `.well-known/pulse-server-info` ab.
 *
 * Timeout: 8s — Self-Host-Server kann hinter VPN/lahmen Leitungen leben,
 * aber 8s ist eine harte UX-Grenze. AbortController.
 */
export async function preCheckServer(
  rawUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<PreCheckResult> {
  const hostname = normalizeHostname(rawUrl);
  // Form-Validierung: Hostname mit Punkt + kein Path (außer /)
  try {
    const url = new URL(hostname);
    if (!url.hostname || !url.hostname.includes('.')) {
      return { ok: false, reason: 'bad-response', details: 'Keine gültige URL.' };
    }
  } catch {
    return { ok: false, reason: 'bad-response', details: 'Keine gültige URL.' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);

  let resp: Response;
  try {
    resp = await fetch(`${hostname}/.well-known/pulse-server-info`, {
      method: 'GET',
      signal: ac.signal,
      mode: 'cors',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = (err as Error)?.message ?? '';
    // Browser maskiert echte CORS-Fehler als generic TypeError "Failed to
    // fetch" — wir können sie nicht zuverlässig vom Network-Down trennen.
    // Fallback: 'unreachable' deckt beide UX-mäßig sauber ab.
    return { ok: false, reason: 'unreachable', details: msg };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    return { ok: false, reason: 'bad-response', details: `HTTP ${resp.status}` };
  }

  let info: ServerInfo;
  try {
    info = (await resp.json()) as ServerInfo;
  } catch {
    return { ok: false, reason: 'bad-response', details: 'Antwort kein JSON.' };
  }

  if (typeof info?.server_version !== 'string') {
    return { ok: false, reason: 'bad-response', details: 'Fehlende server_version.' };
  }

  if (compareVersions(info.server_version, MIN_SERVER_VERSION) < 0) {
    return { ok: false, reason: 'too-old' };
  }

  return { ok: true, info, hostname };
}
