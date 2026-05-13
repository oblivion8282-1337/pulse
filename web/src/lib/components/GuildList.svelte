<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import RenameGuildDialog from './RenameGuildDialog.svelte';
  import type { Guild } from '$lib/api/types';

  let {
    guilds,
    activeGuildId = null,
    currentUserId = null,
    onSelect,
    onCreateClick,
    onGuildDeleted
  }: {
    guilds: Guild[];
    activeGuildId?: string | null;
    /** Used to decide whether to show the owner-only context menu. */
    currentUserId?: string | null;
    onSelect: (g: Guild) => void;
    onCreateClick: () => void;
    /** Called after the user-initiated delete API call succeeds (the WS
     * `guild_deleted` broadcast independently prunes the store). */
    onGuildDeleted?: (guildId: string) => void;
  } = $props();

  let renameTarget = $state<Guild | null>(null);
  let deleteTarget = $state<Guild | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleteBusy = $state(false);

  function initials(name: string): string {
    return name
      .split(/\s+/)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('');
  }

  function openRename(g: Guild) {
    renameTarget = g;
  }

  function openDelete(g: Guild) {
    deleteTarget = g;
    deleteConfirmOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    deleteBusy = true;
    try {
      await chatApi.deleteGuild(id);
      // Eager local cleanup — the guild_deleted WS broadcast does the same
      // for every other tab (and us again, harmlessly via the store guard).
      guildsStore.remove(id);
      onGuildDeleted?.(id);
      deleteConfirmOpen = false;
      deleteTarget = null;
    } catch (err) {
      toast.error('Server löschen fehlgeschlagen', { description: (err as Error).message });
    } finally {
      deleteBusy = false;
    }
  }
</script>

<!-- Horizontale Pill-/Avatar-Reihe der Server, oben in der Sidebar-Karte. -->
<div class="flex items-center gap-1.5 overflow-x-auto px-3 py-3" data-testid="guild-list">
  <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <a {...props} href="/app" class="shrink-0" aria-label="Pulse" data-testid="guild-home">
            <img src="/pulse-mark.svg" alt="" width="28" height="28" class="size-7 rounded-md" />
          </a>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Pulse</Tooltip.Content>
    </Tooltip.Root>
    <div class="bg-border h-6 w-px shrink-0" aria-hidden="true"></div>

    {#each guilds as g (g.id)}
      {@const isOwner = currentUserId !== null && g.owner_id === currentUserId}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props: tipProps })}
                  <button
                    {...props}
                    {...tipProps}
                    class="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-white transition-transform hover:scale-110 data-[active=true]:ring-2 data-[active=true]:ring-primary data-[active=true]:ring-offset-2 data-[active=true]:ring-offset-[color:var(--panel)]"
                    style={g.icon_url?.startsWith('https://') ? '' : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
                    data-active={activeGuildId === g.id}
                    onclick={() => onSelect(g)}
                    data-testid={`guild-${g.id}`}
                  >
                    {#if g.icon_url?.startsWith('https://')}
                      <img src={g.icon_url} alt={g.name} class="size-full object-cover" />
                    {:else}
                      {initials(g.name)}
                    {/if}
                  </button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content side="bottom">{g.name}</Tooltip.Content>
            </Tooltip.Root>
          {/snippet}
        </ContextMenu.Trigger>
        {#if isOwner}
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => openRename(g)} data-testid="guild-rename">
              <PencilIcon />
              Server umbenennen
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onSelect={() => openDelete(g)} data-testid="guild-delete">
              <Trash2Icon />
              Server löschen
            </ContextMenu.Item>
          </ContextMenu.Content>
        {/if}
      </ContextMenu.Root>
    {/each}

    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            class="border-primary/30 text-primary flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed bg-bg-input transition-colors hover:bg-bg-hover"
            onclick={onCreateClick}
            data-testid="guild-create"
            aria-label="Server erstellen"
          >
            <PlusIcon class="size-4" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Server erstellen</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
</div>

<RenameGuildDialog
  open={renameTarget !== null}
  guild={renameTarget}
  onClose={() => (renameTarget = null)}
/>

<AlertDialog.Root bind:open={deleteConfirmOpen}>
  <AlertDialog.Content data-testid="delete-guild-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>Server löschen?</AlertDialog.Title>
      <AlertDialog.Description>
        „{deleteTarget?.name}" wird mit allen Kanälen, Nachrichten und Mitgliedschaften
        dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deleteBusy}>Abbrechen</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={confirmDelete}
        disabled={deleteBusy}
        data-testid="delete-guild-confirm"
      >
        {deleteBusy ? 'Löschen…' : 'Löschen'}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
