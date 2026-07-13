<!--
  StreamGrid — the video-tile column of a voice channel with active streams.

  Renders one anchor div per open tile (via `openedTiles`); the actual players
  live in the app layout (`WatchBackgroundHost`, `HqStreamBackgroundHost`,
  `LiveKitBackgroundHost`) and either dock onto the anchor or fall back to a
  floating corner window when the anchor is gone — that's how HQ streams,
  webcams, and screen share keep playing when you navigate away.

  Layout: grid (equal tiles) OR focus mode — one tile large, the rest as a
  filmstrip row underneath. Detached tiles don't appear as placeholders.
-->
<script lang="ts">
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
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
  import { streamFocus } from '$lib/stream/streamFocus.svelte';
  import { inVoiceChannel } from '$lib/voice/state.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { untrack } from 'svelte';
  import type { Channel } from '$lib/api/types';

  let { channel }: { channel: Channel } = $props();

  let myId = $derived(currentServerUserId());

  // What the viewer has actually opened, in this channel, per kind.
  // Detached tiles are excluded — they're showing in a separate window.
  // One entry per OPEN, live, non-self, non-detached HQ tile — keyed by the
  // composite `<userId>:<slot>` id so a user's two streams get two anchors.
  let openHqTiles = $derived(
    streamPresence
      .streamsIn(channel.id)
      .filter(
        (s) =>
          s.user_id !== myId &&
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

  // Stable tile keys in render order (parties · self-cam · HQ · screens · cams).
  let tileKeys = $derived([
    ...openParties.map((p) => `party:${p.party_id}`),
    ...(showSelfCam ? ['selfcam'] : []),
    ...openHqTiles.map((id) => `hq:${id}`),
    ...openScreens.map((s) => `screen:${s.identity}`),
    ...openCameras.map((c) => `cam:${c.identity}`)
  ]);
  let videoTileCount = $derived(tileKeys.length);

  // --- Focus mode -------------------------------------------------------
  // `focusedKey` lives in the `streamFocus` store (shared source for
  // StreamGrid AND the background hosts, so the focus button works on a
  // docked tile too). `focusMode` additionally checks that ≥2 tiles exist
  // and the focused one is still present (otherwise fall back to grid).
  let focusedKey = $derived(streamFocus.channelId === channel.id ? streamFocus.key : null);
  let focusMode = $derived(
    focusedKey !== null && videoTileCount > 1 && tileKeys.includes(focusedKey)
  );

  // Reset focus when the channel is "really" left (disconnect / switch to a
  // different voice channel). On a pure navigate-away to a text channel /
  // DM the focus is preserved — you return to the tile with the same focus.
  $effect(() => {
    channel.id;
    return () => {
      if (!inVoiceChannel(channel.id)) streamFocus.resetForChannel(channel.id);
    };
  });

  /** Inline grid placement: the focused tile spans the top row. */
  function cellStyle(key: string): string {
    return focusMode && focusedKey === key ? 'grid-column: 1 / -1; grid-row: 1;' : '';
  }

  // Inline grid-template — Tailwind class interpolation could leave a stale
  // `grid-cols-*`, so we set it as a style binding instead.
  let gridStyle = $derived.by(() => {
    if (focusMode) {
      const n = Math.max(1, videoTileCount - 1);
      const strip = viewport.isMobile ? '4.75rem' : '6.5rem';
      return `grid-template-columns: repeat(${n}, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr) ${strip};`;
    }
    // Mobile: always 1 column; multiple tiles share the height (auto-rows-fr).
    if (viewport.isMobile) return 'grid-template-columns: minmax(0, 1fr);';
    const cols =
      videoTileCount <= 1 ? 1 : videoTileCount <= 4 ? 2 : videoTileCount <= 9 ? 3 : 4;
    return `grid-template-columns: repeat(${cols}, minmax(0, 1fr));`;
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3" data-testid="stream-area">
  <div
    class="grid min-h-0 flex-1 gap-2 {focusMode ? '' : 'auto-rows-fr'}"
    style={gridStyle}
    data-testid="stream-grid"
    data-focus-mode={focusMode}
  >
    {#each openParties as party (party.party_id)}
      {@const key = `party:${party.party_id}`}
      <div class="min-h-0 min-w-0" style={cellStyle(key)}>
        <div
          class="h-full w-full"
          use:partyAnchor={{ channelId: channel.id, key: party.party_id }}
          data-testid="watch-anchor"
        ></div>
      </div>
    {/each}
    {#if showSelfCam}
      <div class="min-h-0 min-w-0" style={cellStyle('selfcam')}>
        <div
          class="h-full w-full"
          use:lkAnchor={{ channelId: channel.id, key: { identity: SELF_CAM_ID, kind: 'cam' } }}
          data-testid="selfcam-anchor"
        ></div>
      </div>
    {/if}
    {#each openHqTiles as tileId (tileId)}
      {@const key = `hq:${tileId}`}
      <div class="min-h-0 min-w-0" style={cellStyle(key)}>
        <div
          class="h-full w-full"
          use:hqAnchor={{ channelId: channel.id, key: tileId }}
          data-testid="hq-anchor"
        ></div>
      </div>
    {/each}
    {#each openScreens as st (st.identity)}
      {@const key = `screen:${st.identity}`}
      <div class="min-h-0 min-w-0" style={cellStyle(key)}>
        <div
          class="h-full w-full"
          use:lkAnchor={{ channelId: channel.id, key: { identity: st.identity, kind: 'screen' } }}
          data-testid="screen-anchor"
        ></div>
      </div>
    {/each}
    {#each openCameras as ct (ct.identity)}
      {@const key = `cam:${ct.identity}`}
      <div class="min-h-0 min-w-0" style={cellStyle(key)}>
        <div
          class="h-full w-full"
          use:lkAnchor={{ channelId: channel.id, key: { identity: ct.identity, kind: 'cam' } }}
          data-testid="cam-anchor"
        ></div>
      </div>
    {/each}
  </div>

  <div
    class="flex shrink-0 flex-wrap items-center justify-center gap-3 py-1"
    data-testid="voice-participants"
  >
    {#each voice.participants as p (p.identity)}
      <VoiceParticipantTile {p} channelId={channel.id} guildId={channel.guild_id} />
    {/each}
  </div>
</div>