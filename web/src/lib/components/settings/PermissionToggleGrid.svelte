<!--
  PermissionToggleGrid — a flat list of toggles, one per Permissions bit
  we surface to admins. Grouped headlines mirror the bit layout in the
  shared resolver (server admin / member / channel / voice / ADMIN).

  Editor-perms gating: each bit is locked off when the *editor* doesn't
  hold it themselves (anti-escalation). The server-side check is the
  authoritative one — the frontend gate just keeps the UX honest.
-->
<script lang="ts">
  import { Perm, has, toBitfield, type Permission } from '$lib/permissions/bitfield';
  import { m } from '$lib/paraglide/messages.js';

  type Group = { title: string; entries: { perm: Permission; label: string; desc: string }[] };

  const groups: Group[] = [
    {
      title: m.permission_toggle_grid_group_community_admin(),
      entries: [
        { perm: Perm.MANAGE_GUILD, label: m.permission_toggle_grid_label_manage_guild(), desc: m.permission_toggle_grid_desc_manage_guild() },
        { perm: Perm.MANAGE_CHANNELS, label: m.permission_toggle_grid_label_manage_channels(), desc: m.permission_toggle_grid_desc_manage_channels() },
        { perm: Perm.MANAGE_ROLES, label: m.permission_toggle_grid_label_manage_roles(), desc: m.permission_toggle_grid_desc_manage_roles() },
        { perm: Perm.MANAGE_PERMISSIONS, label: m.permission_toggle_grid_label_manage_permissions(), desc: m.permission_toggle_grid_desc_manage_permissions() },
        { perm: Perm.MANAGE_INVITES, label: m.permission_toggle_grid_label_manage_invites(), desc: m.permission_toggle_grid_desc_manage_invites() }
      ]
    },
    {
      title: m.permission_toggle_grid_group_members(),
      entries: [
        { perm: Perm.KICK_MEMBERS, label: m.permission_toggle_grid_label_kick_members(), desc: m.permission_toggle_grid_desc_kick_members() },
        { perm: Perm.BAN_MEMBERS, label: m.permission_toggle_grid_label_ban_members(), desc: m.permission_toggle_grid_desc_ban_members() },
        { perm: Perm.CHANGE_NICKNAME, label: m.permission_toggle_grid_label_change_nickname(), desc: m.permission_toggle_grid_desc_change_nickname() },
        { perm: Perm.MANAGE_NICKNAMES, label: m.permission_toggle_grid_label_manage_nicknames(), desc: m.permission_toggle_grid_desc_manage_nicknames() }
      ]
    },
    {
      title: m.permission_toggle_grid_group_channels(),
      entries: [
        { perm: Perm.VIEW_CHANNEL, label: m.permission_toggle_grid_label_view_channel(), desc: m.permission_toggle_grid_desc_view_channel() },
        { perm: Perm.READ_HISTORY, label: m.permission_toggle_grid_label_read_history(), desc: m.permission_toggle_grid_desc_read_history() },
        { perm: Perm.SEND_MESSAGES, label: m.permission_toggle_grid_label_send_messages(), desc: m.permission_toggle_grid_desc_send_messages() },
        { perm: Perm.MANAGE_MESSAGES, label: m.permission_toggle_grid_label_manage_messages(), desc: m.permission_toggle_grid_desc_manage_messages() },
        { perm: Perm.ATTACH_FILES, label: m.permission_toggle_grid_label_attach_files(), desc: m.permission_toggle_grid_desc_attach_files() },
        { perm: Perm.ADD_REACTIONS, label: m.permission_toggle_grid_label_add_reactions(), desc: m.permission_toggle_grid_desc_add_reactions() },
        { perm: Perm.CREATE_INVITES, label: m.permission_toggle_grid_label_create_invites(), desc: m.permission_toggle_grid_desc_create_invites() },
        { perm: Perm.MENTION_EVERYONE, label: m.permission_toggle_grid_label_mention_everyone(), desc: m.permission_toggle_grid_desc_mention_everyone() }
      ]
    },
    {
      title: m.permission_toggle_grid_group_voice_stream(),
      entries: [
        { perm: Perm.CONNECT, label: m.permission_toggle_grid_label_connect(), desc: m.permission_toggle_grid_desc_connect() },
        { perm: Perm.SPEAK, label: m.permission_toggle_grid_label_speak(), desc: m.permission_toggle_grid_desc_speak() },
        { perm: Perm.STREAM, label: m.permission_toggle_grid_label_stream(), desc: m.permission_toggle_grid_desc_stream() },
        { perm: Perm.USE_VIDEO, label: m.permission_toggle_grid_label_use_video(), desc: m.permission_toggle_grid_desc_use_video() },
        { perm: Perm.MUTE_MEMBERS, label: m.permission_toggle_grid_label_mute_members(), desc: m.permission_toggle_grid_desc_mute_members() },
        { perm: Perm.DEAFEN_MEMBERS, label: m.permission_toggle_grid_label_deafen_members(), desc: m.permission_toggle_grid_desc_deafen_members() },
        { perm: Perm.MOVE_MEMBERS, label: m.permission_toggle_grid_label_move_members(), desc: m.permission_toggle_grid_desc_move_members() }
      ]
    },
    {
      title: m.permission_toggle_grid_group_admin_override(),
      entries: [
        {
          perm: Perm.ADMINISTRATOR,
          label: m.permission_toggle_grid_label_administrator(),
          desc: m.permission_toggle_grid_desc_administrator()
        }
      ]
    }
  ];

  let {
    value = $bindable('0'),
    editorPermissions,
    disabled = false
  }: {
    /** Bitfield as wire-string (BigInt-safe). */
    value: string;
    /** The editor's resolved guild-wide bitfield. Bits they lack are
     * locked off so they can't grant what they don't have. */
    editorPermissions: string;
    disabled?: boolean;
  } = $props();

  function toggle(perm: Permission, on: boolean): void {
    if (disabled) return;
    if (!has(toBitfield(editorPermissions), perm)) return;
    let bf = toBitfield(value);
    bf = on ? bf | perm : bf & ~perm;
    value = bf.toString();
  }

  function isSet(perm: Permission): boolean {
    return has(toBitfield(value), perm);
  }

  function isEditorAllowed(perm: Permission): boolean {
    return has(toBitfield(editorPermissions), perm);
  }
