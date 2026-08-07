//! Messpunkte fuer die Frage „wo bleiben die Bilder zwischen Decoder und
//! Schirm" — bewusst als globale Zaehler, weil die drei beteiligten Stellen
//! (Weiterleitungs-Task, Fenster-Faden, Zeichnen) sich nichts teilen koennen.
//!
//! Alles hier ist Diagnose und kostet je Bild ein paar Atomics. Ausgegeben
//! wird es nur mit `PULSE_PLAYER_STATS_LOG`.

use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

pub static ABGESCHICKT: AtomicU64 = AtomicU64::new(0);
pub static ANGEKOMMEN: AtomicU64 = AtomicU64::new(0);
/// Verzug zwischen `send_event` und der Behandlung auf dem Fenster-Faden.
pub static WECK_SUM_US: AtomicU64 = AtomicU64::new(0);
pub static WECK_MAX_US: AtomicU64 = AtomicU64::new(0);
pub static WECK_N: AtomicU64 = AtomicU64::new(0);
/// Groesste Pause zwischen zwei Durchlaeufen der Weiterleitung — die Zahl, die
/// entscheidet, ob der Kanal ueberlaeuft, WEIL der Task nicht drankommt.
pub static FW_LUECKE_MAX_US: AtomicU64 = AtomicU64::new(0);
/// Wie lange der Fenster-Faden je Sekunde ueberhaupt arbeitet (alle Rueckrufe
/// zusammen). 1_000_000 hiesse: dauerbelegt.
pub static HAUPT_BELEGT_US: AtomicU64 = AtomicU64::new(0);
/// Der Abschnitt in `draw`, der zwischen den beiden bekannten Uhren liegt.
pub static ZWISCHEN_SUM_US: AtomicU64 = AtomicU64::new(0);
pub static ZWISCHEN_MAX_US: AtomicU64 = AtomicU64::new(0);
/// Ganzer `draw`-Aufruf, inklusive der Abschnitte, die keine eigene Uhr haben.
pub static DRAW_SUM_US: AtomicU64 = AtomicU64::new(0);
pub static DRAW_MAX_US: AtomicU64 = AtomicU64::new(0);
pub static DRAW_N: AtomicU64 = AtomicU64::new(0);

/// Aufteilung des Zeichnens: Holen der Oberflaeche, Aufzeichnen, Ausgeben.
/// Getrennt, weil nur die erste Zahl WARTEN ist und die anderen ARBEIT.
pub static ACQ_SUM_US: AtomicU64 = AtomicU64::new(0);
pub static ACQ_MAX_US: AtomicU64 = AtomicU64::new(0);
pub static ENC_SUM_US: AtomicU64 = AtomicU64::new(0);
pub static PRES_SUM_US: AtomicU64 = AtomicU64::new(0);
pub static PRES_MAX_US: AtomicU64 = AtomicU64::new(0);
/// Groesster Fuellstand des Kanals Decoder → Fenster, je Fenster.
pub static KANAL_MAX: AtomicU64 = AtomicU64::new(0);
/// Groesste Pause zwischen zwei Bildern, die der Decoder in den Kanal stellt.
/// Zeigt Schubbildung auf der ERZEUGER-Seite.
pub static SENDE_LUECKE_MAX_US: AtomicU64 = AtomicU64::new(0);

/// Gemeinsame Uhr in Mikrosekunden seit dem ersten Zugriff — Atomics koennen
/// kein `Instant` halten, und die drei Stellen brauchen dieselbe Skala.
pub fn jetzt_us() -> u64 {
    static ANFANG: std::sync::LazyLock<std::time::Instant> =
        std::sync::LazyLock::new(std::time::Instant::now);
    ANFANG.elapsed().as_micros() as u64
}

/// Wann die Weiterleitung zuletzt lief (auf [`jetzt_us`]).
pub static FW_LAUF_US: AtomicU64 = AtomicU64::new(0);
/// Laufende Gesamtzahlen — NICHT je Sekunde zurueckgesetzt, damit der
/// Rueckstand in der winit-Schlange (`gesendet - empfangen`) jederzeit
/// ablesbar ist.
pub static GES_GESENDET: AtomicU64 = AtomicU64::new(0);
pub static GES_EMPFANGEN: AtomicU64 = AtomicU64::new(0);
/// **Die entscheidende Zahl.** Im Augenblick, in dem ein Bild wegen vollen
/// Kanals verworfen wird: wie lange lief die Weiterleitung da schon nicht?
pub static VERWORFEN_FW_ALTER_MAX_US: AtomicU64 = AtomicU64::new(0);
/// Und: wie viele Ereignisse steckten da in der winit-Schlange fest?
pub static VERWORFEN_SCHLANGE_MAX: AtomicU64 = AtomicU64::new(0);

/// Wie viele Bilder EIN Durchlauf der Sitzungsschleife in den Kanal stellt,
/// und wie lange dieser Durchlauf dauert. Die beiden Zahlen entscheiden, ob
/// der Kanal ueberlaeuft, weil der Verbraucher lahmt — oder weil der Erzeuger
/// zwischen zwei Yield-Punkten mehr hineinlegt, als hineinpasst.
pub static BILDER_LAUFEND: AtomicU64 = AtomicU64::new(0);
pub static BILDER_JE_DURCHLAUF_MAX: AtomicU64 = AtomicU64::new(0);
pub static DURCHLAUF_MAX_US: AtomicU64 = AtomicU64::new(0);
/// Groesste Pause zwischen zwei Durchlaeufen der Sitzungsschleife.
pub static DURCHLAUF_LUECKE_MAX_US: AtomicU64 = AtomicU64::new(0);

