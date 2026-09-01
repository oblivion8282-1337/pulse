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
  import SelfHostPanel from '$lib/components/selfhost/SelfHostPanel.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { selectGuild } from '$lib/navigation/railNavi';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Zurück dorthin, wo der Einstieg steht: unter `lg` die Räume-Liste, darüber
  // die Startseite (dort ist die Server-Leiste selbst der Ort des Knopfes).
  // 1024 = der `lg`-Bruchpunkt, an dem die Leiste erscheint (`hidden lg:flex`).
  let zurueckZiel = $derived(viewport.width < 1024 ? '/app/rooms' : '/app');


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
  <!-- Der Weg zurück gehört auf JEDE Größe, nicht nur aufs Handy: das hier ist
       ein aufgeschobener Bildschirm, keine der vier Bereichs-Seiten. Am
       Rechner blieb sonst nur der Umweg über das Pulse-Zeichen in der Leiste —
       ein Ausgang, den man kennen muss, statt einen, den man sieht. Deshalb
       auch kein `BereichsKopf` (der trägt bewusst keine Zurück-Geste). -->
  <header class="border-border text-text-bright flex h-14 shrink-0 items-center gap-1 border-b px-2">
    <button
      class="text-text-muted hover:text-primary flex min-h-12 min-w-12 items-center justify-center"
      onclick={() => goto(zurueckZiel)}
      data-testid="self-host-back"
      aria-label={m.settings_dialog_back()}
    >
      <ChevronLeftIcon class="size-6" />
    </button>
    <span class="truncate text-base font-bold tracking-tight">{m.self_host_entry_label()}</span>
  </header>

  <div class="flex-1 overflow-y-auto p-4 md:p-6">
    <!-- Der Bereich holt seine Daten über `cookieFetch` und damit immer von der
         Cloud, unabhängig vom aktiven Server. Hier stand bis 2026-08-28 ein
         Hinweis „nur in der Cloud verfügbar" — er beruhte auf einer falschen
         Annahme und verbarg die Verwaltung ausgerechnet dem, der auf seinem
         eigenen Server danach suchte. -->
    <SelfHostPanel />
  </div>
</section>
