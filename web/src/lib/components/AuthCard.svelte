<!--
  AuthCard — gemeinsame Außenhülle der Auth-Seiten (Forgot/Reset/Register/
  Verify): Vollbild-Zeile mit AuthBrandPanel links und der zentrierten
  Formular-Karte rechts (auf Mobil volle Breite, ab md fixe 46 %).
  Die Karte selbst bleibt bei der Seite (sie unterscheidet sich je Fluss);
  `children` ist der Karten-Inhalt, alle übrigen Props reichen 1:1 an
  AuthBrandPanel durch.

  Die Login-Seite nutzt die Komponente bewusst NICHT: ihre Außenhülle trägt
  das seitenweite Cursor-Radar (`use:cursorTrack` + cursor-none), das sich
  nicht als Prop durchreichen lässt.
-->
<script lang="ts">
  import AuthBrandPanel from '$lib/components/AuthBrandPanel.svelte';
  import type { Snippet } from 'svelte';

  let {
    children,
    outerClass = '',
    headline,
    headlineSub,
    headlineAccent,
    description,
    features,
    rotatingPrefix,
    rotatingWords
  }: {
    children: Snippet;
    /** Zusatz-Klassen für die äußere Zeile (z. B. `relative`). */
    outerClass?: string;
    headline: string;
    headlineSub?: string;
    headlineAccent?: string;
    description: string;
    features: string[];
    rotatingPrefix?: string;
    rotatingWords?: string[];
  } = $props();
</script>

<div class="flex min-h-dvh {outerClass}">
  <AuthBrandPanel
    {headline}
    {headlineSub}
    {headlineAccent}
    {description}
    {features}
    {rotatingPrefix}
    {rotatingWords}
  />

  <!-- Formular-Pane: auf Mobil volle Breite + zentriert; ab md: fixe 46 % -->
  <div class="flex flex-1 items-center justify-center p-4 md:flex-none md:basis-[46%]">
    {@render children()}
  </div>
</div>
