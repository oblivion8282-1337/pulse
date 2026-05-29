<!--
  Read-only counts grid. Pulls auth-svc + chat-gateway stats in parallel
  on mount; renders five numbers (storage placeholder until MinIO is wired
  up). No interaction — informational.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { adminApi, type AuthStats, type ChatStats } from '$lib/api/admin';
  import UsersIcon from '@lucide/svelte/icons/users';
  import LayersIcon from '@lucide/svelte/icons/layers';
  import HashIcon from '@lucide/svelte/icons/hash';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import HardDriveIcon from '@lucide/svelte/icons/hard-drive';

  let auth = $state<AuthStats | null>(null);
  let chat = $state<ChatStats | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [a, c] = await Promise.all([adminApi.authStats(), adminApi.chatStats()]);
      auth = a;
      chat = c;
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
  <h2 class="text-text-bright mb-4 text-base font-semibold">Übersicht</h2>

  {#if error}
    <p class="text-red-400 text-sm">Stats konnten nicht geladen werden: {error}</p>
  {:else if auth && chat}
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-users">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <UsersIcon class="size-3.5" />
          User
        </div>
        <div class="text-text-bright text-2xl font-semibold">{auth.user_count}</div>
        <div class="text-text-muted text-xs">
          {auth.admin_count} Admin · {auth.disabled_count} gesperrt
        </div>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-guilds">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <LayersIcon class="size-3.5" />
          Communitys
        </div>
        <div class="text-text-bright text-2xl font-semibold">{chat.guild_count}</div>
        <div class="text-text-muted text-xs">{chat.channel_count} Kanäle</div>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-dms">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <HashIcon class="size-3.5" />
          DMs
        </div>
        <div class="text-text-bright text-2xl font-semibold">{chat.dm_channel_count}</div>
        <div class="text-text-muted text-xs">1:1 Channels</div>
      </div>

      <div class="flex flex-col gap-1 rounded-xl bg-bg-hover/50 p-3" data-testid="stat-msgs">
        <div class="text-text-muted flex items-center gap-1.5 text-xs">
          <MessageSquareIcon class="size-3.5" />
          Nachrichten
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
            noch nicht aktiv
          {:else if chat.storage_total_bytes !== null && chat.storage_free_bytes !== null}
            belegt · {fmtBytes(chat.storage_free_bytes)} frei von {fmtBytes(
              chat.storage_total_bytes
            )}
          {:else}
            belegt
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="text-text-muted text-sm">lade…</div>
  {/if}
</section>
