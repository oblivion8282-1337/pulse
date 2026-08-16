/**
 * Standplatz-Geräte — **die Übertragungs-Einstellungen für den Fernbetrieb**.
 *
 * ## Warum ein eigenes Profil
 *
 * Bis hierher galt: wer überträgt, entscheidet. Das war richtig, solange „wer
 * entscheidet" und „wer sitzt davor" dieselbe Person waren — es ist sein
 * Rechner, seine Leitung, seine Wahl. Bei einem Standplatz-Gerät fallen die
 * beiden Rollen auseinander: entschieden hat der Besitzer irgendwann einmal,
 * gebraucht wird das Bild von jemand anderem, jetzt, für eine bestimmte
 * Aufgabe. Ohne dieses Profil startet ein geweckter Rechner mit dem, was
 * zuletzt für einen ganz anderen Zweck eingestellt war — im schlimmsten Fall
 * „4K, 60 fps, HDR" vom Vorführen, also ausgerechnet die schlechteste
 * Einstellung zum Fernsteuern.
 *
 * ## Warum die Vorgaben so sind, wie sie sind
 *
 * Fernsteuern und Zuschauen wollen Gegensätzliches. Zuschauen will flüssige
 * Bewegung; Fernsteuern will **lesbare Schrift und kurze Wege**. Deshalb:
 *
 * * **Auflösung `Native`** — die eine Einstellung, an der alles hängt.
 *   Skaliertes Bild macht Menütexte und Dateinamen unlesbar, und dann rät man
 *   auf einem fremden Rechner.
 * * **30 Bilder/s** statt 60. Wer arbeitet, bewegt selten etwas Flüssiges, und
 *   die Hälfte der Bilder heisst doppelt so viele Bits je Bild — also
 *   schärfere Schrift bei gleicher Bitrate.
 * * **H.264** als Vorgabe: läuft in jedem Browser und geht immer über den
 *   WHIP-Weg, der als einziger einen Rückkanal hat (`pushProtokoll`). AV1 bleibt
 *   wählbar — es halbiert die Bitrate —, ist aber nicht die Vorgabe für einen
 *   Rechner, den man blind weckt.
 * * **Hauptbildschirm** statt eines gemerkten `Monitor: 2`. Ein Rechner, vor
 *   dem niemand sitzt, darf nicht auf einen Schirm zeigen, den jemand vor
 *   Monaten gewählt hat.
 * * **Kein HDR, keine 10 bit.** HDR bricht den Start ab, wenn es der Schirm
 *   gerade nicht kann, und sieht beim Steuernden auf einem gewöhnlichen
 *   Bildschirm ausgewaschen aus.
 *
 * ## Was das Profil NICHT ist
 *
 * Es ist **kein Wunsch des Steuernden**. Der Besitzer stellt es ein, einmal;
 * wer das Gerät übernimmt, bekommt, was dort steht. Das ist die bewusste
 * Entscheidung (2026-08-16): der Rechner gehört jemandem, und die Leitung, die
 * er belegt, auch. Ein Wunsch im Weckruf — vom Steuernden geäussert, vom Gerät
 * geklemmt — bliebe der nächste Schritt, wenn sich zeigt, dass eine feste
 * Einstellung für zu viele Aufgaben zu grob ist.
 *
 * Gespeichert wird wie die Dauerfreigabe: gerätelokal
 * (`pulse-stream.json`), nicht auf dem Server.
 */

import { loadAll, saveAll } from '$lib/stream/persistence';
import type { OverrideSet } from '$lib/stream/settingsCatalog';

const SPEICHER_SCHLUESSEL = 'remote.standplatzProfil';

/** Aufnahmequelle „Hauptbildschirm" — der Windows-Sidecar deutet `monitor`,
 *  `portal` und die leere Zeichenkette alle als primären Schirm
 *  (`ops/start.rs::parse_capture`). Ausgeschrieben, weil `portal` unter Linux
 *  einen Dialog öffnet und auf einem unbeaufsichtigten Rechner niemand
 *  klickt. */
export const HAUPTBILDSCHIRM = 'monitor';

