/**
 * `ChatView` erwartet ein `Channel`-foermiges Objekt; eine DM/private Gruppe
 * hat aber keinen echten Kanal-Datensatz. Herausgeloest aus
 * `routes/app/@me/[[dmChannelId]]/+page.svelte`, damit die Seite unter der
 * harten Groessen-Grenze bleibt — reine Rechnung, keine Laufzeit-Abhaengigkeit.
 *
 * `guild_id` bleibt leer; die Seite gibt `showMemberList={false}` mit, damit
 * dafuer nirgends eine Mitgliederliste nachgeschlagen wird.
 */
import type { Channel, DMChannel } from '$lib/api/types';

export interface SynthGruppe {
  id: string;
  name: string;
  created_at: string;
}

export function synthKanal(id: string, name: string, erstelltAm: string): Channel {
  return { id, guild_id: '', name, type: 0, position: 0, topic: null, created_at: erstelltAm };
}

/**
 * Eine DM hat noch keinen Anzeigenamen im Datensatz selbst (der steckt in
 * `userCache`) — deshalb der `displayName`-Zugriff als Parameter statt eines
 * direkten Store-Imports. Eine Gruppe traegt ihren Namen bereits selbst.
 */
export function berechneSynthChannel(
  activeDM: DMChannel | undefined,
  aktiveGruppe: SynthGruppe | undefined,
  displayName: (userId: string) => string
): Channel | null {
  if (activeDM) {
    return synthKanal(activeDM.id, displayName(activeDM.other_user_id), activeDM.created_at);
  }
  if (aktiveGruppe) {
    return synthKanal(aktiveGruppe.id, aktiveGruppe.name, aktiveGruppe.created_at);
  }
  return null;
}
