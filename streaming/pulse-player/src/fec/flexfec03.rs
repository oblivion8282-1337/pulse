//! FlexFEC-03: Kopf lesen und ein verlorenes Paket zurueckrechnen.
//!
//! Entwurfsstand `draft-ietf-payload-flexible-fec-scheme-03`, nicht der
//! spaetere RFC 8627 — das ist die Fassung, die Chromium spricht und die pion
//! erzeugt (`FlexEncoder03Factory` ist dort die Voreinstellung). Die beiden
//! sind NICHT austauschbar; wer den RFC danebenlegt, findet ein anderes
//! Kopf-Format.
//!
//! ```text
//!  0                   1                   2                   3
//!  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |0|0| P|X|  CC  |M| PT recovery |         length recovery       |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |                          TS recovery                          |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |   SSRCCount   |                    reserved                   |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |                             SSRC_i                            |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |           SN base_i           |k|          Mask [0-14]        |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |k|                   Mask [15-45] (optional)                   |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! |k|                                                             |
//! +-+                   Mask [46-108] (optional)                  |
//! |                                                               |
//! +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//! ```
//!
//! **Das `k`-Bit ist ein Fortsetzungszeiger, kein Maskenbit.** Steht es, endet
//! die Maske hier und die Nutzlast folgt; steht es nicht, kommt ein weiterer
//! Maskenblock. Wer es als Teil der Maske liest, schuetzt eine Sequenznummer
//! zu viel und rechnet anschliessend Bildmuell zurueck.
//!
//! **Zurueckgerechnet wird nur bei GENAU EINEM fehlenden Paket.** Das ist keine
//! Vereinfachung unsererseits, sondern die Grenze des Verfahrens: die Parität
//! ist ein XOR ueber die Gruppe, und eine Gleichung loest genau eine Unbekannte.
//! Fehlen zwei Pakete derselben Gruppe, ist die Reserve wertlos — das ist der
//! Preis gegenueber Reed-Solomon.

// Noch nicht verdrahtet: der Sammler in `mod.rs` liest die Paritaetspakete
// bereits ein, gibt sie aber noch nicht hier hinein. Faellt weg, sobald die
// Rueckrechnung im Empfangsweg haengt.
#![allow(dead_code)]

use anyhow::{bail, Result};

/// Kopfgroesse einschliesslich der ersten, immer vorhandenen Maske.
const BASIS_KOPF: usize = 20;

/// Ein RTP-Kopf ohne CSRC und ohne Erweiterung. Die Rechnung des Verfahrens
/// bezieht sich auf genau diese zwoelf Bytes.
const RTP_KOPF: usize = 12;

/// Der gelesene Kopf eines Paritaetspakets.
#[derive(Debug, Clone)]
pub struct Paritaetskopf {
    /// Quellkennung des Stroms, den dieses Paket schuetzt.
    pub geschuetzte_ssrc: u32,
    /// Sequenznummer, auf die sich Bit 0 der Maske bezieht.
    pub basis_sequenz: u16,
    /// Die Sequenznummern, die dieses Paritaetspaket abdeckt.
    pub geschuetzte_sequenzen: Vec<u16>,
    /// Beginn der Reparaturdaten innerhalb der Nutzlast.
    pub nutzlast_beginn: usize,
}

