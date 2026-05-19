/**
 * Singleton für app-weite Overlay-States, die von mehreren Call-Sites
 * gesetzt werden (Shortcut + Click). Vermeidet `$bindable` durch mehrere
 * Layout-Layer hindurchzureichen.
 */

class UIOverlays {
  settingsOpen = $state(false);
  quickSwitcherOpen = $state(false);
  hqStreamDialogOpen = $state(false);
}

export const uiOverlays = new UIOverlays();
