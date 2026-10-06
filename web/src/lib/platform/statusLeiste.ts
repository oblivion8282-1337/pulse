import { Keyboard, KeyboardStyle } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';
import { isCapacitorAndroid, isCapacitorIOS } from './runtime';

/**
 * Native Leisten folgen dem App-Erscheinungsbild.
 *
 * Seit dem Full-Bleed-Umbau malt die Seite unter die Statusleiste — ohne
 * diesen Aufruf stünde dort im dunklen Erscheinungsbild dunkle Uhr/Statustext
 * auf dunklem Glas. Dasselbe gilt für den Tastatur-Anhang (Keyboard-Style).
 *
 * In Browser und Electron ein No-op: die Plugins sind dort wirkungslos
 * (Web-Umsetzung bzw. fehlende Brücke), und der Aufruf kostet nichts. Nur
 * iOS setzt den Keyboard-Style — Androids Tastatur folgt dem System.
 *
 * Aufgerufen aus dem App-Shell als $effect über den mode-watcher-Modus; es
 * feuert damit auch beim Systemwechsel unter theme=auto.
 */
export function statusLeisteFolgtTheme(dunkel: boolean): void {
  if (!isCapacitorIOS() && !isCapacitorAndroid()) return;
  void StatusBar.setStyle({ style: dunkel ? Style.Dark : Style.Light }).catch(() => undefined);
  if (isCapacitorIOS()) {
    void Keyboard.setStyle({
      style: dunkel ? KeyboardStyle.Dark : KeyboardStyle.Light
    }).catch(() => undefined);
  }
}
