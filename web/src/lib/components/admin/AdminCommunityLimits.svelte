<!--
  Per-community limit editor, shown in the expanded community row. Owner-only.

  Zwei Arten von Feldern, die nicht verwechselt werden dürfen:
    * Grenzen — leer heißt „erbt den serverweiten Standard" bzw. „unbegrenzt".
      Der Platzhalter nennt den Wert, der dann tatsächlich gilt.
    * Freigaben — ein Schalter, kein Erben: aus heißt aus.

  Gruppiert nach dem, worum es geht, nicht danach, aus welcher Tabellenspalte
  es kommt: alles, was Dateien betrifft (Chat-Anhänge UND Ablage), steht
  zusammen — es ist derselbe Speicher-Gedanke, nur zwei Töpfe.

  Speichert den vollen Satz über PATCH /owner/communities/{id}/limits; null
  löscht eine Übersteuerung. Plain inline inputs (no bits-ui dialog) — safe in
  a re-rendering list.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Switch from '$lib/components/form/Switch.svelte';
  import LimitField from './LimitField.svelte';
  import LimitGroup from './LimitGroup.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { adminApi, type Community } from '$lib/api/admin';
  import {
    numOrNull,
    kbpsToMbpsStr,
    mbpsStrToKbps,
    bytesToUnit,
    bytesToUnitStr,
    unitStrToBytes
  } from './communityLimitFormat';

  let { community, onSaved }: { community: Community; onSaved: (c: Community) => void } =
    $props();

  // Form state as strings ('' = inherit/default). Stream bitrate is shown in
  // Mbit/s (friendlier) and converted to kbps on save. Seeded once from the
  // community (the panel remounts per expand, so initial-only is intentional —
  // untrack marks that so we don't reset the owner's edits on a live update).
  const MB = 1024 * 1024;
  const GB = 1024 * 1024 * 1024;
  /** Instanz-Standard für den Ablage-Speicher — Spiegel von
   *  ``DEFAULT_DROPBOX_QUOTA_BYTES`` (_dropbox_policy.py). Synchron halten. */
  const DEFAULT_DROPBOX_QUOTA_GB = 1;
  /** Instanz-Standard fuer den Geraete-Deckel je Person -- Spiegel von
   *  ``DEFAULT_MAX_DEVICES_PER_OWNER`` (guild_limits.py). Synchron halten. */
  const DEFAULT_MAX_DEVICES_PER_OWNER = 25;
  // "Native" ist ein interner Wert, kein Anzeigetext — Klappmenü und Platzhalter
  // beschriften ihn deshalb über denselben Weg.
  const resLabel = (r: string) => (r === 'Native' ? m.admin_communities_limits_res_native() : r);
  let voice = $state(untrack(() => community.voice_bitrate_max_kbps?.toString() ?? ''));
  let streamMbps = $state(untrack(() => kbpsToMbpsStr(community.stream_bitrate_max_kbps)));
  let fps = $state(untrack(() => community.stream_fps_max?.toString() ?? ''));
  let resolution = $state(untrack(() => community.stream_resolution_max ?? ''));
  // Storage: total quota in GB (empty = unlimited), per-file size in MB, count.
  let storageQuotaGB = $state(
    untrack(() => bytesToUnitStr(community.attachment_storage_quota_bytes, GB))
  );
  let attachSizeMB = $state(untrack(() => bytesToUnitStr(community.attachment_max_size_bytes, MB)));
  let attachCount = $state(untrack(() => community.attachment_max_count_per_message?.toString() ?? ''));
  // Scale caps ('' = unlimited).
  let maxMembers = $state(untrack(() => community.max_members?.toString() ?? ''));
  let maxChannels = $state(untrack(() => community.max_channels?.toString() ?? ''));
  let maxRoles = $state(untrack(() => community.max_roles?.toString() ?? ''));
  let maxDevicesPerOwner = $state(
    untrack(() => community.max_devices_per_owner?.toString() ?? '')
  );
  let maxStreams = $state(untrack(() => community.max_concurrent_streams?.toString() ?? ''));
  // Ablage: Freigabe (Schalter, kein Erben) + eigener Speicher-Topf.
  let dropboxAllowed = $state(untrack(() => community.dropbox_allowed));
  let dropboxQuotaGB = $state(
    untrack(() => bytesToUnitStr(community.dropbox_quota_bytes, GB))
  );
  let busy = $state(false);

  const RES_OPTIONS = ['Native', '4K', '1440p', '1080p', '720p', '480p'];

  async function save() {
    busy = true;
    try {
      const updated = await adminApi.setCommunityLimits(community.id, {
        voice_bitrate_max_kbps: numOrNull(voice),
        stream_bitrate_max_kbps: mbpsStrToKbps(streamMbps),
        stream_fps_max: numOrNull(fps),
        stream_resolution_max: resolution || null,
        attachment_max_size_bytes: unitStrToBytes(attachSizeMB, MB),
        attachment_max_count_per_message: numOrNull(attachCount),
        attachment_storage_quota_bytes: unitStrToBytes(storageQuotaGB, GB),
        max_members: numOrNull(maxMembers),
        max_channels: numOrNull(maxChannels),
        max_roles: numOrNull(maxRoles),
        max_devices_per_owner: numOrNull(maxDevicesPerOwner),
        max_concurrent_streams: numOrNull(maxStreams),
        dropbox_allowed: dropboxAllowed,
        dropbox_quota_bytes: unitStrToBytes(dropboxQuotaGB, GB)
      });
      onSaved(updated);
      toast.success(m.admin_communities_limits_saved());
    } catch (e) {
      toast.error(m.admin_communities_limits_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<div class="mt-1 flex flex-col gap-3" data-testid="admin-community-limits">
  <LimitGroup
    title={m.admin_communities_limits_title()}
    hint={m.admin_communities_limits_hint()}
  >
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <LimitField
        label={m.admin_communities_limits_voice_bitrate()}
        bind:value={voice}
        fallback={capabilities.voiceBitrateMaxKbps}
        min="16" max="512" testid="community-limit-voice"
      />
      <LimitField
        label={m.admin_communities_limits_stream_bitrate()}
        bind:value={streamMbps}
        fallback={capabilities.hqBitrateMaxKbps / 1000}
        min="1" max="100" step="any" testid="community-limit-bitrate"
      />
      <LimitField
        label={m.admin_communities_limits_fps()}
        bind:value={fps}
        fallback={capabilities.hqFpsMax}
        min="1" max="1000" testid="community-limit-fps"
      />
      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_resolution()}</span>
        <select
          bind:value={resolution}
          class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
          data-testid="community-limit-resolution"
        >
          <option value="">
            {m.admin_communities_limits_placeholder_default({
              value: resLabel(capabilities.hqResolutionMax)
            })}
          </option>
          {#each RES_OPTIONS as r (r)}
            <option value={r}>{resLabel(r)}</option>
          {/each}
        </select>
      </label>
    </div>
  </LimitGroup>

  <LimitGroup
    title={m.admin_communities_limits_storage_title()}
    hint={m.admin_communities_limits_storage_hint()}
  >
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <LimitField
        label={m.admin_communities_limits_storage_quota()}
        bind:value={storageQuotaGB}
        fallback="unlimited"
        min="0" step="any" testid="community-limit-storage-quota"
      />
      <!-- Diese beiden Spalten sind nicht-nullable: leer lassen ändert nichts,
           der bisherige Wert gilt weiter. Genau den zeigt der Platzhalter. -->
      <LimitField
        label={m.admin_communities_limits_attach_size()}
        bind:value={attachSizeMB}
        fallback={bytesToUnit(community.attachment_max_size_bytes, MB)}
        min="1" step="any" testid="community-limit-attach-size"
      />
      <LimitField
        label={m.admin_communities_limits_attach_count()}
        bind:value={attachCount}
        fallback={community.attachment_max_count_per_message}
        min="1" max="50" testid="community-limit-attach-count"
      />
    </div>

    <!-- Ablage steht bewusst in dieser Gruppe (derselbe Gegenstand: Dateien
         dieser Community, nur ein zweiter Topf), aber durch einen Trenner
         abgesetzt statt durch einen eigenen Rahmen — sonst Rahmen im Rahmen. -->
    <div class="border-border mt-4 border-t pt-4">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <span class="text-text-base text-sm font-medium">{m.admin_communities_limits_dropbox()}</span>
          <p class="text-text-muted mt-0.5 text-xs">{m.admin_communities_limits_dropbox_hint()}</p>
        </div>
        <Switch
          bind:checked={dropboxAllowed}
          aria-label={m.admin_communities_limits_dropbox()}
          data-testid="community-limit-dropbox"
        />
      </div>

      {#if dropboxAllowed}
        <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LimitField
            label={m.admin_communities_limits_dropbox_quota()}
            bind:value={dropboxQuotaGB}
            fallback={DEFAULT_DROPBOX_QUOTA_GB}
            min="0.01" step="any" testid="community-limit-dropbox-quota"
          />
          <p class="text-text-muted self-end text-xs">{m.admin_communities_limits_dropbox_quota_hint()}</p>
        </div>
      {/if}
    </div>
  </LimitGroup>

  <LimitGroup
    title={m.admin_communities_limits_scale_title()}
    hint={m.admin_communities_limits_scale_hint()}
  >
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <LimitField
        label={m.admin_communities_limits_max_members()}
        bind:value={maxMembers}
        fallback="unlimited"
        min="1" testid="community-limit-max-members"
      />
      <LimitField
        label={m.admin_communities_limits_max_channels()}
        bind:value={maxChannels}
        fallback="unlimited"
        min="1" testid="community-limit-max-channels"
      />
      <LimitField
        label={m.admin_communities_limits_max_roles()}
        bind:value={maxRoles}
        fallback="unlimited"
        min="1" testid="community-limit-max-roles"
      />
      <LimitField
        label={m.admin_communities_limits_max_devices()}
        bind:value={maxDevicesPerOwner}
        fallback={DEFAULT_MAX_DEVICES_PER_OWNER}
        min="1" testid="community-limit-max-devices"
      />
      <LimitField
        label={m.admin_communities_limits_max_streams()}
        bind:value={maxStreams}
        fallback="unlimited"
        min="0" testid="community-limit-max-streams"
      />
    </div>
  </LimitGroup>

  <div class="flex justify-end">
    <Button size="sm" onclick={save} disabled={busy} data-testid="community-limit-save">
      {m.admin_communities_limits_save()}
    </Button>
  </div>
</div>
