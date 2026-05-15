<!--
  Twitch VOD player wrapper.

  Loads https://embed.twitch.tv/embed/v1.js once per session and instantiates
  `Twitch.Player` (video-only, no chat). Live channels aren't supported — the
  source parser rejects them because Twitch doesn't allow seek on live
  streams (no way to keep viewers in sync without it).

  `parent` is required by Twitch and must match the current hostname; we
  derive it from `window.location` at mount time.

  Twitch's Embed API has no `setPlaybackRate` — our handle implements it as a
  no-op; the drift corrector falls back to hard seeks on this player.
-->
<script lang="ts">
  import type { WatchSourceTwitch } from '$lib/stores/watchPartyPresence.svelte';
  import type { PlayerEvent, PlayerHandle } from '../sync';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TwitchPlayer = any;

  interface Props {
    source: WatchSourceTwitch;
    /** Host: clickable. Viewer: pointer-events blocked. Note that Twitch's
     * Embed API has no way to programmatically hide the native chrome —
     * with pointer-events: none the chrome won't appear (no hover events
     * reach the iframe), so this is good enough in practice. */
    interactive?: boolean;
    onReady?: (handle: PlayerHandle) => void;
    onEvent?: (e: PlayerEvent) => void;
  }

  let { source, interactive = true, onReady, onEvent }: Props = $props();

  let mount = $state<HTMLDivElement | undefined>();
  const elementId = `twitch-player-${Math.random().toString(36).slice(2)}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let apiPromise: Promise<any> | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function loadApi(): Promise<any> {
    if (apiPromise) return apiPromise;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (w.Twitch?.Player) {
      apiPromise = Promise.resolve(w.Twitch);
      return apiPromise;
    }
    apiPromise = new Promise((resolve) => {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[src="https://embed.twitch.tv/embed/v1.js"]'
      );
      const onLoad = () => resolve(w.Twitch);
      if (existing) {
        existing.addEventListener('load', onLoad, { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://embed.twitch.tv/embed/v1.js';
      s.async = true;
      s.addEventListener('load', onLoad, { once: true });
      document.head.appendChild(s);
    });
    return apiPromise;
  }

  $effect(() => {
    if (!mount) return;
    let player: TwitchPlayer | undefined;
    let disposed = false;

    void loadApi().then((Twitch) => {
      if (disposed || !mount) return;
      player = new Twitch.Player(elementId, {
        video: source.embed_id,
        parent: [window.location.hostname],
        width: '100%',
        height: '100%',
        autoplay: false,
        muted: false
      });

      const onPlay = () => {
        onEvent?.({ type: 'play', position: Number(player?.getCurrentTime() ?? 0) });
      };
      const onPause = () => {
        onEvent?.({ type: 'pause', position: Number(player?.getCurrentTime() ?? 0) });
      };
      const onSeek = () => {
        onEvent?.({ type: 'seek', position: Number(player?.getCurrentTime() ?? 0) });
      };
      player.addEventListener(Twitch.Player.PLAY, onPlay);
      player.addEventListener(Twitch.Player.PAUSE, onPause);
      // SEEK event fires only for VODs — which is the only mode we support.
      player.addEventListener(Twitch.Player.SEEK, onSeek);

      player.addEventListener(Twitch.Player.READY, () => {
        const handle: PlayerHandle = {
          play: () => player?.play(),
          pause: () => player?.pause(),
          seek: (t: number) => player?.seek(t),
          getCurrentTime: () => Number(player?.getCurrentTime() ?? 0),
          setPlaybackRate: () => {
            /* Twitch Embed API doesn't expose playbackRate. */
          },
          setVolume: (p: number) => {
            const clamped = Math.max(0, Math.min(100, p));
            player?.setVolume(clamped / 100);
          },
          destroy: () => {
            // The Embed API has no `destroy`; clearing the container is the
            // documented teardown.
            if (mount) mount.innerHTML = '';
          }
        };
        onReady?.(handle);
        onEvent?.({ type: 'ready' });
      });
    });

    return () => {
      disposed = true;
      if (mount) mount.innerHTML = '';
    };
  });
</script>

<div
  bind:this={mount}
  id={elementId}
  class="h-full w-full"
  style:pointer-events={interactive ? undefined : 'none'}
></div>
