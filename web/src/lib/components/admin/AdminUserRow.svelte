<!--
  Eine Zeile der Admin-User-Liste: Avatar + Name/E-Mail, Status-Badges
  (Owner/Admin/Gesperrt/Self-Host) und das Aktions-Popover (Admin-Rolle,
  Sperren, Self-Host-Freischaltung). Ausgelagert aus AdminUsers.svelte, damit
  die Liste unter der Komponenten-Größen-Policy bleibt.
-->
<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import type { AdminUser } from '$lib/api/admin';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m } from '$lib/paraglide/messages.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import BanIcon from '@lucide/svelte/icons/ban';
  import ServerIcon from '@lucide/svelte/icons/server';
  import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';

  type Field = 'is_admin' | 'disabled' | 'self_host_enabled';

  let {
    user,
    me,
    pending,
    ontoggle
  }: {
    user: AdminUser;
    me: boolean;
    pending: boolean;
    ontoggle: (u: AdminUser, field: Field, next: boolean) => void;
  } = $props();
</script>

<li class="flex items-center gap-3 p-3" data-testid="admin-user-row" data-user-id={user.id}>
  <Avatar.Root class="size-8 shrink-0">
    {#if safeAvatarUrl(user.avatar_url)}
      <Avatar.Image src={safeAvatarUrl(user.avatar_url)!} alt={user.username} />
    {/if}
    <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
      {(user.display_name ?? user.username).slice(0, 1).toUpperCase()}
    </Avatar.Fallback>
  </Avatar.Root>

  <div class="min-w-0 flex-1">
    <div class="text-text-bright flex items-center gap-2 truncate text-sm font-medium">
      {user.display_name ?? user.username}
      {#if me}<span class="text-text-muted text-xs">{m.admin_users_you()}</span>{/if}
    </div>
    <div class="text-text-muted truncate text-xs">@{user.username} · {user.email}</div>
  </div>

  <div class="flex shrink-0 items-center gap-1">
    {#if user.is_owner}
      <span
        class="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400"
        data-testid="badge-owner"
      >
        {m.admin_users_badge_owner()}
      </span>
    {:else if user.is_admin}
      <span
        class="bg-primary/15 text-primary rounded-md px-2 py-0.5 text-xs font-medium"
        data-testid="badge-admin"
      >
        {m.admin_users_badge_admin()}
      </span>
    {/if}
    {#if user.disabled}
      <span
        class="rounded-md bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
        data-testid="badge-disabled"
      >
        {m.admin_users_badge_disabled()}
      </span>
    {/if}
    {#if user.self_host_enabled}
      <span
        class="rounded-md bg-success/15 px-2 py-0.5 text-xs font-medium text-success"
        data-testid="badge-selfhost"
      >
        {m.admin_users_badge_self_host()}
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
          disabled={pending}
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
        <!-- Der Owner ist gegen Entmachten/Sperren geschützt (Backend 400) →
             diese Aktionen für ihn gar nicht erst anbieten. -->
        {#if !user.is_owner}
          <button
            type="button"
            class="hover:bg-bg-hover text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
            onclick={() => ontoggle(user, 'is_admin', !user.is_admin)}
            data-testid="toggle-admin-btn"
          >
            <ShieldIcon class="size-4" />
            {user.is_admin ? m.admin_users_revoke_admin() : m.admin_users_make_admin()}
          </button>
          <button
            type="button"
            class="hover:bg-bg-hover text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
            onclick={() => ontoggle(user, 'disabled', !user.disabled)}
            data-testid="toggle-disabled-btn"
          >
            <BanIcon class="size-4" />
            {user.disabled ? m.admin_users_unban() : m.admin_users_ban()}
          </button>
        {/if}
        <button
          type="button"
          class="hover:bg-bg-hover text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
          onclick={() => ontoggle(user, 'self_host_enabled', !user.self_host_enabled)}
          data-testid="toggle-selfhost-btn"
        >
          <ServerIcon class="size-4" />
          {user.self_host_enabled ? m.admin_users_self_host_revoke() : m.admin_users_self_host_grant()}
        </button>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>
</li>
