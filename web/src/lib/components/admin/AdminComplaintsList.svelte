<!--
  Admin: eine nach Status gefilterte Liste von Missbrauchsmeldungen + Aktionen.
  Lebenszyklus: neu → in Bearbeitung → weitergeleitet → erledigt. Weiterleiten
  benachrichtigt den Instanz-Betreiber per E-Mail (sofern Kontakt + SMTP da sind).
  Pro Tab eigene Instanz (Eltern remountet via {#key}) — onMount lädt einmal.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import {
    adminComplaintsApi,
    type Complaint,
    type ComplaintStatus
  } from '$lib/api/complaints';

  let { status, onchange }: { status: ComplaintStatus; onchange?: () => void } = $props();

  let items = $state<Complaint[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Forward flow
  let forwardTarget = $state<Complaint | null>(null);
  let forwardOpen = $state(false);
  let forwardNotice = $state('');
  let forwarding = $state(false);

  // Resolve flow
  let resolveTarget = $state<Complaint | null>(null);
  let resolveOpen = $state(false);
  let resolveNote = $state('');
  let resolving = $state(false);

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function fmt(d: string | null): string {
    return d ? new Date(d).toLocaleString('de-DE') : '';
  }

  onMount(reload);

  async function reload() {
    loading = true;
    loadError = null;
    try {
      items = await adminComplaintsApi.list(status);
    } catch (e) {
      loadError = errMsg(e);
    } finally {
      loading = false;
    }
  }

  function drop(id: string) {
    items = items.filter((c) => c.id !== id);
    onchange?.();
  }

  async function doAcknowledge(c: Complaint) {
    busy[c.id] = true;
    try {
      await adminComplaintsApi.acknowledge(c.id);
      toast.success(m.admin_complaints_acknowledged_ok());
      drop(c.id);
    } catch (e) {
      toast.error(m.admin_complaints_acknowledge_failed(), { description: errMsg(e) });
    } finally {
      busy[c.id] = false;
    }
  }

  async function doForward() {
    if (!forwardTarget || !forwardNotice.trim()) return;
    const c = forwardTarget;
    forwarding = true;
    try {
      const res = await adminComplaintsApi.forward(c.id, forwardNotice.trim());
      if (res.email_sent && res.forwarded_to_email) {
        toast.success(m.admin_complaints_forwarded_ok({ email: res.forwarded_to_email }));
      } else if (res.email_error === 'no_operator_email') {
        toast.warning(m.admin_complaints_forwarded_no_email_toast());
      } else if (res.email_error === 'smtp_not_configured') {
        toast.warning(m.admin_complaints_forwarded_smtp_toast());
      } else {
        toast.warning(m.admin_complaints_forwarded_failed_toast());
      }
      forwardOpen = false;
      forwardNotice = '';
      forwardTarget = null;
      drop(c.id);
    } catch (e) {
      toast.error(m.admin_complaints_forward_failed(), { description: errMsg(e) });
    } finally {
      forwarding = false;
    }
  }

  async function doResolve() {
    if (!resolveTarget || !resolveNote.trim()) return;
    const c = resolveTarget;
    resolving = true;
    try {
      await adminComplaintsApi.resolve(c.id, resolveNote.trim());
      toast.success(m.admin_complaints_resolved_ok());
      resolveOpen = false;
      resolveNote = '';
      resolveTarget = null;
      drop(c.id);
    } catch (e) {
      toast.error(m.admin_complaints_resolve_failed(), { description: errMsg(e) });
    } finally {
      resolving = false;
    }
  }
</script>

{#if loading}
  <p class="text-text-muted text-sm">{m.admin_complaints_loading()}</p>
{:else if loadError}
  <p class="text-red-400 text-sm">{m.admin_complaints_load_error({ error: loadError })}</p>
{:else if items.length === 0}
  <p class="text-text-muted text-sm">{m.admin_complaints_empty()}</p>
{:else}
  <div class="flex flex-col gap-2">
    {#each items as c (c.id)}
      <div
        class="border-border bg-bg-hover/30 flex flex-col gap-2 rounded-xl border p-3"
        data-testid="complaint-{c.id}"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 text-xs">
            {#if c.target_instance_id}
              <p class="text-text-bright text-sm font-medium">
                {m.admin_complaints_target_instance({
                  target: c.target_instance_hostname ?? c.target_instance_id
                })}
              </p>
            {:else if c.target_user_id}
              <p class="text-text-bright text-sm font-medium">
                {m.admin_complaints_target_user({
                  target: c.target_username ?? c.target_user_id
                })}
              </p>
            {:else}
              <p class="text-text-bright text-sm font-medium">{m.admin_complaints_target_url()}</p>
            {/if}
            {#if c.target_url}
              <p class="text-text-muted mt-0.5 break-all">{c.target_url}</p>
            {/if}
            <p class="text-text-muted mt-0.5">
              {c.submitter_email
                ? m.admin_complaints_submitter({ email: c.submitter_email })
                : m.admin_complaints_anonymous()}
            </p>
          </div>
          <p class="text-text-muted shrink-0 text-xs">{fmt(c.submitted_at)}</p>
        </div>

        <p class="text-text-base whitespace-pre-wrap break-words text-sm">{c.body}</p>

        {#if c.target_instance_id}
          <p class="text-xs {c.operator_email ? 'text-text-muted' : 'text-amber-500'}">
            {c.operator_email
              ? m.admin_complaints_operator({ email: c.operator_email })
              : m.admin_complaints_no_operator()}
          </p>
        {/if}

        {#if c.status === 'forwarded'}
          <p class="text-text-muted text-xs italic">
            {c.forwarded_to_email
              ? m.admin_complaints_forwarded_info({
                  email: c.forwarded_to_email,
                  date: fmt(c.forwarded_at)
                })
              : m.admin_complaints_forwarded_no_email()}
          </p>
        {/if}
        {#if c.status === 'resolved' && c.resolution_note}
          <p class="text-text-muted text-xs italic">
            {m.admin_complaints_resolution({ note: c.resolution_note })}
          </p>
        {/if}

        {#if c.status !== 'resolved'}
          <div class="flex flex-wrap gap-2">
            {#if c.status === 'new'}
              <button
                type="button"
                onclick={() => doAcknowledge(c)}
                disabled={!!busy[c.id]}
                class="border-border text-text-base hover:bg-bg-hover rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60"
              >
                {m.admin_complaints_btn_acknowledge()}
              </button>
            {/if}
            {#if c.status === 'new' || c.status === 'acknowledged'}
              <button
                type="button"
                onclick={() => {
                  forwardTarget = c;
                  forwardNotice = '';
                  forwardOpen = true;
                }}
                disabled={!!busy[c.id]}
                class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-60"
              >
                {m.admin_complaints_btn_forward()}
              </button>
            {/if}
            <button
              type="button"
              onclick={() => {
                resolveTarget = c;
                resolveNote = '';
                resolveOpen = true;
              }}
              disabled={!!busy[c.id]}
              class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
            >
              {m.admin_complaints_btn_resolve()}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<!-- Forward Dialog -->
<Dialog.Root bind:open={forwardOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="complaint-forward-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_complaints_forward_title()}</Dialog.Title>
        <Dialog.Description>
          {forwardTarget?.target_instance_hostname ?? forwardTarget?.target_instance_id ?? ''}
        </Dialog.Description>
      </Dialog.Header>
      {#if forwardTarget && !forwardTarget.operator_email}
        <p class="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          {m.admin_complaints_forward_no_operator_warn()}
        </p>
      {/if}
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="forward-notice">
          {m.admin_complaints_forward_notice_label()}
        </label>
        <textarea
          id="forward-notice"
          bind:value={forwardNotice}
          rows="4"
          maxlength="5000"
          placeholder={m.admin_complaints_forward_notice_placeholder()}
          class="bg-bg-input border-border text-text-bright focus:ring-primary resize-none rounded-xl border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
        ></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onclick={() => (forwardOpen = false)}
          class="border-border text-text-base hover:bg-bg-hover rounded-xl border px-4 py-2 text-sm"
        >
          {m.admin_complaints_cancel()}
        </button>
        <button
          type="button"
          onclick={doForward}
          disabled={forwarding || !forwardNotice.trim()}
          class="rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-60"
        >
          {m.admin_complaints_forward_submit()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Resolve Dialog -->
<Dialog.Root bind:open={resolveOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="complaint-resolve-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_complaints_resolve_title()}</Dialog.Title>
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="resolve-note">
          {m.admin_complaints_resolve_note_label()}
        </label>
        <textarea
          id="resolve-note"
          bind:value={resolveNote}
          rows="3"
          maxlength="2000"
          placeholder={m.admin_complaints_resolve_note_placeholder()}
          class="bg-bg-input border-border text-text-bright focus:ring-primary resize-none rounded-xl border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
        ></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onclick={() => (resolveOpen = false)}
          class="border-border text-text-base hover:bg-bg-hover rounded-xl border px-4 py-2 text-sm"
        >
          {m.admin_complaints_cancel()}
        </button>
        <button
          type="button"
          onclick={doResolve}
          disabled={resolving || !resolveNote.trim()}
          class="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
        >
          {m.admin_complaints_resolve_submit()}
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
