//! Die Gastverbindung selbst: aufbauen, nachfassen, und die Auskuenfte, aus
//! denen `app::wayland_zug` seine Entscheidungen zieht.
//!
//! Abgetrennt von [`super`], wo der Dispatch wohnt (welches Ereignis welchen
//! Zustand bewegt), und von [`super::zustand`], wo die Entscheidungen darauf
//! als reine Funktionen stehen. Groessen-Begruendung wie ueberall hier
//! (`PLAN.md` §12.1).
//!
//! **Zwei Reihenfolge-Regeln sind hier in die Typen gewandert** statt als
//! Prosa in Doc-Kommentaren zu stehen (Review der vierten Runde):
//! * `nachfassen` gibt den Schluss **zurueck**, statt ihn liegenzulassen —
//!   „dispatchen ohne das Ende abzuholen" ist damit gar nicht mehr
//!   formulierbar. Ein `Beendet`, das liegenbleibt, war Review-Befund C-1.
//! * Beide schluss-liefernden Methoden sind `#[must_use]`. Ein zweites,
//!   unbedachtes `nachfassen()` (Review C-A) faellt damit als Warnung auf —
//!   und Warnungen sind in diesem Projekt ein hartes Tor.

use std::time::Instant;

use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use wayland_backend::sys::client::Backend;
use wayland_client::globals::registry_queue_init;
use wayland_client::protocol::{wl_data_device, wl_data_device_manager, wl_pointer, wl_seat};
use wayland_client::{Connection, EventQueue, Proxy, QueueHandle};
use winit::window::Window;

use super::ende::Zugende;
use super::zug::ZugLage;
use super::zustand::{zugschluss, Zugschluss, Zustand, ANLAUFFRIST};

/// Verbindung, Seats, der zweite Zeiger je Seat und das Datengeraet je Seat —
/// alles, was der Zug ueber die Fenstergrenze auf Wayland braucht.
/// `zug_beginnen`/`zeiger_ueber` (s. [`super::zug`]) sind die Methoden, die ihn
/// tatsaechlich ausloesen bzw. auswerten, verdrahtet in `app::wayland_zug`.
///
/// **`qh`/`manager`/`seats`/`zeiger` werden nach [`aufbauen`] nie wieder
/// GELESEN** — der Compiler sieht das erst, seit dieses Modul ueberhaupt
/// benutzt wird, und meldet es sonst als `dead_code`. Gehalten werden sie
/// trotzdem: `seats`/`zeiger` sind die Bindungen, aus denen `datengeraete`
/// entstand (dieselbe Rolle wie `seats` in
/// `crate::tastensperre::wayland::Verbindung`), `qh` und `manager` gehoeren
/// zur selben Verbindung und wuerden sonst am Ende von [`aufbauen`] gleich
/// wieder fallen. Keins davon ist ein Aufraeum-Versehen, das nachgeholt
/// werden muesste.
///
/// Die Felder sind `pub(super)`, weil `super::zug` denselben Typ weiterbaut
/// (`start_drag` braucht `conn` und `datengeraete`) — sie sind ein
/// Schwestermodul, kein Kind, und kaemen sonst nicht an sie heran.
#[allow(dead_code)]
pub struct Gastverbindung {
    pub(super) conn: Connection,
    queue: EventQueue<Zustand>,
    qh: QueueHandle<Zustand>,
    manager: wl_data_device_manager::WlDataDeviceManager,
    /// Alle Sitzplaetze — winit gibt nicht heraus, welchen es selbst benutzt
    /// (dieselbe Begruendung wie in der Vorlage).
    seats: Vec<wl_seat::WlSeat>,
    /// Je Seat ein EIGENER zweiter Zeiger, nicht winits. Bekommt dieselben
    /// `button`-Ereignisse mit identischer Seriennummer (Messung 2026-08-24)
    /// — das ist der ganze Zweck dieses Felds.
    zeiger: Vec<wl_pointer::WlPointer>,
    /// Je Seat ein Datengeraet.
    pub(super) datengeraete: Vec<wl_data_device::WlDataDevice>,
    pub(super) zustand: Zustand,
}

