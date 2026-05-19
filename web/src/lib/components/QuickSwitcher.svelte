<script lang="ts">
  /**
   * Ctrl+K-Modal: substring-Match über alle bekannten Guilds, Channels und
   * DMs. Pfeil-Tasten = Navigation, Enter = öffnen, Esc = schließen (von
   * bits-ui's Dialog). Bewusst keine Fuzzy-Lib — substring reicht für
   * Phase 3, und vermeidet eine neue Dep.
   */
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { goto } from '$app/navigation';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import UsersIcon from '@lucide/svelte/icons/users';
  import ServerIcon from '@lucide/svelte/icons/server';

  type Result =
    | { kind: 'guild'; key: string; label: string; href: string }
    | { kind: 'channel'; key: string; label: string; sublabel: string; channelType: number; href: string }
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
    <Dialog.Title class="sr-only">Schnell-Wechsler</Dialog.Title>
    <Dialog.Description class="sr-only">
      Channel, Server oder Direct-Message suchen und mit Enter wechseln.
    </Dialog.Description>

    <input
      bind:this={inputEl}
      bind:value={query}
      onkeydown={onKey}
      type="text"
      placeholder="Wohin? (Server, Channel oder Direct-Message)"
      class="border-border text-text-bright placeholder:text-text-muted w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
      data-testid="quick-switcher-input"
    />

    <div class="max-h-[50vh] overflow-y-auto p-2">
      {#if results.length === 0}
        <p class="text-text-muted px-3 py-4 text-center text-sm">Keine Treffer</p>
      {:else}
        {#each results as r, i (r.key)}
          <button
            type="button"
            onclick={() => select(r)}
            onmouseenter={() => (activeIdx = i)}
            class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors {activeIdx ===
            i
              ? 'bg-bg-hover text-text-bright'
              : 'text-text-base'}"
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
            <span class="truncate">{r.label}</span>
            {#if r.kind === 'channel'}
              <span class="text-text-muted ml-auto shrink-0 text-xs">{r.sublabel}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
