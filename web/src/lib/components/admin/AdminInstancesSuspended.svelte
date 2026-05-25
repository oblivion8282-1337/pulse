<!--
  Admin: Gesperrte Self-Host-Instanzen + Entsperren-Aktion.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminInstancesApi, type AdminInstance } from '$lib/api/instances';

  let instances = $state<AdminInstance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<number, boolean>>({});

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      instances = await adminInstancesApi.listInstances('suspended');
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
      toast.success(`Instanz ${inst.hostname} entsperrt.`);
    } catch (e) {
      toast.error('Entsperren fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[inst.id] = false;
    }
  }
</script>

{#if loading}
  <p class="text-text-muted text-sm">Lade…</p>
{:else if loadError}
  <p class="text-red-400 text-sm">Fehler: {loadError}</p>
{:else if instances.length === 0}
  <p class="text-text-muted text-sm">Keine gesperrten Instanzen.</p>
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
          class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white font-medium hover:bg-emerald-500 disabled:opacity-60 transition-colors shrink-0"
        >
          {busy[inst.id] ? 'Wird entsperrt…' : 'Entsperren'}
        </button>
      </div>
    {/each}
  </div>
{/if}
