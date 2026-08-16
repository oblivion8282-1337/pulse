<!--
  MemberActivityHeader — kompakte „was läuft gerade"-Sektion oben in der
  rechten Mitgliederliste. Aggregiert Watch-Parties + HQ-Streams + Browser-
  Screenshares aller Voice-Channels dieses Guilds und bietet pro Eintrag
  einen Quick-Open-Link in die zugehörige Channel-Stream-Ansicht.
-->
<script lang="ts">
  import ClapperboardIcon from '@lucide/svelte/icons/clapperboard';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import { goto } from '$app/navigation';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { stromGehoertGeraet } from '$lib/devices/darstellung';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import {
    watchPartyPresence,
    type WatchPartyState
  } from '$lib/stores/watchPartyPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { openPartyTile } from '$lib/watch/openParty.svelte';
  import { chooseHqForUser } from '$lib/stream/hqTile';
  import { voice } from '$lib/voice/livekit.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { userCache } from '$lib/stores/users.svelte';
  import { prefetchYoutubeTitle, youtubeTitle } from '$lib/watch/youtubeMeta.svelte';
  import type { Channel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  type PartyEntry = { kind: 'party'; channel: Channel; state: WatchPartyState };
  type StreamEntry = { kind: 'stream'; channel: Channel; userId: string };

  // Walk all known channels of this guild and collect activity entries from
  // the three presence stores. Channels-by-guild may be empty until the user
  // has visited the guild once — in that case the header simply renders
  // nothing.
  const entries = $derived.by<Array<PartyEntry | StreamEntry>>(() => {
    const chans = guilds.channelsByGuild[guildId] ?? [];
    const out: Array<PartyEntry | StreamEntry> = [];
    for (const ch of chans) {
      // Skip activity from invisible users (masked to offline) — same privacy
      // rule as the member-list badges, so the header doesn't surface (or let
      // you click into) an invisible user's party / stream.
      for (const wp of watchPartyPresence.partiesIn(ch.id)) {
        if (presence.isOnline(wp.host_user_id)) out.push({ kind: 'party', channel: ch, state: wp });
      }
      // Ohne den Filter stuende der Strom eines Standplatz-Geraets hier als
      // Aktivitaet SEINES BESITZERS — „michael streamt in #werkstatt", obwohl
      // dort sein Rechner steht und er selbst nichts tut. Das Geraet hat seine
      // eigene Zeile in der Kanalliste, dort gehoert das Abzeichen hin.
      const hq = streamPresence.streamersIn(ch.id).filter((uid) => !stromGehoertGeraet(ch.id, uid));
      const ss = voicePresence.streamingIn(ch.id);
      const all = [...new Set([...hq, ...ss])].filter((uid) => presence.isOnline(uid));
      for (const uid of all) out.push({ kind: 'stream', channel: ch, userId: uid });
    }
    return out;
  });

  // Queue display-name lookups + prefetch YouTube titles so the activity
  // labels render with the proper name instead of "…" / the embed id.
  $effect(() => {
    for (const e of entries) {
      if (e.kind === 'stream') userCache.queue(e.userId);
      else {
        userCache.queue(e.state.host_user_id);
        if (e.state.source.type === 'youtube') {
          prefetchYoutubeTitle(e.state.source.embed_id);
        }
      }
    }
  });

  function sourceLabel(s: WatchPartyState): string {
    const src = s.source;
    if (src.type === 'youtube') {
      const t = youtubeTitle(src.embed_id);
      return t ? `YouTube · ${t}` : `YouTube · ${src.embed_id}`;
    }
    if (src.type === 'twitch') return `Twitch · VOD ${src.embed_id}`;
    if (src.type === 'twitch_live') return `Twitch · ${src.channel} (live)`;
    try {
      return new URL(src.url).hostname;
    } catch {
      return m.member_activity_header_direct_video();
    }
  }

  function openParty(channel: Channel, party: WatchPartyState): void {
    openPartyTile(channel.id, party);
    void goto(`/app/guilds/${guildId}/channels/${channel.id}`);
  }

  function openStream(channelId: string, uid: string): void {
    if (streamPresence.streamersIn(channelId).includes(uid)) {
      chooseHqForUser(channelId, uid);
    }
    if (voicePresence.streamingIn(channelId).includes(uid)) {
      const ident = voice.connected && voice.channelId === channelId
        ? voice.screenTracks.find((s) => userIdFromIdentity(s.identity) === uid)?.identity
        : undefined;
      if (ident) openedTiles.open('screen', channelId, ident);
    }
    void goto(`/app/guilds/${guildId}/channels/${channelId}`);
  }
</script>

{#if entries.length > 0}
  <div
    class="border-border flex shrink-0 flex-col gap-1.5 border-b px-2.5 py-2"
    data-testid="member-activity-header"
  >
    {#each entries as e (e.kind === 'party' ? `p-${e.channel.id}-${e.state.party_id}` : `s-${e.channel.id}-${e.userId}`)}
      {#if e.kind === 'party'}
        {@const hostName = userCache.displayName(e.state.host_user_id)}
        <div
          class="bg-primary/10 hover:bg-primary/15 group flex items-start gap-2 rounded-xl px-2.5 py-2 transition-colors"
          data-testid="member-activity-party"
          data-channel-id={e.channel.id}
        >
          <ClapperboardIcon class="text-primary mt-0.5 size-4 shrink-0" />
          <div class="min-w-0 flex-1">
            <p class="text-text-bright truncate text-xs font-semibold">Watch Party</p>
            <p class="text-text-muted truncate text-2xs" title={sourceLabel(e.state)}>
              {sourceLabel(e.state)}
            </p>
            <p class="text-text-muted mt-0.5 truncate text-2xs">
              {m.member_activity_header_host_label()}: <span class="text-text-base">{hostName}</span> · #{e.channel.name}
            </p>
          </div>
          <button
            type="button"
            onclick={() => openParty(e.channel, e.state)}
            class="text-primary hover:text-primary/80 mt-0.5 shrink-0 rounded-full p-1 transition-colors"
            aria-label={m.member_activity_header_open_watch_party_aria()}
            title={m.member_activity_header_open_title()}
          >
            <ExternalLinkIcon class="size-3.5" />
          </button>
        </div>
      {:else}
        {@const name = userCache.displayName(e.userId)}
        <div
          class="bg-red-500/10 hover:bg-red-500/15 flex items-start gap-2 rounded-xl px-2.5 py-2 transition-colors"
          data-testid="member-activity-stream"
          data-channel-id={e.channel.id}
          data-user-id={e.userId}
        >
          <RocketIcon class="mt-0.5 size-4 shrink-0 text-red-500" />
          <div class="min-w-0 flex-1">
            <p class="text-text-bright truncate text-xs font-semibold">
              {m.member_activity_header_user_streaming({ name })}
            </p>
            <p class="text-text-muted truncate text-2xs">#{e.channel.name}</p>
          </div>
          <button
            type="button"
            onclick={() => openStream(e.channel.id, e.userId)}
            class="mt-0.5 shrink-0 rounded-full p-1 text-red-400 transition-colors hover:text-red-300"
            aria-label={m.member_activity_header_open_stream_aria()}
            title={m.member_activity_header_open_title()}
          >
            <ExternalLinkIcon class="size-3.5" />
          </button>
        </div>
      {/if}
    {/each}
  </div>
{/if}
