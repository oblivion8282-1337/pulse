/**
 * Symbol, Beschriftung und Zahl je Bereich — einmal für beide Leisten.
 *
 * Handy-Leiste und Tablet-Spalte zeigen dieselben vier Bereiche mit denselben
 * Symbolen, denselben Wörtern und denselben Zahlen; nur die Anordnung
 * unterscheidet sich. Stünde das in beiden Komponenten, liefe es auseinander,
 * sobald jemand ein Symbol tauscht — und zwar unbemerkt, weil man nie beide
 * Größen gleichzeitig vor sich hat.
 */
import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
import UsersIcon from '@lucide/svelte/icons/users';
import UserIcon from '@lucide/svelte/icons/user';
import type { TabId } from '$lib/navigation/tabs';
import { ungeleseneChats, offeneAnfragen } from '$lib/navigation/abzeichen.svelte';
import { m } from '$lib/paraglide/messages.js';

export const SYMBOLE = {
  chats: MessageCircleIcon,
  rooms: LayoutGridIcon,
  friends: UsersIcon,
  me: UserIcon
} as const;

export function beschriftung(id: TabId): string {
  return id === 'chats'
    ? m.nav_tab_chats()
    : id === 'rooms'
      ? m.nav_tab_rooms()
      : id === 'friends'
        ? m.nav_tab_friends()
        : m.nav_tab_me();
}

/**
 * Die Zahl am Bereich — nur Chats und Freunde tragen eine. Räume bewusst
 * nicht: dort steckt Ungelesenes je Community und je Kanal, eine
 * zusammengezählte Zahl an der Leiste sagte nur „irgendwo ist etwas" und
 * führte nirgendwohin.
 */
export function zahlFuer(id: TabId): number {
  if (id === 'chats') return ungeleseneChats();
  if (id === 'friends') return offeneAnfragen();
  return 0;
}

export function zahlBeschriftung(id: TabId, n: number): string {
  return id === 'friends'
    ? m.nav_tab_requests_badge({ count: n })
    : m.nav_tab_unread_badge({ count: n });
}
