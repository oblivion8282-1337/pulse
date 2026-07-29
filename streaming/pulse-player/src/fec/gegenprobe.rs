//! Prueft die Rueckrechnung gegen ECHTE Paritaetspakete des Servers.
//!
//! **Warum es das braucht.** Die Tests in `flexfec03.rs` pruefen gegen einen
//! Nachbau von pions Encoder in derselben Datei. Stimmt meine Lesart des
//! Formats an einer Stelle nicht, ist sie in Encoder UND Decoder gleich falsch
//! und der Test wird trotzdem gruen. Genau diese Falle hat in dieser Messreihe
//! schon einmal zugeschlagen (der `Av1Payloader` des `rtp`-Crates, 2026-07-28)
//! — dort wurde der Fehler des Generators als eigener diagnostiziert.
//!
//! **Der Kniff: es braucht keinen Verlust.** Geprueft wird an Gruppen, die
//! VOLLSTAENDIG angekommen sind. Jedes Paket der Gruppe wird einmal
//! weggelassen, zurueckgerechnet und mit dem echten verglichen. Damit ist
//! jedes Paket sowohl Eingabe als auch Sollwert, und die Prueflast steigt mit
//! der Gruppengroesse statt mit der Verlustrate. Ein simulierter Verlust
//! wuerde dagegen genau die Pakete verstecken, gegen die man vergleichen will.
//!
//! Eingeschaltet mit `PULSE_PLAYER_FEC_GEGENPROBE=1` (setzt `PULSE_PLAYER_FLEXFEC=1`
//! voraus). Reine Pruefbetriebsart: sie repariert nichts und veraendert den
//! Empfangsweg nicht.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use super::flexfec03::{kopf_lesen, zurueckrechnen, Medienpaket};

/// Wie viele Medienpakete vorgehalten werden. Eine Gruppe umfasst zehn, die
/// Paritaet kann aber nachlaufen — 512 deckt jede Verzoegerung ab, die nicht
/// ohnehin ein Fehler waere.
const VORRAT: usize = 512;

/// Nach wie vielen geprueften Gruppen ein Zwischenstand gemeldet wird.
const MELDEABSTAND: u64 = 50;

struct Pruefstand {
    medien: BTreeMap<u16, Vec<u8>>,
    gruppen_geprueft: u64,
    pakete_gleich: u64,
    pakete_abweichend: u64,
    gruppen_unvollstaendig: u64,
    kopf_fehler: u64,
    erste_abweichung_gemeldet: bool,
}

static PRUEFSTAND: OnceLock<Mutex<Pruefstand>> = OnceLock::new();

fn pruefstand() -> &'static Mutex<Pruefstand> {
    PRUEFSTAND.get_or_init(|| {
        Mutex::new(Pruefstand {
            medien: BTreeMap::new(),
            gruppen_geprueft: 0,
            pakete_gleich: 0,
            pakete_abweichend: 0,
            gruppen_unvollstaendig: 0,
            kopf_fehler: 0,
            erste_abweichung_gemeldet: false,
        })
    })
}

pub fn eingeschaltet() -> bool {
    std::env::var("PULSE_PLAYER_FEC_GEGENPROBE").as_deref() == Ok("1")
}

/// Legt ein empfangenes Medienpaket ab.
///
/// `bytes` muessen die vollstaendigen Bytes sein, so wie sie ueber die Leitung
/// kamen — die Rechnung des Verfahrens bezieht sich auf genau die.
pub fn medienpaket(sequenz: u16, bytes: Vec<u8>) {
    let mut p = pruefstand().lock().unwrap();
    p.medien.insert(sequenz, bytes);
    while p.medien.len() > VORRAT {
        let Some(&aeltester) = p.medien.keys().next() else { break };
        p.medien.remove(&aeltester);
    }
}

