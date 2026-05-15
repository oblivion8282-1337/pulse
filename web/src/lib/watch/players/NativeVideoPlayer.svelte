<!--
  Native HTML5 <video> wrapper for mp4 / webm / m3u8 sources.

  m3u8 plays natively on Safari + recent Chromium via MSE; older browsers
  would need hls.js (not bundled in v1 — Pulse is desktop/PWA-focussed on
  Chromium).

  The `controls` attribute is bound to `controlsEnabled` — viewers get a
  read-only player, host gets full scrubbing/play/pause UI.
-->
<script lang="ts">
  import type { WatchSourceNative } from '$lib/stores/watchPartyPresence.svelte';
  import type { PlayerEvent, PlayerHandle } from '../sync';

  interface Props {
    source: WatchSourceNative;
    controlsEnabled: boolean;
    onReady?: (handle: PlayerHandle) => void;
    onEvent?: (e: PlayerEvent) => void;
  }

  let { source, controlsEnabled, onReady, onEvent }: Props = $props();

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
  controls={controlsEnabled}
  playsinline
  class="h-full w-full bg-black"
  style:pointer-events={controlsEnabled ? undefined : 'none'}
>
  <track kind="captions" />
</video>
