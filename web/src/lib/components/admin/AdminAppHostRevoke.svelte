<!--
  Admin: erteilte App-Hosting-Freischaltung zurücknehmen. Eingebettet in die
  app_host-Zeile im Instanz-„Aktiv"-Tab (AdminInstancesActive) — trägt Knopf +
  Bestätigungsdialog (ReasonDialog) + Aufruf; der Aufrufer erfährt über
  `onrevoked` davon und entfernt die Zeile.

  Wirkung serverseitig (routes_admin_app_host_revoke.py): `self_host_enabled`
  aus UND die auto-provisionierte App-Host-Instanz wird suspendiert — der
  Kill-Switch stoppt einen noch laufenden Container.
-->
<script lang="ts">
  import { errText } from '$lib/utils/errText';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { adminInstancesApi, type AdminApplication } from '$lib/api/instances';
  import ReasonDialog from '$lib/components/feedback/ReasonDialog.svelte';

  let { app, onrevoked }: { app: AdminApplication; onrevoked: () => void } = $props();

  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function doRevoke(reason: string) {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await adminInstancesApi.revokeAppHostApplication(app.id, reason.trim() || undefined);
      toast.success(m.app_host_admin_revoked_toast({ username: app.applicant_username }));
      open = false;
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

<ReasonDialog
  bind:open
  title={m.app_host_admin_revoke_title()}
  description={app.applicant_username}
  label={m.app_host_admin_revoke_reason_label()}
  maxlength={500}
  rows={2}
  busy={busy}
  busyLabel={m.app_host_admin_revoking()}
  error={error}
  confirmLabel={m.app_host_admin_revoke_btn()}
  cancelLabel={m.app_host_admin_cancel()}
  confirmVariant="destructive-solid"
  testId="app-host-revoke-dialog"
  onConfirm={doRevoke}
>
  {#snippet children()}
    <p class="text-text-muted text-sm">{m.app_host_admin_revoke_body()}</p>
  {/snippet}
</ReasonDialog>
