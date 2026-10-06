import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';

/**
 * Haptisches Feedback gibt es nur in der Capacitor-Hülle — dort sitzt der
 * Vibrationsmotor unterm Finger. In Browser und Electron wäre der Aufruf
 * wirkungslos, also gar nicht erst anfassen (gleiches Gate wie
 * statusLeiste/externeLinks). `ImpactStyle.Light` ist der dezente
 * WhatsApp-Tick: ein kurzes Klopfen bei den wichtigsten Bedienmomenten,
 * nichts Aufdringliches.
 */
export function haptikTicken(): void {
  if (!isCapacitorIOS() && !isCapacitorAndroid()) return;
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}
