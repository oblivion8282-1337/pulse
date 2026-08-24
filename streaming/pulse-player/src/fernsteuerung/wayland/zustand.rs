//! Alles, was einen `nachfassen`-Aufruf ueberleben muss — und die beiden
//! Entscheidungen darauf, die ohne Compositor nachrechenbar sind:
//! **welche Datengeraet-Ereignisse den Zug-Zustand ueberhaupt bewegen duerfen**
//! ([`zug_ereignis`]) und **ob und warum ein Zug zu Ende ist** ([`zugschluss`]).
//!
//! **Warum das hier steht und nicht im `Dispatch`-Rumpf:** die erste Frage ist
//! der Kern von Review-Befund C-1 (2026-08-24) — das Datengeraet meldet
//! `Enter`/`Motion`/`Drop`/`Leave` auch fuer FREMDE Zuege, und die erste
//! Fassung liess sie damit dieselben Zaehler speisen wie den eigenen Zug. Im
//! `Dispatch` waere „ein fremder Zug speist [`Zugende`] nicht" eine Behauptung,
//! hier ist es ein Test (Review M-4).
//!
//! **Der Merker allein reichte dafuer nicht** (Review I-2 der vierten Runde):
//! `eigener_zug` beantwortet „haben WIR gefragt", nicht „ist DIESER Zug
//! unserer". Zwischen unserem `start_drag` und seinem ersten `Enter` steht er,
//! ohne dass ein Zug von uns laeuft — traf in diesem Fenster ein fremder Zug
//! ein, sprach er wieder fuer uns. Der Diskriminator steckt im Protokoll und
//! steht im Protokoll: unser eigener Zug faehrt `source = NULL`, sein `Enter`
//! traegt deshalb kein `wl_data_offer` — **gefolgert, und die Messung vom
//! 2026-08-24 deckt einen Compositor** (`Enter { … id: None }`, s.
//! [`super::zug`]-Modulkopf). Und der Zug eines FREMDEN Klienten mit
//! `source = NULL` erreicht uns gar nicht erst: solche Ereignisse gehen laut
//! Protokoll nur an den Klienten, der den Zug begonnen hat.
//!
//! **Die gefaehrliche Fehlrichtung ist die zweite.** „Mit Angebot" heisst
//! sicher „nicht unserer" — daran haengt kein Risiko. Haenge dagegen an einem
//! EIGENEN `Enter` je doch ein Angebot, gaelte unser Zug als fremd: er wuerde
//! nicht verfolgt, sein `Drop` fiele heraus, und die Maustaste bliebe am
//! fernen Rechner unten. Wer dieses Modul auf einen anderen Compositor bringt,
//! prueft zuerst das.

use std::time::{Duration, Instant};

use wayland_backend::sys::client::ObjectId;
use wayland_client::protocol::wl_data_offer;

use super::ende::Zugende;
use super::zug::ZugLage;

