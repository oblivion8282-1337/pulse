<!--
  VoiceParticipantStrip — die Teilnehmer-Zeile unter dem Stream-Grid.

  Eine Reihe, die NICHT umbricht: bei vielen Leuten wird waagerecht gescrollt
  statt in mehrere Reihen zu stapeln. Der Grund ist Höhe — eine Kachel ist rund
  150 px hoch (VoiceParticipantTile: py-5 + 80-px-Avatar + Namenszeile), jede
  Umbruch-Reihe kostete dem Video also noch einmal so viel. Wer hinten steht,
  ist trotzdem auffindbar: dieselben Leute stehen links in der Kanalliste.

  Der Pfeil klappt die Zeile zu und sitzt AUSSERHALB des scrollenden Bereichs —
  mitscrollend wäre er weg, sobald man nach rechts wischt. Zugeklappt bleibt die
  Zeile als schmaler Streifen stehen: sie trägt den Pfeil (der sonst mit dem
  verschwände, was er ausblendet) und nennt weiter die Teilnehmerzahl.
-->
<script lang="ts">
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
  import { m } from '$lib/paraglide/messages.js';
  import type { Channel } from '$lib/api/types';

  let { channel }: { channel: Channel } = $props();

  let collapsed = $derived(settings.appearance.streamParticipantsCollapsed);
  let toggleLabel = $derived(
    collapsed
      ? m.stream_grid_participants_expand_aria()
      : m.stream_grid_participants_collapse_aria()
  );

  // `justify-center-safe` statt `justify-center`: die Kacheln stehen mittig,
  // solange sie passen, und rücken erst bei Überlauf nach links. Ein blankes
  // `center` würde bei Überlauf nach BEIDEN Seiten überquellen — die vordersten
  // Kacheln wären dann unerreichbar, weil sich nicht ins Negative scrollen lässt.
  //
  // Blenden an den Rändern zeigen an, dass die Reihe weitergeht. Sie erscheinen
  // NUR, wenn in die jeweilige Richtung wirklich etwas liegt — sonst wäre der
  // ruhige Fall (alle passen rein) unnötig unruhig.
  let stripEl = $state<HTMLDivElement | null>(null);
  let fadeLeft = $state(false);
  let fadeRight = $state(false);

  function measure(): void {
    const el = stripEl;
    if (!el) {
      fadeLeft = fadeRight = false;
      return;
    }
    // 1 px Toleranz: `scrollLeft` ist bei Zoom/HiDPI gebrochen, ein exakter
    // Vergleich ließe die rechte Blende am Ende stehen.
    fadeLeft = el.scrollLeft > 1;
    fadeRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
  }

  // Fensterbreite: ein ResizeObserver auf der Zeile fängt jedes Verkleinern des
  // Fensters mit ab — sobald es zu eng wird, taucht die rechte Blende auf.
  $effect(() => {
    const el = stripEl;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Teilnehmerzahl / Zuklappen ändern den Inhalt, nicht die Elementgröße — der
  // ResizeObserver sieht das nicht. Svelte flusht das DOM vor diesem Effect,
  // also reicht ein direkter Aufruf (kein rAF nötig).
  $effect(() => {
    void voice.participants.length;
    void collapsed;
    measure();
  });
</script>

{#snippet edgeFade(side: 'left' | 'right', visible: boolean)}
  <span
    class="pointer-events-none absolute inset-y-0 {side === 'left'
      ? 'left-0'
      : 'right-0'} w-11 transition-opacity duration-200 {visible ? 'opacity-100' : 'opacity-0'}"
    style="background: linear-gradient(to {side === 'left'
      ? 'right'
      : 'left'}, var(--panel-solid) 15%, transparent)"
    aria-hidden="true"
  ></span>
{/snippet}

<div class="flex shrink-0 items-center gap-1 px-1" data-testid="voice-participants-row">
  <div class="relative min-w-0 flex-1">
    <div
      bind:this={stripEl}
      onscroll={measure}
      class="flex flex-nowrap items-center gap-3 overflow-x-auto overflow-y-hidden py-1 {collapsed
        ? 'justify-start'
        : 'justify-center-safe'}"
      data-testid="voice-participants"
    >
      {#if collapsed}
        <span class="text-text-faint text-xs" data-testid="voice-participants-hint">
          {m.stream_grid_participants_collapsed_hint({ count: voice.participants.length })}
        </span>
      {:else}
        {#each voice.participants as p (p.identity)}
          <VoiceParticipantTile {p} channelId={channel.id} guildId={channel.guild_id} />
        {/each}
      {/if}
    </div>

    <!-- Panel-Farbe läuft aus. `pointer-events-none`, damit die Blenden keine
         Klicks auf die darunter liegenden Kacheln abfangen. -->
    {@render edgeFade('left', fadeLeft)}
    {@render edgeFade('right', fadeRight)}
  </div>

  <Button
    variant="ghost"
    size="icon"
    class="shrink-0"
    onclick={() => settings.setStreamParticipantsCollapsed(!collapsed)}
    aria-expanded={!collapsed}
    aria-label={toggleLabel}
    title={toggleLabel}
    data-testid="voice-participants-toggle"
  >
    {#if collapsed}
      <ChevronUpIcon class="text-text-muted size-4" />
    {:else}
      <ChevronDownIcon class="text-text-muted size-4" />
    {/if}
  </Button>
</div>
