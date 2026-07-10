<!--
  Admin: Liste offener App-Hosting-Freischaltungs-Anträge + Approve/Reject.

  Spiegel von [[AdminInstancesPending]], aber kompakter (kein Hostname,
  keine expected_users, kein Notes-Feld — App-Hosting hat kein Server-
  Setup). Approval setzt ``users.self_host_enabled=true`` in derselben
  Transaktion, danach ist der User sofort freigeschaltet.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import {
    adminAppHostApplicationsApi,
    type AdminAppHostApplication,
    type AppHostApplicationStatus
  } from '$lib/api/appHostApplications';
  import AdminAppHostRevoke from './AdminAppHostRevoke.svelte';
  import AdminAppHostReject from './AdminAppHostReject.svelte';

  // Eltern (AdminPanel-Cloud-Bereich) hält ggf. einen Pending-Badge-Count.
  let { onchange }: { onchange?: () => void } = $props();

  // Tabs wie bei [[AdminInstances]] — dort sind es Instanz-Zustände
  // (aktiv/gesperrt), hier Antrags-Zustände. Entschieden/erledigte Anträge
  // waren bisher gar nicht einsehbar: die Liste zeigte nur 'pending'.
  const tabs: { id: AppHostApplicationStatus; label: string }[] = [
    { id: 'pending', label: m.self_host_application_status_pending() },
    { id: 'approved', label: m.self_host_application_status_approved() },
    { id: 'rejected', label: m.self_host_application_status_rejected() },
    { id: 'revoked', label: m.app_host_admin_status_revoked() }
  ];
  let activeTab = $state<AppHostApplicationStatus>('pending');

  let apps = $state<AdminAppHostApplication[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Approve flow
  let approveTarget = $state<AdminAppHostApplication | null>(null);
  let approveConfirmOpen = $state(false);
  let approving = $state(false);
  let approveError = $state<string | null>(null);

  /** Nach Ablehnen/Rücknahme: Eintrag aus der Liste + Badge nachziehen.
   *  (Der Antrag wechselt den Status und gehört damit in einen anderen Tab.) */
  function removeFromList(appId: string) {
    apps = apps.filter((a) => a.id !== appId);
    onchange?.();
  }

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      apps = await adminAppHostApplicationsApi.listApplications(activeTab);
    } catch (e) {
      loadError = errMsg(e);
    } finally {
      loading = false;
    }
  }

  async function selectTab(id: AppHostApplicationStatus) {
    if (id === activeTab) return;
    activeTab = id;
    apps = [];
    await reload();
  }

  async function doApprove() {
    const target = approveTarget;
    if (!target || approving) return;
    approving = true;
    approveError = null;
    busy[target.id] = true;
    approveConfirmOpen = false;
    try {
      await adminAppHostApplicationsApi.approveApplication(target.id);
      apps = apps.filter((a) => a.id !== target.id);
      onchange?.();
      toast.success(m.app_host_admin_approved_toast({ username: target.applicant_username }));
    } catch (e) {
      approveError = errMsg(e);
      toast.error(m.app_host_admin_action_failed(), { description: errMsg(e) });
    } finally {
      approving = false;
      busy[target.id] = false;
      approveTarget = null;
    }
  }

</script>

<!-- Tab-Bar (Markup gespiegelt von AdminInstances.svelte) -->
<div class="mb-4 flex gap-1 border-b border-border">
  {#each tabs as t (t.id)}
    <button
      type="button"
      onclick={() => void selectTab(t.id)}
      class="px-3 py-2 text-sm transition-colors border-b-2 -mb-px {activeTab === t.id
        ? 'border-primary text-text-bright font-medium'
        : 'border-transparent text-text-muted hover:text-text-base'}"
      data-testid="app-host-tab-{t.id}"
    >
      {t.label}
    </button>
  {/each}
</div>

{#if loading}
  <p class="text-text-muted text-sm">{m.app_host_admin_loading()}</p>
{:else if loadError}
  <p class="text-red-400 text-sm">{m.app_host_admin_load_error({ error: loadError })}</p>
{:else if apps.length === 0}
  <p class="text-text-muted text-sm">
    {activeTab === 'pending' ? m.app_host_admin_empty() : m.app_host_admin_empty_tab()}
  </p>
{:else}
  <div class="flex flex-col gap-2">
    {#each apps as app (app.id)}
      <div class="border-border bg-bg-hover/30 rounded-xl border p-3 flex flex-col gap-2"
           data-testid="pending-app-host-{app.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium">{app.applicant_username}</p>
            <p class="text-text-muted text-xs mt-0.5">{app.purpose}</p>
            {#if app.message}
              <p class="text-text-base text-xs mt-1 italic">{app.message}</p>
            {/if}
          </div>
          <p class="text-text-muted text-xs shrink-0">
            {new Date(app.created_at).toLocaleDateString('de-DE')}
          </p>
        </div>
        <!-- Aktionen nur auf offenen Anträgen: ein entschiedener Antrag lässt
             sich serverseitig nicht erneut genehmigen/ablehnen (409). -->
        {#if app.status === 'pending'}
          <div class="flex gap-2">
            <button
              type="button"
              onclick={() => { approveError = null; approveTarget = app; approveConfirmOpen = true; }}
              disabled={!!busy[app.id]}
              class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white font-medium hover:bg-emerald-500 disabled:opacity-60 transition-colors"
            >
              {m.app_host_admin_approve_btn()}
            </button>
            <AdminAppHostReject
              {app}
              disabled={!!busy[app.id]}
              onrejected={() => removeFromList(app.id)}
            />
          </div>
        {:else if app.status === 'approved'}
          <AdminAppHostRevoke {app} onrevoked={() => removeFromList(app.id)} />
        {:else if app.rejection_reason}
          <p class="text-text-muted text-xs italic">{app.rejection_reason}</p>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<!-- Approve Confirm -->
<Dialog.Root bind:open={approveConfirmOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="app-host-approve-confirm-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.app_host_admin_confirm_title()}</Dialog.Title>
        <Dialog.Description>
          {approveTarget?.applicant_username} — {approveTarget?.purpose}
        </Dialog.Description>
      </Dialog.Header>
      <p class="text-text-muted text-sm">{m.app_host_admin_confirm_body()}</p>
      {#if approveError}<p class="text-red-400 text-xs mt-2">{approveError}</p>{/if}
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (approveConfirmOpen = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          {m.app_host_admin_cancel()}
        </button>
        <button type="button" onclick={doApprove} disabled={approving}
          class="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white font-medium hover:bg-emerald-500 disabled:opacity-60">
          {approving ? m.app_host_admin_approving() : m.app_host_admin_confirm_approve()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
