//! HEVC: Vollbild-Erkennung und RTP-Paketierung (RFC 7798).
//!
//! **Warum der Paketierer von Hand liegt und nicht im `rtp`-Crate** — dieselbe
//! Vorgeschichte wie [`crate::av1`], nur mit einem anderen Fehlerbild: der
//! `HevcPayloader` dort kennt Fragmentierung nur für die NAL-Typen
//! `IDR_W_RADL (19)`, `TRAIL_R (1)` und `TRAIL_N (0)`; JEDES andere NAL —
//! namentlich `IDR_N_LP (20)` und `CRA (21)`, die Einstiegspunkte sind —
//! faellt in einen `IGNORE`-Ast und wird **lautlos verworfen**. AMDs `hevc_amf`
//! encodiert Vollbilder als IDR_N_LP; am 2026-09-13 auf der Windows-Kette
//! nachgemessen (RTP-Mitschnitt des Players): 5433 Pakete, 563 vollstaendige
//! FU-NALs — und KEIN einziges Keyframe, KEIN VPS/SPS/PPS. Sender und Decoder
//! waeren gesund gewesen, Chromium UND der eigene Player sahen „kein Bild",
//! weil jedes angeforderte Vollbild hier verschwand. Ein zweiter, seltenerer
//! Fall desselben Payloaders: das E-Bit fehlt, wenn der letzte Fragment
//! EXAKT die Fragmentgroesse trifft (`current_fragment_size <
//! max_fragment_size` als `is_last`-Test). Beides ist hier von Hand gebaut
//! und testbar.
//!
//! **Der NAL-Kopf ist hier ZWEI Byte und der Typ sitzt woanders** (RFC 7798
//! §1.1.4): `F(1) | Type(6) | LayerId(6) | TID(3)` — der Typ ist die obere
//! Hälfte des ersten Bytes, `(b0 >> 1) & 0x3F`. Die H.264-Maske `& 0x1F`
//! würde hier Müll lesen.
//!
//! Einstiegspunkte sind BLA (16-18), IDR (19, 20) und CRA (21) — alle drei
//! sind intra, ein Zuschauer kann dort einsteigen. VPS (32), SPS (33) und
//! PPS (34) zählen NICHT als Vollbild: sie gehen dem Einstiegspunkt voraus,
//! und der Payloader hält sie ohnehin zurück, bis er ihn ausspielt.

/// Trägt dieser Annex-B-Zeitabschnitt ein Vollbild (BLA/IDR/CRA)?
pub fn hevc_ist_vollbild(daten: &[u8]) -> bool {
    let mut i = 0;
    while i + 4 < daten.len() {
        let lang = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 0 && daten[i + 3] == 1;
        let kurz = daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 1;
        if lang || kurz {
            let kopf = i + if lang { 4 } else { 3 };
            if kopf + 1 < daten.len() && matches!((daten[kopf] >> 1) & 0x3F, 16..=21) {
                return true;
            }
            i = kopf;
        } else {
            i += 1;
        }
    }
    false
}

use anyhow::Result;

/// Der NAL-Typ eines Zeitabschnitts-Kopfes (RFC 7798 §1.1.4).
fn nal_typ(nal: &[u8]) -> u8 {
    (nal[0] >> 1) & 0x3F
}

/// VPS/SPS/PPS — die Parameter-Saetze, die vor jedem Vollbild mitreisen
/// muessen (RFC 7798 §7.2.2: ein Einstiegspunkt ohne sie ist unbrauchbar).
const PARAM_SAETZE: [u8; 3] = [32, 33, 34];

