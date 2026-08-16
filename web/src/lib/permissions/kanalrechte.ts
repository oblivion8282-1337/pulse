/**
 * Welche Rechte in einem Kanal überhaupt zur Debatte stehen — mit je einem
 * kurzen Satz dazu.
 *
 * **Warum ein Satz.** Der Name allein trägt nicht: „Berechtigungen" heisst
 * „darf genau diese Seite ändern", und das steht nirgends. Vier bis sechs
 * Wörter, kein Aufsatz — mehr liest niemand in einer Liste aus fünfzehn Zeilen.
 *
 * **Warum eine Funktion und keine Konstante.** Die Texte kommen aus Paraglide;
 * eine Konstante würde die Sprache beim Laden des Moduls einfrieren.
 *
 * Ein Bit gehört hierher, sobald der Server es kanalskopiert auflöst.
 */

import { m } from '$lib/paraglide/messages.js';
import { Perm, type Permission } from './bitfield';

export type Kanalrecht = {
  perm: Permission;
  name: string;
  /** Ein Satz, der sagt, was die Person damit tut. */
  satz: string;
};

export function kanalrechte(): Kanalrecht[] {
  return [
    {
      perm: Perm.VIEW_CHANNEL,
      name: m.channel_overrides_perm_view_channel(),
      satz: m.kanalrechte_satz_view_channel()
    },
    {
      perm: Perm.READ_HISTORY,
      name: m.channel_overrides_perm_read_history(),
      satz: m.kanalrechte_satz_read_history()
    },
    {
      perm: Perm.SEND_MESSAGES,
      name: m.channel_overrides_perm_send_messages(),
      satz: m.kanalrechte_satz_send_messages()
    },
    {
      perm: Perm.MANAGE_MESSAGES,
      name: m.channel_overrides_perm_manage_messages(),
      satz: m.kanalrechte_satz_manage_messages()
    },
    {
      perm: Perm.ATTACH_FILES,
      name: m.channel_overrides_perm_attach_files(),
      satz: m.kanalrechte_satz_attach_files()
    },
    {
      perm: Perm.ADD_REACTIONS,
      name: m.channel_overrides_perm_add_reactions(),
      satz: m.kanalrechte_satz_add_reactions()
    },
    {
      perm: Perm.CREATE_INVITES,
      name: m.channel_overrides_perm_create_invites(),
      satz: m.kanalrechte_satz_create_invites()
    },
    {
      perm: Perm.MENTION_EVERYONE,
      name: m.channel_overrides_perm_mention_everyone(),
      satz: m.kanalrechte_satz_mention_everyone()
    },
    {
      perm: Perm.MANAGE_CHANNELS,
      name: m.channel_overrides_perm_manage_channels(),
      satz: m.kanalrechte_satz_manage_channels()
    },
    {
      perm: Perm.MANAGE_PERMISSIONS,
      name: m.channel_overrides_perm_manage_permissions(),
      satz: m.kanalrechte_satz_manage_permissions()
    },
    {
      perm: Perm.CONNECT,
      name: m.channel_overrides_perm_connect(),
      satz: m.kanalrechte_satz_connect()
    },
    {
      perm: Perm.SPEAK,
      name: m.channel_overrides_perm_speak(),
      satz: m.kanalrechte_satz_speak()
    },
    {
      perm: Perm.STREAM,
      name: m.channel_overrides_perm_stream(),
      satz: m.kanalrechte_satz_stream()
    },
    {
      perm: Perm.USE_VIDEO,
      name: m.channel_overrides_perm_use_video(),
      satz: m.kanalrechte_satz_use_video()
    },
    // Fernsteuerung gehört hierher, obwohl das Recht nicht in
    // DEFAULT_EVERYONE_PERMISSIONS steht: der Gateway löst es KANALSKOPIERT auf
    // (`resolve_permissions(..., cid_int)` in `ws_remote_handlers.py`), und der
    // Anfrage-Knopf tut dasselbe. Ohne diesen Eintrag ließe sich ausgerechnet
    // das empfindlichste Bit in keinem einzelnen Kanal erlauben oder entziehen
    // — nur serverweit über die Rolle.
    {
      perm: Perm.REMOTE_CONTROL,
      name: m.channel_overrides_perm_remote_control(),
      satz: m.kanalrechte_satz_remote_control()
    }
  ];
}
