<script lang="ts">
  /**
   * „Community erstellen" für die Bereichs-Ansicht Räume (`< lg`).
   *
   * **Warum es diesen Knopf überhaupt braucht.** Auf `< lg` gibt es die
   * `GuildRail` nicht (`hidden lg:flex`), und mit ihr fehlte der einzige Weg,
   * eine Community anzulegen: Der Leerzustand bot allein „Entdecken" an — und
   * wer als Erster auf einen frischen eigenen Server kommt, findet dort
   * nichts zu entdecken. Auf einem Telefon oder in einem schmalen Fenster war
   * es damit unmöglich, unabhängig von jeder Berechtigung.
   *
   * Eigene Datei, weil `rooms/+page.svelte` sonst über die Größen-Policy läuft
   * (PLAN.md §12.1) und der Knopf an zwei Stellen steht: pro Server, wenn nur
   * dieser leer ist, und im globalen Leerzustand.
   */
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
  import { serverCapabilities } from '$lib/stores/serverCapabilities.svelte';
  import { darfCommunityAnlegen } from '$lib/servers/erstellrecht';
  import { m } from '$lib/paraglide/messages.js';
  import type { ServerEntry } from '$lib/api/servers.svelte';

  let { server, breit = false }: { server: ServerEntry; breit?: boolean } = $props();

  // Dieselbe Rechnung wie in der Rail — eine Stelle für alle Aufrufer.
  // `serverAdmin.has()` trennt „der Server sagt nein" von „der Server hat noch
  // nichts gesagt"; ohne diese Trennung sah ein Betreiber auf seinem eigenen,
  // gerade nicht verbundenen Server keinen Weg (2026-08-27).
  let darf = $derived(
    darfCommunityAnlegen({
      istCloud: server.isCloud,
      cloudAdmin: !!auth.user?.is_admin,
      rolleLautCloud: server.role ?? null,
      adminLautServer: serverAdmin.has(server.id) ? serverAdmin.isAdmin(server.id) : null,
      offenFuerAlle: serverCapabilities.get(server.id)?.allowGuildCreation ?? false,
    }),
  );

  // Der Anlege-Dialog läuft gegen den AKTIVEN Server (wie in der Rail) — erst
  // wechseln, dann öffnen, sonst landet die neue Community auf dem falschen.
  function anlegen(): void {
    if (server.id !== activeServer.serverId) activeServer.set(server.id);
    void goto('/app?add=create');
  }
</script>

{#if darf}
  <button
    type="button"
    onclick={anlegen}
    class="border-primary/40 text-primary flex min-h-12 items-center justify-center gap-2 rounded-xl border border-dashed px-4 text-sm font-semibold {breit
      ? 'w-full max-w-xs'
      : 'w-full'}"
    data-testid={`rooms-create-${server.id}`}
  >
    {m.guild_rail_create_community()}
  </button>
{/if}
