<!--
  Admin: Gesperrte Self-Host-Instanzen + Entsperren-Aktion.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminInstancesApi, type AdminInstance } from '$lib/api/instances';
  import { m } from '$lib/paraglide/messages.js';

  let instances = $state<AdminInstance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      // Gleicher UI-Filter wie im Aktiv-Tab: app_host-Instanzen leben im
      // App-Hosting-Anträge-Tab, nicht hier.
      instances = (await adminInstancesApi.listInstances('suspended')).filter(
        (i) => i.origin !== 'app_host'
      );
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function unsuspend(inst: AdminInstance) {
    busy[inst.id] = true;
    try {
      await adminInstancesApi.unsuspendInstance(inst.id);
      instances = instances.filter((i) => i.id !== inst.id);
      toast.success(m.admin_instances_suspended_unsuspend_success({ hostname: inst.hostname }));
    } catch (e) {
      toast.error(m.admin_instances_suspended_unsuspend_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[inst.id] = false;
    }
  }
</script>

{#if loading}
  <p class="text-text-muted text-sm">{m.admin_instances_suspended_loading()}</p>
{:else if loadError}
  <p class="text-destructive text-sm">{m.admin_instances_suspended_load_error({ error: loadError })}</p>
{:else if instances.length === 0}
  <p class="text-text-muted text-sm">{m.admin_instances_suspended_empty()}</p>
{:else}
  <div class="flex flex-col gap-2">
    {#each instances as inst (inst.id)}
      <div class="border-border bg-bg-hover/30 rounded-xl border p-3 flex items-start justify-between gap-3"
           data-testid="suspended-instance-{inst.id}">
        <div class="min-w-0">
          <p class="text-text-bright text-sm font-medium">{inst.hostname}</p>
          <p class="text-text-muted text-xs mt-0.5">
            {inst.registrar_username} · {new Date(inst.registered_at).toLocaleDateString('de-DE')}
          </p>
        </div>
        <button
          type="button"
          onclick={() => void unsuspend(inst)}
          disabled={!!busy[inst.id]}
          class="rounded-lg bg-success px-3 py-1.5 text-xs text-black font-medium hover:bg-success/90 disabled:opacity-60 transition-colors shrink-0"
        >
          {busy[inst.id] ? m.admin_instances_suspended_unsuspending() : m.admin_instances_suspended_unsuspend_button()}
        </button>
      </div>
    {/each}
  </div>
{/if}
