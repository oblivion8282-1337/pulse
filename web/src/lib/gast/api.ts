/**
 * Die vier Aufrufe, die ein Gast kennt — mehr Oberfläche hat er nicht.
 *
 * Bewusst **nicht** über `$lib/api/client`: der trägt Konto-Token, Auffrischung
 * und Server-Auswahl mit sich, und genau davon hat ein Gast nichts. Er spricht
 * denselben Host, von dem seine Seite kam (der Link zeigt auf den Server, auf
 * dem die Community lebt), und trägt sein Ticket selbst.
 *
 * Importfrei gehalten, damit die reine Rechnung testbar bleibt
 * (`pnpm test:unit`-Falle, s. CLAUDE.md) — hier steckt sie in `gastFehler`.
 */

export type GastInfo = {
  guild_name: string;
  channel_name: string;
  expires_at: string;
};

export type GastBeitritt = {
  ticket: string;
  expires_in: number;
  gast_id: string;
  channel_id: string;
  guild_id: string;
  guild_name: string;
  channel_name: string;
};

export type GastVoiceToken = { token: string; ws_url: string; room: string };

export type GastStreamStand = {
  stream_states: { channel_id: string; user_ids?: string[] }[];
};

/** Warum ein Beitritt scheiterte, in der Sprache des Gastes.
 *
 * Der Gast kann nichts nachschlagen und niemanden fragen — er sieht nur diese
 * eine Seite. Ein „Fehler 404" wäre für ihn eine Sackgasse, deshalb wird jeder
 * Fall zu einem Satz, der sagt, was jetzt zu tun ist. */
export function gastFehler(status: number): string {
  if (status === 404) return 'abgelaufen';
  if (status === 403) return 'entfernt';
  if (status === 409) return 'voll';
  if (status === 429) return 'zuviel';
  return 'fehler';
}

async function hole<T>(pfad: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(pfad, init);
  if (!resp.ok) {
    const err = new Error(gastFehler(resp.status));
    (err as Error & { status?: number }).status = resp.status;
    throw err;
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export function gastInfo(code: string): Promise<GastInfo> {
  return hole<GastInfo>(`/api/chat/gast/${encodeURIComponent(code)}`);
}

export function gastBeitritt(code: string, name: string): Promise<GastBeitritt> {
  return hole<GastBeitritt>(`/api/chat/gast/${encodeURIComponent(code)}/beitritt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
}

export function gastVoiceToken(ticket: string, channelId: string): Promise<GastVoiceToken> {
  return hole<GastVoiceToken>('/api/voice/gast/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket}` },
    body: JSON.stringify({ channel_id: channelId })
  });
}

export function gastStreamStand(ticket: string): Promise<GastStreamStand> {
  return hole<GastStreamStand>('/api/chat/gast/sitzung/stream-state', {
    headers: { Authorization: `Bearer ${ticket}` }
  });
}

export function gastWhepUrl(
  ticket: string,
  userId: string,
  slot = 0
): Promise<{ whep_url: string; ten_bit?: boolean }> {
  return hole(`/api/chat/gast/sitzung/whep?user_id=${userId}&slot=${slot}`, {
    headers: { Authorization: `Bearer ${ticket}` }
  });
}
