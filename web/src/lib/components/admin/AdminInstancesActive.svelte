<!--
  Admin: Aktive Self-Host-Instanzen (VPS + App-Host, mit Herkunfts-Chip).
  Aktion nach Herkunft: VPS → Suspend + Secret-Rotation (Secret EINMALIG nach
  Rotation im Dialog). App-Host → "Freischaltung zurücknehmen" (Revoke) statt
  Suspend; der Revoke läuft über den zugehörigen Antrag, den wir per
  approved_instance_id auf die Instanz-Zeile mappen (Grants-Liste geladen).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
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
  let suspendReason = $state('');
  let suspending = $state(false);
  let rotating = $state(false);

  // Rotate flow
  let rotateTarget = $state<AdminInstance | null>(null);
  let rotateConfirmOpen = $state(false);
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
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function removeInstance(id: string): void {
    instances = instances.filter((i) => i.id !== id);
  }

  async function doSuspend() {
    if (!suspendTarget) return;
    suspending = true;
    try {
      await adminInstancesApi.suspendInstance(suspendTarget.id, suspendReason.trim() || undefined);
      removeInstance(suspendTarget.id);
      toast.success(m.admin_instances_active_suspended({ hostname: suspendTarget.hostname }));
      suspendOpen = false;
      suspendReason = '';
      suspendTarget = null;
    } catch (e) {
      toast.error(m.admin_instances_active_suspend_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      suspending = false;
    }
  }

  async function doRotate() {
    // rotating-Guard (wie suspending bei doSuspend): ohne ihn feuert ein
    // Doppelklick auf "Bestätigen" zwei rotateSecret-Calls — der zweite
    // rotiert das gerade angezeigte Secret sofort wieder weg (Admin hält ein
    // bereits invalidiertes Secket / Fehler).
    if (!rotateTarget || rotating) return;
    rotating = true;
    busy[rotateTarget.id] = true;
    rotateConfirmOpen = false;
    try {
      const result = await adminInstancesApi.rotateSecret(rotateTarget.id);
      rotateResult = result;
      rotateDialogOpen = true;
    } catch (e) {
      toast.error(m.admin_instances_active_rotate_failed(), {
        description: e instanceof Error ? e.message : String(e)
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
              onclick={() => { rotateTarget = inst; rotateConfirmOpen = true; }}
              disabled={!!busy[inst.id]}
            >
              {m.admin_instances_active_btn_rotate()}
            </Button>
            <Button
              variant="destructive-solid"
              size="xs"
              onclick={() => { suspendTarget = inst; suspendReason = ''; suspendOpen = true; }}
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
<Dialog.Root bind:open={suspendOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="suspend-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_instances_active_suspend_title()}</Dialog.Title>
        <Dialog.Description>{suspendTarget?.hostname}</Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="suspend-reason">
          {m.admin_instances_active_reason_label()} <span class="text-text-muted font-normal">({m.admin_instances_active_reason_optional()})</span>
        </label>
        <textarea
          id="suspend-reason"
          bind:value={suspendReason}
          rows="2"
          maxlength="500"
          class="bg-bg-input border-border text-text-bright rounded-xl border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        ></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onclick={() => (suspendOpen = false)}>
          {m.admin_instances_active_btn_cancel()}
        </Button>
        <Button variant="destructive-solid" onclick={doSuspend} disabled={suspending}>
          {suspending ? m.admin_instances_active_suspending() : m.admin_instances_active_btn_suspend()}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Rotate Confirm -->
<Dialog.Root bind:open={rotateConfirmOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-sm" data-testid="rotate-confirm-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_instances_active_rotate_title()}</Dialog.Title>
        <Dialog.Description>{rotateTarget?.hostname}</Dialog.Description>
      </Dialog.Header>
      <p class="text-text-muted text-sm">
        {m.admin_instances_active_rotate_warning()}
      </p>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onclick={() => (rotateConfirmOpen = false)}>
          {m.admin_instances_active_btn_cancel()}
        </Button>
        <Button onclick={doRotate} disabled={rotating}>
          {m.admin_instances_active_btn_rotate_confirm()}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Neues Secret — kein auto-dismiss! (ausgelagert, Größen-Policy) -->
<RotatedSecretDialog open={rotateDialogOpen} result={rotateResult} onClose={onRotateClose} />
