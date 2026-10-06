<!--
  Einstieg in den eigenen Server, unten in der GuildRail — dort, wo der
  Kommentar an ihrem Kopf seit jeher einen „+ Server"-Knopf ankündigt.

  Sichtbar auf JEDEM Server, nicht nur in der Cloud (seit 2026-08-28): Der
  Bereich gehört zum Konto, nicht zum aktiven Server, und holt seine Daten
  ohnehin immer von der Cloud. Begründung in `selfhost/hinweis.svelte.ts`.

  Der Punkt meldet einen freigeschalteten EIGENEN Antrag — bis 2026-08-27 sass
  er am Avatar und führte in die Einstellungen; er ist mit seinem Ziel hierher
  gewandert.

  Die Rail ist `hidden lg:flex`. Auf Tablet und Handy sitzt derselbe Einstieg
  am Fuss der Räume-Liste (`/app/rooms`) — beide rufen dieselbe Route.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import ServerIcon from '@lucide/svelte/icons/server';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { selfHostEinstiegSichtbar, selfHostHinweisOffen } from '$lib/selfhost/hinweis.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let sichtbar = $derived(selfHostEinstiegSichtbar());
  let hinweis = $derived(selfHostHinweisOffen());
</script>

{#if sichtbar}
  <Tooltip.Provider delayDuration={200} disabled={viewport.isMobile}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <div class="relative shrink-0">
            <button
              {...props}
              onclick={() => goto('/app/server')}
              class="text-text-muted hover:bg-bg-hover hover:text-primary flex size-12 items-center justify-center rounded-xl transition-all hover:rounded-md md:size-10"
              data-testid="open-self-host"
              aria-label={m.self_host_entry_label()}
            >
              <ServerIcon class="size-6 md:size-5" />
            </button>
            {#if hinweis}
              <span
                class="bg-badge-count ring-bg-panel absolute -right-1 -bottom-1 size-3 rounded-full ring-2"
                data-testid="self-host-setup-dot"
                aria-label={m.self_host_entry_ready()}
              ></span>
            {/if}
          </div>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right">{m.self_host_entry_label()}</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}
