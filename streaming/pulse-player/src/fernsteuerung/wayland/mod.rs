//! Die Wayland-Gastverbindung fuer den Zug ueber die Fenstergrenze — verdrahtet
//! in `app::wayland_zug` (`aufbauen` beim Einschalten der Erfassung,
//! `zug_beginnen` beim Mausdruck, `nachfassen`/`zeiger_ueber` im Takt).
//! Waylands Datengeraet
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
//! **Das Datengeraet gehoert nicht uns allein** (Review-Befund C-1,
//! 2026-08-24). Es meldet `Enter`/`Motion`/`Drop`/`Leave` auch fuer FREMDE
//! Zuege — jemand zieht eine Datei aus dem Dateimanager ueber ein
//! Player-Fenster —, und die Zwischenablage schickt schon beim Programmstart
//! ein `data_offer` (s. `event_created_child` unten). Die erste Fassung speiste
//! damit [`ende::Zugende`] und [`zug::ZugLage`], also genau die beiden Zaehler,
//! aus denen der Player „der Zug ist zuende, gib alles Gedrueckte frei"
//! ableitet: ein fremder Zug ueber ein Player-Fenster hinterliess ein
//! stehengebliebenes `Beendet`, das der NAECHSTE eigene Zug abholte und in
//! seinem ersten Tick als Ende deutete — die gerade gedrueckte Maustaste ging
//! am fernen Rechner sofort wieder hoch, waehrend der Nutzer sie hielt. Deshalb
//! der Merker [`Zustand::eigener_zug`]: die Zug-Auswertung laeuft nur, solange
//! ein EIGENER Zug angefordert ist. Was NICHT am Merker haengt, ist die
//! Angebots-Verwaltung — die verlangt das Protokoll fuer jeden Zug, auch fremde.
//!
//! **Ungeprueft bleibt alles, was eine echte Wayland-Sitzung braucht**
//! (Verbindungsaufbau, Registry, Binden, Dispatch). Geprueft ist die reine
//! Zustandsfuehrung ohne Wayland-Abhaengigkeit: [`DruckNummer`] hier,
//! [`ende::Zugende`] und [`zug::ZugLage`] daneben.

mod ende;
mod zug;

use std::time::Instant;

use ende::Zugende;
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

