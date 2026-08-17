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

/**
 * WS-Schliesscodes (Plan §DE-10/§5).
 *
 * Gegenstueck: `services/chat-gateway/src/dcc_chat_gateway/routes/ws.py`
 * (dortiger Kommentarblock begruendet die Vergabe) — **synchron halten**.
 * Ausgewertet wird ausschliesslich die Zahl; den `reason`-Text des Servers
 * liest hier niemand. Deshalb darf eine Zahl nur EINE Bedeutung tragen.
 *
 * `CORS_BLOCKED: 4003` ist 2026-08-17 entfallen: serverseitig hat diesen Code
 * nie jemand aus einem CORS-Grund gesendet, wohl aber die Instanz-Sperre und
 * der E-Mail-Riegel — beide erschienen dem Nutzer dadurch als CORS-Problem.
 * Die beiden haben jetzt 4070/4071. Ein alter Server sendet weiter 4003; das
 * faellt hier in den `default`-Zweig („Verbindung weg, erneut versuchen"),
 * was in beiden Faellen richtiger ist als die alte Falschdiagnose.
 */
export const WS_CLOSE = {
  TOKEN_EXPIRED: 4001,
  SERVER_TOO_OLD: 4044,
  SERVER_UPDATING: 4045,
  JWKS_NOT_READY: 4046,
  MFA_REQUIRED: 4047,
  /** Instanz von der Cloud gesperrt/geloescht — umkehrbar, also weiter warten. */
  INSTANCE_SUSPENDED: 4070,
  /** Konto ohne bestaetigte E-Mail — braucht eine Handlung des Nutzers. */
  EMAIL_UNVERIFIED: 4071,
} as const;
