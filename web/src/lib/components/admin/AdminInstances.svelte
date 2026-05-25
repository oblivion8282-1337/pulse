<!--
  Admin: Self-Host-Instanzen und Anträge verwalten.
  3 Tabs: Ausstehende Anträge · Aktive Instanzen · Gesperrte Instanzen.
  Inhalte ausgelagert in AdminInstancesPending / Active / Suspended.
-->
<script lang="ts">
  import AdminInstancesPending from './AdminInstancesPending.svelte';
  import AdminInstancesActive from './AdminInstancesActive.svelte';
  import AdminInstancesSuspended from './AdminInstancesSuspended.svelte';
  import ServerIcon from '@lucide/svelte/icons/server';

  type Tab = 'pending' | 'active' | 'suspended';
  let activeTab = $state<Tab>('pending');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'pending', label: 'Ausstehend' },
    { id: 'active', label: 'Aktiv' },
    { id: 'suspended', label: 'Gesperrt' }
  ];
</script>

<section
  class="rounded-2xl border border-border bg-bg-input p-5"
  data-testid="admin-instances"
>
  <div class="mb-4 flex items-start gap-3">
    <ServerIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold">Self-Host-Instanzen</h2>
      <p class="text-text-muted text-xs mt-0.5">
        Anträge prüfen, Instanzen verwalten und Secrets rotieren.
      </p>
    </div>
  </div>

  <!-- Tab-Bar -->
  <div class="mb-4 flex gap-1 border-b border-border">
    {#each tabs as t (t.id)}
      <button
        type="button"
        onclick={() => (activeTab = t.id)}
        class="px-3 py-2 text-sm transition-colors border-b-2 -mb-px {activeTab === t.id
          ? 'border-primary text-text-bright font-medium'
          : 'border-transparent text-text-muted hover:text-text-base'}"
        data-testid="instances-tab-{t.id}"
      >
        {t.label}
      </button>
    {/each}
  </div>

  {#if activeTab === 'pending'}
    <AdminInstancesPending />
  {:else if activeTab === 'active'}
    <AdminInstancesActive />
  {:else}
    <AdminInstancesSuspended />
  {/if}
</section>
