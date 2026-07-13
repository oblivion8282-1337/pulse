<!--
  Admin: erteilte App-Host-Freischaltungen (genehmigte app_host-Anträge) mit
  Revoke-Knopf. Die Pending-/Reject-Flows leben seit dem vereinten
  Antragssystem im vereinten Tab (AdminInstancesPending) — hier bleibt nur
  die Rücknahme erhalten, weil sie einen eigenen (nicht-vereinten) Endpoint
  hat und nur auf genehmigten app_host-Anträgen sinnvoll ist.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { adminInstancesApi, type AdminApplication } from '$lib/api/instances';
  import AdminAppHostRevoke from './AdminAppHostRevoke.svelte';

  let apps = $state<AdminApplication[]>([]);
  let loading = $state(true);

  onMount(async () => {
    await reload();
  });

  async function reload() {
    loading = true;
    try {
      apps = await adminInstancesApi.listApplications('approved', 'app_host');
    } catch {
      // still — Liste bleibt leer, nächstes Öffnen versucht es erneut
    } finally {
      loading = false;
    }
  }
</script>

{#if loading}
  <p class="text-text-muted text-sm">{m.app_host_admin_loading()}</p>
{:else if apps.length === 0}
  <p class="text-text-muted text-sm">{m.admin_app_host_grants_empty()}</p>
{:else}
  <div class="flex flex-col gap-2">
    {#each apps as app (app.id)}
      <div class="border-border bg-bg-hover/30 flex items-center justify-between gap-3 rounded-xl border p-3"
           data-testid="app-host-grant-{app.id}">
        <div class="min-w-0">
          <p class="text-text-bright text-sm font-medium">{app.applicant_username}</p>
          <p class="text-text-muted text-xs mt-0.5">
            {app.purpose} · {new Date(app.created_at).toLocaleDateString('de-DE')}
          </p>
        </div>
        <AdminAppHostRevoke {app} onrevoked={() => (apps = apps.filter((a) => a.id !== app.id))} />
      </div>
    {/each}
  </div>
{/if}
