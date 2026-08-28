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
): Promise<SitzungAntwort> {
  let resp: Response;
  try {
    resp = await fetch(`${serverHostname}/api/chat/session`, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
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
