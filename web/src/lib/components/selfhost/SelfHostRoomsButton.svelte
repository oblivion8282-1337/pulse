<!--
  Derselbe Einstieg für Tablet und Handy: am Fuss der Räume-Liste, weil die
  GuildRail dort ausgeblendet ist (`hidden lg:flex`).

  Bewusst NICHT im Du-Bereich: „Du" ist auf schmalen Geräten genau der
  Einstellungs-Ort, aus dem der Self-Host-Bereich herausgeholt wurde. Die
  Räume-Liste ist die Entsprechung der Rail — dieselbe Nachbarschaft, dieselbe
  Idee.

  Breite Zeile statt rundem Symbol: hier ist Platz für den Namen, und die
  Trefffläche liegt damit sicher über 48 dp (`web/tests/e2e/mobile-
  treffflaechen.spec.ts` misst das).

  Geometrie exakt wie `CommunityAnlegenKnopf`, der direkt darüber steht
  (`min-h-12`, `rounded-xl`, `px-4`, `text-sm font-semibold`, gestrichelt,
  zentriert): zwei gestrichelte Knöpfe übereinander mit verschiedenen Radien
  und Schriftschnitten lesen sich wie ein Versehen. Nur die Farbe unterscheidet
  sie — „Community erstellen" ist die Haupthandlung dieser Liste und trägt
  deshalb den Akzent, der eigene Server steht daneben.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { selfHostEinstiegSichtbar, selfHostHinweisOffen } from '$lib/selfhost/hinweis.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let sichtbar = $derived(selfHostEinstiegSichtbar());
  let hinweis = $derived(selfHostHinweisOffen());
</script>

{#if sichtbar}
  <button
    onclick={() => goto('/app/server')}
    class="border-border hover:bg-bg-hover text-text-bright mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed px-4 text-sm font-semibold transition-colors"
    data-testid="rooms-open-self-host"
  >
    <ServerIcon class="size-4 shrink-0" />
    <span class="min-w-0 truncate">{m.self_host_entry_label()}</span>
    {#if hinweis}
      <span
        class="bg-badge-count size-2.5 shrink-0 rounded-full"
        data-testid="rooms-self-host-dot"
        aria-label={m.self_host_entry_ready()}
      ></span>
    {/if}
  </button>
{/if}
