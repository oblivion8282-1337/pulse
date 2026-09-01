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
  import SwitchCameraIcon from '@lucide/svelte/icons/switch-camera';
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { m } from '$lib/paraglide/messages.js';

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

  /**
   * Front/Rueck-Wechsel sitzt auf der EIGENEN Kachel, nicht in der Knopfreihe
   * (Entwurf 23a).
   *
   * Zwei Gruende: er betrifft genau dieses Bild, und die Reihe muss einzeilig
   * bleiben — mit ihm waeren es auf dem Handy fuenf runde 56-px-Knoepfe, und
   * die passen nebeneinander nicht mehr.
   *
   * `mirror` ist der verlaessliche Hinweis auf die eigene Kachel: die
   * Selbst-Vorschau wird gespiegelt gerendert, fremde nie.
   */
  const zeigtKameraWechsel = $derived(mirror && viewport.isMobile && voice.isCameraOn);

  let videoEl = $state<HTMLVideoElement | null>(null);

  $effect(() => {
    const t = track;
    const el = videoEl;
    if (!t || !el) return;
    t.attach(el);
    return () => { t.detach(el); };
  });

  // `name` kommt von LiveKit (`Participant.name`) — auf einem Self-Host ist
  // das immer leer, LiveKit fällt dann auf die Identity `user-<id>` zurück.
  // Der Nutzer-Cache kennt den echten Namen — bevorzugt den, sonst `name`.
  const angezeigteUserId = $derived(userIdFromIdentity(identity));
  $effect(() => {
    if (angezeigteUserId) userCache.queue(angezeigteUserId);
  });
  const anzeigeName = $derived(
    angezeigteUserId ? userCache.displayName(angezeigteUserId, name) : name
  );
</script>

<TileShell
  kind="cam"
  containerTestid="camera-tile"
  testidPrefix="camera"
  {identity}
  name={anzeigeName}
  video={videoEl}
  onHide={onHide ?? (() => openedTiles.close('cam', channelId, identity))}
>
  {#snippet overlay()}
    {#if zeigtKameraWechsel}
      <button
        class="absolute bottom-2 right-2 z-10 flex size-11 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
        onclick={() => void voice.flipCamera()}
        data-testid="camera-tile-flip"
        aria-label={m.voice_bar_camera_switch()}
      >
        <SwitchCameraIcon class="size-5" />
      </button>
    {/if}
  {/snippet}
  {#snippet media()}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      muted
      class="h-full min-h-0 w-full min-w-0 object-cover {mirror ? '-scale-x-100' : ''}"
    ></video>
  {/snippet}
</TileShell>
