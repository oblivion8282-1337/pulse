<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';
  import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import { logout } from '$lib/api/auth';
  import { loadTokens } from '$lib/api/storage';
  import { safeAvatarUrl } from '$lib/avatar';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import SettingsDialog from './SettingsDialog.svelte';
  import StatusPicker from './StatusPicker.svelte';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import LogOutIcon from '@lucide/svelte/icons/log-out';

  // `compact`: nur das Avatar-Symbol, kein Name + kein Chip-Hintergrund — für
  // die mobile GuildRail, wo der eigene User unten in der Server-Spalte sitzt.
  // Default = volle Variante (Name + Chip) im Sidebar-Footer auf Desktop.
  let { compact = false }: { compact?: boolean } = $props();

  let displayName = $derived(
    auth.user ? (auth.user.display_name ?? auth.user.username) : ''
  );
  let username = $derived(auth.user?.username ?? '');
  let initial = $derived(displayName.slice(0, 1).toUpperCase());

  let avatarUrl = $derived(safeAvatarUrl(auth.user?.avatar_url));

  // Avatar-Punkt: ein EIGENER Antrag (Self-Host ODER App-Hosting) wurde
  // freigeschaltet und auf diesem Gerät noch nicht angesehen → der Punkt führt
  // den User über das Menü zu den Einstellungen. Ein User-Hinweis, kein
  // Admin-Alert — die Admin-Benachrichtigungen sitzen jetzt am eigenen
  // Server-Admin-Button (ServerAdminButton.svelte). Nur auf der Cloud relevant
  // (dort lebt die Self-Host-Verwaltung).
  let showOwnerSetupBadge = $derived(
    (activeServer.current?.isCloud ?? false) &&
      (myInstanceApplications.pendingSetup > 0 || myAppHostApplications.pendingSetup > 0)
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
</script>

<SettingsDialog bind:open={uiOverlays.settingsOpen} initialTab={uiOverlays.settingsInitialTab} />

{#snippet avatarBlock(sizeClass: string)}
  {#key avatarUrl}
    <div class="relative {sizeClass} shrink-0">
      <Avatar.Root class="size-full">
        {#if avatarUrl}
          <Avatar.Image src={avatarUrl} alt={displayName} />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
          {initial}
        </Avatar.Fallback>
      </Avatar.Root>
      {#if showOwnerSetupBadge}
        <span
          class="ring-bg-input absolute -right-0.5 -top-0.5 size-3 rounded-full bg-red-500 ring-2"
          data-testid="user-footer-dot"
          aria-label={m.instance_app_setup_badge_aria()}
        ></span>
      {/if}
    </div>
  {/key}
{/snippet}

{#snippet menuItems()}
  <!-- Profilbild ändern/löschen wohnt jetzt ausschließlich im Profil-Tab der
       Einstellungen — hier bewusst nur noch Einstellungen + Abmelden, damit das
       Menü schlank bleibt und nichts doppelt anbietet. -->
  <DropdownMenu.Item onclick={() => uiOverlays.openSettings()} data-testid="open-settings">
    <SettingsIcon class="size-4" />
    {m.user_footer_settings()}
  </DropdownMenu.Item>
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
              <!-- w-fit: Verlaufs-Box (background-clip:text) auf Textbreite
                   begrenzen, sonst zieht ein längerer Username den Block breiter
                   als den Namen und nur die Primärfarbe landet auf dem Namen. -->
              <p
                class="text-text-bright w-fit max-w-full truncate text-sm font-semibold"
                style={auth.user ? nameStyle(auth.user.id) : ''}
              >{displayName}</p>
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
