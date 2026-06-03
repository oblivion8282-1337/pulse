<!--
  Read-only counts grid. Pulls auth-svc + chat-gateway stats in parallel
  on mount; renders five numbers (storage placeholder until MinIO is wired
  up). No interaction — informational.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { adminApi, type AuthStats, type ChatStats } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';
  import UsersIcon from '@lucide/svelte/icons/users';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import HashIcon from '@lucide/svelte/icons/hash';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import HardDriveIcon from '@lucide/svelte/icons/hard-drive';

  // Auf Self-Host (isCloud=false) gibt es keine auth.users — die auth-Stats
  // (User/Admin/Disabled-Count) kämen von der Cloud-auth und sind hier
  // irrelevant (+ 403, weil der Cert-Login-Admin dort kein Cloud-Admin ist).
  // Wir laden dann nur die chat-Stats von der Instanz und blenden die
  // User-Kachel aus.
  let { isCloud = true }: { isCloud?: boolean } = $props();

  let auth = $state<AuthStats | null>(null);
  let chat = $state<ChatStats | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      chat = await adminApi.chatStats();
      if (isCloud) auth = await adminApi.authStats();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  function fmtBytes(n: number | null): string {
    if (n === null) return '—';
    const mb = n / 1024 / 1024;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-overview">
  <h2 class="text-text-bright mb-4 text-base font-semibold">{m.admin_overview_title()}</h2>

  {#if error}
    <p class="text-red-400 text-sm">{m.admin_overview_stats_load_error({ error: error ?? '' })}</p>
  {:else if chat}
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {#if auth}
        <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-users">
          <div class="text-text-muted flex items-center gap-1.5 text-xs">
            <UsersIcon class="size-3.5" />
            User
          </div>
          <div class="text-text-bright text-2xl font-semibold">{auth.user_count}</div>
          <div class="text-text-muted text-xs">
            {m.admin_overview_user_detail({ adminCount: auth.admin_count, disabledCount: auth.disabled_count })}
          </div>
        </div>
      {/if}

      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-guilds">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <LayersIcon class="size-3.5" />
          {m.admin_overview_stat_communities()}
        </div>
        <div class="text-text-bright text-2xl font-semibold">{chat.guild_count}</div>
        <div class="text-text-muted text-xs">{m.admin_overview_channel_count({ count: chat.channel_count })}</div>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-dms">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <HashIcon class="size-3.5" />
          DMs
        </div>
        <div class="text-text-bright text-2xl font-semibold">{chat.dm_channel_count}</div>
        <div class="text-text-muted text-xs">{m.admin_overview_dm_subtitle()}</div>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-msgs">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <MessageSquareIcon class="size-3.5" />
          {m.admin_overview_stat_messages()}
        </div>
        <div class="text-text-bright text-2xl font-semibold">{chat.messages_24h}</div>
        <div class="text-text-muted text-xs">in 24 h</div>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-storage">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <HardDriveIcon class="size-3.5" />
          MinIO
        </div>
        <div class="text-text-bright text-2xl font-semibold">{fmtBytes(chat.storage_bytes)}</div>
        <div class="text-text-muted text-xs">
          {#if chat.storage_bytes === null}
            {m.admin_overview_storage_not_active()}
          {:else if chat.storage_total_bytes !== null && chat.storage_free_bytes !== null}
            {m.admin_overview_storage_used_detail({ free: fmtBytes(chat.storage_free_bytes), total: fmtBytes(chat.storage_total_bytes) })}
          {:else}
            {m.admin_overview_storage_used()}
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="text-text-muted text-sm">{m.admin_overview_loading()}</div>
  {/if}
</section>
