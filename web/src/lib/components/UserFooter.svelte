<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { toast } from 'svelte-sonner';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import { logout } from '$lib/api/auth';
  import { deleteAvatar } from '$lib/api/auth';
  import { loadTokens } from '$lib/api/storage';
  import { safeAvatarUrl } from '$lib/avatar';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import AvatarUploadDialog from './AvatarUploadDialog.svelte';
  import SettingsDialog from './SettingsDialog.svelte';
  import StatusPicker from './StatusPicker.svelte';
  import ImagePlusIcon from '@lucide/svelte/icons/image-plus';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import LogOutIcon from '@lucide/svelte/icons/log-out';

  // `compact`: nur das Avatar-Symbol, kein Name + kein Chip-Hintergrund — für
  // die mobile GuildRail, wo der eigene User unten in der Server-Spalte sitzt.
  // Default = volle Variante (Name + Chip) im Sidebar-Footer auf Desktop.
  let { compact = false }: { compact?: boolean } = $props();

  let uploadOpen = $state(false);

  let displayName = $derived(
    auth.user ? (auth.user.display_name ?? auth.user.username) : ''
  );
  let username = $derived(auth.user?.username ?? '');
  let initial = $derived(displayName.slice(0, 1).toUpperCase());

  let avatarUrl = $derived(safeAvatarUrl(auth.user?.avatar_url));

  // Admin ist PRO Server (vgl. routes/app/admin/+page.svelte): Cloud →
  // auth.user.is_admin (auth /me); Self-Host → der is_admin aus dem ready-Frame
  // dieses Servers (Cert-Login-User haben dort kein auth /me). Ohne diese
  // Unterscheidung bleibt der Server-Admin-Eintrag für Self-Host-Admins
  // versteckt, weil ihr Cloud-Account kein is_admin trägt.
  let canAdminHere = $derived(
    activeServer.current?.isCloud
      ? (auth.user?.is_admin ?? false)
      : serverAdmin.isAdmin(activeServer.current?.id ?? '')
  );

  async function onSignOut() {
    const t = loadTokens();
    if (t) {
      try { await logout(t.refresh_token); } catch { /* ignore */ }
    }
    auth.signOut();
    gateway.disconnect();
    void import('$lib/voice/livekit.svelte').then(({ voice }) => voice.disconnect());
    guilds.clear();
    messages.clear();
    await goto('/login', { replaceState: true });
  }

  async function onRemoveAvatar() {
    try {
      await deleteAvatar();
      if (auth.user) {
        auth.setUser({ ...auth.user, avatar_url: null });
        userCache.seed([
          {
            id: auth.user.id,
            username: auth.user.username,
            display_name: auth.user.display_name ?? null,
            avatar_url: null
          }
        ]);
      }
      toast.success(m.user_footer_avatar_removed());
    } catch (e) {
      toast.error(m.user_footer_avatar_remove_error(), { description: (e as Error).message });
    }
  }
</script>

<AvatarUploadDialog bind:open={uploadOpen} />
<SettingsDialog bind:open={uiOverlays.settingsOpen} />

{#snippet avatarBlock(sizeClass: string)}
  {#key avatarUrl}
    <Avatar.Root class="{sizeClass} shrink-0">
      {#if avatarUrl}
        <Avatar.Image src={avatarUrl} alt={displayName} />
      {/if}
      <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
        {initial}
      </Avatar.Fallback>
    </Avatar.Root>
  {/key}
{/snippet}

{#snippet menuItems()}
  <DropdownMenu.Item onclick={() => (uploadOpen = true)} data-testid="avatar-change-btn">
    <ImagePlusIcon class="size-4" />
    {m.user_footer_change_avatar()}
  </DropdownMenu.Item>
  {#if auth.user?.avatar_url}
    <DropdownMenu.Item onclick={onRemoveAvatar} data-testid="avatar-remove-btn">
      <Trash2Icon class="size-4" />
      {m.user_footer_remove_avatar()}
    </DropdownMenu.Item>
  {/if}
  <DropdownMenu.Separator />
  <DropdownMenu.Item onclick={() => (uiOverlays.settingsOpen = true)} data-testid="open-settings">
    <SettingsIcon class="size-4" />
    {m.user_footer_settings()}
  </DropdownMenu.Item>
  {#if canAdminHere}
    <DropdownMenu.Item onclick={() => goto('/app/admin')} data-testid="open-admin">
      <ShieldIcon class="size-4" />
      {m.user_footer_server_admin()}
    </DropdownMenu.Item>
  {/if}
  <DropdownMenu.Separator />
  <DropdownMenu.Item onclick={onSignOut} data-testid="sign-out">
    <LogOutIcon class="size-4" />
    {m.user_footer_sign_out()}
  </DropdownMenu.Item>
{/snippet}

{#if compact}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          class="shrink-0 rounded-2xl transition-transform hover:scale-105 active:scale-95"
          data-testid="user-footer-trigger"
          aria-label={m.user_footer_account_settings_aria()}
        >
          {@render avatarBlock('size-12')}
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="right" align="end" class="w-52">
      {@render menuItems()}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <div
    class="bg-bg-input m-2 flex shrink-0 items-center gap-2.5 rounded-2xl border border-border p-2"
    data-testid="user-footer"
  >
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            class="hover:bg-bg-hover flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors"
            data-testid="user-footer-trigger"
          >
            {@render avatarBlock('size-8')}
            <div class="min-w-0 text-left">
              <p class="text-text-bright truncate text-sm font-semibold">{displayName}</p>
              {#if displayName !== username}
                <p class="text-text-muted truncate text-xs">{username}</p>
              {/if}
            </div>
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="start" class="w-52">
        {@render menuItems()}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <StatusPicker />
  </div>
{/if}
