<!--
  Mod-Queue einer Community. Ein Ort für alles Moderative:
    - Offen:    gemeldete Inhalte mit Aktions-Knöpfen direkt an jeder Meldung
                (Bannen · Nachricht löschen · An Pulse weiterleiten · Verwerfen).
    - Erledigt: abgeschlossene Meldungen mit Ausgang (gebannt / gelöscht / …).
    - Gesperrt: die Bannliste (Entbannen), früher eigener Settings-Tab.
  Sichtbar nur mit MANAGE_MESSAGES | BAN_MEMBERS | MANAGE_GUILD.
-->
<script lang="ts">
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { toast } from 'svelte-sonner';
  import {
    listModQueue,
    resolveReport,
    escalateReport,
    type Report,
    type ResolveInput
  } from '$lib/api/moderation';
  import { userCache } from '$lib/stores/users.svelte';
  import { modQueueCounts } from '$lib/stores/modQueueCounts.svelte';
  import BansList from '$lib/components/settings/BansList.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  type QueueTab = 'open' | 'closed' | 'banned';
  let activeTab = $state<QueueTab>('open');
  let reports = $state<Report[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  // Report-ID, für die gerade eine Aktion läuft → Knöpfe dieser Meldung sperren.
  let actingId = $state<string | null>(null);

  // Bannen braucht eine Rückfrage (endgültig) + optionalen Grund.
  let banDialogOpen = $state(false);
  let banTarget = $state<Report | null>(null);
  let banReason = $state('');

  // An-Pulse-weiterleiten-Bestätigung.
  let escalateDialogOpen = $state(false);
  let escalateTarget = $state<Report | null>(null);
  let escalating = $state(false);

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
    if (tab === 'banned') return; // BansList lädt selbst
    loading = true;
    loadError = null;
    try {
      if (tab === 'open') {
        // "Offen" = alle noch offenen Meldungen. `triaged` ist ein Alt-Status
        // (der frühere "In Bearbeitung"-Knopf ist weg) — wir zeigen ihn hier
        // weiter mit an, damit solche Bestands-Meldungen abarbeitbar bleiben
        // und der Offene-Zähler (zählt new + triaged) auch wirklich leerläuft.
        const [fresh, triaged] = await Promise.all([
          listModQueue(guildId, 'new'),
          listModQueue(guildId, 'triaged')
        ]);
        reports = [...fresh, ...triaged].sort((a, b) =>
          (a.created_at ?? '').localeCompare(b.created_at ?? '')
        );
      } else {
        // "Erledigt" fasst erledigt + verworfen zusammen, neueste zuerst.
        const [resolved, dismissed] = await Promise.all([
          listModQueue(guildId, 'resolved'),
          listModQueue(guildId, 'dismissed')
        ]);
        reports = [...resolved, ...dismissed].sort((a, b) =>
          (b.resolved_at ?? '').localeCompare(a.resolved_at ?? '')
        );
      }
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

  // Live-Nachladen: steigt der Zähler (neue Meldung per WS), während der
  // Offen-Tab sichtbar ist, die Liste auffrischen. Nur bei ECHTEM Anstieg
  // (eine eigene Aktion senkt den Zähler → kein Reload).
  let lastSeenCount = $state(-1);
  $effect(() => {
    const c = guildId ? modQueueCounts.get(guildId) : 0;
    const grew = lastSeenCount >= 0 && c > lastSeenCount;
    lastSeenCount = c;
    if (grew && activeTab === 'open') void load('open');
  });

  /** Meldung serverseitig abschließen und aus der Liste entfernen. Gibt
   *  zurück, ob es geklappt hat (Fehler → Toast + false). Sperrt die Knöpfe
   *  der Meldung für die Dauer der Aktion. */
  async function submitResolution(r: Report, body: ResolveInput): Promise<boolean> {
    actingId = r.id;
    try {
      await resolveReport(guildId, r.id, body);
      reports = reports.filter((x) => x.id !== r.id);
      void modQueueCounts.refresh(guildId);
      return true;
    } catch (e) {
      toast.error(m.mod_queue_toast_error(), {
        description: e instanceof Error ? e.message : String(e)
      });
      return false;
    } finally {
      actingId = null;
    }
  }

  /** Meldung abschließen (Nachricht löschen / verwerfen). Bannen läuft über
   *  den Bestätigungsdialog, Weiterleiten hält die Meldung offen. */
  async function closeReport(
    r: Report,
    resolution: 'resolved' | 'dismissed',
    actionType?: 'message_delete',
    successMsg?: string
  ) {
    if (actingId) return;
    const ok = await submitResolution(r, {
      resolution,
      action_type: actionType,
      resolution_note: undefined
    });
    if (ok && successMsg) toast.success(successMsg);
  }

  function openBan(r: Report) {
    banTarget = r;
    banReason = '';
    banDialogOpen = true;
  }

  async function confirmBan() {
    if (!banTarget || actingId) return;
    const ok = await submitResolution(banTarget, {
      resolution: 'resolved',
      action_type: 'ban',
      resolution_note: banReason || undefined
    });
    if (ok) {
      toast.success(m.mod_queue_toast_banned());
      banDialogOpen = false;
    }
  }

  function openEscalate(r: Report) {
    escalateTarget = r;
    escalateDialogOpen = true;
  }

  async function confirmEscalate() {
    if (!escalateTarget || escalating) return;
    escalating = true;
    try {
      const updated = await escalateReport(guildId, escalateTarget.id);
      // Bleibt offen, nur escalated_at ändert sich → Knopf verschwindet, Badge kommt.
      reports = reports.map((r) => (r.id === updated.id ? updated : r));
      toast.success(m.mod_queue_toast_escalated());
      escalateDialogOpen = false;
    } catch (e) {
      toast.error(m.mod_queue_toast_error(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      escalating = false;
    }
  }

  /** Ausgangs-Label für den Erledigt-Tab. */
  function outcomeLabel(r: Report): string {
    if (r.status === 'dismissed') return m.mod_queue_outcome_dismissed();
    if (r.resolution_action === 'ban') return m.mod_queue_outcome_banned();
    if (r.resolution_action === 'message_delete') return m.mod_queue_outcome_deleted();
    return m.mod_queue_outcome_resolved();
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
    {#each ([['open', m.mod_queue_tab_new()], ['closed', m.mod_queue_tab_resolved()], ['banned', m.mod_queue_tab_banned()]] as const) as [t, label] (t)}
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

  {#if activeTab === 'banned'}
    <BansList {guildId} />
  {:else if loading}
    <p class="text-text-muted text-sm">{m.mod_queue_loading()}</p>
  {:else if loadError}
    <p class="text-destructive text-sm" data-testid="modqueue-error">{m.mod_queue_load_error({ error: loadError })}</p>
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
            {#if activeTab === 'closed'}
              <span
                class="rounded-full bg-bg-input px-2 py-0.5 text-xs font-medium text-text-base"
                data-testid="modqueue-outcome"
              >{outcomeLabel(r)}</span>
            {/if}
            {#if r.escalated_at}
              <span
                class="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning"
                data-testid="modqueue-escalated-badge"
              >{m.mod_queue_escalated_badge()}</span>
            {/if}
          </div>
          <p class="text-text-base mb-3 line-clamp-3 text-sm">{r.body}</p>
          {#if r.resolution_note}
            <p class="text-text-muted mb-3 text-xs italic">{m.mod_queue_note({ note: r.resolution_note })}</p>
          {/if}
          {#if activeTab === 'open'}
            <div class="flex flex-wrap gap-2">
              {#if r.target_user_id}
                <button
                  type="button"
                  onclick={() => openBan(r)}
                  disabled={actingId === r.id}
                  class="rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                  data-testid="modqueue-ban-btn"
                >
                  {m.mod_queue_btn_ban()}
                </button>
              {/if}
              {#if r.target_message_id}
                <button
                  type="button"
                  onclick={() => closeReport(r, 'resolved', 'message_delete', m.mod_queue_toast_deleted())}
                  disabled={actingId === r.id}
                  class="bg-bg-input text-text-base hover:bg-bg-hover rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
                  data-testid="modqueue-delete-btn"
                >
                  {m.mod_queue_btn_delete_message()}
                </button>
              {/if}
              {#if !r.escalated_at}
                <button
                  type="button"
                  onclick={() => openEscalate(r)}
                  disabled={actingId === r.id}
                  class="rounded-md bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
                  data-testid="modqueue-escalate-btn"
                >
                  {m.mod_queue_btn_escalate()}
                </button>
              {/if}
              <button
                type="button"
                onclick={() => closeReport(r, 'dismissed', undefined, m.mod_queue_toast_dismissed())}
                disabled={actingId === r.id}
                class="text-text-muted hover:bg-bg-hover ml-auto rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
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

<!-- Bannen-Bestätigung -->
<AlertDialog.Root bind:open={banDialogOpen}>
  <AlertDialog.Content data-testid="modqueue-ban-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.mod_queue_ban_dialog_title()}</AlertDialog.Title>
      <AlertDialog.Description>{m.mod_queue_ban_dialog_desc()}</AlertDialog.Description>
    </AlertDialog.Header>
    <div class="py-2">
      <textarea
        bind:value={banReason}
        rows="2"
        placeholder={m.mod_queue_ban_reason_placeholder()}
        class="bg-bg-input border-border text-text-base placeholder:text-text-muted w-full resize-none rounded-lg border px-3 py-2 text-sm"
        data-testid="modqueue-ban-reason"
      ></textarea>
    </div>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.mod_queue_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmBan} disabled={actingId !== null}>
        {actingId !== null ? m.mod_queue_banning() : m.mod_queue_ban_confirm()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<!-- An-Pulse-weiterleiten-Bestätigung -->
<AlertDialog.Root bind:open={escalateDialogOpen}>
  <AlertDialog.Content data-testid="modqueue-escalate-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.mod_queue_escalate_dialog_title()}</AlertDialog.Title>
      <AlertDialog.Description>{m.mod_queue_escalate_dialog_desc()}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.mod_queue_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmEscalate} disabled={escalating}>
        {escalating ? m.mod_queue_escalating() : m.mod_queue_escalate_confirm()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
