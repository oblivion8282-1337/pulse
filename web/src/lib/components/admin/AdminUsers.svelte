<!--
  User list + per-row toggles. Cursor pagination (Mehr laden) — server caps
  at 200 per page. Each row exposes a popover with two checkboxes
  (Admin / Gesperrt). PATCH /admin/users/{id} re-renders the row from the
  server response.

  Self-row note: the server rejects "demote last admin" and "disable
  yourself" with 400; we let the click through and surface the toast.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import { adminApi, type AdminUser } from '$lib/api/admin';
  import { auth } from '$lib/stores/auth.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import BanIcon from '@lucide/svelte/icons/ban';
  import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';

  let users = $state<AdminUser[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let hasMore = $state(false);
  let loadingMore = $state(false);
  let pendingId = $state<string | null>(null);

  async function loadInitial() {
    loading = true;
    try {
      const rows = await adminApi.listUsers({ limit: 50 });
      users = rows;
      hasMore = rows.length === 50;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
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
      const more = await adminApi.listUsers({ before: cursor, limit: 50 });
      users = [...users, ...more];
      hasMore = more.length === 50;
    } catch (e) {
      toast.error(m.admin_users_load_more_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      loadingMore = false;
    }
  }

  async function toggle(u: AdminUser, field: 'is_admin' | 'disabled', next: boolean) {
    pendingId = u.id;
    try {
      const updated = await adminApi.patchUser(u.id, { [field]: next });
      users = users.map((x) => (x.id === u.id ? updated : x));
      toast.success(field === 'is_admin' ? m.admin_users_admin_status_updated() : m.admin_users_ban_updated());
    } catch (e) {
      // Errors from the safety nets (last admin, self-disable) bubble through
      // here with the server's German-friendly detail — surface it raw.
      const msg = e instanceof Error ? e.message : String(e);
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

  {#if error}
    <p class="text-red-400 text-sm">{m.admin_users_error({ message: error ?? '' })}</p>
  {:else if loading}
    <div class="text-text-muted text-sm">{m.admin_users_loading()}</div>
  {:else}
    <ul class="divide-border bg-bg-hover/30 divide-y rounded-xl border border-border">
      {#each users as u (u.id)}
        {@const me = auth.user?.id === u.id}
        <li class="flex items-center gap-3 p-3" data-testid="admin-user-row" data-user-id={u.id}>
          <Avatar.Root class="size-8 shrink-0">
            {#if safeAvatarUrl(u.avatar_url)}
              <Avatar.Image src={safeAvatarUrl(u.avatar_url)!} alt={u.username} />
            {/if}
            <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
              {(u.display_name ?? u.username).slice(0, 1).toUpperCase()}
            </Avatar.Fallback>
          </Avatar.Root>

          <div class="min-w-0 flex-1">
            <div class="text-text-bright flex items-center gap-2 truncate text-sm font-medium">
              {u.display_name ?? u.username}
              {#if me}<span class="text-text-muted text-xs">{m.admin_users_you()}</span>{/if}
            </div>
            <div class="text-text-muted truncate text-xs">@{u.username} · {u.email}</div>
          </div>

          <div class="flex shrink-0 items-center gap-1">
            {#if u.is_admin}
              <span
                class="bg-primary/15 text-primary rounded-md px-2 py-0.5 text-xs font-medium"
                data-testid="badge-admin"
              >
                {m.admin_users_badge_admin()}
              </span>
            {/if}
            {#if u.disabled}
              <span
                class="rounded-md bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400"
                data-testid="badge-disabled"
              >
                {m.admin_users_badge_disabled()}
              </span>
            {/if}
          </div>

          <PopoverPrimitive.Root>
            <PopoverPrimitive.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  class="text-text-muted hover:text-text-bright hover:bg-bg-hover rounded-md p-1.5"
                  aria-label={m.admin_users_actions_aria_label()}
                  disabled={pendingId === u.id}
                  data-testid="admin-user-actions"
                >
                  <MoreHorizontalIcon class="size-4" />
                </button>
              {/snippet}
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content
                side="left"
                sideOffset={8}
                class="ring-border bg-popover z-50 flex w-56 flex-col gap-1 rounded-xl p-2 shadow-xl ring-1 outline-none"
              >
                <button
                  type="button"
                  class="hover:bg-bg-hover text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
                  onclick={() => toggle(u, 'is_admin', !u.is_admin)}
                  data-testid="toggle-admin-btn"
                >
                  <ShieldIcon class="size-4" />
                  {u.is_admin ? m.admin_users_revoke_admin() : m.admin_users_make_admin()}
                </button>
                <button
                  type="button"
                  class="hover:bg-bg-hover text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
                  onclick={() => toggle(u, 'disabled', !u.disabled)}
                  data-testid="toggle-disabled-btn"
                >
                  <BanIcon class="size-4" />
                  {u.disabled ? m.admin_users_unban() : m.admin_users_ban()}
                </button>
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
        </li>
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
