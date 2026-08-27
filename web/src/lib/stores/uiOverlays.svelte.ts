/**
 * Singleton für app-weite Overlay-States, die von mehreren Call-Sites
 * gesetzt werden (Shortcut + Click). Vermeidet `$bindable` durch mehrere
 * Layout-Layer hindurchzureichen.
 */

import type { SettingsTab } from '$lib/components/SettingsDialog.svelte';

class UIOverlays {
  settingsOpen = $state(false);
  quickSwitcherOpen = $state(false);
  hqStreamDialogOpen = $state(false);
  /** Tab, auf dem der Einstellungs-Dialog beim nächsten Öffnen landet.
   *  SettingsDialog wendet ihn nur auf der Open-Transition an. */
  settingsInitialTab = $state<SettingsTab>('audio-video');

  /** Einstellungen gezielt auf einem Tab öffnen. (Das frühere Beispiel hier
   *  war 'self-host' aus dem Betreiber-Hinweis der Server-Leiste — den Reiter
   *  gibt es seit 2026-08-27 nicht mehr, der Self-Host-Bereich ist die eigene
   *  Route `/app/server`.) */
  openSettings(tab: SettingsTab = 'audio-video'): void {
    this.settingsInitialTab = tab;
    this.settingsOpen = true;
  }
}

export const uiOverlays = new UIOverlays();
