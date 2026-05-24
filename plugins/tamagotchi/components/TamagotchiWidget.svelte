<!--
  Tamagotchi-Widget (Pulse Plugin-System Schritt 7).

  Kleines Card-UI das die drei Stats (Hunger/Glück/Energie) reaktiv anzeigt
  und Aktionen (Füttern/Spielen/Schlafen/Reset) anbietet. Stats werden
  jedes Mal mit `applyDecay()` durchgereicht, *bevor* sie gerendert
  werden — kein `setInterval` und kein Hintergrund-Tick: ein Reactive-
  Effekt re-running, wenn der User die Karte ansieht und z.B. eine Aktion
  klickt, reicht für ein Schauf­enster-Tamagotchi.

  Persistierung läuft komplett über die Settings-Section
  (`registerSettingsSection('tamagotchi', …)` in `frontend.ts`).

  Wird heute nur eingebunden, wenn das Plugin aktiviert ist; das
  konditionale Mount macht der Sidebar-Footer (siehe
  `web/src/lib/components/SidebarFooter.svelte`).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    feed,
    play,
    refreshDecay,
    rename,
    reset,
    sleep,
    getPetStore
  } from '../frontend';
  import { applyDecay, emojiOf, moodOf, type PetState } from '../store';
  // Bewusst keine Lucide-Imports: das Plugin lebt unter `plugins/` und ist
  // kein pnpm-Workspace-Member — es kann nicht auf `web/node_modules` zugreifen.
  // Plugin-Autoren *könnten* eigene Deps mitbringen (eigene package.json +
  // bundling-step), aber für Schritt 7 reicht's mit Emoji-Glyphen. Die
  // Pulse-Tonalität (Dark-Themed, leicht verspielt) trägt Emojis sowieso gut.

  // Section-Store lazy resolven — falls das Plugin nicht aktiviert ist,
  // ist `getPetStore()` null und wir rendern einen Hint-Block.
  const store = $derived(getPetStore());

  // Live-Decay: bei jedem Re-Render holen wir den aktuellen Decay-Snapshot
  // (pure Funktion, billig). Das *persistiert* den Decay nicht — das
  // erledigen die Action-Buttons + ein einmaliger `refreshDecay()` beim
  // Mount, damit der gespeicherte State nicht zu weit hinterherhinkt.
  const pet = $derived<PetState | null>(
    store ? applyDecay(store.value) : null
  );

  const mood = $derived(pet ? moodOf(pet) : 'zufrieden');
  const emoji = $derived(emojiOf(mood));

  let editingName = $state(false);
  let nameDraft = $state('');

  onMount(() => {
    refreshDecay();
  });

  function startRename() {
    if (!pet) return;
    nameDraft = pet.name;
    editingName = true;
  }

  function commitRename() {
    rename(nameDraft);
    editingName = false;
  }

  function cancelRename() {
    editingName = false;
  }

  function statColor(value: number, kind: 'good' | 'bad'): string {
    // "bad" = hoher Wert ist schlecht (Hunger). "good" = hoher Wert ist gut.
    const normalized = kind === 'bad' ? 100 - value : value;
    if (normalized >= 60) return 'bg-emerald-500';
    if (normalized >= 30) return 'bg-amber-500';
    return 'bg-rose-500';
  }
</script>

<section
  class="border-border bg-bg-input/60 m-2 flex shrink-0 flex-col gap-3 rounded-2xl border p-3"
  data-testid="tamagotchi-widget"
>
  {#if !pet || !store}
    <div class="flex items-center gap-2">
      <span class="text-text-muted text-sm" aria-hidden="true">🫥</span>
      <p class="text-text-muted text-xs">
        Tamagotchi-Plugin nicht aktiviert.
      </p>
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
        {#if editingName}
          <form
            class="flex items-center gap-1"
            onsubmit={(e) => {
              e.preventDefault();
              commitRename();
            }}
          >
            <input
              type="text"
              bind:value={nameDraft}
              maxlength="32"
              class="bg-bg-base text-text-bright min-w-0 flex-1 rounded-md border border-border px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="tamagotchi-name-input"
            />
            <button
              type="submit"
              class="hover:bg-bg-hover rounded-md p-1 text-sm leading-none text-emerald-500"
              aria-label="Namen speichern"
            >✓</button>
            <button
              type="button"
              onclick={cancelRename}
              class="hover:bg-bg-hover rounded-md p-1 text-sm leading-none text-rose-400"
              aria-label="Abbrechen"
            >✕</button>
          </form>
        {:else}
          <div class="flex min-w-0 items-center gap-1.5">
            <span
              class="text-text-bright truncate text-sm font-semibold"
              data-testid="tamagotchi-name"
            >
              {pet.name}
            </span>
            <button
              type="button"
              onclick={startRename}
              class="hover:bg-bg-hover text-text-muted hover:text-text-bright shrink-0 rounded-md px-1 text-xs leading-none"
              aria-label="Umbenennen"
            >✎</button>
          </div>
        {/if}
        <span class="text-text-muted text-xs lowercase" data-testid="tamagotchi-mood">
          {mood}
        </span>
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      {#each [
        { label: 'Hunger', value: pet.hunger, kind: 'bad' as const, testid: 'hunger' },
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
        onclick={feed}
        class="hover:bg-bg-hover text-text-bright flex flex-1 flex-col items-center gap-0.5 rounded-lg p-1.5 text-xs transition-colors"
        title="Füttern"
        data-testid="tamagotchi-feed"
      >
        <span class="text-base leading-none" aria-hidden="true">🍎</span>
        <span>Futter</span>
      </button>
      <button
        type="button"
        onclick={play}
        class="hover:bg-bg-hover text-text-bright flex flex-1 flex-col items-center gap-0.5 rounded-lg p-1.5 text-xs transition-colors"
        title="Spielen"
        data-testid="tamagotchi-play"
      >
        <span class="text-base leading-none" aria-hidden="true">🎾</span>
        <span>Spiel</span>
      </button>
      <button
        type="button"
        onclick={sleep}
        class="hover:bg-bg-hover text-text-bright flex flex-1 flex-col items-center gap-0.5 rounded-lg p-1.5 text-xs transition-colors"
        title="Schlafen"
        data-testid="tamagotchi-sleep"
      >
        <span class="text-base leading-none" aria-hidden="true">💤</span>
        <span>Schlaf</span>
      </button>
      <button
        type="button"
        onclick={reset}
        class="hover:bg-bg-hover text-text-muted hover:text-rose-400 flex shrink-0 items-center justify-center rounded-lg p-1.5 text-base leading-none transition-colors"
        title="Reset"
        data-testid="tamagotchi-reset"
        aria-label="Tamagotchi zurücksetzen"
      >↺</button>
    </div>
  {/if}
</section>
