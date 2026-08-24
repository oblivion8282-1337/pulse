//! Der Dispatch-Zustand — und die eine Stelle, die entscheidet, WELCHE
//! Datengeraet-Ereignisse ihn ueberhaupt speisen duerfen.
//!
//! **Diese Abbildung ist der Kern von Review-Befund C-1** (2026-08-24): das
//! Datengeraet meldet `Enter`/`Motion`/`Drop`/`Leave` auch fuer FREMDE Zuege —
//! jemand zieht eine Datei aus dem Dateimanager ueber ein Player-Fenster —, und
//! die erste Fassung liess sie damit dieselben Zaehler speisen wie den eigenen
//! Zug. Deshalb steht sie hier als reine Funktion ([`zug_ereignis`]) und nicht
//! im `Dispatch`-Rumpf: dort waere „ein fremder Zug speist [`Zugende`] nicht"
//! eine Behauptung, hier ist es ein Test (Review M-4 der zweiten Runde — die
//! Fassung davor hatte nur die FOLGE der Entscheidung geprueft, nicht die
//! Bedingung).
//!
//! Der `Dispatch` daneben ([`super`]) uebersetzt nur noch die
//! wayland-eigenen Typen in [`Zugereignis`] und kuemmert sich um das, was am
//! Merker vorbei laufen MUSS: das `wl_data_offer` eines fremden Zugs.

use std::time::Instant;

use wayland_backend::sys::client::ObjectId;
use wayland_client::protocol::wl_data_offer;

use super::ende::Zugende;
use super::zug::ZugLage;
use super::DruckNummer;

/// Der Dispatch-Zustand. Anders als in [`crate::tastensperre::wayland`], wo
/// `Zustand` leer ist (s. [`super`]-Modulkopf, „Was anders ist"), traegt er
/// hier alles, was einen Aufruf von `nachfassen` ueberleben muss.
#[derive(Default)]
pub(super) struct Zustand {
    /// Die zuletzt gedrueckte Seriennummer.
    pub(super) druck: DruckNummer,
    /// Welche eigene Flaeche der Zeiger waehrend eines laufenden Zugs beruehrt
    /// und wo darin (s. [`super::zug`]).
    pub(super) zug: ZugLage,
    /// EREIGNISGETRIEBEN, ob/wie sicher der Zug zuende ist (s. [`super::ende`],
    /// Review-Befunde C2/I3).
    pub(super) ende: Zugende,
    /// **Haben WIR einen Zug angefordert?** Gesetzt von
    /// [`super::Gastverbindung::zug_beginnen`], sobald `start_drag`
    /// hinausgegangen ist; geloescht, sobald das Ende abgeholt oder der Zug
    /// aufgegeben wurde. Nur solange er steht, speisen die
    /// Datengeraet-Ereignisse die Zug-Auswertung (s. [`zug_ereignis`]) — ohne
    /// ihn spricht ein fremder Zug fuer uns (Review C-1).
    ///
    /// **„Angefordert" ist nicht „laeuft".** `start_drag` ist eine
    /// Feuer-und-vergessen-Anfrage ohne Antwort; passt die Seriennummer nicht
    /// zum Sitzplatz, verwirft der Compositor sie still. Deshalb daneben:
    pub(super) eigener_zug: bool,
    /// **Laeuft er wirklich?** Wird beim ersten `Enter` DIESES Zugs gesetzt.
    /// Vorher ist alles, was winit noch an Zeigerereignissen liefert,
    /// mehrdeutig (es koennen Ereignisse sein, die der Compositor schon vor
    /// unserem `start_drag` abgeschickt hatte); danach ist ein
    /// winit-Zeigerereignis der BEWEIS, dass der Griff vorbei ist (s.
    /// [`super::ende`]-Modulkopf, Messung 2026-08-24: waehrend des ganzen Zugs
    /// kam kein einziges `wl_pointer`-Ereignis).
    ///
    /// Gemessen dazu: das erste `Enter` kommt NICHT mit `start_drag`, sondern
    /// erst mit der ersten Zeigerbewegung danach (427 ms im Messlauf, weil so
    /// lange nicht bewegt wurde).
    pub(super) bestaetigt: bool,
    /// Seit wann der Zug angefordert ist, solange er unbestaetigt bleibt —
    /// Grundlage der Anlauf-Frist (s. [`super::Gastverbindung::nachfassen`],
    /// Review C-B). `None`, sobald er bestaetigt oder abgeraeumt ist.
    pub(super) angefordert_seit: Option<Instant>,
    /// Muss beim `Leave` zerstoert werden, das verlangt das Protokoll
    /// ausdruecklich. **Haengt bewusst NICHT am Merker `eigener_zug`**: bei
    /// unserem eigenen Zug (`source = None`) ist es ohnehin immer `None` (s.
    /// [`super::zug`]-Modulkopf), belegt wird es also nur von FREMDEN Zuegen —
    /// und genau die muessen aufgeraeumt werden. `Selection` (die
    /// Zwischenablage) befuellt es nie.
    pub(super) angebot: Option<wl_data_offer::WlDataOffer>,
}