/// Prueft ein echtes Paritaetspaket gegen die vorhandenen Medienpakete.
pub fn paritaetspaket(nutzlast: &[u8]) {
    let kopf = match kopf_lesen(nutzlast) {
        Ok(k) => k,
        Err(e) => {
            let mut p = pruefstand().lock().unwrap();
            p.kopf_fehler += 1;
            if p.kopf_fehler <= 3 {
                eprintln!("pulse-player: Gegenprobe: Kopf nicht lesbar: {e}");
            }
            return;
        }
    };

    let mut p = pruefstand().lock().unwrap();

    // Nur vollstaendige Gruppen taugen: fehlt eines der geschuetzten Pakete
    // wirklich, gibt es keinen Sollwert zum Vergleichen.
    let mut gruppe: Vec<Medienpaket> = Vec::with_capacity(kopf.geschuetzte_sequenzen.len());
    for &seq in &kopf.geschuetzte_sequenzen {
        let Some(bytes) = p.medien.get(&seq) else {
            p.gruppen_unvollstaendig += 1;
            return;
        };
        gruppe.push(Medienpaket { sequenz: seq, bytes: bytes.clone() });
    }

    let mut gleich = 0u64;
    let mut abweichend = 0u64;
    let mut erste_meldung: Option<String> = None;

    for weggelassen in 0..gruppe.len() {
        let soll = &gruppe[weggelassen];
        let vorhanden: Vec<Medienpaket> = gruppe
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != weggelassen)
            .map(|(_, m)| Medienpaket { sequenz: m.sequenz, bytes: m.bytes.clone() })
            .collect();

        match zurueckrechnen(&kopf, nutzlast, &vorhanden, soll.sequenz) {
            Ok(wieder) if wieder == soll.bytes => gleich += 1,
            Ok(wieder) => {
                abweichend += 1;
                if erste_meldung.is_none() {
                    erste_meldung = Some(format!(
                        "seq={} Laenge {} gegen {} erwartet; erste Abweichung bei Byte {}",
                        soll.sequenz,
                        wieder.len(),
                        soll.bytes.len(),
                        wieder
                            .iter()
                            .zip(soll.bytes.iter())
                            .position(|(a, b)| a != b)
                            .map_or_else(|| "—".to_string(), |i| i.to_string()),
                    ));
                }
            }
            Err(e) => {
                abweichend += 1;
                if erste_meldung.is_none() {
                    erste_meldung = Some(format!("seq={}: {e}", soll.sequenz));
                }
            }
        }
    }

    p.gruppen_geprueft += 1;
    p.pakete_gleich += gleich;
    p.pakete_abweichend += abweichend;

    // Die ERSTE Abweichung ausfuehrlich melden. Ein Zaehler allein sagt nicht,
    // ob die Laenge, der Kopf oder die Nutzlast falsch ist — und genau das
    // entscheidet, wo der Fehler steckt.
    if abweichend > 0 && !p.erste_abweichung_gemeldet {
        p.erste_abweichung_gemeldet = true;
        if let Some(m) = erste_meldung {
            eprintln!("pulse-player: Gegenprobe WEICHT AB: {m}");
        }
    }

    if p.gruppen_geprueft % MELDEABSTAND == 0 {
        eprintln!(
            "pulse-player: Gegenprobe: {} Gruppen, {} Pakete byte-gleich, {} abweichend, \
             {} Gruppen unvollstaendig",
            p.gruppen_geprueft, p.pakete_gleich, p.pakete_abweichend, p.gruppen_unvollstaendig
        );
    }
}

/// Abschliessender Stand, beim Ende der Sitzung.
pub fn bilanz() {
    let p = pruefstand().lock().unwrap();
    if p.gruppen_geprueft == 0 && p.gruppen_unvollstaendig == 0 {
        return;
    }
    eprintln!(
        "pulse-player: Gegenprobe BILANZ: {} Gruppen geprueft, {} Pakete byte-gleich, \
         {} abweichend, {} Gruppen unvollstaendig, {} Koepfe unlesbar",
        p.gruppen_geprueft,
        p.pakete_gleich,
        p.pakete_abweichend,
        p.gruppen_unvollstaendig,
        p.kopf_fehler
    );
}
