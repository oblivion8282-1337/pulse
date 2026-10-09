import {
  listAudioRoutes,
  onRoutesChanged,
  setAudioRoute,
  type AudioRoute,
  type AudioRouteList
} from './audioRoute';

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
  #pusher = false;

  async aktualisieren(): Promise<void> {
    this.liste = await listAudioRoutes();
    this.#devicechangeHaken();
    this.#pushHaken();
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
    this.#hanger = () => this.#gedrosselt();
    navigator.mediaDevices.addEventListener?.('devicechange', this.#hanger);
  }

  /** Nativer Push (AudioRoute-Plugin): Geräte-Callback im APK feuert
   *  "routesChanged". Nötig, weil das WebView-devicechange auf dem nativen
   *  Voice-Pfad NICHT feuert — sonst zeigte das Route-Icon einen BT-Wechsel
   *  erst nach dem nächsten Popup-Öffnen (Nutzerbefund 2026-10-09). */
  #pushHaken(): void {
    if (this.#pusher) return;
    this.#pusher = true;
    void onRoutesChanged(() => this.#gedrosselt());
  }

  #gedrosselt(): void {
    if (this.#offen) return;
    this.#offen = true;
    setTimeout(() => {
      this.#offen = false;
      void this.aktualisieren();
    }, 300);
  }

  #offen = false;
}

export const audioRouteState = new AudioRouteState();
