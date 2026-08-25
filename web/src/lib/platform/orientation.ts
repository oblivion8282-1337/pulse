/**
 * Orientierungs-Sperre der Android-Hülle (Capacitor).
 *
 * Regel: Querformat gibt es nur mit offenem Stream. Standardmäßig sperrt die
 * App auf Hochformat; das Web gibt die Sperre frei, sobald der Nutzer einen
 * Stream anschaut, und sperrt wieder, wenn keiner mehr offen ist — Android
 * dreht dabei von selbst zurück ins Hochformat, auch wenn das Handy quer
 * gehalten wird. Außerhalb der Android-Hülle (Browser/Electron) ist alles
 * No-op: Dort gilt die Breiten-Logik des Viewport-Stores allein.
 */
import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from './runtime';

interface OrientationLockPlugin {
  lock(opts: { portrait: boolean }): Promise<void>;
}

const plugin = registerPlugin<OrientationLockPlugin>('OrientationLock');

let letzterZustand: boolean | null = null;

/** `true` = auf Hochformat sperren, `false` = Sensor freigeben (Quer möglich).
 *  Wiederholte Aufrufe mit demselben Zustand werden übersprungen. */
export async function orientierungSperren(portrait: boolean): Promise<void> {
  if (!isCapacitorAndroid()) return;
  if (letzterZustand === portrait) return;
  letzterZustand = portrait;
  try {
    await plugin.lock({ portrait });
  } catch (e) {
    letzterZustand = null;
    console.warn('[orientation] lock failed', e);
  }
}
