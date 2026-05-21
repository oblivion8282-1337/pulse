<!--
  MentionAutocomplete — popup that appears when the user types `@` in the
  message input. Filters the channel's member list plus mentionable roles
  (+ `@everyone`/`@here` when the caller has `MENTION_EVERYONE`).

  Inserts the Discord-style markup the backend expects (`<@USER_ID>`,
  `<@&ROLE_ID>`, `@everyone`, `@here`). The host (`MessageInput`) owns the
  textarea state and feeds us the trigger range; we just emit
  `onPick(replacement)`.
-->
<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { chatApi } from '$lib/api/chat';
  import { userCache } from '$lib/stores/users.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { safeAvatarUrl } from '$lib/avatar';
  import type { Member } from '$lib/api/types';

  type Item =
    | { kind: 'user'; id: string; label: string; sub: string; avatar: string | null }
    | { kind: 'role'; id: string; label: string; color: string | null }
    | { kind: 'everyone' | 'here' };

  let {
    open,
    query,
    guildId,
    onPick,
    onClose
  }: {
    open: boolean;
    /** Lower-cased substring after the `@` trigger. */
    query: string;
    /** Null for DMs — disables role + everyone suggestions. */
    guildId: string | null;
    /** Called with the human-readable display text and the raw wire markup
     *  separately so the host can show `@Username` in the textarea while
     *  still sending `<@id>` to the server. */
    onPick: (display: string, markup: string) => void;
    onClose: () => void;
  } = $props();

  let members = $state<Member[]>([]);
  let loadedFor = $state<string | null>(null);

  // Lazy-load the guild members on first open. The MemberList already
  // hits the same endpoint elsewhere; we trade a duplicate fetch for
  // not needing a shared `members` store.
  $effect(() => {
    if (!open || !guildId || loadedFor === guildId) return;
    void loadMembers(guildId);
  });

  async function loadMembers(gid: string): Promise<void> {
    try {
      const list = await chatApi.listMembers(gid);
      for (const m of list) userCache.queue(m.user_id);
      members = list;
      loadedFor = gid;
    } catch {
      members = [];
    }
  }

  const canMentionEveryone = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MENTION_EVERYONE)
  );

  function displayFor(m: Member): string {
    if (m.nickname) return m.nickname;
    return userCache.displayName(m.user_id);
  }

  const items = $derived.by<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Item[] = [];

    if (guildId && canMentionEveryone) {
      if ('everyone'.startsWith(q)) out.push({ kind: 'everyone' });
      if ('here'.startsWith(q)) out.push({ kind: 'here' });
    }

    if (guildId) {
      const guildRoles = roles.byGuild[guildId] ?? [];
      for (const r of guildRoles) {
        if (r.is_everyone) continue;
        const visible = r.mentionable || canMentionEveryone;
        if (!visible) continue;
        if (!r.name.toLowerCase().includes(q)) continue;
        out.push({
          kind: 'role',
          id: r.id,
          label: r.name,
          color: r.color != null ? '#' + r.color.toString(16).padStart(6, '0') : null
        });
      }
    }

    for (const m of members) {
      const label = displayFor(m);
      const u = userCache.get(m.user_id);
      const username = u?.username ?? '';
      if (q && !label.toLowerCase().includes(q) && !username.toLowerCase().includes(q)) {
        continue;
      }
      out.push({
        kind: 'user',
        id: m.user_id,
        label,
        sub: username && username !== label ? `@${username}` : '',
        avatar: safeAvatarUrl(u?.avatar_url)
      });
    }

    // Cap to keep the popup bounded — typical Discord behaviour.
    return out.slice(0, 10);
  });

  let activeIdx = $state(0);

  // Reset selection when the candidate list changes (e.g. query narrows).
  $effect(() => {
    void items.length;
    activeIdx = 0;
  });

  function insertionFor(item: Item): { display: string; markup: string } {
    if (item.kind === 'user') return { display: `@${item.label} `, markup: `<@${item.id}> ` };
    if (item.kind === 'role') return { display: `@${item.label} `, markup: `<@&${item.id}> ` };
    if (item.kind === 'everyone') return { display: '@everyone ', markup: '@everyone ' };
    return { display: '@here ', markup: '@here ' };
  }

  function pick(item: Item) {
    const { display, markup } = insertionFor(item);
    onPick(display, markup);
  }

  /** Public — host wires this to the textarea's keydown so ↑/↓/Enter/Tab/Esc
   *  steer the popup before they reach the textarea's default handlers. */
  export function handleKey(e: KeyboardEvent): boolean {
    if (!open || items.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % items.length;
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(items[activeIdx]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return true;
    }
    return false;
  }
</script>

{#if open && items.length > 0}
  <div
    class="bg-bg-panel absolute bottom-full left-2 right-2 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border shadow-lg"
    data-testid="mention-autocomplete"
    role="listbox"
  >
    {#each items as item, i (item.kind === 'user' ? `u:${item.id}` : item.kind === 'role' ? `r:${item.id}` : item.kind)}
      <button
        type="button"
        role="option"
        aria-selected={i === activeIdx}
        class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-hover data-[active=true]:bg-bg-hover"
        data-active={i === activeIdx}
        data-testid="mention-item"
        onmousedown={(e) => { e.preventDefault(); pick(item); }}
        onmouseenter={() => (activeIdx = i)}
      >
        {#if item.kind === 'user'}
          <Avatar.Root class="size-6 shrink-0">
            {#if item.avatar}
              <Avatar.Image src={item.avatar} alt={item.label} />
            {/if}
            <Avatar.Fallback class="accent-gradient text-primary-foreground text-[10px] font-semibold">
              {item.label.slice(0, 1).toUpperCase()}
            </Avatar.Fallback>
          </Avatar.Root>
          <span class="truncate text-text-bright">{item.label}</span>
          {#if item.sub}
            <span class="text-text-muted truncate text-xs">{item.sub}</span>
          {/if}
        {:else if item.kind === 'role'}
          <span class="size-3 shrink-0 rounded-full" style={item.color ? `background:${item.color}` : 'background:var(--text-muted)'}></span>
          <span class="truncate text-text-bright">@{item.label}</span>
        {:else}
          <span class="truncate text-text-bright">@{item.kind}</span>
          <span class="text-text-muted ml-auto text-[10px]">{item.kind === 'everyone' ? 'alle Mitglieder' : 'alle online'}</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
