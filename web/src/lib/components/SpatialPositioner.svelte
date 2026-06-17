<script lang="ts">
  import { untrack } from 'svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { loadChannelPositions, saveChannelPosition, type SpatialPos } from '$lib/voice/spatial/positions';
  import { m } from '$lib/paraglide/messages.js';

  let { channelId, size = 280 }: { channelId: string; size?: number } = $props();

  // Geometry of the top-down circle (px). Listener sits dead centre. Sizes
  // scale with `size` so the same circle works full-width or in the narrow
  // left sidebar.
  const CENTER = $derived(size / 2);
  const AVATAR = $derived(size <= 230 ? 30 : 40); // dot avatar diameter (px)
  const RADIUS = $derived(size / 2 - AVATAR / 2 - 6); // max dot distance from centre
  const MAX_DIST = 14; // metres mapped onto RADIUS
  const DEFAULT_DIST = 2.5;
  const SPREAD_ARC = 200; // frontal fan for not-yet-placed speakers

  let positions = $state<Record<string, SpatialPos>>({});
  let dragging = $state<string | null>(null);

  let remotes = $derived(voice.participants.filter((p) => !p.isLocal && p.userId));
  let localName = $derived(voice.participants.find((p) => p.isLocal)?.name ?? m.spatial_you());
  // Stable membership key — changes only when someone joins/leaves, not on every
  // speaking-level tick. Gates the reconcile effect so it doesn't run ~10×/s.
  let remoteIdsKey = $derived(remotes.map((p) => p.userId).join(','));

  // Ensure every remote has a position (stored → else auto-spread) and push it
  // into the audio engine, once per membership change.
  $effect(() => {
    const ids = remoteIdsKey ? remoteIdsKey.split(',') : [];
    untrack(() => {
      const stored = loadChannelPositions(channelId);
      ids.forEach((uid, i) => {
        if (!positions[uid]) {
          positions[uid] =
            stored[uid] ??
            { az: ids.length <= 1 ? 0 : -SPREAD_ARC / 2 + (SPREAD_ARC * i) / (ids.length - 1), dist: DEFAULT_DIST };
        }
        voice.setSpatialPosition(uid, positions[uid].az, positions[uid].dist);
      });
    });
  });

  function dotStyle(pos: SpatialPos): string {
    const r = Math.min(pos.dist / MAX_DIST, 1) * RADIUS;
    const rad = (pos.az * Math.PI) / 180;
    return `left:${CENTER + r * Math.sin(rad)}px;top:${CENTER - r * Math.cos(rad)}px`;
  }

  function onPointerDown(uid: string, ev: PointerEvent): void {
    dragging = uid;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  function onPointerMove(uid: string, ev: PointerEvent): void {
    if (dragging !== uid) return;
    // Pointer is captured on the dot button; its offsetParent is the circle.
    const stage = (ev.currentTarget as HTMLElement).offsetParent as HTMLElement;
    const rect = stage.getBoundingClientRect();
    const cx = ev.clientX - rect.left - CENTER;
    const cy = ev.clientY - rect.top - CENTER;
    const az = (Math.atan2(cx, -cy) * 180) / Math.PI;
    const dist = Math.max(0.5, Math.min(MAX_DIST, (Math.hypot(cx, cy) / RADIUS) * MAX_DIST));
    positions[uid] = { az, dist };
    voice.setSpatialPosition(uid, az, dist);
    saveChannelPosition(channelId, uid, positions[uid]);
  }

  function displayName(uid: string, fallback: string): string {
    return userCache.get(uid) ? userCache.displayName(uid) : fallback;
  }
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-3 p-4" data-testid="spatial-positioner">
  <div
    class="border-border bg-bg-input/40 relative rounded-full border"
    style="width:{size}px;height:{size}px"
  >
    <!-- Concentric guide rings -->
    <div class="border-border/40 pointer-events-none absolute inset-[20%] rounded-full border"></div>
    <div class="border-border/25 pointer-events-none absolute inset-[40%] rounded-full border"></div>

    <!-- Listener (you), centre, facing up -->
    <div
      class="bg-primary text-primary-foreground absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full text-[9px] leading-none font-semibold shadow-lg"
      style="left:{CENTER}px;top:{CENTER}px;width:{AVATAR + 8}px;height:{AVATAR + 8}px"
      title={localName}
    >
      <span aria-hidden="true">▲</span>
      {m.spatial_you()}
    </div>

    {#each remotes as p (p.identity)}
      {@const uid = p.userId as string}
      {@const pos = positions[uid]}
      {#if pos}
        {@const name = displayName(uid, p.name)}
        {@const avatar = safeAvatarUrl(userCache.get(uid)?.avatar_url)}
        <button
          type="button"
          class="absolute flex -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none flex-col items-center gap-0.5 focus:outline-none active:cursor-grabbing"
          style={dotStyle(pos)}
          onpointerdown={(e) => onPointerDown(uid, e)}
          onpointermove={(e) => onPointerMove(uid, e)}
          onpointerup={() => (dragging = null)}
          data-testid="spatial-dot"
          aria-label={name}
        >
          <span
            class="ring-bg-input overflow-hidden rounded-full ring-2"
            class:ring-primary={p.isSpeaking}
            style="width:{AVATAR}px;height:{AVATAR}px;{p.isSpeaking ? 'box-shadow:0 0 10px var(--color-primary)' : ''}"
          >
            {#if avatar}
              <img src={avatar} alt="" class="size-full object-cover" draggable="false" />
            {:else}
              <span class="bg-bg-hover text-text-bright flex size-full items-center justify-center text-sm font-medium">
                {(name.trim()[0] ?? '?').toUpperCase()}
              </span>
            {/if}
          </span>
          <span class="text-text-base max-w-16 truncate text-[11px]">{name}</span>
        </button>
      {/if}
    {/each}
  </div>
  <p class="text-text-muted text-xs">{m.spatial_drag_hint()}</p>
</div>
