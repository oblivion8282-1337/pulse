// Deep-Link `pulse://invite?code=…[&host=…]` aus dem Browser in die
// Desktop-App. Die App prüft den Link in main (deeplink.ts) und reicht
// {hostname, code} herüber. Vorher trat der Renderer sofort bei und schrieb
// einen Fehlschlag nur in die Konsole — war die App nicht angemeldet, passierte
// für den Nutzer schlicht nichts.
//
// Jetzt: angemeldet und in /app → Dialog an der aktuellen Adresse. Sonst
// merken; der Dialog im App-Layout greift die Einladung nach dem Login auf.
// Genau `/app` ist ein Durchgangszustand (die Seite leitet weiter und verwirft
// die Query): dort wird gemerkt statt über die Adresse geöffnet.
//
// Der Hauptprozess meldet einen Link bei laufender App mehrfach (7× im Abstand
// von 500 ms, gemessen); dieselbe Einladung innerhalb weniger Sekunden wird
// deshalb nur einmal bearbeitet (deepLinkWiederholung).
import { goto } from '$app/navigation';
import { auth } from '$lib/stores/auth.svelte';
import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import {
  deepLinkWeg,
  deepLinkWiederholung,
  istGueltigerCode,
  mitEinladung,
  zielHost
} from './einladungsLink';
import { EREIGNIS_GEMERKT, browserSpeicher, einladungMerken } from './gemerkt';

let zuletzt: { schluessel: string; zeit: number } | null = null;

export function einladungAusDeepLink(data: { hostname: string; code: string }): void {
  // '' = Cloud (Etappe 3); der Cloud-Hostname selbst ebenfalls (zielHost).
  const host = zielHost(data.hostname || null, CLOUD_HOSTNAME);
  if (host === undefined || !istGueltigerCode(data.code)) return;
  const schluessel = `${data.code}|${host ?? ''}`;
  if (deepLinkWiederholung(zuletzt, schluessel, Date.now())) return;
  zuletzt = { schluessel, zeit: Date.now() };
  const e = { code: data.code, host };
  const bereit = !!auth.user && !auth.user.email_verification_pending;
  const weg = deepLinkWeg(window.location.pathname, bereit);
  if (weg === 'dialog') {
    // Steht schon eine Einladung in der Adresse, ersetzen statt anhängen.
    const schonOffen = new URLSearchParams(window.location.search).has('einladung');
    void goto(mitEinladung(window.location.pathname + window.location.search, e), {
      replaceState: schonOffen,
      noScroll: true,
      keepFocus: true
    });
    return;
  }
  einladungMerken(browserSpeicher(), e, Date.now());
  window.dispatchEvent(new Event(EREIGNIS_GEMERKT));
  if (weg === 'merken-und-app') void goto('/app');
}
