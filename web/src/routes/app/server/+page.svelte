<!--
  /app/server — der eigene Server als eigener Ort.

  Bis 2026-08-27 war das ein Einstellungs-Reiter. Der Umzug hat einen Grund,
  der über Geschmack hinausgeht: `settingsTabs.ts` speist drei Oberflächen
  (Dialog, Du-Liste, `/app/me/[section]`), ein Reiter ist dort nie nur ein
  Reiter — und der Self-Host-Bereich ist keine Einstellung, sondern eine
  Verwaltung mit eigenem Zustand (Antrag, Freigabe, laufende Server).

  Der Rahmen folgt `/app/invites`: am Rechner die GuildRail daneben, darunter
  ein Vollbild mit Zurück-Kopf wie `/app/me/[section]`. Der Inhalt kommt aus
  `SelfHostPanel` und existiert nur dort.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import BereichsKopf from '$lib/components/mobile/BereichsKopf.svelte';
  import SelfHostPanel from '$lib/components/selfhost/SelfHostPanel.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { selfHostEinstiegSichtbar } from '$lib/selfhost/hinweis.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Auf einem fremden Server kennt die auth-API `/me/instances` nicht — statt
  // einer Fläche, die still leer bleibt oder in Fehler läuft, der Grund.
  let inDerCloud = $derived(selfHostEinstiegSichtbar());

  async function selectGuild(g: { id: string }) {
    navDrawer.open = true;
    await goto(`/app/guilds/${g.id}/channels/_`);
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
/>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  data-testid="self-host-page"
>
  {#if viewport.isMobile}
    <!-- Auf dem Handy ist das ein aufgeschobener Bildschirm: der Weg zurück
         gehört sichtbar dazu, wie bei `/app/me/[section]`. -->
    <header class="border-border text-text-bright flex h-14 shrink-0 items-center gap-1 border-b px-2">
      <button
        class="text-text-muted hover:text-primary flex min-h-12 min-w-12 items-center justify-center"
        onclick={() => goto('/app/rooms')}
        data-testid="self-host-back"
        aria-label={m.settings_dialog_back()}
      >
        <ChevronLeftIcon class="size-6" />
      </button>
      <span class="truncate text-base font-bold tracking-tight">{m.self_host_entry_label()}</span>
    </header>
  {:else}
    <BereichsKopf titel={m.self_host_entry_label()} />
  {/if}

  <div class="flex-1 overflow-y-auto p-4 md:p-6">
    {#if inDerCloud}
      <SelfHostPanel />
    {:else}
      <p class="text-text-muted text-sm" data-testid="self-host-cloud-only">
        {m.self_host_cloud_only()}
      </p>
    {/if}
  </div>
</section>
