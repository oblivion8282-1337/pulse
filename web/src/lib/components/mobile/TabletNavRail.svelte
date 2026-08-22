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
  import { BEREICHE, aktiverBereich } from '$lib/navigation/tabs';
  import {
    SYMBOLE,
    beschriftung,
    zahlFuer,
    zahlBeschriftung
  } from '$lib/navigation/darstellung.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let aktiv = $derived(aktiverBereich(page.url.pathname));
</script>

<nav
  class="border-border bg-bg-panel flex w-[78px] shrink-0 flex-col items-center gap-1 border-r pt-[var(--safe-top)]"
  data-testid="tablet-nav-rail"
  aria-label={m.nav_tab_bar_label()}
>
  {#each BEREICHE as bereich (bereich.id)}
    {@const Symbol = SYMBOLE[bereich.id]}
    {@const zahl = zahlFuer(bereich.id)}
    {@const istAktiv = aktiv === bereich.id}
    <a
      href={bereich.href}
      class="mt-1 flex min-h-12 w-[66px] flex-col items-center gap-[3px] rounded-xl px-1 py-2 text-2xs font-semibold transition-colors {istAktiv
        ? 'bg-[var(--accent-soft)] text-primary'
        : 'text-text-muted hover:bg-bg-hover'}"
      data-testid={`tab-${bereich.id}`}
      data-active={istAktiv}
      aria-current={istAktiv ? 'page' : undefined}
    >
      <span class="relative">
        <Symbol class="size-[23px]" />
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
  {/each}
</nav>
