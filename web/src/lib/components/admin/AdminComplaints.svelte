<!--
  Cloud-Admin: Missbrauchsmeldungen (Beschwerden) sichten und bearbeiten.
  Zwei Ansichten: Offen (neu + Alt-Status in Arbeit) · Erledigt (abgeschlossen +
  weitergeleitet). Inhalt je Ansicht in AdminComplaintsList (per {#key} neu gemountet).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import AdminComplaintsList from './AdminComplaintsList.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { adminComplaintsApi } from '$lib/api/complaints';
  import { pendingComplaints } from '$lib/stores/pendingComplaints.svelte';

  // Zwei Ansichten statt vier Status-Tabs: Offen (neu/in Arbeit) und Erledigt
  // (abgeschlossen ODER weitergeleitet).
  type ComplaintView = 'open' | 'closed';
  let activeTab = $state<ComplaintView>('open');

  // Wie viele neue (unbearbeitete) Meldungen warten? Ohne Zähler merkt ein
  // Cloud-Admin nicht, dass etwas reingekommen ist (keine Push-Notification).
  let newCount = $state<number | null>(null);

  async function refreshNewCount() {
    try {
      newCount = (await adminComplaintsApi.list('new')).length;
    } catch {
      newCount = null; // Fehler still — Badge bleibt aus.
    }
    // Footer-Badge (gelber Punkt über dem Icon) mitziehen, damit sie sofort
    // sinkt, wenn hier eine Meldung bearbeitet wird — nicht erst beim Poll-Tick.
    pendingComplaints.refresh();
  }

  onMount(refreshNewCount);

  const tabs: { id: ComplaintView; label: string }[] = [
    { id: 'open', label: m.admin_complaints_tab_open() },
    { id: 'closed', label: m.admin_complaints_tab_resolved() }
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
            class="inline-flex min-w-5 items-center justify-center rounded-full bg-warning px-1.5 py-0.5 text-xs font-semibold text-black"
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
        {#if t.id === 'open' && newCount && newCount > 0}
          <span
            class="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-warning px-1 align-middle text-[10px] font-semibold text-black"
          >
            {newCount}
          </span>
        {/if}
      </button>
    {/each}
  </div>

  {#key activeTab}
    <AdminComplaintsList view={activeTab} onchange={refreshNewCount} />
  {/key}
</section>
