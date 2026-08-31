//! Der Eigner-Faden: eine eigene Run-Loop, die das Fach beobachtet und
//! **verzoegert rendert**.
//!
//! ## Warum ein eigener Faden sein MUSS
//!
//! `pasteboard:provideDataForType:` ist **synchron**: es wird gerufen, waehrend
//! das einfuegende Programm wartet, und wir warten in dieser Zeit auf einen
//! Netz-Umlauf (rund 0,4 s, im schlechtesten Fall die volle Abruf-Frist von
//! 2 s). Der Rueckruf darf deshalb auf keinem Faden liegen, der etwas anderes
//! traegt — im Player waere das die winit-Schleife (Bild **und**
//! Eingabeerfassung), im Sidecar der Dispatch-Faden mit `remote_input`.
//!
//! ## Und warum der Takt NICHT hier liegt
//!
//! Er muss weiterlaufen, **waehrend** dieser Faden in [`rendern`] blockiert:
//! die Abruf-Frist ist es, die dem wartenden Programm die leere Antwort
//! zustellt (`crate::lage::takt`, Schritt 2). Ein Faden, der auf sich selbst
//! wartet, haengt. Der Takt gehoert deshalb dem Verbraucher (im Sidecar ein
//! eigener Faden, im Player die Schleife).
//!
//! ## Der Zaehler ersetzt die Meldung, die es nicht gibt
//!
//! macOS meldet keine Aenderung — `NSPasteboard.changeCount` wird abgefragt.
//! Das ist kein Notbehelf, sondern der einzige Weg; alle pollen. Zwei
//! Zahlen genuegen dafuer, und sie erklaeren zugleich, warum
//! `Ablagestand::erwartet` hier nicht gebraucht wird (s. dort):
//!
//! * `gesehen` — der zuletzt verbuchte Stand. Ist er gleich, ist nichts
//!   geschehen.
//! * `eigen` — der Stand, den WIR zuletzt gesetzt haben. Stimmt der aktuelle
//!   damit ueberein, halten wir das Fach.
//!
//! Jeder eigene Vorgang schreibt beide, und damit sieht der Poll die eigene
//! Aenderung gar nicht erst.
//!
//! **Ungeprueft auf der Entwicklungsmaschine**, wie alles macOS-Eigene hier:
//! belegt ist, dass es uebersetzt (`cargo check --target aarch64-apple-darwin`).
//! Die Rechnung darueber steht in [`crate::lage`] und [`crate::stand`] und ist
//! dort gefahren.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::time::{Duration, Instant};

use objc2_app_kit::{NSPasteboard, NSPasteboardType};
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop, NSThread};

use super::auftragsbuch;
use super::eigner::Eigner;
use super::{fach, stand};

/// Wie oft der Faden nachsieht, ob ein Auftrag ansteht.
///
/// Kurz, weil ein Auftraggeber hier wartet (s. [`auftrag`]); teuer ist der
/// Durchlauf nicht — er fragt drei Merker ab und schlaeft weiter.
const TAKT_MS: u64 = 20;

/// Wie oft der Aenderungszaehler abgefragt wird. **Der Wert steht so im
/// Entwurf.**
///
/// Er entscheidet, wie schnell eine fremde Kopie angekuendigt wird, und sonst
/// nichts: der Abruf haengt nicht daran, er beginnt beim Einfuegen.
const POLL_MS: u64 = 200;

/// Wie lange ein Auftraggeber auf den Eigner-Faden wartet.
///
/// **Gefolgert, nicht gemessen**, wie das Gegenstueck auf Windows: im Regelfall
/// ist der Faden untaetig und antwortet binnen eines Taktes; die Frist deckt
/// den einen Fall ab, in dem er gerade in [`rendern`] steht — und der wird
/// durch `Ablagestand::abbrechen` sofort aufgeloest, sobald ein Auftrag
/// ansteht.
pub(super) const AUFTRAG_FRIST: Duration = Duration::from_millis(500);

/// Wie lange ein Rueckruf hoechstens wartet.
///
/// **Ueber `crate::sitzung::ABRUF_FRIST_MS` (2 s)**, damit im Regelfall die
/// Frist der Zustandsmaschine zuerst greift und eine geordnete leere Antwort
/// zustellt. Diese hier ist nur das Netz darunter — fuer den Fall, dass der
/// Takt des Verbrauchers gar nicht mehr laeuft. Ohne sie stuende das
/// einfuegende Programm unbegrenzt.
const RENDER_FRIST: Duration = Duration::from_millis(2_500);

/// Wartetakt der Schleife in [`rendern`].
const RENDER_TAKT: Duration = Duration::from_millis(2);

/// Steht der Faden? Grundlage von `Ablagequelle::wirksam` — die Oberflaeche
/// soll nichts versprechen, was nicht stattfindet.
static STEHT: AtomicBool = AtomicBool::new(false);

