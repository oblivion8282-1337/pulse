//! Die Wayland-Gastverbindung fuer den Zug ueber die Fenstergrenze — verdrahtet
//! in `app::wayland_zug` (`aufbauen`/`zug_beginnen` beim Mausdruck,
//! `nachfassen`/`zeiger_ueber` im Takt). Waylands Datengeraet
//! beantwortet direkt, welches Fenster unter dem Zeiger liegt — auf einem
//! Compositor gibt es dafuer keine abfragbaren Fensterlagen wie unter X11
//! oder Windows. Was hier steht: die Verbindung, der Seat, ein eigener
//! zweiter Zeiger (liefert die Seriennummer, die `start_drag` verlangt) und
//! das Datengeraet. `start_drag` selbst sowie die Enter/Motion/Drop/Leave-
//! Auswertung stehen in [`zug`] daneben — Begruendungen (Einheit der
//! Koordinaten, die offene Frage zu mehreren eigenen Flaechen) dort im
//! Modulkopf.
//!
//! **Dieselbe Vorlage wie [`crate::tastensperre::wayland`], bewusst
//! nachgebaut statt neu erfunden** — beide binden Wayland-Protokolle NEBEN
//! winit, auf WINITS Verbindung, ohne eigenen Faden. Uebernommen:
//! - **Gast-Backend auf winits Verbindung** (`RawDisplayHandle::Wayland` →
//!   `Backend::from_foreign_display` → `Connection::from_backend`) — zwei
//!   Verbindungen koennten keine Objekte teilen, s. dortiger Modulkopf.
//! - **Eigene Warteschlange, kein eigener Faden.** Gelesen wird der Socket
//!   weiter von winit; geleert wird nur bei Gelegenheit ([`nachfassen`]).
//! - **Alle Sitzplaetze aus der Registry**, nicht nur der erste — winit gibt
//!   nicht heraus, welchen es selbst benutzt.
//!
//! **Was anders ist, und warum:**
//! - **Der Dispatch-Zustand traegt hier etwas.** Dort ist `Zustand` ein
//!   leerer Einheitstyp (jeder Aufruf von `nachfassen` baut sich einen
//!   frischen), weil kein Ereignis ausgewertet wird. Bei uns MUSS die
//!   zuletzt gedrueckte Seriennummer Aufrufe ueberleben — deshalb haelt
//!   [`Gastverbindung`] ihren `Zustand` als eigenes Feld und reicht
//!   **denselben** Wert bei jedem `nachfassen` erneut hinein.
//! - **Die Flaeche wird erst in [`zug`] rekonstruiert, nicht hier.** Die
//!   Vorlage braucht `wl_surface` sofort beim Aufbau, weil ein Inhibitor an
//!   eine bestimmte Flaeche gebunden wird. Dieses Modul bindet nichts an eine
//!   Flaeche — die Ursprungsflaeche fuer `start_drag` entsteht erst bei
//!   jedem Zugversuch aus dem dann uebergebenen Fenster (s. [`zug`]).
//! - **`event_created_child` ist hier Pflicht, dort ungenutzt.**
//!   `wl_data_device` erzeugt `wl_data_offer`-Kindobjekte;
//!   `zwp_keyboard_shortcuts_inhibitor_v1` erzeugt gar keine. S. die
//!   Begruendung direkt am `Dispatch<WlDataDevice, _>`-Impl unten — das ist
//!   der teuerste Stolperstein der ganzen Aufgabe.
//!
//! **Gemessen am 2026-08-24**, mit einem eigenstaendigen Testprogramm und
//! echten Maus-Ereignissen: zwei `wl_pointer` auf demselben Seat bekommen
//! dieselben Ereignisse mit **identischer** laufender Nummer (4 von 4
//! Paaren), und `start_drag` akzeptiert die Nummer des zweitgebundenen
//! Zeigers. Genau darauf baut [`Gastverbindung::letzte_druck_nummer`]: der
//! zweite, selbst gebundene Zeiger liefert die Nummer, die `start_drag`
//! verlangt und die winit selbst nicht herausgibt.
//!
//! **Die Nummer gilt nicht ueber einen Zug hinweg.** Sie entwertet sich
//! selbst nach `wl_data_device::Event::Drop` (Zug erfolgreich beendet) oder
//! `Event::Leave` (Zugsitzung abgebrochen) — danach ist die zugehoerige
//! implizite Ergreifung vorbei, und ein spaeterer `start_drag` mit der alten
//! Nummer griffe ins Leere. Eine neue Zugsitzung braucht deshalb zwingend
//! einen frischen Druck. Siehe [`DruckNummer::entwerten`].
//!
//! **Die Reihenfolge zwischen winits Zeiger und unserem ist nicht
//! zugesichert.** Libwayland verteilt beim Lesen an alle Warteschlangen;
//! welche zuerst dispatcht, ist nicht Teil des Protokolls. Das ist
//! unerheblich — es kommt nicht darauf an, WER zuerst dispatcht, beide sehen
//! fuer denselben physischen Druck dieselbe Seriennummer, und nur die Nummer
//! wird gebraucht.
//!
//! **Mehrere Sitzplaetze kollabieren auf EINE Nummer** —
//! `letzte_druck_nummer` nimmt keinen Sitzplatz entgegen, jeder Druck auf
//! irgendeinem gebundenen Zeiger ueberschreibt sie. Auf einem gewoehnlichen
//! Arbeitsplatzrechner mit einem Sitzplatz macht das keinen Unterschied; an
//! einem Mehrsitzplatz-Rechner koennte ein Druck auf dem einen Platz die
//! Nummer eines laufenden Zugs auf dem anderen ueberschreiben. Anders als die
//! Vorlage (dort bekommt JEDER Sitzplatz einen eigenen Inhibitor) ist das
//! hier nicht aufgeloest — Fundament, kein Mehrplatz-Rechner zur Hand, s.
//! Bericht.
//!
//! **Ungeprueft bleibt alles, was eine echte Wayland-Sitzung braucht**
//! (Verbindungsaufbau, Registry, Binden, Dispatch — auf dieser Maschine ohne
//! laufenden Compositor nicht ausfuehrbar). Geprueft ist nur [`DruckNummer`]
//! selbst, die reine Zustandsfuehrung ohne jede Wayland-Abhaengigkeit (s.
//! Tests unten).

