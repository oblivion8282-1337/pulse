import { request } from './client';

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
  revoked: boolean;
  created_by: string;
  /** Nur in der Antwort auf das Erzeugen gesetzt — die Liste liefert ihn nie
   *  nach, weil serverseitig nur der Hash liegt. */
  code?: string | null;
};

export function createGastLink(channelId: string, gueltigStunden = 24): Promise<GastLink> {
  return request<GastLink>(`/channels/${channelId}/guest-links`, {
    method: 'POST',
    body: { gueltig_stunden: gueltigStunden },
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
 * Aus dem Ursprung DIESER Seite gebaut, nicht serverseitig gesetzt: ein
 * Self-Host kennt seine öffentliche Adresse nicht zuverlässig (er sieht nur,
 * was der Proxy ihm sagt), der Browser des Gastgebers dagegen schon — er ist
 * ja gerade darüber verbunden.
 */
export function gastLinkUrl(code: string): string {
  return `${window.location.origin}/gast/${code}`;
}
