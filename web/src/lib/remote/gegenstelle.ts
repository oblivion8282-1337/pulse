/**
 * Fernsteuerung — wer fragt, und von wo.
 *
 * Der Zustimmungsdialog ist der einzige Punkt, an dem jemand entscheidet, ob
 * ein anderer Maus und Tastatur seines Rechners bekommt. Diese Entscheidung
 * braucht mehr als einen Anzeigenamen:
 *
 * - **Anzeigename UND Nutzername.** Der Anzeigename ist frei wählbar; ihn einem
 *   Freund gleichzumachen kostet nichts. Der Nutzername ist die Kennung, unter
 *   der jemand eindeutig ist.
 * - **Der Ort.** Aus welcher Community und welchem Kanal die Anfrage kommt,
 *   trennt „der Freund aus dem Spieleabend" von „irgendwer aus der großen
 *   offenen Community".
 * - **Ein ehrliches Nichtwissen.** Ist der Anfragende nicht bekannt, sagt die
 *   Oberfläche das ausdrücklich, statt „…" zu zeigen (so stand es dort, weil
 *   niemand die Nutzerdaten anforderte).
 *
 * Reines Lesen aus den Stores; die Reaktivität entsteht beim Aufrufer, der das
 * Ergebnis in ein `$derived` legt.
 */

import { userCache } from '$lib/stores/users.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { safeAvatarUrl } from '$lib/avatar';
import { m } from '$lib/paraglide/messages.js';

export type Gegenstelle = {
  /** Liegen überhaupt Nutzerdaten vor? `false` = die Oberfläche muss das sagen. */
  bekannt: boolean;
  /** Anzeigename, oder ein deutlicher Platzhalter, wenn nichts bekannt ist. */
  anzeige: string;
  /** Nutzername (ohne @), nur wenn bekannt. */
  benutzername: string | null;
  /** Geprüfte Avatar-URL oder `null` (dann Initiale). */
  avatar: string | null;
  /** Erster Buchstabe für die Initialen-Kachel. */
  initiale: string;
};

export function gegenstelle(userId: string | null): Gegenstelle {
  const u = userId ? userCache.get(userId) : null;
  if (!u) {
    return {
      bekannt: false,
      anzeige: m.remote_peer_unknown(),
      benutzername: null,
      avatar: null,
      initiale: '?',
    };
  }
  const anzeige = u.display_name ?? u.username;
  return {
    bekannt: true,
    anzeige,
    benutzername: u.username,
    avatar: safeAvatarUrl(u.avatar_url),
    initiale: (anzeige || '?').slice(0, 1).toUpperCase(),
  };
}

export type Ort = { community: string; kanal: string } | null;

/**
 * Community + Kanal zu einer Kanal-Kennung. `null`, wenn sich der Ort hier
 * nicht auflösen lässt (Kanalliste der Community noch nicht geladen, DM) — der
 * Aufrufer sagt dann „Ort nicht auflösbar" statt etwas zu erfinden.
 */
export function ort(channelId: string | null): Ort {
  if (!channelId) return null;
  const guildId = guilds.guildIdForChannel(channelId);
  // Der Rückwärts-Index füllt sich erst beim Laden einer Kanalliste; ohne
  // Treffer die geladenen Listen durchsuchen (dasselbe tut der Anfrage-Knopf).
  const kanal = guildId
    ? (guilds.channelsByGuild[guildId] ?? []).find((c) => c.id === channelId)
    : Object.values(guilds.channelsByGuild)
        .flat()
        .find((c) => c.id === channelId);
  if (!kanal) return null;
  const community = guilds.byId[kanal.guild_id]?.name;
  if (!community) return null;
  return { community, kanal: kanal.name };
}
