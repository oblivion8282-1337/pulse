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
  const grau = $derived(aufBlase ? 'text-white/55' : 'text-text-muted');
  // Das Blau darf die Zeilenfarbe brechen — es ist genau das Signal (Befund
  // 05.10.). Ausserhalb der Blase im hellen Erscheinungsbild dunkler: das
  // Hellblau lag auf Weiss bei rund 2:1 und war kaum zu sehen.
  const blau = $derived(aufBlase ? 'text-[#7dd3fc]' : 'text-sky-600 dark:text-[#53bdeb]');
</script>

<!-- Entwurf 1a (2026-10-10, gewählt aus vier Varianten im echten Layout). -->
<span
  class="mr-1 inline-flex items-center align-[-1px]"
  title={text}
  data-testid="message-haekchen"
  data-stufe={stufe}
>
  {#if stufe === 'nicht_zugestellt'}
    <!-- So gross wie die Uhr: das frühere 14-px-Zeichen machte die Blase
         höher als ihre Nachbarn. -->
    <CircleAlertIcon class="text-warning size-[11px]" strokeWidth={2.6} aria-label={text} role="img" />
  {:else if stufe === 'uhr'}
    <svg
      viewBox="0 0 12 12"
      class="size-[11px] {grau}"
      aria-label={text}
      role="img"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="6" cy="6" r="4.9" />
      <path d="M6 3.5V6l1.6 1" />
    </svg>
  {:else}
    <!-- Zwei Haken mit gleicher Neigung auf derselben Grundlinie (vorher
         wichen Winkel und Grundlinie des zweiten ab); der kurze Strich des
         zweiten ist gekürzt und setzt am langen Strich des ersten an. -->
    <svg
      viewBox="0 0 17 11"
      class="h-[10px] w-[15.5px] {stufe === 'gelesen' ? blau : grau}"
      aria-label={text}
      role="img"
      fill="none"
      stroke="currentColor"
      stroke-width="1.65"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M1.3 5.8 4.4 8.9 10.6 2.1" />
      {#if stufe !== 'gesendet'}
        <path d="M7.25 7.15 9 8.9 15.2 2.1" />
      {/if}
    </svg>
  {/if}
</span>
