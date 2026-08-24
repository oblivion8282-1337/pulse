//! Den Zug ueber die Fenstergrenze beginnen und auswerten, auf dem Fundament
//! aus [`super`]. Zwei Teile, bewusst getrennt:
//!
//! - [`ZugLage`] — reine Zustandsfuehrung (welche eigene Flaeche der Zeiger
//!   waehrend eines laufenden Zugs beruehrt, und wo darin), ohne jede
//!   Wayland-Abhaengigkeit ausser dem blossen Identitaetswert [`ObjectId`].
//!   Genau wie [`super::DruckNummer`] deshalb ohne Compositor testbar (s.
//!   Tests unten).
//! - `impl Gastverbindung` — der Wayland-Teil: `start_drag` ausloesen und die
//!   Flaeche aus dem rohen Fenster-Zeiger rekonstruieren. Ungeprueft, aus
//!   demselben Grund wie beim Fundament (s. dortiger Modulkopf).
//!
//! **Die entscheidende Wahl ist `source = None`.** Im Protokoll ausdruecklich
//! gedeckt: "If source is NULL, enter, leave and motion events are sent only
//! to the client that initiated the drag and the client is expected to
//! handle the data passing internally." Genau unser Fall — kein
//! Datentransfer, nur die Auskunft, welche eigene Flaeche der Zeiger gerade
//! beruehrt. Dadurch sieht **kein fremdes Programm** den Zug. `icon = None`
//! ebenso (`allow-null`, wir zeichnen kein eigenes Symbol).
//!
//! **Gemessen am 2026-08-24**, mit einem eigenstaendigen Testprogramm: ein
//! echter Zug mit `source=None`/`icon=None` liefert auf dem Datengeraet genau
//! `Enter { serial, surface: eigene wl_surface, x, y, id: None } → Motion {
//! time, x, y } → Drop → Leave`. Das `Enter` kam auf der EIGENEN Flaeche —
//! der Kern des Ansatzes.
//!
//! **Einheit: flaechenlokal/logisch, NICHT physisch.** `x`/`y` aus `Enter`
//! und `Motion` sind laut Protokoll "surface-local coordinates" — das ist die
//! LOGISCHE Groesse, unskaliert. [`crate::fernsteuerung::Bildlage::anteil`]
//! dagegen verlangt ausdruecklich PHYSISCHE Fensterpunkte (s. dortiger
//! Modulkopf: "Zeigerposition (physische Punkte) -> Anteil am Bildinhalt");
//! gefuettert wird sie im bestehenden Code
//! (`fernsteuerung/mod.rs::on_window_event`) mit `position.x`/`position.y`
//! aus `WindowEvent::CursorMoved`. **Nachgesehen, nicht nur behauptet:** in
//! winits eigener Quelle (`platform_impl/linux/wayland/seat/pointer/mod.rs`)
//! kommt genau dieselbe rohe, flaechenlokale Wayland-Koordinate an
//! (`event.position`) und wird dort explizit als `LogicalPosition`
//! interpretiert und per `.to_physical(scale_factor)` in die
//! `PhysicalPosition` umgerechnet, die als `CursorMoved` hinausgeht. Zwischen
//! unseren rohen Werten und dem, was `Bildlage::anteil` erwartet, liegt
//! deshalb GENAU dieser eine Faktor (winits `window.scale_factor()`).
//!
//! **[`Gastverbindung::zeiger_ueber`] rechnet trotzdem NICHT um** — mit
//! Absicht, nicht aus Nachlaessigkeit: sie kennt nur die [`ObjectId`] der
//! beruehrten Flaeche, nicht das zugehoerige [`winit::window::Window`] (das
//! kennt nur der Aufrufer, der die Zuordnung Flaeche->Fenster ueberhaupt erst
//! herstellt — s. naechster Absatz). Eine Umrechnung HIER muesste entweder
//! raten, welches Fenster gemeint ist, oder ein zweites Mal Buch fuehren, was
//! der Aufrufer ohnehin schon tut. Der Rueckgabewert bleibt deshalb roh
//! flaechenlokal, LAUT UND DEUTLICH benannt (Feldreihenfolge `(ObjectId, f64,
//! f64)`, Doc-Kommentar an [`Gastverbindung::zeiger_ueber`]) — eine
//! stillschweigend falsche Einheit ergaebe einen Klick am falschen Ort, genau
//! der Fehler, gegen den dieses Vorhaben gebaut ist.
//!
//! **Offene Frage aus der Aufgabenstellung — GEMESSEN, nicht nur per
//! Protokolltext gefolgert.** Liefert EIN Datengeraet je Sitzplatz `enter`
//! fuer MEHRERE eigene Flaechen (mehrere Player-Fenster derselben
//! Fernsteuerungs-Sitzung, s. `CLAUDE.md` "Mehrere Bildschirme")? Die erste
//! Fassung dieses Modulkopfs hielt das fuer unbelegt (angeblich kein
//! laufender Compositor auf dieser Maschine) — das war falsch: **`niri`
//! laeuft hier** (`WAYLAND_DISPLAY=wayland-1`), nur eben nicht ueber die
//! ueblichen Umgebungsvariablen einer interaktiven Sitzung sichtbar.
//! Nachgemessen am 2026-08-24 mit einem eigenstaendigen Wegwerf-Programm
//! (reines `wayland-client`, kein winit, in `/tmp` gebaut und nach der
//! Messung geloescht): zwei echte `xdg_toplevel`-Fenster desselben Klienten
//! (von `niri` automatisch nebeneinander gekachelt), EIN `wl_data_device`,
//! Mausbewegung und -klick per `ydotool` synthetisiert. Beobachtete
//! Ereignisfolge auf dem einen Datengeraet:
//!
//! ```text
//! Enter { surface: A, x=454.6, y=180.0, id: None }
//! Motion { x: 479.6 .. 1504.6, y: 180.0 }   (44 Schritte quer durch A)
//! Leave
//! Enter { surface: B, x=1.6, y=180.0, id: None }
//! Drop
//! Leave
//! ```
//!
//! **Das EINE Datengeraet lieferte `Enter` fuer BEIDE eigenen Flaechen**,
//! nacheinander, innerhalb desselben Zugs — die Frage ist damit positiv
//! beantwortet, nicht nur plausibel gemacht.
//!
//! **Nachgemessen am selben Tag, mit Umlauf- und Zeitstempeln** (Review-Befund
//! I-C, Protokoll und Zahlen in [`super::ende`]): zwischen dem `Leave` von A
//! und dem `Enter` von B liegt die Zeit, die der Zeiger ZWISCHEN den Fenstern
//! verbringt — in der Messung 21 ms und ein eigener Lesevorgang, denn zwischen
//! zwei gekachelten Fenstern klafft eine Luecke (16 px bei `niri`), und ueber
//! die Luecke zwischen zwei Monitoren werden daraus Sekunden. Die beiden
//! Ereignisse liegen also **nicht** im selben Umlauf; wer das annimmt, bricht
//! die Zieh-Geste genau an der Fenstergrenze ab. `zeiger_ueber` ist deshalb ganz
//! bewusst generisch geblieben (s. u.): es nimmt jede vom Compositor
//! gemeldete [`ObjectId`] entgegen, ohne sie gegen eine "erwartete" Flaeche
//! zu pruefen. Nebenbefund derselben Messung: die zwei `wl_pointer` auf dem
//! Sitzplatz meldeten denselben Druck mit identischer Seriennummer — dieselbe
//! Zusage wie im Fundament, hier ein zweites Mal bestaetigt.
//!
//! Die im Auftrag angebotene Ausweich-Option — "je Fenster ein eigenes
//! Datengeraet" — wurde VOR der Messung geprueft und verworfen, aus einem
//! Grund, den die Messung nicht beruehrt: `wl_data_device_manager.
//! get_data_device` nimmt nur einen SITZPLATZ entgegen, keine Flaeche: es
//! gibt auf Protokollebene gar keinen Weg, ein Datengeraet an EIN Fenster zu
//! binden. Und da [`super::Gastverbindung::aufbauen`] winits VORHANDENE
//! Verbindung nur MITBENUTZT (`Backend::from_foreign_display`, s. dortiger
//! Modulkopf), waeren mehrere `Gastverbindung`-Instanzen fuer verschiedene
//! Fenster technisch trotzdem EIN einziger Client (dieselbe Socket-
//! Verbindung) — der Compositor kann sie nicht auseinanderhalten. Ein
//! zweites Datengeraet auf demselben Sitzplatz haette die Mehrdeutigkeit
//! also nicht aufgeloest, sondern hoechstens Ereignisse verdoppelt.

