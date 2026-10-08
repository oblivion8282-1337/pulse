/**
 * PushKit-Token anmelden (iOS-Liste Punkt 40).
 *
 * **Das ist NICHT der FCM-Token.** Dasselbe Gerät führt beide gleichzeitig:
 * den FCM-Token für Nachrichten-Banner, den PushKit-Token fürs Klingeln.
 * Eigene Tabelle am Server, eigener Endpunkt, eigener APNs-Topic — ein Push,
 * der das Telefon zum Klingeln bringt, ist eine andere Zustellart und keine
 * andere Nutzlast.
 *
 * **Warum ein Hörer und nicht nur ein Abruf.** Der Token kommt vom System,
 * wenn es ihn für richtig hält — meist kurz nach dem Start, aber nicht
 * garantiert, und er kann sich im Betrieb ändern. Der Abruf beim Start deckt
 * den Normalfall, der Hörer den Rest; nativ wird die Meldung aufbewahrt
 * (`retainUntilConsumed`), falls sie vor der WebView da war.
 *
 * Alles andere als iOS: No-op.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { request } from '$lib/api/client';
import { pushGeraetId } from './geraeteKennungPush';
import { isCapacitorIOS } from './runtime';

interface AnrufNativPlugin {
  voipToken(): Promise<{ token: string | null }>;
  addListener(
    event: 'voipToken',
    cb: (data: { token: string }) => void
  ): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<AnrufNativPlugin>('Anruf');

let gemeldet: string | null = null;

async function melden(token: string | null): Promise<void> {
  if (!token || token === gemeldet) return;
  try {
    await request<void>('/voip/token', {
      method: 'POST',
      body: { token, geraet_id: pushGeraetId() }
    });
    gemeldet = token;
  } catch (e) {
    // Keine Sitzung, offline, oder der Server kennt die Route nicht (älterer
    // Stand) — still. `gemeldet` wird absichtlich NICHT gesetzt, damit der
    // nächste Start (oder der Hörer) denselben Token erneut anbietet.
    console.warn('[voip] Token-Anmeldung fehlgeschlagen', e);
  }
}

/** Einmal nach dem Anmelden aufrufen. */
export function voipTokenVerfolgen(): void {
  if (!isCapacitorIOS()) return;
  void plugin.addListener('voipToken', ({ token }) => void melden(token));
  void plugin
    .voipToken()
    .then(({ token }) => melden(token))
    .catch(() => undefined);
}

/** Beim Abmelden: die Registrierung dieses Geräts entfernen.
 *
 *  `bearerOverride` aus demselben Grund wie bei `abmeldeFcmToken` — im
 *  Sign-Out-Pfad sind die Token schon gelöscht, wenn dieser Aufruf feuert. */
export async function voipTokenAbmelden(bearerOverride?: string): Promise<void> {
  if (!isCapacitorIOS()) return;
  try {
    const { token } = await plugin.voipToken();
    if (!token) return;
    await request<void>('/voip/token', {
      method: 'DELETE',
      body: { token },
      ...(bearerOverride
        ? { auth: false, headers: { Authorization: `Bearer ${bearerOverride}` } }
        : {})
    });
  } catch {
    /* best-effort — Sign-Out darf daran nicht hängen */
  } finally {
    gemeldet = null;
  }
}