mod zug;

use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use wayland_backend::sys::client::Backend;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{
    wl_data_device, wl_data_device_manager, wl_data_offer,
    wl_pointer::{self, ButtonState},
    wl_registry, wl_seat,
};
use wayland_client::{
    delegate_noop, event_created_child, Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    WEnum,
};
use winit::window::Window;

/// Die reine Zustandsfuehrung hinter [`Gastverbindung::letzte_druck_nummer`]:
/// welche Wayland-Seriennummer gerade als „zuletzter Druck" gilt.
///
/// Getrennt vom Dispatch-Code, damit sie ohne Wayland-Verbindung und ohne
/// Compositor testbar bleibt (s. Modulkopf, „Ungeprueft bleibt").
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct DruckNummer(Option<u32>);

impl DruckNummer {
    /// Ein `wl_pointer.button`-Ereignis mit `state == Pressed` ist eingetroffen.
    fn druecken(&mut self, seriennummer: u32) {
        self.0 = Some(seriennummer);
    }

    /// Die Zugsitzung ist vorbei (`wl_data_device::Event::Drop`/`Leave`) —
    /// die zugehoerige implizite Ergreifung existiert nicht mehr, ein
    /// erneuter `start_drag` mit dieser Nummer griffe ins Leere.
    fn entwerten(&mut self) {
        self.0 = None;
    }

    fn aktuell(&self) -> Option<u32> {
        self.0
    }
}

