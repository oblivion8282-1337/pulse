<!--
  Admin: App-Hosting-Antrag ablehnen (mit Pflicht-Begründung).

  Eigene Komponente aus demselben Grund wie [[AdminAppHostRevoke]]: hält
  AdminAppHostApplications unter der 250-Zeilen-Policy. Knopf + Dialog + Aufruf;
  die Liste erfährt über `onrejected` davon und entfernt den Eintrag.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import {
    adminAppHostApplicationsApi,
    type AdminAppHostApplication
  } from '$lib/api/appHostApplications';

  let {
    app,
    disabled = false,
    onrejected
  }: { app: AdminAppHostApplication; disabled?: boolean; onrejected: () => void } = $props();

  let open = $state(false);
  let reason = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function doReject() {
    if (busy || !reason.trim()) return;
    busy = true;
    error = null;
    try {
      await adminAppHostApplicationsApi.rejectApplication(app.id, reason.trim());
      toast.success(m.app_host_admin_rejected_toast({ username: app.applicant_username }));
      open = false;
      reason = '';
      onrejected();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<button
  type="button"
  onclick={() => { error = null; open = true; }}
  {disabled}
  class="rounded-lg bg-red-600/80 px-3 py-1.5 text-xs text-white font-medium hover:bg-red-500 disabled:opacity-60 transition-colors"
>
  {m.app_host_admin_reject_btn()}
</button>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="app-host-reject-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.app_host_admin_reject_title()}</Dialog.Title>
        <Dialog.Description>{app.applicant_username}</Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="app-host-reject-reason">
          {m.app_host_admin_reject_reason_label()}
        </label>
        <textarea
          id="app-host-reject-reason"
          bind:value={reason}
          rows="3"
          maxlength="1000"
          class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        {#if error}<p class="text-red-400 text-xs">{error}</p>{/if}
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (open = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          {m.app_host_admin_cancel()}
        </button>
        <button type="button" onclick={doReject} disabled={busy || !reason.trim()}
          class="rounded-xl bg-red-600/80 px-4 py-2 text-sm text-white font-medium hover:bg-red-500 disabled:opacity-60">
          {busy ? m.app_host_admin_rejecting() : m.app_host_admin_reject_btn()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
