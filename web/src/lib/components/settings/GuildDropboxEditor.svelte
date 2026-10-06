<!--
  Per-guild Dropbox / Ablage settings. Edits ``dropbox_configs`` via
  PATCH /guilds/{id}/dropbox/settings. Gates the master toggle, total
  quota (MB), per-file size cap (MB), and trash-retention (days). All
  values are clamped by the backend — see routes/_dropbox_schemas.py.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import Switch from '$lib/components/form/Switch.svelte';
  import { dropboxApi, type DropboxConfig } from '$lib/api/dropbox';
  import { formatBytes } from '$lib/utils/formatBytes';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  // Mirrors the server's DEFAULT_DROPBOX_QUOTA_BYTES
  // (routes/_dropbox_policy.py) — that's the value a newly provisioned
  // dropbox actually gets, not the older 5 GiB DropboxConfig column
  // default the row-creation path deliberately no longer uses.
  const DEFAULT_QUOTA_GB = 1;
  const DEFAULT_CFG: DropboxConfig = {
    guild_id: '',
    enabled: true,
    total_quota_bytes: DEFAULT_QUOTA_GB * GB,
    per_file_max_bytes: 100 * MB,
    used_bytes: 0,
    trash_retention_days: 30,
    updated_at: ''
  };

  let cfg = $state<DropboxConfig>(DEFAULT_CFG);
  let loading = $state(true);
  let busy = $state(false);
  // Local form buffers (in human-readable units); commit on save.
  let enabled = $state(true);
  let quotaMb = $state(DEFAULT_QUOTA_GB * 1024);
  let perFileMb = $state(100);
  let retentionDays = $state(30);

  $effect(() => {
    void load();
  });

  async function load() {
    try {
      cfg = await dropboxApi.getQuota(guildId);
      enabled = cfg.enabled;
      // Keep the byte-précise value — Math.round on fractional MB would
      // silently drop remainder the next time the form rehydrates. Floor
      // at the schema minimum (1 MiB / 1 KiB) instead of rounding.
      quotaMb = Math.max(1, cfg.total_quota_bytes / MB);
      perFileMb = Math.max(1024 / MB, cfg.per_file_max_bytes / MB);
      retentionDays = cfg.trash_retention_days;
    } catch {
      // 404 = no config row yet; defaults stand in.
      cfg = { ...DEFAULT_CFG, guild_id: guildId };
      enabled = true;
      quotaMb = DEFAULT_QUOTA_GB * 1024;
      perFileMb = 100;
      retentionDays = 30;
    } finally {
      loading = false;
    }
  }

  const dirty = $derived(
    enabled !== cfg.enabled ||
      Math.abs(quotaMb * MB - cfg.total_quota_bytes) > 0 ||
      Math.abs(perFileMb * MB - cfg.per_file_max_bytes) > 0 ||
      retentionDays !== cfg.trash_retention_days
  );

  async function save() {
    if (busy || !dirty) return;
    busy = true;
    try {
      cfg = await dropboxApi.patchQuota(guildId, {
        enabled,
        total_quota_bytes: Math.round(quotaMb * MB),
        per_file_max_bytes: Math.round(perFileMb * MB),
        trash_retention_days: retentionDays
      });
      // Resync the form from the canonical (clamped) row, byte-précise.
      enabled = cfg.enabled;
      quotaMb = Math.max(1, cfg.total_quota_bytes / MB);
      perFileMb = Math.max(1024 / MB, cfg.per_file_max_bytes / MB);
      retentionDays = cfg.trash_retention_days;
      toast.success(m.dropbox_settings_saved());
    } catch (e) {
      toast.error(m.dropbox_settings_save_failed(), {
        description: errText(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

{#if loading}
  <p class="text-text-faint text-sm">{m.common_loading()}</p>
{:else}
  <div class="space-y-5">
    <p class="text-text-muted text-sm">
      {m.dropbox_settings_intro()}
    </p>

    <div class="flex items-center justify-between gap-4">
      <div>
        <Label class="text-sm font-medium">{m.dropbox_settings_enabled_label()}</Label>
        <p class="text-text-faint mt-1 text-xs">{m.dropbox_settings_enabled_desc()}</p>
      </div>
      <Switch
        bind:checked={enabled}
        aria-label={m.dropbox_settings_enabled_label()}
        data-testid="dropbox-enabled-toggle"
      />
    </div>

    <div class="grid gap-4 sm:grid-cols-3">
      <div class="space-y-1.5">
        <Label class="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {m.dropbox_settings_total_label()}
        </Label>
        <div class="flex items-center gap-2">
          <Input
            type="number"
            min="1"
            max="10485760"
            bind:value={quotaMb}
            class="font-mono"
            disabled={!enabled}
            data-testid="dropbox-quota-mb"
          />
          <span class="text-text-faint text-sm">MB</span>
        </div>
      </div>
      <div class="space-y-1.5">
        <Label class="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {m.dropbox_settings_perfile_label()}
        </Label>
        <div class="flex items-center gap-2">
          <Input
            type="number"
            min="1"
            max="4096"
            bind:value={perFileMb}
            class="font-mono"
            disabled={!enabled}
            data-testid="dropbox-perfile-mb"
          />
          <span class="text-text-faint text-sm">MB</span>
        </div>
      </div>
      <div class="space-y-1.5">
        <Label class="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {m.dropbox_settings_retention_label()}
        </Label>
        <div class="flex items-center gap-2">
          <Input
            type="number"
            min="1"
            max="365"
            bind:value={retentionDays}
            class="font-mono"
            disabled={!enabled}
            data-testid="dropbox-retention-days"
          />
          <span class="text-text-faint text-sm">{m.dropbox_settings_days()}</span>
        </div>
      </div>
    </div>

    {#if cfg.used_bytes > 0}
      <p class="text-text-faint text-xs">
        {m.dropbox_settings_currently_used({
          used: formatBytes(cfg.used_bytes),
          total: formatBytes(cfg.total_quota_bytes)
        })}
      </p>
    {/if}

    <div class="flex justify-end gap-2 pt-2">
      <Button
        onclick={save}
        disabled={!dirty || busy}
        data-testid="dropbox-settings-save"
      >
        {busy ? m.common_saving() : m.common_save()}
      </Button>
    </div>
  </div>
{/if}
