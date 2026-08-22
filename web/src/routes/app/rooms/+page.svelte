<script lang="ts">
  /**
   * Der Räume-Bereich: die Communities als Kacheln.
   *
   * Ersetzt auf Handy und Tablet die dauerhafte `GuildRail` — die Server-Icons
   * wohnen jetzt hier, sichtbar nur wenn man sie braucht. Am Rechner
   * (`>= lg`) ist diese Route nicht der Weg; dort steht die Leiste weiter.
   *
   * **Nach Server gruppiert**, nicht zu einer Liste verschmolzen: mehrere
   * Pulse-Server sind getrennte Welten (eigene Identität, eigene
   * Mitgliedschaften), und eine gemeinsame Kachelwand verwischte, auf welchem
   * Server man gerade etwas anklickt.
   */
  import { goto } from '$app/navigation';
  import CompassIcon from '@lucide/svelte/icons/compass';
  import { serversStore } from '$lib/api/servers.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import type { Guild } from '$lib/api/types';

  /** Initialen als Ersatz für ein fehlendes Community-Bild — wie in der GuildRail. */
  function initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
  }

  /**
   * Ungelesenes einer Community — nur für den AKTIVEN Server. Für fremde
   * Server liegen die Kanäle gar nicht im Speicher; eine Null dort ist
   * ehrlicher als eine erfundene Zahl.
   */
  function ungelesen(g: Guild, istAktiverServer: boolean): number {
    if (!istAktiverServer) return 0;
    const kanaele = guildsStore.channelsByGuild[g.id] ?? [];
    return readState.sumUnread(kanaele.map((c) => c.id));
  }

  let server = $derived(serversStore.servers);
  let mehrereServer = $derived(server.length > 1);
  // Nirgends eine Community: dann NUR der grosse Leerzustand mit dem Weg
  // nach draussen. Sonst stuenden zwei Saetze uebereinander, die dasselbe
  // sagen — je Server einer und darunter nochmal der globale.
  let ueberallLeer = $derived(server.every((s) => serverGuilds.get(s.id).length === 0));

  function oeffnen(g: Guild) {
    void goto(`/app/rooms/${g.id}`);
  }
</script>

<div class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl" data-testid="rooms-page">
  <header class="text-text-bright flex shrink-0 items-center justify-between px-4 pb-2 pt-3.5">
    <h1 class="text-[22px] font-extrabold tracking-tight">{m.nav_tab_rooms()}</h1>
    <a
      href="/app/discover"
      class="text-text-muted hover:text-primary flex min-h-12 items-center gap-1.5 text-sm font-semibold"
      data-testid="rooms-discover-link"
    >
      <CompassIcon class="size-[22px]" />
      <span>{m.rooms_discover_cta()}</span>
    </a>
  </header>

  <div class="flex-1 overflow-y-auto px-3 pb-4">
    {#each server as s (s.id)}
      {@const istAktiv = s.id === activeServer.serverId}
      {@const liste = serverGuilds.get(s.id)}
      {#if mehrereServer}
        <div class="text-text-muted px-1 pb-1.5 pt-3 text-xs font-bold">
          {s.server_name ?? s.label}
        </div>
      {/if}
      {#if liste.length === 0}
        {#if !ueberallLeer}
          <p class="text-text-muted px-1 py-2 text-xs">{m.rooms_empty_server()}</p>
        {/if}
      {:else}
        <div class="grid grid-cols-2 gap-2.5">
          {#each liste as g (g.id)}
            {@const zahl = ungelesen(g, istAktiv)}
            <button
              class="bg-bg-input border-border hover:bg-bg-hover flex min-h-12 flex-col items-start gap-2 rounded-[14px] border p-3 text-left transition-colors"
              onclick={() => oeffnen(g)}
              data-testid={`room-tile-${g.id}`}
            >
              <span class="relative">
                <span
                  class="flex size-11 items-center justify-center overflow-hidden rounded-[14px] text-base font-bold text-white"
                  style={g.icon_url
                    ? ''
                    : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
                >
                  {#if g.icon_url}
                    <img src={g.icon_url} alt={g.name} class="size-full object-cover" />
                  {:else}
                    {initials(g.name)}
                  {/if}
                </span>
                {#if zahl > 0}
                  <span
                    class="bg-badge-count ring-bg-panel absolute -bottom-1 -right-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-extrabold leading-none text-white ring-2"
                    data-testid={`room-unread-${g.id}`}
                  >{zahl > 99 ? '99+' : zahl}</span>
                {/if}
              </span>
              <span class="text-text-bright w-full truncate text-sm font-semibold">{g.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/each}

    {#if ueberallLeer}
      <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <p class="text-text-muted text-sm">{m.rooms_empty_all()}</p>
        <a
          href="/app/discover"
          class="accent-gradient inline-flex min-h-12 items-center rounded-xl px-4 text-sm font-semibold text-white"
          data-testid="rooms-empty-discover"
        >
          {m.rooms_discover_cta()}
        </a>
      </div>
    {/if}
  </div>
</div>
