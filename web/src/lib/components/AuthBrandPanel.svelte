<script lang="ts">
  import { onMount } from 'svelte';
  import CheckIcon from '@lucide/svelte/icons/check';
  import CursorRadar from './CursorRadar.svelte';
  import { cursorTrack } from '$lib/actions/cursor-track';

  interface Props {
    headline: string;
    headlineSub?: string;
    description: string;
    features: string[];
    /** Eigenen Verlaufs-Hintergrund weglassen (transparent) — für Seiten, die
     *  einen durchgehenden Full-Bleed-Verlauf hinter das ganze Layout legen,
     *  damit an der Panel-Grenze keine Naht aus zwei Verläufen entsteht. */
    bareBg?: boolean;
    /** Cursor-Radar NICHT selbst rendern/tracken — die Eltern-Seite stellt ein
     *  seitenweites Radar bereit (s. login/+page.svelte). Dann auch kein
     *  cursor:none hier (die Seite setzt es). */
    externalCursor?: boolean;
    /** Zusätzliche Klassen am Wurzel-Element (z.B. z-index fürs Stacking, wenn
     *  ein seitenweites Radar zwischen Panel und Formular liegt). */
    rootClass?: string;
    /** Teilwort der Headline, das im Electric-Blue-Akzentverlauf erscheint. */
    headlineAccent?: string;
    /** Tagline mit rotierendem letztem Wort: `<prefix> <word>`. Nur gerendert,
     *  wenn beides gesetzt ist. */
    rotatingPrefix?: string;
    rotatingWords?: string[];
  }

  let {
    headline,
    headlineSub,
    description,
    features,
    bareBg = false,
    externalCursor = false,
    rootClass = '',
    headlineAccent,
    rotatingPrefix,
    rotatingWords,
  }: Props = $props();

  // Das Radar-Sonar IST der Mauszeiger: es folgt dem Cursor über das Panel und
  // verblasst sanft, sobald die Maus die Fläche verlässt. Wird die Verfolgung
  // extern (seitenweit) gemacht, bleibt das hier inert.
  let cursorX = $state(0);
  let cursorY = $state(0);
  let cursorActive = $state(false);

  // Headline in Vor-/Akzent-/Nachtext zerlegen, damit das Akzent-Wort den
  // Farbverlauf bekommt. Kein Treffer → null (Headline wird ganz normal gesetzt).
  const accent = $derived.by(() => {
    if (!headlineAccent) return null;
    const i = headline.indexOf(headlineAccent);
    if (i < 0) return null;
    return {
      pre: headline.slice(0, i),
      word: headlineAccent,
      post: headline.slice(i + headlineAccent.length),
    };
  });

  // Rotierendes Wort der Tagline. Wechselt alle 2,6 s — bei
  // prefers-reduced-motion bleibt es statisch beim ersten Wort (kein
  // erzwungenes Bewegen von Inhalt).
  let wordIndex = $state(0);
  onMount(() => {
    const words = rotatingWords;
    if (!words || words.length < 2) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => {
      wordIndex = (wordIndex + 1) % words.length;
    }, 2600);
    return () => clearInterval(id);
  });
</script>

<!--
  Zeigt sich nur ab md: (≥768 px) — auf Mobil ist display:none (hidden).
  Der äußere Container hat position:relative + overflow:hidden damit Glow-Blobs
  und Radar nicht herausragen. cursor:none → das Radar ersetzt den Maus-Pfeil
  (außer wenn die Eltern-Seite den Cursor übernimmt: externalCursor).
-->
<div
  class={`relative hidden flex-1 flex-col justify-center overflow-hidden md:flex ${rootClass}`}
  style="{bareBg
    ? ''
    : 'background: linear-gradient(150deg, #0e1f3a, #0a1525 60%, #08130c);'}{externalCursor
    ? ''
    : ' cursor: none;'}"
  use:cursorTrack={externalCursor
    ? () => {}
    : (x, y, active) => {
        cursorX = x;
        cursorY = y;
        cursorActive = active;
      }}
>
  <!-- Atmende radiale Glow-Blobs — nur wenn das Panel seinen eigenen
       Hintergrund stellt. Bei bareBg liefert die Eltern-Seite einen
       durchgehenden Verlauf inkl. Blobs über die volle Fläche. -->
  {#if !bareBg}
    <div
      class="pointer-events-none absolute inset-0 motion-safe:animate-blob-breathe"
      style="background:
        radial-gradient(420px 320px at 75% 18%, rgba(59,130,246,.25), transparent 60%),
        radial-gradient(420px 320px at 20% 95%, rgba(16,185,129,.18), transparent 60%);"
    ></div>
  {/if}

  <!-- Cursor-folgendes Radar — nur wenn nicht extern (z-20 = über dem Inhalt). -->
  {#if !externalCursor}
    <div class="absolute inset-0 z-20">
      <CursorRadar x={cursorX} y={cursorY} active={cursorActive} />
    </div>
  {/if}

  <!-- Inhalt -->
  <div class="relative z-10 flex flex-col gap-6 px-10 py-12 xl:px-14">
    <!-- Headline (Akzent-Wort im Verlauf) + Sub-Zeile leichter/kleiner -->
    <h2
      class="text-4xl font-extrabold leading-tight tracking-tight text-white motion-safe:animate-fade-up xl:text-5xl"
    >
      {#if accent}{accent.pre}<span class="accent-gradient-text">{accent.word}</span>{accent.post}{:else}{headline}{/if}{#if headlineSub}<span
          class="mt-2 block text-3xl font-semibold text-white/55">{headlineSub}</span
        >{/if}
    </h2>

    <!-- Beschreibung -->
    <p
      class="max-w-[42ch] text-base leading-relaxed motion-safe:animate-fade-up"
      style="color: #9ca3af; animation-delay: 0.12s;"
    >
      {description}
    </p>

    <!-- Tagline mit rotierendem Wort -->
    {#if rotatingPrefix && rotatingWords && rotatingWords.length}
      <p
        class="text-base font-medium motion-safe:animate-fade-up"
        style="color: #c8cad0; animation-delay: 0.22s;"
      >
        {rotatingPrefix}
        {#key wordIndex}<span
            class="accent-gradient-text font-semibold motion-safe:animate-word-in"
            >{rotatingWords[wordIndex]}</span
          >{/key}
      </p>
    {/if}

    <!-- Feature-Liste (gestaffelt eingeblendet) -->
    <ul class="mt-1 flex flex-col gap-3">
      {#each features as feat, i}
        <li
          class="flex items-center gap-3 text-[15px] motion-safe:animate-fade-up"
          style="color: #c8cad0; animation-delay: {0.32 + i * 0.08}s;"
        >
          <CheckIcon class="h-5 w-5 shrink-0" style="color: #4ade80;" />
          {feat}
        </li>
      {/each}
    </ul>
  </div>
</div>
