<!--
  Cloud-Admin: Missbrauchsmeldungen (Beschwerden) sichten und bearbeiten.
  4 Tabs entlang des Lebenszyklus: Neu · In Bearbeitung · Weitergeleitet · Erledigt.
  Inhalt je Tab in AdminComplaintsList (per {#key} neu gemountet).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import AdminComplaintsList from './AdminComplaintsList.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { adminComplaintsApi, type ComplaintStatus } from '$lib/api/complaints';

  let activeTab = $state<ComplaintStatus>('new');

  // Wie viele neue (unbearbeitete) Meldungen warten? Ohne Zähler merkt ein
  // Cloud-Admin nicht, dass etwas reingekommen ist (keine Push-Notification).
  let newCount = $state<number | null>(null);

  async function refreshNewCount() {
    try {
      newCount = (await adminComplaintsApi.list('new')).length;
    } catch {
      newCount = null; // Fehler still — Badge bleibt aus.
    }
  }

  onMount(refreshNewCount);

  const tabs: { id: ComplaintStatus; label: string }[] = [
    { id: 'new', label: m.admin_complaints_tab_new() },
    { id: 'acknowledged', label: m.admin_complaints_tab_acknowledged() },
    { id: 'forwarded', label: m.admin_complaints_tab_forwarded() },
    { id: 'resolved', label: m.admin_complaints_tab_resolved() }
  ];
</script>

<section class="border-border bg-bg-input rounded-2xl border p-5" data-testid="admin-complaints">
  <div class="mb-4 flex items-start gap-3">
    <FlagIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright flex items-center gap-2 text-base font-semibold">
        {m.admin_complaints_heading()}
        {#if newCount && newCount > 0}
          <span
            class="inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-semibold text-white"
            title={m.admin_complaints_new_badge({ count: newCount })}
            data-testid="complaints-new-badge"
          >
            {newCount}
          </span>
        {/if}
      </h2>
      <p class="text-text-muted mt-0.5 text-xs">{m.admin_complaints_description()}</p>
    </div>
  </div>

  <div class="border-border mb-4 flex gap-1 border-b">
    {#each tabs as t (t.id)}
      <button
        type="button"
        onclick={() => (activeTab = t.id)}
        class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors {activeTab === t.id
          ? 'border-primary text-text-bright font-medium'
          : 'text-text-muted hover:text-text-base border-transparent'}"
        data-testid="complaints-tab-{t.id}"
      >
        {t.label}
        {#if t.id === 'new' && newCount && newCount > 0}
          <span
            class="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 align-middle text-[10px] font-semibold text-white"
          >
            {newCount}
          </span>
        {/if}
      </button>
    {/each}
  </div>

  {#key activeTab}
    <AdminComplaintsList status={activeTab} onchange={refreshNewCount} />
  {/key}
</section>
