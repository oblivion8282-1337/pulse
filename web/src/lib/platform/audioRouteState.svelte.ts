import { listAudioRoutes, setAudioRoute, type AudioRoute, type AudioRouteList } from './audioRoute';
import { iosWegWechsel } from './iosAudioSession';

/**
 * Geteilter, reaktiver Stand der Audio-Ausgabe-Routen — EINE Quelle für alle
 * UIs (Route-Popup in der Sprachleiste, Ausgabe-Selector in den Einstellungen).
 *
 * Ohne diesen Store wüsste das Einstellungs-Select nichts von einer Änderung,
 * die über das Route-Popup im Sprachkanal lief (und umgekehrt): beide luden
 * ihre Liste einmalig beim Mount. Hier ändert genau eine Stelle den Stand und
 * jede offene UI sieht sie sofort.
 *
 * `#wegWechselHaken()` hängt an `navigator.mediaDevices.devicechange` — BT
 * verbindet/trennt sich → die Liste (inkl. BT-Geräte) frischt sich von selbst
 * auf.
 *
 * **Auf iOS kommt ein ZWEITER Auslöser dazu** (`iosWegWechsel`, seit
 * 2026-10-08): `routeChangeNotification` der Audio-Session. Das native Plugin
 * meldete diesen Wechsel schon seit Punkt 24, aber **niemand im Web hörte zu**
 * — die Liste hing damit allein an `devicechange`, und ob die WKWebView das
 * feuert, wenn AirPods sich verbinden, ist nicht belegt. Sichtbar wäre der
 * Fehlschlag nur als veraltetes Zeichen in der Leiste: man hört längst über
 * AirPods, die Leiste zeigt weiter den Lautsprecher.
 */
class AudioRouteState {
  liste = $state<AudioRouteList | null>(null);
  /** Die gedrosselte Auffrisch-Funktion. Einmal gebaut, von beiden Quellen
   *  geteilt — sonst drosselten zwei Instanzen unabhängig voneinander und ein
   *  Wegwechsel, den beide melden, löste zwei Abfragen aus. */
  #hanger: (() => void) | null = null;
  #amBrowser = false;
  #amSystem = false;

  async aktualisieren(): Promise<void> {
    this.liste = await listAudioRoutes();
    this.#wegWechselHaken();
  }

  async festenWegWaehlen(route: AudioRoute): Promise<void> {
    await setAudioRoute(route);
    await this.aktualisieren();
  }

  async geraetWaehlen(deviceId: number): Promise<void> {
    await setAudioRoute(undefined, deviceId);
    await this.aktualisieren();
  }

  /** BT verbindet/trennt → WebView feuert devicechange, auf iOS zusätzlich die
   *  Audio-Session (`iosWegWechsel`); je Quelle einmal pro Seite registriert,
   *  refresh gedrosselt (Geräte-Events kommen gebündelt).
   *
   *  **Die zwei Quellen werden getrennt verbucht, und das ist der Punkt.** Beim
   *  Anschliessen des nativen Melders sass er zuerst HINTER dem Riegel
   *  `!navigator.mediaDevices` — eine Vorbedingung des Browser-Wegs, mit der
   *  der native nichts zu tun hat. In einer WebView mit WebRTC ist
   *  `mediaDevices` da, der Fehler wäre also nie aufgefallen und hätte dort
   *  gewartet, wo jemand die Reihenfolge einmal anfasst.
   *
   *  Der Browser-Weg darf ausserdem beim nächsten Mal nachgeholt werden (der
   *  Riegel steht nicht an der ganzen Methode): deshalb zwei Merker und nicht
   *  ein früher Austritt. */
  #wegWechselHaken(): void {
    const hanger = (this.#hanger ??= this.#drossel());
    if (!this.#amBrowser && typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener?.('devicechange', hanger);
      this.#amBrowser = true;
    }
    if (!this.#amSystem) {
      // No-op ausserhalb der iOS-Hülle.
      iosWegWechsel(hanger);
      this.#amSystem = true;
    }
  }

  /** 300 ms Sammelfenster: Geräte-Ereignisse kommen gebündelt (ein
   *  Bluetooth-Wechsel meldet mehrfach), eine Abfrage je Schub genügt. */
  #drossel(): () => void {
    let offen = false;
    return () => {
      if (offen) return;
      offen = true;
      setTimeout(() => {
        offen = false;
        void this.aktualisieren();
      }, 300);
    };
  }
}

export const audioRouteState = new AudioRouteState();
