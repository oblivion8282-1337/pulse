/**
 * Welcher eigene Sendefilter läuft — und vor allem: wann KEINER.
 *
 * **Der Grund für diese Datei ist ein Qualitätsfehler, nicht eine neue
 * Funktion.** Bis zum 2026-10-09 hing die Wahl allein an der Einstellung des
 * Nutzers, plattformblind. Auf iOS filterte damit Apples Sprachverarbeitung
 * (hängt am `.voiceChat`-Modus und ist dort nicht abschaltbar) UND darüber
 * RNNoise samt hartem Gate. Zwei Rauschunterdrückungen in Reihe sind eine
 * bekannte Falle: typische Folge sind abgeschnittene Wortanfänge und ein
 * blechern-roboterhafter Klang. Es soll in jeder Konfiguration genau EINER
 * filtern.
 *
 * Die Regel dreht sich also nicht um „iOS ja/nein", sondern um die FRAGE
 * „filtert das System schon?". Das weiss nur die Hülle, und sie sagt es: der
 * Modus kommt aus `setVoiceActive` zurück (`voiceChat` = System filtert,
 * `default` = nicht). Damit stimmt die Rechnung auch auf der
 * Hochqualitäts-Route über Bluetooth, wo Apples Verarbeitung ausgeschaltet
 * ist und RNNoise gebraucht wird.
 *
 * **Der Makeup-Pegel bleibt davon unberührt.** Er ist keine Filterung, sondern
 * eine Verstärkung; wer ihn gesetzt hat, will ihn auch auf iOS.
 *
 * Importfrei und damit prüfbar (s. die `pnpm test:unit`-Falle in CLAUDE.md).
 */

/** Was die Einstellung des Nutzers sagt. Spiegel von `NoiseSuppressionMode`. */
export type Wunsch = 'off' | 'rnnoise_gated';

/** Was tatsächlich installiert wird. `keiner` = Prozessor abbauen. */
export type Filterziel = 'rnnoise_gated' | 'gain_only' | 'keiner';

export interface Filterlage {
  wunsch: Wunsch;
  /** Makeup-Verstärkung; `1` = unverändert. */
  makeup: number;
  /**
   * Filtert das Betriebssystem bereits? Auf iOS im `voiceChat`-Modus ja.
   * Im Browser und auf Android `false` — dort gibt es keine
   * unabschaltbare System-Kette im Sendeweg.
   */
  systemFiltert: boolean;
}

export function filterziel(lage: Filterlage): Filterziel {
  // Das System filtert schon: RNNoise würde ein zweites Mal filtern. Der
  // Makeup-Pegel darf bleiben — er filtert nicht.
  if (lage.systemFiltert) {
    return lage.makeup !== 1 ? 'gain_only' : 'keiner';
  }
  if (lage.wunsch === 'rnnoise_gated') return 'rnnoise_gated';
  return lage.makeup !== 1 ? 'gain_only' : 'keiner';
}
