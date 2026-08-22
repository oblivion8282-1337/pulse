//! AV1 in RTP-Pakete zerlegen.
//!
//! **Warum von Hand und nicht aus dem `rtp`-Crate.** Dessen `Av1Payloader`
//! schreibt Laengenfelder falsch. Die Ursache liegt in genau einer Funktion:
//! `encode_leb128` packt die Sieben-Bit-Gruppen in Acht-Bit-Faecher (474 wird
//! zu `0xDA03`), und `put_leb128` behandelt dieses Ergebnis anschliessend
//! nochmal als Zahl, die zu kodieren waere. Am 2026-07-28 nachgerechnet:
//!
//! | Wert | Crate schreibt | richtig | Crate liest zurueck |
//! |---|---|---|---|
//! | 127 | `7F` | `7F` | 127 |
//! | 128 | `81 80 02` | `80 01` | 32769 |
//! | 474 | `83 B4 03` | `DA 03` | 55811 |
//! | 16383 | `FF FE 03` | `FF 7F` | 65407 |
//!
//! Zwei Dinge daran sind wichtig. Erstens ist die LESENDE Haelfte desselben
//! Crates korrekt (`read_leb128` gibt fuer richtige Bytes richtige Werte) — es
//! ist also nicht "das Crate kann kein LEB128", sondern eine Funktion. Zweitens
//! stimmt alles unter 128, und OBU-Elemente unter 128 Byte gibt es reichlich.
//! Ein fluechtiger Test faellt darauf herein.
//!
//! Grundlage: <https://aomediacodec.github.io/av1-rtp-spec/>, Abschnitte 4.4,
//! 4.5 und 5.

use anyhow::{Result, bail};

/// Zeitweiliger Kopf der Nutzlast (`Z|Y|W W|N|-|-|-`) plus die Nutzlast selbst
/// passen in ein UDP-Paket, das ueberall durchkommt. 1200 ist derselbe Wert,
/// den webrtc-rs fuer seine eigenen Paketierer nimmt.
pub const MTU: usize = 1200;

/// Takt der RTP-Uhr fuer Video. Steht hier und nicht zweimal ausgeschrieben,
/// weil derselbe Wert im SDP als `clock_rate` angemeldet wird — laufen die
/// beiden auseinander, rechnet der Empfaenger die Zeitstempel falsch um, ohne
/// dass irgendetwas scheitert.
pub const RTP_TAKT_HZ: u32 = 90_000;

/// Groesser als drei Elemente je Paket bringt nichts: `W` ist zwei Bit breit,
/// darueber muss `W=0` gesetzt und JEDES Element mit Laengenfeld versehen
/// werden. Ein Zeitabschnitt besteht ohnehin aus zwei bis drei OBUs
/// (Zeittrenner — wird entfernt —, ggf. Sequenzkopf, Bild).
const MAX_ELEMENTE: usize = 3;

/// Der Aggregationskopf `Z|Y|W W|N|-|-|-` steht in jedem Paket (Abschnitt 4.4).
const AGGREGATIONSKOPF: usize = 1;

/// Fuers Laengenfeld eines Elements zurueckgelegte Bytes. Ein Element ist nie
/// groesser als die MTU, also reichen zwei immer; wird es am Ende eines, bleibt
/// das Paket ein Byte kuerzer als geplant — kein Schaden, nur ein Byte
/// ungenutzt.
const LAENGENFELD_RESERVE: usize = 2;

const OBU_SEQUENZKOPF: u8 = 1;
const OBU_ZEITTRENNER: u8 = 2;
const OBU_BILDKOPF: u8 = 3;
const OBU_BILD: u8 = 6;
const OBU_KACHELLISTE: u8 = 8;
/// Fuellbytes. Laut Spezifikation ein reines No-op — der Decoder ueberspringt
/// sie. Sie DUERFEN nicht auf die Leitung.
///
/// **Warum das hier der wichtigste Filter ist, obwohl er nach Kleinigkeit
/// aussieht.** Mesas VAAPI-Encoder fuellt bei CBR auf die Zielrate auf, sobald
/// der Inhalt sie nicht ausschoepft — und genau das ist der Pulse-Fall:
/// gemessen am 2026-08-03 auf einer Radeon 780M (Mesa 26.1.5), 1080p60 bei
/// 4000 kbps, je vier Sekunden:
///
/// | Inhalt | Bilder mit Fuellung | je Stueck | Anteil am Bitstrom |
/// |---|---|---|---|
/// | statischer Schirm | 225 von 240 | 7677-8301 B | **99,6 %** |
/// | Bildschirmarbeit | 221 von 240 | 2045-6514 B | **66 %** |
/// | Vollbewegung | 0 | — | 0 % |
///
/// Ohne diesen Filter wird jedes ~8-KB-Fuell-OBU ueber rund sieben RTP-Pakete
/// zerteilt: 6,6 statt 1 Paket je Bild, 3,75 statt 0,01 Mbit/s auf der Leitung.
/// Und libwebrtcs Wiederzusammenbau kommt damit nicht klar — der Befund steht
/// im Kopf von `infra/mediamtx-fork/patches/0001-rtmp-inject-temporal-delimiter.patch`
/// bereits im Repo: die Referenzkette bricht rund zwanzig Bilder nach jedem
/// Gruppenanfang. Dieser Patch heilt aber nur den RTMP-Weg; der WHIP-Weg geht
/// ohne jeden Filter aus dem Encoder in `paketiere`.
///
/// **NVENC fuellt nicht auf** — derselbe Code, andere Eingabe. Genau deshalb
/// lief der Weg auf NVIDIA und riss auf AMD.
///
/// Die Referenzumsetzung des Formats verwirft dieselben drei Typen
/// (`vendor/webrtc-rs/rtp/src/codecs/av1/obu.rs::should_ignore_obu_type`).
const OBU_FUELLUNG: u8 = 15;

