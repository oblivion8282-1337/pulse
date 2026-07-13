<!--
  Admin: erteilte App-Hosting-Freischaltung zurücknehmen. Eingebettet in die
  app_host-Zeile im Instanz-„Aktiv"-Tab (AdminInstancesActive) — trägt Knopf +
  Bestätigungsdialog + Aufruf; der Aufrufer erfährt über `onrevoked` davon und
  entfernt die Zeile.

  Wirkung serverseitig (routes_admin_app_host_revoke.py): `self_host_enabled`
  aus UND die auto-provisionierte App-Host-Instanz wird suspendiert — der
  Kill-Switch stoppt einen noch laufenden Container.
-->
<script lang="ts">
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { adminInstancesApi, type AdminApplication } from '$lib/api/instances';

  let { app, onrevoked }: { app: AdminApplication; onrevoked: () => void } = $props();

  let open = $state(false);
  let reason = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function doRevoke() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await adminInstancesApi.revokeAppHostApplication(app.id, reason.trim() || undefined);
      toast.success(m.app_host_admin_revoked_toast({ username: app.applicant_username }));
      open = false;
      reason = '';
      onrevoked();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div>
  <button
    type="button"
    onclick={() => { error = null; open = true; }}
    class="rounded-lg bg-red-600/80 px-3 py-1.5 text-xs text-white font-medium hover:bg-red-500 transition-colors"
    data-testid="app-host-revoke-{app.id}"
  >
    {m.app_host_admin_revoke_btn()}
  </button>
</div>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="app-host-revoke-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.app_host_admin_revoke_title()}</Dialog.Title>
        <Dialog.Description>{app.applicant_username}</Dialog.Description>
      </Dialog.Header>
      <p class="text-text-muted text-sm">{m.app_host_admin_revoke_body()}</p>
      <div class="flex flex-col gap-2 pt-2">
        <label class="text-text-bright text-xs font-medium" for="app-host-revoke-reason">
          {m.app_host_admin_revoke_reason_label()}
        </label>
        <textarea
          id="app-host-revoke-reason"
          bind:value={reason}
          rows="2"
          maxlength="500"
          class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        {#if error}<p class="text-red-400 text-xs">{error}</p>{/if}
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (open = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          {m.app_host_admin_cancel()}
        </button>
        <button type="button" onclick={doRevoke} disabled={busy}
          class="rounded-xl bg-red-600/80 px-4 py-2 text-sm text-white font-medium hover:bg-red-500 disabled:opacity-60">
          {busy ? m.app_host_admin_revoking() : m.app_host_admin_revoke_btn()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
