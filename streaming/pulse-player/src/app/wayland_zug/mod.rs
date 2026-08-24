//! Wayland: den Zug ueber die Fenstergrenze anstossen und seine Bewegungen an
//! die tragende Sitzung weiterreichen (s. `crate::fernsteuerung::wayland`).
//! Reine Verdrahtung — was der Zug bedeutet, wie `start_drag`/das Datengeraet
//! funktionieren und welche Kanten offen sind, steht dort und in
//! `wayland::zug`.
//!
//! **Dieselbe Bauart wie [`crate::tastensperre`]:** die Fassade
//! ([`WaylandZug`], `App::wayland_zug_*`) ist **immer** da, portabel und
//! kostenlos auf Nicht-Linux; der Wayland-Teil steckt hinter
//! `#[cfg(target_os = "linux")]`. Damit braucht kein Aufrufer
//! (`window_event`, `input_capture`, `eingaben_abgeben`, `exiting`) ein
//! eigenes `#[cfg]` — dieselbe Erleichterung, die `tastensperre::Gemeinsam`
//! fuer `input_capture` schon bietet.
//!
//! Getrennt von `app/mod.rs`, aus demselben Grund wie `eingabe.rs` daneben:
//! die Datei ist ueber der Groessen-Grenze (`PLAN.md` §12.1), und dieser Teil
//! laesst sich sauber abtrennen. Aus demselben Grund noch einmal geschnitten:
//! die Zuordnung Flaeche->Fenster ([`zuordnung`]) und das ENDE eines Zugs —
//! es erkennen und abbauen ([`entscheidung`]).
//!
//! **Was zu einem Zug gehoert und wer es raeumt, steht an EINER Stelle:**
//! `App::wayland_zug_abbau(freigeben)` in [`entscheidung`]. Beenden, Aufgeben
//! und der Beginn eines neuen Zugs sind derselbe Abbau, nur mit verschiedenem
//! Schalter. Vor der vierten Review-Runde waren es zwei Trichter, die
//! verschiedene Teilmengen desselben Zustands raeumten — die Ursache dreier
//! Befund-Runden; der dritte (`zug_beginnen`) fiel eine Runde spaeter auf.
//!
//! ## Die fuenf Wege hier hinein
//!
//! 1. **[`App::wayland_zug_bereitstellen`]** — beim EINSCHALTEN der Erfassung
//!    (`input_capture`). Dort und nicht beim ersten Druck: der zweite
//!    `wl_pointer` muss stehen, BEVOR die Taste faellt. Dass
//!    `wl_pointer.button` an eine neu gebundene Ressource **nicht**
//!    nachgeliefert wird (anders als `enter`), ist aus dem Protokoll
//!    gefolgert, nicht gemessen — die Messung vom 2026-08-24 hatte den Zeiger
//!    von Anfang an gebunden. Die Richtung ist trotzdem sicher: frueher binden
//!    kann nicht schaden, spaeter binden kann eine Seriennummer kosten, und
//!    ohne Seriennummer gibt es kein `start_drag` (Review-Befund I-A: der
//!    ERSTE Druck konnte deshalb nie einen Zug starten, erst der zweite).
//! 2. **[`App::wayland_zug_beginnen`]** — beim angenommenen Mausdruck; raeumt
//!    zuerst ueber den Trichter ab und faengt dann an.
//! 3. **[`App::wayland_zug_nachfassen`]** — in jedem Schleifendurchlauf.
//! 4. **`App::wayland_zug_griff_pruefen`** ([`entscheidung`]) — bei jedem
//!    Fensterereignis, s. unten. Holt bei einem DRUCK ausserdem einen noch
//!    offenen Schluss ab, und zwar VOR `Erfassung::on_window_event`
//!    (Review C-A).
//! 5. **`App::wayland_zug_abbrechen`** ([`entscheidung`]) — bei Fokusverlust,
//!    beim Ausschalten der Erfassung und beim Schliessen des Fensters. Ohne
//!    diese drei Wege bliebe der Merker „eigener Zug" stehen, sobald ein Zug
//!    nicht regulaer endet (Review C-B).
//!
//! ## Drei Reihenfolge-Regeln, zwei davon erzwungen
//!
//! * **Dispatchen ohne den Schluss abzuholen** geht nicht mehr:
//!   `Gastverbindung::nachfassen` GIBT ihn zurueck und ist `#[must_use]`.
//!   Dasselbe fuer den Beweisweg (`griff_vorbei`). Ein liegengebliebenes Ende
//!   war Review-Befund C-1 — und weil `zugschluss` konsumiert, ist ein
//!   weggeworfenes Ende nicht aufgeschoben, sondern vernichtet.
//! * **Ein zweites `nachfassen()` in `wayland_zug_beginnen`** faellt aus
//!   demselben Grund auf — und zwar als BAUFEHLER, nicht als Warnung:
//!   `main.rs` traegt dafuer `#![deny(unused_must_use)]`. (Ohne das waere es
//!   nur eine Warnung; dieses Projekt hat kein `-D warnings`, weder in
//!   `ship.sh` noch in den Workflows — der Prueflauf der fuenften Runde hat
//!   das eigens nachgesehen.)
//! * **`griff_pruefen` vor `Erfassung::on_window_event`** liess sich NICHT
//!   erzwingen — es sind zwei Aufrufe in `App::window_event`, und beide
//!   Aufrufer sind fremde Nachbarn. Die Regel steht deshalb an drei Stellen im
//!   Klartext: hier, an `griff_pruefen` und an der Aufrufstelle selbst.
//!
//! ## Ein Modus, in dem der Beweis nie kommt: gefangener Zeiger
//!
//! Bei `CursorGrabMode::Locked` (Zeigerfang, `input_capture` mit
//! `pointer_lock`) steht der Zeiger still und winit liefert **kein**
//! `CursorMoved` mehr — die Bewegung kommt als `DeviceEvent::MouseMotion` und
//! erreicht `griff_pruefen` nie. Der Beweisweg fiele dort auf `MouseInput`
//! zusammen, und ein abgebrochener Zug haenge bis zur Notfrist. Ein Zug ergibt
//! in diesem Modus ohnehin keinen Sinn (es gibt keine Fenstergrenze, ueber die
//! ein stillstehender Zeiger laufen koennte), deshalb stoesst
//! [`App::wayland_zug_beginnen`] dort gar keinen erst an (Review I-2).
//!
//! ## Stolperstein 2: waehrend eines Zugs schweigt winit
//!
//! Sobald `start_drag` gegriffen hat, liefert winit keine
//! `CursorMoved`/`MouseInput` mehr — die komplette Bewegung UND das Loslassen
//! der Maustaste laufen ab dann ausschliesslich ueber
//! [`App::wayland_zug_nachfassen`]: Bewegung ueber `zeiger_ueber`, Loslassen
//! ueber den EREIGNISGETRIEBENEN `Zugschluss` (s. `wayland::ende` und
//! `wayland::zustand`) — **nicht** ueber eine Momentaufnahme von
//! `zeiger_ueber`.
//!
//! **Gemessen am 2026-08-24** (Protokoll im Bericht zu Task 3, Zahlen in
//! `wayland::ende`): mit dem Beginn des Zugs kam `wl_pointer.leave`, danach
//! ueber den ganzen Zug hinweg kein einziges `wl_pointer`-Ereignis mehr, und
//! mit dem `Drop` kam `wl_pointer.enter` im selben Umlauf zurueck. Der
//! Zeigerfokus ist also fuer den ganzen KLIENTEN weg, nicht nur fuer das
//! ziehende Fenster — dass daraus „fuer kein Fenster mehr" folgt, ist ein
//! kurzer Schluss, kein zweiter Messwert (ein Zeiger kann ohnehin nur ueber
//! einem Fenster stehen).
//!
//! Bis dahin war das alles aus dem Protokolltext GEFOLGERT (Review M-e: der
//! Bericht der letzten Runde nannte diese Lektuere „geprueft", was zu viel
//! war). Jetzt ist es belegt — und weil es belegt ist, laesst es sich
//! umdrehen: **liefert winit wieder ein Zeigerereignis, ist der Griff des
//! Compositors vorbei.** Genau das macht `wayland_zug_griff_pruefen` daraus
//! (s. [`entscheidung`]), und genau deshalb ist es ein Beweis und keine
//! Schaetzung — die Frist in `wayland::ende` ist nur noch das Netz darunter.
//!
//! **Der Befund C2/I3 der ersten Review-Runde war das Gegenteil dessen, was
//! hier bis zum 2026-08-24 stand** (Review M-b): die damalige Momentaufnahme
//! sah einen sehr schnellen Zug nicht faelschlich als Ende — sie sah sein Ende
//! **gar nicht**. `laeuft` wurde nie `true`, weil `zeiger_ueber()` zwischen
//! zwei Abtastungen nie als `Some` sichtbar war; damit wurde `zug_beendet()`
//! nie gerufen, und die Maustaste blieb am fernen Rechner unten. Die beiden
//! Fehlermodi haben entgegengesetzte Folgen (zu frueh los gegen klemmen) — sie
//! duerfen nicht verwechselt dastehen.
//!
//! ## C1 (erste Review-Runde): die Reihenfolge im Ereignisschleifen-Takt
//!
//! `window_event` (wo `wayland_zug_beginnen` haengt) laeuft VOR
//! `about_to_wait` -> `eingaben_abgeben` -> `wayland_zug_nachfassen` — die
//! Druck-Seriennummer unseres zweiten Zeigers liegt beim Aufruf von
//! `wayland_zug_beginnen` also noch UNGEDISPATCHT in der Warteschlange.
//! Ohne ein `nachfassen()` VOR `letzte_druck_nummer()` waere sie beim ersten
//! Druck `None` (kein Zug) und bei jedem weiteren die Nummer des VORIGEN,
//! bereits entwerteten Drucks (ein Compositor verwirft eine unpassende
//! Nummer laut Protokolltext still) — der Zug begaenne nie.
//!
//! **Ungeprueft bleibt der Zusammenbau als Ganzes:** es fehlt ein Handlauf mit
//! zwei Player-Fenstern an einem echten ferngesteuerten Rechner (s. Bericht).
//! Gemessen ist das PROTOKOLL darunter (zwei Fenster, ein Datengeraet, ein
//! echter Zug — s. `wayland::ende`); nachrechenbar sind die Stellen, an
//! denen dieses Vorhaben typischerweise bricht — die Einheit der Koordinaten
//! ([`zuordnung::logisch_zu_physisch`]), der Abbauplan
//! (`entscheidung::abbauplan`), was der Abbau an der Erfassung tut
//! (`fernsteuerung::Erfassung::zug_abbau`) und, eine Ebene tiefer, die
//! Ereignis-Zugehoerigkeit und der Zugschluss (`wayland::zustand`) — alle mit
//! eigenen Tests.

