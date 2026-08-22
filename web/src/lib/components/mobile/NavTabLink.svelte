<script lang="ts">
  /**
   * Ein Eintrag der Bereichs-Navigation: Symbol, Zahl, Beschriftung.
   *
   * Handy-Leiste und Tablet-Spalte zeigen dieselben vier Bereiche und
   * unterscheiden sich nur in der Anordnung. `darstellung.svelte.ts` hat
   * bereits die DATEN vereint (Symbole, Woerter, Zahlen); das MARKUP stand
   * danach immer noch zweimal da — Abzeichen-Blase, `data-active`,
   * `aria-current` und die 99+-Kappung wortgleich. Genau der Fall, vor dem die
   * Kommentare in beiden Leisten warnen: man sieht nie beide Groessen
   * gleichzeitig, ein Auseinanderlaufen faellt also nicht auf.
   *
   * Was sich wirklich unterscheidet, sind die Klassen des Verweises selbst
   * (waagerecht gegen senkrecht, andere Hervorhebung) — die bringt jede Leiste
   * ueber `class` mit.
   */
  import type { Bereich } from '$lib/navigation/tabs';
  import {
    SYMBOLE,
    beschriftung,
    zahlFuer,
    zahlBeschriftung
  } from '$lib/navigation/darstellung.svelte';

  let {
    bereich,
    istAktiv,
    class: klasse
  }: {
    bereich: Bereich;
    istAktiv: boolean;
    /** Klassen des `<a>` — der einzige echte Unterschied der beiden Leisten. */
    class: string;
  } = $props();

  let Symbol = $derived(SYMBOLE[bereich.id]);
  let zahl = $derived(zahlFuer(bereich.id));
</script>

<a
  href={bereich.href}
  class={klasse}
  data-testid={`tab-${bereich.id}`}
  data-active={istAktiv}
  aria-current={istAktiv ? 'page' : undefined}
>
  <span class="relative flex items-center justify-center">
    <!-- **Der Sonar-Ping.** Die Bildmarke von Pulse ist ein Ping: konzentrische
         Ringe, die von einem Punkt ausgehen (`static/pulse-mark.svg`). Der
         aktive Bereich sitzt deshalb in genau dieser Form statt in einem
         Allerwelts-Pillenhintergrund — sie taucht auf jedem Bildschirm auf und
         macht die Leiste unverwechselbar, ohne laut zu sein.
         Bewusst OHNE Animation: eine dauernd pulsende Navigation wäre nach
         zwei Minuten eine Zumutung. Der Ping steht still; bewegt wird an
         anderer Stelle nur, was wirklich lebt (Anwesenheit). -->
    {#if istAktiv}
      <span class="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span class="border-primary/25 absolute size-[38px] rounded-full border"></span>
        <span class="border-primary/45 absolute size-[30px] rounded-full border"></span>
        <span class="bg-primary/12 absolute size-[30px] rounded-full"></span>
      </span>
    {/if}
    <Symbol class="relative size-[23px]" />
    {#if zahl > 0}
      <span
        class="bg-badge-count absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-extrabold leading-none text-white"
        data-testid={`tab-badge-${bereich.id}`}
        aria-label={zahlBeschriftung(bereich.id, zahl)}
      >{zahl > 99 ? '99+' : zahl}</span>
    {/if}
  </span>
  {beschriftung(bereich.id)}
</a>
