<!--
  ServerSidebar — Phase 4.3.

  Schmale vertikale Spalte LINKS der bestehenden GuildRail. Listet Cloud
  (oben, immer da) + Self-Host-Server (unten) + Plus-Button.

  Klick auf Icon = activeServer.set(id). Right-Click → Context-Menü
  (Notification-Modus, Info, Entfernen). Self-Host-Badge (Akzent-Dot oben
  rechts) trennt visuell von Cloud. WS-State-Indicator (Dot unten rechts:
  grün/gelb/rot/grau) aus `serverState.byId` (1Hz-Poll via
  server-state.svelte.ts).
-->
<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { onMount, onDestroy } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { serversStore, type ServerEntry } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
  import { serverState } from '$lib/ws/server-state.svelte';
  import AddServerDialog from './AddServerDialog.svelte';
  import ServerInfoDialog from './ServerInfoDialog.svelte';
  import ServerIconButton from './ServerIconButton.svelte';

  let addOpen = $state(false);
  let removeTarget = $state<ServerEntry | null>(null);
  let removeConfirmOpen = $state(false);
  let infoTarget = $state<ServerEntry | null>(null);
  let infoOpen = $state(false);

  onMount(() => serverState.start());
  onDestroy(() => serverState.stop());

  let cloud = $derived(serversStore.servers.find((s) => s.isCloud));
  let selfHosts = $derived(serversStore.servers.filter((s) => !s.isCloud));

  function openInfo(server: ServerEntry): void {
    infoTarget = server;
    infoOpen = true;
  }

  function setNotif(server: ServerEntry, mode: ServerEntry['notification_mode']): void {
    serversStore.update(server.id, { notification_mode: mode });
  }

  function openRemove(server: ServerEntry): void {
    removeTarget = server;
    removeConfirmOpen = true;
  }

  function confirmRemove(): void {
    if (!removeTarget) return;
    const id = removeTarget.id;
    const label = removeTarget.label;
    try {
      // Connection schließen BEVOR der Entry weg ist (Pool dereferenced
      // serversStore.find sonst zu undefined → spätere reconnects crashen).
      gatewayPool.close(id);
      serversStore.remove(id);
      // Falls der entfernte Server gerade aktiv war → auf Cloud zurückfallen.
      if (activeServer.serverId === id) {
        const fallback = serversStore.servers.find((s) => s.isCloud);
        if (fallback) activeServer.set(fallback.id);
      }
      toast.success(`${label} entfernt`);
    } catch (err) {
      toast.error('Entfernen fehlgeschlagen', { description: (err as Error).message });
    } finally {
      removeConfirmOpen = false;
      removeTarget = null;
    }
  }
</script>

<nav
  class="glass-panel flex h-full w-14 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden rounded-none py-3 md:rounded-2xl"
  data-testid="server-sidebar"
  aria-label="Server-Instanzen"
>
  <Tooltip.Provider delayDuration={200}>
    {#if cloud}
      <ServerIconButton
        server={cloud}
        active={activeServer.serverId === cloud.id}
        state={serverState.get(cloud.id).state}
        onPick={() => cloud && activeServer.set(cloud.id)}
        onInfo={() => cloud && openInfo(cloud)}
        onNotif={(m) => cloud && setNotif(cloud, m)}
      />
    {/if}

    <div class="bg-border my-1 h-px w-8 shrink-0" aria-hidden="true"></div>

    {#each selfHosts as server (server.id)}
      <ServerIconButton
        {server}
        active={activeServer.serverId === server.id}
        state={serverState.get(server.id).state}
        onPick={() => activeServer.set(server.id)}
        onInfo={() => openInfo(server)}
        onNotif={(m) => setNotif(server, m)}
        onRemove={() => openRemove(server)}
      />
    {/each}

    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            class="border-primary/30 text-primary flex size-10 shrink-0 items-center justify-center rounded-2xl border border-dashed bg-bg-input transition-all hover:rounded-xl hover:bg-bg-hover"
            onclick={() => (addOpen = true)}
            data-testid="server-add"
            aria-label="Server hinzufügen"
          >
            <PlusIcon class="size-5" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right">Server hinzufügen</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
</nav>

<AddServerDialog open={addOpen} onClose={() => (addOpen = false)} />

<AlertDialog.Root bind:open={removeConfirmOpen}>
  <AlertDialog.Content data-testid="remove-server-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>Server entfernen?</AlertDialog.Title>
      <AlertDialog.Description>
        {removeTarget?.label ?? 'Dieser Server'} wird aus deiner Liste entfernt. Deine
        Daten auf dem Server bleiben dort — nur die lokale Verknüpfung wird gelöscht.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Abbrechen</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmRemove} data-testid="remove-server-confirm">
        Entfernen
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<ServerInfoDialog bind:open={infoOpen} server={infoTarget} />
