/**
 * Anzeigetext je Probe-Schritt (`probe.ts::ProbeSchritt`) — reiner
 * Anzeigetext, deshalb hier und nicht im rechnenden `probe.ts` (dessen
 * Kopf verspricht "ohne Laufzeit-Importe"). Gemeinsam fuer
 * `AblageVerbindenDialog.svelte` und `NextcloudVerbinden.svelte`, die beide
 * denselben Probe-Fehler in Prosa uebersetzen.
 */
import type { ProbeSchritt } from './probe.ts';

export const SCHRITT_TEXT: Record<ProbeSchritt, string> = {
  schreiben: 'Schreiben',
  lesen: 'Lesen',
  vergleichen: 'Vergleichen',
  loeschen: 'Löschen',
};
