<script lang="ts">
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
  }

  let {
    headline,
    headlineSub,
    description,
    features,
    bareBg = false,
    externalCursor = false,
    rootClass = '',
  }: Props = $props();

  // Das Radar-Sonar IST der Mauszeiger: es folgt dem Cursor über das Panel und
  // verblasst sanft, sobald die Maus die Fläche verlässt. Wird die Verfolgung
  // extern (seitenweit) gemacht, bleibt das hier inert.
  let cursorX = $state(0);
  let cursorY = $state(0);
  let cursorActive = $state(false);
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
  <div class="relative z-10 flex flex-col gap-5 px-10 py-12 xl:px-14">
    <!-- Headline -->
    <h2 class="text-3xl font-extrabold leading-tight tracking-tight text-white">
      {headline}{#if headlineSub}<br />{headlineSub}{/if}
    </h2>

    <!-- Beschreibung -->
    <p class="max-w-[34ch] text-sm leading-relaxed" style="color: #9ca3af;">
      {description}
    </p>

    <!-- Feature-Liste -->
    <ul class="mt-1 flex flex-col gap-2.5">
      {#each features as feat}
        <li class="flex items-center gap-2.5 text-[13.5px]" style="color: #c8cad0;">
          <CheckIcon class="h-4 w-4 shrink-0" style="color: #4ade80;" />
          {feat}
        </li>
      {/each}
    </ul>
  </div>
</div>
