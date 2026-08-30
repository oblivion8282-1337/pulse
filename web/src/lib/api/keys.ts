/**
 * Das Geraete-Schluesselverzeichnis — REST-Client.
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/schluessel.py` +
 * `schemas.py` (Abschnitt "Geraete-Schluesselverzeichnis"). Bearer-Auth wie
 * jede andere chat-gateway-Route (`request()` aus `./client`, nicht die
 * Cookie-Auth der Identity-Plane). `device_pubkey` sagt zusaetzlich, WELCHES
 * Geraet des Kontos handelt — der Server haelt es gegen die eigene
 * Geraeteliste (`schluessel_nachweis.py`), es ersetzt den Bearer nicht.
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
  einmalschluessel: string | null;
  rueckfallschluessel: string | null;
  /** Ob dieses Geraet dauerhaft ist (Electron- oder Android-App) — Grundlage
   *  der Koexistenz-Regel (Spec §3, `krypto/empfaengerGeraete.ts`). Optional,
   *  solange das Backend das Feld nicht fuehrt. */
  dauerhaft?: boolean;
  /** Ob dieses Geraet per Kopplungscode gebunden wurde (Spec §3a) — zaehlt
   *  fuer dieselbe Regel wie `dauerhaft`, verfaellt aber nach 14 Tagen ohne
   *  Benutzung. Ebenfalls optional. */
  gekoppelt?: boolean;
}

/** Eine Zeile der EIGENEN Geraeteliste (`GET /keys/geraete`). Spiegel von
 *  `schemas.py::EigenesGeraetOut` — dort steht auch, warum es kein
 *  Namensfeld gibt. */
export interface EigenesGeraet {
  device_pubkey: string;
  dauerhaft: boolean;
  gekoppelt_am: string | null;
  hinzugefuegt_am: string;
  zuletzt_benutzt: string;
  /** Vom Server aus derselben Regel berechnet wie `GET /keys/geraetestand` —
   *  der Klient rechnet den Verfall nicht nach. */
  verfallen: boolean;
}

export const keysApi = {
  /** Legt das Buendel des anfragenden Geraets an oder ersetzt es. */
  publishBundle(
    body: {
      device_pubkey: string;
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
    body: { device_pubkey: string; schluessel: string[] },
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

  /** Die eigene Geraeteliste — wer liest bei mir mit
   *  (`routes/geraete.py`). Ohne Geraeteangabe: welche Zeile „ich selbst"
   *  ist, entscheidet der Klient durch Vergleich mit `geraeteKennung()`; der
   *  Server weiss es nicht und duerfte danach auch nicht fragen, weil eine
   *  Geraeteangabe `zuletzt_benutzt` auffrischt. */
  geraete(route: { serverId?: string } = {}): Promise<EigenesGeraet[]> {
    return request<EigenesGeraet[]>('/keys/geraete', {}, route);
  },

  /** Wirft ein Geraet aus dem eigenen Konto (`routes/geraete.py`). Ab sofort
   *  kein Empfaenger mehr und ohne Zugriff aufs Postfach; das Geraet erfaehrt
   *  es beim naechsten `geraetestand` und loescht daraufhin seinen lokalen
   *  Verlauf. 404, wenn das Konto kein solches Geraet fuehrt. */
  geraetEntfernen(devicePubkey: string, route: { serverId?: string } = {}): Promise<void> {
    return request<void>(
      `/keys/geraete?device_pubkey=${encodeURIComponent(devicePubkey)}`,
      { method: 'DELETE' },
      route
    );
  },

  /** Der Stand des EIGENEN Geraets: `gueltig` | `verfallen` | `entfernt` |
   *  `unbekannt` (`routes/schluessel_auskunft.py::geraetestand`). Ohne
   *  Geraete-Nachweis — ein Nachweis waere selbst eine Benutzung und hoebe
   *  damit die Frage auf, die er stellt. Nur `verfallen` und `entfernt`
   *  duerfen etwas ausloesen, s. `krypto/geraeteVerfall.ts`. */
  geraetestand(
    devicePubkey: string,
    route: { serverId?: string } = {}
  ): Promise<{ stand: string }> {
    return request<{ stand: string }>(
      `/keys/geraetestand?device_pubkey=${encodeURIComponent(devicePubkey)}`,
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