/// Ein OBU ohne sein Groessenfeld.
///
/// Die Nutzlast bleibt eine Ausleihe auf das Encoder-Paket — nur der ein bis
/// zwei Byte grosse Kopf wird kopiert, weil in ihm ein Bit zu loeschen ist.
/// Deshalb kostet das Paketieren keine Kopie des Bildes.
struct Obu<'a> {
    kopf: [u8; 2],
    kopf_len: usize,
    rumpf: &'a [u8],
    typ: u8,
}

impl Obu<'_> {
    fn len(&self) -> usize {
        self.kopf_len + self.rumpf.len()
    }

    /// `[von, bis)` dieses OBU an `ziel` anhaengen. Der Bereich kann ueber die
    /// Grenze zwischen Kopf und Rumpf laufen — beim Fragmentieren ist genau das
    /// der Normalfall.
    fn schreibe(&self, ziel: &mut Vec<u8>, von: usize, bis: usize) {
        let kopf_bis = bis.min(self.kopf_len);
        if von < kopf_bis {
            ziel.extend_from_slice(&self.kopf[von..kopf_bis]);
        }
        let rumpf_von = von.saturating_sub(self.kopf_len);
        let rumpf_bis = bis.saturating_sub(self.kopf_len);
        if rumpf_von < rumpf_bis {
            ziel.extend_from_slice(&self.rumpf[rumpf_von..rumpf_bis]);
        }
    }
}

fn lies_leb128(daten: &[u8]) -> Result<(u32, usize)> {
    let mut wert: u64 = 0;
    for (i, b) in daten.iter().take(8).enumerate() {
        wert |= u64::from(b & 0x7F) << (i * 7);
        if b & 0x80 == 0 {
            return Ok((wert as u32, i + 1));
        }
    }
    bail!("LEB128 ohne Abschluss")
}

fn schreibe_leb128(ziel: &mut Vec<u8>, mut wert: u32) {
    loop {
        let b = (wert & 0x7F) as u8;
        wert >>= 7;
        if wert == 0 {
            ziel.push(b);
            return;
        }
        ziel.push(b | 0x80); // 0x80 = "es folgt noch eine Gruppe"
    }
}

/// Den Zeitabschnitt in OBUs zerlegen, dabei das Groessenfeld entfernen und
/// `obu_has_size_field` loeschen.
///
/// Die Spezifikation sagt dazu "SHOULD be set to zero in all OBUs" — das
/// Laengenfeld der RTP-Nutzlast traegt die Groesse bereits, das Feld im OBU
/// waere die zweite Angabe derselben Sache. Der Empfaenger setzt es beim
/// Zusammensetzen wieder ein (im eigenen Player `depacket/av1.rs`).
///
/// Zeittrenner und Kachellisten fallen weg (Abschnitt 5): der Zeittrenner ist
/// im RTP-Strom ueberfluessig, weil der Zeitstempel den Abschnitt schon trennt.
fn zerlege(daten: &[u8]) -> Result<Vec<Obu<'_>>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < daten.len() {
        let b0 = daten[i];
        let typ = (b0 >> 3) & 0x0F;
        let hat_erweiterung = (b0 >> 2) & 1 == 1;
        let hat_groesse = (b0 >> 1) & 1 == 1;
        let kopf_len = 1 + usize::from(hat_erweiterung);
        if i + kopf_len > daten.len() {
            bail!("OBU-Kopf reicht ueber das Paketende");
        }
        let mut kopf = [0u8; 2];
        kopf[..kopf_len].copy_from_slice(&daten[i..i + kopf_len]);
        kopf[0] &= !0b10; // obu_has_size_field loeschen

        let (rumpf_start, rumpf_len) = if hat_groesse {
            let (len, gelesen) = lies_leb128(&daten[i + kopf_len..])?;
            (i + kopf_len + gelesen, len as usize)
        } else {
            // Ohne Groessenfeld reicht das OBU bis zum Ende — nur fuer das
            // letzte zulaessig. Was danach kaeme, waere ohnehin nicht mehr
            // auffindbar. Der Rumpf endet dann per Konstruktion genau am
            // Paketende, die Pruefung darunter kann hier nicht greifen.
            (i + kopf_len, daten.len() - i - kopf_len)
        };
        if rumpf_start + rumpf_len > daten.len() {
            bail!("OBU-Groesse {rumpf_len} reicht ueber das Paketende");
        }

        if typ != OBU_ZEITTRENNER && typ != OBU_KACHELLISTE && typ != OBU_FUELLUNG {
            out.push(Obu {
                kopf,
                kopf_len,
                rumpf: &daten[rumpf_start..rumpf_start + rumpf_len],
                typ,
            });
        }
        i = rumpf_start + rumpf_len;
    }
    Ok(out)
}

