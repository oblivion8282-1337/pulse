<!--
  Multi-select friend list rendered inside InviteDialog so the user
  can DM the invite link to several friends in one go (mirrors
  Discord's "Send to friends" panel).

  Behaviour:
    - Lists all friends, optionally filtered by a search box that
      matches both display_name and @handle (case-insensitive).
    - Selection toggles on row click. Bulk "Send"-button posts the
      invite link to each selected friend's DM channel; failures per
      friend are reported in a partial-success toast, the rest still
      get sent.
    - Empty state when the user has no friends yet — no point in
      hiding the section, the prompt itself nudges them.

  Sender flow per friend:
    chatApi.createOrGetDMChannel(uid) -> postMessage(dm.id, link)
  Same shape as InviteToServerSubmenu so a future refactor can hoist
  this into a shared helper if a third caller appears.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import SendIcon from '@lucide/svelte/icons/send';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { chatApi } from '$lib/api/chat';
  import { safeAvatarUrl } from '$lib/avatar';
  import { toast } from 'svelte-sonner';

  let {
    inviteCode,
    disabled = false
  }: {
    inviteCode: string;
    disabled?: boolean;
  } = $props();

  let query = $state('');
  let selected = $state<Set<string>>(new Set());
  let sending = $state(false);

  // Make sure profile data for all friends is in the cache so we can
  // render their name + avatar. queue() debounces a batch fetch.
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
    if (sending || !inviteCode || selected.size === 0) return;
    sending = true;
    const link = `${window.location.origin}/invite/${inviteCode}`;
    const targets = Array.from(selected);
    // Send in parallel — the per-DM round-trip is independent, no
    // need to serialize. Promise.allSettled keeps one failure from
    // blocking the rest.
    const results = await Promise.allSettled(
      targets.map(async (uid) => {
        const dm = await chatApi.createOrGetDMChannel(uid);
        await chatApi.postMessage(dm.id, link);
      })
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    if (ok > 0 && fail === 0) {
      toast.success(
        ok === 1 ? 'Einladung an 1 Freund gesendet' : `Einladung an ${ok} Freunde gesendet`
      );
      selected = new Set();
    } else if (ok > 0 && fail > 0) {
      toast.warning(`${ok} gesendet, ${fail} fehlgeschlagen`);
    } else {
      toast.error('Einladung konnte nicht gesendet werden');
    }
    sending = false;
  }
</script>

<div class="space-y-2" data-testid="invite-friend-picker">
  <div class="flex items-center justify-between gap-2">
    <p class="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
      Direkt an Freunde senden
    </p>
    {#if selected.size > 0}
      <span class="text-text-muted text-xs" data-testid="invite-picker-count">
        {selected.size} ausgewählt
      </span>
    {/if}
  </div>

  {#if friends.list.length === 0}
    <p class="text-text-muted px-1 py-3 text-sm">
      Noch keine Freunde — füge erst welche hinzu, um direkt einladen zu können.
    </p>
  {:else}
    <Input
      type="text"
      bind:value={query}
      placeholder="Freund suchen…"
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
        <li class="text-text-muted px-3 py-3 text-sm">Keine Treffer.</li>
      {/if}
    </ul>

    <Button
      type="button"
      class="w-full"
      onclick={send}
      disabled={disabled || sending || selected.size === 0 || !inviteCode}
      data-testid="invite-picker-send"
    >
      <SendIcon class="mr-2 size-4" />
      {sending
        ? 'Senden…'
        : selected.size === 0
          ? 'Freunde auswählen'
          : selected.size === 1
            ? 'An 1 Freund senden'
            : `An ${selected.size} Freunde senden`}
    </Button>
  {/if}
</div>
