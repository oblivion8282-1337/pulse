//! Die Zustandsmaschine beider Enden — angekuendigt, unterwegs, Frist.
//!
//! Zwei Haelften, absichtlich getrennt: [`Ankuendiger`] ist meine Seite (was
//! ICH habe und liefere), [`Empfaenger`] die Gegenseite (was DRUEBEN liegt und
//! was ich davon hole). Jedes Ende haelt beide — die Richtung ist symmetrisch.

use crate::format::{Grund, Inhaltstyp, Rahmen};
use crate::stueckelung::{Sammler, zerlegen};

/// Wie lange ein Abruf hoechstens dauern darf.
///
/// Muss **unter** der Gnadenfrist der Fernsteuerung liegen (`REMOTE_DISCONNECT_
/// GRACE_S`, Vorgabe 10 s) — ein Test haelt die Beziehung fest. Der Grund ist
/// nicht das Netz, sondern das wartende Programm: auf Windows und macOS
/// blockiert der Einfuegevorgang, solange geliefert wird.
pub const ABRUF_FRIST_MS: u64 = 2_000;

/// Meine Seite: was ich habe und was ich davon herausgebe.
pub struct Ankuendiger {
    generation: u64,
}

impl Ankuendiger {
    pub fn neu() -> Ankuendiger {
        // Generation 0 heisst „nie angekuendigt". Ein `hol` mit gen 0 ist damit
        // immer veraltet, ohne Sonderfall.
        Ankuendiger { generation: 0 }
    }

    /// Meine Ablage hat sich geaendert. Liefert den Rahmen, der hinausgeht —
    /// **ohne Inhalt**.
    pub fn geaendert(&mut self) -> Rahmen {
        self.generation += 1;
        Rahmen::Neu { generation: self.generation, typ: Inhaltstyp::Text }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Ein `hol` beantworten. Der Inhalt wird **hier** gelesen, nicht vom
    /// Aufrufer mitgebracht — die Reihenfolge „erst die Aenderung abholen, dann
    /// die Generation vergleichen, dann lesen" ist der Sinn dieser Signatur.
    pub fn beantworte(
        &mut self,
        hol: &Rahmen,
        beobachter: &mut impl crate::beobachter::Beobachter,
    ) -> Vec<Rahmen> {
        let Rahmen::Hol { generation, id } = hol else {
            return Vec::new();
        };
        // **Die Aenderungsmeldung wird HIER abgeholt, nicht irgendwann vorher
        // vom Aufrufer.** Zwischen der Ankuendigung und dieser Antwort kann der
        // Nutzer laengst etwas anderes kopiert haben; `lesen()` liefert dann den
        // NEUEN Inhalt, waehrend `self.generation` noch die ALTE Nummer traegt —
        // und damit ginge Inhalt hinaus, den nie jemand angekuendigt hat. Der
        // Aufrufer koennte das nicht verhindern: er merkt die Aenderung
        // fruehestens bei seinem naechsten Takt (macOS pollt 200 ms).
        //
        // Gemeint ist `Beobachter::geaendert` (meldet nur), nicht das
        // gleichnamige `Ankuendiger::geaendert` (erhoeht und baut den Rahmen).
        if beobachter.geaendert() {
            // Die frische Ankuendigung reist MIT. Ohne sie hielte die
            // Gegenseite fuer immer eine Nummer, die es nicht mehr gibt, und
            // jedes weitere `hol` liefe wieder auf `veraltet` — die Ablage
            // waere still tot. `Self::geaendert` ist die eine Stelle, die die
            // Nummer erhoeht; sie wird deshalb hier benutzt statt nachgebaut.
            let ankuendigung = self.geaendert();
            return vec![Rahmen::Leer { id: *id, grund: Grund::Veraltet }, ankuendigung];
        }
        // **Dann die Generation.** Stimmt sie nicht, wird nicht einmal
        // gelesen — es gaebe nichts zu liefern, das der Anfragende gemeint hat.
        if *generation != self.generation || self.generation == 0 {
            return vec![Rahmen::Leer { id: *id, grund: Grund::Veraltet }];
        }
        let Some(text) = beobachter.lesen() else {
            return vec![Rahmen::Leer { id: *id, grund: Grund::Weg }];
        };
        // **Die Laengengrenze wird hier NICHT noch einmal geprueft.** `zerlegen`
        // haelt sie und meldet `Err(Grund::ZuGross)`, das die Zeile darunter
        // abbildet. Zwei Stellen, die dieselbe Grenze pruefen, laufen
        // auseinander, sobald eine von beiden angefasst wird.
        match zerlegen(*id, &text) {
            Ok(stuecke) => stuecke,
            Err(grund) => vec![Rahmen::Leer { id: *id, grund }],
        }
    }
}

/// Wie weit ein laufender Abruf ist.
#[derive(Debug, PartialEq, Eq)]
pub enum Fortschritt {
    Warten,
    Fertig(String),
    Leer(Grund),
}

struct Laufend {
    id: u64,
    seit_ms: u64,
    sammler: Sammler,
}

/// Die Gegenseite: was drueben liegt und was ich davon hole.
pub struct Empfaenger {
    fremde_generation: Option<u64>,
    laufend: Option<Laufend>,
    naechste_id: u64,
}

impl Empfaenger {
    pub fn neu() -> Empfaenger {
        Empfaenger { fremde_generation: None, laufend: None, naechste_id: 1 }
    }

