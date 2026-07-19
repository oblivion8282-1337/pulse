<!--
  Per-community quality-limit editor (Boost foundation), shown in the expanded
  community row. Owner-only. Empty field = inherit the instance default; a value
  overrides it for THIS community (higher too = boost). Saves the full set via
  the owner-gated PATCH /owner/communities/{id}/limits; null clears an override.

  Plain inline inputs (no bits-ui dialog) — safe in a re-rendering list.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { adminApi, type Community } from '$lib/api/admin';

  let { community, onSaved }: { community: Community; onSaved: (c: Community) => void } =
    $props();

  // Form state as strings ('' = inherit/default). Stream bitrate is shown in
  // Mbit/s (friendlier) and converted to kbps on save. Seeded once from the
  // community (the panel remounts per expand, so initial-only is intentional —
  // untrack marks that so we don't reset the owner's edits on a live update).
  const MB = 1024 * 1024;
  const GB = 1024 * 1024 * 1024;
  const kbpsToMbpsStr = (v: number | null) => (v == null ? '' : String(v / 1000));
  const mbpsStrToKbps = (s: unknown) => {
    const mbps = numOrNull(s);
    return mbps == null ? null : Math.round(mbps * 1000);
  };
  const bytesToUnitStr = (v: number | null, unit: number) =>
    v == null ? '' : String(Math.round((v / unit) * 100) / 100);
  const unitStrToBytes = (s: unknown, unit: number) => {
    const n = numOrNull(s);
    return n == null ? null : Math.round(n * unit);
  };
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
  let maxStreams = $state(untrack(() => community.max_concurrent_streams?.toString() ?? ''));
  let busy = $state(false);

  const RES_OPTIONS = ['Native', '4K', '1440p', '1080p', '720p', '480p'];

  // `type="number"`-Inputs binden nach dem Tippen eine ZAHL (der State startet
  // als String aus toString()) — daher robust gegen beide Typen plus leer/null,
  // sonst wirft `.trim()` "s.trim is not a function" und der Save bricht ab.
  function numOrNull(s: unknown): number | null {
    if (s === '' || s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

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
        max_concurrent_streams: numOrNull(maxStreams)
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

<div class="border-border bg-bg-hover/20 mt-1 rounded-xl border p-4" data-testid="admin-community-limits">
  <h3 class="text-text-bright text-sm font-semibold">{m.admin_communities_limits_title()}</h3>
  <p class="text-text-muted mt-0.5 mb-3 text-xs">{m.admin_communities_limits_hint()}</p>

  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_voice_bitrate()}</span>
      <input
        type="number" min="16" max="512" bind:value={voice}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-voice"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_stream_bitrate()}</span>
      <input
        type="number" min="1" max="100" step="any" bind:value={streamMbps}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-bitrate"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_fps()}</span>
      <input
        type="number" min="1" max="1000" bind:value={fps}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-fps"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_resolution()}</span>
      <select
        bind:value={resolution}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-resolution"
      >
        <option value="">{m.admin_communities_limits_inherit()}</option>
        {#each RES_OPTIONS as r (r)}
          <option value={r}>{r === 'Native' ? m.admin_communities_limits_res_native() : r}</option>
        {/each}
      </select>
    </label>
  </div>

  <h3 class="text-text-bright mt-4 text-sm font-semibold">
    {m.admin_communities_limits_storage_title()}
  </h3>
  <p class="text-text-muted mt-0.5 mb-3 text-xs">{m.admin_communities_limits_storage_hint()}</p>

  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_storage_quota()}</span>
      <input
        type="number" min="0" step="any" bind:value={storageQuotaGB}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-storage-quota"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_attach_size()}</span>
      <input
        type="number" min="1" step="any" bind:value={attachSizeMB}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-attach-size"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_attach_count()}</span>
      <input
        type="number" min="1" max="50" bind:value={attachCount}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-attach-count"
      />
    </label>
  </div>

  <h3 class="text-text-bright mt-4 text-sm font-semibold">
    {m.admin_communities_limits_scale_title()}
  </h3>
  <p class="text-text-muted mt-0.5 mb-3 text-xs">{m.admin_communities_limits_scale_hint()}</p>

  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_max_members()}</span>
      <input
        type="number" min="1" bind:value={maxMembers}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-max-members"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_max_channels()}</span>
      <input
        type="number" min="1" bind:value={maxChannels}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-max-channels"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_max_roles()}</span>
      <input
        type="number" min="1" bind:value={maxRoles}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-max-roles"
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs font-medium">{m.admin_communities_limits_max_streams()}</span>
      <input
        type="number" min="0" bind:value={maxStreams}
        placeholder={m.admin_communities_limits_placeholder_inherit()}
        class="border-border bg-bg-input text-text-base focus:border-primary rounded-md border px-3 py-1.5 text-sm outline-none"
        data-testid="community-limit-max-streams"
      />
    </label>
  </div>

  <div class="mt-3 flex justify-end">
    <Button size="sm" onclick={save} disabled={busy} data-testid="community-limit-save">
      {m.admin_communities_limits_save()}
    </Button>
  </div>
</div>
