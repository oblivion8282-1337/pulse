/**
 * Public-API-Surface des api/-Moduls.
 *
 * Hier nur Re-Exports von Typen + Konstanten die andere Module brauchen.
 * Implementierungs-Details bleiben in den jeweiligen Dateien.
 */

export type { ServerEntry } from './servers.svelte';
export { CLOUD_HOSTNAME, CLOUD_LABEL } from './servers.svelte';
