<script lang="ts">
  /**
   * Die Bereichs-Leiste am unteren Rand des Handys.
   *
   * Ersetzt die dauerhaft sichtbare `GuildRail`, die auf einem Telefon rund
   * 80 px dauerhaft belegte — auch dann, wenn man nur mit einer Person
   * schreibt. Vier Ziele, jedes eine echte Route: der Navigations-Stack ist
   * die URL, damit die System-Zurück-Geste und die Sprünge aus einer
   * Benachrichtigung ohne Zusatzcode funktionieren.
   *
   * **Sichtbarkeit entscheidet das Layout, nicht diese Komponente** — sie
   * rendert immer, `app/+layout.svelte` blendet sie auf Detail-Bildschirmen
   * aus (`istDetailScreen`). Eine Komponente, die sich selbst versteckt, wäre
   * die zweite Stelle mit derselben Regel.
   *
   * Maße aus dem Design-Canvas: Leiste 60 px hoch, Symbol 23 px, Label
   * 11 px/600. Die Trefferfläche ist über `min-h-12` auf 48 dp gezogen, auch
   * wo das Symbol optisch kleiner wirkt.
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
  class="border-border bg-bg-panel flex h-[60px] shrink-0 items-center justify-around border-t px-1.5 pb-3 pt-0"
  data-testid="mobile-tab-bar"
  aria-label={m.nav_tab_bar_label()}
>
  {#each BEREICHE as bereich (bereich.id)}
    {@const Symbol = SYMBOLE[bereich.id]}
    {@const zahl = zahlFuer(bereich.id)}
    {@const istAktiv = aktiv === bereich.id}
    <a
      href={bereich.href}
      class="flex min-h-12 flex-col items-center gap-[3px] rounded-xl px-3.5 py-1.5 text-2xs font-semibold transition-colors {istAktiv
        ? 'text-primary'
        : 'text-text-muted'}"
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
