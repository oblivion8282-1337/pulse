<!--
  CameraTile — playback of a remote LiveKit webcam track.

  Schlankste der vier Kacheln: kein Audio, kein Chat, kein Detach, keine
  Stats. Nutzt TileShell nur für Rahmen + Name-Pille + Fullscreen + Hide.
-->
<script lang="ts">
  import type { RemoteVideoTrack } from 'livekit-client';
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';

  let {
    channelId,
    track,
    name,
    identity,
    compact = false,
    focused = false,
    onToggleFocus
  }: {
    channelId: string;
    track: RemoteVideoTrack;
    name: string;
    identity: string;
    /** Filmstrip-Kachel im Fokus-Modus. */
    compact?: boolean;
    /** Diese Kachel ist die fokussierte (große). */
    focused?: boolean;
    onToggleFocus?: () => void;
  } = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);

  $effect(() => {
    const t = track;
    const el = videoEl;
    if (!t || !el) return;
    t.attach(el);
    return () => { t.detach(el); };
  });
</script>

<TileShell
  kind="cam"
  containerTestid="camera-tile"
  testidPrefix="camera"
  {identity}
  {name}
  video={videoEl}
  onHide={() => openedTiles.close('cam', channelId, identity)}
  {compact}
  {focused}
  {onToggleFocus}
>
  {#snippet media()}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={videoEl} autoplay playsinline class="h-full w-full object-cover"></video>
  {/snippet}
</TileShell>
