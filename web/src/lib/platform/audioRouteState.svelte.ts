import { listAudioRoutes, setAudioRoute, type AudioRoute, type AudioRouteList } from './audioRoute';

/**
 * Geteilter, reaktiver Stand der Audio-Ausgabe-Routen — EINE Quelle für alle
 * UIs (Route-Popup in der Sprachleiste, Ausgabe-Selector in den Einstellungen).
 *
 * Ohne diesen Store wüsste das Einstellungs-Select nichts von einer Änderung,
 * die über das Route-Popup im Sprachkanal lief (und umgekehrt): beide luden
 * ihre Liste einmalig beim Mount. Hier ändert genau eine Stelle den Stand und
 * jede offene UI sieht sie sofort.
 *
 * `hinterher()` hängt an `navigator.mediaDevices.devicechange` — BT verbindet/
 * trennt sich → die Liste (inkl. BT-Geräte) frischt sich von selbst auf.
 */
class AudioRouteState {
  liste = $state<AudioRouteList | null>(null);
  #hanger: (() => void) | null = null;

  async aktualisieren(): Promise<void> {
    this.liste = await listAudioRoutes();
    this.#devicechangeHaken();
  }

  async festenWegWaehlen(route: AudioRoute): Promise<void> {
    await setAudioRoute(route);
    await this.aktualisieren();
  }

  async geraetWaehlen(deviceId: number): Promise<void> {
    await setAudioRoute(undefined, deviceId);
    await this.aktualisieren();
  }

  /** BT verbindet/trennt → WebView feuert devicechange; einmal pro Seite
   *  registriert, refresh gedrosselt (Geräte-Events kommen gebündelt). */
  #devicechangeHaken(): void {
    if (this.#hanger || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    let offen = false;
    const hanger = () => {
      if (offen) return;
      offen = true;
      setTimeout(() => {
        offen = false;
        void this.aktualisieren();
      }, 300);
    };
    navigator.mediaDevices.addEventListener?.('devicechange', hanger);
    this.#hanger = hanger;
  }
}

export const audioRouteState = new AudioRouteState();
