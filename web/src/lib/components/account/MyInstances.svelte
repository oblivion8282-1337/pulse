<!--
  Liste der eigenen Self-Host-Instanzen im Einstellungs-Dialog.
  Endpoint: GET /me/instances (Cookie-Auth via instancesApi).

  Der Server wird ausschließlich über „Server einrichten" (Ein-Befehl-Installer,
  InstanceSetupDialog) aufgesetzt — die Zugangsdaten werden dabei automatisch
  und sicher übertragen. Kein manueller .env-/Secret-Umgang mehr.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import InstanceSetupDialog from './InstanceSetupDialog.svelte';
  import ServerIcon from '@lucide/svelte/icons/server';
  import TerminalIcon from '@lucide/svelte/icons/terminal';

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let setupOpen = $state(false);
  let setupInstance = $state<Instance | null>(null);

  function openSetup(inst: Instance) {
    setupInstance = inst;
    setupOpen = true;
  }

  onMount(async () => {
    try {
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
                ID: {inst.client_id.slice(0, 12)}… ·
                Workers: {inst.worker_id_chat}/{inst.worker_id_voice}/{inst.worker_id_media} ·
                {new Date(inst.registered_at).toLocaleDateString('de-DE')}
              </p>
            </div>
            <span class="rounded-full px-2 py-0.5 text-xs font-medium shrink-0 {statusClass(inst.status)}">
              {inst.status === 'active' ? m.my_instances_status_active() : m.my_instances_status_suspended()}
            </span>
          </div>
          <div class="flex flex-wrap gap-2 mt-1">
            <button
              type="button"
              onclick={() => openSetup(inst)}
              class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 transition-colors"
              data-testid="instance-setup-btn-{inst.id}"
            >
              <TerminalIcon class="size-3.5" />
              {m.instance_setup_button()}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Ein-Befehl-Installer -->
<InstanceSetupDialog bind:open={setupOpen} instance={setupInstance} />