/// Liest den Kopf und loest die Masken in Sequenznummern auf.
pub fn kopf_lesen(nutzlast: &[u8]) -> Result<Paritaetskopf> {
    if nutzlast.len() < BASIS_KOPF {
        bail!("Paritaetspaket zu kurz: {} Byte", nutzlast.len());
    }
    // R (Wiederholung) und F (starre Erzeugermatrix) beschreiben Betriebsarten,
    // die pion nicht erzeugt. Sie stillschweigend zu ignorieren waere die
    // gefaehrlichere Wahl: der Kopf saehe danach gleich aus, die Bedeutung der
    // Maske waere aber eine andere.
    if nutzlast[0] & 0x80 != 0 {
        bail!("Paritaetspaket mit gesetztem R-Bit wird nicht unterstuetzt");
    }
    if nutzlast[0] & 0x40 != 0 {
        bail!("Paritaetspaket mit starrer Erzeugermatrix wird nicht unterstuetzt");
    }
    let ssrc_anzahl = nutzlast[8];
    if ssrc_anzahl != 1 {
        bail!("Paritaet ueber {ssrc_anzahl} Stroeme wird nicht unterstuetzt");
    }

    let geschuetzte_ssrc = u32::from_be_bytes([nutzlast[12], nutzlast[13], nutzlast[14], nutzlast[15]]);
    let basis_sequenz = u16::from_be_bytes([nutzlast[16], nutzlast[17]]);

    let maske = &nutzlast[18..];
    let mut sequenzen = Vec::new();
    let nutzlast_beginn;

    let k0 = maske[0] & 0x80 != 0;
    let maske0 = u16::from_be_bytes([maske[0], maske[1]]) & 0x7FFF;
    sequenzen.extend(maske_aufloesen(u64::from(maske0), 15, basis_sequenz));

    if k0 {
        nutzlast_beginn = 18 + 2;
    } else {
        if nutzlast.len() < 24 {
            bail!("Paritaetspaket zu kurz fuer zweite Maske: {} Byte", nutzlast.len());
        }
        let k1 = maske[2] & 0x80 != 0;
        let maske1 = u32::from_be_bytes([maske[2], maske[3], maske[4], maske[5]]) & 0x7FFF_FFFF;
        sequenzen.extend(maske_aufloesen(
            u64::from(maske1),
            31,
            basis_sequenz.wrapping_add(15),
        ));

        if k1 {
            nutzlast_beginn = 18 + 6;
        } else {
            if nutzlast.len() < 32 {
                bail!("Paritaetspaket zu kurz fuer dritte Maske: {} Byte", nutzlast.len());
            }
            let k2 = maske[6] & 0x80 != 0;
            let maske2 = u64::from_be_bytes([
                maske[6], maske[7], maske[8], maske[9], maske[10], maske[11], maske[12], maske[13],
            ]) & 0x7FFF_FFFF_FFFF_FFFF;
            sequenzen.extend(maske_aufloesen(maske2, 63, basis_sequenz.wrapping_add(46)));
            if !k2 {
                bail!("Letzte Maske ohne gesetztes k-Bit — Kopf unvollstaendig");
            }
            nutzlast_beginn = 18 + 14;
        }
    }

    // **Mindestgruppengroesse 2.** Hier stand bis zum 2026-08-08 nur
    // `sequenzen.is_empty()` — „schuetzt nichts (leere Maske)". Das ist zu
    // wenig, und zwar nicht als Randfall: eine Maske mit GENAU EINEM gesetzten
    // Bit kam damit durch, und so eine Gruppe hat kein einziges echtes
    // Vergleichspaket. Fehlt ihr eines Mitglied, laufen beide XOR-Schleifen in
    // `zurueckrechnen()` null Mal, und das „reparierte" Paket besteht woertlich
    // aus den Bytes, die der Absender in der Paritaetsnutzlast mitgeschickt hat
    // (bei Gruppengroesse 1 ist die Paritaet durch die XOR-Identitaet zwangs-
    // laeufig das Paket selbst). Der Empfangsweg zaehlte das als `repariert` —
    // eine Zahl, die Wirkung der Paritaet belegen soll, wo keine stattfand.
    // Erst ab zwei Mitgliedern rechnet XOR ueberhaupt etwas.
    if sequenzen.len() < 2 {
        bail!(
            "Paritaetspaket schuetzt nur {} Paket(e) — Mindestgruppengroesse 2",
            sequenzen.len()
        );
    }

    Ok(Paritaetskopf {
        geschuetzte_ssrc,
        basis_sequenz,
        geschuetzte_sequenzen: sequenzen,
        nutzlast_beginn,
    })
}

/// Setzt gesetzte Maskenbits in Sequenznummern um.
///
/// Bit 0 steht LINKS: das hoechstwertige Bit des Blocks meint `basis`, nicht
/// `basis + bitanzahl`. Wer hier die Richtung dreht, bekommt eine Maske, die
/// scheinbar plausible, aber falsche Pakete schuetzt.
fn maske_aufloesen(maske: u64, bitanzahl: u16, basis: u16) -> Vec<u16> {
    (0..bitanzahl)
        .filter(|i| (maske >> (bitanzahl - 1 - i)) & 1 == 1)
        .map(|i| basis.wrapping_add(i))
        .collect()
}

/// Ein Medienpaket, wie es fuer die Rechnung gebraucht wird: die vollstaendigen
/// Bytes, so wie sie ueber die Leitung kamen.
pub struct Medienpaket {
    pub sequenz: u16,
    pub bytes: Vec<u8>,
}

