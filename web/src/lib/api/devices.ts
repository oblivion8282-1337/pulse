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

/**
 * Ein Bildschirm des Geräts, wie er beim Anmelden gemeldet wurde.
 *
 * **Dieselbe Form wird auch für die AUSGEHENDE `device_announce`-Meldung
 * benutzt** (`$lib/devices/anmeldung.svelte.ts`, `$lib/ws/gateway-senders.ts`)
 * statt eines eigenen, wortgleichen Typs dort — der Gateway-Filter
 * (`ws_device_handlers.py::_monitore`) validiert genau diese vier zusätzlichen
 * Felder ohnehin einzeln und lässt sie unverändert durch, wenn sie plausibel
 * sind. Ein eigener Sende-Typ wäre eine vierte Stelle, die bei der nächsten
 * Erweiterung erneut synchron gehalten werden müsste.
 */
export interface DeviceMonitor {
  /** 1-basiert, passt zur Aufnahmequelle `Monitor: <index>`. */
  index: number;
  name: string;
  primary: boolean;
  /** Lage und Grösse in Bildpunkten — für die massstäbliche Bildschirm-Karte
   *  im Fernsteuer-Overlay. Alle vier **optional**: ältere Geräte (Sidecar
   *  vor 2026-08-24, oder Linux) melden sie nicht, und der Gateway-Filter
   *  lässt jede der vier Zahlen einzeln weg, wenn sie fehlt oder Unfug ist.
   *  `x`/`y` dürfen negativ sein (ein Monitor links vom oder über dem
   *  Hauptbildschirm hat eine negative Lage); `width`/`height` sind immer
   *  positiv. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

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
  /** Die Bildschirme des Geräts. Leer, solange es nie verbunden war — die
   *  Oberfläche zeigt dann nur den Hauptbildschirm an, und das ist ehrlicher
   *  als eine erfundene Liste. */
  monitors: DeviceMonitor[];
  /** Plätze, auf denen dieses Gerät gerade sendet. Leer heisst „sendet nicht"
   *  — und ebenso „meldet es nicht" (ältere Client-Fassung). */
  stream_slots: number[];
}

/**
 * Antwort auf ein PATCH. Trägt zusätzlich `role_grants_cleared`, wenn ein
 * Community-Wechsel Rollen-Freigaben geräumt hat — das gehört NICHT dauerhaft
 * zu `Device` (in jeder Geräteliste wäre es eine Lüge), deshalb ein eigener
 * Antwort-Typ nur für diese eine Route.
 */
export type DevicePatchAntwort = Device & { role_grants_cleared?: number };

export type GrantArt = 'user' | 'role' | 'everyone';

export interface Grant {
  id: string;
  subject_type: GrantArt;
  /** Nutzer- oder Rollenkennung; `null` bei `everyone`. */
  subject_id: string | null;
  /** ISO-Zeitpunkt; `null` = dauerhaft. */
  expires_at: string | null;
  created_at: string;
}

export type GrantEingabe = Pick<Grant, 'subject_type' | 'subject_id' | 'expires_at'>;

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

  /** Umbenennen, auf einen anderen Standplatz stellen oder die Community
   *  wechseln. */
  patch(
    guildId: string,
    deviceId: string,
    body: { name?: string; channel_id?: string; guild_id?: string },
  ): Promise<DevicePatchAntwort> {
    return request<DevicePatchAntwort>(`/guilds/${guildId}/devices/${deviceId}`, {
      method: 'PATCH',
      body,
    });
  },

  /** Eintragung entfernen. */
  remove(guildId: string, deviceId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/devices/${deviceId}`, { method: 'DELETE' });
  },
};

export const grantsApi = {
  /** Die Freigabeliste eines EIGENEN Geräts. Fremde Geräte antworten 404. */
  list(guildId: string, deviceId: string): Promise<Grant[]> {
    return request<Grant[]>(`/guilds/${guildId}/devices/${deviceId}/grants`);
  },

  /** Die ganze Liste ersetzen — es gibt bewusst keinen Weg, einen einzelnen
   *  Eintrag zu ändern: so entsteht kein Zwischenzustand „scharf, aber für
   *  niemanden". */
  set(guildId: string, deviceId: string, grants: GrantEingabe[]): Promise<Grant[]> {
    return request<Grant[]>(`/guilds/${guildId}/devices/${deviceId}/grants`, {
      method: 'PUT',
      body: { grants },
    });
  },
};
