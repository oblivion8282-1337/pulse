<script lang="ts">
  import { voice } from '$lib/voice/livekit.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { safeAvatarUrl } from '$lib/avatar';
  import {
    azimuthFor,
    loadLayout,
    saveLayout,
    SPREAD_MIN,
    SPREAD_MAX,
    DIST_MIN,
    DIST_MAX
  } from '$lib/voice/spatial/layout';
  import { m } from '$lib/paraglide/messages.js';

  let { size = 280 }: { size?: number } = $props();

  // Geometry of the top-down circle (px). Listener sits dead centre.
  const CENTER = $derived(size / 2);
  const AVATAR = $derived(size <= 230 ? 30 : 40);
  const RADIUS = $derived(size / 2 - AVATAR / 2 - 6);

  const initial = loadLayout();
  let spreadDeg = $state(initial.spreadDeg);
  let distanceM = $state(initial.distanceM);

  // Sorted by userId so the on-screen fan matches the audio engine's order.
  let remotes = $derived(
    voice.participants
      .filter((p) => !p.isLocal && p.userId)
      .sort((a, b) => (a.userId! < b.userId! ? -1 : 1))
  );
  // `p.name` kommt von LiveKit — auf einem Self-Host ist das immer leer und
  // faellt auf die Identity `user-<id>` zurueck (siehe CameraTile.svelte).
  // Der eigene Name ist ueber den Nutzer-Cache immer schon bekannt.
  const eigeneId = $derived(currentServerUserId());
  let localName = $derived.by(() => {
    const p = voice.participants.find((p) => p.isLocal);
    if (!p) return m.spatial_you();
    if (eigeneId) {
      const u = userCache.get(eigeneId);
      if (u) return u.display_name ?? u.username;
    }
    return p.name;
  });

  // Push the layout into the audio engine on mount and on every slider change.
  $effect(() => {
    voice.setSpatialLayout(spreadDeg, distanceM);
    saveLayout({ spreadDeg, distanceM });
  });

  // Distance maps to a comfortable radius band (never on top of the listener).
  function dotStyle(i: number, n: number): string {
    const frac = (distanceM - DIST_MIN) / (DIST_MAX - DIST_MIN);
    const r = RADIUS * (0.4 + 0.6 * frac);
    const rad = (azimuthFor(i, n, spreadDeg) * Math.PI) / 180;
    return `left:${CENTER + r * Math.sin(rad)}px;top:${CENTER - r * Math.cos(rad)}px`;
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
      class="bg-primary text-primary-foreground absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full text-2xs leading-none font-semibold shadow-lg"
      style="left:{CENTER}px;top:{CENTER}px;width:{AVATAR + 8}px;height:{AVATAR + 8}px"
      title={localName}
    >
      <span aria-hidden="true">▲</span>
      {m.spatial_you()}
    </div>

    {#each remotes as p, i (p.identity)}
      {@const uid = p.userId as string}
      {@const name = displayName(uid, p.name)}
      {@const avatar = safeAvatarUrl(userCache.get(uid)?.avatar_url)}
      <div
        class="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5"
        style={dotStyle(i, remotes.length)}
        data-testid="spatial-dot"
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
        <span class="text-text-base max-w-16 truncate text-2xs">{name}</span>
      </div>
    {/each}
  </div>

  <div class="flex w-full flex-col gap-1.5" data-testid="spatial-sliders">
    <label class="flex items-center gap-2 text-2xs">
      <span class="text-text-muted w-14 shrink-0">{m.spatial_spread()}</span>
      <input
        type="range"
        min={SPREAD_MIN}
        max={SPREAD_MAX}
        step="5"
        bind:value={spreadDeg}
        class="accent-primary min-w-0 flex-1"
        data-testid="spatial-slider-spread"
      />
      <span class="text-text-muted w-11 shrink-0 text-right tabular-nums">{Math.round(spreadDeg)}°</span>
    </label>
    <label class="flex items-center gap-2 text-2xs">
      <span class="text-text-muted w-14 shrink-0">{m.spatial_distance()}</span>
      <input
        type="range"
        min={DIST_MIN}
        max={DIST_MAX}
        step="0.1"
        bind:value={distanceM}
        class="accent-primary min-w-0 flex-1"
        data-testid="spatial-slider-distance"
      />
      <span class="text-text-muted w-11 shrink-0 text-right tabular-nums">{distanceM.toFixed(1)} m</span>
    </label>
  </div>
</div>
