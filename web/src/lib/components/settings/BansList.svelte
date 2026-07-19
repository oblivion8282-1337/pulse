<!--
  Server-Bans-Sektion im GuildSettingsDialog.

  Listet alle aktiven Bans, lädt einmal beim Öffnen + re-fetched bei
  WS-Events ``guild_ban_added`` / ``guild_ban_removed`` damit die Liste
  synchron bleibt wenn ein anderer Mod gleichzeitig editiert. Pro Eintrag
  ein "Aufheben"-Button (BAN_MEMBERS deckt beide Richtungen).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { userCache } from '$lib/stores/users.svelte';
  import { useGatewayListener } from '$lib/ws/useGatewayListener.svelte';
  import type { Ban } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  let bans = $state<Ban[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let working = $state<Record<string, boolean>>({});

  async function load() {
    loading = true;
    error = null;
    try {
      bans = await chatApi.listBans(guildId);
      for (const b of bans) {
        userCache.queue(b.user_id);
        userCache.queue(b.banned_by_id);
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // Phase 4.5: useGatewayListener — bei Server-Switch wandert der
  // Listener auf die neue Connection mit.
  useGatewayListener((evt) => {
    if (
      (evt.op === 'guild_ban_added' || evt.op === 'guild_ban_removed') &&
      evt.guild_id === guildId
    ) {
      void load();
    }
  });

  async function unban(userId: string) {
    if (working[userId]) return;
    working = { ...working, [userId]: true };
    try {
      await chatApi.unbanUser(guildId, userId);
      bans = bans.filter((b) => b.user_id !== userId);
      toast.success(m.bans_list_unban_success());
    } catch (err) {
      toast.error(m.bans_list_unban_failed(), {
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      const { [userId]: _, ...rest } = working;
      working = rest;
    }
  }

  function nameFor(userId: string): string {
    return userCache.displayName(userId);
  }
</script>

<section class="space-y-4">
  <header class="space-y-1">
    <h2 class="text-text-bright text-lg font-semibold">{m.bans_list_title()}</h2>
    <p class="text-text-muted text-sm">
      {m.bans_list_description()}
    </p>
  </header>

  {#if loading}
    <p class="text-text-muted text-sm">{m.bans_list_loading()}</p>
  {:else if error}
    <p class="text-sm text-destructive">{error}</p>
  {:else if bans.length === 0}
    <p class="text-text-muted text-sm">{m.bans_list_empty()}</p>
  {:else}
    <ul class="divide-border divide-y rounded-lg border">
      {#each bans as ban (ban.user_id)}
        <li class="flex items-center gap-3 p-3" data-testid="bans-entry" data-user-id={ban.user_id}>
          <div class="min-w-0 flex-1">
            <p class="text-text-bright truncate text-sm font-medium">
              {nameFor(ban.user_id)}
            </p>
            <p class="text-text-muted truncate text-xs">
              {m.bans_list_banned_by({ name: nameFor(ban.banned_by_id) })} ·
              {new Date(ban.banned_at).toLocaleString()}
            </p>
            {#if ban.reason}
              <p class="text-text-base mt-1 text-xs italic">„{ban.reason}"</p>
            {/if}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onclick={() => unban(ban.user_id)}
            disabled={!!working[ban.user_id]}
            data-testid="bans-unban-btn"
          >
            {working[ban.user_id] ? '…' : m.bans_list_unban_button()}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
