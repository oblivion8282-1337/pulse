<!--
  Twitch player wrapper — handles both VOD and live channel sources.

  Loads https://embed.twitch.tv/embed/v1.js once per session and instantiates
  `Twitch.Player` (video-only, no chat). The constructor takes either
  `{ video: <id> }` (VOD) or `{ channel: <name> }` (live) — everything else
  is identical.

  Live caveats baked in:
    * `getCurrentTime()` / `getDuration()` don't work on live — handle
      returns 0 so the sync layer's expectedPosition math stays sane (the
      WatchPartyTile gates heartbeats off entirely for live anyway).
    * `seek()` doesn't work on live — handle's seek is a no-op.
    * `SEEK` event doesn't fire on live — listener registered for VOD only.

  `parent` is required by Twitch and must match the current hostname; we
  derive it from `window.location` at mount time.

  Twitch's Embed API has no `setPlaybackRate` — our handle implements it as a
  no-op; the drift corrector falls back to hard seeks on VODs.
-->
<script lang="ts">
  import type {
    WatchSourceTwitch,
    WatchSourceTwitchLive
  } from '$lib/stores/watchPartyPresence.svelte';
  import type { PlayerEvent, PlayerHandle } from '../sync';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TwitchPlayer = any;

  interface Props {
    source: WatchSourceTwitch | WatchSourceTwitchLive;
    onReady?: (handle: PlayerHandle) => void;
    onEvent?: (e: PlayerEvent) => void;
  }

  let { source, onReady, onEvent }: Props = $props();

  let mount = $state<HTMLDivElement | undefined>();
  const elementId = `twitch-player-${Math.random().toString(36).slice(2)}`;
  const isLive = $derived(source.type === 'twitch_live');

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
      const options: Record<string, unknown> = {
        parent: [window.location.hostname],
        width: '100%',
        height: '100%',
        autoplay: false,
        muted: false
      };
      if (source.type === 'twitch_live') options.channel = source.channel;
      else options.video = source.embed_id;
      player = new Twitch.Player(elementId, options);

      const safeTime = () => (isLive ? 0 : Number(player?.getCurrentTime() ?? 0));
      const onPlay = () => onEvent?.({ type: 'play', position: safeTime() });
      const onPause = () => onEvent?.({ type: 'pause', position: safeTime() });
      player.addEventListener(Twitch.Player.PLAY, onPlay);
      player.addEventListener(Twitch.Player.PAUSE, onPause);
      // SEEK only fires for VODs — Twitch doesn't allow seek on live.
      if (!isLive) {
        const onSeek = () => onEvent?.({ type: 'seek', position: safeTime() });
        player.addEventListener(Twitch.Player.SEEK, onSeek);
      }

      player.addEventListener(Twitch.Player.READY, () => {
        const handle: PlayerHandle = {
          play: () => player?.play(),
          pause: () => player?.pause(),
          seek: (t: number) => {
            if (isLive) return; // no-op on live; sync layer gates this too
            player?.seek(t);
          },
          getCurrentTime: safeTime,
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

<div bind:this={mount} id={elementId} class="h-full w-full"></div>