    /// Eine Ankuendigung der Gegenseite. Liefert `true`, wenn daraufhin die
    /// **lokale Ablage zu beanspruchen** ist.
    ///
    /// Ein unbekannter Inhaltstyp liefert `false`: wir koennten nichts liefern,
    /// und ein Anspruch, den wir nicht einloesen koennen, kostete den
    /// Vorbestand des Nutzers.
    pub fn angekuendigt(&mut self, rahmen: &Rahmen) -> bool {
        let Rahmen::Neu { generation, typ } = rahmen else {
            return false;
        };
        if *typ != Inhaltstyp::Text {
            return false;
        }
        if self.fremde_generation == Some(*generation) {
            // Dieselbe Nummer wie zuletzt: die Gegenseite frischt nur auf. Ein
            // zweiter Anspruch braucht es dafuer nicht, und auf Wayland kostete
            // er ein sinnloses `set_selection`.
            return false;
        }
        self.fremde_generation = Some(*generation);
        // Ein laufender Abruf gilt der ALTEN Generation und wird von der
        // Gegenseite ohnehin mit `veraltet` beantwortet — verworfen wird er
        // hier trotzdem nicht: sonst bliebe der wartende Einfuegevorgang ohne
        // Antwort haengen, bis seine Frist ablaeuft.
        true
    }

    /// Es wird gerade eingefuegt — den Abruf bauen.
    pub fn abrufen(&mut self, jetzt_ms: u64) -> Option<Rahmen> {
        let generation = self.fremde_generation?;
        // **Zuerst die Frist, dann die Entscheidung.** `takt()` ist sonst die
        // einzige Stelle, die einen haengenden Abruf loest — und ihr Aufruf ist
        // Verbraucher-Disziplin. Hoert der Verbraucher auf zu takten (was er
        // tut, sobald niemand mehr wartet), bliebe `laufend` fuer den Rest der
        // Sitzung stehen und die Ablage waere still tot. Die Frist gehoert in
        // diese Kiste, also darf sie nicht von der Sorgfalt ihres Aufrufers
        // abhaengen.
        if let Some(laufend) = self.laufend.as_ref()
            && jetzt_ms.saturating_sub(laufend.seit_ms) >= ABRUF_FRIST_MS
        {
            self.laufend = None;
        }
        if self.laufend.is_some() {
            return None;
        }
        let id = self.naechste_id;
        self.naechste_id += 1;
        self.laufend = Some(Laufend { id, seit_ms: jetzt_ms, sammler: Sammler::neu(id) });
        Some(Rahmen::Hol { generation, id })
    }

    /// Ein Rahmen der Gegenseite.
    pub fn eingang(&mut self, rahmen: &Rahmen) -> Fortschritt {
        let Some(laufend) = self.laufend.as_mut() else {
            // Kein Abruf offen — etwa nach Fristablauf. Still verwerfen: ein
            // spaetes Stueck ist ein Rennen, kein Angriff.
            return Fortschritt::Warten;
        };
        match rahmen {
            Rahmen::Leer { id, grund } if *id == laufend.id => {
                let g = *grund;
                self.laufend = None;
                Fortschritt::Leer(g)
            }
            Rahmen::Stueck { id, .. } if *id == laufend.id => match laufend.sammler.nimm(rahmen) {
                Ok(Some(text)) => {
                    self.laufend = None;
                    Fortschritt::Fertig(text)
                }
                Ok(None) => Fortschritt::Warten,
                Err(_) => {
                    // Ein kaputtes Stueck macht die ganze Lieferung unbrauchbar
                    // — halb eingefuegter Text waere schlimmer als gar keiner.
                    self.laufend = None;
                    Fortschritt::Leer(Grund::Weg)
                }
            },
            _ => Fortschritt::Warten,
        }
    }

