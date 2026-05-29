<!--
  YouTube IFrame Player API wrapper.

  Loads https://www.youtube.com/iframe_api once per session (module-level
  promise); subsequent instances reuse the loaded `window.YT`. Native player
  chrome is always enabled so both host and viewer get volume / quality /
  fullscreen. Viewer-side play/pause/seek don't broadcast (host-only) and
  the WatchPartyTile holds a `viewerPaused` flag so heartbeats don't fight
  the viewer's local pause.

  YT.Player can't emit a discrete "seek" event — the tile detects time-jumps
  via heartbeat drift correction instead.
-->
<script module lang="ts">
  // Module-level singleton load of the IFrame API. Re-entries return the
  // existing promise so we never inject the script twice.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let moduleApiPromise: Promise<any> | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function loadApi(): Promise<any> {
    if (moduleApiPromise) return moduleApiPromise;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (w.YT?.Player) {
      moduleApiPromise = Promise.resolve(w.YT);
      return moduleApiPromise;
    }
    moduleApiPromise = new Promise((resolve) => {
      const prev = w.onYouTubeIframeAPIReady;
      w.onYouTubeIframeAPIReady = () => {
        try {
          prev?.();
        } catch {
          // chained init failed; not our problem
        }
        resolve(w.YT);
      };
      // Check if script already exists before appending
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.async = true;
        document.head.appendChild(s);
      }
    });
    return moduleApiPromise;
  }
</script>

<script lang="ts">
  import type { WatchSourceYouTube } from '$lib/stores/watchPartyPresence.svelte';
  import type { PlayerEvent, PlayerHandle } from '../sync';

  // Ambient YT types we touch — too narrow a slice to pull in @types/youtube.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type YTPlayer = any;

  interface Props {
    source: WatchSourceYouTube;
    onReady?: (handle: PlayerHandle) => void;
    onEvent?: (e: PlayerEvent) => void;
  }

  let { source, onReady, onEvent }: Props = $props();

  let mount = $state<HTMLDivElement | undefined>();

  $effect(() => {
    if (!mount) return;
    let player: YTPlayer | undefined;
    let disposed = false;

    void loadApi().then((YT) => {
      if (disposed || !mount) return;
      player = new YT.Player(mount, {
        videoId: source.embed_id,
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          start: source.start_seconds ?? 0,
          playsinline: 1
        },
        events: {
          onReady: () => {
            const handle: PlayerHandle = {
              play: () => player?.playVideo(),
              pause: () => player?.pauseVideo(),
              seek: (t: number) => player?.seekTo(t, true),
              getCurrentTime: () => Number(player?.getCurrentTime() ?? 0),
              setPlaybackRate: (r: number) => player?.setPlaybackRate(r),
              setVolume: (p: number) => player?.setVolume(Math.max(0, Math.min(100, p))),
              destroy: () => {
                try {
                  player?.destroy();
                } catch {
                  // already destroyed
                }
              }
            };
            onReady?.(handle);
            onEvent?.({ type: 'ready' });
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStateChange: (e: any) => {
            const t = Number(player?.getCurrentTime() ?? 0);
            if (e.data === YT.PlayerState.PLAYING) onEvent?.({ type: 'play', position: t });
            else if (e.data === YT.PlayerState.PAUSED) onEvent?.({ type: 'pause', position: t });
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onError: (e: any) => {
            onEvent?.({ type: 'error', reason: `YouTube error ${e?.data}` });
          }
        }
      });
    });

    return () => {
      disposed = true;
      try {
        player?.destroy();
      } catch {
        // already destroyed
      }
    };
  });
</script>

<div bind:this={mount} class="h-full w-full"></div>
