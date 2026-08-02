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
use std::time::Instant;

use super::flexfec03::{kopf_lesen, zurueckrechnen, Medienpaket};

/// Wie viele Medienpakete vorgehalten werden. Eine Gruppe umfasst
/// `PULSE_FLEXFEC_MEDIA / PULSE_FLEXFEC_FEC` Pakete (heute fuenf), die
/// Paritaet kann aber nachlaufen — 512 deckt jede Verzoegerung ab, die nicht
/// ohnehin ein Fehler waere.
const VORRAT: usize = 512;

/// Nach wie vielen geprueften Gruppen ein Zwischenstand gemeldet wird.
const MELDEABSTAND: u64 = 50;

struct Pruefstand {
    medien: BTreeMap<u16, (Vec<u8>, Instant)>,
    /// Wie lange die Paritaet dem LETZTEN Paket ihrer Gruppe nachlaeuft, in
    /// Mikrosekunden. Das ist die Groesse, die entscheidet, ob eine Reparatur
    /// den Jitter-Puffer noch rechtzeitig erreicht.
    nachlauf_us: Vec<u64>,
    /// Der KLEINSTE Abstand zwischen zwei geschuetzten Sequenznummern je
    /// Gruppe. Diese Zahl allein entscheidet, was ein Buendelverlust anrichtet:
    /// XOR loest genau eine Unbekannte je Gruppe, also ist ein Buendel dieser
    /// Laenge noch reparierbar und eines darueber nicht mehr. pion verteilt
    /// interleaved (`X % numFecPackets`), der Abstand ist damit die Zahl der
    /// Paritaetspakete — hier wird das am echten Strom nachgemessen statt aus
    /// fremdem Quelltext geglaubt.
    mindestabstand: BTreeMap<u16, u64>,
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
            nachlauf_us: Vec::new(),
            mindestabstand: BTreeMap::new(),
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
    p.medien.insert(sequenz, (bytes, Instant::now()));
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

    // Der Abstand steht im KOPF und braucht kein einziges Medienpaket — also
    // vor der Vollstaendigkeitspruefung erfassen. Sonst zaehlt nur, was
    // zufaellig komplett vorlag, und das ist bei hohem Durchsatz die
    // Minderheit.
    if let Some(kleinster) = kopf
        .geschuetzte_sequenzen
        .windows(2)
        .map(|w| w[1].wrapping_sub(w[0]))
        .min()
    {
        *p.mindestabstand.entry(kleinster).or_insert(0) += 1;
    }

    // Nur vollstaendige Gruppen taugen: fehlt eines der geschuetzten Pakete
    // wirklich, gibt es keinen Sollwert zum Vergleichen.
    let mut gruppe: Vec<Medienpaket> = Vec::with_capacity(kopf.geschuetzte_sequenzen.len());
    for &seq in &kopf.geschuetzte_sequenzen {
        let Some((bytes, _)) = p.medien.get(&seq) else {
            p.gruppen_unvollstaendig += 1;
            return;
        };
        gruppe.push(Medienpaket { sequenz: seq, bytes: bytes.clone() });
    }

    // Nachlauf: wie lange nach dem letzten geschuetzten Paket trifft die
    // Reserve ein? Der Jitter-Puffer beginnt seine Geduld mit der Ankunft des
    // ersten Pakets NACH der Luecke — die Reparatur muss also innerhalb dieser
    // Frist da sein, sonst ist die Einheit laengst verworfen.
    let jetzt = Instant::now();
    if let Some(spaeteste) = kopf
        .geschuetzte_sequenzen
        .iter()
        .filter_map(|s| p.medien.get(s).map(|(_, t)| *t))
        .max()
    {
        p.nachlauf_us.push(jetzt.duration_since(spaeteste).as_micros() as u64);
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
        nachlauf_melden(&p);
        abstand_melden(&p);
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

    nachlauf_melden(&p);
    abstand_melden(&p);
}

/// Die Streuung der Gruppen. Sagt voraus, was ein Buendelverlust anrichtet:
/// bis zu diesem Abstand trifft ein Buendel je Gruppe hoechstens ein Paket und
/// ist damit vollstaendig reparierbar, darueber nicht mehr.
fn abstand_melden(p: &Pruefstand) {
    if p.mindestabstand.is_empty() {
        return;
    }
    let verteilung: Vec<String> = p
        .mindestabstand
        .iter()
        .map(|(abstand, anzahl)| format!("{abstand}: {anzahl}x"))
        .collect();
    eprintln!(
        "pulse-player: STREUUNG der Paritaetsgruppen (kleinster Abstand \
         zwischen zwei geschuetzten Sequenznummern) — {}",
        verteilung.join(", ")
    );
}

/// Die Verteilung des Nachlaufs. Getrennt von `abstand_melden`, weil beide an
/// zwei Stellen gebraucht werden: laufend (die Bilanz kommt nur bei sauberem
/// Streamende, und genau das bleibt beim Abbruch der Sitzung aus) und
/// abschliessend.
fn nachlauf_melden(p: &Pruefstand) {
    if p.nachlauf_us.is_empty() {
        return;
    }
    let mut werte = p.nachlauf_us.clone();
    werte.sort_unstable();
    let bei = |anteil: f64| werte[((werte.len() - 1) as f64 * anteil) as usize] as f64 / 1000.0;
    eprintln!(
        "pulse-player: NACHLAUF der Paritaet (ms nach dem letzten geschuetzten \
         Paket): Median {:.1}, 90 % unter {:.1}, 99 % unter {:.1}, Maximum {:.1} \
         — aus {} Gruppen",
        bei(0.5),
        bei(0.9),
        bei(0.99),
        bei(1.0),
        werte.len()
    );
}
