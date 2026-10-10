// Deep-Link `pulse://invite?code=…[&host=…]` aus dem Browser in die
// Desktop-App. Die App prüft den Link in main (deeplink.ts) und reicht
// {hostname, code} herüber. Vorher trat der Renderer sofort bei und schrieb
// einen Fehlschlag nur in die Konsole — war die App nicht angemeldet, passierte
// für den Nutzer schlicht nichts.
//
// Jetzt: angemeldet und in /app → Dialog an der aktuellen Adresse. Sonst
// merken; der Dialog im App-Layout greift die Einladung nach dem Login auf.
import { goto } from '$app/navigation';
import { auth } from '$lib/stores/auth.svelte';
import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import { istGueltigerCode, mitEinladung, zielHost } from './einladungsLink';
import { browserSpeicher, einladungMerken } from './gemerkt';

export function einladungAusDeepLink(data: { hostname: string; code: string }): void {
  // '' = Cloud (Etappe 3); der Cloud-Hostname selbst ebenfalls (zielHost).
  const host = zielHost(data.hostname || null, CLOUD_HOSTNAME);
  if (host === undefined || !istGueltigerCode(data.code)) return;
  const e = { code: data.code, host };
  const bereit = !!auth.user && !auth.user.email_verification_pending;
  if (bereit && window.location.pathname.startsWith('/app')) {
    void goto(mitEinladung(window.location.pathname + window.location.search, e), {
      noScroll: true,
      keepFocus: true
    });
    return;
  }
  einladungMerken(browserSpeicher(), e, Date.now());
  if (bereit) void goto('/app');
}
