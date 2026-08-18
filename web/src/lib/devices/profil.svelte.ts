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
 * * **H.264** als Vorgabe: läuft in jedem Browser. AV1 bleibt wählbar — es
 *   halbiert die Bitrate —, ist aber nicht die Vorgabe für einen Rechner, den
 *   man blind weckt. (Am Sendeweg hängt das seit dem 2026-08-18 nicht mehr:
 *   `pushProtokoll` nimmt für jeden Codec WHIP.)
 * * **Hauptbildschirm** statt eines gemerkten `Monitor: 2`. Ein Rechner, vor
 *   dem niemand sitzt, darf nicht auf einen Schirm zeigen, den jemand vor
 *   Monaten gewählt hat.
 * * **Intra-Frame an, HDR und 10 bit aus** — alle drei sind wählbar. Der
 *   Intra-Frame nützt dem Fernbetrieb (kein Vollbild-Stoss alle zwei
 *   Sekunden), HDR schadet ihm eher: der Steuernde sitzt meist vor einem
 *   gewöhnlichen Bildschirm und sieht das Bild dort ausgewaschen.
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

/**
 * Merker der einmaligen Intra-Refresh-Bereinigung vom 2026-08-18.
 *
 * Bis dahin war Intra-Refresh hier die Vorgabe. Mit dem Vollbild-Abstand von
 * 60 s ist es die schlechtere Wahl (gemessen: +1,87 VMAF bei 16 % weniger
 * Daten ohne), und fuer einen unbeaufsichtigten Rechner zusaetzlich das
 * fehlende Auffangnetz — ein Intra-Refresh-Strom heilt sich nach Paketverlust
 * nicht selbst. Ein gespeichertes `true` stammt aus der alten Lage; ohne diese
 * Bereinigung erreichte die neue Vorgabe kein einziges bestehendes Geraet.
 *
 * **Eigener Schluessel statt eines Feldes im Profil:** das Profil ist die Wahl
 * des Nutzers und wird als Ganzes geschrieben — ein Buchfuehrungs-Haken darin
 * waere ein Feld, das bei jedem Speichern mitreist und in `ausSpeicher`
 * gepflegt werden muesste.
 */
const BEREINIGT_SCHLUESSEL = 'remote.standplatzProfilIntraBereinigt';

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
   * Auffrischung über viele Bilder und hält den Fluss gleichmässig. (Der
   * Sendeweg hing bis zum 2026-08-18 mit daran — inzwischen nimmt
   * `pushProtokoll` ohnehin für jeden Codec WHIP, der Haken entscheidet also
   * nur noch über die Betriebsart selbst.)
   *
   * **Vorgabe ist seit dem 2026-08-18 wieder AUS**, und der Grund ist gemessen:
   * der reguläre Vollbild-Abstand steht seither auf 60 s statt 2 s, und damit
   * kippt die Abwägung. An der echten Leitung nachgemessen (drei Mitschnitte,
   * `KEYFRAME_SEKUNDEN_VORGABE` im Linux-Sidecar nennt die Tabelle) liefert der
   * lange Takt bei 2000 kbps **+1,87 VMAF bei 16 % weniger Daten** als
   * Intra-Refresh (95,16 gegen 93,29 bei 1687 gegen 1999 kbit/s) — die
   * Vollbild-Stösse kommen selten genug, dass der Vorteil der verteilten
   * Auffrischung sie nicht mehr aufwiegt.
   *
   * Dazu der Punkt, der für einen unbeaufsichtigten Rechner besonders zählt:
   * **ein Intra-Refresh-Strom heilt sich nach einem Paketverlust NICHT selbst**
   * (2026-07-29: eine verworfene Zugriffseinheit lässt das Bild dauerhaft
   * stehen, Erholung nie), ein Vollbild-Strom heilt am nächsten Takt
   * byte-perfekt. Wo niemand sitzt, der neu verbindet, ist dieses Auffangnetz
   * mehr wert als eine gleichmässigere Leitung.
   *
   * Der Haken bleibt wählbar — wer eine sehr dünne Leitung hat, für den kann
   * die gleichmässigere Verteilung weiter die bessere Wahl sein.
   *
   * **Die frühere Begründung für AN, zum Nachlesen:** Der Einwand — kann der Encoder
   * es nicht, verweigert der Sidecar den Start (`encode/auffrischung.rs`), und
   * auf einem unbeaufsichtigten Rechner liest niemand die Absage — trägt nicht
   * mehr: der Haken geht nur hinaus, wenn der Sidecar die Fähigkeit gemeldet
   * hat (`buildStartArgs` prüft gegen `stream.intraRefreshAvailable`). Kann der
   * Rechner es nicht, wird ohne gesendet statt gar nicht. Damit überwiegt der
   * Nutzen: ruhige Leitung statt Vollbild-Stössen, und der Rückkanal-Weg.
   */
  intra_refresh: boolean;
  /**
   * 10 bit Farbtiefe — **nur mit AV1** und nur, wenn die Karte es kann.
   *
   * Wählbar seit 2026-08-16, vorher fest aus. Die Begründung dagegen war die
   * Startverweigerung, und die trägt nicht: sie gilt für die rollende
   * Auffrischung genauso, und die ist wählbar. Wer ein Gerät einrichtet, sitzt
   * davor und kann es ausprobieren; entscheiden soll er.
   *
   * **Ein nicht erfüllbarer Wunsch stoppt trotzdem keinen Weckruf** — der Wert
   * geht nur hinaus, wenn er im Moment des Weckens auch einlösbar ist
   * (`buildStartArgs`). Er bleibt gespeichert, greift also wieder, sobald der
   * Rechner es kann; ein Treiberwechsel macht das Gerät damit nicht unweckbar.
   */
  zehn_bit: boolean;
  /**
   * HDR (PQ/BT.2020) — **nur mit AV1 in 10 bit**, nur unter Windows, nur wenn
   * der Encoder es meldet.
   *
   * Dieselbe Linie wie [`zehn_bit`]: die Wahl gehört dem Besitzer, die
   * Erfüllbarkeit prüft der Weckruf. Zu bedenken bleibt, was HDR beim
   * Steuernden anrichtet, wenn dessen Bildschirm keines kann — dort sieht das
   * Bild ausgewaschen aus. Deshalb Vorgabe aus, aber kein Verbot.
   */
  hdr: boolean;
}

