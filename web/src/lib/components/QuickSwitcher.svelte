<script lang="ts">
  /**
   * Ctrl+K-Modal: substring-Match über alle bekannten Guilds, Channels und
   * DMs. Pfeil-Tasten = Navigation, Enter = öffnen, Esc = schließen (von
   * bits-ui's Dialog). Bewusst keine Fuzzy-Lib — substring reicht für
   * Phase 3, und vermeidet eine neue Dep.
   */
  import { m } from '$lib/paraglide/messages.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import { goto } from '$app/navigation';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import UsersIcon from '@lucide/svelte/icons/users';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { channelNameStyle } from '$lib/utils/nameColor';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';

  type Result =
    | { kind: 'guild'; key: string; label: string; href: string }
    | {
        kind: 'channel';
        key: string;
        label: string;
        sublabel: string;
        channelType: number;
        nameStyle: string;
        href: string;
      }
    | { kind: 'dm'; key: string; label: string; href: string };

  let query = $state('');
  let activeIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  // Reset state + queue unknown DM-User-Cache fills on open.
  $effect(() => {
    if (!uiOverlays.quickSwitcherOpen) return;
    query = '';
    activeIdx = 0;
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
    queueMicrotask(() => inputEl?.focus());
  });

  let results = $derived.by((): Result[] => {
    const q = query.trim().toLowerCase();
    const out: Result[] = [];
    for (const g of guilds.list) {
      if (!q || g.name.toLowerCase().includes(q)) {
        out.push({
          kind: 'guild',
          key: 'g:' + g.id,
          label: g.name,
          href: `/app/guilds/${g.id}/channels/_`
        });
      }
    }
    for (const g of guilds.list) {
      const channels = guilds.channelsByGuild[g.id] ?? [];
      for (const c of channels) {
        if (!q || c.name.toLowerCase().includes(q)) {
          out.push({
            kind: 'channel',
            key: 'c:' + c.id,
            label: c.name,
            sublabel: g.name,
            channelType: c.type,
            nameStyle: channelNameStyle(c),
            href: `/app/guilds/${g.id}/channels/${c.id}`
          });
        }
      }
    }
    for (const dm of directMessages.list) {
      const u = userCache.byId[dm.other_user_id];
      const name = u?.display_name ?? u?.username ?? `User ${dm.other_user_id}`;
      if (!q || name.toLowerCase().includes(q)) {
        out.push({
          kind: 'dm',
          key: 'd:' + dm.id,
          label: name,
          href: `/app/@me/${dm.id}`
        });
      }
    }
    return out.slice(0, 50);
  });

  // Keep activeIdx in-bounds after filtering.
  $effect(() => {
    if (activeIdx >= results.length) activeIdx = Math.max(0, results.length - 1);
  });

  function select(r: Result): void {
    uiOverlays.quickSwitcherOpen = false;
    void goto(r.href);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, results.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) select(r);
    }
  }
</script>

<Dialog.Root bind:open={uiOverlays.quickSwitcherOpen}>
  <Dialog.Content class="max-w-xl gap-0 p-0" data-testid="quick-switcher">
    <Dialog.Title class="sr-only">{m.quick_switcher_title()}</Dialog.Title>
    <Dialog.Description class="sr-only">
      {m.quick_switcher_description()}
    </Dialog.Description>

    <input
      bind:this={inputEl}
      bind:value={query}
      onkeydown={onKey}
      type="text"
      placeholder={m.quick_switcher_placeholder()}
      class="border-border text-text-bright placeholder:text-text-muted w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
      data-testid="quick-switcher-input"
    />

    <div class="max-h-[50vh] overflow-y-auto p-2">
      {#if results.length === 0}
        <EmptyState message={m.quick_switcher_no_results()} />
      {:else}
        {#each results as r, i (r.key)}
          <MenuRow
            onclick={() => select(r)}
            onmouseenter={() => (activeIdx = i)}
            active={activeIdx === i}
            data-testid="quick-switcher-result"
          >
            {#if r.kind === 'guild'}
              <ServerIcon class="text-text-muted size-4 shrink-0" />
            {:else if r.kind === 'channel'}
              {#if r.channelType === 1}
                <Volume2Icon class="text-text-muted size-4 shrink-0" />
              {:else}
                <HashIcon class="text-text-muted size-4 shrink-0" />
              {/if}
            {:else}
              <UsersIcon class="text-text-muted size-4 shrink-0" />
            {/if}
            <span class="truncate" style={r.kind === 'channel' ? r.nameStyle : ''}>{r.label}</span>
            {#if r.kind === 'channel'}
              <span class="text-text-muted ml-auto shrink-0 text-xs">{r.sublabel}</span>
            {/if}
          </MenuRow>
        {/each}
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
