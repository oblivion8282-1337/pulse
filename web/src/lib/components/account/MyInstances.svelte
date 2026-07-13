<!--
  Liste der eigenen Self-Host-Instanzen im Einstellungs-Dialog.
  Endpoint: GET /me/instances (Cookie-Auth via instancesApi).

  Der Server wird ausschließlich über „Server einrichten" (Ein-Befehl-Installer,
  InstanceSetupDialog) aufgesetzt — die Zugangsdaten werden dabei automatisch
  und sicher übertragen. Kein manueller .env-/Secret-Umgang mehr.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import { serversStore } from '$lib/api/servers.svelte';
  import { removeServerLocally } from '$lib/api/server-removal';
  import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';
  import InstanceSetupDialog from './InstanceSetupDialog.svelte';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import ServerIcon from '@lucide/svelte/icons/server';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let setupOpen = $state(false);
  let setupInstance = $state<Instance | null>(null);
  let deleteTarget = $state<Instance | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleting = $state(false);

  function openSetup(inst: Instance) {
    setupInstance = inst;
    setupOpen = true;
  }

  function openDelete(inst: Instance) {
    deleteTarget = inst;
    deleteConfirmOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    deleting = true;
    const id = deleteTarget.id;
    try {
      await instancesApi.deleteMyInstance(id);
      instances = instances.filter((i) => i.id !== id);
      // Auch aus der eigenen Server-Leiste entfernen (Match über die
      // Instanz-ID) — andere Geräte/User räumt der Start-Sweep auf
      // (deleted-instance-sweep.ts).
      const localEntry = serversStore.servers.find((s) => s.instance_id === id);
      if (localEntry) removeServerLocally(localEntry.id);
      toast.success(m.my_instances_delete_success());
    } catch {
      toast.error(m.my_instances_delete_error());
    } finally {
      deleting = false;
      deleteConfirmOpen = false;
      deleteTarget = null;
    }
  }

  onMount(async () => {
    // Owner hat seine Instanzen geöffnet → roten „einrichten"-Punkt löschen.
    myInstanceApplications.acknowledge();
    try {
      // App-Host-Instanzen erscheinen als reduzierte Zeile (Status + Löschen):
      // der VPS-Flow ("Server einrichten"-Terminal, .env) ergibt für sie keinen
      // Sinn, aber der Löschweg muss im Client existieren.
      instances = await instancesApi.listMyInstances();
    } catch {
      // Nicht kritisch
    } finally {
      loading = false;
    }
  });

  function statusClass(s: string): string {
    return s === 'active'
      ? 'bg-emerald-500/20 text-emerald-300'
      : 'bg-red-500/20 text-red-300';
  }
</script>

<div class="flex flex-col gap-5" data-testid="my-instances">
  <div class="flex items-start gap-3">
    <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
      <ServerIcon class="size-5" />
    </span>
    <div>
      <h3 class="text-text-bright text-sm font-semibold">{m.my_instances_title()}</h3>
      <p class="text-text-muted text-xs mt-0.5">
        {m.my_instances_subtitle()}
      </p>
    </div>
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">{m.my_instances_loading()}</p>
  {:else if instances.length === 0}
    <p class="text-text-muted text-sm">{m.my_instances_empty()}</p>
  {:else}
    <!-- Setup-Hinweis — nur wenn es überhaupt eine Instanz gibt -->
    <div class="border-border bg-bg-input/40 flex gap-2 rounded-xl border p-3">
      <p class="text-text-muted text-xs leading-relaxed">
        {m.my_instances_secret_hint()}
      </p>
    </div>

    <div class="flex flex-col gap-2">
      {#each instances as inst (inst.id)}
        <div class="border-border bg-bg-input/30 rounded-xl border p-3 flex flex-col gap-2"
             data-testid="instance-row-{inst.id}">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-text-bright text-sm font-medium truncate">{inst.hostname}</p>
              <p class="text-text-muted text-xs mt-0.5">
                {#if inst.origin === 'app_host'}
                  {m.my_instances_apphost_label()} ·
                  {new Date(inst.registered_at).toLocaleDateString('de-DE')}
                {:else}
                  ID: {inst.client_id.slice(0, 12)}… ·
                  Workers: {inst.worker_id_chat}/{inst.worker_id_voice}/{inst.worker_id_media} ·
                  {new Date(inst.registered_at).toLocaleDateString('de-DE')}
                {/if}
              </p>
            </div>
            <span class="rounded-full px-2 py-0.5 text-xs font-medium shrink-0 {statusClass(inst.status)}">
              {inst.status === 'active' ? m.my_instances_status_active() : m.my_instances_status_suspended()}
            </span>
          </div>
          <div class="flex flex-wrap gap-2 mt-1">
            {#if inst.origin !== 'app_host'}
              <!-- Nur VPS: App-Hosts pairen über die Server-App, nicht über
                   Installer-Befehl/.env. -->
              <button
                type="button"
                onclick={() => openSetup(inst)}
                class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 transition-colors"
                data-testid="instance-setup-btn-{inst.id}"
              >
                <TerminalIcon class="size-3.5" />
                {m.instance_setup_button()}
              </button>
            {/if}
            <button
              type="button"
              onclick={() => openDelete(inst)}
              class="flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10 transition-colors"
              data-testid="instance-delete-btn-{inst.id}"
            >
              <Trash2Icon class="size-3.5" />
              {m.my_instances_delete_button()}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Ein-Befehl-Installer -->
<InstanceSetupDialog bind:open={setupOpen} instance={setupInstance} />

<!-- Lösch-Bestätigung -->
<AlertDialog.Root bind:open={deleteConfirmOpen}>
  <AlertDialog.Content data-testid="instance-delete-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.my_instances_delete_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {deleteTarget?.origin === 'app_host'
          ? m.my_instances_apphost_delete_description()
          : m.my_instances_delete_description({ hostname: deleteTarget?.hostname ?? '' })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.my_instances_delete_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={confirmDelete}
        disabled={deleting}
        data-testid="instance-delete-confirm"
      >
        {m.my_instances_delete_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
