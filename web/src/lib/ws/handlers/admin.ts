/**
 * Admin-Ereignisse der Cloud (`admin:events` → nur Admin-Sockets).
 *
 * `admin_application_pending` meldet nur, DASS ein neuer Antrag vorliegt —
 * die Liste holt der jeweilige Store danach über seinen regulären
 * Admin-Endpoint. Vorher merkte ein Admin einen neuen Antrag erst beim
 * nächsten 60-Sekunden-Poll.
 */
import { pendingAppHostApplications } from '$lib/stores/pendingAppHostApplications.svelte';
import { pendingInstanceApps } from '$lib/stores/pendingInstanceApps.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('admin_application_pending', (evt) => {
    if (evt.kind === 'app_host') pendingAppHostApplications.refresh();
    else pendingInstanceApps.refresh();
  });
}
