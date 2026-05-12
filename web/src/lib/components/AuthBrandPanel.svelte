<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';

  interface Props {
    headline: string;
    headlineSub?: string;
    description: string;
    features: string[];
  }

  let { headline, headlineSub, description, features }: Props = $props();
</script>

<!--
  Zeigt sich nur ab md: (≥768 px) — auf Mobil ist display:none (hidden).
  Der äußere Container hat position:relative + overflow:hidden damit die
  Glow-Blobs nicht herausragen.
-->
<div
  class="relative hidden flex-1 flex-col justify-center overflow-hidden md:flex"
  style="background: linear-gradient(150deg, #0e1f3a, #0a1525 60%, #08130c);"
>
  <!-- Radiale Glow-Blobs (passiv, keine Animation) -->
  <div
    class="pointer-events-none absolute inset-0"
    style="background:
      radial-gradient(420px 320px at 75% 18%, rgba(59,130,246,.25), transparent 60%),
      radial-gradient(420px 320px at 20% 95%, rgba(16,185,129,.18), transparent 60%);"
  ></div>

  <!-- Inhalt — über den Blobs via z-10 -->
  <div class="relative z-10 flex flex-col gap-5 px-10 py-12 xl:px-14">
    <!-- Sonar-Ping -->
    <div class="relative mb-2 h-[120px] w-[120px]">
      <!-- Äußerer Ring, statisch -->
      <div
        class="absolute inset-0 rounded-full border-2"
        style="border-color: rgba(255,255,255,.18);"
      ></div>
      <!-- Mittlerer Ring, statisch -->
      <div
        class="absolute rounded-full border-2"
        style="inset: 18px; border-color: rgba(255,255,255,.32);"
      ></div>
      <!-- Innerer Ring, pulsiert -->
      <div
        class="absolute rounded-full border-2 motion-safe:animate-auth-ping"
        style="inset: 40px; border-color: rgba(255,255,255,.7);"
      ></div>
      <!-- Kern-Punkt -->
      <div class="absolute rounded-full bg-white" style="inset: 52px;"></div>
    </div>

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
