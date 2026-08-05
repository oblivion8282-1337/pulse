//! AV1 aus RTP-Paketen wieder zusammensetzen — die Gegenrichtung zu
//! [`super::av1::paketiere`].
//!
//! **Warum von Hand.** Dasselbe wie beim Paketieren, nur noch deutlicher: das
//! `rtp`-Crate hat für AV1 gar keinen Entpacker, nur einen Paketierer (und
//! dessen Längenfelder sind falsch, s. [`super::av1`]). Für H.264 gäbe es
//! einen; für AV1 muss man selbst ran.
//!
//! **Wozu überhaupt.** Ein Messstand, der nur zählt, wie viele Pakete ankommen,
//! beantwortet die interessante Frage nicht. Die lautet: kommt ein Zuschauer
//! nach einem Verlust **wieder ins Bild**, und wie lange dauert das? Dafür muss
//! jemand die Pakete zu Bildern zusammensetzen und die einem Decoder vorlegen.
//! Genau das ist hier der Zweck — nicht Wiedergabe.
//!
//! **Die Prüfung ist der Rundlauf.** `paketiere` → `entpaketiere` muss wieder
//! dasselbe ergeben, und das lässt sich ohne Netz, ohne Server und ohne GPU
//! prüfen (Tests unten). Ein Entpacker, der nur am lebenden Strom getestet
//! wird, verwechselt seine eigenen Fehler mit Übertragungsfehlern.
//!
//! Grundlage: <https://aomediacodec.github.io/av1-rtp-spec/>, Abschnitte 4.4
//! und 5.

use anyhow::{Result, bail};

/// OBU-Typ des Zeittrenners — die AV1-Bildgrenze.
///
/// **Steht hier, weil diese Tatsache sonst dreifach im Haus liegt.** Sie wird
/// an drei Stellen gebraucht: beim Schreiben einer Datei (als Bytefolge), beim
/// Teilen einer Mitschrift und beim Entpacken. `super::av1` führt sie ein
/// viertes Mal — das bleibt so: die Datei ist laut `CLAUDE.md` eine wortgleiche
/// Kopie der Linux-Seite, und Abweichungen sind dort teuer. Dieses Modul ist
/// dagegen hier entstanden und der richtige Ort für empfängerseitiges
/// AV1-Wissen.
pub(crate) const OBU_ZEITTRENNER: u8 = 2;

/// Derselbe Zeittrenner als fertige Bytefolge: Kopf mit `has_size_field`,
/// Länge 0.
///
/// **Ohne ihn ist eine mitgeschriebene Datei nicht auswertbar.** Der Encoder
/// liefert je Bild einen Zeitabschnitt ohne Trenner; ein Leser findet dann
/// keine Bildgrenzen und meldet „No sequence header available" — was nach einem
/// kaputten Encoder aussieht und keiner ist. FFmpegs eigener `obu`-Muxer setzt
/// ihn genauso.
pub(crate) const ZEITTRENNER: [u8; 2] = [(OBU_ZEITTRENNER << 3) | 0b10, 0x00];

/// Ein OBU in einem zusammengesetzten Zeitabschnitt.
///
/// **Der Durchlauf steht hier, weil ihn zwei Stellen brauchen** — die
/// Level-Korrektur im Sendeweg ([`super::av1_level`]) und das Teilen einer
/// Mitschrift beim Zuschauer (`whep::dekoder`). [`super::av1`] führt ihn ein
/// drittes Mal, und das bleibt so: die Datei ist laut `CLAUDE.md` eine
/// wortgleiche Kopie der Linux-Seite, Abweichungen dort sind teuer. Zwei
/// Fassungen statt drei sind der erreichbare Gewinn.
pub(crate) struct Obu {
    pub(crate) typ: u8,
    pub(crate) start: usize,
    /// Länge von Kopf **und** Erweiterungsbyte, ohne das Größenfeld.
    pub(crate) kopf_len: usize,
    /// Beginn des Rumpfes, hinter dem Größenfeld.
    pub(crate) rumpf: usize,
    pub(crate) ende: usize,
}

