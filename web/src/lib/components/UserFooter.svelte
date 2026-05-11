<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { toast } from 'svelte-sonner';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import { logout } from '$lib/api/auth';
  import { deleteAvatar } from '$lib/api/auth';
  import { loadTokens } from '$lib/api/storage';
  import AvatarUploadDialog from './AvatarUploadDialog.svelte';
  import ImagePlusIcon from '@lucide/svelte/icons/image-plus';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import LogOutIcon from '@lucide/svelte/icons/log-out';

  let uploadOpen = $state(false);

  let displayName = $derived(
    auth.user ? (auth.user.display_name ?? auth.user.username) : ''
  );
  let username = $derived(auth.user?.username ?? '');
  let initial = $derived(displayName.slice(0, 1).toUpperCase());

  function safeAvatarUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    return url.startsWith('/') || url.startsWith('https://') ? url : null;
  }
  let avatarUrl = $derived(safeAvatarUrl(auth.user?.avatar_url));

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
      toast.success('Profilbild entfernt');
    } catch (e) {
      toast.error('Fehler beim Entfernen', { description: (e as Error).message });
    }
  }
</script>

<AvatarUploadDialog bind:open={uploadOpen} />

<div
  class="bg-bg-sidebar flex h-14 shrink-0 items-center gap-2 border-t border-black/30 px-2"
  data-testid="user-footer"
>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          class="hover:bg-bg-hover flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 transition-colors"
          data-testid="user-footer-trigger"
        >
          {#key avatarUrl}
            <Avatar.Root class="size-8 shrink-0">
              {#if avatarUrl}
                <Avatar.Image src={avatarUrl} alt={displayName} />
              {/if}
              <Avatar.Fallback class="bg-primary text-primary-foreground text-xs font-semibold">
                {initial}
              </Avatar.Fallback>
            </Avatar.Root>
          {/key}
          <div class="min-w-0 text-left">
            <p class="text-text-bright truncate text-sm font-medium">{displayName}</p>
            {#if displayName !== username}
              <p class="text-text-muted truncate text-xs">{username}</p>
            {/if}
          </div>
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="top" align="start" class="w-52">
      <DropdownMenu.Item onclick={() => (uploadOpen = true)} data-testid="avatar-change-btn">
        <ImagePlusIcon class="size-4" />
        Profilbild ändern
      </DropdownMenu.Item>
      {#if auth.user?.avatar_url}
        <DropdownMenu.Item onclick={onRemoveAvatar} data-testid="avatar-remove-btn">
          <Trash2Icon class="size-4" />
          Profilbild entfernen
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onclick={onSignOut} data-testid="sign-out">
        <LogOutIcon class="size-4" />
        Abmelden
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
