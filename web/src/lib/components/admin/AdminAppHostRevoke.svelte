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
import { errText } from '$lib/utils/errText';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { adminInstancesApi, type AdminApplication } from '$lib/api/instances';
  import FieldError from '$lib/components/feedback/FieldError.svelte';

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
      error = errText(e);
    } finally {
      busy = false;
    }
  }
</script>

<div>
  <Button
    variant="destructive-solid"
    size="xs"
    onclick={() => { error = null; open = true; }}
    data-testid="app-host-revoke-{app.id}"
  >
    {m.app_host_admin_revoke_btn()}
  </Button>
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
        <Label class="text-text-bright text-xs font-medium" for="app-host-revoke-reason">
          {m.app_host_admin_revoke_reason_label()}
        </Label>
        <textarea
          id="app-host-revoke-reason"
          bind:value={reason}
          rows="2"
          maxlength="500"
          class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
        <FieldError message={error} />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onclick={() => (open = false)}>
          {m.app_host_admin_cancel()}
        </Button>
        <Button variant="destructive-solid" onclick={doRevoke} disabled={busy}>
          {busy ? m.app_host_admin_revoking() : m.app_host_admin_revoke_btn()}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
