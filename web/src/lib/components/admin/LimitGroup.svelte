<!--
  Eine umrahmte Gruppe im Community-Grenzen-Editor: Titel + Erklärung + Inhalt.

  Trägt die Gruppierung visuell: statt eines großen Rahmens mit lauter
  Überschriften bekommt jede Sachgruppe (Qualität, Dateien, Größe) ihre eigene
  Karte, damit sofort klar ist, welches Feld wozu gehört.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    hint,
    children
  }: { title: string; hint: string; children: Snippet } = $props();
</script>

<section class="border-border bg-bg-hover/20 rounded-lg border p-4">
  <h3 class="text-text-bright text-sm font-semibold">{title}</h3>
  <p class="text-text-muted mt-0.5 mb-3 text-xs">{hint}</p>
  {@render children()}
</section>
