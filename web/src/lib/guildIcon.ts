import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';

/**
 * Resolve a guild ``icon_url`` for use as an ``<img src>``.
 *
 * Guild icons come back **relative** from whichever server holds the community:
 * ``/api/chat/guild-icons/<id>.webp?v=<token>`` (see chat-gateway
 * ``routes/guild_icons.py``). The web app is always served from the Cloud origin
 * (the Electron app loads ``howispulse.com`` remotely), so a bare relative URL
 * resolves against the Cloud page origin. For a **self-host** community that
 * 404s — the icon lives on the self-host, not the Cloud.
 *
 * Fix: prefix a relative URL with the OWNING server's origin (the server the
 * guild belongs to — Cloud stays Cloud, self-host → self-host). Absolute
 * ``https://`` URLs pass through untouched; anything else (``http:``,
 * ``data:``, ``javascript:``, null) → ``null`` so the caller falls back to the
 * initials avatar.
 *
 * @param url            the guild's ``icon_url`` (relative or absolute https)
 * @param serverHostname the owning server's origin (``server.hostname``,
 *                       e.g. ``https://pulse.unicutmedia.com``); falls back to
 *                       the Cloud origin when not given.
 */
export function guildIconSrc(
  url: string | null | undefined,
  serverHostname?: string | null,
): string | null {
  if (!url) return null;
  if (url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `${serverHostname || CLOUD_HOSTNAME}${url}`;
  return null;
}
