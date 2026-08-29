/**
 * Geraete-Kopplung und Verlaufsumzug — REST-Client (Etappe F, E2E-DM).
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/kopplung.py` +
 * `kopplung_umzug.py` + `kopplung_schemas.py`. Bearer-Auth wie jede andere
 * chat-gateway-Route; `cert`/`signatur` in jedem Rumpf sind ein ZUSAETZLICHER
 * Geraete-Nachweis, kein Ersatz fuer den Bearer.
 *
 * **`route` (optional, jede Funktion) — derselbe Grund wie in `api/keys.ts`:**
 * ohne den Parameter faellt `request()` auf den zuletzt gewaehlten Server
 * zurueck, und das kann ein Self-Host sein. Die Kopplung gehoert zum
 * Cloud-Konto (dort liegen die Geraete-Zertifikate), Aufrufer uebergeben
 * deshalb `{ serverId: serversStore.cloudId() }`.
 */

import { request } from './client';

/** Jeder Rumpf traegt den Geraete-Nachweis. */
type Nachweis = { cert: string; signatur: string };

export interface KopplungStand {
  id: string;
  eingeloest: boolean;
  neu_device_pubkey: string | null;
  gesamt_stuecke: number | null;
  vorhandene_stuecke: number[];
  /** Position (als String-Schluessel, JSON kennt keine Zahlen-Keys) ->
   *  Inhalts-Kennung. Nur wo eine hinterlegt ist — s.
   *  `kopplung/transport.ts::stueckKennung`. */
  vorhandene_kennungen: Record<string, string>;
  verfaellt_am: string;
}

export const kopplungApi = {
  /** Legt eine offene Kopplung an — vom eingerichteten Geraet. */
  anlegen(
    body: Nachweis & { code_hash: string },
    route: { serverId?: string } = {}
  ): Promise<{ id: string; verfaellt_am: string }> {
    return request('/kopplung', { method: 'POST', body }, route);
  },

  /** Loest einen Code ein — vom neuen Geraet. Genau einmal moeglich. */
  einloesen(
    body: Nachweis & { code_hash: string },
    route: { serverId?: string } = {}
  ): Promise<{ id: string; alt_device_pubkey: string; verfaellt_am: string }> {
    return request('/kopplung/einloesen', { method: 'POST', body }, route);
  },

  /** Stand — von beiden Seiten. `vorhandene_stuecke` traegt die
   *  Fortsetzbarkeit. */
  stand(
    body: Nachweis & { kopplung_id: string },
    route: { serverId?: string } = {}
  ): Promise<KopplungStand> {
    return request('/kopplung/stand', { method: 'POST', body }, route);
  },

  /** Legt ein Stueck ab — vom alten Geraet, beliebig oft wiederholbar.
   *  `kennung` ist die Inhalts-Kennung fuer spaetere Fortsetzungen (s.
   *  `kopplung/transport.ts::stueckKennung`). */
  stueckAblegen(
    body: Nachweis & { kopplung_id: string; folge: number; daten: string; kennung: string },
    route: { serverId?: string } = {}
  ): Promise<void> {
    return request('/kopplung/stueck', { method: 'POST', body }, route);
  },

  /** Holt ein Stueck — vom neuen Geraet. Holen loescht nicht. */
  stueckHolen(
    body: Nachweis & { kopplung_id: string; folge: number },
    route: { serverId?: string } = {}
  ): Promise<{ folge: number; daten: string }> {
    return request('/kopplung/stueck/holen', { method: 'POST', body }, route);
  },

  /** Meldet die Gesamtzahl — erst danach ist „vollstaendig" pruefbar. */
  fertig(
    body: Nachweis & { kopplung_id: string; gesamt_stuecke: number },
    route: { serverId?: string } = {}
  ): Promise<void> {
    return request('/kopplung/fertig', { method: 'POST', body }, route);
  },

  /** Loescht Kopplung und Stuecke. Von beiden Seiten, beliebig oft. */
  abschliessen(
    body: Nachweis & { kopplung_id: string },
    route: { serverId?: string } = {}
  ): Promise<void> {
    return request('/kopplung/abschliessen', { method: 'POST', body }, route);
  }
};
