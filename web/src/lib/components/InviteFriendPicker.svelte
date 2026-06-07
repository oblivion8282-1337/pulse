<!--
  Multi-select friend list rendered inside InviteDialog.
  Sendet pro ausgewähltem Freund einen Community-Invite via POST /community-invites
  (statt eines Roh-Links per DM — Stufe 3).

  Flow pro Freund:
    1. chatApi.createInvite(guildId, {maxUses:1, expiresInSeconds:86400})
       → frischer host-Invite-Code auf dem aktiven/hostenden Server
    2. communityInvitesApi.create({invitee_id, target_host, target_instance_id,
       target_guild_id, target_guild_name, code})
       → Cloud-Broker-Call

  Partial-Success-Toast wie bisher.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import SendIcon from '@lucide/svelte/icons/send';
  import { friends } from '$lib/stores/friends.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { chatApi } from '$lib/api/chat';
  import { communityInvitesApi } from '$lib/api/community-invites';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let {
    guildId,
    disabled = false
  }: {
    guildId: string;
    disabled?: boolean;
  } = $props();

  let query = $state('');
  let selected = $state<Set<string>>(new Set());
  let sending = $state(false);

  $effect(() => {
    for (const f of friends.list) userCache.queue(f.user_id);
  });

  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const out = friends.list.map((f) => {
      const u = userCache.get(f.user_id);
      return {
        id: f.user_id,
        name: u?.display_name ?? u?.username ?? '…',
        handle: u?.username ?? '',
        avatar: safeAvatarUrl(u?.avatar_url ?? null)
      };
    });
    if (!q) return out;
    return out.filter(
      (o) => o.name.toLowerCase().includes(q) || o.handle.toLowerCase().includes(q)
    );
  });

  function toggle(uid: string) {
    const next = new Set(selected);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    selected = next;
  }

  async function send() {
    if (sending || !guildId || selected.size === 0) return;
    sending = true;

    const srv = activeServer.current;
    const targetHost = srv?.hostname ?? '';
    const targetInstanceId = srv?.instance_id ?? null;
    const guild = guilds.byId[guildId];
    const guildName = guild?.name ?? guildId;

    const targets = Array.from(selected);
    const results = await Promise.allSettled(
      targets.map(async (uid) => {
        // 1. Frischen host-Invite-Code minten (single-use, 24h)
        const invite = await chatApi.createInvite(guildId, {
          maxUses: 1,
          expiresInSeconds: 86400
        });
        // 2. Community-Invite über den Cloud-Broker schicken
        await communityInvitesApi.create({
          invitee_id: uid,
          target_host: targetHost,
          target_instance_id: targetInstanceId,
          target_guild_id: guildId,
          target_guild_name: guildName,
          code: invite.code
        });
      })
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    if (ok > 0 && fail === 0) {
      toast.success(
        ok === 1
          ? m.invite_friend_picker_sent_one()
          : m.invite_friend_picker_sent_many({ count: ok })
      );
      selected = new Set();
    } else if (ok > 0 && fail > 0) {
      toast.warning(m.invite_friend_picker_partial({ ok, fail }));
    } else {
      toast.error(m.invite_friend_picker_send_failed());
    }
    sending = false;
  }
</script>

<div class="space-y-2" data-testid="invite-friend-picker">
  <div class="flex items-center justify-between gap-2">
    <p class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
      {m.invite_friend_picker_heading()}
    </p>
    {#if selected.size > 0}
      <span class="text-text-muted text-xs" data-testid="invite-picker-count">
        {m.invite_friend_picker_selected_count({ count: selected.size })}
      </span>
    {/if}
  </div>

  {#if friends.list.length === 0}
    <p class="text-text-muted px-1 py-3 text-sm">
      {m.invite_friend_picker_no_friends()}
    </p>
  {:else}
    <Input
      type="text"
      bind:value={query}
      placeholder={m.invite_friend_picker_search_placeholder()}
      autocomplete="off"
      data-testid="invite-picker-search"
    />

    <ul
      class="max-h-56 overflow-y-auto rounded-lg border border-border"
      data-testid="invite-picker-list"
    >
      {#each filtered as f (f.id)}
        {@const isSelected = selected.has(f.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-bg-hover {isSelected
              ? 'bg-[var(--accent-soft)]'
              : ''}"
            onclick={() => toggle(f.id)}
            disabled={sending}
            data-testid="invite-picker-row"
            data-user-id={f.id}
            data-selected={isSelected}
          >
            <Avatar.Root class="size-8 shrink-0">
              {#if f.avatar}
                <Avatar.Image src={f.avatar} alt="" />
              {/if}
              <Avatar.Fallback
                class="accent-gradient text-primary-foreground text-xs font-semibold"
              >
                {f.name.slice(0, 1).toUpperCase()}
              </Avatar.Fallback>
            </Avatar.Root>
            <div class="min-w-0 flex-1">
              <p class="text-text-bright truncate text-sm font-medium">{f.name}</p>
              <p class="text-text-muted truncate text-xs">@{f.handle}</p>
            </div>
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-full border {isSelected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border'}"
            >
              {#if isSelected}
                <CheckIcon class="size-3.5" />
              {/if}
            </span>
          </button>
        </li>
      {/each}
      {#if filtered.length === 0}
        <li class="text-text-muted px-3 py-3 text-sm">{m.invite_friend_picker_no_results()}</li>
      {/if}
    </ul>

    <Button
      type="button"
      class="w-full"
      onclick={send}
      disabled={disabled || sending || selected.size === 0}
      data-testid="invite-picker-send"
    >
      <SendIcon class="mr-2 size-4" />
      {sending
        ? m.invite_friend_picker_sending()
        : selected.size === 0
          ? m.invite_friend_picker_select_friends()
          : selected.size === 1
            ? m.invite_friend_picker_send_one()
            : m.invite_friend_picker_send_many({ count: selected.size })}
    </Button>
  {/if}
</div>