use wayland_backend::sys::client::ObjectId;
use wayland_client::protocol::wl_surface;
use wayland_client::{Connection, Proxy};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

use super::Gastverbindung;

/// Die reine Zustandsfuehrung hinter [`Gastverbindung::zeiger_ueber`]: welche
/// eigene Flaeche der Zeiger waehrend eines laufenden Zugs beruehrt, und die
/// zuletzt gemeldete Lage DARIN (flaechenlokal, s. Modulkopf).
#[derive(Debug, Default, Clone, PartialEq)]
pub(super) struct ZugLage(Option<(ObjectId, f64, f64)>);

impl ZugLage {
    /// `wl_data_device::Event::Enter` — merkt die Flaeche und die
    /// mitgelieferte Startlage.
    pub(super) fn betreten(&mut self, flaeche: ObjectId, x: f64, y: f64) {
        self.0 = Some((flaeche, x, y));
    }

    /// `wl_data_device::Event::Motion` — aktualisiert nur die Lage, laesst
    /// die Flaeche unangetastet. Ohne vorheriges `Enter` (die Reihenfolge
    /// verlangt das Protokoll, aber ein einzelnes Ereignis ausser der Reihe
    /// soll nicht abstuerzen) bleibt es folgenlos.
    pub(super) fn bewegt(&mut self, x: f64, y: f64) {
        if let Some((flaeche, ..)) = self.0.take() {
            self.0 = Some((flaeche, x, y));
        }
    }

