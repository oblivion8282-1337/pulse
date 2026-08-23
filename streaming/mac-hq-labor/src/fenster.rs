//! Das Vollbild-Fenster und der Ablauf eines Laufs.
//!
//! ## Zwangsabschaltung — Pflicht, keine Bequemlichkeit
//!
//! Wortgleich uebernommen aus dem Windows-Pruefziel: ein Vollbildfenster, das
//! Eingabe schluckt und haengenbleibt, sperrt den Rechner aus. Deshalb endet der
//! Lauf **immer** nach `--sekunden` von selbst; zusaetzlich beendet
//! Strg+Alt+Umschalt+Q von Hand (dasselbe Kuerzel wie dort).
//!
//! ## Warum Vollbild und nicht nur „gross"
//!
//! Zwei der acht Ziele liegen am oberen Rand, zwei am unteren. Dort sitzen auf
//! macOS die Menueleiste und das Dock, und beide liegen ueber einem
//! gewoehnlichen Fenster — ein Ereignis dorthin ginge an sie, nicht an das
//! Pruefziel. winits `Fullscreen::Borderless` zusammen mit
//! `with_borderless_game(true)` blendet beide aus (`NSApplicationPresentation
//! HideDock | HideMenuBar`). Ob das an dieser Maschine wirklich reicht, wird
//! nicht angenommen, sondern an jedem einzelnen Ziel geprueft — s.
//! [`crate::obenauf`].

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::keyboard::{KeyCode, ModifiersState, PhysicalKey};
use winit::platform::macos::WindowAttributesExtMacOS;
use winit::window::{Fullscreen, Window, WindowId};

use crate::ereignisse::{Geometrie, Sammler};
use crate::obenauf::{self, Lage};
use crate::{fensterliste, ziele};

/// Wie lange dem Wechsel in den Vollbild-Schreibtisch gegeben wird, bevor
/// Geometrie und Lage abgefragt werden. Zu frueh gefragt meldet macOS noch die
/// Masse des kleinen Fensters — und die Ziele laegen dann irgendwo.
const ANLAUF: Duration = Duration::from_millis(1200);

/// Die Hoehe des Hauptschirms in Punkten — der Bezug fuer Ereignisse ohne
/// Fensterbezug (s. `ereignisse::Geometrie::schirm_hoehe`).
fn hauptschirm_hoehe() -> f64 {
    objc2_core_graphics::CGDisplayBounds(objc2_core_graphics::CGMainDisplayID()).size.height
}

/// Nachlauf nach der Selbstprobe (s. [`Schritt::Nachlauf`]).
const NACHLAUF: Duration = Duration::from_millis(600);

/// Was der Lauf am Ende hergibt.
pub struct Ergebnis {
    /// Fehler am Messmittel selbst (kein Fenster, keine Geometrie, kein
    /// Abgriff). `Err` heisst **immer** ungueltig — hier ist nichts gemessen
    /// worden, was ein Urteil tragen koennte.
    pub aufbau: Result<(), String>,
    /// Ein fremdes Fenster ueber einem der Pruefpunkte, vor oder waehrend der
    /// Messung.
    ///
    /// **Es entwertet den Lauf nicht von sich aus** — anders als im
    /// Windows-Treiber, und die Abweichung ist gemessen: beim ersten Lauf am
    /// 2026-08-23 rief das Ziel in der rechten unteren Ecke macOS' Kurznotiz-
    /// Ecke auf den Schirm (`LinkedNotesUIService`, Schicht 25), und trotzdem
    /// kamen alle acht Ziele mit 0 Punkten Abweichung an. Ein Abbruch haette
    /// eine vollstaendige Messung weggeworfen.
    ///
    /// Die Verdeckung ist deshalb der **Schiedsrichter fuer Fehlschlaege**: was
    /// sauber durchkam, gilt; was nicht durchkam, gilt als ungueltig statt als
    /// durchgefallen, solange etwas darueberlag. Genau das war der Sinn der
    /// Pruefung — nicht, jeden Lauf abzuwuergen, sondern zu verhindern, dass
    /// ein geschluckter Lauf dem Injektor angelastet wird.
    pub verdeckung: Option<String>,
    pub ziele: Vec<(f64, f64)>,
    pub geometrie: Option<Geometrie>,
    pub skalierung: f64,
    pub grund: &'static str,
}