/// Einen Annex-B-Zeitabschnitt in RTP-Nutzlasten zerlegen (RFC 7798 §4.4).
///
/// Interface und Markierungen wie [`crate::av1::paketiere`] — die Aufrufstellen
/// der drei Sendewege bedienen beide Codecs ueber dasselbe Bild. `puffer` ist
/// der Parameter-Satz-Zwischenspeicher der SPUR (analog hält der H.264-Zerleger
/// sein SPS/PPS im Payloader unter dem Spur-Lock).
///
/// * Kleine NALs gehen als Einzel-NAL-Paket (§4.4.1), grosse als FU (§4.4.3)
///   mit S/E sauber gesetzt — auch wenn der letzte Fragment die Fragmentgrösse
///   exakt trifft (der Fall, der dem `rtp`-Crate das E-Bit frisst).
/// * VPS/SPS/PPS werden zurueckgehalten und vor dem naechsten Vollbild als
///   EIN Aggregationspaket (§4.4.2) vorangestellt — dasselbe Muster wie der
///   H.264-Zerleger mit SPS/PPS. Ein Zeitabschnitt NUR aus Parameter-Saetzen
///   liefert daher nichts: legitim, der naechste Einstiegspunkt holt sie ab.
/// * Alle uebrigen NAL-Typen (AUD, SEI, suffix …) werden durchgereicht —
///   genau das lautlose Wegwerfen fremder Typen war der Live-Fehler.
pub fn paketiere(
    puffer: &mut Vec<Vec<u8>>,
    daten: &[u8],
    mtu: usize,
) -> Result<Vec<crate::av1::Nutzlast>> {
    use crate::av1::Nutzlast;

    let nals = zerlege_annexb(daten);
    if nals.is_empty() {
        return Ok(Vec::new());
    }
    let vollbild = nals.iter().any(|n| matches!(nal_typ(n), 16..=21));

    // Parameter-Saetze aus DIESEM Abschnitt uebernehmen und vorne raus: sie
    // reisen gleich gebuendelt vor dem Vollbild statt als Einzel-NALs dahinter.
    let frische: Vec<&[u8]> = nals
        .iter()
        .filter(|n| PARAM_SAETZE.contains(&nal_typ(n)))
        .copied()
        .collect();
    let slices: Vec<&[u8]> = nals
        .into_iter()
        .filter(|n| !PARAM_SAETZE.contains(&nal_typ(n)))
        .collect();

    let mut pakete: Vec<Nutzlast> = Vec::new();
    if vollbild {
        // Gepufferte Parameter-Saetze aelterer Abschnitte voran, dann die
        // frischen — je Typ nur je einer (wiederholt der Encoder sie in jedem
        // GOP, zaehlt trotzdem nur der neueste).
        puffer.retain(|p| !frische.iter().any(|f| nal_typ(f) == nal_typ(p)));
        puffer.extend(frische.iter().map(|n| n.to_vec()));
        if !puffer.is_empty() {
            let mitgenommen: Vec<&[u8]> = puffer.iter().map(|p| p.as_slice()).collect();
            pakete.push(ap_paket(&mitgenommen, mtu));
        }
    } else if !frische.is_empty() {
        // Ohne Vollbild haben die Parameter-Saetze hier nichts zu suchen —
        // puffern, der naechste Einstiegspunkt nimmt sie mit.
        for n in &frische {
            if !puffer.iter().any(|p| nal_typ(p) == nal_typ(n)) {
                puffer.push(n.to_vec());
            }
        }
    }

    for nal in slices {
        if nal.len() <= mtu {
            pakete.push(Nutzlast {
                daten: nal.to_vec(),
                letztes: false,
                erstes: false,
                vollbild,
            });
        } else {
            pakete.extend(fu_pakete(nal, mtu, vollbild));
        }
    }
    if let Some(e) = pakete.first_mut() {
        e.erstes = true;
    }
    if let Some(l) = pakete.last_mut() {
        l.letztes = true;
    }
    Ok(pakete)
}

/// Ein Aggregationspaket (§4.4.2) aus den Parameter-Saetzen. Kopf wie beim
/// Original-NAL mit Typ 48; dahinter je NAL eine u16-Laenge (BE) und das NAL
/// samt seinem eigenen Kopf — genau die Form, die Chromiums Depacketizer
/// (`ProcessApOrSingleNalu`) und der eigene Player lesen.
fn ap_paket(nals: &[&[u8]], mtu: usize) -> crate::av1::Nutzlast {
    let mut daten = Vec::with_capacity(nals.iter().map(|n| n.len() + 2).sum::<usize>() + 2);
    daten.extend_from_slice(&[(nals[0][0] & 0x81) | (48 << 1), nals[0][1]]);
    for nal in nals {
        daten.extend_from_slice(&(nal.len() as u16).to_be_bytes());
        daten.extend_from_slice(nal);
    }
    // Nicht erreichbar mit echten Encoder-Ausgaben (VPS+SPS+PPS ~150 B weit
    // unter jeder MTU) — die Zeile steht trotzdem, damit die Funktion keine
    // Panik kennt.
    if daten.len() > mtu {
        daten.truncate(mtu);
    }
    crate::av1::Nutzlast { daten, erstes: false, letztes: false, vollbild: true }
}

/// Fragmentierung (§4.4.3): Nutzlast-Kopf mit Typ 49, FU-Kopf mit S|E|Typ,
/// dahinter die NAL-Daten ab Byte 2. `letzter` steht auf „Rest aufgebraucht",
/// nicht auf „kleiner als Maximum" — der exakt passende letzte Fragment ist
/// der Fall, den der `rtp`-Crate verliert.
fn fu_pakete(nal: &[u8], mtu: usize, vollbild: bool) -> Vec<crate::av1::Nutzlast> {
    use crate::av1::Nutzlast;

    let fragment = mtu - 3; // Nutzlast-Kopf (2) + FU-Kopf (1)
    let mut pakete = Vec::with_capacity((nal.len() - 2).div_ceil(fragment));
    let mut von = 2usize;
    while von < nal.len() {
        let bis = (von + fragment).min(nal.len());
        let erster = von == 2;
        let letzter = bis == nal.len();
        let mut daten = Vec::with_capacity(bis - von + 3);
        daten.extend_from_slice(&[(nal[0] & 0x81) | (49 << 1), nal[1]]);
        daten.push((u8::from(erster) << 7) | (u8::from(letzter) << 6) | nal_typ(nal));
        daten.extend_from_slice(&nal[von..bis]);
        pakete.push(Nutzlast { daten, erstes: false, letztes: false, vollbild });
        von = bis;
    }
    pakete
}