export interface StandplatzProfil {
  /** Aufnahmequelle: [`HAUPTBILDSCHIRM`] oder `Monitor: <n>`. */
  quelle: string;
  codec: 'h264' | 'av1';
  /** Wert aus `RESOLUTION_VALUES` (`Native`, `1440p`, …). */
  aufloesung: string;
  fps: number;
  bitrate_kbps: number;
  /**
   * Rollender Intra-Refresh statt periodischer Vollbilder.
   *
   * **Warum das hier steht und nicht dem Sidecar überlassen bleibt:** ohne
   * eigenes Feld entschied die Voreinstellung des Sidecars, und der Besitzer
   * hatte für den Fernbetrieb gar keine Wahl — obwohl gerade dort viel davon
   * abhängt. Ein periodisches Vollbild ist bei 30 Bildern je Sekunde ein
   * Brocken, der die Leitung für einen Moment dichtmacht (gemessen: 170–247 KB
   * alle gut zwei Sekunden bei 2,5 Mbit/s); Intra-Refresh verteilt dieselbe
   * Auffrischung über viele Bilder und hält den Fluss gleichmässig. Ausserdem
   * hängt der Sendeweg daran: mit Intra-Refresh geht auch AV1 über WHIP, den
   * einzigen Weg mit Rückkanal (`pushProtokoll`).
   *
   * **Vorgabe ist trotzdem AUS.** Kann der Encoder es nicht, verweigert der
   * Sidecar den Start, statt heimlich etwas anderes zu fahren
   * (`encode/auffrischung.rs`) — auf einem Rechner, vor dem niemand sitzt,
   * wäre ein verweigerter Start ein Weckruf, der wortlos ins Leere läuft. Wer
   * es einschaltet, hat es vorher an seinem Gerät ausprobiert.
   */
  intra_refresh: boolean;
}

/** Die Vorgaben — Begründung im Modulkopf. */
export const VORGABE: StandplatzProfil = {
  quelle: HAUPTBILDSCHIRM,
  codec: 'h264',
  aufloesung: 'Native',
  fps: 30,
  bitrate_kbps: 8000,
  intra_refresh: false,
};

function ausSpeicher(roh: unknown): StandplatzProfil {
  if (!roh || typeof roh !== 'object') return { ...VORGABE };
  const o = roh as Record<string, unknown>;
  return {
    quelle: typeof o.quelle === 'string' && o.quelle ? o.quelle : VORGABE.quelle,
    codec: o.codec === 'av1' ? 'av1' : 'h264',
    aufloesung:
      typeof o.aufloesung === 'string' && o.aufloesung ? o.aufloesung : VORGABE.aufloesung,
    fps: typeof o.fps === 'number' && o.fps > 0 ? o.fps : VORGABE.fps,
    bitrate_kbps:
      typeof o.bitrate_kbps === 'number' && o.bitrate_kbps > 0
        ? o.bitrate_kbps
        : VORGABE.bitrate_kbps,
    intra_refresh: o.intra_refresh === true,
  };
}

class StandplatzProfilStore {
  profil = $state<StandplatzProfil>({ ...VORGABE });

  /** Beim Start einmal rufen, zusammen mit der Dauerfreigabe. */
  async laden(vorgeladen?: Record<string, unknown>): Promise<void> {
    try {
      const alle = vorgeladen ?? (await loadAll());
      this.profil = ausSpeicher(alle[SPEICHER_SCHLUESSEL]);
    } catch {
      this.profil = { ...VORGABE };
    }
  }

  async setzen(neu: StandplatzProfil): Promise<void> {
    this.profil = { ...neu };
    try {
      await saveAll({ [SPEICHER_SCHLUESSEL]: this.profil });
    } catch {
      // Wie überall in der Persistenz: der Stand im Speicher gilt weiter.
    }
  }

  /**
   * Das Profil als Übersteuerungs-Satz, wie ihn `buildStartArgs` erwartet.
   *
   * **HDR und Farbtiefe fehlen hier absichtlich** und nicht aus Versehen: ein
   * `hdr: true`, das der Rechner gerade nicht einlösen kann, bricht den Start
   * ab — auf einem Gerät, das niemand beaufsichtigt, wäre das ein Weckruf, der
   * wortlos ins Leere läuft.
   */
  alsUebersteuerung(): OverrideSet {
    const p = this.profil;
    return {
      codec: p.codec,
      resolution: p.aufloesung,
      fps: p.fps,
      bitrate_kbps: p.bitrate_kbps,
      // **Immer gesetzt, auch als `false`.** Ein fehlendes Feld heisst „der
      // Sidecar entscheidet", und der behält dann die Betriebsart des vorigen
      // Laufs (prozessweite Variable, s. `buildStartArgs`). Auf einem Gerät,
      // das mehrmals am Tag geweckt wird, wäre das eine Einstellung, die von
      // der Vorgeschichte abhängt statt vom Profil.
      intra_refresh: p.intra_refresh,
    };
  }
}

export const standplatzProfil = new StandplatzProfilStore();