/// Ob der laufende Zug (aus Sicht des Datengeraets) zuende ist — und ob das
/// schon SICHER ist.
///
/// **Getrennt von [`zug::ZugLage`], weil deren Momentaufnahme
/// (`aktuell() == None`) das Ende NICHT zuverlaessig anzeigt** — Review-
/// Befunde C2/I3 vom 2026-08-24: ein ganzer Zug kann VOLLSTAENDIG zwischen
/// zwei Abtastungen ablaufen (`Enter -> Motion -> Drop -> Leave` in einem
/// einzigen `dispatch_pending`, wenn Druck und Loslassen sehr schnell
/// aufeinander folgen — dann war `ZugLage::aktuell()` nie von aussen als
/// `Some` sichtbar, und ein Ende-Erkenner, der darauf wartet, sieht es nie).
/// Und ein Flaechenwechsel innerhalb DESSELBEN Zugs raeumt `ZugLage` per
/// `Leave` kurz VOR dem naechsten `Enter` derselben Zugsitzung (gemessene
/// Abfolge `Enter(A) -> Leave -> Enter(B)`, s. [`zug`]-Modulkopf) — eine
/// Abtastung genau in dieser Luecke saehe ebenfalls wie ein Ende aus, waere
/// aber keins.
///
/// `Zugende` ist deshalb EREIGNISGETRIEBEN statt abgetastet: nur `Drop`/
/// `Enter`/`Leave` bewegen ihn voran, [`Gastverbindung::zug_zuende`]
/// konsumiert das Ergebnis genau einmal.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Zugende {
    #[default]
    Keins,
    /// Ein `Leave` kam, OHNE dass zuvor in dieser Zugsitzung ein `Drop` fiel
    /// — koennte ein Flaechenwechsel sein (dann kommt gleich ein `Enter` und
    /// hebt das wieder auf, s. [`Zugende::betreten`]) oder ein Abbruch ohne
    /// Ablage. Bleibt es einen GANZEN `nachfassen`-Umlauf lang unwiderlegt,
    /// gilt es als [`Zugende::Beendet`] (s. [`Gastverbindung::nachfassen`]).
    Unklar,
    /// Definitiv vorbei: `Drop` kam (sofort, ohne auf das abschliessende
    /// `Leave` zu warten — ein `Drop` ohne vorheriges Loesen der Maustaste
    /// gibt es im Protokoll nicht), oder [`Zugende::Unklar`] hat einen
    /// Umlauf ueberlebt.
    Beendet,
}

impl Zugende {
    /// `wl_data_device::Event::Enter` — widerlegt ein vorheriges `Unklar`
    /// (Flaechenwechsel bestaetigt: die Zugsitzung geht weiter). Ein bereits
    /// definitives `Beendet` bleibt dagegen unangetastet: das kaeme nur vor,
    /// wenn eine NEUE Zugsitzung beginnt, bevor [`Gastverbindung::zug_zuende`]
    /// das alte Ende abgeholt hat — und dann darf dieses alte Ende nicht
    /// verlorengehen, sonst bliebe ein Mausknopf am fernen Rechner haengen.
    fn betreten(&mut self) {
        if *self == Self::Unklar {
            *self = Self::Keins;
        }
    }

    /// `Drop` — sofort und unbedingt definitiv (s. Typ-Doku).
    fn fallengelassen(&mut self) {
        *self = Self::Beendet;
    }

    /// `Leave` — nur „unklar", wenn nicht schon `Drop` das Ende gesetzt hat.
    /// Sonst wuerde das abschliessende `Leave` NACH einem `Drop` das
    /// definitive Ende faelschlich wieder auf „unklar" zuruecksetzen.
    fn verlassen(&mut self) {
        if *self != Self::Beendet {
            *self = Self::Unklar;
        }
    }

    /// Nach einem vollen `dispatch_pending`-Umlauf, der mit `Unklar` BEGANN:
    /// ist es immer noch `Unklar` (kein `Enter` kam dazwischen), gilt es
    /// jetzt als sicher beendet. Aufgerufen aus
    /// [`Gastverbindung::nachfassen`], nicht aus dem Dispatch selbst — dort
    /// gibt es keinen Begriff von „ein Umlauf ist vorbei".
    fn umlauf_ohne_widerspruch(&mut self, war_unklar_davor: bool) {
        if war_unklar_davor && *self == Self::Unklar {
            *self = Self::Beendet;
        }
    }

    /// Konsumierend: `true` GENAU EINMAL, wenn [`Self::Beendet`] gilt —
    /// danach wieder [`Self::Keins`]. Ohne das Konsumieren wuerde derselbe
    /// Ende-Frame bei jedem Tick erneut gemeldet.
    fn konsumiere_beendet(&mut self) -> bool {
        if *self == Self::Beendet {
            *self = Self::Keins;
            true
        } else {
            false
        }
    }
}

