/**
 * Der Geraete-Nachweis fuer die Kopplungsrouten (Etappe F, E2E-DM).
 *
 * Jede der sieben Routen verlangt `{ cert, signatur }` ueber einen eigenen
 * Zweck (`schluessel_nachweis.py::baue_nutzlast`). Hier steht das einmal,
 * statt siebenmal in `senden.ts` und `empfangen.ts`.
 *
 * **Wirft, wenn Geraeteschluessel oder Zertifikat fehlen.** Anders als
 * `veroeffentlichen.ts`, das bei fehlender Anmeldung still nichts tut: dort
 * ist der Aufrufer eine Hintergrund-Aufgabe, die es beim naechsten Anlauf
 * erneut versucht. Hier steht ein Mensch davor und wartet — ein stiller
 * Abbruch waere ein Umzug, der nie beginnt und nie sagt, warum.
 */
import { certStore } from '../identity/cert.svelte';
import { loadKeypair } from '../identity/keypair.svelte';
import { baueNutzlast } from '../krypto/nutzlast';
import { signiereNutzlast } from '../krypto/nachweis';

export type NachweisRumpf = { cert: string; signatur: string };

export async function nachweisFuer(zweck: string, ...teile: string[]): Promise<NachweisRumpf> {
  const keypair = await loadKeypair();
  const cert = certStore.cert;
  if (!keypair || !cert) {
    throw new Error('Kein Geraeteschluessel oder Zertifikat — nicht angemeldet?');
  }
  return {
    cert: cert.raw,
    signatur: await signiereNutzlast(keypair, baueNutzlast(zweck, ...teile))
  };
}