    /// `Drop`/`Leave` — die Zugsitzung ist vorbei, dieselbe Zusage wie
    /// [`super::DruckNummer::entwerten`].
    pub(super) fn verlassen(&mut self) {
        self.0 = None;
    }

    pub(super) fn aktuell(&self) -> Option<(ObjectId, f64, f64)> {
        self.0.clone()
    }
}

impl Gastverbindung {
    /// Zug ueber die Fenstergrenze beginnen: `start_drag` mit `source=None`,
    /// `icon=None` und der letzten Druck-Seriennummer, Ursprung ist die
    /// Flaeche von `fenster` (s. Modulkopf).
    ///
    /// Scheitert die Vorbereitung — keine Seriennummer (kein Druck seit dem
    /// letzten Zugende) oder `fenster` hat keine rekonstruierbare
    /// Wayland-Flaeche —, wird **nichts** angefasst und `false` kommt zurueck:
    /// dann bleibt es beim bisherigen Verhalten (kein Zug ueber die Grenze)
    /// statt bei etwas Halbem. `start_drag` selbst ist eine
    /// Feuer-und-vergessen-Anfrage ohne Rueckgabewert — der einzige
    /// Fehlerfall, den diese Methode kennt, ist eine der beiden fehlenden
    /// Voraussetzungen.
    ///
    /// **Auf ALLEN Datengeraeten** (eines je Sitzplatz), nicht nur dem
    /// ersten: [`Gastverbindung::letzte_druck_nummer`] kollabiert bereits auf
    /// EINE Nummer ueber alle Sitzplaetze hinweg (s. Fundament-Modulkopf
    /// "Mehrere Sitzplaetze kollabieren"), diese Methode kann also nicht
    /// wissen, welcher Sitzplatz tatsaechlich gedrueckt hat. `start_drag` mit
    /// einer Seriennummer, die zum jeweiligen Sitzplatz NICHT passt (keine
    /// aktive implizite Ergreifung dort), ist im Protokoll kein Fehlerfall —
    /// `wl_data_device`s `error`-Aufzaehlung kennt nur `role` und
    /// `used_source`, nichts fuer eine nicht passende Seriennummer — bleibt
    /// also folgenlos. Nur der Sitzplatz, dessen Ergreifung wirklich passt,
    /// startet den Zug wirklich. **Aus dem Protokolltext gefolgert, nicht am
    /// Compositor gemessen** (s. Bericht).
    ///
    /// **`true` heisst „Anfrage raus", NICHT „Zug laeuft"** (Review-Befund
    /// C-1). Ob er wirklich laeuft, sagt erst das erste `Enter` —
    /// [`super::Gastverbindung::zug_bestaetigt`]. Deshalb setzt diese Methode
    /// den Merker [`super::Zustand::eigener_zug`] (ab jetzt gehoeren
    /// `Enter`/`Motion`/`Drop`/`Leave` UNS, s. Fundament-Modulkopf) und
    /// raeumt beides ab, was von einem vorigen Zug uebrig sein koennte.
    ///
    /// **Vor dem Abraeumen muss der Aufrufer ein noch offenes Ende abgeholt
    /// haben** (`app::App::wayland_zug_beginnen` tut das) — sonst verschluckt
    /// dieser Start das Ende des vorigen Zugs, und dessen Maustaste bliebe am
    /// fernen Rechner unten.
    pub fn zug_beginnen(&mut self, fenster: &Window) -> bool {
        let Some(serial) = self.letzte_druck_nummer() else { return false };
        let Some(ursprung) = flaeche(&self.conn, fenster) else { return false };
        for geraet in &self.datengeraete {
            geraet.start_drag(None, &ursprung, None, serial);
        }
        let _ = self.conn.flush();
        // Ab hier gehoeren die Datengeraet-Ereignisse UNS — und zwar
        // unbelastet von dem, was ein voriger Zug hinterlassen hat.
        self.zustand.ende = Default::default();
        self.zustand.zug = ZugLage::default();
        self.zustand.bestaetigt = false;
        self.zustand.eigener_zug = true;
        true
    }