/// Der Dispatch-Zustand. Anders als in [`crate::tastensperre::wayland`], wo
/// `Zustand` leer ist (s. Modulkopf, „Was anders ist"), traegt er hier:
/// - [`DruckNummer`] — die zuletzt gedrueckte Seriennummer.
/// - [`zug::ZugLage`] — welche eigene Flaeche der Zeiger waehrend eines
///   laufenden Zugs beruehrt und wo darin (s. [`zug`]).
/// - [`Zugende`] — EREIGNISGETRIEBEN, ob/wie sicher der Zug zuende ist (s.
///   [`ende`], Review-Befunde C2/I3).
/// - `eigener_zug`/`bestaetigt` — der Merker aus Review-Befund C-1 (s.
///   Modulkopf) und seine Bestaetigung.
/// - `angebot` — das `wl_data_offer`, das ein `Enter` gerade eingefuehrt hat.
#[derive(Default)]
struct Zustand {
    druck: DruckNummer,
    zug: zug::ZugLage,
    ende: Zugende,
    /// **Haben WIR einen Zug angefordert?** Gesetzt von
    /// [`Gastverbindung::zug_beginnen`], sobald `start_drag` hinausgegangen
    /// ist; geloescht, sobald das Ende abgeholt oder der Zug aufgegeben wurde.
    /// Nur solange er steht, speisen `Enter`/`Motion`/`Drop`/`Leave` die
    /// Zug-Auswertung — ohne ihn spricht ein fremder Zug fuer uns (s.
    /// Modulkopf, C-1).
    ///
    /// **„Angefordert" ist nicht „laeuft".** `start_drag` ist eine
    /// Feuer-und-vergessen-Anfrage ohne Antwort; passt die Seriennummer nicht
    /// zum Sitzplatz, verwirft der Compositor sie still. Deshalb daneben:
    eigener_zug: bool,
    /// **Laeuft er wirklich?** Wird beim ersten `Enter` DIESES Zugs gesetzt.
    /// Vorher ist alles, was winit noch an Zeigerereignissen liefert,
    /// mehrdeutig (es koennen Ereignisse sein, die der Compositor schon vor
    /// unserem `start_drag` abgeschickt hatte); danach ist ein
    /// winit-Zeigerereignis der BEWEIS, dass der Griff vorbei ist (s.
    /// [`ende`]-Modulkopf, Messung 2026-08-24: waehrend des ganzen Zugs kam
    /// kein einziges `wl_pointer`-Ereignis). `app::wayland_zug` fragt beides
    /// ab und zieht daraus die Folgerung.
    ///
    /// Gemessen dazu: das erste `Enter` kommt NICHT mit `start_drag`, sondern
    /// erst mit der ersten Zeigerbewegung danach (427 ms im Messlauf, weil so
    /// lange nicht bewegt wurde).
    bestaetigt: bool,
    /// Muss beim `Leave` zerstoert werden, das verlangt das Protokoll
    /// ausdruecklich. **Haengt bewusst NICHT am Merker `eigener_zug`**: bei
    /// unserem eigenen Zug (`source = None`) ist es ohnehin immer `None` (s.
    /// [`zug`]-Modulkopf), belegt wird es also nur von FREMDEN Zuegen — und
    /// genau die muessen aufgeraeumt werden. `Selection` (die Zwischenablage)
    /// befuellt es nie, dieser Match hat keinen Arm dafuer.
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
    /// **Zwei Stufen, und die Trennung ist der C-1-Fix.**
    ///
    /// Zuerst das, was dem PROTOKOLL geschuldet ist und deshalb fuer jeden Zug
    /// gilt, auch einen fremden: das beim `Enter` eingefuehrte
    /// `wl_data_offer` merken und beim `Leave` zerstoeren — „The client must
    /// destroy the wl_data_offer introduced at enter time at this point".
    ///
    /// Erst danach, und **nur bei gesetztem [`Zustand::eigener_zug`]**, die
    /// Auswertung UNSERES Zugs: `Enter`/`Motion` speisen [`zug::ZugLage`]
    /// (welche eigene Flaeche, wo darin — s. [`zug`] fuer die Einheit der
    /// Koordinaten), `Enter` loest ausserdem ein `Unklar` in [`Zugende`] auf,
    /// `Drop`/`Leave` entwerten die gemerkte Druck-Nummer (s. Modulkopf, „Die
    /// Nummer gilt nicht ueber einen Zug hinweg"), raeumen die Zug-Lage und
    /// bewegen [`Zugende`] voran (`Drop` sofort definitiv, `Leave` nur
    /// „unklar" — s. [`ende`]).
    ///
    /// `Selection`/`DataOffer` bleiben unausgewertet — die Zwischenablage ist
    /// nicht Sache dieses Moduls.
    fn event(
        zustand: &mut Self,
        _: &wl_data_device::WlDataDevice,
        ereignis: wl_data_device::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match &ereignis {
            wl_data_device::Event::Enter { id, .. } => zustand.angebot = id.clone(),
            wl_data_device::Event::Leave => {
                if let Some(angebot) = zustand.angebot.take() {
                    angebot.destroy();
                }
            }
            _ => {}
        }
        if !zustand.eigener_zug {
            return;
        }
        match ereignis {
            wl_data_device::Event::Enter { surface, x, y, .. } => {
                zustand.zug.betreten(surface.id(), x, y);
                zustand.ende.betreten();
                zustand.bestaetigt = true;
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
                zustand.ende.verlassen(Instant::now());
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
    /// **Prueft dabei die [`ende::NOTFRIST`]** — das letzte Netz fuer ein
    /// `Leave`, das weder von einem `Enter` noch vom Beweisweg aufgeloest
    /// wurde (Begruendung samt Messung in [`ende`]). Hier und nicht im
    /// Dispatch, weil ein abgelaufenes `Unklar` gerade dann beendet werden
    /// soll, wenn ueberhaupt kein Ereignis mehr kommt.
    pub fn nachfassen(&mut self) {
        let _ = self.queue.dispatch_pending(&mut self.zustand);
        self.zustand.ende.frist_pruefen(Instant::now());
    }

    /// Die Seriennummer des letzten Drucks — `None`, solange keiner
    /// stattfand oder die letzte Zugsitzung schon beendet ist (s. Modulkopf).
    pub fn letzte_druck_nummer(&self) -> Option<u32> {
        self.zustand.druck.aktuell()
    }

    /// Haben wir selbst einen Zug angefordert (s. [`Zustand::eigener_zug`])?
    pub fn zug_angefordert(&self) -> bool {
        self.zustand.eigener_zug
    }

    /// Laeuft der angeforderte Zug nachweislich (erstes `Enter` gesehen, s.
    /// [`Zustand::bestaetigt`])?
    pub fn zug_bestaetigt(&self) -> bool {
        self.zustand.bestaetigt
    }

    /// Ist der laufende Zug soeben endgueltig zuende — durch `Drop`, durch den
    /// Beweisweg ([`Self::griff_vorbei`]) oder durch die abgelaufene
    /// [`ende::NOTFRIST`]? EREIGNISGETRIEBEN, nicht aus einer Momentaufnahme
    /// von [`Self::zeiger_ueber`] (s. [`ende`], Review-Befunde C2/I3) —
    /// **konsumierend**: ein zweiter Aufruf ohne neues Ende liefert `false`.
    ///
    /// Mit dem Ende faellt auch der Merker: der naechste fremde Zug spricht
    /// nicht mehr fuer uns (C-1).
    pub fn zug_zuende(&mut self) -> bool {
        let zuende = self.zustand.ende.konsumiere_beendet();
        if zuende {
            self.zustand.eigener_zug = false;
            self.zustand.bestaetigt = false;
        }
        zuende
    }

    /// Der Beweis von der anderen Seite: winit liefert wieder
    /// `CursorMoved`/`MouseInput`, der Griff des Compositors ist also vorbei
    /// (s. [`ende`]-Modulkopf). Loest ein offenes `Leave` auf — und **nur**
    /// das, nicht einen gesunden Zug (Begruendung an [`Zugende::griff_vorbei`]).
    /// Der Aufrufer holt das Ergebnis im selben Zug mit [`Self::zug_zuende`]
    /// ab.
    pub fn griff_vorbei(&mut self) {
        self.zustand.ende.griff_vorbei();
    }

    /// Den eigenen Zug aufgeben, OHNE ein Ende zu melden.
    ///
    /// Fuer den einen Fall, in dem es gar keinen Zug gab: `start_drag` ging
    /// hinaus, der Compositor hat die Anfrage aber still verworfen (unpassende
    /// Seriennummer, s. [`zug::Gastverbindung::zug_beginnen`]), und winit
    /// liefert unbeirrt weiter Zeigerereignisse. Dann ist nichts zu beenden —
    /// der Knopf liegt noch beim gewoehnlichen `MouseInput`-Weg, und ein
    /// gemeldetes Ende wuerde ihn dort mitten in der Geste freigeben.
    pub fn zug_aufgeben(&mut self) {
        self.zustand.eigener_zug = false;
        self.zustand.bestaetigt = false;
        self.zustand.ende = Zugende::default();
        self.zustand.zug = zug::ZugLage::default();
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
    use super::DruckNummer;

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
}