/// Wie lange ein ANGEFORDERTER, aber nie bestaetigter Zug den Merker halten
/// darf, bevor er verfaellt.
///
/// **Wozu das noetig ist** (Review C-B): `eigener_zug` hatte nur zwei
/// Ausgaenge — ein abgeholtes Ende und das ausdrueckliche Aufgeben beim
/// Loslassen. Wer zwischen Druck und Loslassen den Fokus verliert oder das
/// Fenster schliesst, sah beides nie; der Merker blieb fuer den Rest der
/// Prozesslaufzeit stehen, und ab da sprach jeder fremde Zug wieder fuer uns.
/// Die drei bekannten Wege raeumt `app::wayland_zug` ausdruecklich auf; diese
/// Frist ist der Guertel dazu, fuer den Weg, den niemand vorhergesehen hat —
/// und fuer einen Compositor, der `start_drag` ergreift, ohne je ein `Enter`
/// zu schicken (gemessen haben wir EINEN Compositor).
///
/// **Sie misst STILLE, nicht Zeit** (Review I-1 der vierten Runde). Die Uhr
/// wird bei jedem winit-Zeigerereignis neu gestellt
/// (`Gastverbindung::anlauf_bezeugen`), denn ein solches Ereignis ist der
/// Beweis, dass der Compositor gerade NICHT ergriffen hat — derselbe Beweis,
/// auf dem der ganze Rest dieses Moduls steht. Ohne das mass sie „seit
/// `start_drag`" und lief auch dann ab, wenn laufend bewiesen wurde, dass der
/// Merker nicht verwaist ist.
///
/// **Warum sie trotzdem lang ist.** Zwischen `start_drag` und dem ersten
/// `Enter` liegt kein Round-Trip, sondern die erste Zeigerbewegung des Nutzers
/// (gemessen 2026-08-24: 427 ms, weil so lange nicht bewegt wurde). Wer
/// drueckt und in Ruhe ueberlegt, bevor er zieht, haelt einen voellig gesunden
/// Zug unbestaetigt — und solange er den Zeiger dabei WIRKLICH stillhaelt,
/// kommt auch kein winit-Ereignis, das die Uhr neu stellt. Verfaellt der
/// Merker zu frueh und der Nutzer zieht DANN los, laeuft der Zug im Compositor
/// weiter, waehrend wir ihn nicht mehr verfolgen: seine Bewegungen gehen
/// verloren und sein `Drop` ebenso.
///
/// **Verfallen heisst AUFGEBEN, nicht Beenden.** Ein Ende wuerde alles
/// Gedrueckte freigeben — und wenn der Nutzer die Taste in diesem Moment
/// wirklich haelt, waere das der schlimmste Ausgang dieses Vorhabens.
///
/// **Was danach mit einer wirklich noch gehaltenen Taste geschieht, ist
/// ungesichert** — hier stand bis zum 2026-08-25 „die ein anderer Weg noch
/// loest", ohne diesen Weg zu nennen oder zu haben. Ehrlich ist: es gibt vier
/// Stellen, an denen sie noch hochgeht — Fokusverlust
/// (`Erfassung::alles_loslassen`), Erfassung aus (`ausschalten`), Fenster zu
/// (`eingabe_raeumen`) und das Ende des naechsten Zugs (`zug_beendet` gibt
/// ALLES Gedrueckte frei) —, aber keine davon ist zugesichert, und keine
/// kommt zu einer bestimmten Zeit. Der Fall setzt allerdings voraus, dass der
/// Compositor ergriffen hat, ohne je ein `Enter` zu schicken, und dass der
/// Nutzer dabei 30 s lang den Zeiger stillhaelt.
pub(super) const ANLAUFFRIST: Duration = Duration::from_secs(30);

/// Die reine Zustandsfuehrung hinter
/// [`super::Gastverbindung::letzte_druck_nummer`]: welche Wayland-Seriennummer
/// gerade als „zuletzter Druck" gilt.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct DruckNummer(Option<u32>);

impl DruckNummer {
    /// Ein `wl_pointer.button`-Ereignis mit `state == Pressed` ist eingetroffen.
    pub(super) fn druecken(&mut self, seriennummer: u32) {
        self.0 = Some(seriennummer);
    }

    /// Die Zugsitzung ist vorbei (`Drop`/`Leave`) — die zugehoerige implizite
    /// Ergreifung existiert nicht mehr, ein erneuter `start_drag` mit dieser
    /// Nummer griffe ins Leere.
    fn entwerten(&mut self) {
        self.0 = None;
    }