/// Der Dispatch-Zustand. Anders als in [`crate::tastensperre::wayland`], wo
/// `Zustand` leer ist (s. Modulkopf, „Was anders ist"), traegt er hier vier
/// Daten:
/// - [`DruckNummer`] — die zuletzt gedrueckte Seriennummer.
/// - [`zug::ZugLage`] — welche eigene Flaeche der Zeiger waehrend eines
///   laufenden Zugs beruehrt und wo darin (s. [`zug`]).
/// - [`Zugende`] — EREIGNISGETRIEBEN, ob/wie sicher der Zug zuende ist (s.
///   dortige Typ-Doku, Review-Befunde C2/I3).
/// - `angebot` — das `wl_data_offer`, das ein `Enter` gerade eingefuehrt hat
///   (nur bei einem FREMDEN Zug belegt, s. dortiger Match-Arm; `Selection`
///   — die Zwischenablage — wird nicht ausgewertet und befuellt dieses Feld
///   deshalb NIE, s. Bedenken im Bericht) — muss beim `Leave` zerstoert
///   werden, das verlangt das Protokoll ausdruecklich.
#[derive(Default)]
struct Zustand {
    druck: DruckNummer,
    zug: zug::ZugLage,
    ende: Zugende,
    angebot: Option<wl_data_offer::WlDataOffer>,
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Zustand {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Wie in der Vorlage: die Liste der Globals fuehrt
        // `registry_queue_init` selbst, hierher kommt nur die Durchschrift.
    }
}

delegate_noop!(Zustand: ignore wl_seat::WlSeat);
// Der Manager hat keine Ereignisse — die Form ohne `ignore` laesst es
// knallen, falls je eines kaeme (wie beim Inhibit-Manager der Vorlage).
delegate_noop!(Zustand: wl_data_device_manager::WlDataDeviceManager);
// Die Angebote selbst werden nicht ausgewertet (kein Mime-Type-Abgleich,
// kein `receive`) — `ignore` statt der knallenden Form, weil sie ganz
// regulaer eintreffen und entgegengenommen werden MUESSEN (s.
// `event_created_child` unten). Zerstoert werden sie trotzdem — nicht hier
// (das waere die REAKTION auf ihre EIGENEN Ereignisse, wie `offer`), sondern
// im `wl_data_device`-Dispatch unten, beim `Leave` des Zugs, der sie
// eingefuehrt hat.
delegate_noop!(Zustand: ignore wl_data_offer::WlDataOffer);

impl Dispatch<wl_pointer::WlPointer, ()> for Zustand {
    /// Nur ein Ereignis zaehlt: der Druck. Alles andere (Loslassen, Bewegung,
    /// Eintritt/Austritt, Rad, ...) wird nicht ausgewertet — winit macht die
    /// eigentliche Eingabe-Erfassung, dieser zweite Zeiger existiert
    /// ausschliesslich, um die Seriennummer eines Drucks abzulesen.
    fn event(
        zustand: &mut Self,
        _: &wl_pointer::WlPointer,
        ereignis: wl_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_pointer::Event::Button {
            serial, state: WEnum::Value(ButtonState::Pressed), ..
        } = ereignis
        {
            zustand.druck.druecken(serial);
        }
    }
}

impl Dispatch<wl_data_device::WlDataDevice, ()> for Zustand {
    /// `Enter`/`Motion` speisen [`zug::ZugLage`] (welche eigene Flaeche, wo
    /// darin — s. [`zug`] fuer die Einheit der Koordinaten) UND widerlegen ein
    /// vorheriges `Unklar` in [`Zugende`]. `Drop`/`Leave` entwerten die
    /// gemerkte Druck-Nummer (s. Modulkopf, „Die Nummer gilt nicht ueber
    /// einen Zug hinweg"), raeumen die Zug-Lage UND bewegen [`Zugende`] voran
    /// (`Drop` sofort definitiv, `Leave` nur „unklar" — s. dortige Typ-Doku);
    /// `Leave` zerstoert zusaetzlich ein noch offenes `wl_data_offer` (s.
    /// Feld-Doc an [`Zustand`]). `Selection`/`DataOffer` bleiben
    /// unausgewertet — die Zwischenablage ist nicht Sache dieses Moduls.
    fn event(
        zustand: &mut Self,
        _: &wl_data_device::WlDataDevice,
        ereignis: wl_data_device::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match ereignis {
            wl_data_device::Event::Enter { surface, x, y, id, .. } => {
                zustand.zug.betreten(surface.id(), x, y);
                zustand.ende.betreten();
                zustand.angebot = id;
            }
            wl_data_device::Event::Motion { x, y, .. } => {
                zustand.zug.bewegt(x, y);
            }
            wl_data_device::Event::Drop => {
                zustand.druck.entwerten();
                zustand.zug.verlassen();
                zustand.ende.fallengelassen();
            }
            wl_data_device::Event::Leave => {
                zustand.druck.entwerten();
                zustand.zug.verlassen();
                zustand.ende.verlassen();
                // Protokoll (`wl_data_device::leave`): "The client must
                // destroy the wl_data_offer introduced at enter time at this
                // point." Fuer UNSEREN eigenen Zug (`source=None`) war `id`
                // beim `Enter` immer `None` (s. Modulkopf [`zug`]) — dieser
                // Zweig greift nur, wenn ein FREMDER Zug uns ein Angebot
                // hinterlassen hat. Die Zwischenablage (`Selection`) befuellt
                // `angebot` NIE — dieser Match hat keinen Arm dafuer (s. oben,
                // „Selection/DataOffer bleiben unausgewertet").
                if let Some(angebot) = zustand.angebot.take() {
                    angebot.destroy();
                }
            }
            _ => {}
        }
    }