pub struct Einstellungen {
    pub sekunden: u64,
    pub eigenfahrt: bool,
}

#[derive(PartialEq)]
enum Schritt {
    Anlauf,
    Messen,
    /// Nachlauf nach der Selbstprobe: die zuletzt abgefeuerten Ereignisse sind
    /// noch unterwegs, wenn der Faden schon fertig meldet. Ohne diese Frist
    /// fehlten regelmaessig die letzten Tastenereignisse — und das saehe wie
    /// eine verschluckte Taste aus.
    Nachlauf(Instant),
    Vorbei,
}

pub struct App {
    sammler: Rc<RefCell<Sammler>>,
    einstellungen: Einstellungen,
    fenster: Option<Window>,
    abgriff: Option<Retained<AnyObject>>,
    beschriftung: Option<crate::zeichnen::Beschriftung>,
    schritt: Schritt,
    start: Instant,
    umschalt: ModifiersState,
    fertig: Arc<AtomicBool>,
    pub ergebnis: Ergebnis,
}

impl App {
    pub fn neu(sammler: Rc<RefCell<Sammler>>, einstellungen: Einstellungen) -> Self {
        Self {
            sammler,
            einstellungen,
            fenster: None,
            abgriff: None,
            beschriftung: None,
            schritt: Schritt::Anlauf,
            start: Instant::now(),
            umschalt: ModifiersState::empty(),
            fertig: Arc::new(AtomicBool::new(false)),
            ergebnis: Ergebnis {
                aufbau: Err("Lauf nie begonnen".into()),
                verdeckung: None,
                ziele: Vec::new(),
                geometrie: None,
                skalierung: 1.0,
                grund: "unbekannt",
            },
        }
    }

    fn beenden(&mut self, el: &ActiveEventLoop, grund: &'static str) {
        if self.schritt == Schritt::Vorbei {
            return;
        }
        self.schritt = Schritt::Vorbei;
        self.ergebnis.grund = grund;
        // **Die Nachpruefung.** Ein Stoerer, der sich erst waehrend der Messung
        // darueberlegt, taucht in der Pruefung von vorher nicht auf. Das
        // Windows-Skript prueft aus demselben Grund zweimal.
        if self.ergebnis.verdeckung.is_none()
            && let Some(fehler) = self.stoerung()
        {
            self.ergebnis.verdeckung = Some(format!("waehrend der Messung {fehler}"));
        }
        self.sammler.borrow_mut().protokoll.zeile("ende", serde_json::json!({ "grund": grund }));
        el.exit();
    }

    /// Prueft alle Ziele und die Fenstermitte. `None` = alles in Ordnung.
    fn stoerung(&self) -> Option<String> {
        let g = self.ergebnis.geometrie?;
        let mut punkte = self.ergebnis.ziele.clone();
        if let Some(f) = &self.fenster {
            let breite = f64::from(f.outer_size().width) / self.ergebnis.skalierung;
            punkte.push((g.ursprung.0 + breite / 2.0, g.ursprung.1 + g.hoehe / 2.0));
        }
        let liste = fensterliste::sichtbare_fenster();
        let ich = std::process::id() as i32;
        obenauf::ersten_fehler_finden(&liste, ich, &punkte).map(|(punkt, lage)| match lage {
            Lage::Verdeckt(z) => format!(
                "liegt bei ({}, {}) ein fremdes Fenster darueber: Eigner {}, Prozess {}, \
                 Schicht {}, Rechteck {}x{} ab {},{}, Deckkraft {}",
                punkt.0,
                punkt.1,
                z.eigner.clone().unwrap_or_else(|| "unbekannt".into()),
                z.pid,
                z.schicht,
                z.rechteck.breite,
                z.rechteck.hoehe,
                z.rechteck.x,
                z.rechteck.y,
                fensterliste::deckkraft(&z).map_or("?".into(), |a| format!("{a}")),
            ),
            Lage::KeinFenster => format!(
                "liegt bei ({}, {}) ueberhaupt kein sichtbares Fenster \
                 (eigener Schreibtisch gewechselt?)",
                punkt.0, punkt.1
            ),
            Lage::Obenauf => unreachable!("obenauf ist kein Fehler"),
        })
    }

