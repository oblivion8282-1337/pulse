<script lang="ts">
  /**
   * Der Du-Bereich: eigenes Profil, Status, Einstellungen, Abmelden.
   *
   * Am Rechner öffnen die Einstellungen als Dialog mit Reiter-Leiste; auf dem
   * Telefon ist ein Dialog mit Seitenleiste der falsche Behälter — hier ist es
   * eine Liste, deren Einträge sich als eigener Bildschirm aufschieben
   * (`/app/me/[section]`).
   *
   * **Welche Einträge erscheinen, entscheidet `sichtbareReiter`** — dieselbe
   * Funktion wie im Dialog. Eine zweite Rechnung wäre in die gefährliche
   * Richtung falsch gelaufen: ein Reiter, der am Telefon nichts tun kann
   * (Bildschirm teilen, Tastenkürzel), stünde trotzdem da.
   */
  import { goto } from '$app/navigation';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import LogOutIcon from '@lucide/svelte/icons/log-out';
  import { auth } from '$lib/stores/auth.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { deviceStore } from '$lib/devices/store.svelte';
  import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';
  import { darfStandplatzSein } from '$lib/remote/darfStandplatzSein';
  import { reiterSichtbar } from '$lib/devices/reiterSichtbar';
  import { isElectron, isCapacitorAndroid } from '$lib/platform/runtime';
  import { getSettingsTabs, sichtbareReiter } from '$lib/components/settingsTabs';
  import StatusPicker from '$lib/components/StatusPicker.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const inBrowser = !isElectron() && !isCapacitorAndroid();
  const isDesktopApp = isElectron();
  const tabs = getSettingsTabs();

  // Geräte für alle Communitys vorladen — sonst kennt `deviceStore.eigene()`
  // nur die zuletzt geöffnete Community und der Standplatz-Eintrag bliebe
  // dauerhaft unsichtbar. Dieselbe Begründung wie im Einstellungsdialog.
  $effect(() => {
    const guildIds = guilds.list.map((g) => g.id);
    queueMicrotask(() => {
      for (const id of guildIds) void deviceStore.ensureLoaded(id);
    });
  });

  const zeigtStandplatz = $derived(
    reiterSichtbar({
      kannStandplatzSein: darfStandplatzSein(),
      hatEintragung: !!geraeteAnmeldung.fuerServer(activeServer.serverId),
      besitztGeraete: deviceStore.eigene(currentServerUserId()).length > 0
    })
  );

  let eintraege = $derived(
    sichtbareReiter(tabs, {
      istMobil: viewport.isMobile,
      imBrowser: inBrowser,
      istDesktopApp: isDesktopApp,
      zeigtStandplatz
    })
  );

  let anzeigename = $derived(auth.user?.display_name || auth.user?.username || '');

  function initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
  }
</script>

<div
  class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  data-testid="me-page"
>
  <header class="text-text-bright shrink-0 px-4 pb-2 pt-3.5">
    <h1 class="text-[22px] font-extrabold tracking-tight">{m.nav_tab_me()}</h1>
  </header>

  <div class="flex-1 overflow-y-auto px-3 pb-4">
    <!-- Profilblock -->
    <div class="bg-bg-input border-border mb-4 flex items-center gap-3 rounded-[14px] border p-3">
      <span
        class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-bold text-white"
        style={auth.user?.avatar_url
          ? ''
          : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
      >
        {#if auth.user?.avatar_url}
          <img src={auth.user.avatar_url} alt={anzeigename} class="size-full object-cover" />
        {:else}
          {initials(anzeigename)}
        {/if}
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-text-bright truncate text-base font-bold">{anzeigename}</div>
        <div class="text-text-muted truncate text-sm">@{auth.user?.username ?? ''}</div>
      </div>
      <StatusPicker />
    </div>

    <!-- Einstellungen -->
    <div class="border-border overflow-hidden rounded-[14px] border">
      {#each eintraege as eintrag, i (eintrag.id)}
        {@const Symbol = eintrag.icon}
        <button
          class="hover:bg-bg-hover flex min-h-12 w-full items-center gap-3 px-3 py-3 text-left transition-colors {i >
          0
            ? 'border-border border-t'
            : ''}"
          onclick={() => goto(`/app/me/${eintrag.id}`)}
          data-testid={`me-section-${eintrag.id}`}
        >
          <Symbol class="text-text-muted size-5 shrink-0" />
          <span class="text-text-bright flex-1 truncate text-sm font-medium">{eintrag.label}</span>
          <ChevronRightIcon class="text-text-muted size-4 shrink-0" />
        </button>
      {/each}
    </div>

    <!-- Abmelden -->
    <button
      class="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-[14px] px-3 py-3 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/10"
      onclick={() => auth.signOut()}
      data-testid="me-sign-out"
    >
      <LogOutIcon class="size-4" />
      {m.user_footer_sign_out()}
    </button>
  </div>
</div>
