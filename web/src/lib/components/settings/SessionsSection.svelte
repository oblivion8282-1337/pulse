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
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import { listSessions, revokeSession, revokeOtherSessions } from '$lib/api/auth';
  import { auth } from '$lib/stores/auth.svelte';
  import type { Session } from '$lib/api/types';
  import { formatUserAgent } from '$lib/utils/userAgent';
  import { formatRelative } from '$lib/utils/formatRelative';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';

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
      toast.error('Sessions laden fehlgeschlagen', {
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
        toast.success('Diese Session wurde widerrufen — bis bald.');
        auth.signOut();
        return;
      }
      toast.success('Session widerrufen');
    } catch (err) {
      toast.error('Widerrufen fehlgeschlagen', {
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
      toast.success(
        n === 1 ? '1 Session widerrufen' : `${n} Sessions widerrufen`
      );
      bulkOpen = false;
    } catch (err) {
      toast.error('Widerrufen fehlgeschlagen', {
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
    <h3 class="text-text-bright text-sm font-semibold">Aktive Sessions</h3>
    <p class="text-text-muted text-xs">
      Geräte, auf denen du eingeloggt bist. Verdächtige Einträge sofort widerrufen.
    </p>
  </div>

  {#if loading}
    <div class="text-text-muted flex items-center gap-2 text-xs">
      <LoaderIcon class="size-4 animate-spin" />
      <span>Sessions werden geladen…</span>
    </div>
  {:else if sessions.length === 0}
    <div class="text-text-muted text-xs">Keine aktiven Sessions gefunden.</div>
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
                    class="ml-1 inline-flex items-center rounded bg-emerald-500/15 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-500 md:px-1.5 md:py-0.5 md:text-[10px]"
                    data-testid="session-current-badge"
                  >
                    Diese Session
                  </span>
                {/if}
              </span>
              <span class="text-text-muted text-xs">
                Angemeldet {formatRelative(s.created_at)} · Aktiv
                {formatRelative(s.last_used_at ?? s.created_at)}
              </span>
              {#if s.ip_hash_prefix}
                <span class="text-text-muted font-mono text-xs uppercase tracking-wider md:text-[10px]">
                  Quelle: {s.ip_hash_prefix}
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
              {revokingId === s.id ? 'Widerrufen…' : 'Diese Session widerrufen'}
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
        Alle anderen Sessions widerrufen
      </button>
    {/if}
  {/if}
</section>

<AlertDialog.Root bind:open={bulkOpen}>
  <AlertDialog.Content data-testid="sessions-revoke-all-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>Alle anderen Sessions widerrufen?</AlertDialog.Title>
      <AlertDialog.Description>
        Du bleibst auf diesem Gerät eingeloggt. Alle anderen Geräte werden ausgeloggt und müssen
        sich neu anmelden.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={bulkBusy}>Abbrechen</AlertDialog.Cancel>
      <Button
        variant="destructive"
        onclick={handleBulkRevoke}
        disabled={bulkBusy}
        data-testid="sessions-revoke-all-confirm"
      >
        {bulkBusy ? 'Widerrufen…' : 'Alle widerrufen'}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
