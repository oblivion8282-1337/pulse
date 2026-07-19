<!--
  Modal-Server-Settings (Discord-Style).

  Two tabs in the side rail: Rollen (incl. member-assignment) and
  Eigentümerschaft. Visibility is gated server-side, mirrored here as
  the dialog hides what the caller can't use. The dialog is the
  primary UI entry; the previous standalone /settings page is gone —
  deep-linking wasn't a real use case.

  Channel-permissions stays a separate page for now because there's
  no in-line channel-settings dialog to host it.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import UsersIcon from '@lucide/svelte/icons/users';
  import CrownIcon from '@lucide/svelte/icons/crown';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import PuzzleIcon from '@lucide/svelte/icons/puzzle';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
  import GlobeIcon from '@lucide/svelte/icons/globe';
  import PaperclipIcon from '@lucide/svelte/icons/paperclip';
  import LinkIcon from '@lucide/svelte/icons/link';
  import { onMount } from 'svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { Perm } from '$lib/permissions/bitfield';
  import { rolesApi } from '$lib/api/roles';
  import type { Guild } from '$lib/api/types';
  import RolesEditor from './RolesEditor.svelte';
  import MemberRoleAssignment from './MemberRoleAssignment.svelte';
  import OwnerTransferSection from './OwnerTransferSection.svelte';
  import GuildSoundsEditor from './GuildSoundsEditor.svelte';
  import GuildDropboxEditor from './GuildDropboxEditor.svelte';
  import GuildPluginsEditor from './GuildPluginsEditor.svelte';
  import GuildPublicAddressEditor from './GuildPublicAddressEditor.svelte';
  import GuildLimitsEditor from './GuildLimitsEditor.svelte';
  import GuildInvitesEditor from './GuildInvitesEditor.svelte';
  import ModQueue from '$lib/components/admin/ModQueue.svelte';
  import { modQueueCounts } from '$lib/stores/modQueueCounts.svelte';
  import AuditLogViewer from '$lib/components/admin/AuditLogViewer.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';

  let {
    open = $bindable(false),
    guild
  }: {
    open?: boolean;
    /** Guild to open the dialog for. Required when ``open`` flips true;
     * may be null/undefined while the dialog is closed. */
    guild: Guild | null;
  } = $props();

  type Tab = 'roles' | 'members' | 'sounds' | 'dropbox' | 'plugins' | 'limits' | 'invites' | 'modqueue' | 'auditlog' | 'ownership' | 'publicaddress';
  let tab = $state<Tab>('roles');
  let initialized = $state(false);

  let guildId = $derived(guild?.id ?? '');
  let canManageRoles = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MANAGE_ROLES)
  );
  let isOwner = $derived(!!guild && currentServerUserId() === guild.owner_id);
  let myPermissions = $derived(
    guildId ? roles.myGuildPerms[guildId] ?? '0' : '0'
  );
  // Sounds, Plugins, PublicAddress und AuditLog benutzen alle MANAGE_GUILD.
  // Sound-overrides reuse MANAGE_GUILD on the backend (server-rename /
  // icon / settings sit on the same bit). Matches Discord's "manage
  // server" grouping. Plugin-Toggles and AuditLog are gated identically.
  let canManageGuild = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MANAGE_GUILD)
  );
  let canCreateInvites = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.CREATE_INVITES)
  );
  // Mod-Queue: sichtbar wenn MANAGE_MESSAGES | BAN_MEMBERS | MANAGE_GUILD.
  let canSeeModQueue = $derived(
    !!guildId &&
      (roles.hasGuildPermission(guildId, Perm.MANAGE_MESSAGES) ||
        roles.hasGuildPermission(guildId, Perm.BAN_MEMBERS) ||
        roles.hasGuildPermission(guildId, Perm.MANAGE_GUILD))
  );

  // Offene-Meldungen-Zähler für das Tab-Badge.
  let modQueueOpen = $derived(guildId ? modQueueCounts.get(guildId) : 0);

  // Default to the first tab the caller is allowed to see when the dialog
  // first opens, so it never opens on a tab that's empty. Only initialize
  // once; re-runs due to permission changes from WS events are ignored.
  $effect(() => {
    if (open && !initialized) {
      initialized = true;
      if (canManageRoles) tab = 'roles';
      else if (canSeeModQueue) tab = 'modqueue';
      else if (canManageGuild) tab = 'sounds';
      else if (isOwner) tab = 'ownership';
    } else if (!open) {
      // Reset the flag when the dialog closes so the next open reinitializes.
      initialized = false;
    }
  });

  // Dirty-flag from RolesEditor — true while there are unsaved
  // changes in the buffer. Used to gate the close + tab-switch.
  let rolesEditorDirty = $state(false);
  let closeConfirmOpen = $state(false);
  let tabConfirmOpen = $state(false);
  let pendingTab = $state<Tab | null>(null);
  // One-shot override so the user-confirmed discard close passes
  // through the dirty guard instead of bouncing back.
  let closeOverride = $state(false);
  // Monotonic signal — bumping it tells RolesEditor to reset its
  // local edit buffer. Without this, just resetting `rolesEditorDirty`
  // here would be reverted on the next tick because the editor's
  // dirty-effect compares buffer ≠ persisted role and flips it back.
  let discardSignal = $state(0);

  function handleOpenChange(next: boolean): void {
    if (!next && rolesEditorDirty && !closeOverride) {
      // bits-ui already set its internal state to closed and the
      // bind:open below is in the middle of propagating that to us.
      // Schedule the reopen for after that propagation so our true
      // isn't immediately overwritten by the same-tick false.
      closeConfirmOpen = true;
      queueMicrotask(() => {
        open = true;
      });
      return;
    }
    if (!next) {
      // Either nothing dirty, or the user just confirmed discard —
      // reset the one-shot so the next open starts fresh.
      closeOverride = false;
    }
  }

  function confirmDiscardClose(): void {
    closeConfirmOpen = false;
    closeOverride = true;
    // Drop the buffer too — Dialog.Root keeps the inner content mounted
    // through its close transition, so leaving a dirty buffer behind
    // would briefly flash "ungespeicherte Änderungen" before unmount.
    discardSignal += 1;
    open = false;
  }

  // beforeunload guard so a hard tab-close also asks. Browsers ignore
  // our custom message — they show their own generic prompt — but the
  // event being present at all is what triggers the dialog.
  $effect(() => {
    if (typeof window === 'undefined') return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (open && rolesEditorDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  });

  // Lazy-load roles when the dialog first opens for a guild whose roles
  // aren't in the store yet (rare — happens for freshly-joined guilds).
  onMount(() => {
    if (open && guildId && !roles.byGuild[guildId]?.length) {
      void rolesApi
        .list(guildId)
        .then((rows) => {
          for (const r of rows) roles.upsertRole(r);
        })
        .catch(() => undefined);
    }
  });

  function selectTab(t: Tab): void {
    if (t === tab) return;
    if (rolesEditorDirty && tab === 'roles') {
      pendingTab = t;
      tabConfirmOpen = true;
      return;
    }
    tab = t;
  }

  function confirmDiscardTab(): void {
    // Signal RolesEditor to roll back its buffer. The editor's dirty
    // effect will then flip `rolesEditorDirty` to false on its own —
    // clearing it manually here would race with the next reactive run.
    discardSignal += 1;
    if (pendingTab) {
      tab = pendingTab;
      pendingTab = null;
    }
    tabConfirmOpen = false;
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content
    class="flex h-[80vh] max-h-[700px] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
    data-testid="guild-settings-dialog"
  >
    <Dialog.Header class="border-border border-b px-6 py-4">
      <Dialog.Title>{guild?.name ?? '…'} · {m.guild_settings_dialog_title()}</Dialog.Title>
    </Dialog.Header>

    <div class="flex min-h-0 flex-1">
      <nav class="border-border w-48 shrink-0 border-r bg-bg-input/40 p-2">
        {#if canManageRoles}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'roles'}
            onclick={() => selectTab('roles')}
            data-testid="settings-tab-roles"
          >
            <ShieldIcon class="size-4" /> {m.guild_settings_dialog_tab_roles()}
          </button>
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'members'}
            onclick={() => selectTab('members')}
            data-testid="settings-tab-members"
          >
            <UsersIcon class="size-4" /> {m.guild_settings_dialog_tab_members()}
          </button>
        {/if}
        {#if canManageGuild}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'sounds'}
            onclick={() => selectTab('sounds')}
            data-testid="settings-tab-sounds"
          >
            <Volume2Icon class="size-4" /> {m.guild_settings_dialog_tab_sounds()}
          </button>
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'dropbox'}
            onclick={() => selectTab('dropbox')}
            data-testid="settings-tab-dropbox"
          >
            <FolderIcon class="size-4" /> {m.guild_settings_dialog_tab_dropbox()}
          </button>
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'plugins'}
            onclick={() => selectTab('plugins')}
            data-testid="settings-tab-plugins"
          >
            <PuzzleIcon class="size-4" /> {m.guild_settings_dialog_tab_plugins()}
          </button>
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'publicaddress'}
            onclick={() => selectTab('publicaddress')}
            data-testid="settings-tab-publicaddress"
          >
            <GlobeIcon class="size-4" /> {m.guild_settings_dialog_tab_publicaddress()}
          </button>
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'limits'}
            onclick={() => selectTab('limits')}
            data-testid="settings-tab-limits"
          >
            <PaperclipIcon class="size-4" /> {m.guild_settings_dialog_tab_limits()}
          </button>
        {/if}
        {#if canCreateInvites}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'invites'}
            onclick={() => selectTab('invites')}
            data-testid="settings-tab-invites"
          >
            <LinkIcon class="size-4" /> {m.guild_settings_dialog_tab_invites()}
          </button>
        {/if}
        {#if canSeeModQueue}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'modqueue'}
            onclick={() => selectTab('modqueue')}
            data-testid="settings-tab-modqueue"
          >
            <FlagIcon class="size-4" /> {m.guild_settings_dialog_tab_modqueue()}
            {#if modQueueOpen > 0}
              <span
                class="ml-auto rounded-full bg-warning/20 px-1.5 py-0.5 text-xs font-semibold text-warning tabular-nums"
                data-testid="modqueue-tab-badge"
              >
                {modQueueOpen > 99 ? '99+' : modQueueOpen}
              </span>
            {/if}
          </button>
        {/if}
        {#if canManageGuild}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'auditlog'}
            onclick={() => selectTab('auditlog')}
            data-testid="settings-tab-auditlog"
          >
            <ScrollTextIcon class="size-4" /> {m.guild_settings_dialog_tab_auditlog()}
          </button>
        {/if}
        {#if isOwner}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'ownership'}
            onclick={() => selectTab('ownership')}
            data-testid="settings-tab-ownership"
          >
            <CrownIcon class="size-4" /> {m.guild_settings_dialog_tab_ownership()}
          </button>
        {/if}
      </nav>

      <main class="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {#if !guild}
          <EmptyState message={m.guild_settings_dialog_community_not_found()} />
        {:else if tab === 'roles' && canManageRoles}
          <RolesEditor
            {guildId}
            editorPermissions={myPermissions}
            {discardSignal}
            bind:dirty={rolesEditorDirty}
          />
        {:else if tab === 'members' && canManageRoles}
          <MemberRoleAssignment {guildId} editorPermissions={myPermissions} />
        {:else if tab === 'sounds' && canManageGuild}
          <GuildSoundsEditor {guildId} />
        {:else if tab === 'dropbox' && canManageGuild}
          <GuildDropboxEditor {guildId} />
        {:else if tab === 'plugins' && canManageGuild}
          <GuildPluginsEditor {guildId} />
        {:else if tab === 'publicaddress' && canManageGuild}
          <GuildPublicAddressEditor {guildId} />
        {:else if tab === 'limits' && canManageGuild}
          <GuildLimitsEditor {guildId} />
        {:else if tab === 'invites' && canCreateInvites}
          <GuildInvitesEditor {guildId} />
        {:else if tab === 'modqueue' && canSeeModQueue}
          <ModQueue {guildId} />
        {:else if tab === 'auditlog' && canManageGuild}
          <AuditLogViewer {guildId} />
        {:else if tab === 'ownership' && isOwner}
          <OwnerTransferSection {guild} />
        {:else}
          <EmptyState message={m.guild_settings_dialog_no_permission()} />
        {/if}
      </main>
    </div>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={closeConfirmOpen}>
  <AlertDialog.Content data-testid="settings-close-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.guild_settings_dialog_discard_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.guild_settings_dialog_discard_close_description()}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.guild_settings_dialog_keep_editing()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDiscardClose}>{m.guild_settings_dialog_discard()}</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={tabConfirmOpen}>
  <AlertDialog.Content data-testid="settings-tab-switch-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.guild_settings_dialog_discard_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.guild_settings_dialog_discard_tab_description()}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.guild_settings_dialog_keep_editing()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDiscardTab}>{m.guild_settings_dialog_discard()}</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
