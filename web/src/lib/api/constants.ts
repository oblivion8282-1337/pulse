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

/**
 * Chat-WS-Keepalive (half-open-Detection). Der Browser kann eine still
 * gestorbene TCP-Verbindung nicht erkennen (kein `close`-Event), also senden
 * wir alle `WS_PING_INTERVAL_MS` ein `{"op":"ping"}` und erzwingen ein
 * `ws.close()` (→ bestehender Reconnect-Pfad), wenn länger als
 * `WS_PONG_TIMEOUT_MS` kein `pong` zurückkommt. Timeout großzügig (~3
 * verpasste Pings): Browser drosseln `setInterval` im Hintergrund-Tab auf
 * ≥60s, ein zu knapper Timeout würde dort gesunde Verbindungen unnötig
 * reconnecten.
 */
export const WS_PING_INTERVAL_MS = 25_000;
export const WS_PONG_TIMEOUT_MS = 90_000;

/** Self-Host-WS-Close-Codes (Plan §DE-10/§5). */
export const WS_CLOSE = {
  TOKEN_EXPIRED: 4001,
  CORS_BLOCKED: 4003,
  SERVER_TOO_OLD: 4044,
  SERVER_UPDATING: 4045,
  JWKS_NOT_READY: 4046,
  MFA_REQUIRED: 4047,
} as const;
