<!--
  Admin: Aktive Self-Host-Instanzen (VPS + App-Host, mit Herkunfts-Chip).
  Aktion nach Herkunft: VPS → Suspend + Secret-Rotation (Secret EINMALIG nach
  Rotation im Dialog). App-Host → "Freischaltung zurücknehmen" (Revoke) statt
  Suspend; der Revoke läuft über den zugehörigen Antrag, den wir per
  approved_instance_id auf die Instanz-Zeile mappen (Grants-Liste geladen).
-->
<script lang="ts">
  import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import {
    adminInstancesApi,
    type AdminInstance,
    type AdminApplication,
    type RotateSecretResult
  } from '$lib/api/instances';
  import AdminAppHostRevoke from './AdminAppHostRevoke.svelte';
  import RotatedSecretDialog from './RotatedSecretDialog.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
  import ReasonDialog from '$lib/components/feedback/ReasonDialog.svelte';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let instances = $state<AdminInstance[]>([]);
  // app_host-Instanz-ID → genehmigter Antrag (für den Revoke, der die
  // Antrags-ID braucht). Gemappt über approved_instance_id.
  let grantByInstance = $state<Record<string, AdminApplication>>({});
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Suspend flow
  let suspendTarget = $state<AdminInstance | null>(null);
  let suspendOpen = $state(false);
  let suspending = $state(false);
  let rotating = $state(false);

  // Rotate flow
  let rotateTarget = $state<AdminInstance | null>(null);
  let rotateResult = $state<RotateSecretResult | null>(null);
  let rotateDialogOpen = $state(false);

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      // app_host-Instanzen erscheinen hier neben den VPS-Instanzen. Zusätzlich
      // die genehmigten app_host-Anträge laden, um pro Instanz-Zeile den
      // Revoke (braucht die Antrags-ID) über approved_instance_id anzubieten.
      const [insts, grants] = await Promise.all([
        adminInstancesApi.listInstances('active'),
        adminInstancesApi.listApplications('approved', 'app_host')
      ]);
      instances = insts;
      const map: Record<string, AdminApplication> = {};
      for (const g of grants) if (g.approved_instance_id) map[g.approved_instance_id] = g;
      grantByInstance = map;
    } catch (e) {
      loadError = errText(e);
    } finally {
      loading = false;
    }
  }

  function removeInstance(id: string): void {
    instances = instances.filter((i) => i.id !== id);
  }

  async function doSuspend(reason: string) {
    if (!suspendTarget) return;
    suspending = true;
    try {
      await adminInstancesApi.suspendInstance(suspendTarget.id, reason.trim() || undefined);
      removeInstance(suspendTarget.id);
      toast.success(m.admin_instances_active_suspended({ hostname: suspendTarget.hostname }));
      suspendOpen = false;
      suspendTarget = null;
    } catch (e) {
      toast.error(m.admin_instances_active_suspend_failed(), {
        description: errText(e)
      });
    } finally {
      suspending = false;
    }
  }

  // Rotate-Confirm über den gemeinsamen Dienst (statt handgebautem Dialog).
  async function askRotate(inst: AdminInstance) {
    const ok = await confirmDialog({
      title: m.admin_instances_active_rotate_title(),
      description: `${inst.hostname} — ${m.admin_instances_active_rotate_warning()}`,
      confirmLabel: m.admin_instances_active_btn_rotate_confirm(),
      cancelLabel: m.admin_instances_active_btn_cancel()
    });
    if (!ok) return;
    rotateTarget = inst;
    doRotate();
  }

  async function doRotate() {
    // rotating-Guard (wie suspending bei doSuspend): ohne ihn feuert ein
    // Doppelklick auf "Bestätigen" zwei rotateSecret-Calls — der zweite
    // rotiert das gerade angezeigte Secret sofort wieder weg (Admin hält ein
    // bereits invalidiertes Secket / Fehler).
    if (!rotateTarget || rotating) return;
    rotating = true;
    busy[rotateTarget.id] = true;
    try {
      const result = await adminInstancesApi.rotateSecret(rotateTarget.id);
      rotateResult = result;
      rotateDialogOpen = true;
    } catch (e) {
      toast.error(m.admin_instances_active_rotate_failed(), {
        description: errText(e)
      });
    } finally {
      busy[rotateTarget.id] = false;
      rotating = false;
      rotateTarget = null;
    }
  }

  function onRotateClose() {
    rotateDialogOpen = false;
    rotateResult = null;
  }
</script>

{#if loading}
  <LoadingState label={m.admin_instances_active_loading()} />
{:else if loadError}
  <FieldError message={m.admin_instances_active_load_error({ error: loadError })} />
{:else if instances.length === 0}
  <EmptyState message={m.admin_instances_active_empty()} />
{:else}
  <div class="flex flex-col gap-2">
    {#each instances as inst (inst.id)}
      <div class="border-border bg-bg-hover/30 rounded-xl border p-3 flex flex-col gap-2"
           data-testid="active-instance-{inst.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium">{inst.hostname}</p>
            <p class="text-text-muted text-xs mt-0.5">
              {inst.registrar_username} · Workers: {inst.worker_id_chat}/{inst.worker_id_voice}/{inst.worker_id_media}
            </p>
            <p class="text-text-muted text-xs">{new Date(inst.registered_at).toLocaleDateString('de-DE')}</p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="border-border text-text-muted rounded-full border px-2 py-0.5 text-xs"
                  data-testid="admin-instance-origin-chip">
              {inst.origin === 'app_host' ? m.hosting_origin_app() : m.hosting_origin_vps()}
            </span>
            <span class="rounded-full bg-success/20 px-2 py-0.5 text-xs text-success">{m.admin_instances_active_status_active()}</span>
          </div>
        </div>
        <div class="flex gap-2">
          {#if inst.origin === 'app_host' && grantByInstance[inst.id]}
            <!-- App-Host: Freischaltung zurücknehmen (Revoke über den Antrag)
                 statt Suspend/Rotate. Kein Grant gefunden → Fallback unten. -->
            <AdminAppHostRevoke app={grantByInstance[inst.id]} onrevoked={() => removeInstance(inst.id)} />
          {:else}
            <Button
              variant="outline"
              size="xs"
              onclick={() => askRotate(inst)}
              disabled={!!busy[inst.id]}
            >
              {m.admin_instances_active_btn_rotate()}
            </Button>
            <Button
              variant="destructive-solid"
              size="xs"
              onclick={() => { suspendTarget = inst; suspendOpen = true; }}
              disabled={!!busy[inst.id]}
            >
              {m.admin_instances_active_btn_suspend()}
            </Button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Suspend Dialog -->
<ReasonDialog
  bind:open={suspendOpen}
  title={m.admin_instances_active_suspend_title()}
  description={suspendTarget?.hostname}
  label={`${m.admin_instances_active_reason_label()} (${m.admin_instances_active_reason_optional()})`}
  maxlength={500}
  rows={2}
  busy={suspending}
  busyLabel={m.admin_instances_active_suspending()}
  confirmLabel={m.admin_instances_active_btn_suspend()}
  cancelLabel={m.admin_instances_active_btn_cancel()}
  confirmVariant="destructive-solid"
  testId="suspend-dialog"
  onConfirm={doSuspend}
/>

<!-- Neues Secret — kein auto-dismiss! (ausgelagert, Größen-Policy) -->
<RotatedSecretDialog open={rotateDialogOpen} result={rotateResult} onClose={onRotateClose} />
