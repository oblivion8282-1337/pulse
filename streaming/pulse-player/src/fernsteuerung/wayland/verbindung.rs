//! Die Gastverbindung selbst: aufbauen, nachfassen, und die Auskuenfte, aus
//! denen `app::wayland_zug` seine Entscheidungen zieht.
//!
//! Abgetrennt von [`super`], wo der Dispatch wohnt (welches Ereignis welchen
//! Zustand bewegt). Groessen-Begruendung wie ueberall hier (`PLAN.md` §12.1):
//! `mod.rs` lag bei 489 von hart 500 Produktivzeilen, und der Merker aus
//! Review C-B braucht Platz fuer seine Begruendung.

use std::time::{Duration, Instant};

use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use wayland_backend::sys::client::Backend;
use wayland_client::globals::registry_queue_init;
use wayland_client::protocol::{wl_data_device, wl_data_device_manager, wl_pointer, wl_seat};
use wayland_client::{Connection, EventQueue, Proxy, QueueHandle};
use winit::window::Window;

use super::ende::Zugende;
use super::zug::ZugLage;
use super::zustand::Zustand;

/// Wie lange ein ANGEFORDERTER, aber nie bestaetigter Zug den Merker halten
/// darf, bevor er verfaellt.
///
/// **Wozu das noetig ist** (Review C-B, 2026-08-25): `eigener_zug` hatte nur
/// zwei Ausgaenge — ein abgeholtes Ende und das ausdrueckliche Aufgeben beim
/// Loslassen. Wer zwischen Druck und Loslassen den Fokus verliert oder das
/// Fenster schliesst, sah beides nie; der Merker blieb fuer den Rest der
/// Prozesslaufzeit stehen, und ab da sprach **jeder fremde Zug wieder fuer
/// uns** — samt fernem Zeiger, der einer fremden Datei hinterherspringt. Die
/// drei bekannten Wege raeumt `app::wayland_zug` jetzt ausdruecklich auf; diese
/// Frist ist der Guertel dazu, fuer den Weg, den niemand vorhergesehen hat —
/// und fuer einen Compositor, der `start_drag` ergreift, ohne je ein `Enter`
/// zu schicken (gemessen haben wir EINEN Compositor).
///
/// **Warum sie so lang ist.** Zwischen `start_drag` und dem ersten `Enter`
/// liegt kein Round-Trip, sondern die erste Zeigerbewegung des Nutzers
/// (gemessen 2026-08-24: 427 ms, weil so lange nicht bewegt wurde). Wer
/// drueckt und in Ruhe ueberlegt, bevor er zieht, haelt einen voellig gesunden
/// Zug beliebig lange unbestaetigt. Verfaellt der Merker zu frueh und der
/// Nutzer zieht DANN los, laeuft der Zug im Compositor weiter, waehrend wir
/// ihn nicht mehr verfolgen: seine Bewegungen gehen verloren und sein `Drop`
/// ebenso — die Maustaste bliebe am fernen Rechner unten, bis der Fokus
/// wechselt, die Erfassung endet oder der naechste Zug endet. 30 s sind
/// laenger als jedes plausible Zoegern und immer noch kurz gegen eine
/// Prozesslaufzeit.
///
/// **Verfallen heisst AUFGEBEN, nicht Beenden.** Ein Ende wuerde alles
/// Gedrueckte freigeben — und wenn der Nutzer die Taste in diesem Moment
/// wirklich haelt, waere das genau der schlimmste Ausgang dieses Vorhabens.
/// Aufgeben laesst im schlimmsten Fall eine Taste unten, die ein anderer Weg
/// noch loest.
pub(super) const ANLAUFFRIST: Duration = Duration::from_secs(30);

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
    /// Warteschlange leeren, nicht blockierend.
    ///
    /// Muss sein, weil die Registry weiter jedes kommende und gehende Global
    /// hineinlegt und weil sonst kein `button`- oder `Drop`/`Leave`-Ereignis
    /// je den `Zustand` erreicht. Blockiert nicht: gelesen wird der Socket
    /// von winit, hier wird nur abgeholt, was schon dort liegt.
    ///
    /// **Traegt beide Fristen** — die [`super::ende::NOTFRIST`] fuer ein
    /// unaufgeloestes `Leave` und die [`ANLAUFFRIST`] fuer einen nie
    /// bestaetigten Zug. Hier und nicht im Dispatch, weil beide gerade dann
    /// greifen sollen, wenn ueberhaupt kein Ereignis mehr kommt. Beide melden
    /// sich im Log: sie sind, anders als die uebrigen Ende-Wege, echte
    /// Ausnahmefaelle (Review I-1).
    pub fn nachfassen(&mut self) {
        let _ = self.queue.dispatch_pending(&mut self.zustand);
        let jetzt = Instant::now();
        if self.zustand.ende.frist_pruefen(jetzt) {
            eprintln!(
                "pulse-player: Wayland-Zug — der Zeiger hat {} s lang kein Player-Fenster \
                 beruehrt und winit hat sich nicht zurueckgemeldet; der Zug gilt als beendet \
                 und alles Gedrueckte wird freigegeben. Lief er in Wirklichkeit noch, ist die \
                 Geste ab hier tot (s. `wayland::ende::NOTFRIST`).",
                super::ende::NOTFRIST.as_secs()
            );
        }
        if self.anlauf_verfallen(jetzt) {
            eprintln!(
                "pulse-player: Wayland-Zug — seit {} s angefordert, aber nie begonnen; \
                 der Merker wird aufgegeben (es wird nichts losgelassen).",
                ANLAUFFRIST.as_secs()
            );
            self.zug_aufgeben();
        }
    }

    /// Ist ein angeforderter Zug ueber die [`ANLAUFFRIST`] hinaus unbestaetigt
    /// geblieben? Ein bereits stehendes Ende hat Vorrang — es wird abgeholt,
    /// nicht weggeraeumt.
    fn anlauf_verfallen(&self, jetzt: Instant) -> bool {
        if !self.zustand.eigener_zug
            || self.zustand.bestaetigt
            || self.zustand.ende != Zugende::Keins
        {
            return false;
        }
        self.zustand
            .angefordert_seit
            .is_some_and(|seit| jetzt.saturating_duration_since(seit) >= ANLAUFFRIST)
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

    /// Ist der laufende Zug soeben endgueltig zuende — durch `Drop`, durch den
    /// Beweisweg ([`Self::griff_vorbei`]) oder durch die abgelaufene
    /// [`super::ende::NOTFRIST`]? EREIGNISGETRIEBEN, nicht aus einer
    /// Momentaufnahme von `zeiger_ueber` (s. [`super::ende`], Review-Befunde
    /// C2/I3) — **konsumierend**: ein zweiter Aufruf ohne neues Ende liefert
    /// `false`.
    ///
    /// Mit dem Ende faellt auch der Merker: der naechste fremde Zug spricht
    /// nicht mehr fuer uns (C-1).
    pub fn zug_zuende(&mut self) -> bool {
        let zuende = self.zustand.ende.konsumiere_beendet();
        if zuende {
            self.zustand.eigener_zug = false;
            self.zustand.bestaetigt = false;
            self.zustand.angefordert_seit = None;
        }
        zuende
    }

    /// Der Beweis von der anderen Seite: winit liefert wieder
    /// `CursorMoved`/`MouseInput`, der Griff des Compositors ist also vorbei
    /// (s. [`super::ende`]-Modulkopf). Loest ein offenes `Leave` auf — und
    /// **nur** das, nicht einen gesunden Zug (Begruendung an
    /// `Zugende::griff_vorbei`). Der Aufrufer holt das Ergebnis im selben Zug
    /// mit [`Self::zug_zuende`] ab.
    pub fn griff_vorbei(&mut self) {
        self.zustand.ende.griff_vorbei();
    }

    /// Den eigenen Zug aufgeben, OHNE ein Ende zu melden.
    ///
    /// Fuer die Faelle, in denen es nichts zu beenden gibt: `start_drag` ging
    /// hinaus, aber der Compositor hat die Anfrage still verworfen (unpassende
    /// Seriennummer, s. `super::zug::Gastverbindung::zug_beginnen`) oder der
    /// Zug ist an uns vorbei zu Ende gegangen (Fokusverlust, Erfassung aus,
    /// Fenster zu — s. `app::wayland_zug`). Dann liegt der Knopf noch beim
    /// gewoehnlichen `MouseInput`-Weg, und ein gemeldetes Ende wuerde ihn
    /// mitten in der Geste freigeben.
    pub fn zug_aufgeben(&mut self) {
        self.zustand.eigener_zug = false;
        self.zustand.bestaetigt = false;
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
