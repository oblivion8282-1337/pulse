/**
 * Pulse-Laufwerk — Client fuer ``routes/ablage_pulse.py`` (Spezifikation
 * ``docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md``). Die
 * Wire-Shapes spiegeln die Server-Antworten 1:1; Namen sind die
 * klientszeitigen Zufallsnamen (``a-<hex>.puls``, ``verzeichnis.puls``) —
 * der Server kennt keine Klartext-Dateinamen, und diese Schicht sorgt
 * dafür, dass es dabei bleibt.
 */

import { request } from './client';

const PULSE_BASE = (guildId: string) => `/guilds/${guildId}/ablage/pulse`;

export interface PulseStatus {
  verbunden: boolean;
  genutzt_bytes: number;
  kontingent_bytes: number;
}

export const ablagePulseApi = {
  status(guildId: string): Promise<PulseStatus> {
    return request<PulseStatus>(`${PULSE_BASE(guildId)}/status`, { method: 'GET' });
  },

  /** Nur der aktuelle Community-Besitzer (idempotent, 204). */
  verbinden(guildId: string): Promise<void> {
    return request<void>(`${PULSE_BASE(guildId)}/laufwerk`, { method: 'PUT' });
  },

  /** Kuendigt einen Klumpen an (nur Groesse + Zufallsname) und bekommt die
   *  presigned PUT-URL. Bei 413 ist der Speicher voll — die Oberfläche
   *  zeigt das als Tarif-Frage, nicht als Technikfehler. */
  ankuendigen(guildId: string, name: string, groesse: number): Promise<{ upload_url: string }> {
    return request<{ upload_url: string }>(`${PULSE_BASE(guildId)}/dateien`, {
      method: 'POST',
      body: { name, groesse }
    });
  },

  /** Bestaetigt das PUT — erst ab hier zaehlt der Klumpen ins Kontingent. */
  gelungen(guildId: string, name: string): Promise<void> {
    return request<void>(`${PULSE_BASE(guildId)}/dateien/gelungen`, {
      method: 'POST',
      body: { name }
    });
  },

  /** Die Klumpen-Namen (zustand=1) — das Verzeichnis mit den Klartext-
   *  Namen liegt verschluesselt IN einem der Klumpen. */
  namen(guildId: string): Promise<string[]> {
    return request<string[]>(`${PULSE_BASE(guildId)}/dateien`, { method: 'GET' });
  },

  leseUrl(guildId: string, name: string): Promise<{ url: string }> {
    const params = new URLSearchParams({ name });
    return request<{ url: string }>(`${PULSE_BASE(guildId)}/dateien/lese-url?${params}`, {
      method: 'GET'
    });
  },

  loeschen(guildId: string, name: string): Promise<void> {
    const params = new URLSearchParams({ name });
    return request<void>(`${PULSE_BASE(guildId)}/dateien?${params}`, { method: 'DELETE' });
  }
};
