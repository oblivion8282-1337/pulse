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

mod ende;
mod verbindung;
mod zug;
mod zustand;

use std::time::Instant;

use wayland_client::globals::GlobalListContents;
use wayland_client::protocol::{
    wl_data_device, wl_data_device_manager, wl_data_offer,
    wl_pointer::{self, ButtonState},
    wl_registry, wl_seat,
};
use wayland_client::{
    delegate_noop, event_created_child, Connection, Dispatch, Proxy, QueueHandle, WEnum,
};

pub use verbindung::{aufbauen, Gastverbindung};
use zustand::{zug_ereignis, Zugereignis, Zustand};

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
    /// Erst danach die Auswertung UNSERES Zugs, und die steht nicht hier,
    /// sondern als reine Funktion in [`zustand`] ([`zug_ereignis`], samt
    /// Merker-Pruefung und Tests dazu). Diese Stelle uebersetzt nur noch
    /// wayland-eigene Typen in [`Zugereignis`].
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
        let uebersetzt = match ereignis {
            wl_data_device::Event::Enter { surface, x, y, .. } => {
                Some(Zugereignis::Betreten(surface.id(), x, y))
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
