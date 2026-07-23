<!--
  StreamGrid — the video-tile column of a voice channel with active streams.

  Renders one anchor div per open tile (via `openedTiles`); the actual players
  live in the app layout (`WatchBackgroundHost`, `HqStreamBackgroundHost`,
  `LiveKitBackgroundHost`) and either dock onto the anchor or fall back to a
  floating corner window when the anchor is gone — that's how HQ streams,
  webcams, and screen share keep playing when you navigate away.

  Layout: a grid of equal tiles. Detached tiles don't appear as placeholders.
-->
<script lang="ts">
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { watchBackground } from '$lib/watch/watchBackground.svelte';
  import { hqStreamBackground } from '$lib/stream/hqStreamBackground.svelte';
  import { hqTileId } from '$lib/stream/hqTile';
  import { liveKitBackground } from '$lib/stream/liveKitBackground.svelte';
  import { inVoiceChannel } from '$lib/voice/state.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
  import { m } from '$lib/paraglide/messages.js';
  import { untrack } from 'svelte';
  import type { Channel } from '$lib/api/types';

  let { channel }: { channel: Channel } = $props();

  // Zugeklappt-Zustand der Teilnehmer-Zeile — geräteweit persistiert.
  let participantsCollapsed = $derived(settings.appearance.streamParticipantsCollapsed);
  let participantsToggleLabel = $derived(
    participantsCollapsed
      ? m.stream_grid_participants_expand_aria()
      : m.stream_grid_participants_collapse_aria()
  );

  // What the viewer has actually opened, in this channel, per kind.
  // Detached tiles are excluded — they're showing in a separate window.
  // One entry per OPEN, live, non-detached HQ tile — keyed by the composite
  // `<userId>:<slot>` id so a user's two streams get two anchors.
  //
  // Der EIGENE Stream wird NICHT herausgefiltert: er erscheint nicht von selbst
  // (die Auto-Öffnen-Logik in VoiceChannelView überspringt den eigenen Nutzer),
  // aber wenn man seinen eigenen LIVE-Badge anklickt, öffnet sich die eigene
  // Vorschau bewusst — genau wie bei fremden Streams. `isOpen` bleibt der Gate.
  let openHqTiles = $derived(
    streamPresence
      .streamsIn(channel.id)
      .filter(
        (s) =>
          !detachedStreams.has(channel.id, s.user_id, s.slot) &&
          openedTiles.isOpen('hq', channel.id, hqTileId(s.user_id, s.slot))
      )
      .map((s) => hqTileId(s.user_id, s.slot))
  );
  let openScreens = $derived(
    voice.screenTracks.filter((s) => openedTiles.isOpen('screen', channel.id, s.identity))
  );
  let openCameras = $derived(
    voice.cameraTracks.filter((c) => openedTiles.isOpen('cam', channel.id, c.identity))
  );

  // Self-cam preview: same openedTiles mechanics as foreign cams (sentinel
  // identity 'self') so the own-CAM badge in the participant list can
  // open / re-show it. Appears automatically when toggled on; the X
  // hides it without stopping the camera.
  const SELF_CAM_ID = 'self';
  $effect(() => {
    const on = voice.isCameraOn;
    untrack(() => {
      if (on) openedTiles.open('cam', channel.id, SELF_CAM_ID);
    });
  });
  let showSelfCam = $derived(
    !!voice.localCameraTrack && openedTiles.isOpen('cam', channel.id, SELF_CAM_ID)
  );

  // Several parties can run in one channel — show every one the viewer has
  // opened (and that isn't detached into a popup), each as its own tile.
  let openParties = $derived(
    watchPartyPresence
      .partiesIn(channel.id)
      .filter(
        (party) =>
          watchBackground.isOpenParty(channel.id, party.party_id) &&
          !detachedWatchParties.has(channel.id, party.party_id)
      )
  );

  // ---- Anchor actions ---------------------------------------------------
  // StreamGrid renders an empty anchor div per open tile; the background
  // host in the app layout renders the player on top (docked) or as a
  // corner window when the anchor is gone. On anchor-unmount: if you're
  // no longer in that voice channel, close the tile — otherwise leave it
  // open and the floating host takes over. Three separate `use:` actions
  // (one per registry) share the same body via `makeAnchor`.
  function makeAnchor<K>(
    register: (channelId: string, key: K, el: HTMLElement) => () => void,
    onUnmount: (channelId: string, key: K) => void
  ) {
    return function anchor(
      node: HTMLElement,
      ids: { channelId: string; key: K }
    ) {
      let channelId = ids.channelId;
      let key = ids.key;
      let cleanup = register(channelId, key, node);
      return {
        update(next: { channelId: string; key: K }) {
          if (next.channelId === channelId && next.key === key) return;
          cleanup();
          channelId = next.channelId;
          key = next.key;
          cleanup = register(channelId, key, node);
        },
        destroy() {
          cleanup();
          if (!inVoiceChannel(channelId)) onUnmount(channelId, key);
        }
      };
    };
  }
  // Arrow-Wrapper um `this` an die Singleton-Instanz zu binden — sonst
  // verliert die Methodenreferenz ihr Binding und `this.#anchorEls` wirft.
  const partyAnchor = makeAnchor<string>(
    (cid, pid, el) => watchBackground.registerAnchor(cid, pid, el),
    (cid, pid) => watchBackground.closeParty(cid, pid)
  );
  const hqAnchor = makeAnchor<string>(
    (cid, uid, el) => hqStreamBackground.registerAnchor(cid, uid, el),
    (cid, uid) => openedTiles.close('hq', cid, uid)
  );
  const lkAnchor = makeAnchor<{ identity: string; kind: 'cam' | 'screen' }>(
    (cid, key, el) =>
      liveKitBackground.registerAnchor(cid, key.identity, el),
    (cid, key) => openedTiles.close(key.kind, cid, key.identity)
  );

  // Open tiles across all kinds (parties · self-cam · HQ · screens · cams) —
  // drives the column heuristic below.
  let videoTileCount = $derived(
    openParties.length +
      (showSelfCam ? 1 : 0) +
      openHqTiles.length +
      openScreens.length +
      openCameras.length
  );

  // Inline grid-template — Tailwind class interpolation could leave a stale
  // `grid-cols-*`, so we set it as a style binding instead.
  let gridStyle = $derived.by(() => {
    // Mobile: always 1 column; multiple tiles share the height (auto-rows-fr).
    if (viewport.isMobile) return 'grid-template-columns: minmax(0, 1fr);';
    const cols =
      videoTileCount <= 1 ? 1 : videoTileCount <= 4 ? 2 : videoTileCount <= 9 ? 3 : 4;
    return `grid-template-columns: repeat(${cols}, minmax(0, 1fr));`;
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3" data-testid="stream-area">
  <div
    class="grid min-h-0 flex-1 auto-rows-fr gap-2"
    style={gridStyle}
    data-testid="stream-grid"
  >
    {#each openParties as party (party.party_id)}
      <div
        class="h-full min-h-0 w-full min-w-0"
        use:partyAnchor={{ channelId: channel.id, key: party.party_id }}
        data-testid="watch-anchor"
      ></div>
    {/each}
    {#if showSelfCam}
      <div
        class="h-full min-h-0 w-full min-w-0"
        use:lkAnchor={{ channelId: channel.id, key: { identity: SELF_CAM_ID, kind: 'cam' } }}
        data-testid="selfcam-anchor"
      ></div>
    {/if}
    {#each openHqTiles as tileId (tileId)}
      <div
        class="h-full min-h-0 w-full min-w-0"
        use:hqAnchor={{ channelId: channel.id, key: tileId }}
        data-testid="hq-anchor"
      ></div>
    {/each}
    {#each openScreens as st (st.identity)}
      <div
        class="h-full min-h-0 w-full min-w-0"
        use:lkAnchor={{ channelId: channel.id, key: { identity: st.identity, kind: 'screen' } }}
        data-testid="screen-anchor"
      ></div>
    {/each}
    {#each openCameras as ct (ct.identity)}
      <div
        class="h-full min-h-0 w-full min-w-0"
        use:lkAnchor={{ channelId: channel.id, key: { identity: ct.identity, kind: 'cam' } }}
        data-testid="cam-anchor"
      ></div>
    {/each}
  </div>

  <!-- Teilnehmer-Zeile. Der Pfeil sitzt in BEIDEN Zuständen rechts an
       derselben Stelle — er darf beim Umschalten nicht springen. Zugeklappt
       bleibt die Zeile als schmaler Streifen stehen: sie trägt den Pfeil (der
       sonst mit dem verschwände, was er ausblendet) und nennt weiter, wie
       viele Leute im Kanal sind. -->
  <div class="flex shrink-0 items-center gap-2 px-1" data-testid="voice-participants-row">
    <div
      class="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-3 py-1"
      data-testid="voice-participants"
    >
      {#if participantsCollapsed}
        <span class="text-text-faint w-full text-left text-xs" data-testid="voice-participants-hint">
          {m.stream_grid_participants_collapsed_hint({ count: voice.participants.length })}
        </span>
      {:else}
        {#each voice.participants as p (p.identity)}
          <VoiceParticipantTile {p} channelId={channel.id} guildId={channel.guild_id} />
        {/each}
      {/if}
    </div>
    <Button
      variant="ghost"
      size="icon"
      class="shrink-0"
      onclick={() => settings.setStreamParticipantsCollapsed(!participantsCollapsed)}
      aria-expanded={!participantsCollapsed}
      aria-label={participantsToggleLabel}
      title={participantsToggleLabel}
      data-testid="voice-participants-toggle"
    >
      {#if participantsCollapsed}
        <ChevronUpIcon class="text-text-muted size-4" />
      {:else}
        <ChevronDownIcon class="text-text-muted size-4" />
      {/if}
    </Button>
  </div>
</div>