/// Ist dieses OBU ein echtes Vollbild — also ein Einstiegspunkt?
///
/// Gelesen werden die ersten drei Bit des unkomprimierten Bildkopfes:
/// `show_existing_frame` (1 Bit) muss 0 sein (sonst wird nur ein bereits
/// decodierter Puffer erneut gezeigt) und `frame_type` (2 Bit) muss
/// `KEY_FRAME` (0) sein.
///
/// **Warum das nicht am Sequenzkopf abzulesen ist** (Windows-Labor,
/// 2026-08-02): `av1_amf` schreibt an jedem GOP-Rand einen Sequenzkopf, ohne
/// dass ein Vollbild folgt — gemessen 6 Sequenzkoepfe auf 1 Vollbild in 360
/// Bildern. Wer den Kopf als Einstiegspunkt nimmt, schickt den Zuschauer
/// fuenfmal auf ein Zwischenbild.
///
/// Auf `av1_nvenc` faellt das nicht auf, weil der Encoder den Kopf nur vor
/// Vollbildern schreibt (am 2026-08-02 auf dieser Karte nachgemessen: 0
/// Faelle). Das ist eine Eigenschaft dieses einen Encoders, keine des Formats
/// — und der Paketierer darf sich nicht darauf verlassen.
///
/// Das Feld `reduced_still_picture_header` wuerde dieses Bit-Layout aendern; es
/// gilt nur fuer Einzelbild-Streams und kann in einem Live-Strom nicht
/// auftreten.
fn ist_vollbild(obu: &Obu<'_>) -> bool {
    if obu.typ != OBU_BILD && obu.typ != OBU_BILDKOPF {
        return false;
    }
    let Some(&b) = obu.rumpf.first() else {
        return false;
    };
    b & 0x80 == 0 && (b >> 5) & 0b11 == 0
}

/// Platz, der im laufenden Paket noch fuer Nutzdaten bleibt.
fn frei_im_paket(mtu: usize, belegt: usize) -> usize {
    mtu.saturating_sub(belegt + LAENGENFELD_RESERVE)
}

/// Ein Stueck eines OBU, das in ein bestimmtes Paket geht.
struct Stueck {
    obu: usize,
    von: usize,
    bis: usize,
}

/// Die fertige Nutzlast eines RTP-Pakets samt Markierung.
pub struct Nutzlast {
    pub daten: Vec<u8>,
    /// Letztes Paket des Zeitabschnitts — setzt das Marker-Bit (Abschnitt 4.2).
    pub letztes: bool,
    /// Erstes Paket des Zeitabschnitts — Bildanfang der Bildmarke.
    pub erstes: bool,
    /// Gehoert zu einem Vollbild. Je Bild gleich und trotzdem an jedem Paket:
    /// die Bildmarke braucht es an jedem, weil die Schablonen-Tabelle auf
    /// jedem Vollbild-Paket steht (dem `bildmarke`-Modul des jeweiligen Sidecars).
    pub vollbild: bool,
}

/// Einen Zeitabschnitt (ein encodiertes Bild, wie FFmpeg es liefert) in
/// RTP-Nutzlasten zerlegen.
pub fn paketiere(daten: &[u8], mtu: usize) -> Result<Vec<Nutzlast>> {
    let mut obus = zerlege(daten)?;
    // Einen Sequenzkopf ohne Vollbild gar nicht erst senden. Das N-Bit allein
    // zurueckzuhalten reicht NICHT: Chromium leitet den Einstiegspunkt auch aus
    // der blossen Anwesenheit des Kopfes ab und zaehlte im Windows-Labor
    // weiterhin 8 Vollbilder statt 1. Erst das Weglassen hat es beendet.
    //
    // Ungefaehrlich, weil der Kopf in jedem echten Vollbild ohnehin mitsteht:
    // ein spaet hinzukommender Zuschauer braucht bei 60 s Vollbild-Abstand
    // sowieso eine Vollbild-Anforderung, und die liefert ihn mit.
    // Einmal bestimmt, an jedes Paket gehaengt: die Bildmarke waehlt daran ihre
    // Schablone und entscheidet, ob die Tabelle mitgeht.
    let vollbild = obus.iter().any(ist_vollbild);
    if !vollbild {
        obus.retain(|o| o.typ != OBU_SEQUENZKOPF);
    }
    if obus.is_empty() {
        return Ok(Vec::new());
    }
    // Nach dem Aussortieren oben steht ein Sequenzkopf nur noch bei einem
    // echten Vollbild — die Anwesenheit ist hier also wieder das richtige
    // Kriterium.
    let mut sequenzkopf_offen = obus.iter().any(|o| o.typ == OBU_SEQUENZKOPF);

    let mut pakete: Vec<Nutzlast> = Vec::new();
    let mut stuecke: Vec<Stueck> = Vec::new();
    let mut belegt = AGGREGATIONSKOPF;
    let mut z = false; // erstes Stueck setzt eine Zerteilung fort

    for (i, obu) in obus.iter().enumerate() {
        let mut off = 0;
        // Ein OBU kann sich ueber mehrere Pakete ziehen: jeder Durchgang legt
        // ein Stueck ab und schliesst das Paket ab, sobald es voll ist.
        loop {
            let nimm = frei_im_paket(mtu, belegt).min(obu.len() - off);
            if nimm > 0 {
                stuecke.push(Stueck { obu: i, von: off, bis: off + nimm });
                belegt += LAENGENFELD_RESERVE + nimm;
                off += nimm;
            }
            // `rest` ist zugleich das `Y` dieses Pakets und das `Z` des
            // naechsten: das Stueck wird dort fortgesetzt.
            let rest = off < obu.len();
            let voll = stuecke.len() >= MAX_ELEMENTE || frei_im_paket(mtu, belegt) == 0;
            if !rest && !voll {
                break; // dieses OBU ist durch, im selben Paket geht noch was
            }
            pakete.push(baue(&obus, &stuecke, z, rest, &mut sequenzkopf_offen));
            stuecke.clear();
            belegt = AGGREGATIONSKOPF;
            z = rest;
            if !rest {
                break;
            }
        }
    }
    if !stuecke.is_empty() {
        pakete.push(baue(&obus, &stuecke, z, false, &mut sequenzkopf_offen));
    }
    if let Some(f) = pakete.first_mut() {
        f.erstes = true;
    }
    if let Some(l) = pakete.last_mut() {
        l.letztes = true;
    }
    for p in &mut pakete {
        p.vollbild = vollbild;
    }
    Ok(pakete)
}

