/**
 * Startpunkte beim Anlegen einer Rolle.
 *
 * Warum es die gibt: wer mit einer leeren Rolle anfaengt, sucht sich die
 * Bits einzeln zusammen — und greift am Ende doch zu ADMINISTRATOR oder
 * kopiert die maechtigste vorhandene Rolle, weil das schneller geht. Ein
 * benannter Startpunkt mit SICHTBAREM Rechtesatz nimmt dem den Anlass.
 *
 * Die Saetze sind bewusst schmal gehalten: was fehlt, laesst sich in zwei
 * Klicks nachlegen; was zu viel drin steht, faellt niemandem auf.
 */

import { Perm, toBitfield, type Permission } from '$lib/permissions/bitfield';
import { m } from '$lib/paraglide/messages.js';
import { rechtekatalog } from './rechtekatalog';

export type Vorlage = {
  id: 'moderation' | 'mitglied' | 'nurlesen';
  name: string;
  bits: Permission[];
};

export function vorlagen(): Vorlage[] {
  return [
    {
      id: 'moderation',
      name: m.rollen_vorlage_moderation(),
      bits: [
        Perm.VIEW_CHANNEL,
        Perm.READ_HISTORY,
        Perm.SEND_MESSAGES,
        Perm.MANAGE_MESSAGES,
        Perm.KICK_MEMBERS,
        Perm.BAN_MEMBERS,
        Perm.MANAGE_NICKNAMES,
        Perm.MUTE_MEMBERS,
        Perm.DEAFEN_MEMBERS,
        Perm.MOVE_MEMBERS
      ]
    },
    {
      id: 'mitglied',
      name: m.rollen_vorlage_mitglied(),
      bits: [
        Perm.VIEW_CHANNEL,
        Perm.READ_HISTORY,
        Perm.SEND_MESSAGES,
        Perm.ATTACH_FILES,
        Perm.ADD_REACTIONS,
        Perm.CHANGE_NICKNAME,
        Perm.CREATE_INVITES,
        Perm.CONNECT,
        Perm.SPEAK,
        Perm.STREAM,
        Perm.USE_VIDEO
      ]
    },
    {
      id: 'nurlesen',
      name: m.rollen_vorlage_nurlesen(),
      bits: [Perm.VIEW_CHANNEL, Perm.READ_HISTORY]
    }
  ];
}

/** Ein Rechtesatz, beschnitten auf das, was der Bearbeiter selbst haelt.
 *
 * Ohne das Beschneiden gingen Bits mit, die der Server nach
 * `assert_overwrite_within_editor_scope` ablehnt — die Rolle entstuende
 * gar nicht, und der Nutzer saehe nur eine Fehlermeldung ohne Bezug zu
 * dem, was er angeklickt hat. Beschnitten entsteht sie, nur eben
 * schmaler; das ist die freundlichere Halbwahrheit. Gilt fuer Vorlagen
 * wie fuers Duplizieren. */
export function beschnitten(rechte: string, editorPermissions: string): string {
  return (toBitfield(rechte) & toBitfield(editorPermissions)).toString();
}

/** Bits einer Vorlage als Wire-String, beschnitten wie oben. */
export function bitsAlsString(bits: Permission[], editorPermissions: string): string {
  return beschnitten(vereinigt(bits).toString(), editorPermissions);
}

/** Wird eine Vorlage durch die Rechte des Bearbeiters beschnitten? Dann
 * sagt die Bedienoberflaeche das an, statt still weniger zu liefern. */
export function wirdBeschnitten(bits: Permission[], editorPermissions: string): boolean {
  return (vereinigt(bits) & ~toBitfield(editorPermissions)) !== 0n;
}

function vereinigt(bits: Permission[]): bigint {
  let wert = 0n;
  for (const b of bits) wert |= b;
  return wert;
}

/** Die Rechtenamen einer Vorlage, in Katalog-Reihenfolge — damit die
 * Aufzaehlung unter dem Vorlagennamen dieselbe Sprache spricht wie die
 * Schalterliste daneben. */
export function namenDerBits(bits: Permission[]): string[] {
  const gesucht = new Set(bits);
  const namen: string[] = [];
  // Ueber den Katalog gelaufen, nicht ueber `bits`: die Reihenfolge soll die
  // des Katalogs sein. Ein Bit ohne Katalogeintrag faellt dabei weg — das
  // kann nicht vorkommen, solange die Vorlagen aus `Perm` gebaut werden.
  for (const bereich of rechtekatalog()) {
    for (const zeile of bereich.zeilen) {
      if (gesucht.has(zeile.perm)) namen.push(zeile.label);
    }
  }
  return namen;
}
