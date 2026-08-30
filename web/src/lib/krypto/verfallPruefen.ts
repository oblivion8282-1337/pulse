/**
 * Die Anbindung des Verfalls-Signals an Netz, IndexedDB und Oberflaeche — die
 * Entscheidung selbst steht importfrei nebenan (`geraeteVerfall.ts`) und ist
 * dort geprueft.
 *
 * Hier passiert nur Verkabelung, und zwar bewusst so wenig wie moeglich: was
 * in dieser Datei steht, sieht Nodes Testlaeufer nie (sie importiert die
 * Krypto-Schalter, den Zertifikatsspeicher und den IndexedDB-Zugriff).
 */
import { toast } from 'svelte-sonner';

import { keysApi } from '../api/keys';
import { serversStore } from '../api/servers.svelte';
import { certStore } from '../identity/cert.svelte';
import { verlaufAllesLoeschen } from '../verlauf/db';
import { m } from '$lib/paraglide/messages.js';
import { geraeteKennung } from './geraeteKennung';
import { verfallAbarbeiten } from './geraeteVerfall';
import { E2E_DMS_ENABLED } from './schalter';

/** Einmal je Seitenaufruf genuegt: „beim naechsten Oeffnen" heisst genau das.
 *  Ein Modul-`let` und kein `$state` — dieser Merker gehoert keiner Ansicht.
 *
 *  Er ist zugleich die Wache gegen den einen gefaehrlichen Wiedereintritt:
 *  `veroeffentlicheSchluessel()` laeuft auch mitten im Kopplungsvorgang
 *  (`kopplung/empfangen.ts`), und dort wird gleich danach ein frisch
 *  uebernommener Verlauf geschrieben. Ein zweiter Lauf koennte den nicht
 *  loeschen — die Einloesung hat den Grabstein schon aufgehoben —, aber die
 *  Reihenfolge zweier Antworten muss man dann nachrechnen, statt sie
 *  auszuschliessen. */
let schonGeprueft = false;

/**
 * Prueft beim Start, ob dieses Geraet verfallen ist, und loescht in diesem
 * Fall den lokalen Verlauf (Spec §3a, Punkt 2).
 *
 * **Bei ausgeschaltetem `E2E_DMS_ENABLED` passiert gar nichts** — kein
 * Serveraufruf, kein Loeschen. Ohne den Schalter gibt es keinen
 * verschluesselten Verlauf, den zu loeschen sich lohnte, und der Zweig muss
 * jederzeit landbar bleiben.
 *
 * Wirft nie: der Aufrufer ist der Anmeldeweg, und ein Geraet, dessen
 * Statusabfrage scheitert, soll sich normal anmelden koennen. Ein Fehlschlag
 * loescht ohnehin nichts (s. `geraeteVerfall.ts`).
 */
export async function verfallPruefen(): Promise<void> {
  if (!E2E_DMS_ENABLED) return;
  if (schonGeprueft) return;
  // Das Zertifikat steht hier nur noch fuer „ueberhaupt angemeldet?" — nach
  // welcher Kennung gefragt wird, sagt `geraeteKennung()` (s. dort).
  if (!certStore.cert) return;
  schonGeprueft = true;
  const kennung = await geraeteKennung();

  // Dieselbe Cloud-Route wie jeder andere Schluessel-Aufruf (DMs sind heute
  // cloud-only, s. `api/keys.ts`-Modulkopf).
  await verfallAbarbeiten(
    () => keysApi.geraetestand(kennung, { serverId: serversStore.cloudId() }),
    verlaufAllesLoeschen,
    () => toast.warning(m.kopplung_verfallen_hinweis(), { duration: 15000 })
  );
}
