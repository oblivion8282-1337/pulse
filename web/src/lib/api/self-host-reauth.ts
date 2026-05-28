/**
 * Self-Host Re-Auth-Handler — Phase 5.2.
 *
 * Verbindet die Re-Auth-Hooks aus ``client.ts`` UND ``gateway-connection.ts``
 * mit dem Cert-Login-Flow. Beide Module haben einen eigenen ``_selfHost
 * ReauthHandler``-Slot — der eine wird bei REST-401/expired-Token gefeuert,
 * der andere beim WS-Reconnect mit expired Self-Host-Session-Token. Wir
 * registrieren denselben Handler für beide, sonst greift Re-Auth nur auf
 * einem der Pfade.
 *
 * Wenn ein Handler ausgelöst wird, holen wir einen neuen Session-Token via
 * Cert-Challenge und schreiben ihn in den in-memory sessionTokens-Store.
 *
 * Fire-and-forget: Errors landen in der Konsole, der Caller (request())
 * wirft selbst ein SessionExpiredError damit das UI reagieren kann.
 *
 * NIEMALS session_token loggen.
 */

import {
  setSelfHostReauthHandler as setClientReauth,
  setSelfHostReauthAsyncHandler as setClientReauthAsync,
} from './client';
import { setSelfHostReauthHandler as setGatewayReauth } from '$lib/ws/gateway-connection';
import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
import { serversStore } from './servers.svelte';
import { sessionTokens } from './session_tokens.svelte';
import { certLogin, CertLoginError } from './cert-login';

// Verhindert parallele Re-Auth-Stürme pro Server-ID. Wert speichert das
// Resultat (ok=true bei erfolgreichem Re-Auth, false bei fail), damit
// parallele 401-Aufrufer denselben Promise abwarten und dasselbe Retry
// machen können.
const inflight = new Map<string, Promise<boolean>>();

async function reauth(serverId: string): Promise<boolean> {
  const server = serversStore.find(serverId);
  if (!server || server.isCloud) return false;

  // Stale Token aus dem Map kicken, damit `request()` nicht weiter den
  // abgelaufenen Bearer verwendet während die Re-Auth läuft.
  sessionTokens.clear(serverId);

  try {
    const result = await certLogin(server.hostname);
    sessionTokens.set(serverId, result.session_token, Date.now() + result.expires_in * 1000);
    // pairwise_sub kann sich nicht ändern (deterministisch) — nur setzen,
    // falls der Server-Eintrag noch keine hat (Backfill aus früheren Builds).
    if (!server.pairwise_sub) {
      serversStore.update(serverId, { pairwise_sub: result.pairwise_sub });
    }
    // WS-Trigger: der Reauth-Hook wird oft vom _resolveToken() aufgerufen,
    // wenn die Connection mangels Token bereits ins ``closed``-Stadium
    // gegangen ist. Ohne expliziten Re-Connect bleibt sie still, obwohl der
    // neue Token in der Session-Map liegt. Wir stoßen die Verbindung nach
    // erfolgreicher Re-Auth selber wieder an.
    const conn = gatewayPool.peek(serverId);
    if (conn && (conn.state === 'closed' || conn.state === 'idle')) {
      void conn.connect().catch(() => undefined);
    }
    return true;
  } catch (err) {
    if (err instanceof CertLoginError) {
      console.warn(`[self-host-reauth] ${serverId}: ${err.reason}`);
    } else {
      console.warn(`[self-host-reauth] ${serverId}: unexpected`, err);
    }
    return false;
  }
}

function reauthOnce(serverId: string): Promise<boolean> {
  // Singleton-Inflight: parallele Trigger ergeben nur einen Re-Auth-
  // Roundtrip. Aufrufer warten auf denselben Promise und retrien mit
  // demselben frischen Token.
  let p = inflight.get(serverId);
  if (!p) {
    p = reauth(serverId).finally(() => inflight.delete(serverId));
    inflight.set(serverId, p);
  }
  return p;
}

/** Registriert den Re-Auth-Hook beim API-Client UND beim WS-Gateway-Pool.
 *  Einmal beim App-Boot aufrufen. */
export function initSelfHostReauth(): void {
  const fireAndForget = (serverId: string) => {
    void reauthOnce(serverId);
  };
  setClientReauth(fireAndForget);
  setGatewayReauth(fireAndForget);
  // Awaitable Variante: request() in client.ts kann darauf warten und
  // den 401-betroffenen Fetch mit frischem Token retrien — User muss
  // den Submit nicht zweimal klicken.
  setClientReauthAsync(reauthOnce);
}