    pub(super) fn aktuell(&self) -> Option<u32> {
        self.0
    }
}

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
    /// EREIGNISGETRIEBEN, ob/wie sicher der Zug zuende ist (s. [`super::ende`]).
    pub(super) ende: Zugende,
    /// **Haben WIR einen Zug angefordert?** Gesetzt von
    /// [`super::Gastverbindung::zug_beginnen`], sobald `start_drag`
    /// hinausgegangen ist; geraeumt allein vom Abbau
    /// ([`super::Gastverbindung::zug_aufgeben`], den `app::wayland_zug` durch
    /// EINEN Trichter ruft). Nur solange er steht, speisen die
    /// Datengeraet-Ereignisse ueberhaupt etwas (s. [`zug_ereignis`]).
    ///
    /// **„Angefordert" ist nicht „laeuft" und nicht „gehoert uns".**
    /// `start_drag` ist eine Feuer-und-vergessen-Anfrage ohne Antwort; passt
    /// die Seriennummer nicht zum Sitzplatz, verwirft der Compositor sie still.
    /// Deshalb daneben zwei weitere Felder — `bestaetigt` und, fuer die
    /// Zugehoerigkeit, [`Zustand::fremder_zug`].
    pub(super) eigener_zug: bool,
    /// **Laeuft er wirklich?** Wird beim ersten `Enter` DIESES Zugs gesetzt.
    /// Vorher ist alles, was winit noch an Zeigerereignissen liefert,
    /// mehrdeutig (es koennen Ereignisse sein, die der Compositor schon vor
    /// unserem `start_drag` abgeschickt hatte); danach ist ein
    /// winit-Zeigerereignis der BEWEIS, dass der Griff vorbei ist (s.
    /// [`super::ende`]-Modulkopf).
    ///
    /// Gemessen dazu: das erste `Enter` kommt NICHT mit `start_drag`, sondern
    /// erst mit der ersten Zeigerbewegung danach (427 ms im Messlauf).
    pub(super) bestaetigt: bool,
    /// **Laeuft gerade ein FREMDER Zug ueber unsere Flaechen?** Gesetzt vom
    /// `Enter` mit Angebot, geraeumt von dessen `Leave` (s. Modulkopf). Solange
    /// er steht, bewegt kein Datengeraet-Ereignis den Zug-Zustand — auch nicht
    /// `Motion`/`Drop`/`Leave`, die selbst kein Angebot mitfuehren und ohne
    /// dieses Gedaechtnis nicht zuzuordnen waeren.
    pub(super) fremder_zug: bool,
    /// Seit wann zuletzt bewiesen war, dass der angeforderte Zug noch nicht
    /// laeuft — Grundlage der [`ANLAUFFRIST`]. `None`, sobald er bestaetigt
    /// oder abgeraeumt ist.
    pub(super) angefordert_seit: Option<Instant>,
    /// Muss beim `Leave` zerstoert werden, das verlangt das Protokoll
    /// ausdruecklich. **Haengt bewusst NICHT am Merker `eigener_zug`**: bei
    /// unserem eigenen Zug ist es ohnehin immer `None`, belegt wird es also nur
    /// von FREMDEN Zuegen — und genau die muessen aufgeraeumt werden.
    /// `Selection` (die Zwischenablage) befuellt es nie.
    pub(super) angebot: Option<wl_data_offer::WlDataOffer>,
}

/// Ein Datengeraet-Ereignis, so weit fuer den Zug bedeutsam — ohne
/// Wayland-Typen ausser der blossen Flaechen-Kennung, damit [`zug_ereignis`]
/// ohne Compositor pruefbar bleibt.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Zugereignis {
    /// `Enter` — Flaeche, flaechenlokale Startlage, und ob ein `wl_data_offer`
    /// dranhing. **Letzteres ist die Zugehoerigkeit** (s. Modulkopf): mit
    /// Angebot heisst „fremder Zug".
    Betreten { flaeche: ObjectId, x: f64, y: f64, mit_angebot: bool },
    /// `Motion` — nur die Lage.
    Bewegt(f64, f64),
    /// `Drop`.
    Fallengelassen,
    /// `Leave`.
    Verlassen,
}

/// Wie ein Zug zu Ende gegangen ist — das Ergebnis von [`zugschluss`] und
/// damit die einzige Auskunft, die `app::wayland_zug` fuer seinen Abbau
/// braucht.
///
/// Beide Enden schliessen sich aus: die [`ANLAUFFRIST`] laeuft nur, solange
/// gar kein Ende steht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zugschluss {
    /// Nichts zu tun — es laeuft kein Zug, oder er laeuft weiter.
    Offen,
    /// Der Zug ist vorbei: `Drop`, Beweisweg oder [`super::ende::NOTFRIST`].
    /// **Freigeben.** `notfrist` sagt, ob es die Frist war — der einzige der
    /// drei Wege, der einen gesunden Zug zerreissen kann und deshalb ins Log
    /// gehoert (Review I-1).
    Beendet { notfrist: bool },
    /// Der angeforderte Zug ist nie angelaufen ([`ANLAUFFRIST`]).
    /// **Aufgeben, nicht freigeben.**
    Verfallen,
}

