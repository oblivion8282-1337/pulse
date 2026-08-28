/**
 * Das verschluesselte Postfach — REST-Client.
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/postfach.py` +
 * `routes/postfach_abholen.py` + `schemas.py` (Abschnitte „Postfach"). Bearer-
 * Auth wie jede andere chat-gateway-Route (`request()` aus `./client`); die
 * Cert+Unterschrift in `cert`/`signatur` ist ein ZUSAETZLICHER Nachweis, WER
 * das Geraet ist — kein Ersatz fuer den Bearer.
 *
 * Die Rumpf-Typen tragen deshalb die Feldnamen der Leitung (`channel_id`,
 * `zustellung_ids`) und werden unveraendert durchgereicht: eine Umbenennung
 * an dieser Grenze waere eine zweite Stelle, an der ein Feld falsch heissen
 * kann, ohne dass es der Uebersetzer merkt.
 */

import { request } from './client';

export interface PostfachNutzlast {
  /** 0 = Sitzungsaufbau (Olm-PreKey), 1 = laufende Nachricht — die Zaehlung
   *  des Krypto-Kerns (`Umschlagart::aus_zahl`, `krypto/pulse-krypto`), nicht
   *  frei gewaehlt. */
  art: number;
  /** Base64. */
  daten: string;
  /** Geraete-Pubkeys, fuer die diese Nutzlast verschluesselt wurde. */
  empfaenger: string[];
}

export interface PostfachZustellung {
  id: string;
  channel_id: string;
  absender_device_pubkey: string;
  /** Fuer einen frischen Sitzungsaufbau noetig — `null`, wenn das
   *  einliefernde Geraet beim Einliefern kein Buendel veroeffentlicht
   *  hatte. */
  absender_curve25519: string | null;
  /** Vom Server hergeleitet (join `DeviceKeyBundle` ueber
   *  `absender_device_pubkey`) — der Klient kennt zu einer Zustellung nur
   *  den Kanal, und eine verschluesselte DM liefert auch an die EIGENEN
   *  anderen Geraete des Senders aus, sodass "der andere Kanal-Teilnehmer"
   *  in diesem Fall falsch waere. `null`, wenn sich das Sendegeraet
   *  zwischen Einliefern und Abholen abgemeldet hat — dann bleibt nur der
   *  Kanal-Gegenpart als Rueckfall (s. `krypto/empfangen.ts`). */
  absender_user_id: string | null;
  /** Wie `PostfachNutzlast.art`. */
  art: number;
  /** Base64. */
  daten: string;
  groesse: number;
}

export const postfachApi = {
  /** Liefert einen oder mehrere Umschlaege in einem DM-Kanal ein. */
  einliefern(body: {
    channel_id: string;
    cert: string;
    signatur: string;
    nutzlasten: PostfachNutzlast[];
  }): Promise<void> {
    return request<void>('/postfach', { method: 'POST', body });
  },

  /** Holt die offenen Zustellungen des nachgewiesenen Geraets ab. Loescht
   *  nichts — erst `quittieren` raeumt auf. */
  abholen(body: { cert: string; signatur: string }): Promise<PostfachZustellung[]> {
    return request<PostfachZustellung[]>('/postfach/abholen', { method: 'POST', body });
  },

  /** Loescht die genannten Zustellungen des nachgewiesenen Geraets — erst
   *  aufrufen, NACHDEM die Umschlaege lokal sicher abgelegt sind (s.
   *  `empfangen.ts`). */
  quittieren(body: { cert: string; signatur: string; zustellung_ids: string[] }): Promise<void> {
    return request<void>('/postfach/quittung', { method: 'POST', body });
  }
};
