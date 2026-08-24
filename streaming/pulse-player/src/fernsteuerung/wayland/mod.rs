//! Die Wayland-Gastverbindung fuer den Zug ueber die Fenstergrenze —
//! **Fundament, von niemandem aufgerufen** (s. `#![allow(dead_code)]` unten
//! und die Modulzeile in `fernsteuerung/mod.rs`). Waylands Datengeraet
//! beantwortet direkt, welches Fenster unter dem Zeiger liegt — auf einem
//! Compositor gibt es dafuer keine abfragbaren Fensterlagen wie unter X11
//! oder Windows. Was hier steht: die Verbindung, der Seat, ein eigener
//! zweiter Zeiger (liefert die Seriennummer, die `start_drag` verlangt) und
//! das Datengeraet. Das eigentliche `start_drag` und die Enter/Motion/Drop-
//! Auswertung sind eine spaetere Aufgabe.
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
//! - **Keine Flaeche wird rekonstruiert.** Die Vorlage braucht `wl_surface`,
//!   weil ein Inhibitor an eine bestimmte Flaeche gebunden wird. Dieses
//!   Fundament bindet nichts an eine Flaeche — das (Ursprungs-/Icon-Flaeche
//!   fuer `start_drag`) ist Sache der Aufgabe, die den Zug tatsaechlich
//!   ausloest.
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

// Noch nicht verdrahtet: nichts im Rest des Crates ruft `aufbauen` oder
// irgendeine Methode von `Gastverbindung` auf — das ist Sache einer
// spaeteren Aufgabe, die den Zug tatsaechlich ausloest. Faellt weg, sobald
// diese Aufgabe kommt.
#![allow(dead_code)]

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

/// Der Dispatch-Zustand. Traegt genau ein Datum ([`DruckNummer`]) — anders
/// als in [`crate::tastensperre::wayland`], wo `Zustand` leer ist (s.
/// Modulkopf, „Was anders ist").
#[derive(Default)]
struct Zustand {
    druck: DruckNummer,
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
// `event_created_child` unten).
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
    /// `Drop`/`Leave` entwerten die gemerkte Druck-Nummer (s. Modulkopf,
    /// „Die Nummer gilt nicht ueber einen Zug hinweg"). Alles andere
    /// (Enter/Motion/Selection/DataOffer) ist fuer dieses Fundament ohne
    /// Bedeutung — Fortschritt eines Zugs auszuwerten ist Sache der Aufgabe,
    /// die ihn tatsaechlich fuehrt.
    fn event(
        zustand: &mut Self,
        _: &wl_data_device::WlDataDevice,
        ereignis: wl_data_device::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match ereignis {
            wl_data_device::Event::Drop | wl_data_device::Event::Leave => {
                zustand.druck.entwerten();
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
/// alles, was der Zug ueber die Fenstergrenze auf Wayland braucht, aber noch
/// nichts, was ihn ausloest (s. Modulkopf).
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
    pub fn nachfassen(&mut self) {
        let _ = self.queue.dispatch_pending(&mut self.zustand);
    }

    /// Die Seriennummer des letzten Drucks — `None`, solange keiner
    /// stattfand oder die letzte Zugsitzung schon beendet ist (s. Modulkopf).
    pub fn letzte_druck_nummer(&self) -> Option<u32> {
        self.zustand.druck.aktuell()
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
