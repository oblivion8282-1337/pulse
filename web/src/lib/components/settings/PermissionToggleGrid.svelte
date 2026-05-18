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

  type Group = { title: string; entries: { perm: Permission; label: string; desc: string }[] };

  const groups: Group[] = [
    {
      title: 'Server-Administration',
      entries: [
        { perm: Perm.MANAGE_GUILD, label: 'Server verwalten', desc: 'Name, Bild, Settings ändern.' },
        { perm: Perm.MANAGE_CHANNELS, label: 'Kanäle verwalten', desc: 'Kanäle anlegen, umbenennen, löschen.' },
        { perm: Perm.MANAGE_ROLES, label: 'Rollen verwalten', desc: 'Rollen anlegen, editieren, zuweisen.' },
        { perm: Perm.MANAGE_PERMISSIONS, label: 'Kanal-Berechtigungen', desc: 'Channel-Overrides pro Rolle/User editieren.' },
        { perm: Perm.MANAGE_INVITES, label: 'Einladungen verwalten', desc: 'Fremde Einladungen widerrufen.' }
      ]
    },
    {
      title: 'Mitglieder',
      entries: [
        { perm: Perm.KICK_MEMBERS, label: 'Mitglieder rauswerfen', desc: 'Member aus dem Server kicken.' },
        { perm: Perm.BAN_MEMBERS, label: 'Mitglieder bannen', desc: 'Member dauerhaft sperren.' },
        { perm: Perm.CHANGE_NICKNAME, label: 'Eigenen Nick ändern', desc: 'Eigenen Anzeigenamen setzen.' },
        { perm: Perm.MANAGE_NICKNAMES, label: 'Andere Nicks ändern', desc: 'Anzeigenamen anderer setzen.' }
      ]
    },
    {
      title: 'Kanäle',
      entries: [
        { perm: Perm.VIEW_CHANNEL, label: 'Kanal ansehen', desc: 'Pflicht: ohne dieses Bit greift nichts darunter.' },
        { perm: Perm.READ_HISTORY, label: 'Nachrichten-Verlauf lesen', desc: 'Ältere Nachrichten sichtbar.' },
        { perm: Perm.SEND_MESSAGES, label: 'Nachrichten senden', desc: 'In Text-Kanälen posten.' },
        { perm: Perm.MANAGE_MESSAGES, label: 'Nachrichten moderieren', desc: 'Fremde Nachrichten löschen.' },
        { perm: Perm.ATTACH_FILES, label: 'Dateien anhängen', desc: 'Bilder + Files mitschicken.' },
        { perm: Perm.ADD_REACTIONS, label: 'Reaktionen', desc: 'Emoji-Reactions setzen.' },
        { perm: Perm.CREATE_INVITES, label: 'Einladungen erstellen', desc: 'Invite-Links generieren.' },
        { perm: Perm.MENTION_EVERYONE, label: '@everyone erwähnen', desc: 'Den Server-weiten Mention auslösen.' }
      ]
    },
    {
      title: 'Sprache / Stream',
      entries: [
        { perm: Perm.CONNECT, label: 'Voice betreten', desc: 'Voice-Kanal joinen.' },
        { perm: Perm.SPEAK, label: 'Sprechen', desc: 'Mic-Audio senden.' },
        { perm: Perm.STREAM, label: 'HQ-Stream / Screenshare', desc: 'Eigenen Bildschirm pushen.' },
        { perm: Perm.USE_VIDEO, label: 'Kamera', desc: 'Webcam (geplant).' },
        { perm: Perm.MUTE_MEMBERS, label: 'Mute Members', desc: 'Andere im Voice muten.' },
        { perm: Perm.DEAFEN_MEMBERS, label: 'Deafen Members', desc: 'Andere im Voice taub stellen.' },
        { perm: Perm.MOVE_MEMBERS, label: 'Move Members', desc: 'Andere zwischen Voice-Channels verschieben.' }
      ]
    },
    {
      title: 'Admin-Übermacht',
      entries: [
        {
          perm: Perm.ADMINISTRATOR,
          label: 'Administrator',
          desc: 'Bypass: alle Permissions implizit gesetzt. Nur an vertraute Rollen geben.'
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
            class="bg-bg-hover/40 flex cursor-pointer items-start justify-between gap-4 rounded-lg px-3 py-2 hover:bg-bg-hover"
            class:cursor-not-allowed={!allowed || disabled}
            class:opacity-50={!allowed || disabled}
          >
            <div class="min-w-0">
              <div class="text-text-bright text-sm font-medium">{e.label}</div>
              <div class="text-text-muted text-xs">{e.desc}</div>
              {#if !allowed}
                <div class="mt-0.5 text-xs text-amber-500">Du hast diese Permission selbst nicht.</div>
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
