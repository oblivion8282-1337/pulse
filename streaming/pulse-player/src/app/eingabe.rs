//! Die Fernsteuerungs-Seite der Sitzungsverwaltung: den Schalter bedienen und
//! die fertigen Frames nach vorne melden.
//!
//! Was uebersetzt wird, steht in [`crate::fernsteuerung`] und — fuer die Form
//! des Host-Zeigers — in [`super::zeigerform`]; das ist reine Rechnung und ohne
//! Fenster pruefbar. Hier steht nur, was davon die SITZUNG betrifft: welcher
//! Zeiger gefangen ist, welche Form er traegt, wann abgeholt wird, und was beim
//! Abbau noch hinausmuss.
//!
//! Als Kindmodul von [`super`] kommt das an die privaten Felder der Sitzung,
//! ohne dafuer Zugaenge zu oeffnen, die sonst niemand braucht.

use winit::event_loop::ActiveEventLoop;

use super::App;
use super::zeigerform::zeigerform;
use crate::fernsteuerung::Eingabeabgabe;
use crate::proto::{Event, Request};

impl App {
    /// `input_capture` — Eingabe-Erfassung schalten.
    ///
    /// Der **Zeigerfang** wird hier gleich mit am Fenster vollzogen (fangen,
    /// Zeiger verstecken). Scheitert er, laeuft die Erfassung trotzdem, aber
    /// **ohne** Fang: relative Bewegungen ohne gefangenen Zeiger waeren eine
    /// Maus, die aus dem Fenster laeuft und weiter steuert. Die Antwort sagt
    /// deshalb, was wirklich gilt — nicht, was gewuenscht war.
    pub(super) fn input_capture(&mut self, req: &Request) -> Result<serde_json::Value, String> {
        let session_id = req.session.ok_or("session fehlt")?;
        let aktiv = req.enabled.unwrap_or(false);
        let fang_gewuenscht = aktiv && req.pointer_lock.unwrap_or(false);
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;

        let fang = fang_gewuenscht && zeiger_fangen(&session.window, true);
        if !fang_gewuenscht {
            zeiger_fangen(&session.window, false);
        }
        session.zeigersicht.fang_setzen(fang);
        // Der WUNSCH wird getrennt vom Erreichten aufgehoben: nach einem
        // Fokuswechsel muss er neu vollzogen werden (s. [`Self::fokus_gewechselt`]).
        session.fang_gewuenscht = fang_gewuenscht;
        if aktiv {
            // **Der Platz wird NUR beim Einschalten gesetzt.** `slot: 0` ist
            // hier die Vorgabe der Wire-Spec fuer „erster Stream" und kommt aus
            // einem ausdruecklichen Einschalten; beim AUSSCHALTEN darf er
            // dagegen nirgends herkommen — die Hoch-Ereignisse gehoeren dem
            // Stream, der gerade gesteuert wurde (s. `Erfassung::ausschalten`).
            session.eingabe.einschalten(req.slot.unwrap_or(0), fang, req.remote_session.as_deref());
        } else {
            session.eingabe.ausschalten();
            // Der Anzeigetext des Eingabewegs gehoert der Sitzung, die gerade
            // endet — stehen bleiben duerfte er nur, um beim naechsten Start
            // etwas Falsches zu behaupten.
            session.fern_transport.clear();
            // Dasselbe fuer die Kopie der Bildschirmliste (s. Doku am Feld):
            // sonst behauptete sie nach dem Ende der Fernsteuerung weiter,
            // dieses Fenster zeige Bildschirm N — die Fokus-Suche
            // (`OverlayAction::RemoteScreenFocus`) koennte dann ein Fenster
            // nach vorne holen, das diesen Schirm laengst nicht mehr zeigt.
            session.fern_schirme.clear();
            // Dasselbe fuer die Zeigerform: sie gehoert dem fernen Rechner.
            // Bliebe sie stehen, behauptete das Fenster nach dem Ende der
            // Fernsteuerung weiter einen I-Balken ueber einem Bild, in dem es
            // nichts zu schreiben gibt.
            session.window.set_cursor(winit::window::CursorIcon::Default);
            // **Und der Rueckfall „Zeiger im Bild" wird zurueckgenommen.**
            // Lief er, ist der lokale Zeiger gerade ausgeblendet; bliebe er
            // das, saesse der Nutzer nach dem Ende der Fernsteuerung ohne
            // Zeiger vor seinem eigenen Rechner (s. [`super::zeigersicht`]).
            session.zeigersicht.erfassung_aus();
        }
        // Erst jetzt ans Fenster: beide Gruende sind gesetzt, und ein
        // zwischendurch gesetztes `set_cursor_visible` liesse den Zeiger
        // aufblitzen.
        session.window.set_cursor_visible(session.zeigersicht.sichtbar());
        // Die Bedienung im Fenster wechselt mit: waehrend der Fernsteuerung
        // tritt der verschiebbare Griff an die Stelle der Leiste, die sonst bei
        // jeder Mausbewegung aufginge und einen Streifen ueber die volle Breite
        // fuer den fernen Rechner unerreichbar machte (`overlay::fernbedienung`).
        if let Some(overlay) = session.overlay.as_mut() {
            overlay.set_fernsteuerung(aktiv);
        }
        // Und der Vorhalt sinkt fuer die Dauer der Fernsteuerung: beim Steuern
        // zaehlt der geschlossene Kreis aus Eingabe hin und Bild zurueck, und
        // dort schlaegt jede Millisekunde Glaettung voll durch
        // (`takt::Ausgabetakt::fernsteuerung`). Der vorherige Wert kommt danach
        // von selbst zurueck.
        session.takt.fernsteuerung(aktiv);
        // Und die Tastenkuerzel des Fenstermanagers stehen still, solange
        // gesteuert wird (s. [`crate::tastensperre`]). Hier und nicht in der
        // Sitzung nebenan, weil die Sperre am FENSTER haengt: sie gilt je
        // Flaeche und wird vom Compositor angewendet, sobald diese Flaeche die
        // Tastatur hat.
        //
        // Ohne sie ist von einem Wayland-Rechner aus auf dem gesteuerten Mac
        // kein einziges Kuerzel erreichbar: die Befehlstaste geht als
        // Windows-Taste hinaus, und genau die belegt der Compositor als seinen
        // eigenen Modifikator. Scheitert die Sperre, laeuft die Sitzung
        // trotzdem — die Begruendung fuer dieses fail-soft steht im Modulkopf
        // dort und gehoert nicht auf „einheitlich fail-closed" geradegezogen.
        self.tastensperre.setzen(&mut session.tastensperre, &session.window, aktiv);

        // Dieselbe Merk-und-Zurueck-Mechanik fuer die Jitter-Geduld bei
        // Luecken (RTT-gekoppelt, `session`).
        //
        // **Die Swapchain-Tiefe bleibt bewusst bei 2** (Bughunt 2026-08-13):
        // eine Absenkung auf 1 laesst Mailbox auf Windows/DX12 zu Fifo
        // entarten — `get_current_texture` blockiert dann bis zur naechsten
        // Bildwiederholung, und zwar auf GENAU dem winit-Thread, der auch die
        // Eingabe-Erfassung traegt. Der vermeintliche Gewinn auf dem Bildweg
        // wanderte als Blockade auf den Eingabeschenkel; die Messung dazu
        // steht seit jeher an der Anlagestelle (`render/setup.rs`: 7-11 ms
        // Schleifendauer statt ~4, nur 90-140 von 144 Bildern gezeichnet).
        //
        // `try_send` mit Netz darunter: verwirft der volle Kanal ausgerechnet
        // das AUS, bliebe die Geduld dauerhaft abgesenkt — es gibt danach
        // keinen weiteren Ruf, der es nachtraegt. Der Nachschub laeuft dann
        // ueber die Laufzeit (blockierendes send auf einem Tokio-Task).
        let cmd = crate::session::SessionCommand::Fernsteuerung(aktiv);
        if let Err(tokio::sync::mpsc::error::TrySendError::Full(cmd)) =
            session.commands.try_send(cmd)
        {
            let tx = session.commands.clone();
            self.runtime.spawn(async move {
                let _ = tx.send(cmd).await;
            });
        }
        session.window.request_redraw();
        let antwort = serde_json::json!({
            "enabled": aktiv,
            // Der Platz, der WIRKLICH gilt — nicht der erfragte. Beim
            // Ausschalten ist das der noch laufende, nicht die 0 aus einem
            // fehlenden Feld.
            "slot": session.eingabe.slot(),
            "pointer_lock": fang,
            // Was auf dem Weg verlorengegangen ist, steht in der Antwort statt
            // nur im Log: Bewegungen darf die Flutkontrolle verwerfen, Tasten
            // ohne Scancode-Abbildung koennen wir nicht senden — beides sind
            // aber die einzigen Stellen, an denen eine Eingabe lautlos
            // verschwindet, und wer „meine Taste kommt nicht an" meldet,
            // braucht dafuer eine Zahl.
            "dropped_moves": session.eingabe.verworfene_bewegungen(),
            "unmapped_keys": session.eingabe.unbekannte_tasten(),
            // Notbremse: die Warteschlange war uebervoll und der Strom wurde
            // neu begonnen (s. `fernsteuerung::Erfassung::einreihen`). Steht
            // hier, weil es die dritte — und einzige unerwartete — Stelle ist,
            // an der Eingabe verschwindet.
            "emergency_resets": session.eingabe.notbremsen(),
            "dropped_frames": session.eingabe.verworfene_frames(),
        });
        // **Wayland: die Gastverbindung fuer den Zug ueber die Fenstergrenze
        // entsteht HIER**, beim Einschalten — nicht beim ersten Druck (Review
        // I-A). Der zweite `wl_pointer` muss stehen, BEVOR die Taste faellt:
        // `wl_pointer.button` wird an eine neu gebundene Ressource nicht
        // nachgeliefert, und ohne Seriennummer gibt es kein `start_drag`.
        // Steht sie schon, kostet der Aufruf ein `if`; auf X11, Windows und
        // macOS ist er ein Nichtstun (s. `app::wayland_zug`-Modulkopf).
        //
        // Nach dem `json!` und damit nach der Ausleihe von `session`:
        // `wayland_zug_bereitstellen` braucht `&mut self`.
        if aktiv {
            self.wayland_zug_bereitstellen(session_id);
        } else {
            // Und beim AUSSCHALTEN einen etwa laufenden Zug abbrechen (Review
            // C-B): sonst bliebe der Merker stehen, und der naechste FREMDE
            // Zug ueber ein Player-Fenster spraeche wieder fuer uns.
            self.wayland_zug_abbrechen(session_id);
        }
        Ok(antwort)
    }

