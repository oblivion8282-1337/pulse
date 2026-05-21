// Open-Zustand des mobilen Channel-/DM-Drawers. Modul-Ebene (nicht per-Page-
// `$state`), damit der Zustand einen Routenwechsel überlebt: ein Tap auf ein
// Server-Icon in der GuildRail wechselt die Route UND lässt den Drawer auf der
// Zielseite offen. Das Server-Icon ist damit der Drawer-Trigger — einen
// eigenen Burger-Button gibt es auf Mobil nicht mehr.
//
// Auf Desktop ist der Drawer ohnehin `md:`-statisch sichtbar; dieser Wert
// wirkt sich dort nicht aus.
class NavDrawer {
  open = $state(false);
}

export const navDrawer = new NavDrawer();
