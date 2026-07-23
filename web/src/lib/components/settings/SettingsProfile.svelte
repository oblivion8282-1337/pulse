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
  import { settings } from '$lib/stores/settings.svelte';
  import {
    sanitizeProfileColor,
    sanitizeGradientAngle,
    DEFAULT_GRADIENT_ANGLE,
  } from '$lib/utils/nameColor';
  import NameColorEditor from '$lib/components/settings/NameColorEditor.svelte';
  import { me, deleteAvatar } from '$lib/api/auth';
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
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  const DEFAULT_COLOR = '#9ca3af';
  const DEFAULT_SECONDARY = '#22d3ee';

  let avatarOpen = $state(false);
  let avatarRemoving = $state(false);
  const avatarUrl = $derived(safeAvatarUrl(auth.user?.avatar_url));

  // Profilbild löschen — hierher gezogen aus dem User-Menü (der Footer bietet
  // das jetzt nicht mehr an, es gehört zum Profil-Tab). Aktualisiert auth.user
  // + userCache, damit das Bild sofort überall verschwindet.
  async function onRemoveAvatar() {
    if (avatarRemoving) return;
    avatarRemoving = true;
    try {
      await deleteAvatar();
      if (auth.user) {
        auth.setUser({ ...auth.user, avatar_url: null });
        userCache.seed([
          {
            id: auth.user.id,
            username: auth.user.username,
            display_name: auth.user.display_name ?? null,
            avatar_url: null,
          },
        ]);
      }
      toast.success(m.user_footer_avatar_removed());
    } catch (e) {
      toast.error(m.user_footer_avatar_remove_error(), { description: (e as Error).message });
    } finally {
      avatarRemoving = false;
    }
  }
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
  let useGradient = $state(false);
  let profileColorSecondary = $state(DEFAULT_SECONDARY);
  let gradientAngle = $state(DEFAULT_GRADIENT_ANGLE);
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
      const safeSecondary = sanitizeProfileColor(u.profile_color_secondary);
      useGradient = !!safeColor && !!safeSecondary;
      profileColorSecondary = safeSecondary ?? DEFAULT_SECONDARY;
      gradientAngle = sanitizeGradientAngle(u.profile_gradient_angle);
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
        profile_color_secondary: user.profile_color_secondary ?? null,
        profile_gradient_angle: user.profile_gradient_angle ?? null,
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
  // Gewünschter Zielzustand (Farbe aus, einfarbig, oder Verlauf) vs. gespeichert.
  const desiredColor = $derived(useColor ? profileColor : null);
  const desiredSecondary = $derived(useColor && useGradient ? profileColorSecondary : null);
  // Richtung nur persistieren, wenn ein Verlauf aktiv ist; sonst den
  // gespeicherten Wert in Ruhe lassen (Winkel ohne zwei Farben ist wirkungslos).
  const storedAngle = $derived(auth.user?.profile_gradient_angle ?? null);
  const desiredAngle = $derived(useColor && useGradient ? gradientAngle : storedAngle);
  const colorDirty = $derived(desiredColor !== sanitizeProfileColor(auth.user?.profile_color));
  const secondaryDirty = $derived(
    desiredSecondary !== sanitizeProfileColor(auth.user?.profile_color_secondary)
  );
  const angleDirty = $derived(desiredAngle !== storedAngle);
  const profileDirty = $derived(displayNameDirty || colorDirty || secondaryDirty || angleDirty);

  async function submitProfile() {
    if (!profileDirty || profileBusy) return;
    profileBusy = true;
    profileError = null;
    try {
      const payload: {
        display_name?: string | null;
        profile_color?: string | null;
        profile_color_secondary?: string | null;
        profile_gradient_angle?: number | null;
      } = {};
      if (displayNameDirty) payload.display_name = displayName.trim() || null;
      if (colorDirty) payload.profile_color = desiredColor;
      if (secondaryDirty) payload.profile_color_secondary = desiredSecondary;
      if (angleDirty) payload.profile_gradient_angle = desiredAngle;
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
    <h2 class="text-text-bright text-base font-semibold">{m.settings_profile_title()}</h2>
  </header>

  <!-- Display-Name + Profile-Color -->
  <section
    class="border-border bg-bg-input/40 flex flex-col gap-4 rounded-2xl border p-4"
    data-testid="profile-display-section"
  >
    <h3 class="text-text-bright text-sm font-semibold">{m.settings_profile_public_profile_heading()}</h3>

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
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" onclick={() => (avatarOpen = true)} data-testid="profile-avatar-change-btn">
          {m.user_footer_change_avatar()}
        </Button>
        {#if avatarUrl}
          <Button
            variant="outline"
            onclick={onRemoveAvatar}
            disabled={avatarRemoving}
            data-testid="profile-avatar-remove-btn"
          >
            {m.settings_profile_avatar_remove()}
          </Button>
        {/if}
      </div>
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

    <NameColorEditor
      bind:useColor
      bind:color1={profileColor}
      bind:useGradient
      bind:color2={profileColorSecondary}
      bind:angle={gradientAngle}
      previewName={auth.user?.display_name || auth.user?.username || m.settings_profile_color_preview()}
    />

    <!-- Sprech-Ring in Namensfarbe (aus dem Erscheinungsbild hierher gezogen,
         da es direkt zur eigenen Namensfarbe gehört). Geräte-lokal. -->
    <label class="flex items-start gap-2 text-sm">
      <Checkbox
        checked={settings.appearance.speakingRingNameColor}
        onchange={(e) => settings.setSpeakingRingNameColor(e.currentTarget.checked)}
        class="mt-0.5 shrink-0"
        data-testid="profile-speaking-ring-toggle"
      />
      <span class="flex flex-col gap-0.5">
        <span>{m.settings_profile_speaking_ring_label()}</span>
        <span class="text-text-muted text-xs">{m.settings_profile_speaking_ring_hint()}</span>
      </span>
    </label>

    <FieldError message={profileError} testId="profile-error" />

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
      <FieldError message={usernameError} testId="profile-username-error" />
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
