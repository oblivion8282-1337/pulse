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

import { compareVersions } from '$lib/utils/semver';
import { normalizeHostname } from '$lib/utils/hostname';
import { MIN_SERVER_VERSION } from './constants';
import { deuteAbrufFehler } from './verbindungsbefund';

/**
 * Gegenprobe ohne CORS-Anspruch: antwortet unter dieser Adresse überhaupt
 * etwas? `mode:'no-cors'` verlangt keine Header und liefert bei einem
 * laufenden Server eine opaque Antwort — lesen lässt sie sich nicht, aber
 * dass sie kam, ist die ganze Aussage.
 *
 * Bewusst gegen `/health` statt gegen das well-known: `/health` ist auf jedem
 * Self-Host öffentlich (Caddyfile-Template) und antwortet auch dann noch, wenn
 * Datenbank oder Redis liegen — es geht hier um das Netz, nicht um die
 * Gesundheit. Ein einfacher GET, also kein Preflight.
 */
async function antwortetUeberhaupt(hostname: string, timeoutMs: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await fetch(`${hostname}/health`, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: ac.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
  reason: 'unreachable' | 'too-old' | 'bad-response' | 'bad-url' | 'cors';
  details?: string;
};
export type PreCheckResult = PreCheckOk | PreCheckErr;

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
  // Form-Validierung: Hostname muss entweder einen Punkt enthalten (FQDN
  // oder IPv4-Literal) oder ``localhost`` sein. Letzteres ist explizit
  // erlaubt, weil Dev- und Test-Setups regelmäßig gegen einen lokalen
  // Self-Host-Stack laufen — der Browser behandelt ``localhost`` zudem als
  // secure context (RFC 6761 §6.3), TLS-Garantien bleiben erhalten.
  try {
    const url = new URL(hostname);
    const h = url.hostname;
    if (!h || (h !== 'localhost' && !h.includes('.'))) {
      return { ok: false, reason: 'bad-url', details: 'Keine gültige URL.' };
    }
  } catch {
    return { ok: false, reason: 'bad-url', details: 'Keine gültige URL.' };
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
    // Der Browser maskiert einen CORS-Block als denselben generischen
    // `TypeError: Failed to fetch` wie ein totes Netz — aus dem Fehler ALLEIN
    // ist das nicht zu trennen. Trennbar ist es über eine Gegenprobe mit
    // `mode:'no-cors'`: die verlangt keine Header und liefert bei einem
    // laufenden Server eine (opaque) Antwort. Kommt die, steht der Server und
    // es fehlen nur die Header — ein Befund, zu dem es eine andere Handlung
    // gibt (Proxy-/CORS_ALLOW_ORIGINS-Konfiguration statt DNS/Firewall).
    //
    // Was die Gegenprobe NICHT trennt: ein ungültiges Zertifikat scheitert
    // hier genauso wie ein totes Netz. Der Browser gibt dazu nichts her; die
    // genaue Auskunft holt die Electron-Diagnose (`netdiag`), die den
    // Handschlag selbst führen kann.
    return {
      ok: false,
      reason: deuteAbrufFehler(await antwortetUeberhaupt(hostname, opts.timeoutMs ?? 8000)),
      details: msg,
    };
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
