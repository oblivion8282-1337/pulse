/**
 * Globale, persistierte Sichtbarkeit der Diagnose-Stats-Overlays auf den
 * Video-Kacheln (Codec/FPS/Bitrate + Freeze/Stutter-Warnung).
 *
 * Default AUS — Codec/Bitrate interessieren die meisten Zuschauer nicht.
 * Einmal an, gilt für alle Tiles (HQ-Stream + Screenshare) und übersteht
 * Reload. Bewusst ein eigener Mini-Store mit eigenem localStorage-Key statt
 * ein Feld im ohnehin überladenen `settings`-Store.
 *
 * Die Pille folgt zusätzlich der HUD-Sichtbarkeit (Fade auf Desktop /
 * Tap-Toggle auf Mobile) — `on` heißt nur "darf erscheinen", nicht
 * "permanent sichtbar".
 */
const KEY = 'dcc.streamStats';

class StatsVisible {
  #on = $state(false);

  constructor() {
    try {
      this.#on = localStorage.getItem(KEY) === '1';
    } catch {
      /* localStorage kann in privaten Kontexten werfen — Default aus */
    }
  }

  get on(): boolean {
    return this.#on;
  }

  toggle(): void {
    this.#on = !this.#on;
    try {
      localStorage.setItem(KEY, this.#on ? '1' : '0');
    } catch {
      /* ignore quota / private-mode errors */
    }
  }
}

export const statsVisible = new StatsVisible();
