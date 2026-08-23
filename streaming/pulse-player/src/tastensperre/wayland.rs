//! Der Wayland-Teil der Tastenkuerzel-Sperre. Begruendungen im Modulkopf
//! nebenan ([`super`]) — hier steht nur die Mechanik.
//!
//! **Dieselbe Verbindung wie winit, keine zweite.** Objekte zweier Verbindungen
//! lassen sich nicht mischen: ein `wl_surface` aus winits Verbindung darf nicht
//! als Argument einer Anfrage auf einer eigenen Verbindung auftauchen. Deshalb
//! wird ueber `RawDisplayHandle::Wayland` an winits `wl_display` gegriffen, ein
//! **Gast-Backend** darum gelegt (`Backend::from_foreign_display` — es schliesst
//! die Verbindung beim Abbau NICHT) und die Flaeche aus dem rohen `wl_proxy`
//! rekonstruiert (`ObjectId::from_ptr` + `Proxy::from_id`).
//!
//! **Eine eigene Ereigniswarteschlange, aber kein eigener Faden.** Das
//! Gast-Backend legt sich beim Aufbau eine eigene `wl_event_queue` an; die
//! Ereignisse fuer unsere Objekte landen dort und nicht bei winit. Gelesen wird
//! der Socket weiterhin von winit — libwayland verteilt beim Lesen auf alle
//! Warteschlangen. Wir leeren unsere nur bei Gelegenheit
//! ([`Verbindung::nachfassen`]), sonst wuechse sie langsam an: die Registry
//! meldet weiter jedes kommende und gehende Global.
//!
//! **Wo die Fassungen herkommen.** `wayland-client 0.31`, `wayland-backend 0.3`
//! (mit `client_system`) und `wayland-protocols 0.32` sind genau die, die winit
//! zieht — siehe die Begruendung an den Abhaengigkeiten in `Cargo.toml`. Waeren
//! es andere, waeren `wl_surface` hier und `wl_surface` dort fuer den Compiler
//! verschiedene Typen, obwohl sie dasselbe Objekt bezeichnen.

use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use wayland_backend::sys::client::{Backend, ObjectId};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_registry, wl_seat, wl_surface};
use wayland_client::{delegate_noop, Connection, Dispatch, EventQueue, Proxy, QueueHandle};
use wayland_protocols::wp::keyboard_shortcuts_inhibit::zv1::client::{
    zwp_keyboard_shortcuts_inhibit_manager_v1::ZwpKeyboardShortcutsInhibitManagerV1,
    zwp_keyboard_shortcuts_inhibitor_v1::ZwpKeyboardShortcutsInhibitorV1,
};
use winit::window::Window;

/// Der Zustand unserer Warteschlange. Traegt nichts: wir werten kein einziges
/// Ereignis aus, wir muessen fuer `EventQueue<_>` nur einen Typ nennen.
///
/// Auch die beiden Ereignisse des Inhibitors (`active`/`inactive`) bleiben
/// bewusst unbeachtet. Sie sagen, ob der Compositor die Sperre gerade
/// tatsaechlich anwendet — der Nutzer kann sie ueber compositor-eigene Wege
/// abschalten. Daraus liesse sich eine Anzeige bauen; heute gaebe es aber
/// nichts, was der Player mit der Antwort anfinge, und ein Zustand, der
/// nirgends hinfuehrt, laeuft nur auseinander.
struct Zustand;

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Zustand {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Die Liste der Globals fuehrt `registry_queue_init` selbst; hierher
        // kommt nur die Durchschrift.
    }
}

delegate_noop!(Zustand: ignore wl_seat::WlSeat);
delegate_noop!(Zustand: ignore ZwpKeyboardShortcutsInhibitorV1);
// Der Manager hat gar keine Ereignisse — die Form ohne `ignore` laesst es
// knallen, falls je eines kaeme.
delegate_noop!(Zustand: ZwpKeyboardShortcutsInhibitManagerV1);

/// Was ein Fenster an Sperre haelt: je Sitzplatz ein Inhibitor.
#[derive(Default)]
pub(super) struct Halter {
    inhibitoren: Vec<ZwpKeyboardShortcutsInhibitorV1>,
}

impl Drop for Halter {
    /// Das Netz unter dem geordneten Abbau: Fenster zugeklappt, Sitzung
    /// abgerissen, Panik im Faden — die Kuerzel des Nutzers muessen zurueck.
    /// Dieselbe Zusage wie „alles loslassen" bei den gehaltenen Tasten.
    ///
    /// Ist die Verbindung zu dem Zeitpunkt schon abgebaut (s.
    /// [`Gemeinsam::schliessen`]), ist das `destroy` von sich aus ein
    /// Nichtstun: die Objekte halten nur eine schwache Referenz auf das
    /// Backend, und ohne dieses kehrt jede Anfrage sofort zurueck.
    fn drop(&mut self) {
        for inhibitor in self.inhibitoren.drain(..) {
            inhibitor.destroy();
        }
    }
}

