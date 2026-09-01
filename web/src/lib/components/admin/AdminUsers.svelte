<!--
  User list + per-row toggles. Cursor pagination (Mehr laden) — server caps
  at 200 per page. Each row exposes a popover with two checkboxes
  (Admin / Gesperrt). PATCH /admin/users/{id} re-renders the row from the
  server response.

  Self-row note: the server rejects "demote last admin" and "disable
  yourself" with 400; we let the click through and surface the toast.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { adminApi, type AdminUser } from '$lib/api/admin';
  import { auth } from '$lib/stores/auth.svelte';
  import AdminUserRow from './AdminUserRow.svelte';
  import SearchIcon from '@lucide/svelte/icons/search';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  type FilterMode = 'all' | 'admins' | 'disabled' | 'self_host';

  let users = $state<AdminUser[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let hasMore = $state(false);
  let loadingMore = $state(false);
  let pendingId = $state<string | null>(null);
  let query = $state('');
  let filterMode = $state<FilterMode>('all');

  const filters: { id: FilterMode; label: string }[] = [
    { id: 'all', label: m.admin_users_filter_all() },
    { id: 'admins', label: m.admin_users_filter_admins() },
    { id: 'disabled', label: m.admin_users_filter_disabled() },
    { id: 'self_host', label: m.admin_users_filter_self_host() }
  ];

  // Such-/Filter-Parameter fürs Backend. filter=all → weglassen (kein Filter).
  function queryParams() {
    const q = query.trim();
    return {
      ...(q ? { q } : {}),
      ...(filterMode !== 'all' ? { filter: filterMode } : {})
    };
  }

  async function loadInitial() {
    loading = true;
    error = null;
    try {
      const rows = await adminApi.listUsers({ limit: 50, ...queryParams() });
      users = rows;
      hasMore = rows.length >= 50;
    } catch (e) {
      error = errText(e);
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    const cursor = users[users.length - 1]?.id;
    if (!cursor) return;
    loadingMore = true;
    try {
      const more = await adminApi.listUsers({ before: cursor, limit: 50, ...queryParams() });
      users = [...users, ...more];
      hasMore = more.length >= 50;
    } catch (e) {
      toast.error(m.admin_users_load_more_failed(), {
        description: errText(e)
      });
    } finally {
      loadingMore = false;
    }
  }

  // Tippen entprellen: erst 300 ms nach dem letzten Tastendruck neu laden, damit
  // nicht jeder Buchstabe einen Request auslöst.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  function onSearchInput() {
    clearTimeout(debounce);
    debounce = setTimeout(loadInitial, 300);
  }

  function selectFilter(id: FilterMode) {
    if (filterMode === id) return;
    filterMode = id;
    void loadInitial();
  }

  function toggleSuccessMessage(field: 'is_admin' | 'disabled' | 'self_host_enabled') {
    switch (field) {
      case 'is_admin':
        return m.admin_users_admin_status_updated();
      case 'self_host_enabled':
        return m.admin_users_self_host_updated();
      default:
        return m.admin_users_ban_updated();
    }
  }

  async function toggle(u: AdminUser, field: 'is_admin' | 'disabled' | 'self_host_enabled', next: boolean) {
    pendingId = u.id;
    try {
      const updated = await adminApi.patchUser(u.id, { [field]: next });
      users = users.map((x) => (x.id === u.id ? updated : x));
      toast.success(toggleSuccessMessage(field));
    } catch (e) {
      // Errors from the safety nets (last admin, self-disable) bubble through
      // here with the server's German-friendly detail — surface it raw.
      const msg = errText(e);
      toast.error(m.admin_users_change_rejected(), { description: msg });
    } finally {
      pendingId = null;
    }
  }

  onMount(loadInitial);
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-users">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_users_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">
      {m.admin_users_description()}
    </p>
  </div>

  <!-- Suchfeld -->
  <div class="relative mb-3">
    <SearchIcon
      class="text-text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
    />
    <Input
      type="search"
      bind:value={query}
      oninput={onSearchInput}
      placeholder={m.admin_users_search_placeholder()}
      class="w-full py-2 pr-3 pl-9"
      data-testid="admin-users-search"
    />
  </div>

  <!-- Filter-Chips -->
  <div class="mb-4 flex flex-wrap gap-1.5" data-testid="admin-users-filters">
    {#each filters as f (f.id)}
      <button
        type="button"
        onclick={() => selectFilter(f.id)}
        class="rounded-full border px-3 py-1 text-xs transition-colors {filterMode === f.id
          ? 'border-primary bg-primary/15 text-text-bright font-medium'
          : 'border-border text-text-muted hover:text-text-base'}"
        data-testid="admin-users-filter-{f.id}"
      >
        {f.label}
      </button>
    {/each}
  </div>

  {#if error}
    <FieldError message={m.admin_users_error({ message: error ?? '' })} />
  {:else if loading}
    <LoadingState label={m.admin_users_loading()} />
  {:else if users.length === 0}
    <EmptyState message={m.admin_users_empty()} testId="admin-users-empty" />
  {:else}
    <ul class="divide-border bg-bg-hover/30 divide-y rounded-xl border border-border">
      {#each users as u (u.id)}
        <AdminUserRow user={u} me={auth.user?.id === u.id} pending={pendingId === u.id} ontoggle={toggle} />
      {/each}
    </ul>

    {#if hasMore}
      <div class="mt-3 flex justify-center">
        <Button variant="secondary" onclick={loadMore} disabled={loadingMore} data-testid="admin-users-more">
          {m.admin_users_load_more()}
        </Button>
      </div>
    {/if}
  {/if}
</section>
