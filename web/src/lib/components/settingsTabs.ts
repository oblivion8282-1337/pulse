/**
 * Die Tab-Definitionen des Einstellungsdialogs — als reine Daten ausgelagert
 * (Fix-Runde 1 zu Aufgabe 10: `SettingsDialog.svelte` war über die
 * 250-Zeilen-Grenze für Komponenten gewachsen; die Tab-Liste samt
 * Icon-Importen war die naheliegende Naht).
 *
 * **Als Funktion, nicht als Modul-Konstante.** Ein `export const tabs = [...]`
 * auf Modulebene würde die `m.settings_dialog_tab_*()`-Labels EINMAL für die
 * gesamte Lebensdauer der App einfrieren — ES-Module sind Singletons, ein
 * zweites `import` liefert dieselbe eingefrorene Liste. Vorher stand das
 * Array im `<script>` der Komponente und wurde bei jeder Instanz neu
 * ausgewertet (Sprachumschalter erzeugt bislang ohnehin keinen Remount, das
 * Verhalten war also schon vorher an dieser Stelle nicht live — aber diese
 * Auslagerung darf es nicht zusätzlich verschlechtern). `getSettingsTabs()`
 * hält exakt dasselbe Timing: der Aufrufer ruft sie einmal beim Erzeugen der
 * Komponente, wie zuvor der `const`-Ausdruck.
 */
import DownloadIcon from '@lucide/svelte/icons/download';
import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
import PaletteIcon from '@lucide/svelte/icons/palette';
import MicIcon from '@lucide/svelte/icons/mic';
import MonitorIcon from '@lucide/svelte/icons/monitor';
import BellIcon from '@lucide/svelte/icons/bell';
import Volume2Icon from '@lucide/svelte/icons/volume-2';
import KeyboardIcon from '@lucide/svelte/icons/keyboard';
import ShieldIcon from '@lucide/svelte/icons/shield';
import LockIcon from '@lucide/svelte/icons/lock';
import ServerIcon from '@lucide/svelte/icons/server';
import MonitorCogIcon from '@lucide/svelte/icons/monitor-cog';
import UserIcon from '@lucide/svelte/icons/user';
import { m } from '$lib/paraglide/messages.js';
import type { SettingsTab } from './SettingsDialog.svelte';

export interface SettingsTabDef {
  id: SettingsTab;
  label: string;
  icon: typeof MicIcon;
  desktopOnly?: true;
  browserOnly?: true;
  electronOnly?: true;
  /**
   * Nur dort zeigen, wo `reiterSichtbar()` es erlaubt (Rechner kann selbst
   * Standplatz sein, oder es liegt eine Eintragung vor, oder der Nutzer
   * besitzt Geräte auf diesem Server — s. `$lib/devices/reiterSichtbar.ts`).
   *
   * **Hiess bis 2026-08-20 `windowsOnly`.** Der Name stimmte, solange die
   * einzige Bedingung war, ob DIESER Rechner ferngesteuert werden kann (nur
   * der Windows-Sidecar spielt Eingaben ein). Seit auch „besitzt Geräte auf
   * diesem Server" den Reiter zeigt, ist das nicht mehr plattformgebunden —
   * ein Linux-Nutzer mit einem eigenen Windows-Gerät sieht den Reiter jetzt
   * ebenfalls, ohne dass sein eigener Rechner etwas kann.
   *
   * **Betrifft nur das ANBIETEN der Freigabe/Eintragung-Formulare.** Steuern,
   * zusehen und Geräte in der Kanalliste sehen bleibt plattformneutral — der
   * Steuernde braucht keinen Sidecar.
   */
  standplatzGate?: true;
}

export function getSettingsTabs(): SettingsTabDef[] {
  return [
    { id: 'profile', label: m.settings_dialog_tab_profile(), icon: UserIcon },
    { id: 'appearance', label: m.settings_dialog_tab_appearance(), icon: PaletteIcon },
    { id: 'audio-video', label: m.settings_dialog_tab_audio_video(), icon: MicIcon },
    { id: 'screen-share', label: m.settings_dialog_tab_screen_share(), icon: MonitorIcon, desktopOnly: true },
    { id: 'standplatz', label: m.settings_dialog_tab_standplatz(), icon: MonitorCogIcon, standplatzGate: true },
    { id: 'notifications', label: m.settings_dialog_tab_notifications(), icon: BellIcon },
    { id: 'sounds', label: m.settings_dialog_tab_sounds(), icon: Volume2Icon },
    { id: 'keyboard', label: m.settings_dialog_tab_keyboard(), icon: KeyboardIcon, desktopOnly: true },
    { id: 'privacy', label: m.settings_dialog_tab_privacy(), icon: LockIcon },
    { id: 'security', label: m.settings_dialog_tab_security(), icon: ShieldIcon },
    { id: 'self-host', label: m.settings_dialog_tab_self_host(), icon: ServerIcon },
    { id: 'apps', label: m.settings_dialog_tab_apps(), icon: DownloadIcon, browserOnly: true },
    { id: 'experimental', label: m.settings_dialog_tab_diagnostics(), icon: PlugZapIcon, electronOnly: true },
  ];
}

/**
 * Die Bedingungen, unter denen ein Reiter sichtbar ist.
 *
 * Als Werte hereingereicht statt hier ermittelt: die Quellen sind Runen-Stores
 * und ein `viewport`, die in einem reinen Datenmodul nichts zu suchen haben.
 */
export interface ReiterBedingungen {
  /** Schmaler Bildschirm — blendet die reinen Rechner-Reiter aus. */
  istMobil: boolean;
  /** Läuft im Browser (weder Electron noch Android-Hülle). */
  imBrowser: boolean;
  /** Läuft in einer Desktop-App, gleich welcher Plattform. */
  istDesktopApp: boolean;
  /** Standplatz-Reiter zeigen — s. `$lib/devices/reiterSichtbar.ts`. */
  zeigtStandplatz: boolean;
}

/**
 * Welche Reiter unter diesen Bedingungen sichtbar sind.
 *
 * **Steht hier und nicht im Dialog**, seit der Du-Bereich des Handys
 * (`/app/me`) dieselben Einstellungen als aufgeschobene Bildschirme zeigt:
 * zwei Rechnungen für dieselbe Frage liefen auseinander, und zwar in die
 * gefährliche Richtung — ein Reiter, der am Telefon nichts tun kann, wäre
 * dort trotzdem erschienen.
 *
 * Rein und ohne Runen, damit beide Seiten sie gleich aufrufen können.
 */
export function sichtbareReiter(
  tabs: SettingsTabDef[],
  b: ReiterBedingungen
): SettingsTabDef[] {
  return tabs.filter(
    (t) =>
      (!t.desktopOnly || !b.istMobil) &&
      (!t.browserOnly || b.imBrowser) &&
      (!t.electronOnly || b.istDesktopApp) &&
      (!t.standplatzGate || b.zeigtStandplatz)
  );
}