/// Ein Datengeraet-Ereignis, so weit fuer den Zug bedeutsam — ohne
/// Wayland-Typen ausser der blossen Flaechen-Kennung, damit [`zug_ereignis`]
/// ohne Compositor pruefbar bleibt.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Zugereignis {
    /// `Enter` — Flaeche und flaechenlokale Startlage.
    Betreten(ObjectId, f64, f64),
    /// `Motion` — nur die Lage.
    Bewegt(f64, f64),
    /// `Drop`.
    Fallengelassen,
    /// `Leave`.
    Verlassen,
}

/// Ein Datengeraet-Ereignis auf den Zustand anwenden — **nur, wenn es zum
/// EIGENEN Zug gehoert**.
///
/// Die Bedingung ist eine einzige Zeile und trotzdem der ganze C-1-Fix: ohne
/// sie hinterliess ein fremder Zug ueber einem Player-Fenster ein `Beendet`,
/// das der naechste eigene Zug abholte und als sein eigenes Ende deutete — die
/// gerade gedrueckte Maustaste ging am fernen Rechner sofort wieder hoch.
/// Zusaetzlich wuerde ein fremder `Motion` [`ZugLage`] speisen und damit den
/// FERNEN Zeiger dorthin schicken, wo ein Fremder gerade eine Datei zieht.
pub(super) fn zug_ereignis(zustand: &mut Zustand, ereignis: Zugereignis, jetzt: Instant) {
    if !zustand.eigener_zug {
        return;
    }
    match ereignis {
        Zugereignis::Betreten(flaeche, x, y) => {
            zustand.zug.betreten(flaeche, x, y);
            zustand.ende.betreten();
            zustand.bestaetigt = true;
            // Der Anlauf ist geschafft — ab jetzt zaehlt der Zug als laufend,
            // und die Frist darauf hat ihren Zweck erfuellt.
            zustand.angefordert_seit = None;
        }
        Zugereignis::Bewegt(x, y) => zustand.zug.bewegt(x, y),
        Zugereignis::Fallengelassen => {
            zustand.druck.entwerten();
            zustand.zug.verlassen();
            zustand.ende.fallengelassen();
        }
        Zugereignis::Verlassen => {
            zustand.druck.entwerten();
            zustand.zug.verlassen();
            zustand.ende.verlassen(jetzt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{zug_ereignis, Zugereignis, Zustand};
    use super::Zugende;
    use std::time::Instant;
    use wayland_backend::sys::client::ObjectId;

    /// Steht fuer „irgendeine Flaeche" — echte Kennungen entstehen nur ueber
    /// eine lebende Verbindung (dieselbe Begruendung wie in `zug`s Tests).
    fn flaeche() -> ObjectId {
        ObjectId::null()
    }

    fn eigener() -> Zustand {
        Zustand { eigener_zug: true, ..Default::default() }
    }

    /// **Der Test, den Review M-4 verlangt hat, und der C-1 gefangen haette:**
    /// ohne gesetzten Merker darf KEIN Datengeraet-Ereignis den Zug-Zustand
    /// bewegen — sonst spricht ein fremder Zug fuer uns.
    #[test]
    fn ein_fremder_zug_speist_weder_ende_noch_lage() {
        let jetzt = Instant::now();
        let mut z = Zustand::default(); // eigener_zug = false
        zug_ereignis(&mut z, Zugereignis::Betreten(flaeche(), 1.0, 2.0), jetzt);
        zug_ereignis(&mut z, Zugereignis::Bewegt(3.0, 4.0), jetzt);
        zug_ereignis(&mut z, Zugereignis::Fallengelassen, jetzt);
        zug_ereignis(&mut z, Zugereignis::Verlassen, jetzt);
        assert_eq!(z.ende, Zugende::Keins, "ein fremder Zug hinterlaesst kein Ende");
        assert_eq!(z.zug.aktuell(), None, "und keine Lage");
        assert!(!z.bestaetigt, "und bestaetigt keinen Zug");
    }

    /// Die Gegenprobe: mit gesetztem Merker laeuft dieselbe Folge vollstaendig
    /// durch. Ohne sie liesse sich der Test oben auch mit einer kaputten
    /// Abbildung gruen halten.
    #[test]
    fn der_eigene_zug_speist_alles() {
        let jetzt = Instant::now();
        let mut z = eigener();
        zug_ereignis(&mut z, Zugereignis::Betreten(flaeche(), 1.0, 2.0), jetzt);
        assert!(z.bestaetigt, "das erste Enter bestaetigt den Zug");
        assert_eq!(z.zug.aktuell(), Some((flaeche(), 1.0, 2.0)));
        zug_ereignis(&mut z, Zugereignis::Bewegt(3.0, 4.0), jetzt);
        assert_eq!(z.zug.aktuell(), Some((flaeche(), 3.0, 4.0)));
        zug_ereignis(&mut z, Zugereignis::Fallengelassen, jetzt);
        assert_eq!(z.ende, Zugende::Beendet);
        assert_eq!(z.zug.aktuell(), None, "das Drop raeumt die Lage");
    }

    /// Ein `Leave` des eigenen Zugs ist noch kein Ende (s. `ende`), aber es
    /// raeumt die Lage — sonst schickte die naechste Abtastung den fernen
    /// Zeiger auf eine Flaeche, die er laengst verlassen hat.
    #[test]
    fn ein_leave_raeumt_die_lage_und_macht_das_ende_unklar() {
        let jetzt = Instant::now();
        let mut z = eigener();
        zug_ereignis(&mut z, Zugereignis::Betreten(flaeche(), 1.0, 2.0), jetzt);
        zug_ereignis(&mut z, Zugereignis::Verlassen, jetzt);
        assert_eq!(z.zug.aktuell(), None);
        assert_eq!(z.ende, Zugende::Unklar(jetzt));
    }

    /// Das erste `Enter` beendet die Anlauf-Frist (Review C-B): ab dann laeuft
    /// der Zug nachweislich, und ein Verfallen waere falsch.
    #[test]
    fn das_erste_enter_loescht_die_anlauf_frist() {
        let jetzt = Instant::now();
        let mut z =
            Zustand { eigener_zug: true, angefordert_seit: Some(jetzt), ..Default::default() };
        zug_ereignis(&mut z, Zugereignis::Betreten(flaeche(), 0.0, 0.0), jetzt);
        assert_eq!(z.angefordert_seit, None);
    }

    /// Und ein FREMDER Zug darf sie nicht loeschen — sonst haelt sich ein
    /// stehengebliebener Merker ueber jeden fremden Zug am Leben, statt zu
    /// verfallen.
    #[test]
    fn ein_fremdes_enter_loescht_die_anlauf_frist_nicht() {
        let jetzt = Instant::now();
        let mut z = Zustand { angefordert_seit: Some(jetzt), ..Default::default() };
        zug_ereignis(&mut z, Zugereignis::Betreten(flaeche(), 0.0, 0.0), jetzt);
        assert_eq!(z.angefordert_seit, Some(jetzt));
    }
}
