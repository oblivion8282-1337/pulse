/**
 * Heim-Server läuft / läuft nicht / heißt jetzt so (`instance_status`, von
 * auth-svc über `user:events`, 2026-10-08).
 *
 * **Nur von der Cloud-Verbindung.** Das Ereignis benennt beliebige Instanzen
 * per ID — ein Self-Host, der es selbst schickte, könnte sonst fremde Server
 * in der Leiste umbenennen oder ausblenden. `dispatchingIsCloud()` weist alles
 * andere ab.
 *
 * Geht ein Server offline, während man auf ihm ist, wechselt die App auf die
 * Cloud — er verschwindet ja gerade aus der Leiste (Muster wie beim Entfernen,
 * `api/server-removal.ts`).
 */
import { serversStore } from '$lib/api/servers.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { appHostAnwesenheit } from '$lib/stores/appHostAnwesenheit.svelte';
import { dispatchingIsCloud } from '$lib/ws/gateway-connection';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('instance_status', (evt) => {
    if (!dispatchingIsCloud()) return;
    const { instance_id, online, anzeigename } = evt.data;
    const eintrag = serversStore.setzeInstanzStatus(instance_id, { online, anzeigename });
    // Die Direkt-Weichen fragen den Anwesenheits-Store — ihn mitziehen, damit
    // ein gerade gestarteter Server nicht bis zum nächsten Takt als schlafend
    // gilt (und umgekehrt).
    appHostAnwesenheit.vermerke(instance_id, !online);
    if (!online && eintrag && activeServer.serverId === eintrag.id) {
      const cloud = serversStore.servers.find((s) => s.isCloud);
      if (cloud) activeServer.set(cloud.id);
    }
  });
}