impl Gastverbindung {
    /// Warteschlange leeren und **den Schluss abholen** — untrennbar, s.
    /// Modulkopf.
    ///
    /// Das Leeren muss sein, weil die Registry weiter jedes kommende und
    /// gehende Global hineinlegt und weil sonst kein `button`- oder
    /// `Drop`/`Leave`-Ereignis je den `Zustand` erreicht. Blockiert nicht:
    /// gelesen wird der Socket von winit, hier wird nur abgeholt, was schon
    /// dort liegt.
    ///
    /// **Traegt beide Fristen** — die [`super::ende::NOTFRIST`] fuer ein
    /// unaufgeloestes `Leave` und die [`ANLAUFFRIST`] fuer einen nie
    /// bestaetigten Zug (beide schliessen sich aus, s. `zustand::zugschluss`).
    /// Hier und nicht im Dispatch, weil beide gerade dann greifen sollen, wenn
    /// ueberhaupt kein Ereignis mehr kommt. Beide melden sich im Log: sie sind,
    /// anders als die uebrigen Ende-Wege, echte Ausnahmefaelle (Review I-1).
    ///
    /// **Raeumt selbst nichts ab.** Was zu einem Zug gehoert, raeumt der eine
    /// Trichter in `app::wayland_zug::entscheidung` — diese Methode sagt nur,
    /// dass er zu rufen ist, und mit welchem Schalter.
    #[must_use = "der Schluss muss angewandt werden — sonst bleibt ein Ende liegen (Review C-1)"]
    pub fn nachfassen(&mut self) -> Zugschluss {
        let _ = self.queue.dispatch_pending(&mut self.zustand);
        let schluss = zugschluss(&mut self.zustand, Instant::now());
        match schluss {
            Zugschluss::Beendet { notfrist: true } => eprintln!(
                "pulse-player: Wayland-Zug — der Zeiger hat {} s lang kein Player-Fenster \
                 beruehrt und winit hat sich nicht zurueckgemeldet; der Zug gilt als beendet \
                 und alles Gedrueckte wird freigegeben. Lief er in Wirklichkeit noch, ist die \
                 Geste ab hier tot (s. `wayland::ende::NOTFRIST`).",
                super::ende::NOTFRIST.as_secs()
            ),
            Zugschluss::Verfallen => eprintln!(
                "pulse-player: Wayland-Zug — seit {} s angefordert, ohne dass er begonnen hat \
                 und ohne ein einziges Zeigerereignis dazwischen; der Merker wird aufgegeben \
                 (es wird nichts losgelassen).",
                ANLAUFFRIST.as_secs()
            ),
            _ => {}
        }
        schluss
    }

    /// Die Seriennummer des letzten Drucks — `None`, solange keiner
    /// stattfand oder die letzte Zugsitzung schon beendet ist (s.
    /// [`super`]-Modulkopf).
    pub fn letzte_druck_nummer(&self) -> Option<u32> {
        self.zustand.druck.aktuell()
    }

    /// Haben wir selbst einen Zug angefordert (s. `Zustand::eigener_zug`)?
    pub fn zug_angefordert(&self) -> bool {
        self.zustand.eigener_zug
    }

    /// Laeuft der angeforderte Zug nachweislich (erstes `Enter` gesehen, s.
    /// `Zustand::bestaetigt`)?
    pub fn zug_bestaetigt(&self) -> bool {
        self.zustand.bestaetigt
    }

    /// Bezeugen, dass der angeforderte Zug (noch) NICHT laeuft — die
    /// [`ANLAUFFRIST`] faengt von vorne an.
    ///
    /// Gerufen bei jedem winit-Zeigerereignis waehrend eines unbestaetigten
    /// Zugs: solange winit zustellt, hat der Compositor nachweislich nicht
    /// ergriffen (s. [`super::ende`]-Modulkopf), der Merker ist also nicht
    /// verwaist. **Damit misst die Frist Stille statt Zeit** (Review I-1 der
    /// vierten Runde) — vorher lief sie ab `start_drag` und auch dann weiter,
    /// wenn laufend das Gegenteil bewiesen wurde.
    pub fn anlauf_bezeugen(&mut self) {
        if self.zustand.eigener_zug && !self.zustand.bestaetigt {
            self.zustand.angefordert_seit = Some(Instant::now());
        }
    }

    /// Der Beweis von der anderen Seite: winit liefert wieder
    /// `CursorMoved`/`MouseInput`, der Griff des Compositors ist also vorbei
    /// (s. [`super::ende`]-Modulkopf). Loest ein offenes `Leave` auf — und
    /// **nur** das, nicht einen gesunden Zug (Begruendung an
    /// `Zugende::griff_vorbei`) — und holt den Schluss gleich mit ab.
    #[must_use = "der Schluss muss angewandt werden — sonst bleibt ein Ende liegen (Review C-1)"]
    pub fn griff_vorbei(&mut self) -> Zugschluss {
        self.zustand.ende.griff_vorbei();
        zugschluss(&mut self.zustand, Instant::now())
    }