/// Laufnummer des Fadens. Er prueft sie bei jedem Durchlauf und geht, sobald
/// sie fremd ist — dasselbe Muster wie die Wache im mac-Sidecar
/// (`remote_input::wache::faden`): ein fremder Faden koennte die Run-Loop
/// dieses Fadens nicht anfassen, CoreFoundation-Handles sind nicht `Sync`.
static FADEN_NR: AtomicU64 = AtomicU64::new(0);

/// Die beiden Zaehlerstaende (s. Modulkopf).
struct Zaehler {
    gesehen: isize,
    /// Der Stand, den wir selbst gesetzt haben. `isize::MIN` heisst „noch
    /// nie" — ein Wert, den `changeCount` nicht annimmt.
    eigen: isize,
}

static ZAEHLER: Mutex<Zaehler> = Mutex::new(Zaehler { gesehen: 0, eigen: isize::MIN });

fn zaehler() -> std::sync::MutexGuard<'static, Zaehler> {
    ZAEHLER.lock().unwrap_or_else(|e| e.into_inner())
}

pub(super) fn steht() -> bool {
    STEHT.load(Ordering::Relaxed)
}

/// Den Faden aufstellen. Idempotent.
pub(super) fn starten() -> Result<(), String> {
    if steht() {
        return Ok(());
    }
    // **Im Testbau kein Zugriff auf die Zwischenablage des Entwicklers.**
    // Dieselbe Zurueckhaltung wie in `remote_input::wache::starten` des
    // mac-Sidecars; `steht()` bleibt damit `false`, und die Zustandsmaschine
    // laeuft gegen eine Plattform, die nichts beruehrt.
    if cfg!(test) {
        return Ok(());
    }
    let nr = FADEN_NR.fetch_add(1, Ordering::SeqCst) + 1;
    let (melden, warten) = channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("pulse-ablage-eigner".into())
        .spawn(move || faden(nr, melden))
        .map_err(|e| format!("Ablage-Faden nicht startbar: {e}"))?;
    match warten.recv() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(grund)) => Err(grund),
        Err(_) => Err("Ablage-Faden endete vor seiner Meldung".to_string()),
    }
}

/// Den Faden abbauen. **Ohne auf ihn zu warten** — dieser Weg laeuft auch beim
/// Prozessende, und dort wartet niemand mehr.
///
/// Was vorher passieren muss, passiert vorher: der Verbraucher gibt erst das
/// Eigentum ab (und schreibt den Vorbestand zurueck) und ruft dann hier.
pub(super) fn stoppen() {
    FADEN_NR.fetch_add(1, Ordering::SeqCst);
    STEHT.store(false, Ordering::Relaxed);
}

/// Der Faden: Eigner-Objekt bauen, Erfolg melden, Run-Loop bedienen, Auftraege
/// ausfuehren, Zaehler abfragen.
fn faden(nr: u64, melden: Sender<Result<(), String>>) {
    let pb = fach::fach();
    let eigner = Eigner::neu();
    // Den Ausgangsstand verbuchen: was VOR uns im Fach lag, ist keine
    // Aenderung, die jemanden angeht.
    {
        let mut z = zaehler();
        z.gesehen = fach::zaehlerstand(&pb);
        z.eigen = isize::MIN;
    }
    STEHT.store(true, Ordering::Relaxed);
    if melden.send(Ok(())).is_err() {
        STEHT.store(false, Ordering::Relaxed);
        return;
    }
    let mut seit_poll = Instant::now();
    while FADEN_NR.load(Ordering::SeqCst) == nr {
        run_loop_takt();
        auftragsbuch::auftraege_abarbeiten(&pb, &eigner);
        if seit_poll.elapsed() >= Duration::from_millis(POLL_MS) {
            seit_poll = Instant::now();
            pollen(&pb);
        }
    }
    STEHT.store(false, Ordering::Relaxed);
}

/// Einen Takt lang die Run-Loop bedienen.
///
/// **Der Rueckgabewert ist kein Beiwerk:** `runMode:beforeDate:` kehrt
/// **sofort** zurueck, wenn der Modus keine Quelle hat — ein Faden ohne
/// Eingabequelle drehte sich sonst leer und verbraeuchte einen Kern. Ob AppKit
/// mit dem Eigentum eine Quelle einhaengt, ist von hier aus nicht zu sehen;
/// der Schlaf deckt beide Faelle ab.
fn run_loop_takt() {
    let takt = TAKT_MS as f64 / 1000.0;
    let frist = NSDate::dateWithTimeIntervalSinceNow(takt);
    // SAFETY: eine Konstante, die Foundation beim Laden anlegt und nie aendert.
    let modus = unsafe { NSDefaultRunLoopMode };
    let lief = NSRunLoop::currentRunLoop().runMode_beforeDate(modus, &frist);
    if !lief {
        std::thread::sleep(Duration::from_millis(TAKT_MS));
    }
}

