<!--
  Tamagotchi-Widget (Pulse Plugin-System PR3 "Server-shared Pet").

  Pro Guild gibt es **ein** Pet, das alle Mitglieder gemeinsam füttern.
  Beim Mount fetchen wir den Server-State; danach kommen Live-Updates
  via WS-Handler in `frontend.ts`. Action-Klicks zeigen optimistisch
  den neuen Wert und schicken die WS-Op; der Server-Broadcast
  überschreibt mit dem authoritativen State.

  Wird nur eingebunden, wenn das Plugin für die aktuelle Guild
  aktiviert ist (Pro-Guild-Toggle, MANAGE_GUILD-Admin). Das konditionale
  Mount macht der Parent (s. channel/+page.svelte) — das Widget vertraut
  drauf, dass `guildId` immer gesetzt ist.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ensurePetLoaded,
    feed,
    getPetForGuild,
    play,
    reset,
    sleep
  } from '../frontend';
  import { emojiOf, moodOf, type PetState } from '../store';

  let { guildId }: { guildId: string } = $props();

  // Reaktiv: bei jedem Wechsel von guildId oder State-Update läuft das
  // neu. `getPetForGuild` ist eine Funktion, aber sie liest den
  // ``$state``-Store unter der Haube → Svelte 5 trackt das.
  const pet = $derived<PetState | null>(getPetForGuild(guildId));
  const mood = $derived(pet ? moodOf(pet) : 'zufrieden');
  const emoji = $derived(emojiOf(mood));

  onMount(() => {
    void ensurePetLoaded(guildId);
  });

  // Wenn guildId mid-flight wechselt (z.B. User wechselt Server),
  // lade auch das neue Pet — der `$derived` würde sonst beim ersten
  // Render `null` zeigen, bis ein anderes Event den Fetch triggert.
  $effect(() => {
    void ensurePetLoaded(guildId);
  });

  function statColor(value: number, kind: 'good' | 'bad'): string {
    // "bad" = niedriger Wert ist schlecht. PR3: HOHER Hunger-Wert = satt
    // (Backend-Schema: hunger 100 = satt, 0 = am Verhungern), also gilt
    // für alle drei Stats: HOHER Wert = gut.
    const normalized = kind === 'bad' ? 100 - value : value;
    if (normalized >= 60) return 'bg-emerald-500';
    if (normalized >= 30) return 'bg-amber-500';
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
        aria-hidden="true"
      >
        {emoji}
      </div>
      <div class="flex min-w-0 flex-1 flex-col">
        <span
          class="text-text-bright truncate text-sm font-semibold"
          data-testid="tamagotchi-name"
        >
          {pet.name}
        </span>
        <span class="text-text-muted text-xs lowercase" data-testid="tamagotchi-mood">
          {mood}
        </span>
        <span class="text-text-muted text-[10px] italic">
          Server-Pet — alle Mitglieder können füttern
        </span>
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      {#each [
        { label: 'Hunger', value: pet.hunger, kind: 'good' as const, testid: 'hunger' },
        { label: 'Glück', value: pet.happiness, kind: 'good' as const, testid: 'happiness' },
        { label: 'Energie', value: pet.energy, kind: 'good' as const, testid: 'energy' }
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
              class="{statColor(bar.value, bar.kind)} h-full rounded-full transition-all"
              style="width: {Math.round(bar.value)}%"
            ></div>
          </div>
          <span class="text-text-muted w-8 text-right text-xs tabular-nums">
            {Math.round(bar.value)}
          </span>
        </div>
      {/each}
    </div>

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
        title="Reset"
        data-testid="tamagotchi-reset"
        aria-label="Tamagotchi zurücksetzen"
      >↺</button>
    </div>
  {/if}
</section>