/// Die OBU-Kette durchlaufen.
///
/// Bricht ab, wenn ein Kopf oder eine Größe über das Ende hinausreicht —
/// abgeschnittene Daten sind kein Fehler, sondern ein Zeitabschnitt, der nicht
/// vollständig ankam. Die Einträge grenzen lückenlos aneinander.
pub(crate) fn obus(daten: &[u8]) -> Result<Vec<Obu>> {
    let mut aus = Vec::new();
    let mut i = 0usize;
    while i < daten.len() {
        let b0 = daten[i];
        let typ = (b0 >> 3) & 0x0F;
        let kopf_len = 1 + usize::from((b0 >> 2) & 1 == 1);
        let hat_groesse = (b0 >> 1) & 1 == 1;
        if i + kopf_len > daten.len() {
            break;
        }
        let (rumpf, rumpf_len) = if hat_groesse {
            let (len, gelesen) = super::av1::lies_leb128(&daten[i + kopf_len..])?;
            (i + kopf_len + gelesen, len as usize)
        } else {
            (i + kopf_len, daten.len() - i - kopf_len)
        };
        if rumpf + rumpf_len > daten.len() {
            break;
        }
        aus.push(Obu { typ, start: i, kopf_len, rumpf, ende: rumpf + rumpf_len });
        i = rumpf + rumpf_len;
    }
    Ok(aus)
}

/// Sammelt RTP-Nutzlasten und gibt fertige Zeitabschnitte heraus.
///
/// Ein Zeitabschnitt ist das, was FFmpeg als ein Paket geliefert hat — ein
/// Bild samt allem, was dazugehört.
#[derive(Default)]
pub struct Sammler {
    /// Die OBUs des laufenden Zeitabschnitts, bereits vollständig.
    fertig: Vec<Vec<u8>>,
    /// Das OBU, das noch weiterläuft (letztes Paket hatte `Y`).
    offen: Option<Vec<u8>>,
    /// Ein Stück fehlt — der laufende Zeitabschnitt ist unbrauchbar.
    ///
    /// **Wichtig, dass es das gibt:** ein Bild aus halben OBUs sieht für den
    /// Decoder wie gültige Daten aus und führt zu Fehlern, die nach einem
    /// Encoder-Problem aussehen statt nach einem Verlust. Lieber den ganzen
    /// Abschnitt verwerfen und das zählen.
    kaputt: bool,
    /// Wie viele Abschnitte wegen einer Lücke verworfen wurden.
    pub verworfen: u64,
}

impl Sammler {
    /// Eine RTP-Nutzlast einwerfen.
    ///
    /// `verloren` sagt, dass vor diesem Paket mindestens eines fehlt (Lücke in
    /// der Sequenznummer). `marker` ist das Marker-Bit: es schließt den
    /// Zeitabschnitt ab.
    ///
    /// Gibt den fertigen Zeitabschnitt zurück, sobald einer vollständig ist —
    /// in der Form, die ein Decoder frisst (jedes OBU mit Größenfeld).
    pub fn schieb(
        &mut self,
        nutzlast: &[u8],
        marker: bool,
        verloren: bool,
    ) -> Result<Option<Vec<u8>>> {
        if verloren {
            self.kaputt = true;
            // Ein angefangenes OBU ist nach einer Lücke nicht mehr
            // fortsetzbar — sein Rest ist genau das, was fehlt.
            self.offen = None;
        }
        if nutzlast.is_empty() {
            bail!("leere AV1-Nutzlast");
        }

        let kopf = nutzlast[0];
        let z = kopf >> 7 & 1 == 1; // setzt das letzte OBU des Vorgaengers fort
        let y = kopf >> 6 & 1 == 1; // laeuft im naechsten Paket weiter
        let w = (kopf >> 4 & 0b11) as usize;

        let mut i = 1;
        let mut k = 0;
        while i < nutzlast.len() {
            // Bei `W != 0` traegt das letzte Element kein Laengenfeld — seine
            // Groesse ist der Rest des Pakets.
            let letztes = w != 0 && k + 1 == w;
            let (len, kopf_len) = if letztes {
                (nutzlast.len() - i, 0)
            } else {
                let (l, gelesen) = super::av1::lies_leb128(&nutzlast[i..])?;
                (l as usize, gelesen)
            };
            let von = i + kopf_len;
            let bis = von + len;
            if bis > nutzlast.len() {
                bail!("Element-Laenge {len} reicht ueber das Paketende");
            }
            let stueck = &nutzlast[von..bis];

            // Das erste Element setzt den Vorgaenger fort, wenn `Z` steht.
            if k == 0 && z {
                match self.offen.take() {
                    Some(mut teil) => {
                        teil.extend_from_slice(stueck);
                        self.offen = Some(teil);
                    }
                    // `Z` ohne offenes Stueck heisst: der Anfang fehlt.
                    None => self.kaputt = true,
                }
            } else {
                // Ein neues OBU faengt an. Was vorher offen war, ist damit
                // fertig — ausser es war das Ende dieses Pakets.
                if let Some(teil) = self.offen.take() {
                    self.fertig.push(teil);
                }
                self.offen = Some(stueck.to_vec());
            }

            i = bis;
            k += 1;
            if w != 0 && k >= w {
                break;
            }
        }

        // Laeuft das letzte OBU weiter, bleibt es offen; sonst ist es fertig.
        if !y && let Some(teil) = self.offen.take() {
            self.fertig.push(teil);
        }

        if !marker {
            return Ok(None);
        }
        // Marker = Ende des Zeitabschnitts.
        let obus = std::mem::take(&mut self.fertig);
        let kaputt = std::mem::replace(&mut self.kaputt, false);
        self.offen = None;
        if kaputt || obus.is_empty() {
            self.verworfen += 1;
            return Ok(None);
        }
        Ok(Some(zusammensetzen(&obus)))
    }
}

