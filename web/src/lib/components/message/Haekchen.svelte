<script lang="ts">
  /**
   * Die Häkchen-Treppe an einer eigenen Nachricht (WhatsApp-Semantik):
   * Uhr → ein grauer Haken → zwei graue → zwei blaue, dazu ein Warnzeichen
   * für „nicht zugestellt". Welche Stufe gilt, rechnet
   * `nachrichten/haekchen.ts` — hier nur das Bild.
   *
   * EINE Komponente für beide Hüllen (Sprechblase und Zeile); vorher stand
   * dasselbe SVG zweimal abgeschrieben da, und alle Stufen trugen dieselbe
   * Beschriftung „Zugestellt" — ein Screenreader konnte sie nicht
   * unterscheiden. `title` macht die Bedeutung auch beim Überfahren lesbar.
   */
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
  import type { HaekchenStufe } from '$lib/nachrichten/haekchen';
  import { m } from '$lib/paraglide/messages.js';

  let {
    stufe,
    /** Auf der eigenen (blauen) Sprechblase: gedämpftes Weiss statt Grau. */
    aufBlase = false
  }: { stufe: HaekchenStufe; aufBlase?: boolean } = $props();

  const BESCHRIFTUNG: Record<HaekchenStufe, () => string> = {
    uhr: m.message_haekchen_uhr,
    gesendet: m.message_haekchen_gesendet,
    zugestellt: m.message_haekchen_zugestellt,
    gelesen: m.message_haekchen_gelesen,
    nicht_zugestellt: m.message_haekchen_nicht_zugestellt
  };
  const text = $derived(BESCHRIFTUNG[stufe]());
  const grau = $derived(aufBlase ? 'opacity-70' : 'text-text-muted opacity-70');
</script>

<span class="mr-1 inline-flex align-baseline" title={text} data-testid="message-haekchen" data-stufe={stufe}>
  {#if stufe === 'nicht_zugestellt'}
    <CircleAlertIcon class="text-warning size-3.5" aria-label={text} role="img" />
  {:else if stufe === 'uhr'}
    <svg viewBox="0 0 12 12" class="size-3 {grau}" aria-label={text} role="img">
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M6 3.4v2.8l1.9 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  {:else}
    <!-- Das Blau darf die Zeilenfarbe brechen — es ist genau das Signal
         (Befund 05.10.). -->
    <svg
      viewBox="0 0 18 12"
      class="size-3.5 {stufe === 'gelesen' ? 'text-[#53bdeb]' : grau}"
      aria-label={text}
      role="img"
    >
      <path
        d="M1 6.5 4.5 10 10.5 3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      {#if stufe !== 'gesendet'}
        <path
          d="M6.9 9 8 10.3 15.4 2.8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      {/if}
    </svg>
  {/if}
</span>
