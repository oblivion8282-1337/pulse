<!--
  Native HTML5 <video> wrapper for mp4 / webm sources.

  HLS (.m3u8) is NOT supported: this is a plain <video> element and Pulse
  targets Chromium/Electron, which can't play HLS natively. The source parser
  rejects .m3u8 so it never reaches here. Add hls.js + an MSE path if HLS is
  ever wanted.

  Native `controls` is always on so viewers get volume / fullscreen /
  scrubbing. Viewer-driven play/pause/seek events are ignored by
  WatchPartyTile (host-only broadcast), and the next heartbeat re-aligns
  the viewer's position via DriftCorrector.applySoft.
-->
<script lang="ts">
  import type { WatchSourceNative } from '$lib/stores/watchPartyPresence.svelte';
  import type { PlayerEvent, PlayerHandle } from '../sync';

  interface Props {
    source: WatchSourceNative;
    /** Start playing immediately (mount-time only) — see YouTubePlayer. */
    autoplay?: boolean;
    onReady?: (handle: PlayerHandle) => void;
    onEvent?: (e: PlayerEvent) => void;
  }

  let { source, autoplay = false, onReady, onEvent }: Props = $props();
  // Capture once at mount: a later is_playing flip is driven by the controller
  // via the handle, not by re-toggling the element attribute.
  // svelte-ignore state_referenced_locally
  const startPlaying = autoplay;

  let video = $state<HTMLVideoElement | undefined>();

  $effect(() => {
    const v = video;
    if (!v) return;

    const onPlay = () => onEvent?.({ type: 'play', position: v.currentTime });
    const onPause = () => onEvent?.({ type: 'pause', position: v.currentTime });
    const onSeeked = () => onEvent?.({ type: 'seek', position: v.currentTime });
    const onError = () => {
      const code = v.error?.code;
      onEvent?.({ type: 'error', reason: `video error ${code ?? '?'}` });
    };
    const onLoadedMeta = () => {
      const handle: PlayerHandle = {
        play: () => {
          void v.play().catch(() => undefined);
        },
        pause: () => v.pause(),
        seek: (t: number) => {
          v.currentTime = t;
        },
        getCurrentTime: () => v.currentTime,
        getDuration: () => (Number.isFinite(v.duration) ? v.duration : 0),
        setPlaybackRate: (r: number) => {
          v.playbackRate = r;
        },
        setVolume: (p: number) => {
          v.volume = Math.max(0, Math.min(100, p)) / 100;
        },
        destroy: () => {
          v.pause();
          v.removeAttribute('src');
          v.load();
        }
      };
      onReady?.(handle);
      onEvent?.({ type: 'ready' });
    };

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    v.addEventListener('loadedmetadata', onLoadedMeta, { once: true });

    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
      v.removeEventListener('loadedmetadata', onLoadedMeta);
    };
  });
</script>

<video
  bind:this={video}
  src={source.url}
  controls
  playsinline
  autoplay={startPlaying}
  class="h-full w-full bg-black"
>
  <track kind="captions" />
</video>
