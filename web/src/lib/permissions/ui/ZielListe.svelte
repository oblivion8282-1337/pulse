<!--
  Die linke Spalte der Kanalrechte: Rollen und Mitglieder, getrennt in
  „Mit Abweichung" und „Ohne Abweichung".

  Liegt unter `lib/permissions/`, nicht unter `lib/components/`, weil sie ohne
  den Rest der Kanalrechte-Ansicht sinnlos ist — Begründung im Kopf von
  `ziele.ts`.
-->
<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import type { ZielEintrag } from '../ziele';

  let {
    ziele,
    ausgewaehlt,
    onwaehle
  }: {
    ziele: ZielEintrag[];
    ausgewaehlt: string | null;
    onwaehle: (key: string) => void;
  } = $props();

  let suche = $state('');

  let gefiltert = $derived.by(() => {
    const q = suche.trim().toLowerCase();
    return q ? ziele.filter((z) => z.name.toLowerCase().includes(q)) : ziele;
  });
  let mit = $derived(gefiltert.filter((z) => z.gesetzte > 0));
  let ohne = $derived(gefiltert.filter((z) => z.gesetzte === 0));
</script>

{#snippet gruppe(titel: string, eintraege: ZielEintrag[], testId: string)}
  {#if eintraege.length > 0}
    <div class="mb-4" data-testid={testId}>
      <h3 class="text-text-muted mb-1 px-1 text-xs font-semibold tracking-wide uppercase">
        {titel}
      </h3>
      <ul class="space-y-0.5">
        {#each eintraege as z (z.key)}
          <li>
            <button
              type="button"
              class="hover:bg-bg-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
              class:bg-bg-hover={ausgewaehlt === z.key}
              onclick={() => onwaehle(z.key)}
              aria-current={ausgewaehlt === z.key ? 'true' : undefined}
              data-testid={`perm-target-${z.key}`}
            >
              {#if z.art === 0}
                <!-- Rolle: eckiger Farbpunkt, wie überall sonst auch. -->
                <span
                  class="size-3 shrink-0 rounded-sm border border-border"
                  style={z.farbe ? `background: ${z.farbe}; border-color: ${z.farbe}` : ''}
                  aria-hidden="true"
                ></span>
              {:else}
                <Avatar.Root class="size-5 shrink-0">
                  {#if z.avatar}
                    <Avatar.Image src={z.avatar} alt="" />
                  {/if}
                  <Avatar.Fallback class="text-[10px] font-semibold">
                    {z.initialen}
                  </Avatar.Fallback>
                </Avatar.Root>
              {/if}
              <span class="min-w-0 flex-1 truncate text-sm" style={z.farbe ? `color: ${z.farbe}` : ''}>
                {z.name}
              </span>
              {#if z.gesetzte > 0}
                <span
                  class="bg-bg-input text-text-muted shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  title={m.kanalrechte_abweichungen_zahl({ count: z.gesetzte })}
                >
                  {z.gesetzte}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col" data-testid="perm-targets">
  <Input
    bind:value={suche}
    placeholder={m.kanalrechte_ziele_suche()}
    class="mb-3"
    aria-label={m.kanalrechte_ziele_suche()}
    data-testid="perm-target-search"
  />
  <div class="min-h-0 flex-1 overflow-y-auto">
    {@render gruppe(m.kanalrechte_ziele_mit(), mit, 'perm-targets-mit')}
    {@render gruppe(m.kanalrechte_ziele_ohne(), ohne, 'perm-targets-ohne')}
    {#if gefiltert.length === 0}
      <EmptyState message={m.kanalrechte_ziele_leer()} />
    {/if}
  </div>
</div>
