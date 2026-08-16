/**
 * Der Rechtekatalog — Reihenfolge, Gruppierung, Beschriftung und Tragweite
 * aller Rechte, die wir Administratoren zeigen.
 *
 * Eigene Datei, weil drei Ansichten daran haengen: die Schalterliste im
 * Reiter „Rechte", die Vorlagen beim Anlegen (die ihren Rechtesatz
 * SICHTBAR aufzaehlen) und spaeter jede weitere Stelle, die einen Bit-Namen
 * braucht. Stuende die Tabelle in der Komponente, muesste die zweite
 * Ansicht sie abschreiben.
 *
 * Die Bits selbst kommen aus `lib/permissions/bitfield.ts` und werden hier
 * NICHT veraendert — diese Datei benennt nur, was dort definiert ist.
 *
 * Gebaut wird der Katalog in einer FUNKTION, nicht als Modul-Konstante:
 * die Texte kommen aus paraglide, und auf Modulebene ausgewertet froeren
 * sie auf die Sprache beim Import ein.
 */

import { Perm, type Permission } from '$lib/permissions/bitfield';
import { m } from '$lib/paraglide/messages.js';

/**
 * Tragweite eines Rechts. Nur zwei Stufen, damit die Markierung etwas
 * bedeutet — waere die Haelfte markiert, waere es Tapete.
 *
 * `vollmacht` traegt allein ADMINISTRATOR: es hebt jede andere Pruefung auf.
 *
 * `weitreichend` traegt, was AUF ANDERE MENSCHEN wirkt, statt dem Traeger
 * nur eine eigene Faehigkeit zu geben. Deshalb ist „Nachrichten schreiben"
 * unmarkiert und „fremde Nachrichten loeschen" markiert, obwohl beide im
 * selben Bereich stehen.
 */
export type Tragweite = 'vollmacht' | 'weitreichend' | null;

export type Rechtezeile = {
  perm: Permission;
  label: string;
  /** Ein kurzer Satz, vier bis sechs Woerter. Kein Aufsatz — wer hier
   * erklaeren muss, hat das Recht falsch benannt. */
  kurz: string;
  tragweite: Tragweite;
};

export type Rechtebereich = { titel: string; zeilen: Rechtezeile[] };

export function rechtekatalog(): Rechtebereich[] {
  return [
    {
      titel: m.rechte_bereich_community(),
      zeilen: [
        z(Perm.MANAGE_GUILD, m.rechte_label_manage_guild(), m.rechte_kurz_manage_guild()),
        z(Perm.MANAGE_ROLES, m.rechte_label_manage_roles(), m.rechte_kurz_manage_roles(), 'weitreichend'),
        z(Perm.MANAGE_PERMISSIONS, m.rechte_label_manage_permissions(), m.rechte_kurz_manage_permissions(), 'weitreichend'),
        z(Perm.MANAGE_INVITES, m.rechte_label_manage_invites(), m.rechte_kurz_manage_invites()),
        z(Perm.CREATE_INVITES, m.rechte_label_create_invites(), m.rechte_kurz_create_invites())
      ]
    },
    {
      titel: m.rechte_bereich_mitglieder(),
      zeilen: [
        z(Perm.KICK_MEMBERS, m.rechte_label_kick_members(), m.rechte_kurz_kick_members(), 'weitreichend'),
        z(Perm.BAN_MEMBERS, m.rechte_label_ban_members(), m.rechte_kurz_ban_members(), 'weitreichend'),
        z(Perm.CHANGE_NICKNAME, m.rechte_label_change_nickname(), m.rechte_kurz_change_nickname()),
        z(Perm.MANAGE_NICKNAMES, m.rechte_label_manage_nicknames(), m.rechte_kurz_manage_nicknames(), 'weitreichend')
      ]
    },
    {
      titel: m.rechte_bereich_kanaele(),
      zeilen: [
        z(Perm.MANAGE_CHANNELS, m.rechte_label_manage_channels(), m.rechte_kurz_manage_channels()),
        z(Perm.VIEW_CHANNEL, m.rechte_label_view_channel(), m.rechte_kurz_view_channel()),
        z(Perm.READ_HISTORY, m.rechte_label_read_history(), m.rechte_kurz_read_history())
      ]
    },
    {
      titel: m.rechte_bereich_nachrichten(),
      zeilen: [
        z(Perm.SEND_MESSAGES, m.rechte_label_send_messages(), m.rechte_kurz_send_messages()),
        z(Perm.MANAGE_MESSAGES, m.rechte_label_manage_messages(), m.rechte_kurz_manage_messages(), 'weitreichend'),
        z(Perm.ATTACH_FILES, m.rechte_label_attach_files(), m.rechte_kurz_attach_files()),
        z(Perm.ADD_REACTIONS, m.rechte_label_add_reactions(), m.rechte_kurz_add_reactions()),
        z(Perm.MENTION_EVERYONE, m.rechte_label_mention_everyone(), m.rechte_kurz_mention_everyone())
      ]
    },
    {
      titel: m.rechte_bereich_sprache_bild(),
      zeilen: [
        z(Perm.CONNECT, m.rechte_label_connect(), m.rechte_kurz_connect()),
        z(Perm.SPEAK, m.rechte_label_speak(), m.rechte_kurz_speak()),
        z(Perm.STREAM, m.rechte_label_stream(), m.rechte_kurz_stream()),
        z(Perm.USE_VIDEO, m.rechte_label_use_video(), m.rechte_kurz_use_video()),
        z(Perm.MUTE_MEMBERS, m.rechte_label_mute_members(), m.rechte_kurz_mute_members(), 'weitreichend'),
        z(Perm.DEAFEN_MEMBERS, m.rechte_label_deafen_members(), m.rechte_kurz_deafen_members(), 'weitreichend'),
        z(Perm.MOVE_MEMBERS, m.rechte_label_move_members(), m.rechte_kurz_move_members(), 'weitreichend')
      ]
    },
    {
      // Eigener Bereich, obwohl es nur ein Eintrag ist. Das Recht erlaubt, die
      // Fernsteuerung eines anderen Mitglieds ANZUFRAGEN — es zwischen
      // „Mikrofon stummschalten" und „Kamerabild senden" zu stellen wuerde
      // seine Tragweite verwischen. Der Gesteuerte stimmt jeder Sitzung
      // zusaetzlich zu; dieses Bit ist die Vorabhuerde, nicht die Erlaubnis.
      titel: m.rechte_bereich_fernsteuerung(),
      zeilen: [
        z(Perm.REMOTE_CONTROL, m.rechte_label_remote_control(), m.rechte_kurz_remote_control(), 'weitreichend')
      ]
    },
    {
      titel: m.rechte_bereich_vollmacht(),
      zeilen: [
        z(Perm.ADMINISTRATOR, m.rechte_label_administrator(), m.rechte_kurz_administrator(), 'vollmacht')
      ]
    }
  ];
}

function z(perm: Permission, label: string, kurz: string, tragweite: Tragweite = null): Rechtezeile {
  return { perm, label, kurz, tragweite };
}