/// Die OBUs zu einem Strom fügen, den ein Decoder liest.
///
/// Ein Decoder braucht bei **jedem** OBU ein Größenfeld, nicht nur bei den
/// vorderen — ohne nimmt er den ganzen Rest als dessen Rumpf.
///
/// **Beide Fälle müssen hier durch, und das ist kein Zierrat.** Die
/// Spezifikation sagt zum Größenfeld in der RTP-Nutzlast „SHOULD be set to
/// zero" — ein *sollte*, kein *muss*. Unser eigener Paketierer löscht es
/// (`av1::zerlege`), aber die Pakete, die ein Zuschauer sieht, kommen nicht
/// vom Sender, sondern vom **Server**, der neu paketiert. Setzt der das Feld,
/// und fügt man dann blind ein zweites ein, entsteht ein Strom, den kein
/// Decoder liest — und zwar mit einer Meldung („Error parsing OBU data"), die
/// nach kaputter Übertragung aussieht statt nach einem Fehler beim
/// Zusammensetzen. Genau darauf bin ich am 2026-08-02 hereingefallen.
fn zusammensetzen(obus: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(obus.iter().map(Vec::len).sum::<usize>() + obus.len() * 3);
    for obu in obus {
        if obu.is_empty() {
            continue;
        }
        if (obu[0] >> 1) & 1 == 1 {
            // Trägt schon eines — unverändert übernehmen.
            out.extend_from_slice(obu);
            continue;
        }
        let hat_erweiterung = (obu[0] >> 2) & 1 == 1;
        let kopf_len = (1 + usize::from(hat_erweiterung)).min(obu.len());
        out.push(obu[0] | 0b10); // obu_has_size_field setzen
        out.extend_from_slice(&obu[1..kopf_len]);
        super::av1::schreibe_leb128(&mut out, (obu.len() - kopf_len) as u32);
        out.extend_from_slice(&obu[kopf_len..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::whip::av1::{MTU, paketiere};

    /// Der OBU-Durchlauf trägt seit 2026-08-02 zwei Aufrufer (Level-Korrektur
    /// im Sendeweg, Teilen einer Mitschrift beim Zuschauer) und braucht
    /// deshalb einen eigenen Test — vorher war er nur mittelbar geprüft.
    #[test]
    fn durchlauf_findet_alle_obus_lueckenlos() {
        let mut d = obu(2, 0, 0); // Zeittrenner
        d.extend_from_slice(&obu(1, 5, 0xAA)); // Sequenzkopf
        d.extend_from_slice(&obu(6, 9, 0xBB)); // Bild
        let o = obus(&d).unwrap();
        assert_eq!(o.iter().map(|x| x.typ).collect::<Vec<_>>(), vec![2, 1, 6]);
        assert_eq!(o[0].start, 0, "der erste beginnt bei 0");
        for paar in o.windows(2) {
            assert_eq!(paar[0].ende, paar[1].start, "die Einträge grenzen lueckenlos aneinander");
        }
        assert_eq!(o[2].ende, d.len(), "und der letzte endet am Ende");
        assert_eq!(&d[o[1].rumpf..o[1].ende], &[0xAA; 5], "der Rumpf zeigt auf die Nutzdaten");
    }

    /// **Abgeschnittene Daten sind kein Fehler, sondern ein Zeitabschnitt, der
    /// nicht vollständig ankam.** Der Durchlauf bricht ab und liefert, was
    /// ganz da ist — ein `bail!` hier hiesse, einen Verlust auf der Strecke als
    /// Programmfehler zu behandeln.
    #[test]
    fn abgeschnittene_daten_brechen_ab_statt_zu_scheitern() {
        let mut d = obu(2, 0, 0);
        let voll = obu(6, 9, 0xBB);
        d.extend_from_slice(&voll[..voll.len() - 3]); // hinten abgeschnitten
        let o = obus(&d).unwrap();
        assert_eq!(o.len(), 1, "nur der vollstaendige Zeittrenner");
        assert_eq!(o[0].typ, 2);
    }

    /// Die Bytefolge des Zeittrenners muss das sein, was `obu(2, 0, _)` baut.
    ///
    /// **Zwei Darstellungen derselben Tatsache**, und beide werden gebraucht:
    /// den Typ zum Erkennen, die Bytes zum Schreiben. Ohne diesen Test können
    /// sie auseinanderlaufen, und das Ergebnis wäre eine mitgeschriebene Datei,
    /// in der ein Leser keine Bildgrenzen findet — was nach einem kaputten
    /// Encoder aussieht.
    #[test]
    fn die_bytefolge_passt_zum_typ() {
        assert_eq!(ZEITTRENNER.to_vec(), obu(OBU_ZEITTRENNER, 0, 0));
    }

    /// Ein OBU bauen, wie FFmpeg es liefert: Kopf mit Groessenfeld, dann die
    /// LEB128-Groesse, dann der Rumpf.
    fn obu(typ: u8, rumpf_len: usize, fuellung: u8) -> Vec<u8> {
        let mut v = vec![(typ << 3) | 0b10];
        let mut len = Vec::new();
        crate::whip::av1::schreibe_leb128(&mut len, rumpf_len as u32);
        v.extend_from_slice(&len);
        v.extend(std::iter::repeat_n(fuellung, rumpf_len));
        v
    }

    /// Alles durch den Sammler schicken und den Zeitabschnitt einsammeln.
    fn rundlauf(eingabe: &[u8], mtu: usize) -> Option<Vec<u8>> {
        let pakete = paketiere(eingabe, mtu).unwrap();
        let mut s = Sammler::default();
        let mut aus = None;
        for (i, p) in pakete.iter().enumerate() {
            let marker = i + 1 == pakete.len();
            if let Some(v) = s.schieb(&p.daten, marker, false).unwrap() {
                aus = Some(v);
            }
        }
        aus
    }

    /// **Das Fuellbyte des Bildes ist nicht beliebig.** Seit dem 2026-08-02
    /// wirft der Paketierer einen Sequenzkopf weg, dem kein Vollbild folgt (die
    /// Begruendung steht an `av1::paketiere`), und die ersten drei Bit des
    /// Bildrumpfs entscheiden darueber. `0x1C` bedeutet Vollbild; mit dem
    /// frueheren `0x5C` waere es ein Intra-Only-Bild, der Kopf fiele zu Recht
    /// weg, und der Rundlauf vergliche zwei verschiedene Dinge.
    const VOLLBILD_FUELLUNG: u8 = 0x1C;

    /// **Die eigentliche Probe.** Was der Paketierer zerlegt, muss hier wieder
    /// zusammenkommen — Byte fuer Byte, nur mit zurueckgesetztem Groessenfeld.
    #[test]
    fn rundlauf_ergibt_wieder_dasselbe() {
        // Sequenzkopf (Typ 1) + Bild (Typ 6). Der Zeittrenner (Typ 2) faellt
        // beim Paketieren weg — er darf danach auch nicht wieder auftauchen.
        let mut ein = obu(2, 0, 0);
        ein.extend(obu(1, 12, 0xAA));
        ein.extend(obu(6, 300, VOLLBILD_FUELLUNG));

        let aus = rundlauf(&ein, MTU).expect("ein Zeitabschnitt muss herauskommen");

        // Erwartet: Sequenzkopf und Bild, jeweils mit Groessenfeld, ohne
        // Zeittrenner.
        let mut soll = obu(1, 12, 0xAA);
        soll.extend(obu(6, 300, VOLLBILD_FUELLUNG));
        assert_eq!(aus, soll, "der Rundlauf muss dasselbe ergeben");
    }

    /// Ein Bild, das ueber viele Pakete zerteilt wird, muss ebenso
    /// zusammenkommen — das ist der Fall, der im Betrieb der Regelfall ist.
    #[test]
    fn rundlauf_ueber_viele_pakete() {
        let ein = obu(6, 9000, 0x33);
        let aus = rundlauf(&ein, 300).expect("Zeitabschnitt");
        assert_eq!(aus, obu(6, 9000, 0x33));
    }

    /// Auch bei winziger MTU, wo ein OBU-Kopf selbst zerteilt wird.
    #[test]
    fn rundlauf_bei_winziger_mtu() {
        let mut ein = obu(1, 40, 0x11);
        ein.extend(obu(6, 500, VOLLBILD_FUELLUNG));
        let aus = rundlauf(&ein, 40).expect("Zeitabschnitt");
        let mut soll = obu(1, 40, 0x11);
        soll.extend(obu(6, 500, VOLLBILD_FUELLUNG));
        assert_eq!(aus, soll);
    }

    /// **Eine Luecke muss den ganzen Abschnitt verwerfen, nicht halb
    /// durchlassen.** Ein Bild aus halben OBUs sieht fuer den Decoder wie
    /// gueltige Daten aus — der Fehler saehe dann nach einem Encoder-Problem
    /// aus statt nach einem Verlust.
    #[test]
    fn luecke_verwirft_den_abschnitt() {
        let ein = obu(6, 5000, 0x42);
        let pakete = paketiere(&ein, 300).unwrap();
        assert!(pakete.len() > 3, "fuer diesen Test braucht es mehrere Pakete");

        let mut s = Sammler::default();
        let mut aus = None;
        for (i, p) in pakete.iter().enumerate() {
            if i == 2 {
                continue; // dieses Paket geht verloren
            }
            let marker = i + 1 == pakete.len();
            // Das Paket NACH dem verlorenen meldet die Luecke.
            let verloren = i == 3;
            if let Some(v) = s.schieb(&p.daten, marker, verloren).unwrap() {
                aus = Some(v);
            }
        }
        assert!(aus.is_none(), "ein Abschnitt mit Luecke darf nicht herauskommen");
        assert_eq!(s.verworfen, 1);
    }

    /// Nach einer verworfenen Luecke muss der NAECHSTE Abschnitt wieder
    /// sauber durchkommen — sonst bliebe der Zuschauer fuer immer schwarz,
    /// auch wenn wieder alles ankommt.
    #[test]
    fn nach_der_luecke_geht_es_weiter() {
        let ein = obu(6, 5000, 0x42);
        let pakete = paketiere(&ein, 300).unwrap();
        let mut s = Sammler::default();
        for (i, p) in pakete.iter().enumerate() {
            if i == 2 {
                continue;
            }
            let _ = s.schieb(&p.daten, i + 1 == pakete.len(), i == 3).unwrap();
        }
        // Zweiter, vollstaendiger Abschnitt.
        let mut aus = None;
        for (i, p) in pakete.iter().enumerate() {
            if let Some(v) = s.schieb(&p.daten, i + 1 == pakete.len(), false).unwrap() {
                aus = Some(v);
            }
        }
        assert_eq!(aus, Some(obu(6, 5000, 0x42)), "danach muss es weitergehen");
    }
}