    /// `remote_transport` — der Eingabeweg fuers Statistik-Feld.
    ///
    /// Der Renderer meldet, worueber die Eingabe-Frames gerade fahren
    /// (Direktverbindung oder Serverweg, samt Grund bei Rueckfall). Der Player
    /// zeigt den Text nur an — die Zustandsmaschine dazu lebt in `p2p.ts`,
    /// und eine zweite hier koennte nur auseinanderlaufen.
    pub(super) fn remote_transport(&mut self, req: &Request) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;
        session.fern_transport = req.transport.clone().unwrap_or_default();
        // Waehrend einer Fernsteuerung fliessen Bilder — der naechste Durchgang
        // zeichnet den Text ohnehin mit. Das `request_redraw` deckt Standbild
        // und abgerissenen Strom, wo sonst kein Durchgang kaeme.
        if let Some(overlay) = session.overlay.as_mut() {
            overlay.mark_stats_dirty();
        }
        session.window.request_redraw();
        Ok(())
    }

    /// `remote_pointer` — die Form des Host-Zeigers auf den eigenen setzen.
    ///
    /// **Warum das noetig ist.** Waehrend einer Fernsteuerung nimmt der Host
    /// seinen Zeiger aus der Aufnahme (Cursor-Echo), damit hier nur der lokale,
    /// verzoegerungsfreie zu sehen ist. Mit ihm verschwindet aber die
    /// Formensprache: I-Balken ueber Text, Doppelpfeil an Kanten, Hand ueber
    /// Verweisen. Der Host meldet sie deshalb, und hier bekommt der lokale
    /// Zeiger die passende Form.
    ///
    /// **Zwei Wege, und der Name ist der bevorzugte.** Fuer die Formen, die
    /// Windows selbst mitbringt, kommt ein NAME — dann zeichnet das
    /// Betriebssystem dieses Rechners, in dessen Zeigergroesse und Thema. Fuer
    /// alles andere (Werkzeugzeiger von Schnitt-, Bild- und 3D-Programmen)
    /// kommt ein BILD, das [`super::zeigerbau`] entpackt. Das Bild hat Vorrang,
    /// der Name bleibt der Rueckfall: kommt es nicht durch oder laesst es sich
    /// nicht bauen, steht immer noch eine Form da statt gar nichts.
    ///
    /// **Nicht an die laufende Erfassung gekoppelt.** Der Renderer liefert die
    /// zuletzt bekannte Form nach, sobald sich das Fenster anhaengt, und das
    /// kann kurz VOR dem `input_capture` geschehen. Wuerde hier abgewiesen,
    /// bliebe der Standardpfeil stehen, bis sich am fernen Rechner zufaellig
    /// etwas aendert — die Auffrischungen tragen nur bis zum Renderer, der
    /// Gleiches nicht erneut durchreicht. Zurueckgesetzt wird beim Ausschalten
    /// der Erfassung (s. [`Self::input_capture`]).
    pub(super) fn remote_pointer(
        &mut self,
        req: &Request,
        event_loop: &ActiveEventLoop,
    ) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        // **Erst die Sitzung pruefen, dann bauen.** Andersherum legte eine
        // Meldung fuer ein laengst geschlossenes Fenster noch einen Zeiger beim
        // Betriebssystem an, der dann im Vorrat liegenbliebe — und der Aufruf
        // schluege danach trotzdem fehl.
        if !self.sessions.contains_key(&session_id) {
            return Err("unbekannte Sitzung".to_string());
        }
        // Der Vorrat gehoert der App und nicht der Sitzung: `create_custom_cursor`
        // haengt am Ereignisschleifen-Zeiger, nicht am Fenster, und derselbe
        // ferne Rechner kann ueber mehrere Fenster gesteuert werden (ein Platz
        // je Bildschirm). Ihn je Fenster zu halten hiesse, dasselbe Bild
        // mehrfach beim Betriebssystem anzulegen.
        let gebaut = req.bild.as_ref().and_then(|b| self.zeigervorrat.holen(b, event_loop));
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;
        match gebaut {
            Some(zeiger) => session.window.set_cursor(zeiger),
            None => session.window.set_cursor(zeigerform(req.shape.as_deref().unwrap_or_default())),
        }
        // Der Rueckfall: kann der Host die Form gar nicht mehr abfragen, legt er
        // seinen Zeiger zurueck ins Videobild und meldet das. Dann muss der
        // lokale weichen — sonst stehen zwei im Bild, und der falsche ist der
        // schnellere. **Ein fehlendes Feld heisst „nicht im Bild"** (aeltere
        // Shell): im Zweifel lieber zwei Zeiger als keiner. Die Form wird
        // trotzdem gesetzt — sie gilt wieder, sobald der Rueckfall endet.
        session.zeigersicht.im_bild_setzen(req.zeiger_im_bild.unwrap_or(false));
        session.window.set_cursor_visible(session.zeigersicht.sichtbar());
        Ok(())
    }

    /// `remote_screens` — welche Bildschirme der ferne Rechner hat.
    ///
    /// Wie `remote_transport` reine Anzeige: das Fenster zeigt die Liste im
    /// Menue am Griff und meldet die Wahl zurueck, entscheidet aber nichts. Wer
    /// welchen Bildschirm anfordert und was dann passiert, weiss nur die App —
    /// sie kennt Geraet, Sitzung und Server.
    ///
    /// **Nicht an die laufende Erfassung gekoppelt**, aus demselben Grund wie
    /// `remote_pointer`: die App liefert die Liste nach, sobald sich das
    /// Fenster anhaengt, und das kann kurz VOR dem `input_capture` geschehen.
    /// `remote_anfragbar` — den Anfrage-Knopf in der Bedienleiste zeigen.
    ///
    /// Reine Anzeige, wie [`Self::remote_screens`]: das Fenster fragt nichts
    /// an, es meldet nur den Klick. Ob angefragt werden DARF, entscheidet die
    /// App aus Rechten im Kanal, Plattform des Streamers und laufender Sitzung.
    pub(super) fn remote_anfragbar(&mut self, req: &Request) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;
        if let Some(overlay) = session.overlay.as_mut() {
            overlay.set_fern_anfragbar(req.anfragbar.unwrap_or(false));
        }
        session.window.request_redraw();
        Ok(())
    }

    pub(super) fn remote_screens(&mut self, req: &Request) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;
        let schirme = req.screens.clone().unwrap_or_default();
        // Zusaetzlich direkt an der Sitzung (wie `can_reattach`, s. dort):
        // `RemoteScreenFocus` sucht ueber ALLE Sitzungen nach dem Fenster
        // eines fremden Bildschirms und braucht dafuer eine Kopie, die ohne
        // das (optionale) `overlay` auskommt.
        session.fern_schirme = schirme.clone();
        if let Some(overlay) = session.overlay.as_mut() {
            overlay.set_fern_schirme(schirme);
        }
        session.window.request_redraw();
        Ok(())
    }

    /// Das Fenster hat den Tastaturfokus bekommen oder verloren.
    ///
    /// **Windows loest `ClipCursor` beim Fokusverlust auf, und winit stellt es
    /// nicht wieder her.** Ohne diese Stelle kam der Nutzer nach Alt+Tab und
    /// zurueck mit einem Zeiger wieder, der frei UND unsichtbar war, waehrend
    /// die Erfassung ihn weiter fuer gefangen hielt und `CursorMoved` deshalb
    /// verwarf — die Bedienleiste im Fenster war damit nicht mehr zu treffen.
    ///
    /// Beim Fokusverlust wird der Griff ausdruecklich abgegeben und der Zeiger
    /// wieder sichtbar gemacht: ein unsichtbarer Zeiger ueber einem Fenster,
    /// das gerade nicht bedient wird, ist ein verlorener Zeiger.
    pub(super) fn fokus_gewechselt(&mut self, id: u64, fokus: bool) {
        if fokus {
            self.zuletzt_fokussiert = Some(id);
        } else {
            // **Fokus weg heisst: der Zug ist vorbei, und wir erfahren es
            // sonst nie** (Review C-B). Der Compositor bricht mit dem Fokus
            // auch die implizite Ergreifung ab; das Loslassen der Maustaste
            // erreicht uns danach weder als `MouseInput` noch als `Drop`.
            // Ohne diese Zeile bliebe der Merker „eigener Zug" bis zum
            // Prozessende stehen. Nichts wird dabei losgelassen — das
            // besorgt `Erfassung::alles_loslassen`, das im selben
            // Fensterereignis schon gelaufen ist.
            self.wayland_zug_abbrechen(id);
        }
        let Some(session) = self.sessions.get_mut(&id) else { return };
        if !session.eingabe.aktiv() && !session.fang_gewuenscht {
            return;
        }
        let fang = fokus
            && session.fang_gewuenscht
            && session.eingabe.aktiv()
            && zeiger_fangen(&session.window, true);
        if !fang {
            zeiger_fangen(&session.window, false);
        }
        session.zeigersicht.fang_setzen(fang);
        session.window.set_cursor_visible(session.zeigersicht.sichtbar());
        session.eingabe.zeigerfang_nachfuehren(fang);
    }

    /// Fertige Eingabe-Frames aller Sitzungen nach vorne melden.
    ///
    /// Gibt den fruehesten Zeitpunkt zurueck, zu dem noch etwas ansteht — der
    /// Aufrufer legt ihn in den Kontrollfluss der Fensterschleife. Ohne das
    /// bliebe die letzte Bewegung einer Geste liegen, bis zufaellig das
    /// naechste Ereignis eintrifft.
    pub(super) fn eingaben_abgeben(
        &mut self,
        jetzt: std::time::Instant,
    ) -> Option<std::time::Instant> {
        // Wayland: die Warteschlange des Datengeraets leeren (sonst waechst
        // sie, s. `wayland_zug`-Modulkopf) und eine laufende Zug-Bewegung
        // weiterreichen. Hier und nicht anderswo, weil diese Methode ohnehin
        // bei jedem Schleifendurchlauf laeuft (`about_to_wait`) — dieselbe
        // Stelle, an der die Aufgabenstellung `nachfassen` verortet. Auf
        // Nicht-Linux und ohne laufenden Zug ein Nichtstun.
        self.wayland_zug_nachfassen();
        // Den Schreiber vorher ausleihen: `send` nimmt `&self`, und darunter
        // laeuft eine veraenderliche Schleife ueber die Sitzungen.
        let stdout = self.stdout.clone();
        let mut frueheste: Option<std::time::Instant> = None;
        for (id, session) in self.sessions.iter_mut() {
            // Schleife statt Einzelabholung: beim Zielwechsel koennen mehrere
            // Buendel mit verschiedenen Plaetzen bereitstehen, und jedes braucht
            // seine eigene Nachricht.
            loop {
                match session.eingabe.abholen(jetzt) {
                    Eingabeabgabe::Nichts => break,
                    Eingabeabgabe::Spaeter(t) => {
                        frueheste =
                            Some(frueheste.map_or(t, |f: std::time::Instant| f.min(t)));
                        break;
                    }
                    Eingabeabgabe::Jetzt { slot, frames } => {
                        // Zaehler fuers Statistik-Feld: was WIRKLICH hinausgeht.
                        session.eingabe_frames += frames.len() as u64;
                        stdout.send(&eingabe_ereignis(*id, slot, frames));
                    }
                }
            }
        }
        frueheste
    }

    /// Was noch in der Warteschlange steht, bevor eine Sitzung verschwindet.
    ///
    /// Wichtig fuer die Hoch-Ereignisse aus `Erfassung::ausschalten`:
    /// gingen die mit dem Fenster verloren, bliebe beim Host eine Taste
    /// gedrueckt, bis er selbst aufraeumt.
    pub(super) fn eingabe_raeumen(&mut self, id: u64) {
        // Das Fenster geht zu — ein laufender Zug gehoert abgebrochen, bevor
        // die Sitzung verschwindet (Review C-B). Sonst haelt der Merker
        // „eigener Zug" eine Sitzung am Leben, die es nicht mehr gibt, und
        // fremde Zuege sprechen wieder fuer uns.
        self.wayland_zug_abbrechen(id);
        let stdout = self.stdout.clone();
        let Some(session) = self.sessions.get_mut(&id) else { return };
        session.fang_gewuenscht = false;
        // Zweiter Riegel fuer den Rueckfall: dieser Weg laeuft, wenn das
        // Fenster von sich aus zugeht, und dann kommt kein `input_capture`
        // mehr. Der Zeiger gehoert dem Nutzer zurueck, solange es das Fenster
        // noch gibt.
        session.zeigersicht.erfassung_aus();
        session.window.set_cursor_visible(session.zeigersicht.sichtbar());
        session.eingabe.ausschalten();
        for (slot, frames) in session.eingabe.raeumen() {
            stdout.send(&eingabe_ereignis(id, slot, frames));
        }
        // Bilanz am Ende der Erfassung — die einzigen Stellen, an denen eine
        // Eingabe lautlos verschwindet.
        let (bewegungen, tasten) =
            (session.eingabe.verworfene_bewegungen(), session.eingabe.unbekannte_tasten());
        let notbremsen = session.eingabe.notbremsen();
        if bewegungen > 0 || tasten > 0 || notbremsen > 0 {
            eprintln!(
                "pulse-player: Sitzung {id}: Eingabe — {bewegungen} Bewegungen verworfen, \
                 {tasten} Tasten ohne Scancode-Abbildung, {notbremsen}x Notbremse"
            );
        }
    }
}

