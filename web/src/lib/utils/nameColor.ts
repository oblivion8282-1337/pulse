/**
 * Namensfarben-Auflösung: Rollenfarbe (höchste position mit Farbe) gewinnt,
 * sonst die Profilfarbe des Users (Profileinstellungen → `profile_color`).
 *
 * Reine Lese-Helfer über reaktive Stores — in `$derived` / Templates aufrufen,
 * dann aktualisiert sich die Farbe live (Role-Edit, Profil-Save, Cache-Fetch).
 */
import { userCache } from '$lib/stores/users.svelte';
import { memberRoles } from '$lib/stores/memberRoles.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { currentServerUserId } from '$lib/stores/currentServerUser';

/** Nur Hex-Farben durchlassen (#rgb/#rgba/#rrggbb/#rrggbbaa). Der Wert landet
 *  in `style="color: …"` — alles andere (insbesondere Strings mit `;`) könnte
 *  dort zusätzliche CSS-Deklarationen einschleusen. Backend validiert beim
 *  Schreiben dasselbe Muster; das hier schützt vor Alt-Daten/fremden Servern. */
export function sanitizeProfileColor(c: string | null | undefined): string | null {
  if (!c) return null;
  return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c) ? c : null;
}

/** Rollenfarbe des Users in einer Guild als `#rrggbb`, oder null. */
export function roleNameColor(guildId: string, userId: string): string | null {
  const ids = memberRoles.for(guildId, userId);
  const top = roles.topColorRole(guildId, ids);
  if (!top) return null;
  return '#' + top.color.toString(16).padStart(6, '0');
}

/** Komplette Auflösung: Rollenfarbe (wenn `guildId`) → Profilfarbe.
 *  Für den eigenen User kommt die Profilfarbe aus `auth.user` (sofort aktuell
 *  nach einem Settings-Save), sonst aus dem `userCache`. */
export function nameColor(userId: string, guildId?: string | null): string | null {
  if (guildId) {
    const fromRole = roleNameColor(guildId, userId);
    if (fromRole) return fromRole;
  }
  if (auth.user && (userId === auth.user.id || userId === currentServerUserId())) {
    return sanitizeProfileColor(auth.user.profile_color);
  }
  return sanitizeProfileColor(userCache.get(userId)?.profile_color);
}
