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
import { drafts } from '$lib/stores/drafts.svelte';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';
import { berechtigungsblatt } from './berechtigung.svelte';
import type { Stand } from './berechtigungRegel';
import { pushGeraetId } from './geraeteKennungPush';

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
    listenerFunc: (event: {
      notification: { data?: unknown };
      /** Bezeichner der getippten Aktion; `tap` = auf die Meldung selbst. */
      actionId?: string;
      /** Text aus dem Antwort-Feld der Meldung (nur bei `antworten`). */
      inputValue?: string;
    }) => void
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

async function meldeAn(fcm: FcmPlugin): Promise<void> {
  const { token } = await fcm.getToken();
  await request<void>('/fcm/token', {
    method: 'POST',
    body: { token, geraet_id: pushGeraetId() }
  });
}

/**
 * Push-Tap → Deep-Link in den DM-Chat (Kanal ohne Guild → `/app/@me`).
 *
 * Die Aktion „Antworten" bringt den im Banner getippten Text mit. Er wird
 * NICHT hier gesendet, sondern als Entwurf hinterlegt: Senden heisst bei
 * einer verschlüsselten DM, eine Sitzung aufzubauen und den Umschlag zu
 * bauen — das gehört in den Chat, der gerade aufgeht, nicht in einen
 * Ereignis-Handler. Der Nutzer sieht seinen Text im Eingabefeld stehen und
 * drückt Senden; was dazwischen schiefgehen kann, zeigt die Oberfläche dann
 * an, statt still zu scheitern.
 */
function zeigAn(event: {
  notification: { data?: unknown };
  actionId?: string;
  inputValue?: string;
}): void {
  const data = event.notification?.data;
  const kanalId =
    typeof data === 'object' && data !== null && 'channel_id' in data
      ? String((data as Record<string, unknown>).channel_id)
      : '';
  if (!kanalId) return;
  const text = event.actionId === 'antworten' ? (event.inputValue ?? '').trim() : '';
  if (text) drafts.set(kanalId, text);
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
  // iOS-Hülle nutzt dieselbe Plugin-Schnittstelle und denselben
  // /fcm/token-Endpunkt — der Server-Versand unterscheidet nur am Token
  // (APNs braucht den Auth-Key im Firebase-Projekt, seit 2026-10-06 drin).
  if (!isCapacitorAndroid() && !isCapacitorIOS()) return;
  const fcm = plugin();
  if (!fcm) return;

  let listenerBereit = false;
  let anmeldung: Promise<void> | null = null;

  const meldeBestEffort = (): void => {
    anmeldung ??= (async () => {
      try {
        if (isCapacitorAndroid()) {
          await fcm.createChannel({
            id: KANAL_ID,
            name: 'Nachrichten',
            importance: 4, // HIGH — Pop-up + Ton, Discord-artig
            visibility: 1 // PUBLIC — auf dem Sperrbildschirm lesbar
          });
        }
        // **Hier wird NICHT mehr nach der Erlaubnis gefragt** (2026-10-08,
        // iOS-Punkt 36). Diese Stelle läuft beim Start, also bevor der Nutzer
        // die App gesehen hat — und der iOS-Dialog erscheint genau EINMAL.
        // Ein „nein" aus Reflex war damit dauerhaft. Gefragt wird jetzt mit
        // Vorerklärung und erst nach einem Anlass, s. `mitteilungenAnfragen`.
        // Was hier bleibt, ist der Fall „Erlaubnis liegt vor": dann muss das
        // Token bei jedem Start neu gemeldet werden (es kann sich ändern).
        const perms = await fcm.checkPermissions();
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

/** Plugin-Auskunft in unseren Stand übersetzt (`berechtigungRegel.ts`).
 *  `prompt` heisst „noch offen" — nur dort kann ein Dialog noch etwas
 *  ändern. */
function alsStand(receive: 'granted' | 'denied' | 'prompt'): Stand {
  switch (receive) {
    case 'granted':
      return 'erteilt';
    case 'denied':
      return 'verweigert';
    default:
      return 'offen';
  }
}

/**
 * Nach der Mitteilungs-Erlaubnis fragen — mit Vorerklärung und erst nach einem
 * Anlass (iOS-Liste Punkt 36).
 *
 * Gerufen wird das nach einer gesendeten Nachricht, nicht beim Start. Grund:
 * der iOS-Dialog erscheint GENAU EINMAL, und beim Start hat der Nutzer keinen
 * Grund, ja zu sagen. Die Regel (wie viele Nachrichten, einmal abgelehnt =
 * nicht wieder) steht in `berechtigungRegel.ts`.
 *
 * Mehrfache Aufrufe sind billig: liegt die Erlaubnis vor oder ist sie
 * verweigert, sagt die Regel schon „keine Erklärung" und `requestPermissions`
 * wird gar nicht erreicht. Still bei jedem Fehler — eine Mitteilungs-Erlaubnis
 * ist nichts, wofür man eine Fehlermeldung zeigt.
 */
export async function mitteilungenAnfragen(): Promise<void> {
  const fcm = plugin();
  if (!fcm) return;
  try {
    const { receive } = await fcm.checkPermissions();
    const stand = alsStand(receive);
    if (stand !== 'offen') return;
    if (!(await berechtigungsblatt.fragen('mitteilungen', stand))) return;
    const neu = await fcm.requestPermissions();
    if (neu.receive !== 'granted') return;
    await meldeAn(fcm);
  } catch {
    /* Kein Firebase-Setup / keine Session / offline — bewusst still. */
  }
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