/// Rechnet das eine fehlende Paket zurueck.
///
/// `vorhanden` muss alle geschuetzten Pakete AUSSER dem fehlenden enthalten.
/// Rueckgabe sind die vollstaendigen Bytes des wiederhergestellten Pakets.
///
/// Das Verfahren (Abschnitt 6.3.2 des Entwurfs): die ersten acht Bytes des
/// RTP-Kopfes und die um zwoelf verminderte Paketlaenge bilden eine 80-Bit-Kette
/// je Paket; XOR ueber alle vorhandenen Ketten und die Paritaet ergibt die
/// Kette des fehlenden. Sequenznummer und Quellkennung stehen nicht darin —
/// die erste kennen wir aus der Maske, die zweite aus dem Kopf der Paritaet.
pub fn zurueckrechnen(
    kopf: &Paritaetskopf,
    paritaet_nutzlast: &[u8],
    vorhanden: &[Medienpaket],
    fehlende_sequenz: u16,
) -> Result<Vec<u8>> {
    if paritaet_nutzlast.len() < kopf.nutzlast_beginn + 2 {
        bail!("Paritaetsnutzlast zu kurz");
    }

    // Die ersten zehn Bytes des Kopfes tragen die Wiederherstellungsfelder
    // (Kopfbits, Laenge, Zeitstempel). Bytes 8-11 des Ergebnisses nimmt spaeter
    // die Quellkennung ein.
    let mut kopf_bytes = [0u8; RTP_KOPF];
    kopf_bytes[..10].copy_from_slice(&paritaet_nutzlast[..10]);

    for paket in vorhanden {
        if paket.bytes.len() < RTP_KOPF {
            bail!("Medienpaket kuerzer als ein RTP-Kopf");
        }
        // Die Laenge tritt an die Stelle der Sequenznummer — genau so ist die
        // 80-Bit-Kette des Verfahrens definiert.
        let laenge = (paket.bytes.len() - RTP_KOPF) as u16;
        let mut kette = [0u8; 8];
        kette.copy_from_slice(&paket.bytes[..8]);
        kette[2] = (laenge >> 8) as u8;
        kette[3] = laenge as u8;
        for i in 0..8 {
            kopf_bytes[i] ^= kette[i];
        }
    }

    // Fassung auf 2 setzen: das oberste Bitpaar traegt im Paritaetskopf die
    // R/F-Bits und ist deshalb genullt, nicht die RTP-Fassung.
    kopf_bytes[0] |= 0x80;
    kopf_bytes[0] &= 0xBF;

    let nutzlast_laenge = u16::from_be_bytes([kopf_bytes[2], kopf_bytes[3]]) as usize;
    kopf_bytes[2..4].copy_from_slice(&fehlende_sequenz.to_be_bytes());
    kopf_bytes[8..12].copy_from_slice(&kopf.geschuetzte_ssrc.to_be_bytes());

    let reparatur = &paritaet_nutzlast[kopf.nutzlast_beginn..];
    if nutzlast_laenge > reparatur.len() {
        bail!(
            "zurueckgerechnete Laenge {nutzlast_laenge} groesser als die Reparaturdaten ({})",
            reparatur.len()
        );
    }
    let mut nutzlast = reparatur[..nutzlast_laenge].to_vec();
    for paket in vorhanden {
        let eigene = &paket.bytes[RTP_KOPF..];
        for i in 0..nutzlast_laenge.min(eigene.len()) {
            nutzlast[i] ^= eigene[i];
        }
    }

    let mut ergebnis = kopf_bytes.to_vec();
    ergebnis.extend_from_slice(&nutzlast);
    Ok(ergebnis)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Baut ein Paritaetspaket wie pions Encoder — dieselbe Reihenfolge, damit
    /// der Test das echte Format prueft und nicht das, was ich mir dabei
    /// gedacht habe.
    ///
    /// `pub(crate)`, weil auch `empfaenger.rs` echte Paritaetspakete braucht.
    /// Eine zweite Fassung dort wuerde beim naechsten Formatdetail auseinander-
    /// laufen, und dann prueften die Tests zwei verschiedene Formate.
    pub(crate) fn paritaet_bauen(medien: &[Medienpaket], ssrc: u32, basis: u16) -> Vec<u8> {
        let max_nutzlast = medien
            .iter()
            .map(|p| p.bytes.len() - RTP_KOPF)
            .max()
            .unwrap_or(0);
        let mut aus = vec![0u8; BASIS_KOPF + max_nutzlast];

        for paket in medien {
            aus[0] ^= paket.bytes[0];
            aus[1] ^= paket.bytes[1];
            aus[0] &= 0b0011_1111;
            let laenge = (paket.bytes.len() - RTP_KOPF) as u16;
            aus[2] ^= (laenge >> 8) as u8;
            aus[3] ^= laenge as u8;
            for i in 4..8 {
                aus[i] ^= paket.bytes[i];
            }
            for (i, b) in paket.bytes[RTP_KOPF..].iter().enumerate() {
                aus[BASIS_KOPF + i] ^= b;
            }
        }

        aus[8] = 1;
        aus[12..16].copy_from_slice(&ssrc.to_be_bytes());
        aus[16..18].copy_from_slice(&basis.to_be_bytes());
        // Maske: die ersten `medien.len()` Bits ab links, k-Bit gesetzt.
        let mut maske: u16 = 0;
        for i in 0..medien.len() {
            maske |= 1 << (14 - i);
        }
        aus[18..20].copy_from_slice(&maske.to_be_bytes());
        aus[18] |= 0x80;
        aus
    }

    pub(crate) fn medienpaket(
        sequenz: u16,
        zeitstempel: u32,
        ssrc: u32,
        nutzlast: &[u8],
    ) -> Medienpaket {
        let mut bytes = vec![0x80, 96];
        bytes.extend_from_slice(&sequenz.to_be_bytes());
        bytes.extend_from_slice(&zeitstempel.to_be_bytes());
        bytes.extend_from_slice(&ssrc.to_be_bytes());
        bytes.extend_from_slice(nutzlast);
        Medienpaket { sequenz, bytes }
    }

    #[test]
    fn kopf_mit_einer_maske_wird_gelesen() {
        let medien: Vec<_> = (0..5)
            .map(|i| medienpaket(1000 + i, 9000, 0xDEAD_BEEF, &[i as u8; 40]))
            .collect();
        let roh = paritaet_bauen(&medien, 0xDEAD_BEEF, 1000);

        let kopf = kopf_lesen(&roh).expect("Kopf lesbar");
        assert_eq!(kopf.geschuetzte_ssrc, 0xDEAD_BEEF);
        assert_eq!(kopf.basis_sequenz, 1000);
        assert_eq!(kopf.geschuetzte_sequenzen, vec![1000, 1001, 1002, 1003, 1004]);
        assert_eq!(kopf.nutzlast_beginn, BASIS_KOPF);
    }

    #[test]
    fn ein_verlorenes_paket_wird_byte_gleich_zurueckgerechnet() {
        let medien: Vec<_> = (0..5)
            .map(|i| medienpaket(1000 + i, 9000 + u32::from(i), 0xDEAD_BEEF, &[i as u8 * 7; 40]))
            .collect();
        let roh = paritaet_bauen(&medien, 0xDEAD_BEEF, 1000);
        let kopf = kopf_lesen(&roh).unwrap();

        for fehlend in 0..5usize {
            let erwartet = medien[fehlend].bytes.clone();
            let vorhanden: Vec<_> = medien
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != fehlend)
                .map(|(_, p)| Medienpaket { sequenz: p.sequenz, bytes: p.bytes.clone() })
                .collect();

            let wieder = zurueckrechnen(&kopf, &roh, &vorhanden, 1000 + fehlend as u16)
                .expect("Rueckrechnung gelingt");
            assert_eq!(wieder, erwartet, "Paket {fehlend} nicht byte-gleich");
        }
    }

    #[test]
    fn unterschiedlich_lange_pakete_bleiben_byte_gleich() {
        // Der haeufigste Fall im Betrieb: das letzte Paket eines Bildes ist
        // kuerzer als die uebrigen. Die Laenge kommt dann NUR aus dem
        // Wiederherstellungsfeld — ein Fehler dort faellt bei gleich langen
        // Paketen nicht auf.
        let medien = vec![
            medienpaket(500, 111, 42, &[1u8; 1188]),
            medienpaket(501, 111, 42, &[2u8; 1188]),
            medienpaket(502, 111, 42, &[3u8; 17]),
        ];
        let roh = paritaet_bauen(&medien, 42, 500);
        let kopf = kopf_lesen(&roh).unwrap();

        let vorhanden: Vec<_> = medien[..2]
            .iter()
            .map(|p| Medienpaket { sequenz: p.sequenz, bytes: p.bytes.clone() })
            .collect();
        let wieder = zurueckrechnen(&kopf, &roh, &vorhanden, 502).unwrap();
        assert_eq!(wieder, medien[2].bytes);
    }

    #[test]
    fn k_bit_ist_kein_maskenbit() {
        // Gegenprobe zur Falle aus der Kopfzeile: das oberste Bit von Byte 18
        // ist gesetzt (k), darf aber keine Sequenznummer erzeugen.
        let medien: Vec<_> = (0..3)
            .map(|i| medienpaket(7000 + i, 5, 1, &[i as u8; 20]))
            .collect();
        let roh = paritaet_bauen(&medien, 1, 7000);
        assert_eq!(roh[18] & 0x80, 0x80, "k-Bit sollte gesetzt sein");

        let kopf = kopf_lesen(&roh).unwrap();
        assert_eq!(kopf.geschuetzte_sequenzen, vec![7000, 7001, 7002]);
    }

    #[test]
    fn abgeschnittener_kopf_wird_abgelehnt() {
        assert!(kopf_lesen(&[0u8; 19]).is_err());
    }

    #[test]
    fn gesetztes_r_bit_wird_abgelehnt() {
        let mut roh = vec![0u8; BASIS_KOPF];
        roh[0] = 0x80;
        roh[8] = 1;
        assert!(kopf_lesen(&roh).is_err());
    }

    /// **Reproduktion Befund 21 — Schutzgruppe mit genau EINEM Mitglied.**
    ///
    /// Bis zum 2026-08-08 lehnte `kopf_lesen()` nur die voellig leere Maske
    /// ab, nicht eine mit genau einem gesetzten Bit. Eine solche Gruppe hat
    /// kein einziges echtes
    /// Vergleichspaket: beide XOR-Schleifen in `zurueckrechnen()` laufen null
    /// Mal, und das "reparierte" Paket besteht woertlich aus den Bytes, die
    /// der Absender in der Paritaetsnutzlast mitgeschickt hat.
    ///
    /// Erwartet nach der Behebung: Mindestgruppengroesse 2, also `is_err()`.
    ///
    /// **Umgebaut bei der Behebung.** Die Reproduktionsfassung liess sich
    /// `kopf_lesen()` erst gelingen (Nachweis der Ein-Bit-Maske) und verlangte
    /// dieselbe Rueckgabe danach als Fehler — nach der Behebung kann nur noch
    /// eines von beidem zutreffen. Geblieben ist die Zusicherung, die die
    /// Behebung beschreibt; der Ablauf, den sie ersetzt, steht oben im Text.
    #[test]
    fn repro_21_einzelgruppe_wird_angenommen() {
        let medien: Vec<_> = (0..1)
            .map(|i| medienpaket(1000 + i, 9000, 0xDEAD_BEEF, &[0xAB; 40]))
            .collect();
        let paritaet = paritaet_bauen(&medien, 0xDEAD_BEEF, 1000);

        let fehler = kopf_lesen(&paritaet).expect_err(
            "eine Schutzgruppe mit nur einem Mitglied muss abgelehnt werden \
             (Mindestgruppengroesse 2) — sonst liefert ihre Rueckrechnung die \
             Paritaetsnutzlast unveraendert zurueck und zaehlt als repariert",
        );
        assert!(
            fehler.to_string().contains("Mindestgruppengroesse"),
            "abgelehnt, aber aus einem anderen Grund: {fehler}"
        );

        // Gegenprobe, damit der Test nicht aus irgendeinem Grund gruen ist:
        // dieselbe Gruppe mit ZWEI Mitgliedern bleibt lesbar.
        let zwei: Vec<_> = (0..2)
            .map(|i| medienpaket(1000 + i, 9000, 0xDEAD_BEEF, &[0xAB; 40]))
            .collect();
        let kopf = kopf_lesen(&paritaet_bauen(&zwei, 0xDEAD_BEEF, 1000))
            .expect("ab zwei Mitgliedern unveraendert lesbar");
        assert_eq!(kopf.geschuetzte_sequenzen, vec![1000, 1001]);
    }
}