    /// **Die Verbindungs-Haelfte des Abbaus**: alles vergessen, was zu einem
    /// Zug gehoert — Merker, Bestaetigung, Zugehoerigkeit, Anlauf-Frist, Ende
    /// und Lage.
    ///
    /// **Nur aus dem einen Trichter rufen** (`App::wayland_zug_abbau`), nie
    /// direkt: die andere Haelfte (Sitzung, Ziel, Gedruecktes) liegt in der
    /// `Erfassung`, und die beiden Haelften auseinanderlaufen zu lassen war die
    /// Ursache dreier Review-Runden.
    pub fn zug_aufgeben(&mut self) {
        self.zustand.eigener_zug = false;
        self.zustand.bestaetigt = false;
        self.zustand.fremder_zug = false;
        self.zustand.angefordert_seit = None;
        self.zustand.ende = Zugende::default();
        self.zustand.zug = ZugLage::default();
    }
}

/// Gast-Backend auf winits Anzeige legen, Datengeraet-Manager und Sitzplaetze
/// binden, je Sitzplatz einen zweiten Zeiger und ein Datengeraet dazu.
///
/// Der Fehlerfall traegt einen Grund fuer den Aufrufer-seitigen Log (s.
/// [`crate::tastensperre::wayland::aufbauen`] fuer das Vorbild) — auf X11
/// und auf Windows/macOS (dort baut das Modul gar nicht erst, s.
/// `fernsteuerung/mod.rs`) ist ein `Err` hier der Normalfall, kein Defekt.
pub fn aufbauen(window: &Window) -> Result<Gastverbindung, String> {
    let anzeige = window.display_handle().map_err(|e| format!("kein Anzeige-Handle: {e}"))?;
    let RawDisplayHandle::Wayland(anzeige) = anzeige.as_raw() else {
        return Err("kein Wayland (X11 kennt das Protokoll nicht)".into());
    };

    // SICHERHEIT: Der Zeiger kommt aus winits Anzeige-Handle und ist damit
    // ein gueltiger `wl_display`. Er muss das Backend ueberleben — dieselbe
    // Zusage wie in der Vorlage: `WaylandZug::schliessen`/`Drop` bauen die
    // Verbindung ab, solange winits Anzeige noch lebt (s. `app::wayland_zug`).
    // `from_foreign_display` legt das Backend im Gast-Modus an: es schliesst
    // die Verbindung beim Abbau NICHT.
    let backend = unsafe { Backend::from_foreign_display(anzeige.display.as_ptr().cast()) };
    let conn = Connection::from_backend(backend);

    let (globals, queue) = registry_queue_init::<Zustand>(&conn)
        .map_err(|e| format!("Registry nicht lesbar: {e}"))?;
    let qh = queue.handle();

    let manager: wl_data_device_manager::WlDataDeviceManager = globals
        .bind(&qh, 1..=1, ())
        .map_err(|e| format!("wl_data_device_manager: {e}"))?;

    // `GlobalList::bind` ist fuer Globals mit genau einer Ausfertigung
    // gedacht; `wl_seat` kann mehrfach vorkommen. Deshalb hier ueber die
    // Liste, damit wirklich JEDER Platz einen Zeiger und ein Datengeraet
    // bekommt (Begruendung an `seats`, wie in der Vorlage).
    let plaetze: Vec<u32> = globals.contents().with_list(|liste| {
        liste
            .iter()
            .filter(|global| global.interface == wl_seat::WlSeat::interface().name)
            .map(|global| global.name)
            .collect()
    });
    let seats: Vec<wl_seat::WlSeat> =
        plaetze.into_iter().map(|name| globals.registry().bind(name, 1, &qh, ())).collect();
    if seats.is_empty() {
        return Err("kein wl_seat angekuendigt".into());
    }

    let zeiger: Vec<wl_pointer::WlPointer> =
        seats.iter().map(|seat| seat.get_pointer(&qh, ())).collect();
    let datengeraete: Vec<wl_data_device::WlDataDevice> =
        seats.iter().map(|seat| manager.get_data_device(seat, &qh, ())).collect();

    let _ = conn.flush();
    Ok(Gastverbindung {
        conn,
        queue,
        qh,
        manager,
        seats,
        zeiger,
        datengeraete,
        zustand: Zustand::default(),
    })
}