    /// Welche eigene Flaeche der Zeiger waehrend eines laufenden Zugs gerade
    /// beruehrt, und wo darin.
    ///
    /// **Flaechenlokal, NICHT physisch** (s. Modulkopf "Einheit") — der
    /// Aufrufer muss mit dem Skalierungsfaktor DES FENSTERS umrechnen, zu dem
    /// die zurueckgegebene [`ObjectId`] gehoert, bevor er den Wert an
    /// [`crate::fernsteuerung::Bildlage::anteil`] gibt. Diese Methode kennt
    /// das Fenster nicht, nur die vom Compositor gemeldete Flaechen-Kennung —
    /// nur der Aufrufer weiss, welches seiner Fenster das ist.
    pub fn zeiger_ueber(&self) -> Option<(ObjectId, f64, f64)> {
        self.zustand.zug.aktuell()
    }
}

/// Winits `wl_surface` des UEBERGEBENEN Fensters als Objekt unserer
/// Verbindung. Dieselbe Technik wie
/// [`crate::tastensperre::wayland::flaeche`] (SICHERHEIT-Begruendung dort) —
/// hier ueber den Parameter statt am selbst gehaltenen Fenster festgemacht,
/// weil `zug_beginnen` seinen Ursprung bei jedem Aufruf frisch von aussen
/// bekommt und selbst kein eigenes Fenster kennt.
fn flaeche(conn: &Connection, fenster: &Window) -> Option<wl_surface::WlSurface> {
    let handle = fenster.window_handle().ok()?;
    let RawWindowHandle::Wayland(handle) = handle.as_raw() else { return None };
    // SICHERHEIT: wie in `tastensperre::wayland::flaeche` — der Zeiger kommt
    // aus winits Fenster-Handle und zeigt auf einen gueltigen `wl_proxy` der
    // Schnittstelle `wl_surface`. Er bleibt gueltig, solange `fenster` lebt —
    // der Aufrufer haelt es gerade in der Hand.
    let id = unsafe {
        ObjectId::from_ptr(wl_surface::WlSurface::interface(), handle.surface.as_ptr().cast())
    }
    .ok()?;
    wl_surface::WlSurface::from_id(conn, id).ok()
}

#[cfg(test)]
mod tests {
    use super::ZugLage;
    use wayland_backend::sys::client::ObjectId;

    /// Steht fuer "irgendeine Flaeche" — echte [`ObjectId`]s entstehen nur
    /// ueber eine lebende Verbindung (s. Modulkopf, kein Compositor hier).
    /// Die Null-Kennung ist dafuer ausdruecklich vorgesehen ("should be used
    /// as placeholder") und fuer diese Tests voellig ausreichend: geprueft
    /// wird die Zustandsmaschine, nicht die Identitaet realer Flaechen.
    fn irgendeine_flaeche() -> ObjectId {
        ObjectId::null()
    }

    #[test]
    fn frisch_ist_leer() {
        assert_eq!(ZugLage::default().aktuell(), None);
    }

    #[test]
    fn betreten_setzt_flaeche_und_lage() {
        let mut lage = ZugLage::default();
        lage.betreten(irgendeine_flaeche(), 1.5, 2.5);
        assert_eq!(lage.aktuell(), Some((irgendeine_flaeche(), 1.5, 2.5)));
    }

    #[test]
    fn bewegt_aktualisiert_nur_die_lage() {
        let mut lage = ZugLage::default();
        lage.betreten(irgendeine_flaeche(), 1.0, 1.0);
        lage.bewegt(9.0, 9.0);
        assert_eq!(lage.aktuell(), Some((irgendeine_flaeche(), 9.0, 9.0)));
    }

