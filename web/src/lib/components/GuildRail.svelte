<!--
  GuildRail — Discord-style vertical server rail.

  Lebt links neben der ChannelList-Sidebar, immer sichtbar (auch auf Mobil
  per User-Wunsch). Vertikal: Pulse-Logo oben, horizontale Trennlinie, dann
  Server-Avatars darunter, am Ende der "Server erstellen"-Knopf. Tooltips
  zeigen nach rechts.

  Active-Indikator: ein kleiner weißer Pill links neben dem aktuell
  ausgewählten Avatar (Discord-Pattern). Owner sehen das Rechtsklick-Menü
  mit Umbenennen/Löschen.
-->
<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import ImageIcon from '@lucide/svelte/icons/image';
  import ImageOffIcon from '@lucide/svelte/icons/image-off';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  // Channels-by-guild map drives the guild-rail mention indicator. We
  // reach into the same store; the rail's `guilds` prop only has
  // top-level guild metadata, not their channel lists.
  import { roles } from '$lib/stores/roles.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import RenameGuildDialog from './RenameGuildDialog.svelte';
  import GuildSettingsDialog from './settings/GuildSettingsDialog.svelte';
  import type { Guild } from '$lib/api/types';

  let {
    guilds,
    activeGuildId = null,
    currentUserId = null,
    homeActive = false,
    onSelect,
    onCreateClick,
    onHomeClick,
    onGuildDeleted
  }: {
    guilds: Guild[];
    activeGuildId?: string | null;
    currentUserId?: string | null;
    /** Show the active pill on the home button (e.g. when on /app/@me). */
    homeActive?: boolean;
    onSelect: (g: Guild) => void;
    /** Hide the "+" button when undefined (e.g. when the admin disabled
     *  guild-creation for non-admins). */
    onCreateClick?: () => void;
    /** Overrides the default `href="/app"` navigation. */
    onHomeClick?: () => void;
    onGuildDeleted?: (guildId: string) => void;
  } = $props();

  // True if any DM has a `latest > lastRead` — drives the red dot on the
  // home button so the user knows there's something to look at on /app/@me
  // without having to navigate there first. Computed live; flips off again
  // as soon as the user opens the DM (the page's markRead bumps lastRead).
  let hasUnreadDM = $derived(directMessages.list.some((dm) => readState.isUnread(dm.id)));

  let renameTarget = $state<Guild | null>(null);
  let deleteTarget = $state<Guild | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleteBusy = $state(false);
  // Server-settings modal — opened from the context-menu, replaces the
  // /settings page navigation.
  let settingsTarget = $state<Guild | null>(null);
  let settingsOpen = $state(false);

  function openSettings(g: Guild): void {
    settingsTarget = g;
    settingsOpen = true;
  }

  // Hidden file-input shared by all guilds — clicked programmatically from
  // the context-menu item. `iconTarget` remembers which guild the dialog
  // was opened for between the click and the change event.
  let iconInput: HTMLInputElement | null = $state(null);
  let iconTarget = $state<Guild | null>(null);

  function openIconPicker(g: Guild) {
    iconTarget = g;
    iconInput?.click();
  }

  async function onIconFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    const target = iconTarget;
    input.value = ''; // allow re-selecting the same file later
    if (!file || !target) return;
    try {
      const g = await chatApi.uploadGuildIcon(target.id, file);
      guildsStore.updateGuild(g);
      toast.success('Server-Bild aktualisiert');
    } catch (err) {
      toast.error('Bild-Upload fehlgeschlagen', { description: (err as Error).message });
    }
  }

  async function removeIcon(g: Guild) {
    try {
      await chatApi.deleteGuildIcon(g.id);
      guildsStore.updateGuild({ ...g, icon_url: null });
      toast.success('Server-Bild entfernt');
    } catch (err) {
      toast.error('Bild entfernen fehlgeschlagen', { description: (err as Error).message });
    }
  }

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

<nav
  class="glass-panel flex h-full w-16 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden rounded-none py-3 md:rounded-2xl"
  data-testid="guild-rail"
  aria-label="Server"