    // STOLPERSTEIN 1 — der teuerste der ganzen Aufgabe, belegt durch die
    // Messung vom 2026-08-24: `wl_data_device` erzeugt `wl_data_offer`
    // Kindobjekte (Ereignis `data_offer`). Ohne dieses `event_created_child`
    // stuerzt der Prozess beim ERSTEN `data_offer` ab — und das trifft schon
    // beim Start ueber `Selection` (die Zwischenablage) ein, nicht erst beim
    // Ziehen. Wer das Datengeraet gedanklich nur fuer `start_drag` benutzt,
    // uebersieht diese Zeile zwangslaeufig: das erste Angebot, das crasht,
    // hat mit einem Zug nichts zu tun. NICHT ENTFERNEN, auch wenn Angebote
    // nirgends ausgewertet werden — sie muessen nur entgegengenommen werden
    // duerfen (s. `delegate_noop!` fuer `WlDataOffer` oben).
    event_created_child!(Zustand, wl_data_device::WlDataDevice, [
        wl_data_device::EVT_DATA_OFFER_OPCODE => (wl_data_offer::WlDataOffer, ()),
    ]);
}

/// Verbindung, Seats, der zweite Zeiger je Seat und das Datengeraet je Seat —
/// alles, was der Zug ueber die Fenstergrenze auf Wayland braucht.
/// `zug_beginnen`/`zeiger_ueber` (s. [`zug`]) sind die Methoden, die ihn
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
#[allow(dead_code)]
pub struct Gastverbindung {
    conn: Connection,
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
    datengeraete: Vec<wl_data_device::WlDataDevice>,
    zustand: Zustand,
}

impl Gastverbindung {
    /// Warteschlange leeren, nicht blockierend.
    ///
    /// Muss sein, weil die Registry weiter jedes kommende und gehende Global
    /// hineinlegt und weil sonst kein `button`- oder `Drop`/`Leave`-Ereignis
    /// je den `Zustand` erreicht. Blockiert nicht: gelesen wird der Socket
    /// von winit, hier wird nur abgeholt, was schon dort liegt.
    ///
    /// **Traegt auch die Ein-Umlauf-Kulanz fuer [`Zugende::Unklar`]** (Review
    /// C2/I3): `war_unklar` haelt fest, ob der Zustand VOR diesem Dispatch
    /// schon „unklar" war; blieb er es auch NACH diesem Dispatch (kein
    /// `Enter` widerlegte es dazwischen), gilt er jetzt als sicher beendet.
    /// Das gibt einem `Enter`, das den Flaechenwechsel bestaetigt, einen
    /// vollen `nachfassen`-Umlauf Zeit, bevor ein blosses `Leave` als Ende
    /// gilt — **kein Beweis, dass das immer reicht** (s. Bericht), aber
    /// deutlich enger als eine reine Momentaufnahme.
    pub fn nachfassen(&mut self) {
        let war_unklar = self.zustand.ende == Zugende::Unklar;
        let _ = self.queue.dispatch_pending(&mut self.zustand);
        self.zustand.ende.umlauf_ohne_widerspruch(war_unklar);
    }

    /// Die Seriennummer des letzten Drucks — `None`, solange keiner
    /// stattfand oder die letzte Zugsitzung schon beendet ist (s. Modulkopf).
    pub fn letzte_druck_nummer(&self) -> Option<u32> {
        self.zustand.druck.aktuell()
    }