    #[test]
    fn bewegt_ohne_vorheriges_betreten_bleibt_folgenlos() {
        // Die Reihenfolge Enter-vor-Motion verlangt das Protokoll; ein
        // einzelnes Ereignis ausser der Reihe soll trotzdem nicht knallen.
        let mut lage = ZugLage::default();
        lage.bewegt(3.0, 4.0);
        assert_eq!(lage.aktuell(), None);
    }

    #[test]
    fn verlassen_raeumt() {
        let mut lage = ZugLage::default();
        lage.betreten(irgendeine_flaeche(), 1.0, 1.0);
        lage.verlassen();
        assert_eq!(lage.aktuell(), None);
    }

    #[test]
    fn verlassen_ohne_vorheriges_betreten_bleibt_folgenlos() {
        let mut lage = ZugLage::default();
        lage.verlassen();
        assert_eq!(lage.aktuell(), None);
    }

    #[test]
    fn erneutes_betreten_ueberschreibt_die_vorherige_lage() {
        // Zwei Zuege ohne dazwischenliegendes `verlassen` sollten laut
        // Protokoll nicht vorkommen (jeder Zug endet mit Drop/Leave), aber
        // wie bei `DruckNummer::druecken` gilt: der neuere Stand zaehlt.
        let mut lage = ZugLage::default();
        lage.betreten(irgendeine_flaeche(), 1.0, 1.0);
        lage.betreten(irgendeine_flaeche(), 2.0, 2.0);
        assert_eq!(lage.aktuell(), Some((irgendeine_flaeche(), 2.0, 2.0)));
    }

    /// **Der Kernfall, fuer den dieses ganze Vorhaben existiert** — die von
    /// der Messung 2026-08-24 belegte Abfolge `Enter(A) → Leave → Enter(B)`
    /// IM SELBEN Zug (s. Modulkopf): eine Flaeche wird verlassen, und im
    /// selben Zug wird eine ANDERE betreten. Keiner der Tests oben verkettet
    /// `betreten → verlassen → betreten`; die Zustandsfuehrung ist zwar
    /// trivial korrekt (sie ueberschreibt das Tupel unbedingt, ohne
    /// Sonderfall "gleiche gegen andere Flaeche"), aber ein spaeterer Umbau,
    /// der genau einen solchen Sonderfall einfuehrt ("wenn dieselbe Flaeche,
    /// dann nicht ueberschreiben"), braeche die Sequenz — und ohne diesen
    /// Test wuerde es niemand melden.
    ///
    /// **Ehrliche Luecke:** eine ECHTE zweite, von der ersten
    /// UNTERSCHEIDBARE `ObjectId` gibt es ausserhalb einer laufenden
    /// Wayland-Verbindung nicht — `ObjectId::null()` ist der einzige sichere
    /// Konstruktor ohne Compositor (s. `irgendeine_flaeche` oben), und der
    /// unsichere `ObjectId::from_ptr` verlangt einen echten `wl_proxy`.
    /// Dieser Test betritt deshalb zweimal **dieselbe** Kennung. Er prueft
    /// damit die FORM der Sequenz — `verlassen` raeumt vollstaendig, ein
    /// `betreten` danach faengt wieder frisch an, keine liegengebliebene
    /// alte Lage —, aber NICHT, dass ein Wechsel auf eine WIRKLICH andere
    /// Flaeche sich ebenso verhaelt wie ein erneuter Eintritt in dieselbe.
    /// Diese Luecke (Sonderfall "gleiche gegen echte andere Flaeche") kann
    /// kein Test dieses Moduls schliessen, solange er ohne Compositor laeuft
    /// — nur die Messung selbst (Wegwerf-Programm, s. Bericht) deckt sie ab.
    #[test]
    fn verlassen_und_erneutes_betreten_im_selben_zug_ist_der_kernfall_der_messung() {
        let mut lage = ZugLage::default();
        lage.betreten(irgendeine_flaeche(), 1.0, 1.0);
        lage.verlassen();
        assert_eq!(lage.aktuell(), None, "verlassen raeumt vollstaendig, bevor die naechste Flaeche kommt");
        lage.betreten(irgendeine_flaeche(), 2.0, 2.0);
        assert_eq!(
            lage.aktuell(),
            Some((irgendeine_flaeche(), 2.0, 2.0)),
            "das erneute betreten faengt frisch an, ohne Rest der alten Lage"
        );
    }
}