mod entscheidung;
#[cfg(target_os = "linux")]
mod zuordnung;

use super::App;

/// Was die App sich ueber den laufenden Zug merkt. Leer und kostenlos auf
/// Nicht-Linux (s. Modulkopf).
#[derive(Default)]
pub(super) struct WaylandZug {
    #[cfg(target_os = "linux")]
    inner: Innen,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct Innen {
    verbindung: Option<crate::fernsteuerung::wayland::Gastverbindung>,
    /// Aufbau schon versucht? Ein Fehlschlag (kein Wayland, kein Compositor
    /// mit dem Protokoll, kein `wl_seat`) aendert sich waehrend eines
    /// Prozesslebens nicht — dieselbe Begruendung wie
    /// `tastensperre::Gemeinsam::versucht`, kein Grund, ihn bei jedem
    /// Einschalten erneut zu zahlen.
    versucht: bool,
    /// Welche Sitzung den laufenden Zug gestartet hat — dorthin gehen seine
    /// Bewegungen, bis er endet.
    session: Option<u64>,
    /// Gemeldet, dass die zuletzt bekannte Flaeche keinem Fenster zugeordnet
    /// werden konnte (Review I4)? Nur fuer die EDGE-getriggerte Meldung: sie
    /// soll einmal je Uebergang ins Log, nicht bei jedem Tick, in dem ein
    /// laufender Zug ausserhalb aller eigenen Fenster haengt.
    ziel_fehler_gemeldet: bool,
}

impl App {
    /// Die Gastverbindung aufbauen — beim EINSCHALTEN der Erfassung, nicht
    /// beim ersten Druck (Review-Befund I-A, Begruendung im Modulkopf).
    ///
    /// Genau einmal je Prozessleben versucht; Erfolg UND Fehlschlag gehen ins
    /// Log (Review I4) — dieselbe Begruendung wie bei
    /// `tastensperre::wayland::Gemeinsam::anfordern`: ohne das Log sieht „der
    /// Compositor kann es nicht" genauso aus wie „es hat geklappt, aber etwas
    /// Nachgelagertes scheitert still", und das sind zwei Befunde mit voellig
    /// verschiedenen Antworten.
    ///
    /// Nichtstun, wenn Wayland es nicht hergibt (X11, kein Compositor mit dem
    /// Protokoll) — dann bleibt es beim Verhalten von vor diesem Vorhaben.
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_bereitstellen(&mut self, id: u64) {
        if self.wayland_zug.inner.versucht {
            return;
        }
        let Some(session) = self.sessions.get(&id) else { return };
        self.wayland_zug.inner.versucht = true;
        match crate::fernsteuerung::wayland::aufbauen(&session.window) {
            Ok(verbindung) => {
                eprintln!("pulse-player: Zug ueber die Fenstergrenze (Wayland) bereit.");
                self.wayland_zug.inner.verbindung = Some(verbindung);
            }
            Err(grund) => {
                eprintln!(
                    "pulse-player: Zug ueber die Fenstergrenze nicht verfuegbar ({grund}) \
                     — Ziehen bleibt auf das eigene Fenster beschraenkt."
                );
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn wayland_zug_bereitstellen(&mut self, _id: u64) {}

    /// Zug anstossen — beim MouseInput-Druck, **nur** wenn der Druck
    /// tatsaechlich bei der Erfassung ankam (Vorpruefung beim Aufrufer,
    /// `window_event` — Review I2/M-a: ein Druck auf der Bedienleiste oder
    /// ausserhalb des Bildes darf keinen Zug anstossen, sonst verliert der
    /// Griff waehrend einer Fernsteuerung seinen eigenen Zeigerfokus).
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_beginnen(&mut self, id: u64) {
        // Falls das Einschalten die Verbindung nicht gebaut hat (Sitzung erst
        // nach dem `input_capture` entstanden): hier noch einmal. Kostet ein
        // `if`, wenn sie schon steht.
        self.wayland_zug_bereitstellen(id);
        // C1 (`nachfassen()` vor `letzte_druck_nummer()`) UND das Abholen
        // eines noch offenen Endes sind beide schon gelaufen — in
        // `wayland_zug_griff_pruefen`, ganz vorne im selben `window_event`
        // (Review C-A; die Begruendung, warum es dort und nicht hier steht,
        // ebenda). **Hier darf kein zweites `nachfassen()` stehen:** es koennte
        // ein `Drop` dispatchen, das gleich darauf von `zug_beginnen`
        // weggeraeumt wuerde — und dann bliebe die Maustaste des vorigen Zugs
        // am fernen Rechner unten.
        let Some(session) = self.sessions.get(&id) else { return };
        // **Bei gefangenem Zeiger gar nicht erst anstossen** (Review I-2). Ein
        // Zug ueber die Fenstergrenze ist dann sinnlos — der Zeiger steht
        // still, gesteuert wird ueber Differenzen (`DeviceEvent::MouseMotion`),
        // und es gibt keine Fenstergrenze, ueber die er laufen koennte. Er
        // waere sogar schaedlich: der Beweisweg haengt an `CursorMoved`, und
        // genau das liefert winit bei `CursorGrabMode::Locked` nicht mehr —
        // ein abgebrochener Zug haenge dann bis zur Notfrist.
        if session.eingabe.zeigerfang() {
            return;
        }
        // **Erst abbauen, dann anfangen** (Review 1 der fuenften Runde). Der
        // Abbau ist die eine Stelle, an der steht, was zu einem Zug gehoert —
        // `zug_beginnen` setzte bis dahin fuenf derselben Felder ein zweites
        // Mal und vergass dabei prompt das sechste. **Ohne Freigabe:** ein
        // etwaiges Ende ist im selben `window_event` schon in
        // `griff_pruefen` abgeholt worden (mitsamt Freigabe); was hier noch
        // stehen kann, ist der Rest eines Zugs, den niemand mehr verfolgt —
        // und der Knopf, der gleich einen neuen Zug traegt, ist gerade erst
        // gedrueckt worden.
        self.wayland_zug_abbau(false);
        let Some(session) = self.sessions.get(&id) else { return };
        let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
        if verbindung.zug_beginnen(&session.window) {
            self.wayland_zug.inner.session = Some(id);
            self.wayland_zug.inner.ziel_fehler_gemeldet = false;
        } else {
            // Review I4: still zu bleiben war genau die Stelle, an der der
            // C1-Befund sich verstecken konnte.
            eprintln!(
                "pulse-player: Zug ueber die Fenstergrenze nicht gestartet \
                 (kein frischer Druck oder Fenster ohne Wayland-Flaeche)."
            );
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn wayland_zug_beginnen(&mut self, _id: u64) {}

    /// Warteschlange des Datengeraets leeren (`Gastverbindung::nachfassen`,
    /// s. dortiger Modulkopf „Warum das noetig ist") und, falls ein Zug
    /// laeuft, seine Bewegung an die tragende Sitzung weiterreichen — oder,
    /// falls er gerade endete (ereignisgetrieben, s. Modulkopf), ihren
    /// gehaltenen Mausknopf loslassen.
    #[cfg(target_os = "linux")]
    pub(super) fn wayland_zug_nachfassen(&mut self) {
        // **Der Schluss wird IMMER abgeholt**, auch ohne eigene Sitzung
        // (Review C-1): `nachfassen` gibt ihn zurueck und ist `#[must_use]` —
        // liegenlassen ist gar nicht mehr formulierbar. Ein `Beendet`, das
        // hier haengenbliebe, waere die Ladung fuer den naechsten Zug: dessen
        // erster Tick holte es ab und deutete es als sein eigenes Ende — die
        // gerade gedrueckte Maustaste ginge sofort wieder hoch.
        let (schluss, lage) = {
            let Some(verbindung) = self.wayland_zug.inner.verbindung.as_mut() else { return };
            (verbindung.nachfassen(), verbindung.zeiger_ueber())
        };

        // Bewegung zuerst anwenden: eine letzte Position kurz vor dem Ende
        // soll noch ankommen, wenn eine da ist.
        if let (Some((flaeche, x, y)), Some(id)) = (lage, self.wayland_zug.inner.session) {
            // Review I1: dieselben zwei Filter wie beim Desktop-Koordinaten-
            // Weg in `window_event` (aktive Erfassung UND dieselbe
            // Fernsteuerungs-Sitzung) — sonst koennte ein Fenster OHNE
            // Handschlag beim Host eine Nachricht bekommen (die der Host
            // verwirft und dabei ALLES Gedrueckte freigibt), oder ein
            // Fenster einer FREMDEN Steuerung eine Platznummer beisteuern,
            // die drueben einen anderen Bildschirm meint. Woher
            // `eigene_sitzung` selbst kommt, unterscheidet sich dabei
            // geringfuegig von `window_event` — benannt an `ziel_fuer`
            // (Review M-e).
            let eigene_sitzung = self.sessions.get(&id).and_then(|s| s.eingabe.sitzung());
            match zuordnung::ziel_fuer(&self.sessions, eigene_sitzung, &flaeche, x, y) {
                Some((slot, lage, px, py)) => {
                    self.wayland_zug.inner.ziel_fehler_gemeldet = false;
                    if let Some(session) = self.sessions.get_mut(&id) {
                        session.eingabe.wayland_ziel_setzen(Some((slot, lage)));
                        session.eingabe.zeigerposition(lage, px, py);
                    }
                }
                None if !self.wayland_zug.inner.ziel_fehler_gemeldet => {
                    // Review I4, EDGE-getriggert (s. Feld-Doc
                    // `ziel_fehler_gemeldet`): kein Tick-Spam, aber auch
                    // nicht mehr komplett still.
                    self.wayland_zug.inner.ziel_fehler_gemeldet = true;
                    eprintln!(
                        "pulse-player: Wayland-Zug — gemeldete Flaeche gehoert zu keinem \
                         erfassenden Fenster derselben Sitzung, Bewegung verworfen."
                    );
                }
                None => {}
            }
        }

        self.wayland_zug_schluss_anwenden(schluss);
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn wayland_zug_nachfassen(&mut self) {}
}

impl WaylandZug {
    /// Die Verbindung abbauen, solange winits Anzeige noch lebt — muss aus
    /// `App::exiting()` kommen (Review C3). Dieselbe Zusage wie
    /// `tastensperre::wayland::Gemeinsam::schliessen`/[`Drop`]: `main.rs`
    /// legt `App` VOR `run_app` an, `run_app` gibt winits `wl_display` frei,
    /// `App` faellt danach — ohne dieses Rufziel wuerden `Connection`,
    /// `EventQueue` und alle Proxys ihre Zerstoerung auf einer Anzeige
    /// versuchen, die es nicht mehr gibt.
    #[cfg(target_os = "linux")]
    pub(super) fn schliessen(&mut self) {
        self.inner.verbindung = None;
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) fn schliessen(&mut self) {}
}

#[cfg(target_os = "linux")]
impl Drop for WaylandZug {
    /// **Der Abbau gehoert in [`Self::schliessen`], nicht hierher** —
    /// dasselbe Netz wie `tastensperre::wayland::Gemeinsam::drop`: kommt
    /// `schliessen()` nicht zum Zug (Panik vor `App::exiting()`), wird hier
    /// lieber liegengelassen als eine Anzeige angefasst, die es nicht mehr
    /// gibt. Kostet am Prozessende eine Warteschlange und eine Handvoll
    /// Objekte — der Prozess endet ohnehin.
    fn drop(&mut self) {
        std::mem::forget(self.inner.verbindung.take());
    }
}
