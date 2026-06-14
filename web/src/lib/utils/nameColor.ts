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

/** Schwarz oder Weiß — je nachdem, was auf `hex` als Hintergrund besser lesbar
 *  ist (für Avatar-Initialen auf der Namensfarbe). Weiß-Default bei Müll. */
export function idealTextColor(hex: string | null | undefined): string {
  const c = sanitizeProfileColor(hex);
  if (!c) return '#fff';
  let h = c.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  if (h.length < 6) return '#fff';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Perzeptive Helligkeit (sRGB-Gewichte). > 0.6 ≈ "helle" Farbe → dunkler Text.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0a0a0a' : '#fff';
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
