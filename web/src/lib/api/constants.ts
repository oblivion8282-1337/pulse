/**
 * Multi-Server-Konstanten — Phase 4.2.
 *
 * `MIN_SERVER_VERSION` wird in das Build gebacken; das Frontend lehnt
 * Self-Host-Server unter dieser Version ab (WS-Close 4044). Bump bei
 * Breaking-API-Changes; siehe `docs/SELF_HOST_PLAN.md` §DE-10.
 */

export const MIN_SERVER_VERSION = '0.8.0';

/**
 * Deterministische Reconnect-Backoff-Stufen (ms) — kein Jitter.
 * Plan-Spec: 1s → 2s → 4s → 8s → 16s → 32s → 60s → 120s → 300s (Cap).
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [
  1000, 2000, 4000, 8000, 16000, 32000, 60000, 120000, 300000,
];

/** Self-Host-WS-Close-Codes (Plan §DE-10/§5). */
export const WS_CLOSE = {
  TOKEN_EXPIRED: 4001,
  CORS_BLOCKED: 4003,
  SERVER_TOO_OLD: 4044,
  SERVER_UPDATING: 4045,
  JWKS_NOT_READY: 4046,
  MFA_REQUIRED: 4047,
} as const;
