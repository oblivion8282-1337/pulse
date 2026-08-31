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
//! der Merker `Zustand::eigener_zug`: die Zug-Auswertung laeuft nur, solange
//! ein EIGENER Zug angefordert ist. Was NICHT am Merker haengt, ist die
//! Angebots-Verwaltung — die verlangt das Protokoll fuer jeden Zug, auch fremde.
//! Die Abbildung „welches Ereignis darf was bewegen" steht als reine Funktion
//! in [`zustand`] und ist damit pruefbar, statt im `Dispatch`-Rumpf zu stehen
//! (Review M-4).
//!
//! **Aufgeteilt** (`PLAN.md` §12.1): hier stehen nur noch der Dispatch und
//! [`DruckNummer`]; die Verbindung samt Aufbau und Fristen in [`verbindung`],
//! der Zustand und die Ereignis-Abbildung in [`zustand`], `start_drag` und die
//! Zug-Lage in [`zug`], das Ende in [`ende`].
//!
//! **Ungeprueft bleibt alles, was eine echte Wayland-Sitzung braucht**
//! (Verbindungsaufbau, Registry, Binden, Dispatch). Geprueft ist die reine
//! Zustandsfuehrung ohne Wayland-Abhaengigkeit: [`DruckNummer`] hier,
//! `ende::Zugende`, `zug::ZugLage` und `zustand::zug_ereignis` daneben.

mod ablage;
mod ende;
mod verbindung;
mod zug;
mod zustand;

use std::time::Instant;

use wayland_client::globals::GlobalListContents;
use wayland_client::protocol::{
    wl_data_device, wl_data_device_manager, wl_data_offer, wl_data_source,
    wl_pointer::{self, ButtonState},
    wl_registry, wl_seat,
};
use wayland_client::{
    delegate_noop, event_created_child, Connection, Dispatch, Proxy, QueueHandle, WEnum,
};

pub use verbindung::{aufbauen, Gastverbindung};
pub use zustand::Zugschluss;
use zustand::{zug_ereignis, Zugereignis, Zustand};

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
/// **Ausgewertet wird genau EIN Ereignis: `offer`** — welche Mime-Typen ein
/// Angebot mitbringt. Die Zwischenablage braucht das, weil der
/// `offer`-Ereignisstrom VOR dem `selection` kommt, das sein Angebot benennt:
/// spaeter liesse sich nicht mehr feststellen, ob dort Text liegt, und jedes
/// `receive` auf ein Bild liefe in die volle Lesefrist (s.
/// [`ablage::AblageZustand::mime`]). Bis zum 2026-08-31 stand hier ein
/// `delegate_noop!(… ignore …)` — die Angebote wurden nur entgegengenommen.
///
/// Alles andere (`source_actions`, `action`) bleibt unausgewertet: es gehoert
/// zum ZIEHEN, und dessen Zugehoerigkeit entscheidet `zustand::zug_ereignis`.
///
/// **Zerstoert werden Angebote weiterhin nicht hier** (das waere die Reaktion
/// auf ihre eigenen Ereignisse), sondern im `wl_data_device`-Dispatch unten:
/// ein Zug-Angebot beim `Leave` seines Zugs, ein Auswahl-Angebot beim
/// naechsten `selection`.
impl Dispatch<wl_data_offer::WlDataOffer, ()> for Zustand {
    fn event(
        zustand: &mut Self,
        angebot: &wl_data_offer::WlDataOffer,
        ereignis: wl_data_offer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_data_offer::Event::Offer { mime_type } = ereignis {
            zustand.ablage.mime(angebot, &mime_type);
        }
    }
}

/// Unsere EIGENE Quelle, solange wir die Auswahl halten (s. [`ablage`]).
///
/// `send` ist der Kern des verzoegerten Renderns: es kommt erst, wenn jemand
/// tatsaechlich einfuegt. `cancelled` ist die einzige verlaessliche Meldung,
/// dass ein anderer Klient die Auswahl uebernommen hat.
///
/// Die uebrigen Ereignisse (`target`, `action`, `dnd_drop_performed`,
/// `dnd_finished`) gehoeren zum ZIEHEN mit einer eigenen Quelle — unser Zug
/// faehrt `source = NULL` und erzeugt sie nie.
impl Dispatch<wl_data_source::WlDataSource, ()> for Zustand {
    fn event(
        zustand: &mut Self,
        _: &wl_data_source::WlDataSource,
        ereignis: wl_data_source::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match ereignis {
            wl_data_source::Event::Send { fd, .. } => zustand.ablage.send(fd),
            wl_data_source::Event::Cancelled => zustand.ablage.abgeloest(),
            _ => {}
        }
    }
}

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
    /// Erst danach die Auswertung UNSERES Zugs, und die steht nicht hier,
    /// sondern als reine Funktion in [`zustand`] ([`zug_ereignis`], samt
    /// Merker-Pruefung und Tests dazu). Diese Stelle uebersetzt nur noch
    /// wayland-eigene Typen in [`Zugereignis`].
    ///
    /// **`Selection` gehoert seit dem 2026-08-31 der Zwischenablage** (s.
    /// [`ablage`]) und wird an [`ablage::AblageZustand::auswahl`] gereicht —
    /// hier stand bis dahin, sie sei nicht Sache dieses Moduls. `DataOffer`
    /// bleibt unausgewertet: das Kindobjekt entsteht ueber
    /// `event_created_child` unten, seine Mime-Typen kommen als eigene
    /// `offer`-Ereignisse am Angebot selbst an.
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
                    zustand.ablage.vergessen(&angebot);
                    angebot.destroy();
                }
            }
            // **Die Auswahl, nicht der Zug.** Sie kommt schon beim
            // Programmstart und danach bei jedem fremden Kopieren; sie
            // befuellt `Zustand::angebot` nie (s. dort).
            wl_data_device::Event::Selection { id } => zustand.ablage.auswahl(id.clone()),
            _ => {}
        }
        let uebersetzt = match ereignis {
            // **`id` wird hier NICHT weggeworfen** (Review I-2 der vierten
            // Runde): ob ein Angebot dranhaengt, ist die Zugehoerigkeit des
            // Zugs — unser eigener faehrt `source = NULL` und traegt nie eins
            // (gemessen, s. `zug`-Modulkopf). Vorher entschied allein der
            // Merker, und der sagt nur „haben wir gefragt".
            wl_data_device::Event::Enter { surface, x, y, ref id, .. } => {
                Some(Zugereignis::Betreten {
                    flaeche: surface.id(),
                    x,
                    y,
                    mit_angebot: id.is_some(),
                })
            }
            wl_data_device::Event::Motion { x, y, .. } => Some(Zugereignis::Bewegt(x, y)),
            wl_data_device::Event::Drop => Some(Zugereignis::Fallengelassen),
            wl_data_device::Event::Leave => Some(Zugereignis::Verlassen),
            _ => None,
        };
        if let Some(uebersetzt) = uebersetzt {
            zug_ereignis(zustand, uebersetzt, Instant::now());
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
