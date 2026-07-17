<!--
  LiveKitBackgroundHost — siblings `WatchBackgroundHost` and
  `HqStreamBackgroundHost`, owns the LiveKit video tracks: webcams (`cam`)
  and screen share (`screen`). StreamGrid now renders only empty anchors
  for the active tiles.

  Audio keeps running through the existing `VoiceParticipantTile` audio
  elements (the silent webcam video has no audio track; screen-share audio
  is wired through `audioEl` in `ScreenShareTile`, which stays active in
  docked mode). Track refs are resolved by LiveKit identity via
  `voice.cameraTracks` / `voice.screenTracks` — those are stable for the
  whole room session.

  Self-cam (`identity = 'self'`) is a special case: local track
  (`voice.localCameraTrack`), mirrored when `cameraFacing === 'user'`.
-->
<script lang="ts">
  import type { LocalVideoTrack, RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
  import { goto } from '$app/navigation';
  import { voice } from '$lib/voice/livekit.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { userCache } from '$lib/stores/users.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { liveKitBackground } from '$lib/stream/liveKitBackground.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { voiceState } from '$lib/voice/state.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import WatchBackgroundFrame from '$lib/watch/WatchBackgroundFrame.svelte';
  import CameraTile from '$lib/components/CameraTile.svelte';
  import ScreenShareTile from '$lib/components/ScreenShareTile.svelte';

  const SELF_CAM_ID = 'self';

  type CamRender = {
    track: RemoteVideoTrack | LocalVideoTrack;
    name: string;
    mirror: boolean;
  };
  type ScreenRender = {
    track: RemoteVideoTrack;
    audioTrack: RemoteAudioTrack | undefined;
    name: string;
    streamerId: string | null;
  };

  let myId = $derived(currentServerUserId());

  // Resolved at row-render time (not in `$derived`) because the local track
  // reference flips when LiveKit publishes — capturing it eagerly here would
  // pin a stale track to a tile.
  function resolveCam(identity: string): CamRender | null {
    if (identity === SELF_CAM_ID) {
      const t = voice.localCameraTrack;
      if (!t) return null;
      return {
        track: t,
        name: myId ? userCache.displayName(myId) : 'Du',
        mirror: voice.cameraFacing === 'user'
      };
    }
    const c = voice.cameraTracks.find((x) => x.identity === identity);
    if (!c) return null;
    return { track: c.track, name: c.name, mirror: false };
  }

  function resolveScreen(identity: string): ScreenRender | null {
    const s = voice.screenTracks.find((x) => x.identity === identity);
    if (!s) return null;
    return {
      track: s.track,
      audioTrack: s.audioTrack,
      name: s.name,
      streamerId: userIdFromIdentity(identity)
    };
  }

  function returnTo(channelId: string): void {
    const guildId = guilds.guildIdForChannel(channelId);
    if (guildId) goto(`/app/guilds/${guildId}/channels/${channelId}`);
  }

  // Corner-window stack offset needs a globally-unique index across both
  // groups so a cam + a screen at the same corner don't sit on top of each
  // other. Cams render first, so screens offset by the cam count.
  let camCount = $derived(openedTiles.entriesOfKind('cam').length);

  // Close cam + screen tiles that lose their reason to stay when the connected
  // voice channel changes / drops — same rationale as WatchBackgroundHost and
  // HqStreamBackgroundHost: anchor destroy in StreamGrid only fires on real
  // unmount, so a corner-mode tile that survived a "navigate-away-then-hang-up"
  // sequence would otherwise sit as a ghost popup. Viewed tiles (anchor present)
  // stay open.
  let prevVoice: string | null = null;
  $effect(() => {
    const cur = voiceState.connected ? voiceState.channelId : null;
    const prev = prevVoice;
    prevVoice = cur;
    if (!prev || prev === cur) return;
    for (const kind of ['cam', 'screen'] as const) {
      for (const e of openedTiles.entriesOfKind(kind)) {
        if (
          e.channelId === prev &&
          liveKitBackground.anchorRect(e.channelId, e.id) === null
        ) {
          openedTiles.close(kind, e.channelId, e.id);
        }
      }
    }
  });
</script>

{#each openedTiles.entriesOfKind('cam') as e, i (e.channelId + '::cam::' + e.id)}
  {@const entry = resolveCam(e.id)}
  {#if entry}
    {@const rect = liveKitBackground.anchorRect(e.channelId, e.id)}
    <WatchBackgroundFrame {rect} index={i} onReturn={() => returnTo(e.channelId)}>
      <CameraTile
        channelId={e.channelId}
        track={entry.track}
        name={entry.name}
        identity={e.id}
        mirror={entry.mirror}
      />
    </WatchBackgroundFrame>
  {/if}
{/each}

{#each openedTiles.entriesOfKind('screen') as e, i (e.channelId + '::screen::' + e.id)}
  {@const entry = resolveScreen(e.id)}
  {#if entry}
    {@const rect = liveKitBackground.anchorRect(e.channelId, e.id)}
    <WatchBackgroundFrame {rect} index={camCount + i} onReturn={() => returnTo(e.channelId)}>
      <ScreenShareTile
        channelId={e.channelId}
        streamerId={entry.streamerId}
        track={entry.track}
        audioTrack={entry.audioTrack}
        name={entry.name}
        identity={e.id}
      />
    </WatchBackgroundFrame>
  {/if}
{/each}