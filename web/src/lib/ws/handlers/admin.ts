/**
 * Hosting-Anträge in Echtzeit — beide Richtungen.
 *
 * `admin_application_pending` (admin:events → nur Admin-Sockets): ein neuer
 * Antrag liegt vor. `application_decided` (user:events → nur der
 * Antragsteller): der Admin hat entschieden.
 *
 * Beide Ereignisse tragen nur das Signal, keine Antragsdaten — der jeweilige
 * Store lädt seine Liste danach über den regulären REST-Endpoint nach und
 * erzeugt daraus Toast und roten Punkt. Ohne sie wartete jede Seite bis zu
 * einem Poll-Intervall (60 s bzw. 90 s).
 */
import { pendingAppHostApplications } from '$lib/stores/pendingAppHostApplications.svelte';
import { pendingInstanceApps } from '$lib/stores/pendingInstanceApps.svelte';
import { myAppHostApplications } from '$lib/stores/myAppHostApplications.svelte';
import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('admin_application_pending', (evt) => {
    if (evt.kind === 'app_host') pendingAppHostApplications.refresh();
    else pendingInstanceApps.refresh();
  });

  registerWsHandler('application_decided', (evt) => {
    if (evt.data.kind === 'app_host') myAppHostApplications.refresh();
    else myInstanceApplications.refresh();
  });
}
