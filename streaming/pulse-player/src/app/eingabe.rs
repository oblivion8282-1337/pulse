//! Die Fernsteuerungs-Seite der Sitzungsverwaltung: den Schalter bedienen und
//! die fertigen Frames nach vorne melden.
//!
//! Was uebersetzt wird, steht in [`crate::fernsteuerung`] — das ist reine
//! Rechnung und ohne Fenster pruefbar. Hier steht nur, was davon die SITZUNG
//! betrifft: welcher Zeiger gefangen ist, wann abgeholt wird, und was beim
//! Abbau noch hinausmuss.
//!
//! Als Kindmodul von [`super`] kommt das an die privaten Felder der Sitzung,
//! ohne dafuer Zugaenge zu oeffnen, die sonst niemand braucht.

use super::App;
use crate::fernsteuerung::Abgabe;
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
        session.window.set_cursor_visible(!fang);
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
            // Dasselbe fuer die Zeigerform: sie gehoert dem fernen Rechner.
            // Bliebe sie stehen, behauptete das Fenster nach dem Ende der
            // Fernsteuerung weiter einen I-Balken ueber einem Bild, in dem es
            // nichts zu schreiben gibt.
            session.window.set_cursor(winit::window::CursorIcon::Default);
        }
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
        Ok(serde_json::json!({
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
        }))
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
    /// Verweisen. Der Host meldet sie deshalb als NAMEN, und hier bekommt der
    /// lokale Zeiger die passende Form — gezeichnet vom Betriebssystem dieses
    /// Rechners, in dessen Zeigergroesse und Thema.
    ///
    /// **Nicht an die laufende Erfassung gekoppelt.** Der Renderer liefert die
    /// zuletzt bekannte Form nach, sobald sich das Fenster anhaengt, und das
    /// kann kurz VOR dem `input_capture` geschehen. Wuerde hier abgewiesen,
    /// bliebe der Standardpfeil stehen, bis sich am fernen Rechner zufaellig
    /// etwas aendert — die Auffrischungen tragen nur bis zum Renderer, der
    /// Gleiches nicht erneut durchreicht. Zurueckgesetzt wird beim Ausschalten
    /// der Erfassung (s. [`Self::input_capture`]).
    pub(super) fn remote_pointer(&mut self, req: &Request) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;
        session.window.set_cursor(zeigerform(req.shape.as_deref().unwrap_or_default()));
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
        session.window.set_cursor_visible(!fang);
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
        // Den Schreiber vorher ausleihen: `send` nimmt `&self`, und darunter
        // laeuft eine veraenderliche Schleife ueber die Sitzungen.
        let stdout = self.stdout.clone();
        let mut frueheste: Option<std::time::Instant> = None;
        for (id, session) in self.sessions.iter_mut() {
            match session.eingabe.abholen(jetzt) {
                Abgabe::Nichts => {}
                Abgabe::Spaeter(t) => {
                    frueheste = Some(frueheste.map_or(t, |f: std::time::Instant| f.min(t)));
                }
                Abgabe::Jetzt(frames) => {
                    // Zaehler fuers Statistik-Feld: was WIRKLICH hinausgeht.
                    session.eingabe_frames += frames.len() as u64;
                    stdout.send(&eingabe_ereignis(*id, session.eingabe.slot(), frames));
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
        let stdout = self.stdout.clone();
        let Some(session) = self.sessions.get_mut(&id) else { return };
        session.fang_gewuenscht = false;
        session.eingabe.ausschalten();
        if let Some(frames) = session.eingabe.raeumen() {
            stdout.send(&eingabe_ereignis(id, session.eingabe.slot(), frames));
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

/// Den gemeldeten Namen in eine winit-Form uebersetzen.
///
/// Die Namen kommen aus der CSS-Zeigerliste, und winit benennt seine Formen
/// nach derselben — deshalb ist das hier eine Tabelle und keine Uebersetzung.
/// Genau darin liegt die Plattformunabhaengigkeit: winit setzt daraus unter
/// Windows die `IDC_*`-Zeiger, unter macOS `NSCursor` und unter Linux die Namen
/// des installierten Zeiger-Themas. Ein Linux-Rechner, der einen
/// Windows-Rechner steuert, sieht damit seinen eigenen I-Balken.
///
/// **Unbekanntes wird zum Pfeil, nicht zum Fehler.** Der Name kommt vom fernen
/// Rechner; eine neuere Gegenseite darf eine Form kennen, die diese Fassung
/// nicht hat, ohne dass daran etwas bricht. **Mit der Liste des Hosts synchron
/// halten** (`streaming/win-hq-sidecar/src/remote_input/zeigerform.rs` und
/// `web/src/lib/remote/zeigerform.ts`).
fn zeigerform(name: &str) -> winit::window::CursorIcon {
    use winit::window::CursorIcon as C;
    match name {
        "text" => C::Text,
        "pointer" => C::Pointer,
        "wait" => C::Wait,
        "progress" => C::Progress,
        "crosshair" => C::Crosshair,
        "help" => C::Help,
        "not-allowed" => C::NotAllowed,
        "ew-resize" => C::EwResize,
        "ns-resize" => C::NsResize,
        "nwse-resize" => C::NwseResize,
        "nesw-resize" => C::NeswResize,
        "move" => C::Move,
        _ => C::Default,
    }
}

#[cfg(test)]
mod tests {
    use super::zeigerform;
    use winit::window::CursorIcon as C;

    /// Die Namen der Gegenseite treffen die erwarteten Formen. Der Test ist die
    /// eine Stelle, an der die drei Listen (Sidecar, Renderer, Player)
    /// zusammenkommen — faellt hier ein Name durch, kaeme er im Betrieb
    /// wortlos als Standardpfeil an, und niemand suchte danach.
    #[test]
    fn bekannte_namen_werden_uebersetzt() {
        for (name, erwartet) in [
            ("text", C::Text),
            ("pointer", C::Pointer),
            ("wait", C::Wait),
            ("progress", C::Progress),
            ("crosshair", C::Crosshair),
            ("help", C::Help),
            ("not-allowed", C::NotAllowed),
            ("ew-resize", C::EwResize),
            ("ns-resize", C::NsResize),
            ("nwse-resize", C::NwseResize),
            ("nesw-resize", C::NeswResize),
            ("move", C::Move),
            ("default", C::Default),
        ] {
            assert_eq!(zeigerform(name), erwartet, "{name}");
        }
    }

    /// Unbekanntes und Fehlendes werden zum Pfeil — der Name kommt vom fernen
    /// Rechner, und eine neuere Gegenseite darf mehr kennen als diese Fassung.
    #[test]
    fn unbekanntes_wird_zum_pfeil() {
        for name in ["", "zoom-in", "ns-Resize", "beliebiger unsinn"] {
            assert_eq!(zeigerform(name), C::Default, "{name:?}");
        }
    }
}
