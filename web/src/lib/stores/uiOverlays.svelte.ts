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

  /** Einstellungen gezielt auf einem Tab öffnen (z.B. 'self-host' aus dem
   *  Betreiber-Hinweis der Server-Leiste). */
  openSettings(tab: SettingsTab = 'audio-video'): void {
    this.settingsInitialTab = tab;
    this.settingsOpen = true;
  }
}

export const uiOverlays = new UIOverlays();
