/**
 * Das Geraete-Schluesselverzeichnis — REST-Client.
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/schluessel.py` +
 * `schemas.py` (Abschnitt "Geraete-Schluesselverzeichnis"). Bearer-Auth wie
 * jede andere chat-gateway-Route (`request()` aus `./client`, nicht die
 * Cookie-Auth der Identity-Plane) — die Cert+Unterschrift in `cert`/`signatur`
 * ist ein ZUSAETZLICHER Nachweis, kein Ersatz fuer den Bearer.
 *
 * **`route` (optional, jede Funktion):** DMs sind heute cloud-only
 * (Global-Friends Stufe 1) — ohne diesen Parameter faellt `request()` auf
 * `activeServer.current` zurueck, also den zuletzt gewaehlten Self-Host, und
 * eine Schluessel-Veroeffentlichung/-Abholung liefe dort gegen ein
 * Verzeichnis, das den Empfaenger gar nicht kennt (Bughunt 2026-08-28,
 * FIX 4). Aufrufer aus dem DM-Weg uebergeben deshalb `{serverId:
 * serversStore.cloudId()}` — dasselbe Muster wie `chatApi.*` im DM-Klienten
 * (`+page.svelte::cloudRoute`).
 */

import { request } from './client';

export interface GeraeteSchluessel {
  device_pubkey: string;
  curve25519: string;
  signatur: string;
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
  /** Ob dieses Geraet dauerhaft ist (Electron- oder Android-App) — Grundlage
   *  der Koexistenz-Regel (Spec §3, `krypto/empfaengerGeraete.ts`). Optional,
   *  solange das Backend das Feld nicht fuehrt. */
  dauerhaft?: boolean;
}

export const keysApi = {
  /** Legt das Buendel des anfragenden Geraets an oder ersetzt es. */
  publishBundle(
    body: {
      cert: string;
      signatur: string;
      curve25519: string;
      rueckfallschluessel?: string | null;
      dauerhaft: boolean;
    },
    route: { serverId?: string } = {}
  ): Promise<void> {
    return request<void>('/keys/bundle', { method: 'PUT', body }, route);
  },

  /** Haengt einen Batch Einmalschluessel an das Buendel des Geraets an. */
  addOneTimeKeys(
    body: { cert: string; signatur: string; schluessel: string[] },
    route: { serverId?: string } = {}
  ): Promise<void> {
    return request<void>('/keys/onetime', { method: 'POST', body }, route);
  },

  /** Liest den Vorrat des angemeldeten Kontos fuer EIN Geraet. */
  oneTimeKeyCount(
    devicePubkey: string,
    route: { serverId?: string } = {}
  ): Promise<{ vorrat: number }> {
    return request<{ vorrat: number }>(
      `/keys/onetime/count?device_pubkey=${encodeURIComponent(devicePubkey)}`,
      {},
      route
    );
  },

  /** Ob ein Gespraech mit diesem Konto verschluesselt laufen kann — reine
   *  Auskunft, die KEINEN Einmalschluessel verbraucht (im Unterschied zu
   *  `claim`, s. `routes/schluessel_auskunft.py`). Fehlende Berechtigung
   *  ergibt `false`, keine 403. */
  verschluesselbar(
    userId: string,
    route: { serverId?: string } = {}
  ): Promise<{ verschluesselbar: boolean }> {
    return request<{ verschluesselbar: boolean }>(
      `/keys/verschluesselbar/${encodeURIComponent(userId)}`,
      {},
      route
    );
  },

  /** Holt die Buendel aller Geraete jedes angefragten Nutzers ab. */
  claim(
    userIds: string[],
    route: { serverId?: string } = {}
  ): Promise<Record<string, GeraeteSchluessel[]>> {
    return request<Record<string, GeraeteSchluessel[]>>(
      '/keys/claim',
      { method: 'POST', body: { user_ids: userIds } },
      route
    );
  }
};
