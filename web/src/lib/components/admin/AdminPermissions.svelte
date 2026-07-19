<!--
  Two toggle switches: who can create guilds, who can issue invites.

  Defaults are both ``on`` (the migration seeds them so) which keeps the
  historical "anyone can" behaviour. Off-states fall back to admin-only
  for guild creation and guild-owner-only for invites — see the server-
  side enforcement in routes/guilds.py + routes/invites.py.

  Toggles save immediately on click (no Speichern-button) since each
  switch is a single bool — the latency feels weird with a two-step
  flow. The PATCH is debounced via the in-flight check on the button.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Permissions } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input/index.js';
  import Switch from '$lib/components/form/Switch.svelte';
  import AdminCamLimits from './AdminCamLimits.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let current = $state<Permissions | null>(null);
  let busy = $state<{ allow_guild_creation: boolean; allow_member_invites: boolean }>({
    allow_guild_creation: false,
    allow_member_invites: false
  });
  let error = $state<string | null>(null);
  // Working copy of the size-limit input. Stored as KB for human input;
  // converted to bytes on save. Bound to <input type=number>; "" = empty
  // (user is editing) until they blur or press Speichern.
  let soundLimitKb = $state<number | ''>('');
  let soundLimitBusy = $state(false);

  onMount(async () => {
    try {
      current = await adminApi.getPermissions();
      soundLimitKb = Math.round(current.guild_sound_max_size_bytes / 1024);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function toggle(field: 'allow_guild_creation' | 'allow_member_invites') {
    if (!current || busy[field]) return;
    busy[field] = true;
    const before = current;
    const next = !before[field];
    // Erst umlegen, bei einem Fehler zurückdrehen — wie in AdminPlugins.
    // Der Schalter legt beim Klick seinen eigenen Stand um; bliebe `current`
    // im Fehlerfall unverändert, stünde die Anzeige danach falsch.
    current = { ...before, [field]: next };
    try {
      current = await adminApi.patchPermissions({ [field]: next });
      toast.success(m.admin_permissions_permission_updated());
    } catch (e) {
      current = before;
      toast.error(m.admin_permissions_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy[field] = false;
    }
  }

  async function saveSoundLimit() {
    if (!current || soundLimitBusy) return;
    const kb = typeof soundLimitKb === 'number' ? soundLimitKb : NaN;
    // Backend accepts 4096 (4 KB) – 5 * 1024 * 1024 (5 MB). Mirror here
    // so the toast tells the user *before* the round-trip what the cap is.
    if (!Number.isFinite(kb) || kb < 4 || kb > 5120) {
      toast.error(m.admin_permissions_invalid_value(), { description: m.admin_permissions_invalid_value_desc() });
      return;
    }
    soundLimitBusy = true;
    try {
      const updated = await adminApi.patchPermissions({
        guild_sound_max_size_bytes: Math.round(kb * 1024)
      });
      current = updated;
      soundLimitKb = Math.round(updated.guild_sound_max_size_bytes / 1024);
      toast.success(m.admin_permissions_size_limit_saved());
    } catch (e) {
      toast.error(m.admin_permissions_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      soundLimitBusy = false;
    }
  }
</script>

{#snippet toggleRow(field: 'allow_guild_creation' | 'allow_member_invites', title: string, description: string)}
  <div class="flex items-start justify-between gap-4 rounded-xl border border-border bg-bg-hover/30 p-3">
    <div class="min-w-0 flex-1">
      <div class="text-text-bright text-sm font-medium">{title}</div>
      <div class="text-text-muted text-xs mt-0.5">{description}</div>
    </div>
    <Switch
      checked={current ? current[field] : false}
      onCheckedChange={() => toggle(field)}
      aria-label={title}
      disabled={!current || busy[field]}
      data-testid="perm-toggle-{field}"
      class="disabled:cursor-wait"
    />
  </div>
{/snippet}

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-permissions">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_permissions_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">
      {m.admin_permissions_description()}
    </p>
  </div>

  {#if error}
    <FieldError message={m.admin_permissions_load_error({ error })} />
  {:else if current}
    <div class="flex flex-col gap-2">
      {@render toggleRow(
        'allow_guild_creation',
        m.admin_permissions_guild_creation_label(),
        m.admin_permissions_guild_creation_desc()
      )}
      {@render toggleRow(
        'allow_member_invites',
        m.admin_permissions_member_invites_label(),
        m.admin_permissions_member_invites_desc()
      )}

      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_permissions_sound_limit_label()}</div>
          <div class="text-text-muted text-xs mt-0.5">
            {m.admin_permissions_sound_limit_desc()}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Input
            type="number"
            min="4"
            max="5120"
            step="1"
            bind:value={soundLimitKb}
            class="w-24 text-right tabular-nums"
            data-testid="sound-limit-input"
            aria-label={m.admin_permissions_sound_limit_aria()}
          />
          <span class="text-text-muted text-xs">KB</span>
          <Button
            size="xs"
            disabled={soundLimitBusy || soundLimitKb === '' || Math.round(current.guild_sound_max_size_bytes / 1024) === soundLimitKb}
            onclick={saveSoundLimit}
            data-testid="sound-limit-save"
          >
            {m.admin_permissions_save_button()}
          </Button>
        </div>
      </div>
    </div>
  {:else}
    <LoadingState label={m.admin_permissions_loading()} />
  {/if}
</section>

<AdminCamLimits />
