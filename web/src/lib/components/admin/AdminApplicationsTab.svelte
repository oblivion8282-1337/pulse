<!--
  "Anträge"-Reiter (nur Cloud): Self-Host-Instanzen (AdminInstances mit eigenen
  Unter-Tabs) + App-Host-Anträge. Beides sind Owner-Entscheidungen "wer darf
  hosten". Der App-Host-Block hängt am Feature-Flag; ist es aus, bleibt nur die
  Instanz-Verwaltung.
-->
<script lang="ts">
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import AdminInstances from './AdminInstances.svelte';
  import AdminAppHostApplications from './AdminAppHostApplications.svelte';
  import { pendingAppHostApplications } from '$lib/stores/pendingAppHostApplications.svelte';
  import { APP_HOSTING_ENABLED } from '$lib/featureFlags';
  import { m } from '$lib/paraglide/messages.js';

  let { onAppHostChange }: { onAppHostChange: () => void } = $props();
</script>

<div class="flex flex-col gap-6">
  <AdminInstances />
  {#if APP_HOSTING_ENABLED}
    <section
      class="border-border bg-bg-input rounded-2xl border p-5"
      data-testid="admin-app-host-applications"
    >
      <div class="mb-4 flex items-start gap-3">
        <AppWindowIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
        <div class="min-w-0">
          <h2 class="text-text-bright flex items-center gap-2 text-base font-semibold">
            {m.admin_app_host_heading()}
            {#if pendingAppHostApplications.count > 0}
              <span
                class="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-black"
                title={m.admin_app_host_pending_badge({ count: pendingAppHostApplications.count })}
                data-testid="app-host-pending-badge"
              >
                {pendingAppHostApplications.count}
              </span>
            {/if}
          </h2>
          <p class="text-text-muted mt-0.5 text-xs">{m.admin_app_host_description()}</p>
        </div>
      </div>
      <AdminAppHostApplications onchange={onAppHostChange} />
    </section>
  {/if}
</div>