    /// Zeitablauf pruefen. Ruft der Aufrufer regelmaessig, waehrend er wartet.
    pub fn takt(&mut self, jetzt_ms: u64) -> Fortschritt {
        let Some(laufend) = self.laufend.as_ref() else {
            return Fortschritt::Warten;
        };
        if jetzt_ms.saturating_sub(laufend.seit_ms) < ABRUF_FRIST_MS {
            return Fortschritt::Warten;
        }
        self.laufend = None;
        Fortschritt::Leer(Grund::Frist)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Gemeint ist das Trait — `TestAblage::geaendert` ist seine Umsetzung und
    // ohne diesen Import nicht sichtbar.
    use crate::beobachter::Beobachter;
    use crate::format::Inhaltstyp;

    #[test]
    fn ankuendigung_traegt_keinen_inhalt() {
        // Der Kern des ganzen Entwurfs. Sollte diese Zusicherung je fallen,
        // liegt jedes lokal kopierte Passwort sofort auf dem fremden Rechner.
        let mut a = Ankuendiger::neu();
        let r = a.geaendert();
        assert_eq!(r, Rahmen::Neu { generation: 1, typ: Inhaltstyp::Text });
        let j = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
        // **Woertlich diese drei Felder und keins mehr.** Ein Teilstring-Test
        // („enthaelt 'geheim' nicht") waere wirkungslos: `geaendert()` nimmt gar
        // keinen Inhalt entgegen, es gaebe nichts, was dort landen koennte.
        // Diese Fassung wird rot, sobald jemand `Rahmen::Neu` um ein Feld
        // erweitert — und genau das ist der Weg, auf dem Inhalt jemals in eine
        // Ankuendigung geriete.
        //
        // Die Reihenfolge ist alphabetisch, nicht die Schreibreihenfolge:
        // `serde_json::Map` ist ohne das Merkmal `preserve_order` eine
        // BTreeMap. Nachgemessen, nicht angenommen.
        assert_eq!(j, r#"{"gen":1,"t":"neu","typ":"text"}"#);
    }

    #[test]
    fn jede_aenderung_erhoeht_die_generation() {
        let mut a = Ankuendiger::neu();
        a.geaendert();
        a.geaendert();
        assert_eq!(a.generation(), 2);
    }

    /// Eine Ablage mit `text` darin, deren Aenderungsmeldung schon quittiert
    /// ist. So prueft jeder Test darunter genau seine Regel und nicht
    /// nebenbei das Aenderungs-Rennen aus C1.
    fn ablage_mit(text: Option<&str>) -> crate::pruefstand::TestAblage {
        let mut ablage = crate::pruefstand::TestAblage::neu();
        if let Some(t) = text {
            ablage.setzen(t);
        }
        ablage.geaendert();
        ablage
    }

    #[test]
    fn veraltete_anfrage_bekommt_nie_den_neuen_inhalt() {
        // Die wichtigste Regel des Protokolls: es wird nie ein ANDERER Inhalt
        // geliefert als der angekuendigte.
        let mut a = Ankuendiger::neu();
        let mut ablage = ablage_mit(Some("neu"));
        a.geaendert(); // gen 1 — "alt"
        a.geaendert(); // gen 2 — "neu"
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, &mut ablage);
        assert_eq!(antwort, vec![Rahmen::Leer { id: 5, grund: Grund::Veraltet }]);
    }

    #[test]
    fn passende_anfrage_bekommt_den_inhalt() {
        let mut a = Ankuendiger::neu();
        let mut ablage = ablage_mit(Some("hallo"));
        a.geaendert();
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, &mut ablage);
        assert_eq!(antwort.len(), 1);
        assert!(matches!(antwort[0], Rahmen::Stueck { id: 5, i: 0, n: 1, .. }));
    }

    #[test]
    fn leere_ablage_beantwortet_mit_weg() {
        let mut a = Ankuendiger::neu();
        let mut ablage = ablage_mit(None);
        a.geaendert();
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, &mut ablage);
        assert_eq!(antwort, vec![Rahmen::Leer { id: 5, grund: Grund::Weg }]);
    }

