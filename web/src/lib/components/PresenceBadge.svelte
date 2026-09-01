<!--
  PresenceBadge — die weiche LIVE/PARTY/CAM-Pille (Rand + farbiger Punkt),
  wie sie Freundesliste, Member-Liste, Voice-Tooltip und Voice-Kanalköpfe
  zeigen. Solide Füllungen bleiben dem Video-Tile vorbehalten, wo sie gegen
  das Bild halten müssen.

  Mit `onclick` wird die Pille zum eigenen Klickziel (`role="button"`, Enter/
  Space-Bedienung, Hover-Helligkeit, `stopPropagation` — sie hängt meist in
  einem größeren Klickziel). Ohne `onclick` ist sie rein statisch.
-->
<script lang="ts">
  let {
    kind,
    label,
    title,
    ariaLabel,
    testid,
    onclick
  }: {
    kind: 'live' | 'party' | 'cam';
    label: string;
    title?: string;
    ariaLabel?: string;
    testid?: string;
    onclick?: (e: MouseEvent | KeyboardEvent) => void;
  } = $props();

  // Farbwelt je Art — Pillen-Rahmen/-Fläche/-Text und der Punkt in voller Farbe.
  const STILE = {
    live: {
      pille: 'border-red-500/30 bg-red-500/10 text-red-400',
      punkt: 'bg-red-400',
      hover: 'hover:bg-red-500/20'
    },
    party: {
      pille: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      punkt: 'bg-amber-400',
      hover: 'hover:bg-amber-500/20'
    },
    cam: {
      pille: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
      punkt: 'bg-cyan-400',
      hover: 'hover:bg-cyan-500/20'
    }
  } as const;

  const stil = $derived(STILE[kind]);
  const klasse = $derived(
    `inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs font-bold uppercase
         ${stil.pille}${onclick ? ` cursor-pointer ${stil.hover}` : ''}`
  );
</script>

{#snippet inhalt()}
  <span class="size-1.5 rounded-full {stil.punkt}"></span>{label}
{/snippet}

{#if onclick}
  <!-- role=button statt <button>: die Pille hängt meist in einem größeren
       Klickziel, ein Knopf im Knopf wäre ungültiges HTML. -->
  <span
    role="button"
    tabindex="0"
    class={klasse}
    data-testid={testid}
    {title}
    aria-label={ariaLabel}
    onclick={(e) => {
      e.stopPropagation();
      onclick(e);
    }}
    onkeydown={(e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      onclick(e);
    }}
  >{@render inhalt()}</span
>
{:else}
  <span class={klasse} data-testid={testid} {title} aria-label={ariaLabel}>
    {@render inhalt()}
  </span>
{/if}