/// Der Ereignisrahmen, den die Electron-Seite (`desktop/electron/remoteInput.ts`)
/// in die `remote_input`-Huelle giesst. An EINER Stelle, weil ihn zwei Wege
/// absetzen (Takt und Abbau) und ein abweichendes Feld dort still verschwaende.
fn eingabe_ereignis(id: u64, slot: u32, frames: Vec<String>) -> Event {
    Event::new(
        "player:input",
        serde_json::json!({ "session": id, "slot": slot, "frames": frames }),
    )
}

/// Zeiger fangen oder freigeben. Liefert, ob er jetzt gefangen IST.
///
/// **Zwei Betriebsarten, und keine ist ueberall zu haben:** `Locked` (der Zeiger
/// steht still, es kommen nur noch Differenzen) gibt es unter Windows nicht,
/// `Confined` (der Zeiger bleibt im Fenster) nicht unter macOS. Deshalb wird der
/// Reihe nach probiert statt eine Art vorauszusetzen — die relativen Bewegungen
/// kommen ohnehin aus `DeviceEvent::MouseMotion` und nicht aus der Fangart.
fn zeiger_fangen(window: &winit::window::Window, fangen: bool) -> bool {
    use winit::window::CursorGrabMode;
    if !fangen {
        let _ = window.set_cursor_grab(CursorGrabMode::None);
        return false;
    }
    [CursorGrabMode::Locked, CursorGrabMode::Confined]
        .into_iter()
        .any(|art| window.set_cursor_grab(art).is_ok())
}
