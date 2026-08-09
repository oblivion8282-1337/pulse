/**
 * Wiedergabe-Auflösung einer Watch-Party-Kachel — nur Anzeige, kein Regler.
 *
 * Sitzt zwischen dem Player (via PartyController) und dem Qualitäts-Badge in
 * WatchPartyTile. YouTube verrät die tatsächlich gelieferte Auflösung über
 * getPlaybackQuality() und ändert sie über onPlaybackQualityChange (Adaptive
 * Bitrate — schwankt mit der Leitung, auch mitten im Video). Diese Klasse hält
 * den Roh-Code reaktiv und wandelt ihn in ein lesbares Label. Rein lokal pro
 * Zuschauer: jeder lädt seinen eigenen Stream, der Wert wird bewusst NICHT
 * synchronisiert (wie Lautstärke und Untertitel).
 */

/** Was QualityState vom Player braucht — der PartyController erfüllt das. */
export interface QualityPort {
  getPlaybackQuality(): string | null;
}

/** YouTube-Roh-Code -> Anzeigelabel. Unbekannte Codes fallen auf sich selbst. */
export function qualityLabel(code: string): string {
  return QUALITY_LABELS[code] ?? code;
}

const QUALITY_LABELS: Readonly<Record<string, string>> = {
  highres: 'Max',
  hd2880: '5K',
  hd2160: '4K',
  hd1440: '1440p',
  hd1080: '1080p',
  hd720: '720p',
  large: '480p',
  medium: '360p',
  small: '240p',
  tiny: '144p',
  auto: 'Auto'
};

export class QualityState {
  /** Roh-Code der aktiven Auflösung, null wenn noch nichts bekannt. */
  quality = $state<string | null>(null);
  readonly #port: QualityPort;

  constructor(port: QualityPort) {
    this.#port = port;
  }

  /** Lesbares Label für das Badge, null wenn es nichts anzuzeigen gibt. */
  get label(): string | null {
    return this.quality ? qualityLabel(this.quality) : null;
  }

  /** Auflösung neu einlesen — Aufrufer ist das `quality_changed`-Player-Event. */
  refresh(): void {
    this.quality = this.#port.getPlaybackQuality();
  }

  /** Beim Videowechsel: der alte Player ist weg, seine Auflösung gilt nicht
   *  mehr. Der neue Player meldet seine eigene per quality_changed. */
  reset(): void {
    this.quality = null;
  }
}