/// Einen selbst ausgeloesten Stand verbuchen — **beide Zaehler**, damit der
/// naechste Poll die eigene Aenderung gar nicht erst sieht.
pub(super) fn eigenen_stand_verbuchen(neu: isize, eigen: bool) {
    {
        let mut z = zaehler();
        z.gesehen = neu;
        // Nach dem Raeumen gehoert das Fach niemandem: ein Stand, der nie
        // wieder gleich ist, statt eines Merkers, der luege.
        z.eigen = if eigen { neu } else { isize::MIN };
    }
    // **Die Sperre um den Zaehler ist hier schon gefallen.** Dieselbe Regel wie
    // ueberall in diesem Weg: nie zwei Sperren uebereinander halten.
    stand().selbst_geaendert_quittiert(eigen);
}

/// Den Aenderungszaehler abfragen — der Ersatz fuer die Meldung, die es auf
/// macOS nicht gibt.
fn pollen(pb: &NSPasteboard) {
    let jetzt = fach::zaehlerstand(pb);
    let eigner = {
        let mut z = zaehler();
        if jetzt == z.gesehen {
            return;
        }
        z.gesehen = jetzt;
        jetzt == z.eigen
    };
    // **Erst fragen, dann sperren**: `text_da` ist ein Aufruf ans
    // Betriebssystem, und ueber einen solchen wird keine Sperre gehalten.
    let text_da = fach::text_da(pb);
    stand().systemmeldung(eigner, text_da);
}

/// Der blockierende Rueckruf: **hier wartet ein fremdes Programm.**
///
/// Geliefert wird, was `Eigentum::liefern` hinterlegt (der Weg ueber die
/// Leitung), ein Abbruch, oder nach [`RENDER_FRIST`] eine leere Zeichenkette.
/// Ein Einfuegen, das nichts einfuegt, versteht jeder; ein haengendes Programm
/// nicht.
pub(super) fn rendern(pb: &NSPasteboard, typ: &NSPasteboardType) {
    faden_melden();
    stand().warten_beginnen();
    let ende = Instant::now() + RENDER_FRIST;
    let text = loop {
        if let Some(t) = stand().antwort_nehmen() {
            break t;
        }
        if Instant::now() >= ende {
            break String::new();
        }
        // Schlafend gewartet, nicht drehend: der Faden hat sonst nichts zu tun.
        std::thread::sleep(RENDER_TAKT);
    };
    fach::antworten(pb, typ, &text);
    stand().warten_beenden();
    // **Den Zaehler nachziehen, falls die Antwort ihn bewegt hat.**
    //
    // Ob `setString:forType:` beim Einloesen eines Versprechens den
    // `changeCount` hochzieht, ist **gefolgert und nicht gemessen** — die
    // Dokumentation nennt das Anmelden von Typen und das Schreiben von
    // Inhalten, ohne den Einloese-Fall zu trennen. Taete es das und bliebe es
    // hier unverbucht, haelte der naechste Poll unsere eigene Antwort fuer eine
    // fremde Aenderung: eine Ankuendigung, die niemand ausgeloest hat, und
    // danach eine Buchfuehrung, die uns nicht mehr als Eigentuemer sieht.
    // Zwei billige Abfragen schliessen den Fall; der Preis ist eine fremde
    // Aenderung in genau diesem Augenblick, die wir uns selbst zuschrieben.
    let nach = fach::zaehlerstand(pb);
    let mut z = zaehler();
    if nach != z.gesehen && z.eigen != isize::MIN {
        z.gesehen = nach;
        z.eigen = nach;
    }
}

/// Einmal je Prozess melden, auf welchem Faden der Rueckruf ankommt.
///
/// **Das ist die eine offene Frage dieses Weges**, und sie ist von Linux aus
/// nicht zu beantworten: der Entwurf verlangt eine eigene Run-Loop, aber ob
/// AppKit den Rueckruf wirklich dorthin zustellt oder an den Hauptfaden,
/// entscheidet AppKit. Kommt er am Hauptfaden an, steht im Player fuer die
/// Dauer eines Einfuegens das Bild — genau das, was der eigene Faden
/// verhindern soll. Die Zeile beantwortet das beim ersten Handlauf auf einem
/// Mac, statt es zu einer Vermutung im Bericht zu machen.
fn faden_melden() {
    static EINMAL: std::sync::Once = std::sync::Once::new();
    EINMAL.call_once(|| {
        let haupt = NSThread::isMainThread_class();
        eprintln!(
            "[ablage] erster Rueckruf des Fachs auf {} — erwartet wird der Eigner-Faden.",
            if haupt { "dem HAUPTFADEN" } else { "einem Nebenfaden" }
        );
    });
}
