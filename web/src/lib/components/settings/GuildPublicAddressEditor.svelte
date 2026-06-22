<!--
  Öffentliche-Adresse-Editor. MANAGE_GUILD-gated Tab im Server-Settings-Dialog.

  Erlaubt das Setzen eines Slugs (Handle) + das Aktivieren/Deaktivieren der
  öffentlichen Community-Seite. Backend-Kontrakt:
    PATCH /guilds/{id}  { handle?, is_public? }
    → 400 wenn is_public=true ohne Handle
    → 409 wenn Handle bereits vergeben

  Kopierbare Adresse: <aktiver-Server-Host>/c/<handle> (nur sichtbar wenn
  Handle gesetzt). Der Host wird aus dem aktiven Server-Entry gelesen.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import GlobeIcon from '@lucide/svelte/icons/globe';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import { chatApi } from '$lib/api/chat';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  // Slug-Regex spiegelt Backend-Kontrakt (community_handle.py): 3–32 Zeichen,
  // alnum-Rand + bis zu 30 alnum/Bindestrich in der Mitte + alnum-Rand.
  // (Die mittlere Gruppe ist PFLICHT — kein `?` — sonst ließe der Client 1–2-
  // Zeichen-Handles durch, die das Backend mit 422 ablehnt.)
  const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

  let handle = $state('');
  let isPublic = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let copied = $state(false);

  /** Host-Origin des aktiven Servers (für die kopierbare Adresse). */
  let serverHost = $derived(activeServer.current?.hostname ?? '');

  let publicUrl = $derived(
    handle && serverHost ? `${serverHost}/c/${handle}` : null,
  );

  // Lokale Validierung (spiegelt Backend-Regex)
  let handleError = $derived(
    handle && !HANDLE_RE.test(handle) ? m.guild_public_address_handle_invalid() : null,
  );
  let canSubmit = $derived(
    !handleError && !saving && (handle !== '' || !isPublic),
  );

  onMount(async () => {
    try {
      const settings = await chatApi.getGuildSettings(guildId);
      handle = settings.handle ?? '';
      isPublic = settings.is_public;
    } catch {
      error = m.guild_public_address_load_failed();
    } finally {
      loading = false;
    }
  });

  async function save() {
    error = null;
    if (handleError) return;
    saving = true;
    try {
      await chatApi.patchGuildPublicAddress(guildId, {
        handle: handle || null,
        is_public: isPublic,
      });
      // PATCH /guilds/{id} gibt GuildOut zurück (kein handle/is_public) — frischen
      // State über GET /guilds/{id}/settings holen.
      const settings = await chatApi.getGuildSettings(guildId);
      handle = settings.handle ?? '';
      isPublic = settings.is_public;
      toast.success(m.guild_public_address_saved());
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        error = m.guild_public_address_handle_taken();
      } else if (status === 400) {
        error = m.guild_public_address_handle_required();
      } else {
        error = (err as Error).message || m.guild_public_address_save_failed();
      }
    } finally {
      saving = false;
    }
  }

  async function copyUrl() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      toast.error(m.guild_public_address_copy_failed());
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-text-bright text-base font-semibold">{m.guild_public_address_heading()}</h2>
    <p class="text-text-muted mt-1 text-sm">{m.guild_public_address_description()}</p>
  </div>

  {#if loading}
    <p class="text-text-muted text-sm">{m.guild_public_address_loading()}</p>
  {:else}
    <div class="space-y-4">
      <!-- Handle-Eingabe -->
      <div class="space-y-1.5">
        <Label
          for="guild-handle"
          class="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
        >
          {m.guild_public_address_handle_label()}
        </Label>
        <div class="flex items-center gap-2">
          <span class="text-text-muted text-sm">{serverHost}/c/</span>
          <Input
            id="guild-handle"
            type="text"
            bind:value={handle}
            placeholder={m.guild_public_address_handle_placeholder()}
            maxlength={32}
            autocomplete="off"
            data-testid="guild-handle-input"
            class="max-w-[220px]"
          />
        </div>
        <p class="text-text-muted text-xs">{m.guild_public_address_handle_hint()}</p>
        {#if handleError}
          <p class="text-destructive text-xs" data-testid="guild-handle-error">{handleError}</p>
        {/if}
      </div>

      <!-- Öffentlich-Toggle -->
      <label class="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          class="mt-0.5 size-4 accent-primary"
          bind:checked={isPublic}
          disabled={saving || (!handle && !isPublic)}
          data-testid="guild-public-toggle"
        />
        <div>
          <span class="text-text-bright text-sm font-medium">{m.guild_public_address_public_label()}</span>
          <p class="text-text-muted text-xs">{m.guild_public_address_public_hint()}</p>
        </div>
      </label>

      <!-- Kopierbare Adresse (nur sichtbar wenn Handle gesetzt) -->
      {#if publicUrl}
        <div class="bg-bg-input border-border flex items-center gap-2 rounded-lg border px-3 py-2">
          <GlobeIcon class="text-text-muted size-4 shrink-0" />
          <span
            class="text-text-bright min-w-0 flex-1 truncate font-mono text-sm"
            data-testid="guild-public-url"
          >
            {publicUrl}
          </span>
          <button
            type="button"
            class="text-text-muted hover:text-text-bright shrink-0 transition-colors"
            onclick={copyUrl}
            aria-label={m.guild_public_address_copy_aria()}
            data-testid="guild-public-url-copy"
          >
            {#if copied}
              <CheckIcon class="size-4 text-green-500" />
            {:else}
              <CopyIcon class="size-4" />
            {/if}
          </button>
        </div>
      {/if}

      {#if error}
        <Alert.Root variant="destructive" data-testid="guild-public-address-error">
          <OctagonXIcon />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      <Button
        type="button"
        disabled={!canSubmit}
        onclick={save}
        data-testid="guild-public-address-save"
      >
        {saving ? m.guild_public_address_saving() : m.guild_public_address_save()}
      </Button>
    </div>
  {/if}
</div>