    #[test]
    fn zu_grosser_inhalt_beantwortet_mit_zu_gross() {
        let mut a = Ankuendiger::neu();
        let riesig = "z".repeat(crate::format::MAX_TEXT_BYTE + 1);
        let mut ablage = ablage_mit(Some(&riesig));
        a.geaendert();
        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, &mut ablage);
        assert_eq!(antwort, vec![Rahmen::Leer { id: 5, grund: Grund::ZuGross }]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn eine_unbemerkte_aenderung_liefert_NIE_den_neuen_inhalt() {
        // **Der Kern von C1.** Der Nutzer kopiert etwas Neues, der Ankuendiger
        // hat es noch nicht bemerkt (der Poll lief noch nicht) — und genau dann
        // trifft ein `hol` auf die alte Nummer ein.
        let mut a = Ankuendiger::neu();
        let mut ablage = ablage_mit(Some("harmlos"));
        a.geaendert(); // gen 1, angekuendigt wurde "harmlos"

        // Jetzt kopiert der Nutzer ein Geheimnis — unbemerkt.
        ablage.setzen("streng geheim");

        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, &mut ablage);
        for r in &antwort {
            let j = serde_json::to_string(&r.nach_json()).expect("serialisierbar");
            assert!(!j.contains("geheim"), "Geheimnis in der Antwort: {j}");
        }
        assert!(
            matches!(antwort.first(), Some(Rahmen::Leer { grund: Grund::Veraltet, .. })),
            "die Anfrage muss als veraltet abgewiesen werden, bekam: {antwort:?}"
        );
    }

    #[test]
    fn nach_einer_unbemerkten_aenderung_reist_die_frische_ankuendigung_mit() {
        // Ohne sie hielte die Gegenseite fuer immer eine Nummer, die es nicht
        // mehr gibt: jedes weitere `hol` bekaeme `veraltet`, und die Ablage
        // waere still tot.
        let mut a = Ankuendiger::neu();
        let mut ablage = ablage_mit(Some("alt"));
        a.geaendert(); // gen 1
        ablage.setzen("neu"); // unbemerkt

        let antwort = a.beantworte(&Rahmen::Hol { generation: 1, id: 5 }, &mut ablage);
        assert_eq!(antwort.len(), 2, "veraltet UND frische Ankuendigung: {antwort:?}");
        assert_eq!(
            antwort[1],
            Rahmen::Neu { generation: 2, typ: crate::format::Inhaltstyp::Text }
        );
        assert_eq!(a.generation(), 2);
    }

    #[test]
    fn ohne_ankuendigung_wird_nicht_abgerufen() {
        let mut e = Empfaenger::neu();
        assert_eq!(e.abrufen(0), None, "es gibt nichts zu holen");
    }

    #[test]
    fn unbekannter_typ_wird_nicht_beansprucht() {
        // Stufe 2 schickt `dateien`. Diese Fassung darf die lokale Ablage
        // dafuer NICHT beanspruchen — sie koennte nichts liefern, und der
        // Vorbestand des Nutzers waere weg.
        let mut e = Empfaenger::neu();
        let angekuendigt = e.angekuendigt(&Rahmen::Neu {
            generation: 1,
            typ: Inhaltstyp::Anderes("dateien".into()),
        });
        assert!(!angekuendigt);
        assert_eq!(e.abrufen(0), None);
    }

