/**
 * Bildschirm wach halten — natives Gegenstück für die iOS-Hülle.
 *
 * Gerufen wird das NICHT direkt, sondern über `platform/wakeLock.ts`: dort
 * sitzt der Zähler der Pächter (mehrere Kacheln können gleichzeitig wach
 * halten wollen) und die Sichtbarkeits-Regel. Hier steht nur die Brücke.
 *
 * Browser, Electron und Android: No-op — dort trägt der Browser-Weg
 * (`navigator.wakeLock`) beziehungsweise die Electron-Brücke.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitorIOS } from './runtime';

interface WachhaltenPlugin {
  wachHalten(options: { an: boolean }): Promise<void>;
}

const plugin = registerPlugin<WachhaltenPlugin>('Wachhalten');

/** `true`, wenn in dieser Hülle der native Weg gilt — also nur, wenn der
 *  App-Bau das Plugin auch mitbringt. Ein älterer Bau ohne es fiele sonst
 *  nicht auf `navigator.wakeLock` zurück, sondern auf ein `UNIMPLEMENTED`,
 *  das `wakeLock.ts` still schluckt: der Bildschirm ginge beim Zuschauen aus. */
export function iosWachhaltenVerfuegbar(): boolean {
  return isCapacitorIOS() && Capacitor.isPluginAvailable('Wachhalten');
}

/** Schaltet den iOS-Ruhe-Timer ab (`an = true`) beziehungsweise wieder an. */
export async function iosWachHalten(an: boolean): Promise<void> {
  if (!isCapacitorIOS()) return;
  await plugin.wachHalten({ an });
}
