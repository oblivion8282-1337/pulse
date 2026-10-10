// Lädt und löst ein, was die Einladungskarte zeigt — gemeinsam für die Seite
// /invite/<code> und den Dialog in der App.
//
// Cloud-Einladungen gehen AUSDRÜCKLICH an die Cloud, nie an den aktiven
// Server: ist gerade ein Self-Host aktiv, kennt der den Cloud-Code nicht und
// meldete fälschlich „ungültig“.
import { ApiError } from '$lib/api/client';
import { chatApi } from '$lib/api/chat';
import { getInvitePreviewOn, SelfHostContactConfirmRequired } from '$lib/api/add-server-flow';
import type { InvitePreview } from '$lib/api/types';
import { serversStore } from '$lib/api/servers.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
import { guildIconSrc } from '$lib/guildIcon';
import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
import { m } from '$lib/paraglide/messages.js';
import type { EinladungCommunity, EinladungZustand } from './EinladungKarte.svelte';
import type { Einladung } from './einladungsLink';
import { einladungFehler, type EinladungFehler } from './fehlertext';

export interface GeladeneEinladung {
  zustand: EinladungZustand;
  community: EinladungCommunity | null;
  guildId: string | null;
  fehler: EinladungFehler | null;
}

const LEER = { community: null, guildId: null, fehler: null } as const;

export function fehlerAus(e: unknown): EinladungFehler {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: unknown } | null;
    return einladungFehler(e.status, body?.detail);
  }
  return 'netz';
}

export function fehlerMeldung(f: EinladungFehler, host: string | null): string {
  switch (f) {
    case 'ungueltig':
      return m.einladung_ungueltig_titel();
    case 'email':
      return m.einladung_email_titel();
    case 'ausgeschlossen':
      return m.einladung_fehler_ausgeschlossen();
    case 'gesperrt':
      return m.einladung_fehler_gesperrt();
    case 'voll':
      return m.einladung_fehler_voll();
    case 'bremse':
      return m.einladung_fehler_bremse();
    case 'abgelehnt':
      return m.einladung_fehler_abgelehnt();
    case 'netz':
      return host ? m.einladung_fehler_server() : m.einladung_fehler_netz();
  }
}

function alsCommunity(p: InvitePreview, origin: string): EinladungCommunity {
  return {
    name: p.guild.name,
    iconUrl: guildIconSrc(p.guild.icon_url, origin),
    mitglieder: p.member_count
  };
}

function cloudVorschau(code: string): Promise<InvitePreview> {
  const cloudId = serversStore.cloudId();
  return cloudId ? getInvitePreviewOn(code, { serverId: cloudId }) : chatApi.getInvitePreview(code);
}

/** Für angemeldete, bestätigte Nutzer. */
export async function ladeEinladung(e: Einladung): Promise<GeladeneEinladung> {
  if (e.host) {
    // Self-Host: Vorschau nur, wenn wir dort schon eine Sitzung haben. Einen
    // UNBEKANNTEN Server fragen wir vor der Zustimmung nicht — er sähe sonst
    // die IP-Adresse, bevor der Nutzer zugestimmt hat (Spec, Sicherheit 2).
    const srv = serversStore.findByHostname(e.host);
    if (!srv) return { zustand: 'einladung', ...LEER };
    try {
      const p = await getInvitePreviewOn(e.code, { serverId: srv.id });
      await serverGuilds.ensureLoaded(srv.id);
      const mitglied = serverGuilds.get(srv.id).some((g) => g.id === p.guild.id);
      return {
        zustand: mitglied ? 'mitglied' : 'einladung',
        community: alsCommunity(p, srv.hostname),
        guildId: p.guild.id,
        fehler: null
      };
    } catch (err) {
      // Nur ein 404 ist endgültig; sonst bleibt der Beitritt versuchbar.
      if (fehlerAus(err) === 'ungueltig') return { zustand: 'ungueltig', ...LEER };
      return { zustand: 'einladung', ...LEER };
    }
  }

  try {
    const p = await cloudVorschau(e.code);
    await guilds.hydrate().catch(() => {});
    return {
      zustand: guilds.byId[p.guild.id] ? 'mitglied' : 'einladung',
      community: alsCommunity(p, window.location.origin),
      guildId: p.guild.id,
      fehler: null
    };
  } catch (err) {
    const f = fehlerAus(err);
    if (f === 'ungueltig') return { zustand: 'ungueltig', ...LEER };
    if (f === 'email') return { zustand: 'email', ...LEER };
    return { zustand: 'fehler', community: null, guildId: null, fehler: f };
  }
}

/** Für Abgemeldete. Ohne anonyme Vorschau (Etappe 2) gibt es keinen Namen. */
export async function ladeEinladungAbgemeldet(_e: Einladung): Promise<GeladeneEinladung> {
  return { zustand: 'abgemeldet', ...LEER };
}

export type BeitrittsErgebnis =
  | { art: 'ok' }
  | { art: 'rueckfrage' }
  | { art: 'fehler'; fehler: EinladungFehler };

/** Eingabe für joinGuildByInvite — dieselbe Form, die InviteEmbed baut. */
function beitrittsEingabe(e: Einladung): string {
  return e.host ? `https://app/invite/${e.code}?host=${encodeURIComponent(e.host)}` : e.code;
}

/** Tritt bei. Bei 'ok' hat joinGuildByInvite schon in die Community navigiert. */
export async function einladungAnnehmen(
  e: Einladung,
  bestaetigt: boolean
): Promise<BeitrittsErgebnis> {
  try {
    await joinGuildByInvite(beitrittsEingabe(e), bestaetigt);
    return { art: 'ok' };
  } catch (err) {
    if (err instanceof SelfHostContactConfirmRequired) return { art: 'rueckfrage' };
    return { art: 'fehler', fehler: fehlerAus(err) };
  }
}