    #[test]
    fn abruf_nennt_die_angekuendigte_generation() {
        let mut e = Empfaenger::neu();
        assert!(e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }));
        assert_eq!(e.abrufen(0), Some(Rahmen::Hol { generation: 4, id: 1 }));
    }

    #[test]
    fn ein_abgelaufener_abruf_blockiert_den_naechsten_nicht() {
        // Ohne diese Selbstheilung haenge die Ablage fuer den Rest der Sitzung,
        // sobald der Verbraucher aufhoert zu takten — und das tut er genau
        // dann, wenn niemand mehr auf ein Einfuegen wartet.
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        assert!(e.abrufen(1_000).is_some());
        // Kein `takt()` — der Verbraucher hat aufgehoert.
        assert!(
            e.abrufen(1_000 + ABRUF_FRIST_MS).is_some(),
            "der abgelaufene Abruf muss beim naechsten Versuch selbst geraeumt werden"
        );
    }

    #[test]
    fn dieselbe_generation_wird_nicht_zweimal_beansprucht() {
        // Eine Ankuendigung, die nur auffrischt, darf keinen zweiten Anspruch
        // ausloesen: auf Wayland kostete er ein sinnloses `set_selection`.
        let mut e = Empfaenger::neu();
        assert!(e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }));
        assert!(!e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text }));
        assert!(e.angekuendigt(&Rahmen::Neu { generation: 5, typ: Inhaltstyp::Text }));
    }

    #[test]
    fn zweiter_abruf_waehrend_eines_laufenden_wird_abgelehnt() {
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        e.abrufen(0);
        assert_eq!(e.abrufen(10), None, "es laeuft schon einer");
    }

    #[test]
    fn stuecke_fuehren_zu_fertig() {
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(0) else { panic!("Abruf fehlt") };
        for r in crate::stueckelung::zerlegen(id, "hallo").expect("passt") {
            match e.eingang(&r) {
                Fortschritt::Fertig(t) => {
                    assert_eq!(t, "hallo");
                    return;
                }
                Fortschritt::Warten => {}
                Fortschritt::Leer(g) => panic!("unerwartet leer: {g:?}"),
            }
        }
        panic!("nie fertig geworden");
    }

    #[test]
    fn leer_rahmen_beendet_den_abruf() {
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(0) else { panic!("Abruf fehlt") };
        assert_eq!(
            e.eingang(&Rahmen::Leer { id, grund: Grund::Veraltet }),
            Fortschritt::Leer(Grund::Veraltet)
        );
        // Danach ist wieder ein Abruf moeglich.
        assert!(e.abrufen(10).is_some());
    }

    #[test]
    fn ein_kaputtes_stueck_verwirft_die_ganze_lieferung() {
        // Halb eingefuegter Text waere schlimmer als gar keiner: der Nutzer
        // saehe eine abgeschnittene Zeichenkette und merkte es womoeglich nicht.
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(0) else { panic!("Abruf fehlt") };
        let stuecke = crate::stueckelung::zerlegen(id, &"z".repeat(20_000)).expect("passt");
        assert!(stuecke.len() > 2, "der Fall braucht mehrere Stuecke");
        assert_eq!(e.eingang(&stuecke[0]), Fortschritt::Warten);
        // Ein Stueck mit kaputtem Base64 — `Sammler::nimm` liefert `Err`.
        let kaputt = Rahmen::Stueck { id, i: 1, n: stuecke.len() as u32, d: "!!!".into() };
        assert_eq!(e.eingang(&kaputt), Fortschritt::Leer(Grund::Weg));
        // Und der Abruf ist geraeumt: die noch fehlenden Stuecke duerfen die
        // angebrochene Lieferung nicht doch noch vollenden.
        assert_eq!(e.eingang(&stuecke[1]), Fortschritt::Warten);
        assert_eq!(e.eingang(&stuecke[2]), Fortschritt::Warten);
    }

    #[test]
    fn frist_laeuft_ab_und_spaete_stuecke_werden_ignoriert() {
        // **Der Grund fuer die Frist:** auf Windows und macOS blockiert das
        // einfuegende Programm, solange wir liefern. Ein Einfuegen, das nichts
        // einfuegt, versteht jeder; ein haengendes Programm nicht.
        let mut e = Empfaenger::neu();
        e.angekuendigt(&Rahmen::Neu { generation: 4, typ: Inhaltstyp::Text });
        let Some(Rahmen::Hol { id, .. }) = e.abrufen(1_000) else { panic!("Abruf fehlt") };
        assert_eq!(e.takt(1_000 + ABRUF_FRIST_MS - 1), Fortschritt::Warten);
        assert_eq!(e.takt(1_000 + ABRUF_FRIST_MS), Fortschritt::Leer(Grund::Frist));
        let spaet = crate::stueckelung::zerlegen(id, "hallo").expect("passt");
        assert_eq!(
            e.eingang(&spaet[0]),
            Fortschritt::Warten,
            "ein Stueck nach Fristablauf darf nichts mehr ausloesen"
        );
    }

    #[test]
    fn abruf_frist_liegt_unter_der_gnadenfrist() {
        // **Eine Beziehung, kein Einzelwert.** Reisst der Socket mitten im
        // Abruf ab, haelt die Gnadenfrist die SITZUNG offen
        // (`REMOTE_DISCONNECT_GRACE_S`, Vorgabe 10 s,
        // `services/chat-gateway/src/dcc_chat_gateway/remote_reconnect_registry.py`).
        // Der ABRUF darf darauf nicht warten — sonst steht das einfuegende
        // Programm zehn Sekunden. Dieselbe Bauart wie `CLIENT_GRACE_MS` gegen
        // die Server-Frist in `web/src/lib/remote/gnadenfrist.ts`.
        //
        // Die 10_000 sind hier eine SPIEGELKONSTANTE: aendert sich die Vorgabe
        // drueben, muss dieser Test von Hand nachgezogen werden. Ein Test ueber
        // die Sprachgrenze gibt es hier nicht — er waere die dritte Kopie
        // derselben Zahl.
        const GNADENFRIST_MS: u64 = 10_000;
        assert!(
            ABRUF_FRIST_MS < GNADENFRIST_MS,
            "ABRUF_FRIST_MS ({ABRUF_FRIST_MS}) muss unter der Gnadenfrist \
             ({GNADENFRIST_MS}) liegen"
        );
    }
}
