<!--
  YouTube IFrame Player API wrapper.

  Loads https://www.youtube.com/iframe_api once per session (module-level
  promise); subsequent instances reuse the loaded `window.YT`.

  `interactive` gates the native player chrome: the HOST gets the full YouTube
  controls (play/pause/seek + volume/quality/fullscreen), a VIEWER gets a
  read-only player (`controls: 0` + `disablekb: 1`) so only the host steers
  playback. The viewer's lost volume/fullscreen is handed back via the tile's
  own HUD; a click-catcher over the iframe (in WatchPartyTile) stops a bare
  video-click from pausing. `interactive` is mount-time only — a handoff
  remounts the player (WatchPartyTile keys the player on the host role).

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
    moduleApiPromise = new Promise((resolve, reject) => {
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
        s.onerror = () => {
          moduleApiPromise = undefined;
          reject(new Error('YouTube IFrame API failed to load'));
        };
        document.head.appendChild(s);
      }
    });
    return moduleApiPromise;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { WatchSourceYouTube } from '$lib/stores/watchPartyPresence.svelte';
  import type { PlayerEvent, PlayerHandle } from '../sync';

  // Ambient YT types we touch — too narrow a slice to pull in @types/youtube.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type YTPlayer = any;

  interface Props {
    source: WatchSourceYouTube;
    /** Start playing immediately (mount-time only). True when the party is in
     * its playing state — leverages the user-activation from the create/join
     * click so host + viewer don't have to press play manually. */
    autoplay?: boolean;
    /** Host = full native controls; viewer = read-only player. Mount-time only
     * (see file header) — the tile remounts on a host handoff. */
    interactive?: boolean;
    onReady?: (handle: PlayerHandle) => void;
    onEvent?: (e: PlayerEvent) => void;
  }

  let { source, autoplay = false, interactive = true, onReady, onEvent }: Props = $props();

  let mount = $state<HTMLDivElement | undefined>();

  $effect(() => {
    if (!mount) return;
    // mount-time only — read without tracking so a later is_playing flip
    // doesn't tear down and rebuild the player.
    const startPlaying = untrack(() => autoplay);
    const canControl = untrack(() => interactive);
    let player: YTPlayer | undefined;
    let disposed = false;
    // CyTube's `pauseSeekRaceCondition` (player/youtube.coffee): calling
    // pause() before the player has ever fired a PLAYING event makes the YT
    // iframe "do weird things" — historically a hard crash, today a swallowed
    // pause / stuck player. Our "play immediately on create/join" flow
    // (commits 2cbda80 / c961085) hits exactly this: applyHard pause()+seek()
    // can run from onReady before YT has started. So we DEFER a pre-PLAYING
    // pause and replay it on the first PLAYING event; play() cancels a pending
    // one. seek() before PLAYING is safe (CyTube seeks in its lead-in path).
    let firstPlayingSeen = false;
    let pendingPause = false;

    void loadApi()
      .then((YT) => {
        if (disposed || !mount) return;
        player = new YT.Player(mount, {
          videoId: source.embed_id,
          playerVars: {
            autoplay: startPlaying ? 1 : 0,
            // Viewer = read-only: no control bar, no keyboard shortcuts. The
            // host keeps the full native chrome. See file header.
            controls: canControl ? 1 : 0,
            disablekb: canControl ? 0 : 1,
            modestbranding: 1,
            rel: 0,
            start: source.start_seconds ?? 0,
            playsinline: 1
          },
          events: {
            onReady: () => {
              const handle: PlayerHandle = {
                play: () => {
                  // Cancel any pause deferred before the first PLAYING event.
                  pendingPause = false;
                  player?.playVideo();
                },
                pause: () => {
                  // Before the first PLAYING event, don't pause directly (the
                  // race above) — defer and replay it in onStateChange.
                  if (firstPlayingSeen) player?.pauseVideo();
                  else pendingPause = true;
                },
                seek: (t: number) => player?.seekTo(t, true),
                getCurrentTime: () => Number(player?.getCurrentTime() ?? 0),
                getDuration: () => Number(player?.getDuration() ?? 0),
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
              if (e.data === YT.PlayerState.PLAYING) {
                firstPlayingSeen = true;
                if (pendingPause) {
                  // Replay the deferred pre-PLAYING pause now that it's safe.
                  // The brief PLAYING was only the race workaround firing — do
                  // NOT surface it as 'play', or a host would broadcast a
                  // phantom play and viewers would resync to it.
                  pendingPause = false;
                  player?.pauseVideo();
                  return;
                }
                onEvent?.({ type: 'play', position: t });
              } else if (e.data === YT.PlayerState.PAUSED) {
                onEvent?.({ type: 'pause', position: t });
              } else if (e.data === YT.PlayerState.ENDED) {
                // Host promotes the next queued video (WatchPartyTile).
                onEvent?.({ type: 'ended' });
              }
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onError: (e: any) => {
              onEvent?.({ type: 'error', reason: `YouTube error ${e?.data}` });
            }
          }
        });
      })
      .catch(() => {
        // loadApi() rejected (script failed to load); moduleApiPromise was
        // already reset to undefined so the next mount will retry.
        onEvent?.({ type: 'error', reason: 'YouTube IFrame API failed to load' });
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
