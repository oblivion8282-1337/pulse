<!--
  Admin: Liste offener Hosting-Anträge (BEIDE Arten: VPS + App-Host,
  vereintes Antragssystem) + Approve/Reject über die vereinten Pfade.
  Approve öffnet einen Confirm-Dialog; bei Erfolg nur ein Toast (kein Secret —
  der VPS-Eigentümer richtet den Server über „Server einrichten" ein, der
  App-Host bekommt Flag + auto-provisionierte Instanz).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { adminInstancesApi, type AdminApplication } from '$lib/api/instances';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  // Eltern (AdminInstances) hält den Pending-Badge-Count — nach jeder
  // Approve/Reject-Aktion Bescheid geben, damit das Badge live stimmt.
  let { onchange }: { onchange?: () => void } = $props();

  let apps = $state<AdminApplication[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Approve flow — nach Erfolg nur ein Toast (kein Dialog, kein Secret: der
  // Eigentümer richtet den Server über „Server einrichten" ein, das die
  // Zugangsdaten per Bootstrap-Token automatisch + rotiert überträgt).
  let approveTarget = $state<AdminApplication | null>(null);
  let approveConfirmOpen = $state(false);

  // Reject flow
  let rejectTarget = $state<AdminApplication | null>(null);
  let rejectOpen = $state(false);
  let rejectReason = $state('');
  let rejecting = $state(false);
  let approving = $state(false);
  let rejectError = $state<string | null>(null);

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  // Anschluss-Check-Chip (nur Info, keine Logik daran): ok=grün,
  // blocked/cgnat/symmetric=rot, unknown/nicht geprüft=neutral.
  function netCheckLabel(v: AdminApplication['network_check']): string {
    if (v === 'ok') return m.admin_net_check_ok();
    if (v === 'blocked' || v === 'cgnat' || v === 'symmetric') return m.admin_net_check_bad();
    return m.admin_net_check_unknown();
  }

  function netCheckClass(v: AdminApplication['network_check']): string {
    if (v === 'ok') return 'bg-success/20 text-success';
    if (v === 'blocked' || v === 'cgnat' || v === 'symmetric') return 'bg-destructive/20 text-destructive';
    return 'bg-bg-hover text-text-muted';
  }

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      apps = await adminInstancesApi.listApplications('pending', 'all');
    } catch (e) {
      loadError = errMsg(e);
    } finally {
      loading = false;
    }
  }

  async function doApprove() {
    // approving-Guard (wie rejecting bei doReject): die Genehmigung ist
    // IRREVERSIBEL (Worker-IDs werden nie wiederverwendet). Ohne Guard feuert
    // ein Doppelklick auf "Bestätigen" zwei approveApplication-Calls — der zweite
    // bringt im besten Fall einen verwirrenden 409 auf eine erfolgreiche Aktion.
    if (!approveTarget || approving) return;
    approving = true;
    const id = approveTarget.id;
    const username = approveTarget.applicant_username;
    busy[id] = true;
    approveConfirmOpen = false;
    try {
      await adminInstancesApi.approveApplication(id);
      apps = apps.filter((a) => a.id !== id);
      onchange?.();
      toast.success(m.admin_instances_pending_approved({ username }));
    } catch (e) {
      toast.error(m.admin_instances_pending_approve_failed(), {
        description: errMsg(e)
      });
    } finally {
      approving = false;
      busy[id] = false;
      approveTarget = null;
    }
  }

  async function doReject() {
    if (!rejectTarget || !rejectReason.trim()) return;
    rejecting = true;
    rejectError = null;
    try {
      await adminInstancesApi.rejectApplication(rejectTarget.id, rejectReason.trim());
      apps = apps.filter((a) => a.id !== rejectTarget!.id);
      onchange?.();
      toast.success(m.admin_instances_pending_rejected({ username: rejectTarget.applicant_username }));
      rejectOpen = false;
      rejectReason = '';
      rejectTarget = null;
    } catch (e) {
      rejectError = errMsg(e);
    } finally {
      rejecting = false;
    }
  }

</script>

