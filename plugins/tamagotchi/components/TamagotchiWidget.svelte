<!--
  Tamagotchi-Widget — "Lebendiges Pet" (v0.3.0).

  Pro Guild ein gemeinsames Pet. Server (mechanics.py) ist Source-of-Truth;
  zwischen den Server-Updates rechnet das Widget den Zeit-Decay lokal weiter
  (Tick alle 30s → sichtbar sinkende Bars) und leitet Tod/Evolution ab.
  Aktions-Klicks zeigen optimistisch den neuen Wert und schicken die WS-Op;
  der ``tamagotchi:state_update``-Broadcast überschreibt mit dem
  authoritativen State. Tot → nur Wiederbeleben (MANAGE_GUILD, Backend-gated).

  Mount macht der Parent (channel/+page.svelte) conditional; das Widget
  vertraut drauf, dass ``guildId`` gesetzt ist.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ensurePetLoaded,
    feed,
    getPetForGuild,
    play,
    reset,
    revive,
    sleep
  } from '../frontend';
  import {
    applyDecay,
    avatarOf,
    isAlive,
    moodEmoji,
    moodOf,
    xpProgress,
    type PetState
  } from '../store';

  let { guildId }: { guildId: string } = $props();

  // Reaktiver "now" für den Live-Decay — alle 30s neu, damit die Bars
  // zwischen Server-Updates sichtbar sinken (kein Server-Roundtrip).
  let nowMs = $state(Date.now());

  const raw = $derived<PetState | null>(getPetForGuild(guildId));
  const pet = $derived<PetState | null>(raw ? applyDecay(raw, nowMs) : null);
  const alive = $derived(raw ? isAlive(raw, nowMs) : true);
  const mood = $derived(pet ? moodOf(pet) : 'zufrieden');
  const avatar = $derived(pet ? avatarOf(pet, alive) : '🥚');
  const xp = $derived(pet ? xpProgress(pet) : { into: 0, span: 1, pct: 0 });

  onMount(() => {
    void ensurePetLoaded(guildId);
    const t = setInterval(() => (nowMs = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  $effect(() => {
    void ensurePetLoaded(guildId);
  });

  function statColor(value: number): string {
    if (value >= 60) return 'bg-emerald-500';
    if (value >= 30) return 'bg-amber-500';
    return 'bg-rose-500';
  }
</script>

<section
  class="border-border bg-bg-input/60 flex shrink-0 flex-col gap-3 rounded-2xl border p-3"
  data-testid="tamagotchi-widget"
>
  {#if !pet}
    <div class="flex items-center gap-2">
      <span class="text-text-muted text-sm" aria-hidden="true">🫥</span>
      <p class="text-text-muted text-xs">Lade Tamagotchi…</p>
    </div>
  {:else}
    <div class="flex items-start gap-3">
      <div
        class="bg-bg-hover flex size-12 shrink-0 items-center justify-center rounded-full text-2xl shadow-inner"
        class:grayscale={!alive}
        aria-hidden="true"
        data-testid="tamagotchi-avatar"
      >
        {avatar}
      </div>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-1.5">
          <span class="text-text-bright truncate text-sm font-semibold" data-testid="tamagotchi-name">
            {pet.name}
          </span>
          <span
            class="bg-bg-hover text-text-muted shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
            data-testid="tamagotchi-level"
          >
            Lv {pet.level}
          </span>
        </div>
        <span class="text-text-muted text-xs lowercase" data-testid="tamagotchi-mood">
          {#if alive}<span aria-hidden="true">{moodEmoji(mood)}</span> {mood}{:else}gestorben{/if}
        </span>
        <!-- XP-Bar -->
        <div
          class="bg-bg-hover mt-1 h-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-label="Erfahrung"
          aria-valuenow={Math.round(xp.pct)}
          aria-valuemin="0"
          aria-valuemax="100"
          data-testid="tamagotchi-xp"
        >
          <div class="h-full rounded-full bg-violet-500 transition-all" style="width: {xp.pct}%"></div>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      {#each [
        { label: 'Hunger', value: pet.hunger, testid: 'hunger' },
        { label: 'Glück', value: pet.happiness, testid: 'happiness' },
        { label: 'Energie', value: pet.energy, testid: 'energy' }
      ] as bar (bar.label)}
        <div class="flex items-center gap-2">
          <span class="text-text-muted w-14 text-xs">{bar.label}</span>
          <div
            class="bg-bg-hover h-1.5 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label={bar.label}
            aria-valuenow={Math.round(bar.value)}
            aria-valuemin="0"
            aria-valuemax="100"
            data-testid="tamagotchi-bar-{bar.testid}"
          >
            <div
              class="{statColor(bar.value)} h-full rounded-full transition-all"
              style="width: {Math.round(bar.value)}%"
            ></div>
          </div>
          <span class="text-text-muted w-8 text-right text-xs tabular-nums">
            {Math.round(bar.value)}
          </span>
        </div>
      {/each}
    </div>

    {#if alive}
      <div class="flex gap-1">
        <button
          type="button"
          onclick={() => feed(guildId)}
          class="hover:bg-bg-hover text-text-bright flex flex-1 flex-col items-center gap-0.5 rounded-lg p-1.5 text-xs transition-colors"
          title="Füttern"
          data-testid="tamagotchi-feed"
        >
          <span class="text-base leading-none" aria-hidden="true">🍎</span>
          <span>Futter</span>
        </button>
        <button
          type="button"
          onclick={() => play(guildId)}
          class="hover:bg-bg-hover text-text-bright flex flex-1 flex-col items-center gap-0.5 rounded-lg p-1.5 text-xs transition-colors"
          title="Spielen"
          data-testid="tamagotchi-play"
        >
          <span class="text-base leading-none" aria-hidden="true">🎾</span>
          <span>Spiel</span>
        </button>
        <button
          type="button"
          onclick={() => sleep(guildId)}
          class="hover:bg-bg-hover text-text-bright flex flex-1 flex-col items-center gap-0.5 rounded-lg p-1.5 text-xs transition-colors"
          title="Schlafen"
          data-testid="tamagotchi-sleep"
        >
          <span class="text-base leading-none" aria-hidden="true">💤</span>
          <span>Schlaf</span>
        </button>
        <button
          type="button"
          onclick={() => reset(guildId)}
          class="hover:bg-bg-hover text-text-muted hover:text-rose-400 flex shrink-0 items-center justify-center rounded-lg p-1.5 text-base leading-none transition-colors"
          title="Reset (nur Admins)"
          data-testid="tamagotchi-reset"
          aria-label="Tamagotchi zurücksetzen"
        >↺</button>
      </div>
    {:else}
      <div class="flex flex-col gap-1.5">
        <p class="text-text-muted text-[11px] italic">
          {pet.name} ist verhungert. Ein Admin kann es wiederbeleben.
        </p>
        <button
          type="button"
          onclick={() => revive(guildId)}
          class="bg-bg-hover hover:text-emerald-400 text-text-bright flex items-center justify-center gap-1.5 rounded-lg p-2 text-xs font-medium transition-colors"
          title="Wiederbeleben (nur Admins)"
          data-testid="tamagotchi-revive"
        >
          <span class="text-base leading-none" aria-hidden="true">✨</span>
          <span>Wiederbeleben</span>
        </button>
      </div>
    {/if}
  {/if}
</section>