    fn messen_beginnen(&mut self, el: &ActiveEventLoop) {
        let Some(f) = &self.fenster else {
            return self.beenden(el, "kein_fenster");
        };
        let skal = f.scale_factor();
        let Ok(pos) = f.outer_position() else {
            return self.beenden(el, "keine_fensterlage");
        };
        let groesse = f.outer_size();
        let ursprung = (f64::from(pos.x) / skal, f64::from(pos.y) / skal);
        let breite = f64::from(groesse.width) / skal;
        let hoehe = f64::from(groesse.height) / skal;

        self.ergebnis.skalierung = skal;
        self.ergebnis.geometrie =
            Some(Geometrie { ursprung, hoehe, schirm_hoehe: hauptschirm_hoehe() });
        self.ergebnis.ziele = ziele::ziele_fuer(ursprung, breite, hoehe);
        self.sammler.borrow_mut().geometrie = self.ergebnis.geometrie;

        let liste = fensterliste::sichtbare_fenster();
        let ich = std::process::id() as i32;
        self.sammler.borrow_mut().protokoll.zeile(
            "bereit",
            serde_json::json!({
                "pid": ich,
                "fenster": { "x": ursprung.0, "y": ursprung.1, "breite": breite, "hoehe": hoehe },
                "skalierung": skal,
                "ziele": self.ergebnis.ziele.iter().map(|z| [z.0, z.1]).collect::<Vec<_>>(),
                "sichtbare_fenster": liste.len(),
                "eigenfahrt": self.einstellungen.eigenfahrt,
            }),
        );

        self.ergebnis.aufbau = Ok(());
        if let Some(fehler) = self.stoerung() {
            let grund = format!("vor der Messung {fehler}");
            self.sammler
                .borrow_mut()
                .protokoll
                .zeile("verdeckt", serde_json::json!({ "grund": grund }));
            self.ergebnis.verdeckung = Some(grund);
        }

        self.beschriftung = crate::zeichnen::aufsetzen(f, &self.ergebnis.ziele, ursprung, hoehe);
        self.schritt = Schritt::Messen;

        if self.einstellungen.eigenfahrt {
            let mitte = (ursprung.0 + (breite / 2.0).floor(), ursprung.1 + (hoehe / 2.0).floor());
            crate::eigenfahrt::starten(
                self.ergebnis.ziele.clone(),
                mitte,
                Arc::clone(&self.fertig),
            );
        }
    }

}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.fenster.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("Pulse Eingabe-Pruefziel")
            .with_decorations(false)
            .with_fullscreen(Some(Fullscreen::Borderless(None)))
            .with_borderless_game(true);
        match el.create_window(attrs) {
            Ok(f) => {
                self.abgriff = crate::ereignisse::abgriff_anmelden(Rc::clone(&self.sammler));
                if self.abgriff.is_none() {
                    // Ohne Abgriff misst der Lauf nichts — und das darf nicht
                    // wie „keine Eingabe angekommen" aussehen.
                    self.ergebnis.aufbau = Err("NSEvent-Abgriff nicht angemeldet".into());
                    self.beenden(el, "kein_abgriff");
                    return;
                }
                self.fenster = Some(f);
                self.start = Instant::now();
            }
            Err(e) => {
                self.ergebnis.aufbau = Err(format!("Fenster nicht aufgezogen: {e}"));
                self.beenden(el, "kein_fenster");
            }
        }
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, ereignis: WindowEvent) {
        match ereignis {
            WindowEvent::CloseRequested => self.beenden(el, "geschlossen"),
            WindowEvent::ModifiersChanged(m) => self.umschalt = m.state(),
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed
                    && event.physical_key == PhysicalKey::Code(KeyCode::KeyQ)
                    && self.umschalt.control_key()
                    && self.umschalt.alt_key()
                    && self.umschalt.shift_key() =>
            {
                self.beenden(el, "kuerzel")
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, el: &ActiveEventLoop) {
        el.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(50)));
        match self.schritt {
            Schritt::Anlauf if self.start.elapsed() >= ANLAUF => self.messen_beginnen(el),
            Schritt::Messen if self.fertig.load(Ordering::SeqCst) => {
                self.schritt = Schritt::Nachlauf(Instant::now() + NACHLAUF);
            }
            Schritt::Nachlauf(bis) if Instant::now() >= bis => self.beenden(el, "selbstprobe"),
            _ => {}
        }
        if self.schritt != Schritt::Vorbei
            && self.start.elapsed() >= Duration::from_secs(self.einstellungen.sekunden)
        {
            self.beenden(el, "zeit");
        }
    }
}