/// Dieselbe Frage an drei Stellen der Kette, im GLEICHEN Fenster gemessen:
/// Ankunft eines Videopakets → fertige Zugriffseinheit → Bild im Kanal.
/// Nur so ist zu sehen, welche Stufe die Schuebe macht. (Die vorhandene
/// `Ankunft max` in der Statistikzeile misst nur 250 ms und unterschaetzt
/// deshalb systematisch.)
pub static ANK_LUECKE_MAX_US: AtomicU64 = AtomicU64::new(0);
pub static EINHEIT_LUECKE_MAX_US: AtomicU64 = AtomicU64::new(0);

pub fn hoch(z: &AtomicU64, v: u64) {
    z.fetch_add(v, Relaxed);
}

pub fn hoechstens(z: &AtomicU64, v: u64) {
    z.fetch_max(v, Relaxed);
}

/// Alle Werte lesen und zuruecksetzen — genau einmal je Log-Zeile.
pub fn abholen() -> Zeile {
    let n = WECK_N.swap(0, Relaxed);
    let dn = DRAW_N.swap(0, Relaxed);
    Zeile {
        abgeschickt: ABGESCHICKT.swap(0, Relaxed),
        angekommen: ANGEKOMMEN.swap(0, Relaxed),
        weck_avg_us: if n > 0 { WECK_SUM_US.swap(0, Relaxed) / n } else { WECK_SUM_US.swap(0, Relaxed) },
        weck_max_us: WECK_MAX_US.swap(0, Relaxed),
        fw_luecke_max_us: FW_LUECKE_MAX_US.swap(0, Relaxed),
        haupt_belegt_us: HAUPT_BELEGT_US.swap(0, Relaxed),
        zwischen_avg_us: if dn > 0 { ZWISCHEN_SUM_US.swap(0, Relaxed) / dn } else { ZWISCHEN_SUM_US.swap(0, Relaxed) },
        zwischen_max_us: ZWISCHEN_MAX_US.swap(0, Relaxed),
        draw_avg_us: if dn > 0 { DRAW_SUM_US.swap(0, Relaxed) / dn } else { DRAW_SUM_US.swap(0, Relaxed) },
        draw_max_us: DRAW_MAX_US.swap(0, Relaxed),
        draw_n: dn,
        acq_avg_us: if dn > 0 { ACQ_SUM_US.swap(0, Relaxed) / dn } else { ACQ_SUM_US.swap(0, Relaxed) },
        acq_max_us: ACQ_MAX_US.swap(0, Relaxed),
        enc_avg_us: if dn > 0 { ENC_SUM_US.swap(0, Relaxed) / dn } else { ENC_SUM_US.swap(0, Relaxed) },
        pres_avg_us: if dn > 0 { PRES_SUM_US.swap(0, Relaxed) / dn } else { PRES_SUM_US.swap(0, Relaxed) },
        pres_max_us: PRES_MAX_US.swap(0, Relaxed),
        kanal_max: KANAL_MAX.swap(0, Relaxed),
        sende_luecke_max_us: SENDE_LUECKE_MAX_US.swap(0, Relaxed),
        verworfen_fw_alter_max_us: VERWORFEN_FW_ALTER_MAX_US.swap(0, Relaxed),
        verworfen_schlange_max: VERWORFEN_SCHLANGE_MAX.swap(0, Relaxed),
        bilder_je_durchlauf_max: BILDER_JE_DURCHLAUF_MAX.swap(0, Relaxed),
        durchlauf_max_us: DURCHLAUF_MAX_US.swap(0, Relaxed),
        durchlauf_luecke_max_us: DURCHLAUF_LUECKE_MAX_US.swap(0, Relaxed),
        ank_luecke_max_us: ANK_LUECKE_MAX_US.swap(0, Relaxed),
        einheit_luecke_max_us: EINHEIT_LUECKE_MAX_US.swap(0, Relaxed),
    }
}

pub struct Zeile {
    pub abgeschickt: u64,
    pub angekommen: u64,
    pub weck_avg_us: u64,
    pub weck_max_us: u64,
    pub fw_luecke_max_us: u64,
    pub haupt_belegt_us: u64,
    pub zwischen_avg_us: u64,
    pub zwischen_max_us: u64,
    pub draw_avg_us: u64,
    pub draw_max_us: u64,
    pub draw_n: u64,
    pub acq_avg_us: u64,
    pub acq_max_us: u64,
    pub enc_avg_us: u64,
    pub pres_avg_us: u64,
    pub pres_max_us: u64,
    pub kanal_max: u64,
    pub sende_luecke_max_us: u64,
    pub verworfen_fw_alter_max_us: u64,
    pub verworfen_schlange_max: u64,
    pub bilder_je_durchlauf_max: u64,
    pub durchlauf_max_us: u64,
    pub durchlauf_luecke_max_us: u64,
    pub ank_luecke_max_us: u64,
    pub einheit_luecke_max_us: u64,
}

/// Misst die Dauer eines Rueckrufs auf dem Fenster-Faden und schlaegt sie auf
/// [`HAUPT_BELEGT_US`] auf.
pub struct Belegt(std::time::Instant);

impl Belegt {
    pub fn neu() -> Self {
        Self(std::time::Instant::now())
    }
}

impl Drop for Belegt {
    fn drop(&mut self) {
        hoch(&HAUPT_BELEGT_US, self.0.elapsed().as_micros() as u64);
    }
}
