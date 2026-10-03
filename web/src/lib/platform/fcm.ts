/**
 * FCM-Push-Empfang in der Android-App (Übergabe P0.1).
 *
 * Die Capacitor-App lädt diese Web-App remote; das native Plugin
 * (`@capacitor-firebase/messaging`, nur in mobile/ installiert) ist deshalb
 * hier NICHT als Paket-Import erreichbar und wird wie beim Share-Empfang über
 * `window.Capacitor.Plugins` angesprochen (Typen lokal, schmal gehalten).
 *
 * Aufgabenteilung laut Plugin-Doku (v8):
 *  - App im HINTERGRUND/zu: Android zeigt die FCM-Notification-Meldung selbst
 *    im System-Tray an — kein eigener Anzeigecode nötig.
 *  - App im VORDERGRUND: `notificationReceived` feuert, aber die Nachricht
 *    erscheint ohnehin inline über den WS (`dm_bump`/`message`) — eine
 *    zusätzliche OS-Meldung wäre doppelt. Bewusst kein Listener.
 *  - TAP auf die Systemmeldung: `notificationActionPerformed` → Deep-Link
 *    in den Chat (`channel_id` aus der Push-Nutzlast, inhaltsfrei).
 */

import { goto } from '$app/navigation';
import { request } from '$lib/api/client';
import { isCapacitorAndroid } from './runtime';

/** Schmaler Ausschnitt der Plugin-Oberfläche (nur was wir rufen). */
interface FcmPlugin {
  getToken(): Promise<{ token: string }>;
  checkPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' }>;
  requestPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' }>;
  createChannel(options: {
    id: string;
    name: string;
    importance?: number;
    visibility?: number;
  }): Promise<void>;
  addListener(
    eventName: 'notificationActionPerformed',
    listenerFunc: (event: { notification: { data?: unknown } }) => void
  ): Promise<{ remove: () => void }>;
}

function plugin(): FcmPlugin | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (cap?.Plugins?.FirebaseMessaging as FcmPlugin | undefined) ?? null;
}

/**
 * Muss zum Backend-Kanal passen: der Versand ordnet die Meldung über
 * `AndroidNotification.channel_id` hier ein (dcc_chat_gateway/fcm.py).
 */
const KANAL_ID = 'messages';

const GERAET_KEY = 'pulse-fcm-geraet-id';

function geraetId(): string {
  try {
    let id = window.localStorage.getItem(GERAET_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(GERAET_KEY, id);
    }
    return id;
  } catch {
    return 'geraet-ohne-speicher';
  }
}

async function meldeAn(fcm: FcmPlugin): Promise<void> {
  const { token } = await fcm.getToken();
  await request<void>('/fcm/token', {
    method: 'POST',
    body: { token, geraet_id: geraetId() }
  });
}

/** Push-Tap → Deep-Link in den DM-Chat (Kanal ohne Guild → `/app/@me`). */
function zeigAn(event: { notification: { data?: unknown } }): void {
  const data = event.notification?.data;
  const kanalId =
    typeof data === 'object' && data !== null && 'channel_id' in data
      ? String((data as Record<string, unknown>).channel_id)
      : '';
  if (!kanalId) return;
  void goto(`/app/@me/${kanalId}`);
}

/**
 * Beim App-Start verkabeln (app/+layout.svelte): Token holen + melden,
 * Tap-Listener registrieren. Best-effort in jedem Schritt — ohne Firebase-
 * Konfiguration, vor der Anmeldung oder ohne erteilte Berechtigung bleibt
 * alles still (kein Crash, kein Log-Spam). Nach jedem Resume wird die
 * Token-Meldung wiederholt (idempotent), damit eine Anmeldung NACH dem
 * App-Start den Token nachreicht.
 */
export function installiereFcmPush(): void {
  if (!isCapacitorAndroid()) return;
  const fcm = plugin();
  if (!fcm) return;

  let listenerBereit = false;
  let anmeldung: Promise<void> | null = null;

  const meldeBestEffort = (): void => {
    anmeldung ??= (async () => {
      try {
        await fcm.createChannel({
          id: KANAL_ID,
          name: 'Nachrichten',
          importance: 4, // HIGH — Pop-up + Ton, Discord-artig
          visibility: 1 // PUBLIC — auf dem Sperrbildschirm lesbar
        });
        let perms = await fcm.checkPermissions();
        if (perms.receive !== 'granted') {
          perms = await fcm.requestPermissions();
        }
        if (perms.receive !== 'granted') return;
        await meldeAn(fcm);
        if (!listenerBereit) {
          listenerBereit = true;
          void fcm.addListener('notificationActionPerformed', zeigAn);
        }
      } catch {
        // Kein Firebase-Setup / keine Session / offline — bewusst still.
      } finally {
        anmeldung = null;
      }
    })();
  };

  meldeBestEffort();
  // Nach Login/Resume: Token nachmelden, ohne den Listener doppelt zu hängen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') meldeBestEffort();
  });
}

/**
 * Token serverseitig abmelden (Sign-Out). `bearerOverride`: gleiche Begründung
 * wie bei `deletePushSubscription` — `clearTokens()` ist im Sign-Out-Pfad
 * schon gelaufen, wenn dieser (dynamisch importierte) Aufruf feuert.
 */
export async function abmeldeFcmToken(bearerOverride?: string): Promise<void> {
  const fcm = plugin();
  if (!fcm) return;
  try {
    const { token } = await fcm.getToken();
    await request<void>('/fcm/token', {
      method: 'DELETE',
      body: { token },
      ...(bearerOverride
        ? { auth: false, headers: { Authorization: `Bearer ${bearerOverride}` } }
        : {})
    });
  } catch {
    /* best-effort — Sign-Out darf daran nicht hängen */
  }
}
