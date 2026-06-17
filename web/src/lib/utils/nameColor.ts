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
  const [c1] = profileColors(userId);
  return c1;
}

/** Beide Profilfarben des Users (primär, sekundär) als sanitisierte Hex-Werte
 *  oder null. Eigener User aus `auth.user` (sofort aktuell), sonst userCache. */
function profileColors(userId: string): [string | null, string | null] {
  const u = profileSource(userId);
  return [
    sanitizeProfileColor(u?.profile_color),
    sanitizeProfileColor(u?.profile_color_secondary)
  ];
}

/** Profil-Quelle für einen User: eigener aus `auth.user` (sofort aktuell nach
 *  Settings-Save), sonst aus dem userCache. */
function profileSource(userId: string) {
  return auth.user && (userId === auth.user.id || userId === currentServerUserId())
    ? auth.user
    : userCache.get(userId);
}

/** Verlaufs-Richtung des Users als gültiger CSS-Winkel (ganze Grad 0–360).
 *  Default 90° (links→rechts) bei fehlendem/ungültigem Wert. */
export const DEFAULT_GRADIENT_ANGLE = 90;
export function gradientAngle(userId: string): number {
  return sanitizeGradientAngle(profileSource(userId)?.profile_gradient_angle);
}

/** Auf eine ganze Zahl 0–360 klemmen; Müll → Default. Der Wert landet in
 *  `linear-gradient(<n>deg, …)` — nur eine Zahl ist CSS-injection-sicher. */
export function sanitizeGradientAngle(a: number | null | undefined): number {
  if (typeof a !== 'number' || !Number.isFinite(a)) return DEFAULT_GRADIENT_ANGLE;
  return Math.min(360, Math.max(0, Math.round(a)));
}

/** Inline-`style`, das Text als Farb-Verlauf rendert (background-clip: text).
 *  Zentral, damit Render-Pfad und Settings-Vorschau identisch aussehen. */
export function gradientTextStyle(c1: string, c2: string, angle: number): string {
  return (
    `background-image: linear-gradient(${sanitizeGradientAngle(angle)}deg, ${c1}, ${c2}); ` +
    `-webkit-background-clip: text; background-clip: text; ` +
    `color: transparent; -webkit-text-fill-color: transparent;`
  );
}

/** Komplettes Inline-`style` für einen Namen — fertig für `style={…}`:
 *  - Rollenfarbe (wenn `guildId`) gewinnt und ist immer EINFARBIG.
 *  - sonst zwei Profilfarben → Text-Verlauf (background-clip: text).
 *  - sonst eine Profilfarbe → einfarbig.
 *  - sonst leerer String (Default-Textfarbe).
 *  Reaktiv: in `$derived`/Templates aufrufen. */
export function nameStyle(userId: string, guildId?: string | null): string {
  if (guildId) {
    const fromRole = roleNameColor(guildId, userId);
    if (fromRole) return `color: ${fromRole}`;
  }
  const [c1, c2] = profileColors(userId);
  if (c1 && c2) {
    return gradientTextStyle(c1, c2, gradientAngle(userId));
  }
  if (c1) return `color: ${c1}`;
  return '';
}

/** Inline `style` for a channel name from its stored styling fields:
 *  two colors → gradient; one → solid; none → '' (default text color).
 *  Same sanitizers/helper as usernames, so editor preview == real render. */
export function channelNameStyle(channel: {
  name_color?: string | null;
  name_color_secondary?: string | null;
  name_gradient_angle?: number | null;
}): string {
  const c1 = sanitizeProfileColor(channel.name_color);
  const c2 = sanitizeProfileColor(channel.name_color_secondary);
  if (c1 && c2) return gradientTextStyle(c1, c2, sanitizeGradientAngle(channel.name_gradient_angle));
  if (c1) return `color: ${c1}`;
  return '';
}

/** Click-to-apply palette for the name-color editor (profile + channels):
 *  a few solid accents and a few gradients. angle omitted → default 90°. */
export const NAME_STYLE_PRESETS: {
  label: string;
  color1: string;
  color2?: string;
  angle?: number;
}[] = [
  { label: 'Amber', color1: '#f59e0b' },
  { label: 'Rose', color1: '#ec4899' },
  { label: 'Emerald', color1: '#10b981' },
  { label: 'Sky', color1: '#38bdf8' },
  { label: 'Sunset', color1: '#f59e0b', color2: '#ef4444', angle: 90 },
  { label: 'Ocean', color1: '#22d3ee', color2: '#3b82f6', angle: 90 },
  { label: 'Candy', color1: '#a78bfa', color2: '#ec4899', angle: 90 },
  { label: 'Lime', color1: '#a3e635', color2: '#10b981', angle: 90 }
];
