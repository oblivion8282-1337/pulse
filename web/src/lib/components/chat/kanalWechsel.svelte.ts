/**
 * Kanalwechsel + serverseitiges Verschwinden eines Kanals/einer Community —
 * herausgeloest aus `routes/app/guilds/[guildId]/channels/[channelId]/+page.svelte`,
 * damit die Seite unter der harten Groessen-Grenze bleibt (dasselbe Vorbild
 * wie `chat/dmKanalWechsel.svelte.ts` fuer die DM-Seite). Der Umzug aendert
 * kein Verhalten: dieselbe Reihenfolge (Community laden, Zielkanal aufloesen,
 * Ablage-Kanal lokal statt per REST, dann Abonnement + Nachhol-Lese-
 * Markierung), derselbe Stale-Check ueber einen laufenden Generation-Zaehler.
 *
 * `erstelleKanalWechsel()` haelt eigenen `$state` (laufender Wechsel, zuletzt
 * gezeigter Fehler) — deshalb `.svelte.ts` statt eines importfreien Moduls.
 */
import { untrack } from 'svelte';
import { goto } from '$app/navigation';
import { guilds } from '$lib/stores/guilds.svelte';
import { messages } from '$lib/stores/messages.svelte';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import { readState } from '$lib/stores/readState.svelte';
import { chatApi } from '$lib/api/chat';
import { gateway } from '$lib/ws/connection';
import { voice } from '$lib/voice/livekit.svelte';
import { hatServerVerlauf } from '$lib/verlauf';
import { ladeAblageKanalVerlauf } from '$lib/components/chat/ablageKanalVerlauf';
import type { Channel } from '$lib/api/types';
import { m as pm } from '$lib/paraglide/messages.js';

