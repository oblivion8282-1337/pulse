<!--
  Owner-only cloud-wide community (guild) overview. Metadata only — never any
  chat content. Lists every community on the Cloud with its owner, member count,
  storage and created date, searchable + cursor-paginated. The owner_id is
  resolved to a name via the shared user cache (single list round-trip on the
  server; names filled in client-side). Gated to `auth.user.is_owner`; the
  `/owner/*` endpoints 403 for anyone else.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import AdminCommunityDeleteDialog from './AdminCommunityDeleteDialog.svelte';
  import AdminCommunityLimits from './AdminCommunityLimits.svelte';
  import { adminApi, type Community } from '$lib/api/admin';
  import { userCache } from '$lib/stores/users.svelte';
  import { formatBytes } from '$lib/utils/formatBytes';
  import SearchIcon from '@lucide/svelte/icons/search';
  import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
  import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let communities = $state<Community[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let nextBefore = $state<string | null>(null);
  let loadingMore = $state(false);
  let query = $state('');
  let pendingId = $state<string | null>(null);
  // Which community's settings panel is expanded (aufklappen). One at a time.
  let expandedId = $state<string | null>(null);

  // Löschen läuft über einen eigenständigen Dialog (AdminCommunityDeleteDialog)
  // mit Namen-Tippen-Abfrage — hier nur Ziel + Sichtbarkeit halten.
  let deleteTarget = $state<Community | null>(null);
  let deleteOpen = $state(false);

  // Queue every owner id for name resolution as rows arrive. `displayName`
  // falls back to "…" until the batch fetch lands, then re-renders.
  function queueOwners(rows: Community[]) {
    for (const c of rows) userCache.queue(c.owner_id);
  }

  async function loadInitial() {
    loading = true;
    error = null;
    try {
      const res = await adminApi.listCommunities({ limit: 50, q: query.trim() || undefined });
      communities = res.communities;
      nextBefore = res.next_before;
      queueOwners(res.communities);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (loadingMore || !nextBefore) return;
    loadingMore = true;
    try {
      const res = await adminApi.listCommunities({
        before: nextBefore,
        limit: 50,
        q: query.trim() || undefined
      });
      communities = [...communities, ...res.communities];
      nextBefore = res.next_before;
      queueOwners(res.communities);
    } catch (e) {
      toast.error(m.admin_communities_load_more_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      loadingMore = false;
    }
  }

  // Debounce typing: reload 300ms after the last keystroke.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  function onSearchInput() {
    clearTimeout(debounce);
    debounce = setTimeout(loadInitial, 300);
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  function replaceRow(updated: Community) {
    communities = communities.map((x) => (x.id === updated.id ? updated : x));
  }

  async function toggleSuspend(c: Community) {
    if (!c.suspended) {
      const ok = await confirmDialog({
        description: m.admin_communities_suspend_confirm(),
        destructive: true
      });
      if (!ok) return;
    }
    pendingId = c.id;
    try {
      const updated = c.suspended
        ? await adminApi.unsuspendCommunity(c.id)
        : await adminApi.suspendCommunity(c.id);
      replaceRow(updated);
      toast.success(
        updated.suspended
          ? m.admin_communities_suspended_toast()
          : m.admin_communities_unsuspended_toast()
      );
    } catch (e) {
      toast.error(m.admin_communities_action_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      pendingId = null;
    }
  }

  function openDelete(c: Community) {
    deleteTarget = c;
    deleteOpen = true;
  }

  function onCommunityDeleted(id: string) {
    communities = communities.filter((x) => x.id !== id);
  }

  onMount(loadInitial);
</script>

<section class="border-border bg-bg-input rounded-2xl border p-5" data-testid="admin-communities">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_communities_title()}</h2>
    <p class="text-text-muted mt-0.5 text-xs">{m.admin_communities_description()}</p>
  </div>

  <div class="relative mb-4">
    <SearchIcon
      class="text-text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
    />
    <Input
      type="search"
      bind:value={query}
      oninput={onSearchInput}
      placeholder={m.admin_communities_search_placeholder()}
      class="w-full py-2 pr-3 pl-9"
      data-testid="admin-communities-search"
    />
  </div>

  {#if error}
    <FieldError message={m.admin_communities_error({ message: error ?? '' })} />
  {:else if loading}
    <LoadingState label={m.admin_communities_loading()} />
  {:else if communities.length === 0}
    <EmptyState message={m.admin_communities_empty()} testId="admin-communities-empty" />
  {:else}
    <ul class="divide-border border-border bg-bg-hover/30 divide-y rounded-xl border">
      {#each communities as c (c.id)}
        <li class="px-4 py-3" data-testid="admin-community-row">
        <div class="flex items-center gap-3">
          {#if c.icon_url}
            <img src={c.icon_url} alt="" class="size-9 shrink-0 rounded-xl object-cover" />
          {:else}
            <div
              class="bg-bg-hover text-text-muted flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold"
            >
              {c.name.slice(0, 1).toUpperCase()}
            </div>
          {/if}

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-text-bright truncate text-sm font-medium">{c.name}</span>
              <span
                class="rounded-full px-1.5 py-0.5 text-[10px] font-medium {c.is_public
                  ? 'bg-success/15 text-success'
                  : 'text-text-muted bg-bg-hover'}"
              >
                {c.is_public ? m.admin_communities_public() : m.admin_communities_private()}
              </span>
              {#if c.suspended}
                <span
                  class="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                >
                  {m.admin_communities_suspended_badge()}
                </span>
              {/if}
            </div>
            <div class="text-text-muted mt-0.5 truncate text-xs">
              {m.admin_communities_owner_label()}: {userCache.displayName(c.owner_id)}
              · {m.admin_communities_members({ count: c.member_count })}
            </div>
          </div>

          <div class="text-text-muted hidden shrink-0 text-right text-xs sm:block">
            <div>{m.admin_communities_storage_label()}: {formatBytes(c.storage_bytes)}</div>
            <div>{m.admin_communities_created_label()}: {fmtDate(c.created_at)}</div>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <Button
              variant={expandedId === c.id ? 'secondary' : 'outline'}
              size="sm"
              onclick={() => (expandedId = expandedId === c.id ? null : c.id)}
              data-testid="admin-community-settings-toggle"
              title={m.admin_communities_limits_toggle()}
            >
              <SlidersHorizontalIcon class="size-4" />
            </Button>
            <Button
              variant={c.suspended ? 'secondary' : 'outline'}
              size="sm"
              disabled={pendingId === c.id}
              onclick={() => toggleSuspend(c)}
              data-testid="admin-community-suspend-toggle"
            >
              {c.suspended ? m.admin_communities_unsuspend() : m.admin_communities_suspend()}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onclick={() => openDelete(c)}
              data-testid="admin-community-delete"
            >
              {m.admin_communities_delete()}
            </Button>
          </div>
        </div>

        {#if expandedId === c.id}
          <AdminCommunityLimits community={c} onSaved={replaceRow} />
        {/if}
        </li>
      {/each}
    </ul>

    {#if nextBefore}
      <div class="mt-3 flex justify-center">
        <Button
          variant="secondary"
          onclick={loadMore}
          disabled={loadingMore}
          data-testid="admin-communities-more"
        >
          {m.admin_communities_load_more()}
        </Button>
      </div>
    {/if}
  {/if}
</section>

<AdminCommunityDeleteDialog
  open={deleteOpen}
  community={deleteTarget}
  onClose={() => (deleteOpen = false)}
  onDeleted={onCommunityDeleted}
/>
