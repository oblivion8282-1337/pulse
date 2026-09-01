<!--
  Admin: Self-Host-Instanzen und Anträge verwalten.
  3 Tabs: Ausstehende Anträge · Aktive Instanzen · Gesperrte Instanzen.
  Inhalte ausgelagert in AdminInstancesPending / Active / Suspended.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import AdminInstancesPending from './AdminInstancesPending.svelte';
  import AdminInstancesActive from './AdminInstancesActive.svelte';
  import AdminInstancesSuspended from './AdminInstancesSuspended.svelte';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { m } from '$lib/paraglide/messages.js';
  import { adminInstancesApi } from '$lib/api/instances';
  import AdminTabBar from './AdminTabBar.svelte';

  type Tab = 'pending' | 'active' | 'suspended';
  let activeTab = $state<Tab>('pending');

  // Pending-Antrags-Counter: ohne ihn merkt ein Cloud-Admin gar nicht, dass ein
  // neuer Self-Host-Antrag eingegangen ist (es gibt keine Push-Notification).
  // Beim Öffnen des Admin-Panels geladen + nach jeder Approve/Reject-Aktion
  // (Callback aus AdminInstancesPending) neu gezogen.
  let pendingCount = $state<number | null>(null);

  async function refreshPendingCount() {
    try {
      // Beide Antragsarten (vereintes Antragssystem) — der Badge zählt alles,
      // was auf eine Entscheidung wartet.
      const apps = await adminInstancesApi.listApplications('pending', 'all');
      pendingCount = apps.length;
    } catch {
      pendingCount = null; // Fehler still — Badge bleibt einfach aus.
    }
  }

  onMount(refreshPendingCount);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'pending', label: m.admin_instances_tab_pending() },
    { id: 'active', label: m.admin_instances_tab_active() },
    { id: 'suspended', label: m.admin_instances_tab_suspended() }
  ];
</script>

<section
  class="rounded-2xl border border-border bg-bg-input p-5"
  data-testid="admin-instances"
>
  <div class="mb-4 flex items-start gap-3">
    <ServerIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold flex items-center gap-2">
        {m.admin_instances_heading()}
        {#if pendingCount && pendingCount > 0}
          <span
            class="inline-flex min-w-5 items-center justify-center rounded-full bg-warning px-1.5 py-0.5 text-xs font-semibold text-black"
            title={m.admin_instances_pending_badge({ count: pendingCount })}
            data-testid="instances-pending-badge"
          >
            {pendingCount}
          </span>
        {/if}
      </h2>
      <p class="text-text-muted text-xs mt-0.5">
        {m.admin_instances_description()}
      </p>
    </div>
  </div>

  <!-- Tab-Bar -->
  <AdminTabBar
    bind:active={activeTab}
    {tabs}
    testIdPrefix="instances-tab"
    badgeTab="pending"
    badgeCount={pendingCount}
  />

  {#if activeTab === 'pending'}
    <AdminInstancesPending onchange={refreshPendingCount} />
  {:else if activeTab === 'active'}
    <AdminInstancesActive />
  {:else}
    <AdminInstancesSuspended />
  {/if}
</section>
