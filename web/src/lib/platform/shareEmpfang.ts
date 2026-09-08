/**
 * Share-Target-Empfang (Übergabe P1.8): Text/Bilder aus anderen Apps
 * landen über ACTION_SEND in MainActivity, das sie in den
 * ShareReceiver-Plugin legt. Diese Brücke pollt einmalig beim App-Start
 * und nach jedem ``resume`` — ein Push-Event ist nicht nötig, weil die
 * Weiterverwendung (Composer-Prefill im gewählten Chat) ohnehin einen
 * Nutzer-Klick braucht.
 *
 * Ablage: ``freigabeStore`` (importfrei, s. dort). Verbraucher ist die
 * Composer-Seite — sie leert die Freigabe, sobald sie sie in den
 * Composer übernommen hat.
 */
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from './runtime';
import { freigabeAnkommen } from '$lib/freigabe/freigabeStore';

interface ShareReceiverPlugin {
  getPending(): Promise<{ text?: string; imageBase64?: string; imageMime?: string }>;
}

const ShareReceiver = registerPlugin<ShareReceiverPlugin>('ShareReceiver');

async function hole(): Promise<void> {
  try {
    const paket = await ShareReceiver.getPending();
    const text = typeof paket.text === 'string' && paket.text !== '' ? paket.text : null;
    const bild =
      typeof paket.imageBase64 === 'string' && paket.imageBase64 !== ''
        ? { base64: paket.imageBase64, mime: paket.imageMime ?? 'image/jpeg' }
        : null;
    if (!text && !bild) return;
    freigabeAnkommen({ text, bild });
    window.dispatchEvent(new CustomEvent('pulse-freigabe'));
  } catch {
    // Kein Android-Kontext oder Plugin fehlt — bewusst still.
  }
}

export function installiereShareEmpfang(): void {
  if (!isCapacitorAndroid()) return;
  void hole();
  // Vordergrund-Wechsel (Share-intent über onNewIntent, kein Reload):
  // dann liegt das Paket frisch im Plugin.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void hole();
  });
}