/// Annex-B in NALs zerlegen — Startcodes beider Laengen, NAL jeweils ohne
/// Startcode. Nullbytes zwischen NAL und naechstem Startcode bleiben am
/// vorherigen NAL ( Annex-B `trailing_zero_8bits`, Dekoder ueberspringen sie).
fn zerlege_annexb(daten: &[u8]) -> Vec<&[u8]> {
    let mut nals = Vec::new();
    let mut i = 0;
    let mut anfang: Option<usize> = None;
    while i < daten.len() {
        let lang = i + 3 < daten.len()
            && daten[i] == 0
            && daten[i + 1] == 0
            && daten[i + 2] == 0
            && daten[i + 3] == 1;
        let kurz = i + 2 < daten.len() && daten[i] == 0 && daten[i + 1] == 0 && daten[i + 2] == 1;
        if lang || kurz {
            if let Some(a) = anfang.replace(i + if lang { 4 } else { 3 }) {
                nals.push(&daten[a..i]);
            }
            i += if lang { 4 } else { 3 };
        } else {
            i += 1;
        }
    }
    if let Some(a) = anfang {
        nals.push(&daten[a..]);
    }
    nals.retain(|n| n.len() >= 2);
    nals
}

#[cfg(test)]
mod tests {
    use super::{hevc_ist_vollbild, paketiere};

    /// Ein Zeitabschnitt in Annex-B bauen: je NAL der lange Startcode plus
    /// Kopf- und Testbytes. `typ` ist der 6-Bit-NAL-Typ, die Groesse die
    /// NAL-Laenge gesamt (inkl. der zwei Kopfbytes).
    fn annexb(typ: u8, groesse: usize, fuellung: u8) -> Vec<u8> {
        let mut n = vec![0, 0, 0, 1, (typ << 1) & 0x7F, 0x01];
        n.extend(std::iter::repeat(fuellung).take(groesse.saturating_sub(2)));
        n
    }

    /// DER Live-Fehler vom 2026-09-13: AMDs `hevc_amf` encodiert Vollbilder
    /// als IDR_N_LP (20), und der `rtp`-Crate-Payloader warf jeden Typ
    /// ausser 19/1/0 lautlos weg — 5433 Pakete Stream ohne ein einziges
    /// Keyframe. Dieser Test haelt fest, dass IDR_N_LP samt der gebuendelten
    /// Parameter-Saete RAUSGEHT: ein AP (Typ 48) zuerst, dahinter FU-Fragmente
    /// mit fu_type=20.
    #[test]
    fn idr_n_lp_keyframe_und_parameter_saetze_reisen() {
        let au = [
            annexb(32, 10, 0x11), // VPS
            annexb(33, 12, 0x22), // SPS
            annexb(34, 8, 0x33),  // PPS
            annexb(35, 5, 0x44),  // AUD
            annexb(20, 3000, 0x55), // IDR_N_LP, weit ueber der MTU
        ]
        .concat();
        let pakete = paketiere(&mut Vec::new(), &au, 1200).unwrap();
        assert!(pakete.iter().all(|p| p.vollbild), "alle Pakete sind Vollbild");
        // Erstes Paket: AP mit VPS+SPS+PPS (Typ 48 im Nutzlast-Kopf).
        assert_eq!((pakete[0].daten[0] >> 1) & 0x3F, 48, "erstes Paket ist ein AP");
        assert!(pakete[0].erstes, "AP eroeffnet den Abschnitt");
        // Dahinter: AUD als Einzel-NAL, dann FU-Fragmente des IDR_N_LP.
        let fu: Vec<&crate::av1::Nutzlast> = pakete
            .iter()
            .filter(|p| (p.daten[0] >> 1) & 0x3F == 49)
            .collect();
        assert!(fu.len() >= 2, "IDR_N_LP ist fragmentiert: {} FU-Pakete", fu.len());
        assert_eq!(fu[0].daten[2] & 0x3F, 20, "fu_type ist IDR_N_LP");
        assert_eq!(fu[0].daten[2] & 0x80, 0x80, "erstes Fragment setzt S");
        assert_eq!(fu.last().unwrap().daten[2] & 0x40, 0x40, "letztes Fragment setzt E");
        assert!(pakete.last().unwrap().letztes, "letztes Paket traegt das Marker-Bit");
    }