/** Die Vorgaben — Begründung im Modulkopf. */
export const VORGABE: StandplatzProfil = {
  quelle: HAUPTBILDSCHIRM,
  codec: 'h264',
  aufloesung: 'Native',
  fps: 30,
  bitrate_kbps: 8000,
  intra_refresh: false,
  zehn_bit: false,
  hdr: false,
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
    zehn_bit: o.zehn_bit === true,
    hdr: o.hdr === true,
  };
}

class StandplatzProfilStore {
  profil = $state<StandplatzProfil>({ ...VORGABE });

  /** Beim Start einmal rufen, zusammen mit der Dauerfreigabe. */
  async laden(vorgeladen?: Record<string, unknown>): Promise<void> {
    try {
      const alle = vorgeladen ?? (await loadAll());
      this.profil = ausSpeicher(alle[SPEICHER_SCHLUESSEL]);
      // Genau einmal (s. `BEREINIGT_SCHLUESSEL`): wer den Haken danach wieder
      // setzt, behaelt ihn. Der Merker wird auch dann geschrieben, wenn nichts
      // zu bereinigen war — sonst liefe die Pruefung bei jedem Start erneut.
      if (alle[BEREINIGT_SCHLUESSEL] !== true) {
        const musste = this.profil.intra_refresh;
        if (musste) this.profil = { ...this.profil, intra_refresh: false };
        await saveAll({
          [BEREINIGT_SCHLUESSEL]: true,
          ...(musste ? { [SPEICHER_SCHLUESSEL]: this.profil } : {}),
        });
      }
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
   * **Farbtiefe und HDR reisen als WUNSCH mit** (seit 2026-08-16), nicht als
   * Befehl: `buildStartArgs` schickt sie nur hinaus, wenn sie im Moment des
   * Weckens auch einlösbar sind (AV1, passende Karte, gemeldete Fähigkeit).
   * Ein `hdr: true`, das der Rechner gerade nicht kann, bräche den Start ab —
   * und auf einem Gerät, vor dem niemand sitzt, liefe der Weckruf wortlos ins
   * Leere. Der gespeicherte Wunsch bleibt davon unberührt und greift wieder,
   * sobald die Karte es hergibt.
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
      // Nur der Wunsch. Die Prüfung „kann die Karte das gerade" steht in
      // `buildStartArgs` — dort ist sie für den Knopf des Besitzers und für den
      // Weckruf dieselbe, und es gibt sie nur einmal.
      ...(p.zehn_bit ? { bit_depth: 10 as const } : {}),
      ...(p.hdr ? { hdr: true } : {}),
    };
  }
}

export const standplatzProfil = new StandplatzProfilStore();
