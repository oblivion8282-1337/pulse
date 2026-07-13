<!--
  "Anträge"-Reiter (nur Cloud). Seit dem vereinten Antragssystem zeigt der
  Pending-Tab in AdminInstances BEIDE Antragsarten (VPS + App-Host); hier
  bleibt nur noch die Rücknahme erteilter App-Host-Freischaltungen als
  eigener Block (eigener Endpoint, kein vereinter Zwilling). Der Block hängt
  am Feature-Flag; ist es aus, bleibt nur die Instanz-Verwaltung.
-->
<script lang="ts">
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import AdminInstances from './AdminInstances.svelte';
  import AdminAppHostGrants from './AdminAppHostGrants.svelte';
  import { APP_HOSTING_ENABLED } from '$lib/featureFlags';
  import { m } from '$lib/paraglide/messages.js';
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
          <h2 class="text-text-bright text-base font-semibold">
            {m.admin_app_host_grants_heading()}
          </h2>
          <p class="text-text-muted mt-0.5 text-xs">{m.admin_app_host_grants_desc()}</p>
        </div>
      </div>
      <AdminAppHostGrants />
    </section>
  {/if}
</div>