>
  <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <div class="relative shrink-0">
            {#if homeActive}
              <span
                class="absolute -left-2 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                aria-hidden="true"
              ></span>
            {/if}
            {#if onHomeClick}
              <button
                {...props}
                type="button"
                class="block"
                aria-label="Direktnachrichten"
                data-testid="guild-home"
                onclick={onHomeClick}
              >
                <img src="/pulse-mark.svg" alt="" width="36" height="36" class="size-9 rounded-lg" />
              </button>
            {:else}
              <a
                {...props}
                href="/app"
                class="block"
                aria-label="Pulse"
                data-testid="guild-home"
              >
                <img src="/pulse-mark.svg" alt="" width="36" height="36" class="size-9 rounded-lg" />
              </a>
            {/if}
            {#if hasUnreadDM && !homeActive}
              <span
                class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-red-500 ring-2 ring-bg-panel"
                aria-label="ungelesene Direktnachrichten"
                data-testid="home-unread-dot"
              ></span>
            {/if}
          </div>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right">
        {onHomeClick ? 'Direktnachrichten' : 'Pulse'}
      </Tooltip.Content>
    </Tooltip.Root>

    <div class="bg-border my-1 h-px w-8 shrink-0" aria-hidden="true"></div>

    {#each guilds as g (g.id)}
      {@const isOwner = currentUserId !== null && g.owner_id === currentUserId}
      {@const canManageGuild = roles.hasGuildPermission(g.id, Perm.MANAGE_GUILD)}
      {@const canManageRoles = roles.hasGuildPermission(g.id, Perm.MANAGE_ROLES)}
      {@const active = activeGuildId === g.id}
      {@const guildChannels = guildsStore.channelsByGuild[g.id] ?? []}
      {@const guildMentioned = !active && readState.hasGuildMentions(guildChannels.map((c) => c.id))}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props: tipProps })}
                  <div class="relative shrink-0">
                    <!-- Discord-style active pill on the left -->
                    {#if active}
                      <span
                        class="absolute -left-2 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                        aria-hidden="true"
                      ></span>
                    {/if}
                    <button
                      {...props}
                      {...tipProps}
                      class="relative flex size-10 items-center justify-center overflow-hidden rounded-2xl text-xs font-bold text-white transition-all hover:rounded-xl data-[active=true]:rounded-xl data-[active=true]:shadow-[0_0_8px_color-mix(in_oklab,var(--primary)_70%,transparent),0_0_22px_color-mix(in_oklab,var(--primary)_55%,transparent)]"
                      style={g.icon_url?.startsWith('https://') || g.icon_url?.startsWith('/')
                        ? ''
                        : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
                      data-active={active}
                      onclick={() => onSelect(g)}
                      data-testid={`guild-${g.id}`}
                    >
                      {#if g.icon_url}
                        <img src={g.icon_url} alt={g.name} class="size-full object-cover" />
                      {:else}
                        {initials(g.name)}
                      {/if}
                    </button>
                    {#if guildMentioned}
                      <span
                        class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-red-500 ring-2 ring-bg-panel"
                        aria-label="ungelesene Erwähnungen"
                        data-testid="guild-mention-dot"
                      ></span>
                    {/if}
                  </div>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content side="right">{g.name}</Tooltip.Content>
            </Tooltip.Root>
          {/snippet}
        </ContextMenu.Trigger>
        {#if canManageGuild || canManageRoles || isOwner || auth.user?.is_admin}
          <ContextMenu.Content>
            {#if canManageRoles || isOwner}
              <ContextMenu.Item
                onSelect={() => openSettings(g)}
                data-testid="guild-settings"
              >
                <SettingsIcon />
                Einstellungen
              </ContextMenu.Item>
            {/if}
            {#if canManageGuild}
              <ContextMenu.Item onSelect={() => openRename(g)} data-testid="guild-rename">
                <PencilIcon />
                Server umbenennen
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => openIconPicker(g)} data-testid="guild-icon-set">
                <ImageIcon />
                Server-Bild ändern…
              </ContextMenu.Item>
              {#if g.icon_url}
                <ContextMenu.Item onSelect={() => removeIcon(g)} data-testid="guild-icon-clear">
                  <ImageOffIcon />
                  Server-Bild entfernen
                </ContextMenu.Item>
              {/if}
            {/if}
            {#if isOwner || auth.user?.is_admin}
              {#if canManageGuild}<ContextMenu.Separator />{/if}
              <ContextMenu.Item variant="destructive" onSelect={() => openDelete(g)} data-testid="guild-delete">
                <Trash2Icon />
                Server löschen
              </ContextMenu.Item>
            {/if}
          </ContextMenu.Content>
        {/if}
      </ContextMenu.Root>
    {/each}

    {#if onCreateClick}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="border-primary/30 text-primary flex size-10 shrink-0 items-center justify-center rounded-2xl border border-dashed bg-bg-input transition-all hover:rounded-xl hover:bg-bg-hover"
              onclick={onCreateClick}
              data-testid="guild-create"
              aria-label="Server erstellen"
            >
              <PlusIcon class="size-5" />
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="right">Server erstellen</Tooltip.Content>
      </Tooltip.Root>
    {/if}
  </Tooltip.Provider>
</nav>

<RenameGuildDialog
  open={renameTarget !== null}
  guild={renameTarget}
  onClose={() => (renameTarget = null)}
/>

<input
  bind:this={iconInput}
  type="file"
  accept="image/png,image/jpeg,image/webp"
  class="hidden"
  onchange={onIconFile}
  data-testid="guild-icon-file"
/>

<GuildSettingsDialog bind:open={settingsOpen} guild={settingsTarget} />

<AlertDialog.Root bind:open={deleteConfirmOpen}>
  <AlertDialog.Content data-testid="delete-guild-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>Server löschen?</AlertDialog.Title>
      <AlertDialog.Description>
        {deleteTarget?.name ?? 'Dieser Server'} und alle Inhalte werden dauerhaft gelöscht.
        Diese Aktion kann nicht rückgängig gemacht werden.
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
