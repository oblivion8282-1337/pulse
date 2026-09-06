import { request } from './client';
import { activeServer } from '$lib/stores/active-server.svelte';

/**
 * Gast-Links (Besprechungslinks für Leute ohne Konto). Verwaltungsseite —
 * der Beitritt selbst liegt in `$lib/gast/api.ts` und geht bewusst NICHT über
 * diesen Klienten: er trägt Konto-Token und Server-Auswahl mit sich, und
 * davon hat ein Gast nichts.
 */

export type GastLink = {
  id: string;
  channel_id: string;
  guild_id: string;
  expires_at: string;
  /** Frühester Eintritt — null heisst „ab sofort" (alle Bestandslinks). */
  valid_from: string | null;
  revoked: boolean;
  created_by: string;
  /** Nur in der Antwort auf das Erzeugen gesetzt — die Liste liefert ihn nie
   *  nach, weil serverseitig nur der Hash liegt. */
  code?: string | null;
};

export type GastLinkZeitfenster = {
  /** Dauer in Stunden — nur relevant, wenn kein absolutes Ende gesetzt ist. */
  gueltigStunden?: number;
  /** ISO-Zeitpunkte (oder null = ab sofort). ``gueltigBis`` gewinnt über die
   *  Stunden-Rechnung, wenn beides gesetzt ist. */
  gueltigAb?: string | null;
  gueltigBis?: string | null;
};

export function createGastLink(
  channelId: string,
  zeitfenster: GastLinkZeitfenster = {}
): Promise<GastLink> {
  return request<GastLink>(`/channels/${channelId}/guest-links`, {
    method: 'POST',
    body: {
      gueltig_stunden: zeitfenster.gueltigStunden ?? 24,
      gueltig_ab: zeitfenster.gueltigAb ?? null,
      gueltig_bis: zeitfenster.gueltigBis ?? null
    },
    endpoint: 'chat'
  });
}

export function listGastLinks(guildId: string): Promise<GastLink[]> {
  return request<GastLink[]>(`/guilds/${guildId}/guest-links`, { endpoint: 'chat' });
}

export function revokeGastLink(linkId: string): Promise<void> {
  return request<void>(`/guest-links/${linkId}`, { method: 'DELETE', endpoint: 'chat' });
}

/** Die Adresse, die der Gastgeber verschickt.
 *
 * **Sie zeigt auf den Server, auf dem die Community lebt** — nicht auf den
 * Ursprung dieser Seite. Der Unterschied ist der ganze Punkt: wer von der
 * Cloud aus eine Self-Host-Community verwaltet, säße sonst einen Link
 * zusammen, der auf ``howispulse.com`` zeigt, wo der Code gar nicht existiert
 * (er liegt in der Datenbank des Self-Hosts) — der Gast bekäme ein 404 und
 * niemand wüsste warum.
 *
 * Anders als beim Einladungslink (``guilds/inviteLink.ts``) gibt es hier
 * **keinen ``?host=``-Umweg über die Cloud**: der führt den Empfänger durch
 * Anmeldung und Grant, und genau die hat ein Gast nicht. Er spricht
 * ausschliesslich den Server, der die Besprechung hält, und der liefert ihm
 * auch die Seite dafür aus.
 */
export function gastLinkUrl(code: string): string {
  const srv = activeServer.current;
  if (!srv || srv.isCloud) return `${window.location.origin}/gast/${code}`;
  const host = srv.hostname.replace(/\/+$/, '');
  return `${host}/gast/${code}`;
}
