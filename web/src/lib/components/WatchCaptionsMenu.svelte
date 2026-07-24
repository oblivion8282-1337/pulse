<!--
  WatchCaptionsMenu — Untertitel-Auswahl für den read-only Zuschauer-Player.

  Der Zuschauer bekommt `controls: 0` (nur der Host steuert die Wiedergabe) und
  verliert damit auch YouTubes CC-Knopf. Startzustand der Untertitel ist die
  YouTube-/Browser-Präferenz des Zuschauers — wer sie anhat, sass bis hierhin in
  der Falle. Dieses Menü ist der Ausweg: „Aus" plus jede angebotene Sprache.

  Rein lokal, bewusst NICHT synchronisiert — Untertitel sind eine persönliche
  Entscheidung, keine Eigenschaft der Party (anders als Play/Pause/Position).

  Der Aufrufer rendert das Menü nur, wenn es überhaupt Spuren gibt; ein Video
  ohne Untertitel zeigt keinen toten Knopf. Aufgeteilt aus WatchPartyTile, um
  dessen Größen-Cap zu halten (wie WatchPartyHandoffMenu).
-->
<script lang="ts">
  import CaptionsIcon from '@lucide/svelte/icons/captions';
  import CaptionsOffIcon from '@lucide/svelte/icons/captions-off';
  import { m } from '$lib/paraglide/messages.js';
  import type { CaptionTrack } from '$lib/watch/sync';

  interface Props {
    tracks: CaptionTrack[];
    /** Sprachcode der aktiven Spur, null wenn aus. */
    active: string | null;
    onSelect: (languageCode: string | null) => void;
  }
  let { tracks, active, onSelect }: Props = $props();

  let open = $state(false);

  function select(languageCode: string | null): void {
    onSelect(languageCode);
    open = false;
  }
</script>

<div class="relative">
  <button
    type="button"
    onclick={() => (open = !open)}
    class="flex items-center justify-center rounded-full p-3 backdrop-blur-sm md:p-1.5 {active
      ? 'bg-primary text-primary-foreground hover:bg-primary/80'
      : 'bg-black/55 text-white hover:bg-black/75'}"
    aria-label={m.watch_party_tile_captions_aria()}
    title={m.watch_party_tile_captions_aria()}
    aria-pressed={!!active}
    data-testid="watch-party-captions"
  >
    {#if active}
      <CaptionsIcon class="size-5 md:size-3.5" />
    {:else}
      <CaptionsOffIcon class="size-5 md:size-3.5" />
    {/if}
  </button>
  {#if open}
    <!-- z-30 ist Pflicht, nicht Kosmetik: das Menü klappt nach OBEN über die
         Videofläche, und dort liegt der Klick-Fänger des Zuschauers
         (`watch-party-viewer-lock`, z-10). Ohne eigenen z-index läge das Menü
         darunter — es wäre sichtbar, aber jeder Klick landete im Fänger. -->
    <div
      class="absolute right-0 bottom-full z-30 mb-2 max-h-64 min-w-44 overflow-y-auto rounded-xl bg-black/90 p-1 text-sm text-white shadow-lg backdrop-blur-sm"
      data-testid="watch-party-captions-menu"
    >
      <button
        type="button"
        class="block w-full rounded px-3 py-2 text-left hover:bg-white/10 {active
          ? ''
          : 'bg-white/10'}"
        onclick={() => select(null)}
        data-testid="watch-party-captions-off"
      >
        {m.watch_party_tile_captions_off()}
      </button>
      {#each tracks as track (track.languageCode)}
        <button
          type="button"
          class="block w-full truncate rounded px-3 py-2 text-left hover:bg-white/10 {active ===
          track.languageCode
            ? 'bg-white/10'
            : ''}"
          onclick={() => select(track.languageCode)}
        >
          {track.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