</script>

<div class="space-y-6">
  {#each groups as g (g.title)}
    <section>
      <h3 class="text-text-muted mb-2 text-xs font-semibold uppercase tracking-wide">{g.title}</h3>
      <div class="space-y-1">
        {#each g.entries as e (e.perm)}
          {@const set = isSet(e.perm)}
          {@const allowed = isEditorAllowed(e.perm)}
          <label
            class="bg-bg-hover/40 flex cursor-pointer items-start justify-between gap-4 rounded-md px-3 py-2 hover:bg-bg-hover"
            class:cursor-not-allowed={!allowed || disabled}
            class:opacity-50={!allowed || disabled}
          >
            <div class="min-w-0">
              <div class="text-text-bright text-sm font-medium">{e.label}</div>
              <div class="text-text-muted text-xs">{e.desc}</div>
              {#if !allowed}
                <div class="mt-0.5 text-xs text-warning">{m.permission_toggle_grid_editor_missing_perm()}</div>
              {/if}
            </div>
            <input
              type="checkbox"
              class="mt-1 size-4 accent-primary"
              checked={set}
              disabled={!allowed || disabled}
              onchange={(ev) => toggle(e.perm, (ev.currentTarget as HTMLInputElement).checked)}
              data-testid={`perm-toggle-${e.perm.toString()}`}
            />
          </label>
        {/each}
      </div>
    </section>
  {/each}
</div>
