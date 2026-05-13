/** Filter avatar_url values that we trust as `<img src>`: same-origin (`/…`)
 *  or absolute https. Anything else (null, http, javascript:, data:) is
 *  rejected so the consumer falls back to the initials fallback. */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith('/') || url.startsWith('https://') ? url : null;
}
