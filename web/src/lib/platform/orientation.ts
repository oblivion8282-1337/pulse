/**
 * Orientierungs-Sperre der Mobil-Hüllen (Capacitor, Android UND iOS).
 *
 * Regel: Querformat gibt es nur mit offenem Stream. Standardmäßig sperrt die
 * App auf Hochformat; das Web gibt die Sperre frei, sobald der Nutzer einen
 * Stream anschaut, und sperrt wieder, wenn keiner mehr offen ist — beide
 * Hüllen drehen dabei von selbst zurück ins Hochformat, auch wenn das Gerät
 * quer gehalten wird. Außerhalb einer Hülle (Browser/Electron) ist alles
 * No-op: Dort gilt die Breiten-Logik des Viewport-Stores allein.
 *
 * **iOS kam am 2026-10-08 dazu** (`OrientationPlugin.swift`, gleicher JS-Name
 * und gleiche Signatur wie das Android-Pendant). Vorher stand hier ein
 * `isCapacitorAndroid()`-Riegel, und das war am iPhone doppelt wirksam: die
 * Hülle durfte laut `Info.plist` ohnehin nicht drehen. Sichtbar wurde es als
 * „das Stream-Vollbild dreht nicht mit, wenn ich das Telefon quer halte".
 */
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';

interface OrientationLockPlugin {
  lock(opts: { portrait: boolean }): Promise<void>;
}

const plugin = registerPlugin<OrientationLockPlugin>('OrientationLock');

let letzterZustand: boolean | null = null;

/** `true` = auf Hochformat sperren, `false` = Sensor freigeben (Quer möglich).
 *  Wiederholte Aufrufe mit demselben Zustand werden übersprungen. */
export async function orientierungSperren(portrait: boolean): Promise<void> {
  if (!isCapacitorAndroid() && !isCapacitorIOS()) return;
  if (letzterZustand === portrait) return;
  letzterZustand = portrait;
  try {
    await plugin.lock({ portrait });
  } catch (e) {
    letzterZustand = null;
    console.warn('[orientation] lock failed', e);
  }
}