    /// Der zweite `rtp`-Crate-Fehler: trifft der letzte Fragment die
    /// Fragmentgroesse EXAKT, fehlte das E-Bit. NAL von 2 + 2×1197 Byte
    /// → genau zwei Fragmente, der zweite muss E setzen.
    #[test]
    fn exakt_passender_letzter_fragment_bekommt_e() {
        let au = annexb(1, 2 + 2 * (1200 - 3), 0x55); // TRAIL_R
        let pakete = paketiere(&mut Vec::new(), &au, 1200).unwrap();
        let fu: Vec<&crate::av1::Nutzlast> = pakete
            .iter()
            .filter(|p| (p.daten[0] >> 1) & 0x3F == 49)
            .collect();
        assert_eq!(fu.len(), 2, "zwei exakt passende Fragmente");
        assert_eq!(fu[0].daten[2], 0x80 | 1, "S gesetzt, Typ TRAIL_R");
        assert_eq!(fu[1].daten[2], 0x40 | 1, "E gesetzt trotz exakter Groesse");
    }

    /// Parameter-Saetze ohne Vollbild liefern nichts (H.264-Muster: der
    /// naechste Einstiegspunkt holt sie ab) — und ein spaeteres Vollbild
    /// OHNE eigene Parameter-Saetze bekommt sie aus dem Puffer.
    #[test]
    fn gepufferte_parameter_reisen_mit_naechstem_vollbild() {
        let mut puffer = Vec::new();
        let nur_params = [annexb(32, 10, 0x11), annexb(33, 12, 0x22), annexb(34, 8, 0x33)].concat();
        assert!(paketiere(&mut puffer, &nur_params, 1200).unwrap().is_empty());
        // IDR_N_LP ganz ohne VPS/SPS/PPS im Abschnitt — der Encoder wiederholt
        // sie nur am GOP-Start, ein erzwungenes Vollbild mid-GOP nicht.
        let keyframe = annexb(20, 3000, 0x55);
        let pakete = paketiere(&mut puffer, &keyframe, 1200).unwrap();
        assert_eq!(
            (pakete[0].daten[0] >> 1) & 0x3F,
            48,
            "Puffer-Ap geht dem Vollbild voran"
        );
    }

    /// Differenzbilder ohne Parameter-Saetze sind unveraendert Einzel-NALs.
    #[test]
    fn p_bild_als_einzel_nal() {
        let au = annexb(1, 100, 0x55);
        let pakete = paketiere(&mut Vec::new(), &au, 1200).unwrap();
        assert_eq!(pakete.len(), 1);
        assert!(!pakete[0].vollbild);
        assert!(pakete[0].erstes && pakete[0].letztes);
    }

    /// IDR_W_RADL (19): `19 << 1 = 0x26`. Derselbe Aufbau wie der
    /// H.264-Test — langer und kurzer Startcode müssen beide gehen.
    #[test]
    fn idr_gilt_als_vollbild() {
        assert!(hevc_ist_vollbild(&[0, 0, 0, 1, 0x26, 0x01, 0xAA]), "langer Startcode, IDR_W_RADL");
        assert!(hevc_ist_vollbild(&[0, 0, 1, 0x26, 0x01, 0xAA]), "kurzer Startcode, IDR_W_RADL");
    }

    /// CRA (21) und BLA_W_LP (16) sind ebenfalls Einstiegspunkte — die
    /// Bildmarke darf sie nicht anders behandeln als eine IDR.
    #[test]
    fn cra_und_bla_gelten_auch() {
        assert!(hevc_ist_vollbild(&[0, 0, 0, 1, 0x2A, 0x01, 0xAA]), "CRA (21)");
        assert!(hevc_ist_vollbild(&[0, 0, 0, 1, 0x20, 0x01, 0xAA]), "BLA_W_LP (16)");
    }

    /// TRAIL_R (1) ist ein Differenzbild; `& 0x1F` würde aus dem Kopf 0x02
    /// fälschlich Typ 2 lesen — der Test hält die richtige Maske fest.
    #[test]
    fn differenzbild_ist_kein_vollbild() {
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x02, 0x01, 0xAA]), "TRAIL_R (1)");
    }

    /// VPS (32), SPS (33), PPS (34) gehen dem Vollbild voraus und werden vom
    /// Payloader zurückgehalten — allein sind sie KEIN Einstiegspunkt.
    #[test]
    fn parameter_saetze_sind_kein_vollbild() {
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x40, 0x01, 0xAA]), "VPS (32)");
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x42, 0x01, 0xAA]), "SPS (33)");
        assert!(!hevc_ist_vollbild(&[0, 0, 0, 1, 0x44, 0x01, 0xAA]), "PPS (34)");
    }
}
