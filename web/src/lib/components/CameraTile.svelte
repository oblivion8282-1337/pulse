<!--
  CameraTile — playback of a LiveKit webcam track.

  Schlankste der vier Kacheln: kein Audio, kein Chat, kein Detach, keine
  Stats. Nutzt TileShell nur für Rahmen + Name-Pille + Fullscreen + Hide.
  Zeigt entweder eine fremde (RemoteVideoTrack) ODER die eigene
  (LocalVideoTrack, `mirror`) Kamera — die eigene Selbst-Vorschau wird
  gespiegelt + stummgeschaltet gerendert.
-->
<script lang="ts">
  import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client';
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';

  let {
    channelId,
    track,
    name,
    identity,
    mirror = false,
    onHide
  }: {
    channelId: string;
    track: LocalVideoTrack | RemoteVideoTrack;
    name: string;
    identity: string;
    /** Horizontal spiegeln — für die eigene Frontkamera-Vorschau. */
    mirror?: boolean;
    /** Überschreibt das Standard-Schließen (openedTiles) — z.B. um die
     *  eigene Selbst-Vorschau auszublenden ohne die Kamera zu stoppen. */
    onHide?: () => void;
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
  onHide={onHide ?? (() => openedTiles.close('cam', channelId, identity))}
>
  {#snippet media()}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      muted
      class="h-full w-full object-cover {mirror ? '-scale-x-100' : ''}"
    ></video>
  {/snippet}
</TileShell>
