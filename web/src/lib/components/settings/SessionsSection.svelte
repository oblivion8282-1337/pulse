<script lang="ts">
  /**
   * "Aktive Sessions"-Block im Sicherheits-Tab.
   *
   * Lädt onMount alle aktiven Sessions (= Refresh-Tokens) und gibt dem User
   * einen Knopf pro Eintrag, sowie einen Bulk-Revoke-Knopf für alle anderen.
   * Optimistic-update: nach einem erfolgreichen DELETE entfernen wir die
   * Session lokal aus der Liste — bei einem Fehler refetchen wir.
   *
   * Sonderfall: revoked der User aus Versehen seine eigene (`is_current`)
   * Session, dann läuft `auth.signOut()` — der nächste `/refresh` würde
   * sowieso 401 zurückgeben und ihn rauswerfen, also vorziehen für saubere
   * UX (Toast + Redirect statt schwarzer Screen).
   */
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import { listSessions, revokeSession, revokeOtherSessions } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import type { Session } from '$lib/api/types';
  import { formatUserAgent } from '$lib/utils/userAgent';
  import { formatRelative } from '$lib/utils/formatRelative';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let sessions = $state<Session[]>([]);
  let loading = $state(true);
  let revokingId = $state<string | null>(null);
  let bulkOpen = $state(false);
  let bulkBusy = $state(false);

  const otherCount = $derived(sessions.filter((s) => !s.is_current).length);

  async function load() {
    loading = true;
    try {
      sessions = await listSessions();
    } catch (err) {
      toast.error(m.sessions_section_load_failed(), {
        description: (err as Error).message
      });
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function handleRevoke(s: Session) {
    if (revokingId) return;
    revokingId = s.id;
    try {
      await revokeSession(s.id);
      // Optimistic local removal — refetch on error path.
      sessions = sessions.filter((x) => x.id !== s.id);
      if (s.is_current) {
        toast.success(m.sessions_section_current_revoked());
        auth.signOut();
        return;
      }
      toast.success(m.sessions_section_session_revoked());
    } catch (err) {
      toast.error(m.sessions_section_revoke_failed(), {
        description: (err as Error).message
      });
      void load();
    } finally {
      revokingId = null;
    }
  }

  async function handleBulkRevoke() {
    if (bulkBusy) return;
    bulkBusy = true;
    try {
      const res = await revokeOtherSessions();
      sessions = sessions.filter((s) => s.is_current);
      const n = res.revoked_count;
      toast.success(m.sessions_section_bulk_revoked({ count: n }));
      bulkOpen = false;
    } catch (err) {
      toast.error(m.sessions_section_revoke_failed(), {
        description: (err as Error).message
      });
    } finally {
      bulkBusy = false;
    }
  }
</script>

<section
  class="border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4"
  data-testid="sessions-section"
>
  <div class="flex flex-col gap-1">
    <h3 class="text-text-bright text-sm font-semibold">{m.sessions_section_title()}</h3>
    <p class="text-text-muted text-xs">
      {m.sessions_section_description()}
    </p>
  </div>

  {#if loading}
    <LoadingState label={m.sessions_section_loading()} />
  {:else if sessions.length === 0}
    <EmptyState message={m.sessions_section_empty()} />
  {:else}
    <ul class="flex flex-col gap-2" data-testid="sessions-list">
      {#each sessions as s (s.id)}
        <li
          class="border-border bg-bg-base/40 flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="session-row"
          data-session-id={s.id}
        >
          <div class="flex items-start gap-3 min-w-0">
            <span
              class="bg-bg-input text-text-muted mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full"
            >
              <MonitorIcon class="size-4" />
            </span>
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="text-text-bright truncate text-sm font-medium">
                {formatUserAgent(s.user_agent)}
                {#if s.is_current}
                  <span
                    class="ml-1 inline-flex items-center rounded bg-success/15 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-success md:px-1.5 md:py-0.5 md:text-[10px]"
                    data-testid="session-current-badge"
                  >
                    {m.sessions_section_current_badge()}
                  </span>
                {/if}
              </span>
              <span class="text-text-muted text-xs">
                {m.sessions_section_session_meta({ signedIn: formatRelative(s.created_at), active: formatRelative(s.last_used_at ?? s.created_at) })}
              </span>
              {#if s.ip_hash_prefix}
                <span class="text-text-muted font-mono text-xs uppercase tracking-wider md:text-[10px]">
                  {m.sessions_section_source({ prefix: s.ip_hash_prefix })}
                </span>
              {/if}
            </div>
          </div>

          {#if !s.is_current}
            <button
              type="button"
              onclick={() => handleRevoke(s)}
              disabled={revokingId === s.id}
              class="text-destructive bg-destructive/10 hover:bg-destructive/20 self-start rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 sm:self-auto md:py-1.5"
              data-testid="session-revoke"
            >
              {revokingId === s.id ? m.sessions_section_revoking() : m.sessions_section_revoke_this()}
            </button>
          {/if}
        </li>
      {/each}
    </ul>

    {#if otherCount > 0}
      <button
        type="button"
        onclick={() => (bulkOpen = true)}
        class="text-destructive bg-destructive/10 hover:bg-destructive/20 mt-1 self-start rounded-md px-3 py-2 text-sm font-medium transition-colors md:py-1.5"
        data-testid="sessions-revoke-all"
      >
        {m.sessions_section_revoke_all_others()}
      </button>
    {/if}
  {/if}
</section>

<AlertDialog.Root bind:open={bulkOpen}>
  <AlertDialog.Content data-testid="sessions-revoke-all-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.sessions_section_bulk_dialog_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.sessions_section_bulk_dialog_description()}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={bulkBusy}>{m.sessions_section_cancel()}</AlertDialog.Cancel>
      <Button
        variant="destructive"
        onclick={handleBulkRevoke}
        disabled={bulkBusy}
        data-testid="sessions-revoke-all-confirm"
      >
        {bulkBusy ? m.sessions_section_revoking() : m.sessions_section_revoke_all_confirm()}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
