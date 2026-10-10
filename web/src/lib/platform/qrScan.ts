/**
 * QR-Code einlesen — für den Kopplungs-Code (iOS-Liste Punkt 34).
 *
 * **Warum es diesen Weg gibt.** Das eingerichtete Gerät zeigt den Code längst
 * als QR (`kopplung/qr.ts`); das neue Gerät musste ihn bis hierher ABTIPPEN —
 * 20 Zeichen, in einem Alphabet, in dem man 0 und O verwechselt.
 *
 * **Nur die iOS-Hülle, und das ist kein Versehen.** Im Browser und in der
 * Android-Hülle bleibt das Eintippen, und das ist kein Notnagel: es muss
 * ohnehin funktionieren (Kamera verweigert, kein Licht, Code auf Papier), und
 * es funktioniert schon.
 *
 * Der erste Entwurf meldete `qrScanMoeglich() === true`, sobald der Browser
 * `BarcodeDetector` mitbringt — Chromium tut das, und damit die Android-Hülle.
 * Nur: die Schnittstelle prüft ein EINZELNES BILD, sie bringt keine
 * Kamera-Ansicht mit. Der Knopf wäre erschienen und hätte nichts getan. Wer
 * den Web-Weg nachliefert, braucht beides — Kamera-Ansicht plus Bildschleife —
 * und kann dann hier `qrScanMoeglich` erweitern.
 *
 * `null` heisst immer dasselbe: kein Code. Abbruch, keine Kamera, keine
 * Erlaubnis — die Oberfläche behandelt alle drei gleich, weil der Nutzer in
 * allen drei Fällen dasselbe tun soll (tippen). Ein eigener Fehlertext je
 * Ursache wäre drei Texte für eine Handlung.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitorIOS } from './runtime';

interface QrScanPlugin {
  scannen(): Promise<{ code: string | null }>;
}

const plugin = registerPlugin<QrScanPlugin>('QrScan');

/** `true`, wenn diese Umgebung scannen kann. Die Oberfläche blendet den Knopf
 *  sonst aus, statt ihn anzubieten und nichts zu tun — das gilt auch für einen
 *  älteren App-Bau ohne das Plugin. */
export function qrScanMoeglich(): boolean {
  return isCapacitorIOS() && Capacitor.isPluginAvailable('QrScan');
}

/** Öffnet den Scanner und liefert den Inhalt, oder `null`. */
export async function qrScannen(): Promise<string | null> {
  if (!isCapacitorIOS()) return null;
  try {
    const { code } = await plugin.scannen();
    return code ?? null;
  } catch (e) {
    console.warn('[qrScan] nativer Scanner nicht erreichbar', e);
    return null;
  }
}
