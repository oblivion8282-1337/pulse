<script lang="ts">
  /**
   * Die Bereichs-Spalte am linken Rand des Tablets.
   *
   * Dieselben vier Ziele wie die Handy-Leiste, nur senkrecht: auf einem Tablet
   * ist Platz für Liste **und** Detail nebeneinander, also darf die
   * Navigation nicht den unteren Rand belegen, wo die Liste weitergeht.
   *
   * 78 px breit (Canvas). Zahlen und Ziele kommen aus denselben Modulen wie
   * bei der Handy-Leiste — zwei Rechnungen für dieselben Zahlen liefen
   * unbemerkt auseinander, weil man nie beide Größen gleichzeitig sieht.
   */
  import { page } from '$app/state';
  import { aktiverBereich } from '$lib/navigation/tabs';
  import { bereichsReihenfolge } from '$lib/navigation/darstellung.svelte';
  import NavTabLink from './NavTabLink.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let aktiv = $derived(aktiverBereich(page.url.pathname));
</script>

<!-- Als Karte wie die Nachbar-Spalten (glass-panel: Flaeche + Rand + runde
     Ecken) — vorher nur eine rechte Trennlinie, der Rahmen fehlte zum Teil. -->
<nav
  class="glass-panel flex w-[78px] shrink-0 flex-col items-center gap-1 rounded-2xl pt-[var(--safe-top)]"
  data-testid="tablet-nav-rail"
  aria-label={m.nav_tab_bar_label()}
>
  {#each bereichsReihenfolge() as bereich (bereich.id)}
    {@const istAktiv = aktiv === bereich.id}
    <!-- Beschriftungslos wie die Handy-Leiste: nur Symbol (dafuer groesser),
         der Bereichsname bleibt als sr-only fuer Screenreader erhalten. -->
    <NavTabLink
      {bereich}
      {istAktiv}
      zeigeBeschriftung={false}
      symbolGroesse="size-[30px]"
      class="mt-1 flex min-h-12 w-[66px] items-center justify-center rounded-xl px-1 py-2 transition-colors {istAktiv
        ? 'bg-[var(--accent-soft)] text-accent-on-soft'
        : 'text-text-muted hover:bg-bg-hover'}"
    />
  {/each}
</nav>