    /// Ist der laufende Zug soeben (durch `Drop`, oder durch ein unwiderlegt
    /// gebliebenes `Leave`) endgueltig zuende? EREIGNISGETRIEBEN, nicht aus
    /// einer Momentaufnahme von [`Self::zeiger_ueber`] (s. [`Zugende`]-Doku,
    /// Review-Befunde C2/I3) — **konsumierend**: ein zweiter Aufruf ohne ein
    /// neues Ende liefert wieder `false`.
    pub fn zug_zuende(&mut self) -> bool {
        self.zustand.ende.konsumiere_beendet()
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
    // Zusage wie in der Vorlage (dort uebernimmt `Gemeinsam::schliessen`/
    // `Drop` das; dieses Fundament hat noch keinen Aufrufer, der das
    // uebernehmen koennte — s. Bericht). `from_foreign_display` legt das
    // Backend im Gast-Modus an: es schliesst die Verbindung beim Abbau NICHT.
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

#[cfg(test)]
mod tests {
    use super::{DruckNummer, Zugende};

    #[test]
    fn frische_nummer_ist_leer() {
        assert_eq!(DruckNummer::default().aktuell(), None);
    }

    #[test]
    fn druck_liefert_die_gedrueckte_seriennummer() {
        let mut nummer = DruckNummer::default();
        nummer.druecken(42);
        assert_eq!(nummer.aktuell(), Some(42));
    }

    #[test]
    fn ein_zweiter_druck_ueberschreibt_den_ersten() {
        // Zwischen zwei Druecken liegt kein Entwerten — der zweite Druck
        // (derselbe Zeiger oder ein anderer Sitzplatz, s. Modulkopf
        // „Mehrere Sitzplaetze kollabieren") gilt einfach als der neue.
        let mut nummer = DruckNummer::default();
        nummer.druecken(1);
        nummer.druecken(2);
        assert_eq!(nummer.aktuell(), Some(2));
    }

    #[test]
    fn entwerten_macht_die_nummer_wieder_leer() {
        let mut nummer = DruckNummer::default();
        nummer.druecken(7);
        nummer.entwerten();
        assert_eq!(nummer.aktuell(), None);
    }

    #[test]
    fn entwerten_ohne_vorherigen_druck_bleibt_folgenlos() {
        // Der Fall bei Sitzungsstart: ein `Leave` kann eintreffen, bevor
        // ueberhaupt je gedrueckt wurde (z. B. Fokuswechsel). Darf nicht
        // knallen und aendert nichts an „leer".
        let mut nummer = DruckNummer::default();
        nummer.entwerten();
        assert_eq!(nummer.aktuell(), None);
    }

    #[test]
    fn nach_entwerten_gilt_ein_neuer_druck_wieder() {
        // Genau der Fall aus dem Modulkopf: eine Zugsitzung endet (Drop/
        // Leave), und die naechste braucht einen frischen Druck — die alte
        // Nummer darf nicht wiederauferstehen.
        let mut nummer = DruckNummer::default();
        nummer.druecken(5);
        nummer.entwerten();
        nummer.druecken(9);
        assert_eq!(nummer.aktuell(), Some(9));
    }

    // ── Zugende (Review-Befunde C2/I3) ──────────────────────────────────

    #[test]
    fn frisch_ist_keins() {
        assert_eq!(Zugende::default(), Zugende::Keins);
    }

    #[test]
    fn drop_ist_sofort_definitiv() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        assert_eq!(ende, Zugende::Beendet);
    }

    #[test]
    fn leave_ohne_vorheriges_drop_ist_nur_unklar() {
        let mut ende = Zugende::default();
        ende.verlassen();
        assert_eq!(ende, Zugende::Unklar, "noch nicht definitiv — koennte ein Flaechenwechsel sein");
    }

    /// **Der Flaechenwechsel-Fall (I3):** `Leave(A)` gefolgt von `Enter(B)`
    /// IM SELBEN Zug widerlegt das `Unklar` wieder — kein Ende.
    #[test]
    fn enter_widerlegt_ein_unklares_leave() {
        let mut ende = Zugende::default();
        ende.verlassen();
        ende.betreten();
        assert_eq!(ende, Zugende::Keins, "der Flaechenwechsel wurde bestaetigt, kein Ende");
    }

    /// Ein bereits definitives `Beendet` (durch `Drop`) darf ein danach
    /// eintreffendes `Enter` NICHT verlieren — sonst verschluckt eine neue
    /// Zugsitzung, die beginnt, bevor `zug_zuende()` das alte Ende abgeholt
    /// hat, genau dieses Ende.
    #[test]
    fn enter_laesst_ein_bereits_definitives_ende_unangetastet() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        ende.betreten();
        assert_eq!(ende, Zugende::Beendet);
    }