export function erstelleKanalWechsel() {
  let resolving = $state(true);
  let loadError = $state<string | null>(null);
  let prevGuild = $state('');
  let prevChannel = $state('');
  let switchGen = $state(0);

  async function switchTo(g: string, c: string) {
    if (!g) return;
    // All access to switchGen/prevGuild/prevChannel goes through untrack so the
    // surrounding $effect never re-triggers on our own writes.
    const isStale = () => untrack(() => switchGen) !== gen;
    const gen = untrack(() => (switchGen += 1));
    const prevG = untrack(() => prevGuild);
    const prevC = untrack(() => prevChannel);

    if (g !== prevG) {
      resolving = true;
      loadError = null;
      try {
        // `ensureChannels` hits the post-Ready prefetch cache if it ran
        // through; falls back to a single `listChannels` otherwise. The
        // `channel_*` lifecycle events keep the cache live during the
        // session, so this rarely needs to refetch.
        await guilds.ensureChannels(g);
      } catch (err) {
        if (isStale()) return;
        loadError = err instanceof Error ? err.message : pm.channel_page_channels_load_error();
        resolving = false;
        return;
      }
      if (isStale()) return;
      untrack(() => (prevGuild = g));
    }
    const list = guilds.channelsByGuild[g] ?? [];
    let target: string | null = c;
    if (c === '_' || !list.find((ch) => ch.id === c)) {
      const first = list.find((ch) => ch.type === 0) ?? list[0];
      if (first) {
        await goto(`/app/guilds/${g}/channels/${first.id}`, { replaceState: true, noScroll: true });
        return;
      }
      target = null;
    }

    if (target && target !== prevC) {
      // Leave the previous text channel's WS subscription.
      if (prevC) gateway.unsubscribe(prevC);
      const ch = list.find((x) => x.id === target);
      // Lazy-load this channel's permission overwrites so the resolver
      // doesn't false-positive against guild defaults. Best-effort:
      // a 403/500 here would only collapse UI affordances back to the
      // guild-level resolution, which is still correct (just permissive).
      if (ch) void channelPermissions.ensure(ch.id).catch(() => undefined);
      // Only text channels have message history + WS subscriptions.
      // Voice channels are handled entirely by VoiceChannelView/LiveKit.
      if (ch && ch.type === 0) {
        // Cached from an earlier visit? Then its WS subscription lapsed while
        // we were away — re-subscribe + gap-fill below instead of re-fetching.
        const alreadyLoaded = !!messages.loadedChannels[target];
        try {
          if (!alreadyLoaded) {
            // Ablage-Kanal: der Server hat den Klartext nie gesehen (B1) —
            // lokaler Bestand statt REST, wie bei einer privaten Gruppe
            // (`dmKanalWechsel.svelte.ts`). `hatServerVerlauf` kennt ihn
            // schon (hinter `ABLAGE_KANAL_ENABLED`).
            if (!hatServerVerlauf(target)) {
              await ladeAblageKanalVerlauf(target);
              if (isStale()) return;
            } else {
              const history = await chatApi.listMessages(target);
              if (isStale()) return;
              messages.setInitial(target, history);
            }
          }
        } catch (err) {
          if (isStale()) return;
          loadError = err instanceof Error ? err.message : pm.channel_page_messages_load_error();
          resolving = false;
          return;
        }
        // Only subscribe once this switch is still the active one — otherwise
        // a faster switch already moved on and we'd leak a subscription.
        if (isStale()) return;
        gateway.subscribe(target);
        // Backfill anything that landed while the subscription was dropped.
        if (alreadyLoaded) void gateway.gapFill(target);
        // Acknowledge unread state: the user is now looking at this channel.
        // markRead uses latestByChannel — which also reflects ids learned via
        // channel_bump while we weren't subscribed. loaded[…].id alone would
        // lag behind those.
        const loaded = messages.for(target);
        const latestSeen = loaded[loaded.length - 1]?.id;
        if (latestSeen) readState.recordSeen(target, latestSeen);
        readState.markRead(target);
      }
      // Record prevChannel only after the whole operation succeeded.
      untrack(() => (prevChannel = target!));
    }
    if (isStale()) return;
    loadError = null;
    resolving = false;
  }

  // WS reconnect path: connection.ts calls messages.clearChannel(cid) for every
  // subscribed channel on `open`, which empties byChannel + loadedChannels.
  // switchTo only fires on URL change — so without this effect the user would
  // see an empty chat until they navigate away. We watch for the load flag
  // disappearing *after* we already switched to the channel and re-fetch.
  function nachladenWennNoetig(cid: string, channelsForGuild: Channel[]) {
    if (!cid || messages.loadedChannels[cid]) return;
    if (prevChannel !== cid) return; // initial switchTo path handles its own fetch
    const ch = channelsForGuild.find((c) => c.id === cid);
    if (!ch || ch.type !== 0) return;
    // Ablage-Kanal: kein Serverabruf (`hatServerVerlauf` kennt ihn bereits)
    // — der lokale Bestand ist die einzige Kopie, `messages.loadedChannels`
    // wird von `clearChannel()` beim Reconnect trotzdem geleert.
    if (!hatServerVerlauf(cid)) {
      void ladeAblageKanalVerlauf(cid).catch(() => {
        // Best-effort: the user can navigate to retry.
      });
      return;
    }
    void chatApi
      .listMessages(cid)
      .then((history) => {
        if (untrack(() => prevChannel) === cid) messages.setInitial(cid, history);
      })
      .catch(() => {
        // Best-effort: the user can navigate to retry.
      });
  }

  // Retry-Knopf nach einem Ladefehler: Zustand zuruecksetzen und denselben
  // Wechsel noch einmal versuchen (wie ein frischer Seitenaufruf).
  function retry(g: string, c: string) {
    loadError = null;
    prevGuild = '';
    prevChannel = '';
    void switchTo(g, c);
  }

  async function onChannelDeleted(guildId: string, deletedId: string, activeChannelId: string) {
    if (deletedId !== activeChannelId) return;
    const remaining = (guilds.channelsByGuild[guildId] ?? []).filter((c) => c.id !== deletedId);
    const next = remaining.find((c) => c.type === 0) ?? remaining[0];
    if (next) {
      await goto(`/app/guilds/${guildId}/channels/${next.id}`, { replaceState: true });
    } else {
      await goto(`/app/guilds/${guildId}/channels/_`, { replaceState: true });
    }
  }

  async function navigateAfterGuildGone() {
    const remaining = guilds.list;
    if (remaining.length > 0) {
      await goto(`/app/guilds/${remaining[0].id}/channels/_`, { replaceState: true });
    } else {
      await goto('/app', { replaceState: true });
    }
  }

  // Store was already pruned in connection.ts. If we were in a voice channel
  // in this guild, disconnect — channels are gone.
  async function handleRemoteGuildDeleted() {
    if (voice.connected || voice.connecting) await voice.disconnect().catch(() => undefined);
    await navigateAfterGuildGone();
  }

  return {
    get resolving() {
      return resolving;
    },
    get loadError() {
      return loadError;
    },
    switchTo,
    nachladenWennNoetig,
    retry,
    onChannelDeleted,
    handleRemoteGuildDeleted
  };
}
