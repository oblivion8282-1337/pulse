<!--
  Die rechte Spalte: Kopfzeile, die Kette als Erklärung, die Rechteliste.

  Die Kette steht EINMAL oben und kurz — `Community-Rolle → Abweichung hier →
  gilt in #kanal`. Sie ist die ganze Mechanik in drei Wörtern; steht sie
  stattdessen als Fussnote unter der Liste, liest sie niemand, bevor er die
  erste Einstellung setzt.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { m } from '$lib/paraglide/messages.js';
  import { Perm, type Permission } from '../bitfield';
  import type { Zustand } from '../entwurf.svelte';
  import type { Rechtsstand } from '../herkunft';
  import type { Kanalrecht } from '../kanalrechte';
  import type { ZielEintrag } from '../ziele';
  import RechtZeile from './RechtZeile.svelte';

  let {
    ziel,
    kanalName,
    rechte,
    staende,
    zustandFuer,
    gesperrt,
    onsetze,
    kopfAktionen
  }: {
    ziel: ZielEintrag;
    kanalName: string;
    rechte: Kanalrecht[];
    staende: Map<Permission, Rechtsstand>;
    zustandFuer: (perm: Permission) => Zustand;
    gesperrt: (perm: Permission) => boolean;
    onsetze: (perm: Permission, zu: Zustand) => void;
    kopfAktionen?: Snippet;
  } = $props();

  // Sieht das Ziel den Kanal am Ende nicht, fällt alles Übrige weg — die
  // revoke-all-Invariante aus `permission_resolver.py`. Sie wirkt hart und
  // stand bisher nirgends in der Oberfläche.
  let sieht = $derived(staende.get(Perm.VIEW_CHANNEL)?.gilt ?? true);
  let kettenAnfang = $derived(
    ziel.art === 0 ? m.kanalrechte_kette_rolle() : m.kanalrechte_kette_rollen_person()
  );
</script>

<div class="min-w-0" data-testid={`perm-detail-${ziel.key}`}>
  <header class="mb-3 flex flex-wrap items-start justify-between gap-2">
    <div class="min-w-0">
      <h2 class="text-text-bright truncate text-base font-semibold">
        {m.kanalrechte_kopf({ ziel: ziel.name, kanal: kanalName })}
      </h2>
      <div class="text-text-muted mt-1 flex flex-wrap items-center gap-1 text-xs">
        <span class="bg-bg-input rounded px-1.5 py-0.5">{kettenAnfang}</span>
        <ChevronRightIcon class="size-3 shrink-0" />
        <span class="bg-bg-input rounded px-1.5 py-0.5">{m.kanalrechte_kette_abweichung()}</span>
        <ChevronRightIcon class="size-3 shrink-0" />
        <span class="bg-bg-input text-text-bright rounded px-1.5 py-0.5">
          {m.kanalrechte_kette_ergebnis({ kanal: kanalName })}
        </span>
      </div>
    </div>
    {#if kopfAktionen}
      <div class="flex shrink-0 flex-wrap gap-2">{@render kopfAktionen()}</div>
    {/if}
  </header>

  {#if !sieht}
    <p
      class="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
      data-testid="perm-sichtsperre"
    >
      <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
      <span>
        <strong class="font-semibold">{m.kanalrechte_sichtsperre_titel()}</strong>
        {m.kanalrechte_sichtsperre_text()}
      </span>
    </p>
  {/if}

  <ul class="divide-border divide-y">
    {#each rechte as recht (recht.perm)}
      {@const stand = staende.get(recht.perm)}
      {#if stand}
        <RechtZeile
          {recht}
          {stand}
          zustand={zustandFuer(recht.perm)}
          zielName={ziel.name}
          gesperrt={gesperrt(recht.perm)}
          gedaempft={!sieht && recht.perm !== Perm.VIEW_CHANNEL}
          testKey={ziel.key}
          onsetze={(zu) => onsetze(recht.perm, zu)}
        />
      {/if}
    {/each}
  </ul>
</div>
