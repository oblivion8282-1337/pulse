<!--
  Native HTML5 <video> wrapper for mp4 / webm / m3u8 sources.

  m3u8 plays natively on Safari + recent Chromium via MSE; older browsers
  would need hls.js (not bundled in v1 — Pulse is desktop/PWA-focussed on
  Chromium).

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
    /** Host: native controls on. Viewer: no controls, pointer-events
     * blocked — the tile's custom overlay handles volume + fullscreen. */
    interactive?: boolean;
    onReady?: (handle: PlayerHandle) => void;
    onEvent?: (e: PlayerEvent) => void;
  }

  let { source, interactive = true, onReady, onEvent }: Props = $props();

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
  controls={interactive}
  playsinline
  class="h-full w-full bg-black"
  style:pointer-events={interactive ? undefined : 'none'}
>
  <track kind="captions" />
</video>
