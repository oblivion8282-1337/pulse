<!--
  Admin: Aktive Self-Host-Instanzen — Suspend + Secret-Rotation.
  Secret wird EINMALIG nach Rotation im Dialog angezeigt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { adminInstancesApi, type AdminInstance, type RotateSecretResult } from '$lib/api/instances';
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import CheckIcon from '@lucide/svelte/icons/check';

  let instances = $state<AdminInstance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Suspend flow
  let suspendTarget = $state<AdminInstance | null>(null);
  let suspendOpen = $state(false);
  let suspendReason = $state('');
  let suspending = $state(false);

  // Rotate flow
  let rotateTarget = $state<AdminInstance | null>(null);
  let rotateConfirmOpen = $state(false);
  let rotateResult = $state<RotateSecretResult | null>(null);
  let rotateDialogOpen = $state(false);
  let copied = $state(false);

  onMount(async () => { await reload(); });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      instances = await adminInstancesApi.listInstances('active');
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function doSuspend() {
    if (!suspendTarget) return;
    suspending = true;
    try {
      await adminInstancesApi.suspendInstance(suspendTarget.id, suspendReason.trim() || undefined);
      instances = instances.filter((i) => i.id !== suspendTarget!.id);
      toast.success(`Instanz ${suspendTarget.hostname} gesperrt.`);
      suspendOpen = false;
      suspendReason = '';
      suspendTarget = null;
    } catch (e) {
      toast.error('Sperren fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      suspending = false;
    }
  }

  async function doRotate() {
    if (!rotateTarget) return;
    busy[rotateTarget.id] = true;
    rotateConfirmOpen = false;
    try {
      const result = await adminInstancesApi.rotateSecret(rotateTarget.id);
      rotateResult = result;
      rotateDialogOpen = true;
    } catch (e) {
      toast.error('Secret-Rotation fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[rotateTarget.id] = false;
      rotateTarget = null;
    }
  }

  async function copySecret() {
    if (!rotateResult?.client_secret) return;
    await navigator.clipboard.writeText(rotateResult.client_secret);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function onRotateClose() {
    rotateDialogOpen = false;
    rotateResult = null;
    copied = false;
  }
</script>

{#if loading}
  <p class="text-text-muted text-sm">Lade…</p>
{:else if loadError}
  <p class="text-red-400 text-sm">Fehler: {loadError}</p>
{:else if instances.length === 0}
  <p class="text-text-muted text-sm">Keine aktiven Instanzen.</p>
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
          <span class="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300 shrink-0">Aktiv</span>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            onclick={() => { rotateTarget = inst; rotateConfirmOpen = true; }}
            disabled={!!busy[inst.id]}
            class="rounded-lg border border-border bg-bg-hover px-3 py-1.5 text-xs text-text-base hover:text-text-bright disabled:opacity-60 transition-colors"
          >
            Secret rotieren
          </button>
          <button
            type="button"
            onclick={() => { suspendTarget = inst; suspendReason = ''; suspendOpen = true; }}
            disabled={!!busy[inst.id]}
            class="rounded-lg bg-red-600/70 px-3 py-1.5 text-xs text-white font-medium hover:bg-red-500 disabled:opacity-60 transition-colors"
          >
            Sperren
          </button>
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
        <Dialog.Title>Instanz sperren?</Dialog.Title>
        <Dialog.Description>{suspendTarget?.hostname}</Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="suspend-reason">
          Grund <span class="text-text-muted font-normal">(optional)</span>
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
        <button type="button" onclick={() => (suspendOpen = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          Abbrechen
        </button>
        <button type="button" onclick={doSuspend} disabled={suspending}
          class="rounded-xl bg-red-600/80 px-4 py-2 text-sm text-white font-medium hover:bg-red-500 disabled:opacity-60">
          {suspending ? 'Wird gesperrt…' : 'Sperren'}
        </button>
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
        <Dialog.Title>Secret rotieren?</Dialog.Title>
        <Dialog.Description>{rotateTarget?.hostname}</Dialog.Description>
      </Dialog.Header>
      <p class="text-text-muted text-sm">
        Das alte Secret wird sofort ungültig. Das neue Secret wird einmalig angezeigt.
      </p>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick={() => (rotateConfirmOpen = false)}
          class="rounded-xl border border-border px-4 py-2 text-sm text-text-base hover:bg-bg-hover">
          Abbrechen
        </button>
        <button type="button" onclick={doRotate}
          class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium">
          Rotieren
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Neues Secret — kein auto-dismiss! -->
<Dialog.Root
  open={rotateDialogOpen}
  onOpenChange={(v) => { if (!v) onRotateClose(); }}
>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="rotate-secret-dialog">
      <Dialog.Header>
        <Dialog.Title>Neues Client-Secret</Dialog.Title>
      </Dialog.Header>
      <div class="flex flex-col gap-3">
        <p class="text-amber-300 text-sm font-medium">{rotateResult?.warning}</p>
        <div class="bg-bg-input flex items-center gap-2 rounded-xl border border-border p-3">
          <code class="text-text-bright flex-1 break-all text-xs select-all">
            {rotateResult?.client_secret}
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
      </div>
      <div class="flex justify-end pt-2">
        <button type="button" onclick={onRotateClose}
          class="bg-primary hover:bg-primary/90 text-white rounded-xl px-4 py-2 text-sm font-medium">
          Verstanden, schließen
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
