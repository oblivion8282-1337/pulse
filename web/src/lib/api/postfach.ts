/**
 * Das verschluesselte Postfach — REST-Client.
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/postfach.py` +
 * `routes/postfach_abholen.py` + `schemas.py` (Abschnitte „Postfach"). Bearer-
 * Auth wie jede andere chat-gateway-Route (`request()` aus `./client`);
 * `device_pubkey` sagt zusaetzlich, WELCHES Geraet des Kontos handelt — der
 * Server haelt es gegen die eigene Geraeteliste (`schluessel_nachweis.py`)
 * und ersetzt damit den frueheren Zertifikats-Nachweis (Spec §3b).
 *
 * Die Rumpf-Typen tragen deshalb die Feldnamen der Leitung (`channel_id`,
 * `zustellung_ids`) und werden unveraendert durchgereicht: eine Umbenennung
 * an dieser Grenze waere eine zweite Stelle, an der ein Feld falsch heissen
 * kann, ohne dass es der Uebersetzer merkt.
 *
 * **`route` (optional, jede Funktion):** DMs sind heute cloud-only, s.
 * `../api/keys.ts` Modulkopf (Bughunt 2026-08-28, FIX 4) — Aufrufer aus dem
 * DM-Weg uebergeben `{serverId: serversStore.cloudId()}`.
 */

import { request } from './client';
import type { PostfachEinliefernErgebnis } from '../krypto/zustellErgebnis';

export type { PostfachEinliefernErgebnis };

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

/** Antwort von `POST /postfach/anhaenge/upload-url` (Etappe E). Wire-Form
 *  `AttachmentUploadOut` — dieselbe wie im Klartext-Weg, der Unterschied
 *  steckt im RUMPF der Anfrage (kein Name, kein Typ, keine Maße). */
export interface PostfachAnhangUpload {
  id: string;
  upload_url: string;
  thumb_upload_url?: string | null;
}

/** Antwort von `POST /postfach/anhaenge/{id}/abrufadresse` — kurzlebige
 *  signierte GET-Adressen auf die verschluesselten Klumpen. */
export interface PostfachAnhangAdresse {
  url: string;
  thumb_url?: string | null;
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
  /** Liefert einen oder mehrere Umschlaege in einem DM-Kanal ein.
   *  `undefined`, wenn der Server mit einem koerperlosen 2xx (204) antwortet
   *  — `wurdeZugestellt` (zustellErgebnis.ts) behandelt das als Erfolg, kein
   *  Fehlschlag. Ein 404 (Route existiert nicht — alter Server) wird NICHT
   *  hier abgefangen, sondern wirft weiter als `ApiError`: das ist ein
   *  eigener Fall, den der Aufrufer (`krypto/senden.ts`) unterscheidet. */
  einliefern(
    body: {
      channel_id: string;
      device_pubkey: string;
      nutzlasten: PostfachNutzlast[];
      /** Kennungen der verschluesselten Anhaenge dieser Nachricht (Etappe E).
       *  Stehen HIER und nicht je Nutzlast, weil alle Nutzlasten einer
       *  Einlieferung dieselbe Nachricht sind — nur je Empfaengergeraet
       *  verschluesselt. Weglassen = keine Anhaenge (Server-Vorgabe `[]`). */
      anhaenge?: string[];
    },
    route: { serverId?: string } = {}
  ): Promise<PostfachEinliefernErgebnis | undefined> {
    return request<PostfachEinliefernErgebnis | undefined>(
      '/postfach',
      { method: 'POST', body },
      route
    );
  },

  /** Holt die offenen Zustellungen des genannten Geraets ab. Loescht
   *  nichts — erst `quittieren` raeumt auf. */
  abholen(
    body: { device_pubkey: string },
    route: { serverId?: string } = {}
  ): Promise<PostfachZustellung[]> {
    return request<PostfachZustellung[]>('/postfach/abholen', { method: 'POST', body }, route);
  },

  /** Loescht die genannten Zustellungen des genannten Geraets — erst
   *  aufrufen, NACHDEM die Umschlaege lokal sicher abgelegt sind (s.
   *  `empfangen.ts`). */
  quittieren(
    body: { device_pubkey: string; zustellung_ids: string[] },
    route: { serverId?: string } = {}
  ): Promise<void> {
    return request<void>('/postfach/quittung', { method: 'POST', body }, route);
  },

  /**
   * Legt eine leere Anhang-Huelle an und gibt die vorsignierte(n)
   * PUT-Adresse(n) heraus (Etappe E). **Bewusst OHNE Dateiname, Typ und
   * Maße** — die neue Route nimmt sie gar nicht entgegen, und der Server legt
   * nichts davon ab. `size`/`thumb_size` sind die Groessen der
   * VERSCHLUESSELTEN Klumpen, wie sie hochgeladen werden.
   */
  anhangUploadAdresse(
    body: {
      channel_id: string;
      size: number;
      has_thumb?: boolean;
      thumb_size?: number | null;
    },
    route: { serverId?: string } = {}
  ): Promise<PostfachAnhangUpload> {
    return request<PostfachAnhangUpload>(
      '/postfach/anhaenge/upload-url',
      { method: 'POST', body },
      route
    );
  },

  /**
   * Signierte GET-Adressen fuer einen verschluesselten Anhang. Nur ein
   * Geraet mit einer OFFENEN Zustellung zu diesem Anhang bekommt sie —
   * deshalb `device_pubkey` und deshalb **vor der Quittung** rufen: mit der
   * Quittung faellt das Recht, und kurz darauf der Klumpen selbst.
   */
  anhangAdresse(
    anhangId: string,
    body: { device_pubkey: string },
    route: { serverId?: string } = {}
  ): Promise<PostfachAnhangAdresse> {
    return request<PostfachAnhangAdresse>(
      `/postfach/anhaenge/${anhangId}/abrufadresse`,
      { method: 'POST', body },
      route
    );
  }
};
