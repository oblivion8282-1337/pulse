/**
 * Community-Laufwerk + Zwischenlager — Client fuer
 * ``routes/ablage_guild_laufwerk.py`` + ``routes/ablage_zwischenlager.py``
 * (Etappe E8, Design §7). Wire-Shape spiegelt die Server-Antworten 1:1,
 * Snowflake-IDs als String (Pulse-Konvention).
 */

import { request } from './client';

const LAUFWERK_BASE = (guildId: string) => `/guilds/${guildId}/ablage`;

export interface ZwischenlagerEintrag {
  id: string;
  groesse: number;
  hochgeladen_von: string;
  erstellt_am: string;
}

export const ablageGuildApi = {
  /** Nur Ja/Nein — die Adresse selbst verlaesst den Server nie. */
  laufwerkStatus(guildId: string): Promise<{ verbunden: boolean }> {
    return request<{ verbunden: boolean }>(`${LAUFWERK_BASE(guildId)}/laufwerk/status`, {
      method: 'GET'
    });
  },

  /** Nur der aktuelle Community-Besitzer darf das (403 sonst). */
  setzeLaufwerk(guildId: string, freigabeAdresse: string): Promise<void> {
    return request<void>(`${LAUFWERK_BASE(guildId)}/laufwerk`, {
      method: 'PUT',
      body: { freigabe_adresse: freigabeAdresse }
    });
  },

  /** Weiterreich-Route (§4.2) — der Klient probiert immer erst direkt
   *  (`leser.ts`-Muster) und faellt nur bei Bedarf hierauf zurueck. */
  abrufUrl(guildId: string, pfad: string): string {
    const params = new URLSearchParams({ pfad });
    return `${LAUFWERK_BASE(guildId)}/abruf?${params.toString()}`;
  },

  /** Kuendigt einen Klumpen an, bekommt eine presigned PUT-URL zurueck.
   *  ``groesse`` ist alles, was der Server ueber die Datei erfaehrt. */
  zwischenlagerAnkuendigen(
    guildId: string,
    groesse: number
  ): Promise<{ id: string; upload_url: string }> {
    return request<{ id: string; upload_url: string }>(
      `${LAUFWERK_BASE(guildId)}/zwischenlager`,
      { method: 'POST', body: { groesse } }
    );
  },

  zwischenlagerListe(guildId: string): Promise<ZwischenlagerEintrag[]> {
    return request<ZwischenlagerEintrag[]>(`${LAUFWERK_BASE(guildId)}/zwischenlager`, {
      method: 'GET'
    });
  },

  zwischenlagerDownloadUrl(guildId: string, eintragId: string): Promise<{ url: string }> {
    return request<{ url: string }>(
      `${LAUFWERK_BASE(guildId)}/zwischenlager/${eintragId}/download-url`,
      { method: 'GET' }
    );
  },

  /** Die Quittung — nur der Besitzer, s. ``festigung.ts``: erst schreiben,
   *  dann quittieren. */
  zwischenlagerQuittieren(guildId: string, eintragId: string): Promise<void> {
    return request<void>(`${LAUFWERK_BASE(guildId)}/zwischenlager/${eintragId}`, {
      method: 'DELETE'
    });
  }
};
