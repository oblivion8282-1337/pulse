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
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import TabletPlaceholder from '$lib/components/mobile/TabletPlaceholder.svelte';
  import BereichsKopf from '$lib/components/mobile/BereichsKopf.svelte';
  import { initialen } from '$lib/utils/initialen';
  import { m } from '$lib/paraglide/messages.js';
  import type { Guild } from '$lib/api/types';

  /**
   * Ungelesenes einer Community — nur für den AKTIVEN Server. Für fremde
   * Server liegen die Kanäle gar nicht im Speicher; eine Null dort ist
   * ehrlicher als eine erfundene Zahl.
   */
  function ungelesen(g: Guild): number {
    // Wie `leben()`: `channelsByGuild` ist nur fuer den aktiven Server
    // gefuellt, eine zusaetzliche Server-Abfrage waere nur eine zweite Stelle
    // zum stummen Ausfallen.
    const kanaele = guildsStore.channelsByGuild[g.id] ?? [];
    return readState.sumUnread(kanaele.map((c) => c.id));
  }

  /**
   * Die Zeile unter dem Namen.
   *
   * **Was gerade lebt, hat Vorrang vor dem, was nur da ist.** Sitzt jemand in
   * einem Sprachkanal, steht das dort — mit dem Smaragd der Bildmarke, dem
   * Anwesenheitston der App. Sonst die Zahl der Kanäle: eine ehrliche Angabe,
   * die die Kachel ausfüllt, statt sie leer zu lassen.
   *
   * Fremde Server liefern nichts davon (ihre Kanäle liegen nicht im
   * Speicher) — dort bleibt die Zeile leer statt eine Zahl zu erfinden.
   */
  function leben(g: Guild): { imGespraech: number; kanaele: number } {
    // KEINE Abfrage auf „aktiver Server" mehr: `channelsByGuild` ist ohnehin
    // nur fuer den aktiven Server gefuellt, und die zusaetzliche Bedingung war
    // eine zweite Stelle, an der die Zeile stumm ausfallen konnte — genau das
    // ist beim ersten Ansehen passiert.
    const kanaele = guildsStore.channelsByGuild[g.id] ?? [];
    const imGespraech = kanaele
      .filter((c) => c.type === 1)
      .reduce((n, c) => n + voicePresence.usersIn(c.id).length, 0);
    return { imGespraech, kanaele: kanaele.filter((c) => c.type !== 1).length };
  }

  // Kanaele der eigenen Communities nachladen. Das Layout laedt sie beim
  // Start vor, aber wer direkt auf `/app/rooms` einsteigt (Adresse, Neuladen)
  // saehe die Zeile unter dem Namen sonst leer. `ensureChannels` ist
  // idempotent, ein zweiter Aufruf kostet nichts.
  $effect(() => {
    const ids = guildsStore.list.map((g) => g.id);
    queueMicrotask(() => {
      for (const id of ids) void guildsStore.ensureChannels(id).catch(() => undefined);
    });
  });

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

<div class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:w-72 md:flex-none md:rounded-2xl" data-testid="rooms-page">
  <BereichsKopf titel={m.nav_tab_rooms()}>
    {#snippet handlung()}
      <a
        href="/app/discover"
        class="text-text-muted hover:text-primary flex min-h-12 items-center gap-1.5 text-sm font-semibold"
        data-testid="rooms-discover-link"
      >
        <CompassIcon class="size-[19px]" />
        <span>{m.rooms_discover_short()}</span>
      </a>
    {/snippet}
  </BereichsKopf>

  <div class="flex-1 overflow-y-auto px-3 pb-4">
    {#each server as s (s.id)}
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
            {@const zahl = ungelesen(g)}
            {@const l = leben(g)}
            <button
              class="bg-bg-input border-border hover:border-primary/40 hover:bg-bg-hover flex flex-col items-start gap-2.5 rounded-[16px] border p-3.5 text-left transition-colors"
              onclick={() => oeffnen(g)}
              data-testid={`room-tile-${g.id}`}
            >
              <span class="relative">
                <span
                  class="flex size-14 items-center justify-center overflow-hidden rounded-[18px] text-lg font-bold text-white"
                  style={g.icon_url
                    ? ''
                    : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
                >
                  {#if g.icon_url}
                    <img src={g.icon_url} alt={g.name} class="size-full object-cover" />
                  {:else}
                    {initialen(g.name)}
                  {/if}
                </span>
                {#if zahl > 0}
                  <span
                    class="bg-badge-count ring-bg-panel absolute -bottom-1 -right-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-extrabold leading-none text-white ring-2"
                    data-testid={`room-unread-${g.id}`}
                  >{zahl > 99 ? '99+' : zahl}</span>
                {/if}
              </span>
              <span class="w-full min-w-0">
                <span class="text-text-bright block truncate text-sm font-semibold">{g.name}</span>
                {#if l.imGespraech > 0}
                  <span class="text-text-muted mt-0.5 flex items-center gap-1.5 text-2xs">
                    <span class="bg-success size-1.5 shrink-0 rounded-full"></span>
                    {m.rooms_in_voice({ count: l.imGespraech })}
                  </span>
                {:else if l.kanaele > 0}
                  <span class="text-text-muted mt-0.5 block text-2xs"
                    >{m.rooms_channel_count({ count: l.kanaele })}</span
                  >
                {/if}
              </span>
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

{#if !viewport.isMobile}
  <TabletPlaceholder text={m.rooms_pick_community()} />
{/if}