{#if loading}
  <LoadingState label={m.admin_instances_pending_loading()} />
{:else if loadError}
  <FieldError message={m.admin_instances_pending_load_error({ error: loadError })} />
{:else if apps.length === 0}
  <EmptyState message={m.admin_instances_pending_empty()} />
{:else}
  <div class="flex flex-col gap-2">
    {#each apps as app (app.id)}
      <div class="border-border bg-bg-hover/30 rounded-xl border p-3 flex flex-col gap-2"
           data-testid="pending-app-{app.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium">
              {app.origin === 'app_host' ? app.applicant_username : app.hostname}
            </p>
            <p class="text-text-muted text-xs mt-0.5">
              {app.applicant_username} · {app.contact_email}
              {#if app.origin === 'app_host'}· {app.purpose}{/if}
            </p>
            {#if app.origin === 'app_host' && app.notes}
              <p class="text-text-base text-xs mt-1 italic">{app.notes}</p>
            {/if}
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <p class="text-text-muted text-xs">
              {new Date(app.created_at).toLocaleDateString('de-DE')}
            </p>
            <div class="flex items-center gap-1.5">
              <span class="border-border text-text-muted rounded-full border px-2 py-0.5 text-xs"
                    data-testid="admin-app-origin-chip">
                {app.origin === 'app_host' ? m.hosting_origin_app() : m.hosting_origin_vps()}
              </span>
              {#if app.origin === 'app_host'}
                <span class="rounded-full px-2 py-0.5 text-xs font-medium {netCheckClass(app.network_check)}"
                      data-testid="admin-net-check-chip">
                  {m.admin_net_check_label()}: {netCheckLabel(app.network_check)}
                </span>
              {/if}
            </div>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            onclick={() => { approveTarget = app; approveConfirmOpen = true; }}
            disabled={!!busy[app.id]}
            class="rounded-lg bg-success px-3 py-1.5 text-xs text-black font-medium hover:bg-success/90 disabled:opacity-60 transition-colors"
          >
            {m.admin_instances_pending_approve_btn()}
          </button>
          <button
            type="button"
            onclick={() => { rejectTarget = app; rejectOpen = true; }}
            disabled={!!busy[app.id]}
            class="rounded-lg bg-destructive/80 px-3 py-1.5 text-xs text-white font-medium hover:bg-destructive disabled:opacity-60 transition-colors"
          >
            {m.admin_instances_pending_reject_btn()}
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Approve Confirm -->
<Dialog.Root bind:open={approveConfirmOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="approve-confirm-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_instances_pending_confirm_title()}</Dialog.Title>
        <Dialog.Description>
          {approveTarget?.origin === 'app_host'
            ? `${m.hosting_apply_mode_app_title()} — ${approveTarget?.applicant_username}`
            : `${approveTarget?.hostname} — ${approveTarget?.applicant_username}`}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (approveConfirmOpen = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          {m.admin_instances_pending_cancel()}
        </button>
        <button type="button" onclick={doApprove} disabled={approving}
          class="rounded-xl bg-success px-4 py-2 text-sm text-black font-medium hover:bg-success/90 disabled:opacity-60">
          {m.admin_instances_pending_confirm_approve()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>


<!-- Reject Dialog -->
<Dialog.Root bind:open={rejectOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="reject-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_instances_pending_reject_title()}</Dialog.Title>
        <Dialog.Description>
          {rejectTarget?.origin === 'app_host'
            ? rejectTarget?.applicant_username
            : rejectTarget?.hostname}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="reject-reason">{m.admin_instances_pending_reject_reason_label()}</label>
        <textarea
          id="reject-reason"
          bind:value={rejectReason}
          rows="3"
          maxlength="1000"
          class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        <FieldError message={rejectError} />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (rejectOpen = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          {m.admin_instances_pending_cancel()}
        </button>
        <button type="button" onclick={doReject} disabled={rejecting || !rejectReason.trim()}
          class="rounded-xl bg-destructive/80 px-4 py-2 text-sm text-white font-medium hover:bg-destructive disabled:opacity-60">
          {rejecting ? m.admin_instances_pending_rejecting() : m.admin_instances_pending_reject_btn()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
