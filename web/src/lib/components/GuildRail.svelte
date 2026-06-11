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
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import ImageIcon from '@lucide/svelte/icons/image';
  import ImageOffIcon from '@lucide/svelte/icons/image-off';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import UsersRoundIcon from '@lucide/svelte/icons/users-round';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import ServerIcon from '@lucide/svelte/icons/server';
  import LogOutIcon from '@lucide/svelte/icons/log-out';
  import { onMount, onDestroy } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { ApiError } from '$lib/api/client';
  import { leaveInstanceOn } from '$lib/api/add-server-flow';
  import { guildIconSrc } from '$lib/guildIcon';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  // Channels-by-guild map drives the guild-rail mention indicator. We
  // reach into the same store; the rail's `guilds` prop only has
  // top-level guild metadata, not their channel lists.
  import { roles } from '$lib/stores/roles.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { serversStore, type ServerEntry } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
  import { gatewayPool } from '$lib/ws/gateway-pool.svelte';
  import { serverState } from '$lib/ws/server-state.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { serverCapabilities } from '$lib/stores/serverCapabilities.svelte';
  import AddServerDialog from './sidebar/AddServerDialog.svelte';
  import ServerInfoDialog from './sidebar/ServerInfoDialog.svelte';
  import ServerIconButton from './sidebar/ServerIconButton.svelte';
  import RenameGuildDialog from './RenameGuildDialog.svelte';
  import UserFooter from './UserFooter.svelte';
  import GuildSettingsDialog from './settings/GuildSettingsDialog.svelte';
  import GuildVoiceTooltip from './GuildVoiceTooltip.svelte';
  import type { Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    guilds,
    activeGuildId = null,
    currentUserId = null,
    homeActive = false,
    onSelect,
    onCreateClick,
    onJoinClick,
    onHomeClick,
    onGuildDeleted
  }: {
    guilds: Guild[];
    activeGuildId?: string | null;
    currentUserId?: string | null;
    /** Show the active pill on the home button (e.g. when on /app/@me). */
    homeActive?: boolean;
    onSelect: (g: Guild) => void;
    /** Opens the add-community dialog on the *create* screen. Undefined when
     *  the admin disabled guild-creation for non-admins → the "Community
     *  erstellen" menu item is hidden (joining stays available). */
    onCreateClick?: () => void;
    /** Opens the add-community dialog on the *join* screen. */
    onJoinClick?: () => void;
    /** Overrides the default `href="/app"` navigation. */
    onHomeClick?: () => void;
    onGuildDeleted?: (guildId: string) => void;
  } = $props();

  // Drives the red dot on the home button so the user sees there's something
  // waiting on /app/@me without navigating there first. Covers everything that
  // lives in the home area: unread DMs *and* incoming friend requests.
  // Computed live — flips off as the user reads the DM (markRead bumps
  // lastRead) / actions the request, and is hidden entirely while the user is
  // already on the home view (`!homeActive` in the markup below).
  let hasUnreadDM = $derived(directMessages.list.some((dm) => readState.isUnread(dm.id)));
  let hasHomeActivity = $derived(hasUnreadDM || friendRequests.incomingList.length > 0);

  let renameTarget = $state<Guild | null>(null);
  let deleteTarget = $state<Guild | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleteBusy = $state(false);
  let leaveTarget = $state<Guild | null>(null);
  let leaveConfirmOpen = $state(false);
  let leaveBusy = $state(false);
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
      toast.success(m.guild_rail_icon_updated());
    } catch (err) {
      toast.error(m.guild_rail_icon_upload_failed(), { description: (err as Error).message });
    }
  }

  async function removeIcon(g: Guild) {
    try {
      await chatApi.deleteGuildIcon(g.id);
      guildsStore.updateGuild({ ...g, icon_url: null });
      toast.success(m.guild_rail_icon_removed());
    } catch (err) {
      toast.error(m.guild_rail_icon_remove_failed(), { description: (err as Error).message });
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
      toast.error(m.guild_rail_delete_failed(), { description: (err as Error).message });
    } finally {
      deleteBusy = false;
    }
  }

  function openLeave(g: Guild) {
    leaveTarget = g;
    leaveConfirmOpen = true;
  }

  async function confirmLeave() {
    if (!leaveTarget) return;
    const id = leaveTarget.id;
    leaveBusy = true;
    try {
      await chatApi.leaveGuild(id);
      // Lokal entfernen + (falls aktiv) wegnavigieren — gleiche UX wie beim
      // Delete; das ``guild_member_removed``-WS-Event räumt parallel mit auf.
      guildsStore.remove(id);
      onGuildDeleted?.(id);
      leaveConfirmOpen = false;
      leaveTarget = null;
    } catch (err) {
      toast.error(m.guild_rail_leave_failed(), { description: (err as Error).message });
    } finally {
      leaveBusy = false;
    }
  }

  // -- Server-Instanzen-Section (Cloud + Self-Hosts) ------------------------
  // Vorher eine eigene linke Spalte (ServerSidebar.svelte); jetzt unten in
  // dieser Spalte integriert mit Trennlinie davor. Designziel: eine
  // vertikale Sidebar, Discord-Style für Cloud-only-User mit kompaktem
  // Footer-Block, Self-Host-User sieht zusätzliche Server-Icons.
  let addServerOpen = $state(false);
  let removeServerTarget = $state<ServerEntry | null>(null);
  let removeServerConfirmOpen = $state(false);
  let infoServerTarget = $state<ServerEntry | null>(null);
  let infoServerOpen = $state(false);

  onMount(() => serverState.start());
  onDestroy(() => serverState.stop());

  let cloudServer = $derived(serversStore.servers.find((s) => s.isCloud));
  let selfHostServers = $derived(serversStore.servers.filter((s) => !s.isCloud));

  function openServerInfo(server: ServerEntry): void {
    infoServerTarget = server;
    infoServerOpen = true;
  }

  function setServerNotif(server: ServerEntry, mode: ServerEntry['notification_mode']): void {
    serversStore.update(server.id, { notification_mode: mode });
  }

  function openServerRemove(server: ServerEntry): void {
    removeServerTarget = server;
    removeServerConfirmOpen = true;
  }

  async function confirmServerRemove(): Promise<void> {
    if (!removeServerTarget) return;
    const id = removeServerTarget.id;
    const label = removeServerTarget.label;
    const isCloud = removeServerTarget.isCloud;
    // Entfernen = echtes Austreten (User-Entscheidung 2026-06-10): erst die
    // Instanz-Mitgliedschaft serverseitig beenden, dann lokal aufräumen.
    // 403 = Instanz-Owner (bleibt Mitglied, nur Ansicht entfernt) · 409 =
    // besitzt noch Communitys (Abbruch) · Netzfehler = lokal trotzdem
    // entfernen, aber warnen (Mitgliedschaft besteht weiter).
    let leaveResult: 'left' | 'owner' | 'unreachable' = 'left';
    if (!isCloud) {
      try {
        await leaveInstanceOn({ serverId: id });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          toast.error(m.guild_rail_leave_owns_communities());
          removeServerConfirmOpen = false;
          removeServerTarget = null;
          return;
        }
        leaveResult = err instanceof ApiError && err.status === 403 ? 'owner' : 'unreachable';
      }
    }
    try {
      // Connection schließen BEVOR der Entry weg ist (Pool dereferenced
      // serversStore.find sonst zu undefined → spätere reconnects crashen).
      gatewayPool.close(id);
      serversStore.remove(id);
      serverGuilds.forget(id);
      serverCapabilities.forget(id);
      if (activeServer.serverId === id) {
        const fallback = serversStore.servers.find((s) => s.isCloud);
        if (fallback) activeServer.set(fallback.id);
      }
      if (isCloud || leaveResult === 'left') {
        toast.success(m.guild_rail_server_removed({ label }));
      } else if (leaveResult === 'owner') {
        toast.info(m.guild_rail_leave_owner_view_only({ label }));
      } else {
        toast.warning(m.guild_rail_leave_unreachable({ label }));
      }
    } catch (err) {
      toast.error(m.guild_rail_server_remove_failed(), { description: (err as Error).message });
    } finally {
      removeServerConfirmOpen = false;
      removeServerTarget = null;
    }
  }

  // Click auf eine Community aus einer non-aktiven Server-Sektion: erst Server
  // wechseln, dann die Community aktivieren. activeServer.set() resettet die
  // Server-scoped Stores und re-connectet die WS — sobald der Ready-Frame
  // zurück ist, navigiert onSelect zur konkreten Community.
  function selectGuildFromServer(g: Guild, serverId: string): void {
    if (serverId !== activeServer.serverId) {
      activeServer.set(serverId);
    }
    onSelect(g);
  }

  // Darf der User auf DIESEM Server eine Community erstellen? Admin des Servers
  // (Cloud: ``auth.user.is_admin``; Self-Host: ``serverAdmin`` aus dem
  // Ready-Frame) ODER der Server hat ``allow_guild_creation`` offen. Der
  // Capabilities-Flag wird pro Server geladen (serverCapabilities); solange er
  // fehlt, zeigt das „+" nur für Admins (kein optimistisches Flackern).
  function canCreateOnServer(server: ServerEntry): boolean {
    if (isAdminOnServer(server)) return true;
    return serverCapabilities.get(server.id)?.allowGuildCreation ?? false;
  }

  // Per-Server-„+"-Aktionen: erst den Server aktivieren (falls nötig), dann den
  // Erstellen-/Beitreten-Dialog des Eltern-Views öffnen. Der Dialog läuft gegen
  // den aktiven Server, daher landet die neue/beigetretene Community garantiert
  // auf genau dem Server, dessen „+" geklickt wurde.
  function createOnServer(serverId: string): void {
    if (serverId !== activeServer.serverId) activeServer.set(serverId);
    onCreateClick?.();
  }

  function joinOnServer(serverId: string): void {
    if (serverId !== activeServer.serverId) activeServer.set(serverId);
    onJoinClick?.();
  }

  // Kompakter Section-Header pro Server: 2-Letter-Initialen, Klick öffnet
  // dasselbe ContextMenu wie der frühere ServerIconButton (Notif-Mode,
  // Server-Info, Server entfernen).
  function serverInitials(label: string): string {
    return label
      .replace(/^https?:\/\//, '')
      .split(/[.\s-]+/)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('') || '?';
  }

  // Cloud: is_admin-Flag aus dem Auth-State; Self-Host: serverAdmin-Store aus
  // dem Ready-Frame. Zentralisiert den doppelten Ausdruck (canCreateOnServer +
  // Template-@const).
  function isAdminOnServer(server: ServerEntry): boolean {
    return server.isCloud ? !!auth.user?.is_admin : serverAdmin.isAdmin(server.id);
  }

  // Status-Dot-Farbe für Self-Host-Server-Section-Header.
  function serverStateDotColor(state: string): string {
    if (state === 'open') return 'bg-emerald-500';
    if (state === 'connecting' || state === 'starting' || state === 'updating') return 'bg-amber-500';
    if (state === 'incompatible' || state === 'cors-blocked' || state === 'mfa-required') return 'bg-red-500';
    return 'bg-gray-500';
  }
</script>

<nav
  class="glass-panel flex h-full w-20 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden rounded-none py-3 md:w-16 md:rounded-2xl"
  data-testid="guild-rail"
  aria-label={m.guild_rail_nav_label()}
>
  <!-- Tooltips auf Mobil aus: Hover-Popups (Server-Name/Member-Zahl) poppen
       auf Touch beim Antippen unerwünscht auf. -->
  <Tooltip.Provider delayDuration={200} disabled={viewport.isMobile}>
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
                aria-label={m.guild_rail_direct_messages()}
                data-testid="guild-home"
                onclick={onHomeClick}
              >
                <img src="/pulse-mark.svg" alt="" width="36" height="36" class="size-11 rounded-lg md:size-9" />
              </button>
            {:else}
              <a
                {...props}
                href="/app"
                class="block"
                aria-label="Pulse"
                data-testid="guild-home"
              >
                <img src="/pulse-mark.svg" alt="" width="36" height="36" class="size-11 rounded-lg md:size-9" />
              </a>
            {/if}
            {#if hasHomeActivity && !homeActive}
              <span
                class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-red-500 ring-2 ring-bg-panel"
                aria-label={m.guild_rail_home_activity_dot()}
                data-testid="home-unread-dot"
              ></span>
            {/if}
          </div>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right">
        {onHomeClick ? m.guild_rail_direct_messages() : 'Pulse'}
      </Tooltip.Content>
    </Tooltip.Root>

    <div class="bg-border my-1 h-px w-8 shrink-0" aria-hidden="true"></div>

    <!-- Sidebar-Variante B: pro Server eine eigene Sektion. Section-Header =
         Server-Label + Status-Dot. Darunter die Communitys DIESES Servers,
         dann ein "+" zum Anlegen einer neuen Community auf DIESEM Server. Am
         Ende globaler "+ Server"-Button für Self-Host-Add. -->
    {#each serversStore.servers as server, sectionIdx (server.id)}
      {@const isActiveServer = activeServer.serverId === server.id}
      {@const sectionGuilds = serverGuilds.get(server.id)}
      {@const sState = serverState.get(server.id).state}
      {@const isServerAdmin = isAdminOnServer(server)}
      {#if sectionIdx > 0}
        <div class="bg-border my-2 h-px w-8 shrink-0" aria-hidden="true"></div>
      {/if}

      <!-- Section-Header: Server-Label + Status-Dot, Klick = aktivieren -->
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props: ctxProps })}
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props: tipProps })}
                  <button
                    {...ctxProps}
                    {...tipProps}
                    class="relative flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[10px] font-bold uppercase tracking-wide transition-colors hover:bg-bg-hover data-[active=true]:text-primary"
                    data-active={isActiveServer}
                    onclick={() => activeServer.set(server.id)}
                    data-testid={`server-${server.id}`}
                    aria-label={server.label}
                  >
                    <!-- Cloud-Server: Marken-Label "PULSE" ohne Status-Dot
                         (immer da, kein Verbindungszustand nötig). Selbst-
                         gehostete Zusatz-Server behalten Initialen + Dot, weil
                         der Punkt dort echte Connect-/Fehlerzustände anzeigt. -->
                    {#if server.isCloud}
                      Pulse
                    {:else}
                      {serverInitials(server.label)}
                      <span
                        class="size-1.5 rounded-full {serverStateDotColor(sState)}"
                        data-testid="server-state-dot"
                        aria-label={`Status: ${sState}`}
                      ></span>
                    {/if}
                  </button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content side="right">{server.label}</Tooltip.Content>
            </Tooltip.Root>
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => openServerInfo(server)}>
            {m.guild_rail_server_info()}
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger>{m.guild_rail_notifications()}</ContextMenu.SubTrigger>
            <ContextMenu.SubContent>
              <ContextMenu.CheckboxItem
                checked={server.notification_mode === 'all'}
                onCheckedChange={() => setServerNotif(server, 'all')}
              >{m.guild_rail_notif_all()}</ContextMenu.CheckboxItem>
              <ContextMenu.CheckboxItem
                checked={server.notification_mode === 'mentions'}
                onCheckedChange={() => setServerNotif(server, 'mentions')}
              >{m.guild_rail_notif_mentions()}</ContextMenu.CheckboxItem>
              <ContextMenu.CheckboxItem
                checked={server.notification_mode === 'none'}
                onCheckedChange={() => setServerNotif(server, 'none')}
              >{m.guild_rail_notif_mute()}</ContextMenu.CheckboxItem>
            </ContextMenu.SubContent>
          </ContextMenu.Sub>
          {#if !server.isCloud}
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onSelect={() => openServerRemove(server)}>
              <Trash2Icon /> {m.guild_rail_remove_server()}
            </ContextMenu.Item>
          {/if}
        </ContextMenu.Content>
      </ContextMenu.Root>

      <!-- Communitys des Servers -->
      {#each sectionGuilds as g (g.id)}
        {@const isOwner = isActiveServer && currentUserId !== null && g.owner_id === currentUserId}
        {@const canManageGuild = isActiveServer && roles.hasGuildPermission(g.id, Perm.MANAGE_GUILD)}
        {@const canManageRoles = isActiveServer && roles.hasGuildPermission(g.id, Perm.MANAGE_ROLES)}
        {@const active = isActiveServer && activeGuildId === g.id}
        {@const guildChannels = isActiveServer ? (guildsStore.channelsByGuild[g.id] ?? []) : []}
        {@const guildChannelIds = isActiveServer && !active ? guildChannels.map((c) => c.id) : []}
        {@const guildMentioned = isActiveServer && !active && readState.hasGuildMentions(guildChannelIds)}
        {@const iconSrc = guildIconSrc(g.icon_url, server.hostname)}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            {#snippet child({ props })}
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props: tipProps })}
                    <div class="relative shrink-0">
                      {#if active}
                        <span
                          class="absolute -left-2 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                          aria-hidden="true"
                        ></span>
                      {/if}
                      <button
                        {...props}
                        {...tipProps}
                        class="relative flex size-12 items-center justify-center overflow-hidden rounded-2xl text-xs font-bold text-white transition-all md:size-10 hover:rounded-xl data-[active=true]:rounded-xl data-[active=true]:shadow-[0_0_8px_color-mix(in_oklab,var(--primary)_70%,transparent),0_0_22px_color-mix(in_oklab,var(--primary)_55%,transparent)]"
                        style={iconSrc
                          ? ''
                          : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
                        data-active={active}
                        onclick={() => selectGuildFromServer(g, server.id)}
                        data-testid={`guild-${g.id}`}
                      >
                        {#if iconSrc}
                          <img src={iconSrc} alt={g.name} class="size-full object-cover" />
                        {:else}
                          {initials(g.name)}
                        {/if}
                      </button>
                      {#if guildMentioned}
                        <span
                          class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-red-500 ring-2 ring-bg-panel"
                          aria-label={m.guild_rail_unread_mentions()}
                          data-testid="guild-mention-dot"
                        ></span>
                      {/if}
                    </div>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content
                  side="right"
                  class="flex-col items-stretch gap-0 px-3 py-2.5 min-w-[12rem]"
                >
                  <GuildVoiceTooltip
                    guildId={g.id}
                    name={g.name}
                    serverId={server.id}
                    serverLabel={isActiveServer ? null : server.label}
                  />
                </Tooltip.Content>
              </Tooltip.Root>
            {/snippet}
          </ContextMenu.Trigger>
          {#if isActiveServer}
            <ContextMenu.Content>
              {#if canManageRoles || isOwner}
                <ContextMenu.Item
                  onSelect={() => openSettings(g)}
                  data-testid="guild-settings"
                >
                  <SettingsIcon />
                  {m.guild_rail_settings()}
                </ContextMenu.Item>
              {/if}
              {#if canManageGuild}
                <ContextMenu.Item onSelect={() => openRename(g)} data-testid="guild-rename">
                  <PencilIcon />
                  {m.guild_rail_rename_community()}
                </ContextMenu.Item>
                <ContextMenu.Item onSelect={() => openIconPicker(g)} data-testid="guild-icon-set">
                  <ImageIcon />
                  {m.guild_rail_change_icon()}
                </ContextMenu.Item>
                {#if g.icon_url}
                  <ContextMenu.Item onSelect={() => removeIcon(g)} data-testid="guild-icon-clear">
                    <ImageOffIcon />
                    {m.guild_rail_remove_icon()}
                  </ContextMenu.Item>
                {/if}
              {/if}
              {#if isOwner || isServerAdmin}
                {#if canManageGuild}<ContextMenu.Separator />{/if}
                <ContextMenu.Item variant="destructive" onSelect={() => openDelete(g)} data-testid="guild-delete">
                  <Trash2Icon />
                  {m.guild_rail_delete_community()}
                </ContextMenu.Item>
              {/if}
              <!-- Verlassen: jedes Mitglied AUSSER dem Owner (der muss erst
                   übertragen/löschen). Funktioniert identisch Cloud + Self-Host. -->
              {#if !isOwner}
                {#if canManageGuild || canManageRoles || isServerAdmin}<ContextMenu.Separator />{/if}
                <ContextMenu.Item variant="destructive" onSelect={() => openLeave(g)} data-testid="guild-leave">
                  <LogOutIcon />
                  {m.guild_rail_leave_community()}
                </ContextMenu.Item>
              {/if}
            </ContextMenu.Content>
          {/if}
        </ContextMenu.Root>
      {/each}

      <!-- Per-Server-„+": Mini-Menü für DIESEN Server. IMMER sichtbar (jedes
           Mitglied kann einer Community beitreten); nur der Punkt „Community
           erstellen" ist gegatet (``canCreateOnServer`` = Admin oder
           allow_guild_creation). Klick aktiviert erst den Server, dann öffnet
           der Eltern-Dialog → neue/beigetretene Community landet garantiert auf
           genau diesem Server. Bewusst kleiner als die Community-Icons
           (size-9, gestrichelt), damit es als Sektions-Aktion liest. -->
      {#if onCreateClick || onJoinClick}
        {@const canCreateHere = !!onCreateClick && canCreateOnServer(server)}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <!-- KEIN Tooltip-Wrapper: ein zweiter Trigger-Spread (tipProps)
                   überschreibt die Klick-Handler des DropdownMenu-Triggers, dann
                   öffnet das Menü nur per Tastatur, nicht per Maus. aria-label
                   deckt die Zugänglichkeit ab. -->
              <button
                {...props}
                class="border-primary/40 text-primary flex size-9 shrink-0 items-center justify-center rounded-xl border border-dashed bg-transparent transition-all hover:rounded-lg hover:bg-primary/10"
                data-testid={`guild-create-menu-${server.id}`}
                aria-label={canCreateHere
                  ? m.guild_rail_create_community()
                  : m.guild_rail_join_community()}
              >
                <PlusIcon class="size-4" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="right" align="start" class="w-56">
            {#if canCreateHere}
              <DropdownMenu.Item
                onSelect={() => createOnServer(server.id)}
                data-testid="guild-create"
              >
                <UsersRoundIcon />
                {m.guild_rail_create_community()}
              </DropdownMenu.Item>
            {/if}
            {#if onJoinClick}
              <DropdownMenu.Item onSelect={() => joinOnServer(server.id)} data-testid="guild-join">
                <LogInIcon />
                {m.guild_rail_join_community()}
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}

    {/each}

    <!-- "Server hinzufügen" ist bewusst abgesetzt ganz unten — es betrifft die
         ganze App (neuer Self-Host/Cloud-Verbund), nicht eine einzelne
         Community. Der flex-Spacer schiebt es ans Leisten-Ende. -->
    <div class="min-h-2 flex-1 shrink-0" aria-hidden="true"></div>
    <div class="bg-border my-1 h-px w-8 shrink-0" aria-hidden="true"></div>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            class="border-border text-text-muted hover:text-text-bright flex size-10 shrink-0 items-center justify-center rounded-2xl border border-dashed bg-transparent transition-all hover:rounded-xl hover:bg-bg-hover"
            data-testid="server-add"
            aria-label={m.guild_rail_add_server()}
            onclick={() => (addServerOpen = true)}
          >
            <ServerIcon class="size-5" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right">{m.guild_rail_add_server()}</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>

  <!-- Eigener User: auf Mobil unten in der Server-Spalte, nur das Avatar-
       Symbol (Desktop hat ihn im Sidebar-Footer mit Name). -->
  {#if viewport.isMobile}
    <div class="mt-auto shrink-0 pt-1">
      <UserFooter compact />
    </div>
  {/if}
</nav>

<AddServerDialog open={addServerOpen} onClose={() => (addServerOpen = false)} />

<AlertDialog.Root bind:open={removeServerConfirmOpen}>
  <AlertDialog.Content data-testid="remove-server-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.guild_rail_remove_server_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.guild_rail_remove_server_description({ label: removeServerTarget?.label ?? m.guild_rail_this_server() })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.guild_rail_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmServerRemove} data-testid="remove-server-confirm">
        {m.guild_rail_remove_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<ServerInfoDialog bind:open={infoServerOpen} server={infoServerTarget} />

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
      <AlertDialog.Title>{m.guild_rail_delete_community_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.guild_rail_delete_community_description({ name: deleteTarget?.name ?? m.guild_rail_this_community() })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deleteBusy}>{m.guild_rail_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={confirmDelete}
        disabled={deleteBusy}
        data-testid="delete-guild-confirm"
      >
        {deleteBusy ? m.guild_rail_deleting() : m.guild_rail_delete_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={leaveConfirmOpen}>
  <AlertDialog.Content data-testid="leave-guild-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.guild_rail_leave_community_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {m.guild_rail_leave_community_description({ name: leaveTarget?.name ?? m.guild_rail_this_community() })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={leaveBusy}>{m.guild_rail_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={confirmLeave}
        disabled={leaveBusy}
        data-testid="leave-guild-confirm"
      >
        {leaveBusy ? m.guild_rail_leaving() : m.guild_rail_leave_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