/// Ein Paket aus den gesammelten Stuecken zusammensetzen.
///
/// `sequenzkopf_offen` wird beim ersten Paket geleert: `N` bedeutet "erstes
/// Paket einer codierten Bildfolge", nicht "enthaelt einen Sequenzkopf" — und
/// die Spezifikation haelt fest, dass bei `N=1` auch `Z=0` sein muss.
fn baue(
    obus: &[Obu<'_>],
    stuecke: &[Stueck],
    z: bool,
    y: bool,
    sequenzkopf_offen: &mut bool,
) -> Nutzlast {
    let n = *sequenzkopf_offen && !z;
    if n {
        *sequenzkopf_offen = false;
    }

    // `W` = Anzahl der Elemente, wenn sie in zwei Bit passt. Dann traegt das
    // LETZTE Element kein Laengenfeld — seine Groesse ergibt sich aus dem Rest
    // des Pakets. Sonst `W=0` und jedes Element bekommt eines.
    let w = if stuecke.len() <= MAX_ELEMENTE { stuecke.len() } else { 0 };

    let mut daten = Vec::with_capacity(MTU);
    daten.push(
        u8::from(z) << 7 | u8::from(y) << 6 | ((w as u8) & 0b11) << 4 | u8::from(n) << 3,
    );
    for (k, s) in stuecke.iter().enumerate() {
        let letztes = k + 1 == stuecke.len();
        if w == 0 || !letztes {
            schreibe_leb128(&mut daten, (s.bis - s.von) as u32);
        }
        obus[s.obu].schreibe(&mut daten, s.von, s.bis);
    }
    Nutzlast { daten, letztes: false, erstes: false, vollbild: false }
}

/// Fortlaufender Spur-Zustand: Sequenznummern + Zeitstempel.
///
/// Beides gehoert hierher und nicht in den Encode-Faden: `TrackLocalStaticRTP`
/// vergibt weder Sequenznummern noch Zeitstempel — es ueberschreibt nur SSRC
/// und Payload-Typ je Bindung.
///
/// Codec-frei: seit 2026-08-14 stempelt auch die H.264-Spur hierueber
/// (s. Modulkopf von [`super`]) — genau das Fehlen dieser Rechnung war der
/// H.264-Judder. Er wohnt weiter in `av1.rs`, weil der AV1-Paketierer sein
/// erster und dokumentierender Nutzer ist.
pub struct SpurZustand {
    seq: u16,
    /// Ersatz-Takt, falls ein Encoder-Paket ausnahmsweise KEINEN `pts` traegt.
    /// Zaehlt dann dort weiter, wo der letzte Zeitstempel lag — sonst laegen
    /// zwei Bilder auf derselben Uhrzeit.
    ersatz_takt: u64,
    fps: u32,
    /// Laufende Bildnummer fuer die Bildmarke. Laeuft bei 65536 um.
    bildnummer: u16,
}

impl SpurZustand {
    pub fn neu(fps: u32) -> Self {
        // Zufaelliger Startpunkt fuer die Sequenznummern, wie es auch
        // webrtc-rs' eigener Zaehler macht. Die Uhr reicht dafuer — eine
        // Zufallsquelle waere hier eine Abhaengigkeit fuer nichts.
        let seq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos() as u16);
        Self { seq, ersatz_takt: 0, fps, bildnummer: 0 }
    }

    /// RTP-Zeitstempel DIESES Bildes, aus dem `pts` des Encoder-Pakets.
    ///
    /// **Hier stand bis 2026-08-03 ein reiner Bildzaehler** (`bilder * 90000 /
    /// fps`, danach `bilder += 1`) — und das war falsch, sobald ein Bild
    /// wegfiel. Der Pacing-Loop leitet den echten `pts` aus `record_start` ab
    /// und protokolliert selbst, dass er springt und klemmt
    /// (`stream_controller.rs`, `pts_gaps`/`pts_clamps`); dazu verwirft
    /// `send_hw` bei anhaltendem EAGAIN ganze Bilder. Jedes so verlorene Bild
    /// liess den Zaehler hinter der Wanduhr zurueckfallen, waehrend die
    /// Tonspur mit echten Opus-Dauern weiterlief: wachsende Bild-Ton-
    /// Verschiebung und ein Jitter-Puffer, der beim Zuschauer immer weiter
    /// auflaeuft. Auf einer iGPU bei 1440p60 — also genau dort, wo der Encoder
    /// die Bildrate nicht immer haelt — faellt das sofort auf.
    ///
    /// **Seit 2026-08-14 ist das eine Identitaet, und das ist der Zweck.** Der
    /// `pts` liegt in der Encoder-Zeitbasis, und die ist dieselbe 90-kHz-Uhr
    /// wie die RTP-Uhr ([`crate::zeitbasis`] begruendet die Wahl genau damit).
    /// Vorher stand hier `takt * 90000 / fps`, weil ein Takt ein BILDPLATZ war
    /// — und diese Umrechnung war die Stelle, an der die echten Aufnahme-
    /// Abstaende verlorengingen: sie kamen schon gerundet an.
    ///
    /// Die Rechnung faellt damit weg, nicht die Wachsamkeit: laufen
    /// Encoder-Zeitbasis und [`RTP_TAKT_HZ`] je auseinander, rechnet der
    /// Empfaenger falsch, ohne dass irgendetwas scheitert. Der Test
    /// `zeitbasis_und_rtp_uhr_sind_dieselbe` haelt die beiden zusammen.
    ///
    /// `as u32` schneidet oben ab — genau das erwartet RFC 3550 von einer
    /// RTP-Uhr (sie laeuft ueber und faengt von vorn an).
    pub fn zeitstempel(&mut self, pts: Option<i64>) -> u32 {
        let takt = match pts {
            Some(p) if p >= 0 => p as u64,
            _ => self.ersatz_takt,
        };
        // Der Ersatz-Takt geht um einen BILDABSTAND weiter, nicht um einen
        // Takt: ein Takt sind 11 µs, zwei Bilder laegen damit praktisch auf
        // derselben Uhrzeit — genau das, was der Ersatz verhindern soll.
        self.ersatz_takt = takt + crate::zeitbasis::takte_je_bild(self.fps) as u64;
        takt as u32
    }

    /// Die Nummer DIESES Bildes; danach steht der Zaehler auf dem naechsten.
    ///
    /// **Wird nur aufgerufen, wenn wirklich Pakete hinausgehen.** Verschluckt
    /// der Encoder ein Bild, oder haelt der Paketierer einen Sequenzkopf ohne
    /// Vollbild zurueck, verbraucht das KEINE Nummer — und genau daran
    /// erkennt der Zuschauer, dass nichts verlorenging. Wuerde hier je Aufruf
    /// von `send` gezaehlt, meldete er eine Luecke fuer ein Bild, das es nie
    /// gegeben hat: derselbe Fehler wie beim Zeitstempel, nur teurer.
    pub fn naechste_bildnummer(&mut self) -> u16 {
        let n = self.bildnummer;
        self.bildnummer = self.bildnummer.wrapping_add(1);
        n
    }

    /// Sequenznummer fuer das naechste Paket; laeuft bei 65535 ueber.
    pub fn naechste_seq(&mut self) -> u16 {
        let seq = self.seq;
        self.seq = self.seq.wrapping_add(1);
        seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bildnummer_laeuft_um_und_ueberspringt_nichts() {
        let mut z = SpurZustand::neu(60);
        z.bildnummer = u16::MAX - 1;
        assert_eq!(z.naechste_bildnummer(), u16::MAX - 1);
        assert_eq!(z.naechste_bildnummer(), u16::MAX);
        assert_eq!(z.naechste_bildnummer(), 0, "der Umlauf ist ein normaler Schritt");
        assert_eq!(z.naechste_bildnummer(), 1);
    }

    /// Ein OBU im Format, das FFmpeg liefert: mit Groessenfeld.
    ///
    /// Das Laengenfeld wird hier VON HAND geschrieben, nicht mit
    /// `schreibe_leb128`. Sonst pruefte der Rundlauf die zu pruefende Funktion
    /// gegen sich selbst: ein falscher Schreiber erzeugte eine falsche Vorlage,
    /// die der gleich falsche Leser wieder auflöste, und der Test bliebe gruen.
    fn obu(typ: u8, rumpf_len: usize) -> Vec<u8> {
        let mut v = vec![(typ << 3) | 0b10];
        let mut n = rumpf_len as u32;
        loop {
            let b = (n & 0x7F) as u8;
            n >>= 7;
            v.push(if n != 0 { b | 0x80 } else { b });
            if n == 0 {
                break;
            }
        }
        v.extend((0..rumpf_len).map(|i| (i % 251) as u8));
        v
    }

    /// Was der Empfaenger sieht: alle Nutzlasten wieder zu OBUs
    /// zusammensetzen — bewusst als eigene, schlichte Umsetzung, damit der
    /// Test nicht dieselbe Annahme prueft, die er belegen soll.
    fn setze_zusammen(pakete: &[Nutzlast]) -> Vec<Vec<u8>> {
        let mut fertig: Vec<Vec<u8>> = Vec::new();
        let mut offen: Option<Vec<u8>> = None;
        for p in pakete {
            let kopf = p.daten[0];
            let z = kopf & 0x80 != 0;
            let y = kopf & 0x40 != 0;
            let w = ((kopf >> 4) & 0b11) as usize;
            let mut rest = &p.daten[1..];
            let mut k = 0;
            while !rest.is_empty() {
                k += 1;
                let letztes_im_paket = w != 0 && k == w;
                let stueck: &[u8] = if letztes_im_paket {
                    let s = rest;
                    rest = &[];
                    s
                } else {
                    let (len, n) = lies_leb128(rest).unwrap();
                    let s = &rest[n..n + len as usize];
                    rest = &rest[n + len as usize..];
                    s
                };
                let erstes_im_paket = k == 1;
                if erstes_im_paket && z {
                    offen.as_mut().expect("Z=1 ohne offenes OBU").extend_from_slice(stueck);
                } else {
                    if let Some(o) = offen.take() {
                        fertig.push(o);
                    }
                    offen = Some(stueck.to_vec());
                }
                let letztes_element = rest.is_empty();
                if letztes_element && !y {
                    fertig.push(offen.take().unwrap());
                }
            }
        }
        if let Some(o) = offen {
            fertig.push(o);
        }
        fertig
    }

    /// Die OBUs so, wie sie nach dem Strippen aussehen sollen.
    fn erwartet(quelle: &[u8]) -> Vec<Vec<u8>> {
        zerlege(quelle)
            .unwrap()
            .iter()
            .map(|o| {
                let mut v = o.kopf[..o.kopf_len].to_vec();
                v.extend_from_slice(o.rumpf);
                v
            })
            .collect()
    }

    #[test]
    fn leb128_stimmt_wo_das_crate_falsch_liegt() {
        // Genau die Werte, bei denen `rtp` 0.17.2 danebenliegt.
        for (wert, bytes) in [
            (0u32, vec![0x00]),
            (127, vec![0x7F]),
            (128, vec![0x80, 0x01]),
            (474, vec![0xDA, 0x03]),
            (16383, vec![0xFF, 0x7F]),
            (16384, vec![0x80, 0x80, 0x01]),
        ] {
            let mut v = Vec::new();
            schreibe_leb128(&mut v, wert);
            assert_eq!(v, bytes, "schreiben von {wert}");
            assert_eq!(lies_leb128(&v).unwrap(), (wert, bytes.len()), "lesen von {wert}");
        }
    }

    #[test]
    fn zeittrenner_und_kachelliste_fallen_weg() {
        let mut tu = obu(OBU_ZEITTRENNER, 0);
        tu.extend(obu(6, 50)); // Bild
        tu.extend(obu(OBU_KACHELLISTE, 20));
        let obus = zerlege(&tu).unwrap();
        assert_eq!(obus.len(), 1);
        assert_eq!(obus[0].typ, 6);
    }

    /// Ein Zeitabschnitt in der AMD-FORM: Bildkopf und Kacheldaten getrennt
    /// (NVENC packt beides in ein `OBU_FRAME`), dazu die Fuellung, mit der Mesa
    /// bei CBR auf die Zielrate auffuellt.
    ///
    /// **Diese Form hat in der ganzen Testdatei gefehlt** — jeder andere Test
    /// baut ein Bild als `obu(6, …)`, also wie NVENC es liefert. Genau deshalb
    /// konnte der fehlende Fuellungs-Filter ueberleben, bis er auf einer
    /// AMD-Karte den Zuschauer-Decoder umgebracht hat.
    #[test]
    fn fuellung_faellt_weg_amd_form() {
        let mut tu = obu(OBU_ZEITTRENNER, 0);
        tu.extend(obu(OBU_BILDKOPF, 30));
        tu.extend(obu(4, 400)); // Kachelgruppe
        tu.extend(obu(OBU_FUELLUNG, 8000));
        let obus = zerlege(&tu).unwrap();
        assert_eq!(
            obus.iter().map(|o| o.typ).collect::<Vec<_>>(),
            vec![OBU_BILDKOPF, 4],
            "Zeittrenner UND Fuellung muessen weg sein, Bildkopf und Kacheln bleiben"
        );
        // Und die Folge davon, in der Groesse gemessen, die den Fehler beim
        // Zuschauer erzeugt hat: ohne Filter zerteilt sich das 8-KB-Fuell-OBU
        // ueber rund sieben Pakete, mit Filter bleibt EINS.
        assert_eq!(
            paketiere(&tu, MTU).unwrap().len(),
            1,
            "Kopf + Kacheln passen in ein Paket; mit durchgereichter Fuellung waeren es rund sieben"
        );
    }

    #[test]
    fn groessenfeld_wird_entfernt_und_das_bit_geloescht() {
        let tu = obu(6, 200);
        let obus = zerlege(&tu).unwrap();
        assert_eq!(obus[0].kopf[0] & 0b10, 0, "obu_has_size_field muss 0 sein");
        assert_eq!(obus[0].len(), 201, "Kopf + 200 Byte, ohne die zwei Laengenbytes");
        // Zur Gegenprobe: die Quelle war 1 + 2 + 200 Byte lang.
        assert_eq!(tu.len(), 203);
    }

    #[test]
    fn kleines_bild_ein_paket_mit_marker() {
        let tu = obu(6, 100);
        let p = paketiere(&tu, MTU).unwrap();
        assert_eq!(p.len(), 1);
        assert!(p[0].letztes, "Marker-Bit gehoert auf das letzte Paket");
        let kopf = p[0].daten[0];
        assert_eq!(kopf & 0x80, 0, "Z");
        assert_eq!(kopf & 0x40, 0, "Y");
        assert_eq!((kopf >> 4) & 0b11, 1, "W = ein Element");
        assert_eq!(kopf & 0x08, 0, "N ohne Sequenzkopf");
    }

    /// Wie [`obu`], aber mit gesetztem ersten Rumpfbyte — dort stehen bei
    /// Bild-OBUs `show_existing_frame` und `frame_type`. Der Standardhelfer
    /// fuellt den Rumpf ab 0, was zufaellig genau ein `KEY_FRAME` ergibt.
    fn bild_obu(typ: u8, rumpf_len: usize, erstes: u8) -> Vec<u8> {
        let mut v = obu(typ, rumpf_len);
        let rumpf_start = v.len() - rumpf_len;
        v[rumpf_start] = erstes;
        v
    }

    /// `frame_type = 1` (INTER) — kein Einstiegspunkt.
    const INTER: u8 = 0b0010_0000;
    /// `show_existing_frame = 1` — zeigt nur einen Puffer erneut.
    const ZEIGT_VORHANDENES: u8 = 0b1000_0000;

    #[test]
    fn vollbild_wird_an_den_ersten_drei_bit_erkannt() {
        for (erstes, erwartet, was) in [
            (0b0000_0000, true, "KEY_FRAME"),
            (INTER, false, "INTER"),
            (0b0100_0000, false, "INTRA_ONLY"),
            (0b0110_0000, false, "SWITCH"),
            (ZEIGT_VORHANDENES, false, "show_existing_frame"),
        ] {
            let tu = bild_obu(OBU_BILD, 40, erstes);
            let obus = zerlege(&tu).unwrap();
            assert_eq!(ist_vollbild(&obus[0]), erwartet, "{was}");
        }
        // Ein Sequenzkopf ist selbst nie ein Vollbild, egal was drinsteht.
        let tu = bild_obu(OBU_SEQUENZKOPF, 40, 0);
        assert!(!ist_vollbild(&zerlege(&tu).unwrap()[0]));
    }

    #[test]
    fn sequenzkopf_ohne_vollbild_wird_gar_nicht_gesendet() {
        let mut tu = obu(OBU_ZEITTRENNER, 0);
        tu.extend(obu(OBU_SEQUENZKOPF, 12));
        tu.extend(bild_obu(OBU_BILD, 50, INTER));
        let p = paketiere(&tu, MTU).unwrap();
        assert_eq!(p.len(), 1);
        let kopf = p[0].daten[0];
        assert_eq!(kopf & 0x08, 0, "N darf ohne Vollbild nicht stehen");
        assert_eq!(
            (kopf >> 4) & 0b11,
            1,
            "nur das Bild darf uebrig sein — der Sequenzkopf gehoert weggelassen"
        );
    }

    #[test]
    fn sequenzkopf_bei_echtem_vollbild_bleibt_erhalten() {
        let mut tu = obu(OBU_ZEITTRENNER, 0);
        tu.extend(obu(OBU_SEQUENZKOPF, 12));
        tu.extend(bild_obu(OBU_BILD, 50, 0));
        let p = paketiere(&tu, MTU).unwrap();
        assert_eq!(p.len(), 1);
        let kopf = p[0].daten[0];
        assert_eq!(kopf & 0x08, 0x08, "N gehoert auf ein echtes Vollbild");
        assert_eq!((kopf >> 4) & 0b11, 2, "Sequenzkopf und Bild");
    }

    #[test]
    fn zeitabschnitt_aus_nur_einem_sequenzkopf_ergibt_kein_paket() {
        let mut tu = obu(OBU_ZEITTRENNER, 0);
        tu.extend(obu(OBU_SEQUENZKOPF, 12));
        assert!(paketiere(&tu, MTU).unwrap().is_empty());
    }

    #[test]
    fn sequenzkopf_setzt_n_nur_im_ersten_paket() {
        let mut tu = obu(OBU_ZEITTRENNER, 0);
        tu.extend(obu(OBU_SEQUENZKOPF, 12));
        tu.extend(obu(6, 5000));
        let p = paketiere(&tu, MTU).unwrap();
        assert!(p.len() > 1);
        assert_eq!(p[0].daten[0] & 0x08, 0x08, "N im ersten Paket");
        for (i, q) in p.iter().enumerate().skip(1) {
            assert_eq!(q.daten[0] & 0x08, 0, "N darf nur im ersten Paket stehen (Paket {i})");
        }
    }

    #[test]
    fn zerteilung_setzt_y_und_z_paarweise() {
        let tu = obu(6, 5000);
        let p = paketiere(&tu, MTU).unwrap();
        assert!(p.len() >= 5);
        for (i, q) in p.iter().enumerate() {
            let z = q.daten[0] & 0x80 != 0;
            let y = q.daten[0] & 0x40 != 0;
            assert_eq!(z, i > 0, "Z im Paket {i}");
            assert_eq!(y, i + 1 < p.len(), "Y im Paket {i}");
            assert_eq!(q.letztes, i + 1 == p.len(), "Marker im Paket {i}");
            assert!(q.daten.len() <= MTU, "Paket {i} ueberschreitet die MTU");
        }
    }

    /// Der Test, der die Sache traegt: was hineingeht, muss unveraendert
    /// wieder herauskommen — bei jeder MTU, ueber jede Zerteilungsgrenze
    /// hinweg. Genau hier faellt ein falsches Laengenfeld auf.
    #[test]
    fn rundlauf_byte_gleich_bei_jeder_mtu() {
        let mut tu = obu(OBU_ZEITTRENNER, 0);
        tu.extend(obu(OBU_SEQUENZKOPF, 13));
        tu.extend(obu(6, 130)); // knapp ueber 128 — dort liegt der Crate-Fehler
        tu.extend(obu(6, 4711));
        let soll = erwartet(&tu);
        for mtu in [MTU, 500, 300, 137, 60, 20, 8] {
            let p = paketiere(&tu, mtu).unwrap();
            assert!(p.iter().all(|q| q.daten.len() <= mtu), "MTU {mtu} verletzt");
            assert_eq!(setze_zusammen(&p), soll, "Rundlauf bei MTU {mtu}");
        }
    }

    #[test]
    fn mehr_als_drei_obus_gehen_auf_mehrere_pakete() {
        let mut tu = Vec::new();
        for _ in 0..5 {
            tu.extend(obu(6, 40));
        }
        let p = paketiere(&tu, MTU).unwrap();
        assert_eq!(p.len(), 2, "drei Elemente je Paket, also 3 + 2");
        assert_eq!(setze_zusammen(&p), erwartet(&tu));
    }

    #[test]
    fn letztes_obu_darf_ohne_groessenfeld_kommen() {
        let mut tu = obu(6, 30);
        tu.push(7 << 3); // ohne Groessenfeld, reicht bis zum Ende
        tu.extend([1, 2, 3, 4]);
        let obus = zerlege(&tu).unwrap();
        assert_eq!(obus.len(), 2);
        assert_eq!(obus[1].rumpf, &[1, 2, 3, 4]);
    }
}

#[cfg(test)]
mod zeitstempel_tests {
    use super::{RTP_TAKT_HZ, SpurZustand};
    use crate::zeitbasis::{VIDEO_HZ, pts_aus_sekunden};

    /// Die Voraussetzung der ganzen Identitaet: dieselbe Uhr auf beiden
    /// Seiten. Faellt sie, rechnet der Empfaenger jeden Zeitstempel falsch um,
    /// ohne dass irgendetwas scheitert — deshalb ein eigener Test und keine
    /// Bemerkung im Fliesstext.
    #[test]
    fn zeitbasis_und_rtp_uhr_sind_dieselbe() {
        assert_eq!(VIDEO_HZ, RTP_TAKT_HZ);
    }

    /// Der Kern der Sache: ein AUSGELASSENES Bild darf die Uhr nicht
    /// verschieben. Der `pts` kommt aus der echten Aufnahmezeit und geht
    /// unveraendert hinaus.
    #[test]
    fn ausgelassene_bilder_verschieben_die_uhr_nicht() {
        let mut z = SpurZustand::neu(60);
        assert_eq!(z.zeitstempel(Some(0)), 0);
        assert_eq!(z.zeitstempel(Some(1_500)), 1_500, "ein Bildabstand bei 60 fps");
        // Bilder 2, 3, 4 sind im Encoder verworfen worden.
        assert_eq!(z.zeitstempel(Some(7_500)), 7_500, "die Uhr des fuenften Bildes");
    }

    /// **Der eigentliche Gewinn der feineren Zeitbasis.** Drei Bilder, wie sie
    /// ein 143,9-Hz-Schirm bei 60 fps liefert (Muster 2-2-3 Bildschirmtakte),
    /// muessen mit DREI VERSCHIEDENEN Abstaenden auf die Leitung gehen. Im
    /// alten Raster kamen hier dreimal 1500 heraus — die Bewegung lief also
    /// abwechselnd zu langsam und zu schnell.
    #[test]
    fn ungleiche_aufnahmeabstaende_gehen_ungleich_hinaus() {
        let takt = 1.0 / 143.9;
        let mut z = SpurZustand::neu(60);
        let stempel: Vec<u32> = [0.0, 2.0, 4.0, 7.0]
            .iter()
            .map(|n| z.zeitstempel(Some(pts_aus_sekunden(n * takt))))
            .collect();
        let abstaende: Vec<u32> = stempel.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(abstaende, vec![1_251, 1_251, 1_876]);
    }

    /// Ohne `pts` läuft der Ersatz-Takt weiter, statt zwei Bilder auf dieselbe
    /// Uhrzeit zu legen — und zwar um einen BILDABSTAND, nicht um einen Takt.
    #[test]
    fn fehlender_pts_faellt_auf_den_ersatz_takt_zurueck() {
        let mut z = SpurZustand::neu(60);
        assert_eq!(z.zeitstempel(Some(15_000)), 15_000);
        assert_eq!(z.zeitstempel(None), 16_500, "ein Bildabstand weiter");
        assert_eq!(z.zeitstempel(None), 18_000, "und noch einer");
        // Kommt der pts zurück, gilt wieder er.
        assert_eq!(z.zeitstempel(Some(30_000)), 30_000);
    }

    /// Krumme Bildraten koennen nicht mehr davonlaufen, weil gar nicht mehr
    /// gerechnet wird — der Ersatz-Takt rundet auf und bleibt damit
    /// mindestens einen echten Bildabstand auseinander.
    #[test]
    fn krumme_bildrate_laeuft_nicht_davon() {
        let mut z = SpurZustand::neu(280);
        assert_eq!(z.zeitstempel(Some(90_000)), 90_000, "genau eine Sekunde");
        assert_eq!(z.zeitstempel(None), 90_322, "90000/280 ist 321,4 — aufgerundet");
    }
}
