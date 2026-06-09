<!--
  Admin: Liste offener Self-Host-Anträge + Approve/Reject-Aktionen.
  Approve öffnet Confirm-Dialog; bei Erfolg wird das client_secret EINMALIG
  im SecretDialog angezeigt — kein auto-dismiss, User muss explizit klicken.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { adminInstancesApi, type AdminApplication, type Approval } from '$lib/api/instances';
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import CheckIcon from '@lucide/svelte/icons/check';

  // Eltern (AdminInstances) hält den Pending-Badge-Count — nach jeder
  // Approve/Reject-Aktion Bescheid geben, damit das Badge live stimmt.
  let { onchange }: { onchange?: () => void } = $props();

  let apps = $state<AdminApplication[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Approve flow
  let approveTarget = $state<AdminApplication | null>(null);
  let approveConfirmOpen = $state(false);
  let secretResult = $state<Approval | null>(null);
  let secretDialogOpen = $state(false);
  let copied = $state(false);

  // Reject flow
  let rejectTarget = $state<AdminApplication | null>(null);
  let rejectOpen = $state(false);
  let rejectReason = $state('');
  let rejecting = $state(false);
  let rejectError = $state<string | null>(null);

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      apps = await adminInstancesApi.listApplications('pending');
    } catch (e) {
      loadError = errMsg(e);
    } finally {
      loading = false;
    }
  }

  async function doApprove() {
    if (!approveTarget) return;
    const id = approveTarget.id;
    busy[id] = true;
    approveConfirmOpen = false;
    try {
      const result = await adminInstancesApi.approveApplication(id);
      apps = apps.filter((a) => a.id !== id);
      onchange?.();
      secretResult = result;
      secretDialogOpen = true;
    } catch (e) {
      toast.error(m.admin_instances_pending_approve_failed(), {
        description: errMsg(e)
      });
    } finally {
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

  async function copySecret() {
    if (!secretResult?.client_secret) return;
    await navigator.clipboard.writeText(secretResult.client_secret);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }


</script>

{#if loading}
  <p class="text-text-muted text-sm">{m.admin_instances_pending_loading()}</p>
{:else if loadError}
  <p class="text-red-400 text-sm">{m.admin_instances_pending_load_error({ error: loadError })}</p>
{:else if apps.length === 0}
  <p class="text-text-muted text-sm">{m.admin_instances_pending_empty()}</p>
{:else}
  <div class="flex flex-col gap-2">
    {#each apps as app (app.id)}
      <div class="border-border bg-bg-hover/30 rounded-xl border p-3 flex flex-col gap-2"
           data-testid="pending-app-{app.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium">{app.hostname}</p>
            <p class="text-text-muted text-xs mt-0.5">
              {app.applicant_username} · {app.purpose} · {m.admin_instances_pending_user_count({ count: app.expected_users })}
            </p>
            <p class="text-text-muted text-xs">{app.contact_email}</p>
            {#if app.notes}
              <p class="text-text-base text-xs mt-1 italic">{app.notes}</p>
            {/if}
          </div>
          <p class="text-text-muted text-xs shrink-0">
            {new Date(app.created_at).toLocaleDateString('de-DE')}
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            onclick={() => { approveTarget = app; approveConfirmOpen = true; }}
            disabled={!!busy[app.id]}
            class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white font-medium hover:bg-emerald-500 disabled:opacity-60 transition-colors"
          >
            {m.admin_instances_pending_approve_btn()}
          </button>
          <button
            type="button"
            onclick={() => { rejectTarget = app; rejectOpen = true; }}
            disabled={!!busy[app.id]}
            class="rounded-lg bg-red-600/80 px-3 py-1.5 text-xs text-white font-medium hover:bg-red-500 disabled:opacity-60 transition-colors"
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
          {approveTarget?.hostname} — {approveTarget?.applicant_username}
        </Dialog.Description>
      </Dialog.Header>
      <p class="text-text-muted text-sm">
        {m.admin_instances_pending_confirm_body()}
      </p>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (approveConfirmOpen = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          {m.admin_instances_pending_cancel()}
        </button>
        <button type="button" onclick={doApprove}
          class="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white font-medium hover:bg-emerald-500">
          {m.admin_instances_pending_confirm_approve()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Secret anzeigen — kein auto-dismiss! -->
<Dialog.Root
  open={secretDialogOpen}
  onOpenChange={(v) => { if (!v) { secretDialogOpen = false; secretResult = null; copied = false; } }}
>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="secret-reveal-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_instances_pending_secret_title()}</Dialog.Title>
        <Dialog.Description>{secretResult?.hostname}</Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-3">
        <p class="text-amber-300 text-sm font-medium">{secretResult?.warning}</p>
        <div class="bg-bg-input flex items-center gap-2 rounded-xl border border-border p-3">
          <code class="text-text-bright flex-1 break-all text-xs select-all">
            {secretResult?.client_secret}
          </code>
          <button type="button" onclick={copySecret}
            class="text-text-muted hover:text-text-bright shrink-0 rounded p-1">
            {#if copied}
              <CheckIcon class="size-4 text-emerald-400" />
            {:else}
              <ClipboardIcon class="size-4" />
            {/if}
          </button>
        </div>
        <p class="text-text-muted text-xs">
          {m.admin_instances_pending_secret_client_id()} <code class="text-text-base">{secretResult?.client_id}</code>
        </p>
        <p class="text-text-muted text-xs">
          {m.admin_instances_pending_secret_owner_id()}
          <code class="text-text-base">{secretResult?.owner_user_id}</code>
        </p>
      </div>
      <div class="flex justify-end pt-2">
        <button type="button" onclick={() => { secretDialogOpen = false; secretResult = null; copied = false; }}
          class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium">
          {m.admin_instances_pending_secret_close()}
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
        <Dialog.Description>{rejectTarget?.hostname}</Dialog.Description>
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
        {#if rejectError}<p class="text-red-400 text-xs">{rejectError}</p>{/if}
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (rejectOpen = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          {m.admin_instances_pending_cancel()}
        </button>
        <button type="button" onclick={doReject} disabled={rejecting || !rejectReason.trim()}
          class="rounded-xl bg-red-600/80 px-4 py-2 text-sm text-white font-medium hover:bg-red-500 disabled:opacity-60">
          {rejecting ? m.admin_instances_pending_rejecting() : m.admin_instances_pending_reject_btn()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
