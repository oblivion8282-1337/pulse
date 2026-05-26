/**
 * Self-Host Re-Auth-Handler — Phase 5.2.
 *
 * Verbindet `setSelfHostReauthHandler` (client.ts) mit dem Cert-Login-Flow.
 * Wenn der API-Client einen 401 oder ein abgelaufenes Session-Token bemerkt,
 * triggert er diesen Hook — wir holen einen neuen Session-Token via Cert-
 * Challenge und schreiben ihn in den in-memory sessionTokens-Store.
 *
 * Fire-and-forget: Errors landen in der Konsole, der Caller (request())
 * wirft selbst ein SessionExpiredError damit das UI reagieren kann.
 *
 * NIEMALS session_token loggen.
 */

import { setSelfHostReauthHandler } from './client';
import { serversStore } from './servers.svelte';
import { sessionTokens } from './session_tokens.svelte';
import { certLogin, CertLoginError } from './cert-login';

// Verhindert parallele Re-Auth-Stürme pro Server-ID.
const inflight = new Map<string, Promise<void>>();

async function reauth(serverId: string): Promise<void> {
  const server = serversStore.find(serverId);
  if (!server || server.isCloud) return;

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
  } catch (err) {
    if (err instanceof CertLoginError) {
      console.warn(`[self-host-reauth] ${serverId}: ${err.reason}`);
    } else {
      console.warn(`[self-host-reauth] ${serverId}: unexpected`, err);
    }
  }
}

/** Registriert den Re-Auth-Hook beim API-Client. Einmal beim App-Boot aufrufen. */
export function initSelfHostReauth(): void {
  setSelfHostReauthHandler((serverId) => {
    // Singleton-Inflight: parallele Trigger ergeben nur einen Re-Auth-Roundtrip.
    let p = inflight.get(serverId);
    if (!p) {
      p = reauth(serverId).finally(() => inflight.delete(serverId));
      inflight.set(serverId, p);
    }
    // Hook-Signatur ist void — wir fire-and-forget. Caller wirft SessionExpiredError.
    void p;
  });
}
