<!--
  Admin: Missbrauchsmeldungen (Beschwerden) einer Ansicht + Aktionen.
  Zwei Ansichten: "open" (neu + Alt-Status in Arbeit) und "closed" (erledigt +
  weitergeleitet). An jeder offenen Beschwerde nur die passenden Knöpfe:
    - Instanz-Beschwerde → „An Betreiber weiterleiten" (E-Mail; gilt danach als
      erledigt und wandert nach „closed" mit Vermerk „Weitergeleitet").
    - Nutzer-Beschwerde   → „An Nutzer schreiben" (private PM).
    - immer               → „Erledigen".
  Pro Ansicht eigene Instanz (Eltern remountet via {#key}) — onMount lädt einmal.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { adminComplaintsApi, type Complaint } from '$lib/api/complaints';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import { adminApi } from '$lib/api/admin';
  import { useGatewayListener } from '$lib/ws/useGatewayListener.svelte';

  // Zwei Ansichten: "open" = neu + in Arbeit, "closed" = erledigt + weitergeleitet.
  let { view, onchange }: { view: 'open' | 'closed'; onchange?: () => void } = $props();

  let items = $state<Complaint[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

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

  // Notify-user flow (PM vom Betreiber an den gemeldeten Nutzer)
  let notifyTarget = $state<Complaint | null>(null);
  let notifyOpen = $state(false);
  let notifyMessage = $state('');
  let notifying = $state(false);

  // Ban-user flow (Konto plattformweit sperren + Beschwerde erledigen)
  let banTarget = $state<Complaint | null>(null);
  let banOpen = $state(false);
  let banning = $state(false);

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function fmt(d: string | null): string {
    return d ? new Date(d).toLocaleString('de-DE') : '';
  }

  onMount(reload);

  // Live: eine neue Beschwerde kam rein → offene Liste sofort nachladen, damit
  // der Admin sie ohne Reload sieht (der Server pusht das Event nur an Admins).
  useGatewayListener((evt) => {
    if (evt.op === 'complaint_new' && view === 'open') void reload();
  });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      if (view === 'open') {
        // Offen = neu + (Alt-Status) in Arbeit, neueste zuerst.
        const [fresh, ack] = await Promise.all([
          adminComplaintsApi.list('new'),
          adminComplaintsApi.list('acknowledged')
        ]);
        items = [...fresh, ...ack].sort((a, b) =>
          b.submitted_at.localeCompare(a.submitted_at)
        );
      } else {
        // Erledigt fasst abgeschlossene + weitergeleitete zusammen.
        const [resolved, forwarded] = await Promise.all([
          adminComplaintsApi.list('resolved'),
          adminComplaintsApi.list('forwarded')
        ]);
        items = [...resolved, ...forwarded].sort((a, b) =>
          (b.resolved_at ?? b.forwarded_at ?? '').localeCompare(
            a.resolved_at ?? a.forwarded_at ?? ''
          )
        );
      }
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

  async function doNotify() {
    if (!notifyTarget || !notifyMessage.trim()) return;
    const c = notifyTarget;
    notifying = true;
    try {
      const res = await adminComplaintsApi.notifyUser(c.id, notifyMessage.trim());
      if (res.sent) {
        toast.success(m.admin_complaints_notify_ok());
        notifyOpen = false;
        notifyMessage = '';
        notifyTarget = null;
        // Kein drop(): Benachrichtigen schließt die Beschwerde nicht.
      } else {
        toast.warning(m.admin_complaints_notify_not_sent());
      }
    } catch (e) {
      toast.error(m.admin_complaints_notify_failed(), { description: errMsg(e) });
    } finally {
      notifying = false;
    }
  }

  async function doBanUser() {
    if (!banTarget?.target_user_id || banning) return;
    const c = banTarget;
    banning = true;
    try {
      // Zwei bestehende, getestete Endpoints: Konto plattformweit sperren
      // (widerruft Sessions/Tokens, Owner-Schutz serverseitig) + Beschwerde
      // erledigen (schickt dem Melder die automatische Rückmeldung).
      await adminApi.patchUser(c.target_user_id!, { disabled: true });
      await adminComplaintsApi.resolve(c.id, m.admin_complaints_ban_note());
      toast.success(m.admin_complaints_ban_ok());
      banOpen = false;
      banTarget = null;
      drop(c.id);
    } catch (e) {
      toast.error(m.admin_complaints_ban_failed(), { description: errMsg(e) });
    } finally {
      banning = false;
    }
  }

  async function doResolve() {
    if (!resolveTarget || resolving) return;
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
  <LoadingState label={m.admin_complaints_loading()} />
{:else if loadError}
  <FieldError message={m.admin_complaints_load_error({ error: loadError })} />
{:else if items.length === 0}
  <EmptyState message={m.admin_complaints_empty()} />
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
          <div class="flex shrink-0 items-center gap-2">
            {#if view === 'closed'}
              <span
                class="bg-bg-input text-text-base rounded-full px-2 py-0.5 text-xs font-medium"
                data-testid="complaint-outcome"
              >
                {c.status === 'forwarded'
                  ? m.admin_complaints_outcome_forwarded()
                  : m.admin_complaints_outcome_resolved()}
              </span>
            {/if}
            <p class="text-text-muted text-xs">{fmt(c.submitted_at)}</p>
          </div>
        </div>

        <p class="text-text-base whitespace-pre-wrap break-words text-sm">{c.body}</p>

        {#if c.target_instance_id}
          <p class="text-xs {c.operator_email ? 'text-text-muted' : 'text-warning'}">
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

        {#if view === 'open'}
          <div class="flex flex-wrap gap-2">
            {#if c.target_instance_id}
              <Button
                variant="warning-solid"
                size="xs"
                onclick={() => {
                  forwardTarget = c;
                  forwardNotice = '';
                  forwardOpen = true;
                }}
              >
                {m.admin_complaints_btn_forward()}
              </Button>
            {/if}
            {#if c.target_user_id}
              <Button
                size="xs"
                onclick={() => {
                  notifyTarget = c;
                  notifyMessage = '';
                  notifyOpen = true;
                }}
                data-testid="complaint-notify-btn"
              >
                {m.admin_complaints_btn_notify_user()}
              </Button>
              <Button
                variant="destructive-solid"
                size="xs"
                onclick={() => {
                  banTarget = c;
                  banOpen = true;
                }}
                data-testid="complaint-ban-btn"
              >
                {m.admin_complaints_btn_ban_user()}
              </Button>
            {/if}
            <Button
              variant="success-solid"
              size="xs"
              onclick={() => {
                resolveTarget = c;
                resolveNote = '';
                resolveOpen = true;
              }}
            >
              {m.admin_complaints_btn_resolve()}
            </Button>
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
        <p class="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
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
        <Button variant="outline" onclick={() => (forwardOpen = false)}>
          {m.admin_complaints_cancel()}
        </Button>
        <Button
          variant="warning-solid"
          onclick={doForward}
          disabled={forwarding || !forwardNotice.trim()}
        >
          {m.admin_complaints_forward_submit()}
        </Button>
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
        <Button variant="outline" onclick={() => (resolveOpen = false)}>
          {m.admin_complaints_cancel()}
        </Button>
        <Button variant="success-solid" onclick={doResolve} disabled={resolving}>
          {m.admin_complaints_resolve_submit()}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Notify-User Dialog -->
<Dialog.Root bind:open={notifyOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="complaint-notify-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_complaints_notify_title()}</Dialog.Title>
        <Dialog.Description>
          {notifyTarget?.target_username ?? notifyTarget?.target_user_id ?? ''}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        <label class="text-text-bright text-xs font-medium" for="notify-message">
          {m.admin_complaints_notify_message_label()}
        </label>
        <textarea
          id="notify-message"
          bind:value={notifyMessage}
          rows="4"
          maxlength="2000"
          placeholder={m.admin_complaints_notify_message_placeholder()}
          class="bg-bg-input border-border text-text-bright focus:ring-primary resize-none rounded-xl border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
        ></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="outline" onclick={() => (notifyOpen = false)}>
          {m.admin_complaints_cancel()}
        </Button>
        <Button onclick={doNotify} disabled={notifying || !notifyMessage.trim()}>
          {m.admin_complaints_notify_submit()}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<!-- Ban-User Dialog (Konto plattformweit sperren) -->
<Dialog.Root bind:open={banOpen}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content class="max-w-md" data-testid="complaint-ban-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.admin_complaints_ban_title()}</Dialog.Title>
        <Dialog.Description>
          {banTarget?.target_username ?? banTarget?.target_user_id ?? ''}
        </Dialog.Description>
      </Dialog.Header>
      <p class="text-text-muted text-sm">{m.admin_complaints_ban_desc()}</p>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="outline" onclick={() => (banOpen = false)}>
          {m.admin_complaints_cancel()}
        </Button>
        <Button variant="destructive-solid" onclick={doBanUser} disabled={banning}>
          {banning ? m.admin_complaints_ban_submitting() : m.admin_complaints_ban_confirm()}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
