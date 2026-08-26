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
   * Maße aus dem Design-Canvas: Leiste 60 px, Symbol 23 px (mittlerweile
   * beschriftungslos 26 px — die Wörter tragen nur noch die Tablet-Spalte,
   * auf dem Handy liest ein sr-only-Text sie vor). Die Trefferfläche ist
   * über `min-h-12` auf 48 dp gezogen, auch wo das Symbol optisch
   * kleiner wirkt.
   */
  import { page } from '$app/state';
  import { aktiverBereich } from '$lib/navigation/tabs';
  import { bereichsReihenfolge } from '$lib/navigation/darstellung.svelte';
  import NavTabLink from './NavTabLink.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { letzterRaumPfad } from '$lib/navigation/letzterRaumBereich.svelte';

  let aktiv = $derived(aktiverBereich(page.url.pathname));

  // Räume-Tab-Rückkehrziel: der ZULETZT angezeigte Bildschirm im Räume-
  // Bereich — jede Ebene (Sprachkanal, Chat, Raum-Ansicht, Übersicht),
  // gemerkt bei jeder Navigation innerhalb des Bereichs. Frischer App-
  // Start ohne Gedächtnis → Übersicht.
  let raeumeZiel = $derived(letzterRaumPfad() ?? undefined);
</script>

<!-- Karten-Behandlung wie auf der Login-Seite (AppDownloadLinks-Rezept):
     bg-card/85 + feiner Rand rundum + Schatten + Blur, als schwebende Karte
     mit seitlichem Abstand über dem Marine-Grund statt randloser Balken mit
     oberer Trennlinie. -->
<!-- Gleiche Karten-Behandlung wie der Profilblock der Du-Seite
     (bg-bg-input + border-border + rounded-[14px], ohne Schatten) — die
     Leiste soll exakt wie diese Flächen aussehen. Schwebt mit seitlichem
     Abstand über dem Seitengrund (mx-2 mb-2). -->
<nav
  class="border-border bg-bg-input mx-2 mb-2 flex h-[72px] shrink-0 items-center justify-around rounded-[14px] border px-1.5 card-shadow"
  data-testid="mobile-tab-bar"
  aria-label={m.nav_tab_bar_label()}
>
  {#each bereichsReihenfolge() as bereich (bereich.id)}
    {@const istAktiv = aktiv === bereich.id}
    <NavTabLink
      {bereich}
      {istAktiv}
      ziel={bereich.id === 'rooms' ? raeumeZiel : undefined}
      zeigeBeschriftung={false}
      class="flex min-h-12 flex-1 items-center justify-center rounded-xl py-1.5 transition-colors {istAktiv
        ? 'text-primary'
        : 'text-text-muted'}"
    />
  {/each}
</nav>
