/**
 * Das Geraete-Schluesselverzeichnis — REST-Client.
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/schluessel.py` +
 * `schemas.py` (Abschnitt "Geraete-Schluesselverzeichnis"). Bearer-Auth wie
 * jede andere chat-gateway-Route (`request()` aus `./client`, nicht die
 * Cookie-Auth der Identity-Plane) — die Cert+Unterschrift in `cert`/`signatur`
 * ist ein ZUSAETZLICHER Nachweis, kein Ersatz fuer den Bearer.
 */

import { request } from './client';

export interface GeraeteSchluessel {
  device_pubkey: string;
  curve25519: string;
  signatur: string;
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
}

export const keysApi = {
  /** Legt das Buendel des anfragenden Geraets an oder ersetzt es. */
  publishBundle(body: {
    cert: string;
    signatur: string;
    curve25519: string;
    rueckfallschluessel?: string | null;
  }): Promise<void> {
    return request<void>('/keys/bundle', { method: 'PUT', body });
  },

  /** Haengt einen Batch Einmalschluessel an das Buendel des Geraets an. */
  addOneTimeKeys(body: { cert: string; signatur: string; schluessel: string[] }): Promise<void> {
    return request<void>('/keys/onetime', { method: 'POST', body });
  },

  /** Liest den Vorrat des angemeldeten Kontos fuer EIN Geraet. */
  oneTimeKeyCount(devicePubkey: string): Promise<{ vorrat: number }> {
    return request<{ vorrat: number }>(
      `/keys/onetime/count?device_pubkey=${encodeURIComponent(devicePubkey)}`
    );
  },

  /** Holt die Buendel aller Geraete jedes angefragten Nutzers ab. */
  claim(userIds: string[]): Promise<Record<string, GeraeteSchluessel[]>> {
    return request<Record<string, GeraeteSchluessel[]>>('/keys/claim', {
      method: 'POST',
      body: { user_ids: userIds }
    });
  }
};
