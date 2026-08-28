/**
 * Self-Host Re-Auth-Handler — Phase 5.2.
 *
 * Verbindet die Re-Auth-Hooks aus ``client.ts`` UND ``gateway-connection.ts``
 * mit der Ticket-Anmeldung. Beide Module haben einen eigenen ``_selfHost
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
import { holeTicket, loeseTicketEin, TicketFehler } from './server-ticket';
import { instancesApi } from './instances';
import type { ServerEntry } from './servers.svelte';
import { merkeGrund, vergissGrund } from './anmelde-fehler';

// Pro App-Session einmal die Cloud-Membership backfillen — deckt Server ab, die
// schon vor dem Membership-Sync (oder als Nicht-Owner-Invite) lokal hinzugefügt
// wurden und daher im Browser fehlten. Idempotent serverseitig; das Set
// verhindert nur eine Cloud-Anfrage bei jedem 5-Min-Reauth.
const membershipSynced = new Set<string>();

// Verhindert parallele Re-Auth-Stürme pro Server-ID. Wert speichert das
// Resultat (ok=true bei erfolgreichem Re-Auth, false bei fail), damit
// parallele 401-Aufrufer denselben Promise abwarten und dasselbe Retry
// machen können.
const inflight = new Map<string, Promise<boolean>>();

/**
 * Nach erfolgreicher Anmeldung: Cloud-Mitgliedschaft nachtragen und die
 * WebSocket anstossen.
 *
 * Für BEIDE Anmeldewege dieselbe Fassung. Zwei Kopien wären hier besonders
 * teuer: Der Teil, der den neuen Token an den offenen Socket meldet, ist genau
 * die Stelle, an der ein Self-Host-Nutzer sonst im Fünf-Minuten-Takt aus den
 * Listen der anderen flackerte.
 */
async function nachAnmeldung(
  serverId: string,
  server: ServerEntry,
  instanceId: string | null,
  frischesToken: string,
): Promise<void> {
  vergissGrund(serverId);
  // Ab jetzt ist belegt, dass hier je eine Anmeldung durchging — die Rail zeigt
  // sonst dauerhaft „nie eingerichtet".
  if (server.je_verbunden !== true) serversStore.update(serverId, { je_verbunden: true });
  // Cloud-Membership-Backfill (einmal pro Session). So wird auch ein früher
  // beigetretener Self-Host im Browser sichtbar, ohne ihn neu hinzuzufügen.
  // Best-effort.
  if (instanceId && !membershipSynced.has(serverId)) {
    membershipSynced.add(serverId);
    void instancesApi.joinInstanceMembership(instanceId).catch(() => {
      membershipSynced.delete(serverId); // Retry beim nächsten Reauth.
    });
  }
  // Der Reauth-Hook wird oft von `_resolveToken()` gerufen, wenn die Connection
  // mangels Token bereits `closed` ist. Ohne expliziten Re-Connect bliebe sie
  // still, obwohl der neue Token in der Session-Map liegt.
  const conn = gatewayPool.peek(serverId);
  if (conn && (conn.state === 'closed' || conn.state === 'idle')) {
    void conn.connect().catch(() => undefined);
  } else if (conn && conn.state === 'open') {
    // Steht die Verbindung noch, bekommt sie den neuen Token gereicht statt ihn
    // erst beim nächsten Aufbau zu sehen. Der Server hängt die Lebensdauer des
    // Sockets an das `exp` des Tokens, mit dem verbunden wurde.
    conn.pushToken(frischesToken);
  }
}

/**
 * Anmeldung über ein Cloud-Ticket. Gibt `true` bei Erfolg zurück.
 *
 * Der Grund eines Fehlschlags wird hier benannt statt verschluckt — das war
 * der Kern des Umbaus. Wer die Zeile im Betrieb sieht, weiss ohne weitere
 * Fehlersuche, was zu tun ist.
 */
async function ueberTicket(serverId: string, server: ServerEntry): Promise<string | null> {
  if (!server.instance_id) {
    // Ohne Instanz-Kennung gibt es kein `aud` — der Server ist nur über den
    // alten Weg erreichbar. Kein Fehler, sondern ein Rückfall.
    return null;
  }
  try {
    const ticket = await holeTicket(server.instance_id);
    const sitzung = await loeseTicketEin(server.hostname, ticket);
    sessionTokens.set(serverId, sitzung.session_token, Date.now() + sitzung.expires_in * 1000);
    return sitzung.session_token;
  } catch (err) {
    if (err instanceof TicketFehler) {
      merkeGrund(serverId, err.code);
      console.warn(`[self-host-reauth] ${serverId}: ${err.code}`);
      // Auf dieser Instanz gebannt → die Cloud-Mitgliedschaft wegräumen, sonst
      // zeigt der Server bei `GET /me/instances` weiter auf allen anderen
      // Geräten. Best-effort.
      if (err.code === 'instance banned' && server.instance_id) {
        void instancesApi.leaveInstanceMembership(server.instance_id).catch(() => undefined);
      }
    } else {
      console.warn(`[self-host-reauth] ${serverId}: unexpected`, err);
    }
    return null;
  }
}

async function reauth(serverId: string): Promise<boolean> {
  const server = serversStore.find(serverId);
  if (!server || server.isCloud) return false;

  // Stale Token aus dem Map kicken, damit `request()` nicht weiter den
  // abgelaufenen Bearer verwendet während die Re-Auth läuft.
  sessionTokens.clear(serverId);

  const token = await ueberTicket(serverId, server);
  if (!token) return false;
  await nachAnmeldung(serverId, server, server.instance_id ?? null, token);
  return true;
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

// ---------------------------------------------------------------------------
// Proaktiver Refresh (F18): re-mintet den Self-Host-Session-Token VOR Ablauf
// (TTL = 5 Min), solange eine aktive WS-Connection besteht. So bleibt die
// Session permanent frisch und es gibt keine SessionExpiredError mid-session.
// Idle-Server (keine offene Connection) lässt den Token bewusst ablaufen → der
// reaktive Reauth (bearerWithReauth in client.ts) heilt bei der nächsten Nutzung.
// ---------------------------------------------------------------------------

const REFRESH_BUFFER_MS = 60_000; // 60 s vor dem 5-Min-Ablauf neu minten
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelRefresh(serverId: string): void {
  const t = refreshTimers.get(serverId);
  if (t) clearTimeout(t);
  refreshTimers.delete(serverId);
}

function scheduleProactiveRefresh(serverId: string): void {
  cancelRefresh(serverId);
  const entry = sessionTokens.get(serverId);
  if (!entry) return;
  const delay = Math.max(0, entry.expiresAt - Date.now() - REFRESH_BUFFER_MS);
  refreshTimers.set(
    serverId,
    setTimeout(() => {
      refreshTimers.delete(serverId);
      const conn = gatewayPool.peek(serverId);
      if (conn && (conn.state === 'open' || conn.state === 'connecting')) {
        // reauthOnce → sessionTokens.set → Listener plant den nächsten Refresh.
        void reauthOnce(serverId);
      }
    }, delay),
  );
}

/** Registriert den Re-Auth-Hook beim API-Client UND beim WS-Gateway-Pool +
 *  den proaktiven Refresh-Scheduler. Einmal beim App-Boot aufrufen. */
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
  // Proaktiver Refresh: an jeden Token-Set/-Clear koppeln.
  sessionTokens.setChangeListener((serverId, action) => {
    if (action === 'set') scheduleProactiveRefresh(serverId);
    else cancelRefresh(serverId);
  });
}
