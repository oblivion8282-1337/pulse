<script lang="ts">
  /**
   * Die Kopfzeile eines Bereichs: grosser Titel links, höchstens eine
   * Handlung rechts.
   *
   * **Warum das ein eigener Baustein ist:** die vier Bereiche hatten drei
   * verschiedene Kopfzeilen — Chats und Räume je einen 22-px-Titel mit
   * eigenen Abständen, Freunde einen 16-px-Titel mit Trennlinie, Entdecken
   * eine Leiste im Stil der Detail-Screens. Vier Bildschirme derselben App,
   * die sich oben unterschiedlich anfühlen, lesen sich als unfertig, noch
   * bevor man den Inhalt anschaut. Das hier ist die eine Fassung.
   *
   * Höhe und Schrift folgen dem Entwurf (22 px/800, `padding 14px 16px 8px`).
   * Die Handlung rechts ist optional und trägt IMMER ein Wort — ein blosses
   * Symbol in einer Kopfzeile ist ein Rätsel, das jeder Nutzer einmal lösen
   * muss.
   */
  import type { Snippet } from 'svelte';

  let {
    titel,
    handlung
  }: {
    titel: string;
    /** Rechte Seite: ein Verweis oder Knopf mit Symbol UND Wort. */
    handlung?: Snippet;
  } = $props();
</script>

<!-- Titel mit `min-h-12 flex items-center`: Der Text sitzt damit auf JEDER
     Bereichs-Seite gleich hoch — auch wenn die Seite (wie Räume → Entdecken)
     eine Handlung mit 48px-Trefferfläche rechts trägt. Ohne die feste Höhe
     zentriert der Header den Titel nur DANN mittig, wenn eine hohe Handlung
     daneben steht; ohne Handlung klebte er gut 10px höher (gemessen: Chats
     15px vs. Räume 25px). Die 48px-Box um den Text gleicht das aus. -->
<header
  class="text-text-bright flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-3.5"
  data-testid="bereichs-kopf"
>
  <h1
    class="text-text-bright flex min-h-12 min-w-0 items-center truncate text-[22px] font-extrabold leading-tight tracking-[-0.02em]"
  >{titel}</h1>
  {#if handlung}
    <div class="shrink-0">{@render handlung()}</div>
  {/if}
</header>
