<!--
  Mod-Queue für eine Guild. Tabs: Offen / Erledigt / Verworfen.
  Pro Report: Reason-Badge, Body, Target-Info + Resolve/Dismiss-Aktionen.
  Nur sichtbar wenn MANAGE_MESSAGES | BAN_MEMBERS | MANAGE_GUILD.
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { toast } from 'svelte-sonner';
  import {
    listModQueue,
    resolveReport,
    type Report,
    type ReportStatus,
    type ActionType
  } from '$lib/api/moderation';
  import { userCache } from '$lib/stores/users.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  type QueueTab = 'new' | 'resolved' | 'dismissed';
  let activeTab = $state<QueueTab>('new');
  let reports = $state<Report[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  let resolveDialogOpen = $state(false);
  let resolveTarget = $state<Report | null>(null);
  let resolutionType = $state<'resolved' | 'dismissed'>('resolved');
  let actionType = $state<ActionType>('other');
  let resolutionNote = $state('');
  let resolving = $state(false);

  const ACTION_LABELS: Record<ActionType, string> = $derived({
    ban: m.mod_queue_action_ban(),
    kick: m.mod_queue_action_kick(),
    message_delete: m.mod_queue_action_message_delete(),
    warn: m.mod_queue_action_warn(),
    role_change: m.mod_queue_action_role_change(),
    other: m.mod_queue_action_other()
  });

  const REASON_LABELS: Record<string, string> = $derived({
    spam: m.mod_queue_reason_spam(),
    harassment: m.mod_queue_reason_harassment(),
    illegal: m.mod_queue_reason_illegal(),
    csam: m.mod_queue_reason_csam(),
    other: m.mod_queue_reason_other()
  });

  const REASON_COLORS: Record<string, string> = {
    spam: 'bg-yellow-500/15 text-yellow-400',
    harassment: 'bg-orange-500/15 text-orange-400',
    illegal: 'bg-red-500/15 text-red-400',
    csam: 'bg-red-700/20 text-red-300',
    other: 'bg-bg-hover text-text-muted'
  };

  async function load(tab: QueueTab) {
    loading = true;
    loadError = null;
    try {
      const status: ReportStatus = tab === 'new' ? 'new' : tab;
      reports = await listModQueue(guildId, status);
      for (const r of reports) {
        if (r.reporter_user_id) userCache.queue(r.reporter_user_id);
        if (r.target_user_id) userCache.queue(r.target_user_id);
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => { void load(activeTab); });

  function openResolve(r: Report, type: 'resolved' | 'dismissed') {
    resolveTarget = r;
    resolutionType = type;
    actionType = 'other';
    resolutionNote = '';
    resolveDialogOpen = true;
  }

  async function confirmResolve() {
    if (!resolveTarget || resolving) return;
    resolving = true;
    try {
      await resolveReport(guildId, resolveTarget.id, {
        resolution: resolutionType,
        action_type: resolutionType === 'resolved' ? actionType : undefined,
        resolution_note: resolutionNote || undefined
      });
      toast.success(
        resolutionType === 'resolved' ? m.mod_queue_toast_resolved() : m.mod_queue_toast_dismissed()
      );
      resolveDialogOpen = false;
      void load(activeTab);
    } catch (e) {
      toast.error(m.mod_queue_toast_error(), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      resolving = false;
    }
  }

  function fmtUser(id: string | null): string {
    if (!id) return '—';
    const u = userCache.get(id);
    return u ? `@${u.display_name ?? u.username}` : `…${id.slice(-6)}`;
  }

  function fmtTime(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
</script>

<section class="flex flex-col gap-5" data-testid="mod-queue-panel">
  <div>
    <h2 class="text-text-bright text-lg font-semibold">{m.mod_queue_title()}</h2>
    <p class="text-text-muted text-sm">{m.mod_queue_subtitle()}</p>
  </div>

  <!-- Tab-Bar -->
  <div class="flex gap-1 rounded-lg bg-bg-input/40 p-1">
    {#each ([['new', m.mod_queue_tab_new()], ['resolved', m.mod_queue_tab_resolved()], ['dismissed', m.mod_queue_tab_dismissed()]] as const) as [t, label] (t)}
      <button
        type="button"
        onclick={() => (activeTab = t)}
        class="flex-1 rounded-md px-3 py-1.5 text-sm transition-colors
               {activeTab === t
                 ? 'bg-bg-hover text-text-bright font-medium'
                 : 'text-text-muted hover:text-text-base'}"
        data-testid="modqueue-tab-{t}"
      >
        {label}
      </button>
    {/each}
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">{m.mod_queue_loading()}</p>
  {:else if loadError}
    <p class="text-red-400 text-sm" data-testid="modqueue-error">{m.mod_queue_load_error({ error: loadError })}</p>
  {:else if reports.length === 0}
    <p class="text-text-muted text-sm">{m.mod_queue_empty()}</p>
  {:else}
    <ul class="flex flex-col gap-2" data-testid="modqueue-list">
      {#each reports as r (r.id)}
        <li class="rounded-xl border border-border bg-bg-hover/30 p-3" data-testid="modqueue-report">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="rounded-full px-2 py-0.5 text-xs font-medium {REASON_COLORS[r.reason_code] ?? REASON_COLORS.other}">
              {REASON_LABELS[r.reason_code] ?? r.reason_code}
            </span>
            <span class="text-text-muted text-xs">{fmtTime(r.created_at)}</span>
            <span class="text-text-muted text-xs">{m.mod_queue_report_by({ user: fmtUser(r.reporter_user_id) })}</span>
            {#if r.target_user_id}
              <span class="text-text-muted text-xs">→ {fmtUser(r.target_user_id)}</span>
            {/if}
          </div>
          <p class="text-text-base mb-3 line-clamp-3 text-sm">{r.body}</p>
          {#if r.resolution_note}
            <p class="text-text-muted mb-3 text-xs italic">{m.mod_queue_note({ note: r.resolution_note })}</p>
          {/if}
          {#if activeTab === 'new'}
            <div class="flex gap-2">
              <button
                type="button"
                onclick={() => openResolve(r, 'resolved')}
                class="bg-primary/10 text-primary hover:bg-primary/20 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                data-testid="modqueue-resolve-btn"
              >
                {m.mod_queue_btn_resolve()}
              </button>
              <button
                type="button"
                onclick={() => openResolve(r, 'dismissed')}
                class="bg-bg-input text-text-muted hover:bg-bg-hover rounded-md px-3 py-1.5 text-xs transition-colors"
                data-testid="modqueue-dismiss-btn"
              >
                {m.mod_queue_btn_dismiss()}
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<!-- Resolve/Dismiss Dialog -->
<AlertDialog.Root bind:open={resolveDialogOpen}>
  <AlertDialog.Content data-testid="modqueue-resolve-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>
        {resolutionType === 'resolved' ? m.mod_queue_dialog_title_resolve() : m.mod_queue_dialog_title_dismiss()}
      </AlertDialog.Title>
      <AlertDialog.Description>
        {resolutionType === 'resolved'
          ? m.mod_queue_dialog_desc_resolve()
          : m.mod_queue_dialog_desc_dismiss()}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <div class="flex flex-col gap-3 py-2">
      {#if resolutionType === 'resolved'}
        <select
          bind:value={actionType}
          class="bg-bg-input border-border text-text-base w-full rounded-lg border px-3 py-2 text-sm"
          data-testid="modqueue-action-type"
        >
          {#each Object.entries(ACTION_LABELS) as [val, label] (val)}
            <option value={val}>{label}</option>
          {/each}
        </select>
      {/if}
      <textarea
        bind:value={resolutionNote}
        rows="3"
        placeholder={m.mod_queue_note_placeholder()}
        class="bg-bg-input border-border text-text-base placeholder:text-text-muted w-full resize-none rounded-lg border px-3 py-2 text-sm"
        data-testid="modqueue-resolution-note"
      ></textarea>
    </div>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.mod_queue_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmResolve} disabled={resolving}>
        {resolving ? m.mod_queue_saving() : m.mod_queue_confirm()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
