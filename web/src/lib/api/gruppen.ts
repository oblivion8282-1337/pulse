/**
 * Private Gruppenkanaele — REST-Client.
 *
 * Wire-Form spiegelt `services/chat-gateway/.../routes/private_gruppen.py` +
 * `schemas.py` (`PrivateGroupOut`, `PrivateGroupCreateIn`,
 * `PrivateGroupMemberAddIn`). Die Routen liegen im Wurzel-Router ohne
 * Prefix — also `/gruppen`, nicht `/chat/gruppen`.
 *
 * **Jede Funktion ist hinter `PRIVATE_GRUPPEN_ENABLED` verriegelt** (s.
 * `krypto/schalter.ts`): bei ausgeschaltetem Schalter geht kein einziger
 * Aufruf hinaus. Der Riegel sitzt HIER und nicht bei den Aufrufern, weil
 * „nichts laeuft" sonst an jeder Aufrufstelle einzeln zu wiederholen waere —
 * und genau eine vergessene Stelle macht die Zusage kaputt. Was der Schalter
 * nicht kann, ist eine Antwort erfinden: die Funktionen liefern `null` bzw.
 * eine leere Liste, und der Aufrufer behandelt das wie „es gibt keine
 * Gruppen".
 *
 * **Cloud-only, wie DMs** — der Router traegt `CloudOnly`
 * (`routes/private_gruppen.py`), und die Gegenstellen-Schluessel liegen im
 * Cloud-Verzeichnis. Ohne die ausdrueckliche Route liefe der Aufruf gegen
 * den zuletzt gewaehlten Self-Host (`api/keys.ts`-Modulkopf, Bughunt
 * 2026-08-28 FIX 4).
 */

import { request } from './client';
import { serversStore } from './servers.svelte';
import { PRIVATE_GRUPPEN_ENABLED } from '../krypto/schalter';

export interface GruppenMitglied {
  user_id: string;
  beigetreten_am: string;
}

export interface PrivateGruppe {
  id: string;
  ersteller_id: string;
  name: string;
  created_at: string;
  last_message_id: string | null;
  members: GruppenMitglied[];
}

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

export const gruppenApi = {
  /** Alle eigenen Gruppen. Leer, solange der Schalter aus ist. */
  auflisten(): Promise<PrivateGruppe[]> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve([]);
    return request<PrivateGruppe[]>('/gruppen', {}, cloudRoute());
  },

  /**
   * EINE Gruppe frisch vom Server.
   *
   * **Das ist der Aufruf, an dem die Aussperrung haengt.** Der Sendeweg ruft
   * ihn unmittelbar vor jeder Sendung (`krypto/gruppe/senden.ts`), weil es
   * kein Ereignis ueber einen Mitgliederwechsel gibt (nachgesehen, s.
   * `krypto/gruppe/sitzungswahl.ts`-Modulkopf). Ein zwischengespeicherter
   * Stand waere hier nicht eine Optimierung, sondern das Loch: dann
   * entschiede der Cache, wen man aussperrt.
   */
  lesen(gruppeId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe>(
      `/gruppen/${encodeURIComponent(gruppeId)}`,
      {},
      cloudRoute()
    );
  },

  erstellen(name: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe>('/gruppen', { method: 'POST', body: { name } }, cloudRoute());
  },

  mitgliedHinzufuegen(gruppeId: string, userId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe>(
      `/gruppen/${encodeURIComponent(gruppeId)}/mitglieder`,
      { method: 'POST', body: { user_id: userId } },
      cloudRoute()
    );
  },

  /** `null` in der Antwort heisst: die Gruppe wurde dabei aufgeloest (letztes
   *  Mitglied gegangen) — nicht „Fehler". */
  mitgliedEntfernen(gruppeId: string, userId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/mitglieder/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
      cloudRoute()
    );
  },

  verlassen(gruppeId: string): Promise<PrivateGruppe | null> {
    if (!PRIVATE_GRUPPEN_ENABLED) return Promise.resolve(null);
    return request<PrivateGruppe | null>(
      `/gruppen/${encodeURIComponent(gruppeId)}/verlassen`,
      { method: 'POST' },
      cloudRoute()
    );
  }
};
