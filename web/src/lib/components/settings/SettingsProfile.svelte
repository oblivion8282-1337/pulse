<script lang="ts">
  /**
   * "Profil"-Tab in den Settings.
   *
   * Schickt POST /me/profile (display_name + profile_color) und
   * POST /me/username (Username-Change mit 30-Tage-Cooldown). Triggert
   * danach forceProfileRefresh() damit das frisch signierte Profile-
   * Statement sofort gepullt + per Push-Cache zu den Server-Connections
   * weitergegeben wird (kein Wait auf den Hintergrund-Refresh-Timer).
   */
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { sanitizeProfileColor } from '$lib/utils/nameColor';
  import { me } from '$lib/api/auth';
  import { changeUsername, updateProfile, type UsernameChangeResponse } from '$lib/api/credentials';
  import { ApiError } from '$lib/api/client';
  import { forceProfileRefresh } from '$lib/identity/profile-refresh.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { safeAvatarUrl } from '$lib/avatar';
  import AvatarUploadDialog from '$lib/components/AvatarUploadDialog.svelte';

  const DEFAULT_COLOR = '#9ca3af';

  let avatarOpen = $state(false);
  const avatarUrl = $derived(safeAvatarUrl(auth.user?.avatar_url));
  const avatarInitial = $derived(
    (auth.user?.display_name || auth.user?.username || '?').charAt(0).toUpperCase()
  );

  const initial = $derived({
    username: auth.user?.username ?? '',
    displayName: auth.user?.display_name ?? '',
    profileColor: auth.user?.profile_color ?? '',
  });

  // Lokaler Buffer — wird beim auth.user-Wechsel resynced.
  let username = $state('');
  let displayName = $state('');
  let useColor = $state(false);
  let profileColor = $state(DEFAULT_COLOR);
  let lastSeededUserId = $state<string | null>(null);

  $effect(() => {
    const u = auth.user;
    if (!u) return;
    if (u.id !== lastSeededUserId) {
      lastSeededUserId = u.id;
      lastReservation = null;
      username = u.username;
      displayName = u.display_name ?? '';
      // Sanitize gegen Altdaten von vor der Hex-Pattern-Validierung — der
      // Wert landet unten direkt in einem style-Attribut.
      const safeColor = sanitizeProfileColor(u.profile_color);
      useColor = !!safeColor;
      profileColor = safeColor ?? DEFAULT_COLOR;
    }
  });

  async function refreshUser() {
    const [user] = await Promise.all([me(), forceProfileRefresh()]);
    auth.setUser(user);
    // userCache mitziehen, damit Name/Farbe in Nachrichten, Mitgliederliste
    // und Mentions sofort umspringen (gleicher Pfad wie der Avatar-Upload).
    userCache.seed([
      {
        id: user.id,
        username: user.username,
        display_name: user.display_name ?? null,
        avatar_url: user.avatar_url ?? null,
        profile_color: user.profile_color ?? null,
      },
    ]);
  }

  // ---- Username ------------------------------------------------------------
  let usernameBusy = $state(false);
  let usernameError = $state<string | null>(null);
  let usernameSuggestions = $state<string[]>([]);
  let lastReservation = $state<UsernameChangeResponse | null>(null);

  const usernameValid = $derived(
    /^[a-z0-9_]{3,32}$/i.test(username.trim()) && username.trim() !== initial.username,
  );

  async function submitUsername() {
    if (!usernameValid || usernameBusy) return;
    usernameBusy = true;
    usernameError = null;
    usernameSuggestions = [];
    try {
      lastReservation = await changeUsername(username.trim());
      await refreshUser();
      toast.success(m.settings_profile_username_changed(), {
        description: m.settings_profile_old_name_reserved(),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { detail?: { error?: string; suggestions?: string[] } } | null;
        const d = body?.detail;
        if (d?.error === 'username_taken') {
          usernameError = m.settings_profile_username_taken();
          usernameSuggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
        } else if (d?.error === 'username_reserved') {
          usernameError = m.settings_profile_username_reserved();
        } else {
          usernameError = err.message;
        }
      } else {
        usernameError = (err as Error).message;
      }
    } finally {
      usernameBusy = false;
    }
  }

  // ---- Display-Name + Profile-Color ---------------------------------------
  let profileBusy = $state(false);
  let profileError = $state<string | null>(null);

  const displayNameDirty = $derived(displayName.trim() !== initial.displayName);
  const colorDirty = $derived(
    useColor ? profileColor !== (initial.profileColor ?? DEFAULT_COLOR) : !!initial.profileColor,
  );
  const profileDirty = $derived(displayNameDirty || colorDirty);

  async function submitProfile() {
    if (!profileDirty || profileBusy) return;
    profileBusy = true;
    profileError = null;
    try {
      const payload: { display_name?: string | null; profile_color?: string | null } = {};
      if (displayNameDirty) payload.display_name = displayName.trim() || null;
      if (colorDirty) payload.profile_color = useColor ? profileColor : null;
      await updateProfile(payload);
      await refreshUser();
      toast.success(m.settings_profile_saved());
    } catch (err) {
      profileError = err instanceof Error ? err.message : m.settings_profile_unknown_error();
    } finally {
      profileBusy = false;
    }
  }
</script>

<div class="space-y-6 pr-2" data-testid="settings-profile">
  <header>
    <h2 class="text-text-bright text-lg font-semibold">{m.settings_profile_title()}</h2>
    <p class="text-text-muted text-sm">
      {m.settings_profile_subtitle()}
    </p>
  </header>

  <!-- Display-Name + Profile-Color -->
  <section
    class="border-border bg-bg-input/40 flex flex-col gap-4 rounded-2xl border p-4"
    data-testid="profile-display-section"
  >
    <div class="flex flex-col gap-1">
      <h3 class="text-text-bright text-sm font-semibold">{m.settings_profile_public_profile_heading()}</h3>
      <p class="text-text-muted text-xs">
        {m.settings_profile_public_profile_description()}
      </p>
    </div>

    <div class="flex items-center gap-4" data-testid="profile-avatar-section">
      {#key avatarUrl}
        <Avatar.Root class="size-16 shrink-0">
          {#if avatarUrl}
            <Avatar.Image src={avatarUrl} alt={displayName} />
          {/if}
          <Avatar.Fallback class="accent-gradient text-primary-foreground text-lg font-semibold">
            {avatarInitial}
          </Avatar.Fallback>
        </Avatar.Root>
      {/key}
      <Button variant="outline" onclick={() => (avatarOpen = true)} data-testid="profile-avatar-change-btn">
        {m.user_footer_change_avatar()}
      </Button>
    </div>

    <div class="flex flex-col gap-2">
      <Label for="profile-display-name">{m.settings_profile_display_name_label()}</Label>
      <Input
        id="profile-display-name"
        bind:value={displayName}
        placeholder={initial.username || m.settings_profile_display_name_placeholder()}
        maxlength={64}
        data-testid="profile-display-name-input"
      />
    </div>

    <div class="flex flex-col gap-2">
      <span class="text-text-base text-sm font-medium">{m.settings_profile_color_label()}</span>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            bind:checked={useColor}
            class="size-4"
            data-testid="profile-color-toggle"
          />
          {m.settings_profile_use_color()}
        </label>
        <input
          type="color"
          bind:value={profileColor}
          disabled={!useColor}
          class="h-8 w-12 cursor-pointer rounded border border-border bg-transparent disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="profile-color-input"
        />
        <span
          class="text-text-bright text-sm font-medium"
          style={useColor ? `color: ${profileColor}` : ''}
        >
          {auth.user?.display_name || auth.user?.username || m.settings_profile_color_preview()}
        </span>
      </div>
    </div>

    {#if profileError}
      <p class="text-destructive text-sm" data-testid="profile-error">{profileError}</p>
    {/if}

    <div class="flex justify-end">
      <Button
        onclick={submitProfile}
        disabled={!profileDirty || profileBusy}
        data-testid="profile-save-btn"
      >
        {profileBusy ? m.settings_profile_saving() : m.settings_profile_save_button()}
      </Button>
    </div>
  </section>

  <!-- Username -->
  <section
    class="border-border bg-bg-input/40 flex flex-col gap-4 rounded-2xl border p-4"
    data-testid="profile-username-section"
  >
    <div class="flex flex-col gap-1">
      <h3 class="text-text-bright text-sm font-semibold">{m.settings_profile_username_heading()}</h3>
      <p class="text-text-muted text-xs">
        {m.settings_profile_username_description()}
      </p>
    </div>

    <div class="flex flex-col gap-2">
      <Label for="profile-username">{m.settings_profile_username_label()}</Label>
      <Input
        id="profile-username"
        bind:value={username}
        placeholder={initial.username}
        maxlength={32}
        autocomplete="username"
        data-testid="profile-username-input"
      />
      <p class="text-text-muted text-xs">{m.settings_profile_username_hint()}</p>
    </div>

    {#if usernameError}
      <p class="text-destructive text-sm" data-testid="profile-username-error">{usernameError}</p>
      {#if usernameSuggestions.length}
        <div class="flex flex-wrap gap-2">
          {#each usernameSuggestions as s (s)}
            <Button
              variant="ghost"
              size="sm"
              onclick={() => (username = s)}
              data-testid="profile-username-suggestion"
            >
              {s}
            </Button>
          {/each}
        </div>
      {/if}
    {/if}

    {#if lastReservation}
      <p class="text-text-muted text-xs" data-testid="profile-username-reservation">
        {m.settings_profile_username_reservation({ date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' }).format(new Date(lastReservation.reserved_until)) })}
      </p>
    {/if}

    <div class="flex justify-end">
      <Button
        onclick={submitUsername}
        disabled={!usernameValid || usernameBusy}
        data-testid="profile-username-save-btn"
      >
        {usernameBusy ? m.settings_profile_username_changing() : m.settings_profile_username_change_button()}
      </Button>
    </div>
  </section>
</div>

<AvatarUploadDialog bind:open={avatarOpen} />