/// Ein Datengeraet-Ereignis auf den Zustand anwenden — **nur, wenn es zum
/// EIGENEN Zug gehoert**.
///
/// Zwei Bedingungen, und beide sind ein Review-Befund: der Merker
/// ([`Zustand::eigener_zug`], C-1) und die Zugehoerigkeit
/// ([`Zustand::fremder_zug`], I-2 der vierten Runde). Ohne sie hinterliess ein
/// fremder Zug ueber einem Player-Fenster ein `Beendet`, das der naechste
/// eigene Zug als sein eigenes Ende deutete — die gerade gedrueckte Maustaste
/// ging am fernen Rechner sofort wieder hoch; und sein `Motion` schickte den
/// FERNEN Zeiger dorthin, wo ein Fremder gerade eine Datei zieht.
pub(super) fn zug_ereignis(zustand: &mut Zustand, ereignis: Zugereignis, jetzt: Instant) {
    // Die Zugehoerigkeit steht nur am `Enter`; `Motion`/`Drop`/`Leave` tragen
    // sie nicht, deshalb wird sie gemerkt.
    if let Zugereignis::Betreten { mit_angebot, .. } = &ereignis {
        zustand.fremder_zug = *mit_angebot;
    }
    let fremd = zustand.fremder_zug;
    // Mit dem `Leave` ist die Zugsitzung des Datengeraets vorbei — die naechste
    // faengt beim `Enter` wieder von vorne an.
    if matches!(ereignis, Zugereignis::Verlassen) {
        zustand.fremder_zug = false;
    }
    if !zustand.eigener_zug || fremd {
        return;
    }
    match ereignis {
        Zugereignis::Betreten { flaeche, x, y, .. } => {
            zustand.zug.betreten(flaeche, x, y);
            zustand.ende.betreten();
            zustand.bestaetigt = true;
            // Der Anlauf ist geschafft — ab jetzt laeuft der Zug nachweislich,
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

/// Ist der Zug zu Ende — und warum?
///
/// **Nur [`Zugschluss::Beendet`] ist konsumierend** (wie das [`Zugende`]
/// darunter): ein zweiter Aufruf ohne neues Ende liefert wieder
/// [`Zugschluss::Offen`]. **[`Zugschluss::Verfallen`] ist es NICHT** — es ist
/// keine Flanke, sondern ein Dauerzustand („angefordert, unbestaetigt, seit
/// zu lange"), und aufgeloest wird er allein vom Abbau. Wer ihn ignoriert,
/// bekommt ihn bei jedem Aufruf erneut, samt Log-Zeile aus
/// [`super::Gastverbindung::nachfassen`]. Beides ist so gewollt: ein
/// verschlucktes Ende laesst eine Taste unten, ein verschluckter Verfall nur
/// ein Log volllaufen.
///
/// **Das Ende wird IMMER abgeholt, auch ohne eigenen Merker** (Review C-1): ein
/// `Beendet`, das liegenbliebe, waere die Ladung fuer den naechsten Zug.
pub(super) fn zugschluss(zustand: &mut Zustand, jetzt: Instant) -> Zugschluss {
    let notfrist = zustand.ende.frist_pruefen(jetzt);
    if zustand.ende.konsumiere_beendet() {
        return Zugschluss::Beendet { notfrist };
    }
    if anlauf_verfallen(zustand, jetzt) {
        return Zugschluss::Verfallen;
    }
    Zugschluss::Offen
}

/// Ist ein angeforderter Zug ueber die [`ANLAUFFRIST`] hinaus unbestaetigt
/// geblieben?
///
/// Ein bereits stehendes Ende hat Vorrang — es wird abgeholt, nicht
/// weggeraeumt. Deshalb die Bedingung auf [`Zugende::Keins`]: sonst koennte ein
/// Verfallen ein `Unklar` verschlucken, das gleich noch zu einem `Beendet`
/// geworden waere, und die Freigabe bliebe aus.
fn anlauf_verfallen(zustand: &Zustand, jetzt: Instant) -> bool {
    if !zustand.eigener_zug || zustand.bestaetigt || zustand.ende != Zugende::Keins {
        return false;
    }
    zustand
        .angefordert_seit
        .is_some_and(|seit| jetzt.saturating_duration_since(seit) >= ANLAUFFRIST)
}

#[cfg(test)]
mod tests {
    use super::{
        anlauf_verfallen, zug_ereignis, zugschluss, DruckNummer, Zugende, Zugereignis, Zugschluss,
        Zustand, ANLAUFFRIST,
    };
    use std::time::{Duration, Instant};
    use wayland_backend::sys::client::ObjectId;

    /// Steht fuer „irgendeine Flaeche" — echte Kennungen entstehen nur ueber
    /// eine lebende Verbindung (dieselbe Begruendung wie in `zug`s Tests).
    fn flaeche() -> ObjectId {
        ObjectId::null()
    }

    fn eigenes_enter() -> Zugereignis {
        Zugereignis::Betreten { flaeche: flaeche(), x: 1.0, y: 2.0, mit_angebot: false }
    }

    fn fremdes_enter() -> Zugereignis {
        Zugereignis::Betreten { flaeche: flaeche(), x: 1.0, y: 2.0, mit_angebot: true }
    }

    fn eigener() -> Zustand {
        Zustand { eigener_zug: true, ..Default::default() }
    }

    /// **Der Test, den Review M-4 verlangt hat, und der C-1 gefangen haette:**
    /// ohne gesetzten Merker darf KEIN Datengeraet-Ereignis den Zug-Zustand
    /// bewegen.
    #[test]
    fn ohne_merker_speist_kein_ereignis_etwas() {
        let jetzt = Instant::now();
        let mut z = Zustand::default(); // eigener_zug = false
        zug_ereignis(&mut z, eigenes_enter(), jetzt);
        zug_ereignis(&mut z, Zugereignis::Bewegt(3.0, 4.0), jetzt);
        zug_ereignis(&mut z, Zugereignis::Fallengelassen, jetzt);
        zug_ereignis(&mut z, Zugereignis::Verlassen, jetzt);
        assert_eq!(z.ende, Zugende::Keins, "kein Ende");
        assert_eq!(z.zug.aktuell(), None, "keine Lage");
        assert!(!z.bestaetigt);
    }

    /// **Der Fall, den der Merker allein NICHT abdeckte** (Review I-2 der
    /// vierten Runde): der Merker steht (wir haben gefragt), aber der Zug, der
    /// eintrifft, ist ein FREMDER — er traegt ein Angebot. Weder sein `Enter`
    /// noch sein `Motion` oder sein `Leave` duerfen etwas bewegen; sonst
    /// erzeugt sein `Leave` ein `Unklar`, die Notfrist macht ein `Beendet`
    /// daraus, und der Knopf des Nutzers geht am fernen Rechner hoch, waehrend
    /// er ihn haelt.
    #[test]
    fn ein_fremder_zug_speist_nichts_auch_mit_gesetztem_merker() {
        let jetzt = Instant::now();
        let mut z = eigener();
        zug_ereignis(&mut z, fremdes_enter(), jetzt);
        assert!(!z.bestaetigt, "ein fremdes Enter bestaetigt unseren Zug nicht");
        assert_eq!(z.zug.aktuell(), None, "und speist die Lage nicht");
        zug_ereignis(&mut z, Zugereignis::Bewegt(3.0, 4.0), jetzt);
        assert_eq!(z.zug.aktuell(), None, "auch sein Motion nicht");
        zug_ereignis(&mut z, Zugereignis::Verlassen, jetzt);
        assert_eq!(z.ende, Zugende::Keins, "und sein Leave macht kein Ende daraus");
    }

    /// Nach dem `Leave` des fremden Zugs ist die Zugehoerigkeit wieder offen —
    /// sonst bliebe der naechste EIGENE Zug fuer immer ausgesperrt.
    #[test]
    fn nach_dem_fremden_leave_zaehlt_der_eigene_zug_wieder() {
        let jetzt = Instant::now();
        let mut z = eigener();
        zug_ereignis(&mut z, fremdes_enter(), jetzt);
        zug_ereignis(&mut z, Zugereignis::Verlassen, jetzt);
        zug_ereignis(&mut z, eigenes_enter(), jetzt);
        assert!(z.bestaetigt);
        assert_eq!(z.zug.aktuell(), Some((flaeche(), 1.0, 2.0)));
    }

    /// Die Gegenprobe zu beiden Toren: mit Merker und ohne Angebot laeuft die
    /// ganze Folge durch. Ohne sie liessen sich die Tests oben auch mit einer
    /// Abbildung gruen halten, die gar nichts tut.
    #[test]
    fn der_eigene_zug_speist_alles() {
        let jetzt = Instant::now();
        let mut z = eigener();
        zug_ereignis(&mut z, eigenes_enter(), jetzt);
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
        zug_ereignis(&mut z, eigenes_enter(), jetzt);
        zug_ereignis(&mut z, Zugereignis::Verlassen, jetzt);
        assert_eq!(z.zug.aktuell(), None);
        assert_eq!(z.ende, Zugende::Unklar(jetzt));
    }

    #[test]
    fn das_erste_enter_loescht_die_anlauf_frist() {
        let jetzt = Instant::now();
        let mut z =
            Zustand { eigener_zug: true, angefordert_seit: Some(jetzt), ..Default::default() };
        zug_ereignis(&mut z, eigenes_enter(), jetzt);
        assert_eq!(z.angefordert_seit, None);
    }

    /// Und ein FREMDES `Enter` darf sie nicht loeschen — sonst haelt sich ein
    /// stehengebliebener Merker ueber jeden fremden Zug am Leben.
    #[test]
    fn ein_fremdes_enter_loescht_die_anlauf_frist_nicht() {
        let jetzt = Instant::now();
        let mut z =
            Zustand { eigener_zug: true, angefordert_seit: Some(jetzt), ..Default::default() };
        zug_ereignis(&mut z, fremdes_enter(), jetzt);
        assert_eq!(z.angefordert_seit, Some(jetzt));
    }

    // ── DruckNummer (aus `mod.rs` mitgezogen, Review M-5) ───────────────

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

    // ── Der Schluss: Ende, Verfall, oder nichts ─────────────────────────

    #[test]
    fn ohne_alles_ist_der_schluss_offen() {
        let jetzt = Instant::now();
        assert_eq!(zugschluss(&mut Zustand::default(), jetzt), Zugschluss::Offen);
    }

    #[test]
    fn ein_drop_ergibt_beendet_ohne_notfrist() {
        let jetzt = Instant::now();
        let mut z = eigener();
        zug_ereignis(&mut z, eigenes_enter(), jetzt);
        zug_ereignis(&mut z, Zugereignis::Fallengelassen, jetzt);
        assert_eq!(zugschluss(&mut z, jetzt), Zugschluss::Beendet { notfrist: false });
        assert_eq!(zugschluss(&mut z, jetzt), Zugschluss::Offen, "konsumierend");
    }

    /// Die Notfrist meldet sich als solche — daran haengt die einzige
    /// Log-Zeile der drei Ende-Wege (Review I-1).
    #[test]
    fn die_abgelaufene_notfrist_ergibt_beendet_mit_notfrist() {
        let jetzt = Instant::now();
        let mut z = eigener();
        zug_ereignis(&mut z, eigenes_enter(), jetzt);
        zug_ereignis(&mut z, Zugereignis::Verlassen, jetzt);
        let spaeter = jetzt + super::super::ende::NOTFRIST;
        assert_eq!(zugschluss(&mut z, spaeter), Zugschluss::Beendet { notfrist: true });
    }

    /// **Der Verfall, erstmals geprueft** (Review M-4 der vierten Runde): ein
    /// angeforderter, nie bestaetigter Zug verfaellt nach der Frist — und
    /// vorher nicht.
    #[test]
    fn ein_nie_bestaetigter_zug_verfaellt_erst_nach_der_frist() {
        let jetzt = Instant::now();
        let mut z =
            Zustand { eigener_zug: true, angefordert_seit: Some(jetzt), ..Default::default() };
        assert_eq!(
            zugschluss(&mut z, jetzt + ANLAUFFRIST - Duration::from_millis(1)),
            Zugschluss::Offen
        );
        assert_eq!(zugschluss(&mut z, jetzt + ANLAUFFRIST), Zugschluss::Verfallen);
    }

    /// Ein bestaetigter Zug verfaellt nie — er laeuft ja nachweislich.
    #[test]
    fn ein_bestaetigter_zug_verfaellt_nicht() {
        let jetzt = Instant::now();
        let z = Zustand {
            eigener_zug: true,
            bestaetigt: true,
            angefordert_seit: Some(jetzt),
            ..Default::default()
        };
        assert!(!anlauf_verfallen(&z, jetzt + ANLAUFFRIST * 10));
    }

    /// **Ende schlaegt Verfall.** Steht schon ein `Unklar`, darf der Verfall
    /// nicht dazwischenfunken — sonst verschluckt er das `Beendet`, das die
    /// Notfrist gleich daraus gemacht haette, und die Freigabe bliebe aus.
    #[test]
    fn ein_offenes_ende_schliesst_den_verfall_aus() {
        let jetzt = Instant::now();
        let mut z =
            Zustand { eigener_zug: true, angefordert_seit: Some(jetzt), ..Default::default() };
        z.ende.verlassen(jetzt);
        assert!(!anlauf_verfallen(&z, jetzt + ANLAUFFRIST * 10));
        assert_eq!(
            zugschluss(&mut z, jetzt + ANLAUFFRIST * 10),
            Zugschluss::Beendet { notfrist: true },
            "es endet ueber die Notfrist, nicht ueber den Verfall"
        );
    }

    /// Ohne Merker gibt es nichts zu verfallen.
    #[test]
    fn ohne_merker_kein_verfall() {
        let jetzt = Instant::now();
        let z = Zustand { angefordert_seit: Some(jetzt), ..Default::default() };
        assert!(!anlauf_verfallen(&z, jetzt + ANLAUFFRIST * 10));
    }
}
