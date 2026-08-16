/**
 * Standplatz-Geräte — REST-Client.
 *
 * Ein Gerät ist ein Rechner, der in einem Sprachkanal **steht**, ohne dort
 * Teilnehmer zu sein (`docs/plans/2026-08-14-fernsteuerung-unbeaufsichtigte-geraete.md`).
 * Wire-Form spiegelt `services/chat-gateway/.../routes/devices.py`.
 *
 * Kennungen sind Zeichenketten, wie überall über die API — `Number` kann
 * 64-bit-Snowflakes nicht verlustfrei tragen.
 */

import { request } from './client';

/** Zustand aus dem Verbindungsregister des Gateways, nicht aus der Datenbank. */
export type DeviceState = 'ready' | 'busy' | 'offline';

export interface Device {
  id: string;
  guild_id: string;
  /** Der Standplatz — ein Sprachkanal. */
  channel_id: string;
  owner_user_id: string;
  name: string;
  state: DeviceState;
  /** Wer gerade steuert (nur bei `busy`). */
  busy_with: string | null;
}

export const devicesApi = {
  /** Alle Geräte der Community, deren Standplatz man sehen darf. */
  list(guildId: string): Promise<Device[]> {
    return request<Device[]>(`/guilds/${guildId}/devices`);
  },

  /** Diesen Rechner als Gerät eintragen. */
  create(
    guildId: string,
    body: { channel_id: string; name: string; cert_id?: string | null },
  ): Promise<Device> {
    return request<Device>(`/guilds/${guildId}/devices`, { method: 'POST', body });
  },

  /** Umbenennen oder auf einen anderen Standplatz stellen. */
  patch(
    guildId: string,
    deviceId: string,
    body: { name?: string; channel_id?: string },
  ): Promise<Device> {
    return request<Device>(`/guilds/${guildId}/devices/${deviceId}`, {
      method: 'PATCH',
      body,
    });
  },

  /** Eintragung entfernen. */
  remove(guildId: string, deviceId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/devices/${deviceId}`, { method: 'DELETE' });
  },
};
