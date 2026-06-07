/**
 * Cert-Login-Client (Phase 5.2) — Self-Host Cert-Auth.
 *
 * Stateless two-step flow gegen Self-Host-Server:
 *   1. POST /cert-login/challenge {cert}       → {challenge_token, nonce, expires_in}
 *   2. POST /cert-login/verify    {cert,...}   → {session_token, expires_in, pairwise_sub, instance_id}
 *
 * Direkter Cross-Origin-Fetch (kein request()-Wrapper) — der Self-Host hat
 * NOCH keinen Session-Token, also können wir nicht über die Bearer-Auth-Logik
 * von client.ts laufen. Caller (AddServerDialog / Re-Auth-Handler) übernimmt
 * das Mapping in serversStore + sessionTokens.
 *
 * NIEMALS loggen: cert, challenge_token, signature, session_token.
 */

import { loadCert } from '$lib/identity/cert.svelte';
import { loadKeypair, signChallenge } from '$lib/identity/keypair.svelte';
import { CHAT_BASE } from './client';

export type CertLoginResult = {
  session_token: string;
  expires_in: number;
  pairwise_sub: string;
  instance_id: string | null;
};

export type CertLoginReason =
  | 'no-cert'
  | 'no-keypair'
  | 'cert-invalid'
  | 'challenge-expired'
  | 'signature-invalid'
  | 'rate-limited'
  | 'join-closed'
  | 'join-requires-invite'
  | 'network'
  | 'unknown';

export class CertLoginError extends Error {
  constructor(
    public readonly reason: CertLoginReason,
    public readonly httpStatus?: number,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'CertLoginError';
  }
}

// ---------------------------------------------------------------------------
// base64url helpers (RFC 4648 §5, no padding) — die key-backup-Helfer sind
// standard-base64 + privat, daher hier inline.
// ---------------------------------------------------------------------------

function b64urlDecode(s: string): Uint8Array {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const std = padded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ---------------------------------------------------------------------------
// Fetch-Helfer — direkter Cross-Origin-POST mit konsistenter Error-Map.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wieviele ms warten wir nach einem 429? `Retry-After` (Sekunden) wird
 *  respektiert, sonst ein kurzer Default; gedeckelt, damit ein bösartiger
 *  Server-Header uns nicht minutenlang blockiert. */
function retryAfterMs(resp: Response, attempt: number): number {
  const hdr = resp.headers.get('Retry-After');
  const secs = hdr ? Number.parseInt(hdr, 10) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 5000);
  return Math.min(500 * 2 ** attempt, 2000); // 500ms, 1s, 2s …
}

/** POST mit begrenztem Retry bei 429. Der ``cert-login``-Endpoint ist
 *  per-IP rate-limited (10–30/min) — ein kurzzeitiger Burst (Multi-Tab,
 *  proaktiver Refresh + reaktives Re-Auth) kann das Budget treffen. Ein
 *  paar Backoff-Retries heilen den transienten Fall, statt die Re-Auth
 *  (und damit z.B. das Community-Erstellen) hart fehlschlagen zu lassen. */
async function postJSON(url: string, body: unknown, maxRetries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new CertLoginError('network', undefined, (err as Error).message);
    }
    if (resp.status === 429 && attempt < maxRetries) {
      await sleep(retryAfterMs(resp, attempt));
      continue;
    }
    return resp;
  }
}

function reasonForStatus(status: number, detail: string | null): CertLoginReason {
  if (detail === 'cert_invalid') return 'cert-invalid';
  if (detail === 'challenge_expired') return 'challenge-expired';
  if (detail === 'signature_invalid' || detail === 'cert_mismatch') return 'signature-invalid';
  if (detail === 'join_closed') return 'join-closed';
  if (detail === 'join_requires_invite') return 'join-requires-invite';
  if (status === 410) return 'challenge-expired';
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'cert-invalid';
  return 'unknown';
}

async function readDetail(resp: Response): Promise<string | null> {
  try {
    const j = (await resp.clone().json()) as { detail?: unknown };
    return typeof j.detail === 'string' ? j.detail : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Vollständiger Cert-Login gegen einen Self-Host-Server.
 *
 * @param serverHostname       Voller Origin inkl. Schema, z.B. "https://chat.firma.de"
 *                             (kein trailing slash — caller normalisiert).
 * @param joinCode             Optionaler Server-Beitritts-Code (für geschlossene /
 *                             invite-only-Server). Wird nur beim Erstkontakt benötigt
 *                             — Re-Auth (self-host-reauth.ts) lässt ihn weg.
 * @param communityGrantCode   Optionaler Community-Invite-Code — gewährt beim
 *                             cert-login/verify community-scoped Instanz-Mitgliedschaft.
 *                             Stufe 3: wird als `community_grant_code` im Verify-Body
 *                             mitgegeben, wenn vorhanden.
 * @param publicJoinHandle     Optionaler öffentlicher Community-Handle (Stufe 4).
 *                             Wird als `public_join_handle` im Verify-Body mitgegeben —
 *                             gewährt community-scoped Mitgliedschaft via öffentlicher Adresse.
 * @throws CertLoginError mit `.reason`-Tag fürs UI-Mapping.
 */
export async function certLogin(
  serverHostname: string,
  joinCode?: string,
  communityGrantCode?: string,
  publicJoinHandle?: string,
): Promise<CertLoginResult> {
  // 1. Cert + Keypair laden (pure helpers — kein Store-State erforderlich,
  //    funktioniert auch wenn die Stores noch nicht hydriert sind).
  const cert = await loadCert();
  if (!cert?.raw) throw new CertLoginError('no-cert');
  const keypair = await loadKeypair();
  if (!keypair) throw new CertLoginError('no-keypair');

  const base = `${serverHostname}${CHAT_BASE}`;

  // 2. Challenge holen
  const chResp = await postJSON(`${base}/cert-login/challenge`, { cert: cert.raw });
  if (!chResp.ok) {
    const detail = await readDetail(chResp);
    throw new CertLoginError(reasonForStatus(chResp.status, detail), chResp.status);
  }
  const challenge = (await chResp.json()) as {
    challenge_token: string;
    nonce: string;
    expires_in: number;
  };

  // 3. Nonce signieren (raw bytes — Server erwartet base64url(sig over raw nonce))
  const nonceBytes = b64urlDecode(challenge.nonce);
  const sigBytes = await signChallenge(keypair, nonceBytes);
  const signature = b64urlEncode(sigBytes);

  // 4. Verify
  const verifyBody: Record<string, unknown> = {
    cert: cert.raw,
    challenge_token: challenge.challenge_token,
    signature,
  };
  if (joinCode) verifyBody.join_code = joinCode;
  if (communityGrantCode) verifyBody.community_grant_code = communityGrantCode;
  if (publicJoinHandle) verifyBody.public_join_handle = publicJoinHandle;
  const vResp = await postJSON(`${base}/cert-login/verify`, verifyBody);
  if (!vResp.ok) {
    const detail = await readDetail(vResp);
    throw new CertLoginError(reasonForStatus(vResp.status, detail), vResp.status);
  }
  const verified = (await vResp.json()) as {
    session_token: string;
    expires_in: number;
    pairwise_sub: string;
    instance_id: string | null | '';
  };
  return {
    session_token: verified.session_token,
    expires_in: verified.expires_in,
    pairwise_sub: verified.pairwise_sub,
    instance_id: verified.instance_id ? verified.instance_id : null,
  };
}