/// Die geteilte Verbindung samt Manager und Sitzplaetzen.
struct Verbindung {
    conn: Connection,
    queue: EventQueue<Zustand>,
    qh: QueueHandle<Zustand>,
    manager: ZwpKeyboardShortcutsInhibitManagerV1,
    /// **Alle** Sitzplaetze, nicht nur der erste.
    ///
    /// Ein Inhibitor gilt je (Flaeche, Sitzplatz). Welchen Sitzplatz winit
    /// benutzt, gibt winit nicht heraus — mit nur einem geratenen Platz waere
    /// die Sperre an einem Mehrplatz-Rechner mit einiger Wahrscheinlichkeit die
    /// falsche. Ein Inhibitor je Platz trifft immer den richtigen mit, und die
    /// ueberzaehligen kosten nichts: sie greifen nur, wenn ihr Platz die
    /// Tastatur auf unsere Flaeche richtet.
    seats: Vec<wl_seat::WlSeat>,
}

impl Verbindung {
    /// Unsere Warteschlange leeren.
    ///
    /// Muss sein, weil die Registry weiter jedes kommende und gehende Global in
    /// sie hineinlegt. Blockiert nicht: gelesen wird der Socket von winit,
    /// hier wird nur abgeholt, was schon dort liegt.
    fn nachfassen(&mut self) {
        let mut zustand = Zustand;
        let _ = self.queue.dispatch_pending(&mut zustand);
    }
}

/// Alles, was sich die Fenster teilen.
#[derive(Default)]
pub(super) struct Gemeinsam {
    verbindung: Option<Verbindung>,
    /// Wurde der Aufbau schon einmal versucht? Ein Fehlschlag wird **nicht**
    /// wiederholt: die Ursachen (X11 statt Wayland, Compositor ohne die
    /// Erweiterung, kein Sitzplatz) aendern sich waehrend eines Prozesslebens
    /// nicht, und der Aufbau kostet einen Umlauf zum Compositor.
    versucht: bool,
}

impl Drop for Gemeinsam {
    /// **Der Abbau gehoert in [`Self::schliessen`], nicht hierher.**
    ///
    /// Wir haengen als Gast an winits `wl_display`. winit gibt die Anzeige frei,
    /// sobald seine Ereignisschleife abgebaut wird — und das geschieht, bevor
    /// die letzten Werte des Programms fallen. Liefe der gewoehnliche Abbau
    /// unserer Verbindung erst danach, griffe er auf eine Anzeige zu, die es
    /// nicht mehr gibt. `schliessen()` am Ende der Schleife ist der richtige
    /// Zeitpunkt; kommt es dort nicht dazu (Panik), wird hier lieber
    /// liegengelassen als angefasst. Das kostet am Prozessende eine
    /// Warteschlange und eine Handvoll Objekte — der Prozess endet ohnehin.
    fn drop(&mut self) {
        std::mem::forget(self.verbindung.take());
    }
}

impl Gemeinsam {
    /// Sperre fuer dieses Fenster anfordern. Gibt zurueck, ob sie WIRKLICH
    /// steht — nicht, ob sie gewuenscht war.
    pub(super) fn anfordern(&mut self, halter: &mut Halter, window: &Window) -> bool {
        if !self.versucht {
            self.versucht = true;
            match aufbauen(window) {
                Ok(verbindung) => self.verbindung = Some(verbindung),
                Err(grund) => {
                    // Genau einmal je Prozess, und ohne Drama: die Sitzung
                    // laeuft weiter (s. Modulkopf nebenan).
                    eprintln!(
                        "pulse-player: Tastenkuerzel des Fenstermanagers bleiben aktiv \
                         ({grund}) — die Fernsteuerung laeuft ohne die Sperre."
                    );
                }
            }
        }
        let Some(verbindung) = self.verbindung.as_mut() else { return false };
        let Some(surface) = flaeche(&verbindung.conn, window) else {
            eprintln!("pulse-player: Tastensperre — Fenster hat keine Wayland-Flaeche.");
            return false;
        };
        for seat in &verbindung.seats {
            halter.inhibitoren.push(verbindung.manager.inhibit_shortcuts(
                &surface,
                seat,
                &verbindung.qh,
                (),
            ));
        }
        // Selbst hinausschieben statt auf winits naechsten Durchgang zu warten:
        // die Sperre soll mit dem ersten Tastendruck gelten, nicht mit dem
        // ersten Bild danach.
        let _ = verbindung.conn.flush();
        verbindung.nachfassen();
        !halter.inhibitoren.is_empty()
    }

