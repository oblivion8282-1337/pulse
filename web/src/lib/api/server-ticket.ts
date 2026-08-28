/**
 * Ticket holen und einlösen — der Anmeldeweg ohne Langzeitgeheimnis im Browser.
 *
 * Zwei Schritte statt der bisherigen sieben (Schlüsselpaar laden, Zertifikat
 * laden, Challenge holen, Nonce signieren, Verify, Token ablegen, gelegentlich
 * rotieren): Die Cloud stellt einen auf genau diesen Server ausgestellten
 * Ausweis aus, der Server tauscht ihn gegen seine eigene Sitzung.
 *
 * Das Einlösen läuft bewusst NICHT über `request()`: Für den Self-Host gibt es
 * an dieser Stelle noch keinen Bearer, die Bearer-Logik aus `client.ts` griffe
 * also ins Leere. Gleiche Begründung wie beim alten `cert-login.ts`.
 *
 * NIEMALS loggen: ticket, session_token.
 */

import { request } from './client';
import { istAblehnungscode } from './anmelde-fehler-codes';
import type { Ablehnungscode } from './anmelde-fehler-codes';

/**
 * Ablehnung mit einem Code, der bis in die Oberfläche reist.
 *
 * Der Code ist der ganze Zweck dieser Klasse — s. `anmelde-fehler-codes.ts`.
 */
export class TicketFehler extends Error {
  constructor(
    public readonly code: Ablehnungscode | 'unknown',
    public readonly httpStatus?: number,
  ) {
    super(code);
    this.name = 'TicketFehler';
  }
}

type TicketAntwort = { ticket: string; expires_in: number };
export type SitzungAntwort = { session_token: string; expires_in: number };

/**
 * Holt bei der Cloud einen Ausweis für genau diese Instanz.
 *
 * Läuft über `request()` mit `endpoint: 'auth'` — die Identitäts-Ebene ist
 * immer Cloud-relativ, auch wenn gerade ein Self-Host der aktive Server ist
 * (s. `buildUrl` in `client.ts`).
 */
export async function holeTicket(instanceId: string): Promise<string> {
  const antwort = await request<TicketAntwort>('/me/server-ticket', {
    method: 'POST',
    body: { instance_id: instanceId },
    endpoint: 'auth',
  });
  return antwort.ticket;
}

/** Legt das Ticket dem Self-Host vor und bekommt dessen Sitzung. */
export async function loeseTicketEin(
  serverHostname: string,
  ticket: string,
  zugang: { communityGrantCode?: string; publicJoinHandle?: string } = {},
): Promise<SitzungAntwort> {
  let resp: Response;
  try {
    resp = await fetch(`${serverHostname}/api/chat/session`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        // Ein Ticket beweist, WER jemand ist — nicht, dass er hier
        // hereindarf. Wer noch kein Mitglied ist, legt hier seine Erlaubnis vor.
        ...(zugang.communityGrantCode
          ? { community_grant_code: zugang.communityGrantCode }
          : {}),
        ...(zugang.publicJoinHandle ? { public_join_handle: zugang.publicJoinHandle } : {}),
      }),
    });
  } catch {
    // Ein Netzfehler ist ein eigener Grund und kein „ungültiges Ticket". Die
    // Vermischung der beiden war der Kern der alten Sammelmeldung.
    throw new TicketFehler('network');
  }

  if (!resp.ok) {
    let code: Ablehnungscode | 'unknown' = 'unknown';
    try {
      const j = (await resp.json()) as { detail?: unknown };
      if (istAblehnungscode(j.detail)) code = j.detail;
    } catch {
      // Antwort ohne JSON (etwa eine Proxy-Fehlerseite) — Code bleibt 'unknown'.
    }
    throw new TicketFehler(code, resp.status);
  }

  return (await resp.json()) as SitzungAntwort;
}

/** Was ein Server öffentlich über sich sagt. */
export type ServerInfo = {
  server_version: string;
  pulse_oidc_issuer: string;
  instance_id: string | null;
  capabilities: string[];
};

/**
 * Fragt einen Server, wer er ist und was er kann — ohne Anmeldung.
 *
 * Das löst das Henne-Ei-Problem beim ERSTEN Besuch: Für ein Ticket braucht die
 * Cloud die Instanz-Kennung, und die kannte der Klient bisher erst aus der
 * Antwort des Anmelde-Vorgangs. Beim Beitritt über eine Einladung oder eine
 * öffentliche Adresse hat er sie vorher gar nicht.
 *
 * Die Auskunft ist unbeglaubigt — sie sagt nur, wofür der Klient ein Ticket
 * holen soll. Ob sie stimmt, entscheidet der Server selbst: Ein Ticket mit
 * falschem `aud` weist er ab (`ticket_wrong_audience`). Ein Server kann sich
 * hier also nicht die Identität eines anderen erschleichen.
 */
export async function holeServerInfo(serverHostname: string): Promise<ServerInfo> {
  let resp: Response;
  try {
    resp = await fetch(`${serverHostname}/.well-known/pulse-server-info`, {
      mode: 'cors',
      credentials: 'omit',
    });
  } catch {
    throw new TicketFehler('network');
  }
  if (!resp.ok) throw new TicketFehler('network', resp.status);
  try {
    return (await resp.json()) as ServerInfo;
  } catch {
    // 200 ohne JSON: der SPA-Rückfall liefert die Startseite, weil die Route
    // im Proxy fehlt. Dieselbe Falle, die die Cloud-Poller schon erwischt hat.
    throw new TicketFehler('network', resp.status);
  }
}