    /// Das abschliessende `Leave` NACH einem `Drop` (gemessene Abfolge
    /// `Drop -> Leave`, s. `zug`-Modulkopf) darf das definitive Ende nicht
    /// wieder auf „unklar" zuruecksetzen.
    #[test]
    fn leave_nach_drop_bleibt_beendet() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        ende.verlassen();
        assert_eq!(ende, Zugende::Beendet);
    }

    /// **Der C2-Kernfall:** ein ganzer Zug (`Enter -> Motion -> Drop ->
    /// Leave`) lief vollstaendig ab, ohne dass je eine Abtastung dazwischen
    /// kam — `Zugende` ist trotzdem korrekt `Beendet`, weil `Drop` sofort
    /// definitiv ist, unabhaengig von jeder Momentaufnahme.
    #[test]
    fn ein_ganzer_schneller_zug_ergibt_beendet_ohne_zwischenabtastung() {
        let mut ende = Zugende::default();
        ende.betreten(); // Enter
        // Motion beruehrt `Zugende` nicht.
        ende.fallengelassen(); // Drop
        ende.verlassen(); // Leave
        assert_eq!(ende, Zugende::Beendet);
    }

    #[test]
    fn konsumiere_beendet_liefert_einmal_true_und_dann_wieder_false() {
        let mut ende = Zugende::default();
        ende.fallengelassen();
        assert!(ende.konsumiere_beendet());
        assert!(!ende.konsumiere_beendet(), "ein zweiter Aufruf ohne neues Ende liefert false");
        assert_eq!(ende, Zugende::Keins);
    }

    #[test]
    fn konsumiere_beendet_ohne_ende_liefert_false() {
        assert!(!Zugende::default().konsumiere_beendet());
        let mut unklar = Zugende::default();
        unklar.verlassen();
        assert!(!unklar.konsumiere_beendet(), "unklar ist noch nicht beendet");
    }

    /// **Die Ein-Umlauf-Kulanz, isoliert getestet:** blieb `Unklar` ueber
    /// einen GANZEN Umlauf hinweg unwiderlegt (kein `Enter` dazwischen),
    /// wird es beendet.
    #[test]
    fn unklar_wird_nach_einem_umlauf_ohne_widerspruch_beendet() {
        let mut ende = Zugende::default();
        ende.verlassen(); // Leave, kein vorheriges Drop -> Unklar
        ende.umlauf_ohne_widerspruch(true);
        assert_eq!(ende, Zugende::Beendet);
    }

    /// Widerlegt ein `Enter` das `Unklar` INNERHALB desselben Umlaufs (bevor
    /// `umlauf_ohne_widerspruch` geprueft wird), bleibt es beim
    /// Flaechenwechsel — keine faelschliche Beendigung.
    #[test]
    fn ein_enter_im_selben_umlauf_verhindert_die_beendigung() {
        let mut ende = Zugende::default();
        ende.verlassen(); // Leave -> Unklar
        ende.betreten(); // Enter im selben Umlauf -> Keins
        ende.umlauf_ohne_widerspruch(true);
        assert_eq!(ende, Zugende::Keins, "das Enter hat widersprochen, kein Ende");
    }

    /// `war_unklar_davor = false` darf ein Unklar, das ERST WAEHREND dieses
    /// Umlaufs entstand, nicht sofort beenden — es braucht seinen EIGENEN
    /// vollen Umlauf unwiderlegt, nicht nur irgendeinen.
    #[test]
    fn ein_frisch_entstandenes_unklar_braucht_einen_eigenen_umlauf() {
        let mut ende = Zugende::default();
        ende.verlassen(); // Unklar, entstand JETZT
        ende.umlauf_ohne_widerspruch(false);
        assert_eq!(ende, Zugende::Unklar, "noch keinen vollen Umlauf ueberlebt");
    }
}