    /// Die Sperre dieses Fensters aufheben.
    pub(super) fn abraeumen(&mut self, halter: &mut Halter) {
        if halter.inhibitoren.is_empty() {
            return;
        }
        for inhibitor in halter.inhibitoren.drain(..) {
            inhibitor.destroy();
        }
        if let Some(verbindung) = self.verbindung.as_mut() {
            // Sofort hinaus: der Nutzer soll seine Kuerzel jetzt zurueck haben.
            let _ = verbindung.conn.flush();
            verbindung.nachfassen();
        }
    }

    /// Die Verbindung abbauen, solange winits Anzeige noch lebt (s. [`Drop`]).
    pub(super) fn schliessen(&mut self) {
        self.verbindung = None;
    }
}

/// Gast-Backend auf winits Anzeige legen, Manager und Sitzplaetze binden.
///
/// Der Fehlerfall traegt einen Grund, weil er genau einmal im Log landet und
/// die drei moeglichen Ursachen voellig verschiedene Antworten verlangen.
fn aufbauen(window: &Window) -> Result<Verbindung, String> {
    let anzeige = window.display_handle().map_err(|e| format!("kein Anzeige-Handle: {e}"))?;
    let RawDisplayHandle::Wayland(anzeige) = anzeige.as_raw() else {
        return Err("kein Wayland (X11 kennt das Protokoll nicht)".into());
    };

    // SICHERHEIT: Der Zeiger kommt aus winits Anzeige-Handle und ist damit ein
    // gueltiger `wl_display`. Er muss das Backend ueberleben — dafuer sorgt
    // `Gemeinsam::schliessen`/`Drop` (s. dort). `from_foreign_display` legt das
    // Backend im Gast-Modus an: es schliesst die Verbindung beim Abbau NICHT.
    let backend = unsafe { Backend::from_foreign_display(anzeige.display.as_ptr().cast()) };
    let conn = Connection::from_backend(backend);

    let (globals, queue) = registry_queue_init::<Zustand>(&conn)
        .map_err(|e| format!("Registry nicht lesbar: {e}"))?;
    let qh = queue.handle();

    let manager: ZwpKeyboardShortcutsInhibitManagerV1 = globals
        .bind(&qh, 1..=1, ())
        .map_err(|e| format!("zwp_keyboard_shortcuts_inhibit_manager_v1: {e}"))?;

    // `GlobalList::bind` ist fuer Globals mit genau einer Ausfertigung gedacht;
    // `wl_seat` kann mehrfach vorkommen. Deshalb hier ueber die Liste, damit
    // wirklich JEDER Platz einen Inhibitor bekommt (Begruendung an `seats`).
    let plaetze: Vec<u32> = globals.contents().with_list(|liste| {
        liste
            .iter()
            .filter(|global| global.interface == wl_seat::WlSeat::interface().name)
            .map(|global| global.name)
            .collect()
    });
    // Fassung 1 genuegt: gebraucht wird der Sitzplatz nur als Argument, keine
    // seiner Anfragen und keines seiner Ereignisse.
    let seats: Vec<wl_seat::WlSeat> =
        plaetze.into_iter().map(|name| globals.registry().bind(name, 1, &qh, ())).collect();
    if seats.is_empty() {
        return Err("kein wl_seat angekuendigt".into());
    }

    let _ = conn.flush();
    Ok(Verbindung { conn, queue, qh, manager, seats })
}

/// Winits `wl_surface` als Objekt unserer Verbindung.
///
/// Wird bei jeder Anforderung frisch geholt und nirgends gemerkt: winit legt
/// die Flaeche beim Wiederaufbau eines Fensters neu an, und ein gemerktes
/// Objekt zeigte danach ins Leere.
fn flaeche(conn: &Connection, window: &Window) -> Option<wl_surface::WlSurface> {
    let fenster = window.window_handle().ok()?;
    let RawWindowHandle::Wayland(fenster) = fenster.as_raw() else { return None };
    // SICHERHEIT: Der Zeiger kommt aus winits Fenster-Handle und zeigt auf
    // einen gueltigen `wl_proxy` der Schnittstelle `wl_surface`. Er bleibt
    // gueltig, solange das Fenster lebt — und dieses hier lebt, wir halten es
    // gerade in der Hand. `from_ptr` prueft die Schnittstelle selbst nach.
    let id = unsafe {
        ObjectId::from_ptr(wl_surface::WlSurface::interface(), fenster.surface.as_ptr().cast())
    }
    .ok()?;
    wl_surface::WlSurface::from_id(conn, id).ok()
}
