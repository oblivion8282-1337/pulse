//! Beantwortung der RPC-Requests.
//!
//! Getrennt von der Fenster- und Sitzungsverwaltung in [`super`], weil das
//! zwei verschiedene Dinge sind: hier steht, was eine Operation bedeutet,
//! dort, wie eine Sitzung lebt. Als Kindmodul kommt dieser Teil trotzdem an
//! die privaten Felder von [`App`].
//!
//! Gemeinsame Regel aller Antworten: eine Operation beantwortet ihren Request
//! **genau einmal**, auch im Fehlerfall — die Gegenseite wartet sonst bis in
//! ihren Timeout.

use anyhow::Result;
use tokio::sync::mpsc;

use super::{App, Session};
use crate::proto::{PlayerOptions, Request, Response, SessionState};
use crate::render;
use crate::session::SessionCommand;
use winit::event_loop::ActiveEventLoop;

impl App {
    pub(super) fn handle_request(&mut self, req: Request, event_loop: &ActiveEventLoop) {
        let id = req.id;
        match req.op.as_str() {
            "health" => self.stdout.send(&Response::ok(
                id,
                serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "sessions": self.sessions.len(),
                    "codecs": ["h264", "av1"],
                }),
            )),

            // **Erst antworten, dann melden.** Die Gegenseite ordnet jede
            // Zustandsmeldung ueber die Sitzungsnummer zu, und die erfaehrt sie
            // aus dieser Antwort. Alles, was davor gemeldet wird, gehoert fuer
            // sie zu keiner bekannten Sitzung und faellt weg — Begruendung samt
            // Hergang bei `App::open`.
            "open" => match self.open(req, event_loop) {
                Ok(session_id) => {
                    self.stdout
                        .send(&Response::ok(id, serde_json::json!({ "session": session_id })));
                    self.emit_state(session_id, SessionState::Connecting, None);
                }
                Err(e) => self.stdout.send(&Response::err(id, format!("{e:#}"))),
            },

            "close" => match req.session {
                Some(sid) if self.sessions.contains_key(&sid) => {
                    self.close_session(sid);
                    self.stdout.send(&Response::bare(id));
                }
                _ => self.stdout.send(&Response::err(id, "unbekannte Sitzung")),
            },

            "set_option" => match self.set_option(&req) {
                Ok(()) => self.stdout.send(&Response::bare(id)),
                Err(e) => self.stdout.send(&Response::err(id, e)),
            },

            // Fenster nach vorne holen. Das Fenster wertet selbst KEINE
            // Eingaben aus (die Bedienung sitzt in der Pulse-App), es kann
            // aber hinter ihr liegen — dann fuehrt der Knopf in der Kachel
            // hierher. Ob der Compositor dem Wunsch folgt, entscheidet er;
            // unter Wayland darf ein Fenster sich nicht selbst nach vorne
            // zwingen, deshalb ist das eine Bitte, keine Garantie.
            "focus" => match req.session.and_then(|s| self.sessions.get(&s)) {
                Some(session) => {
                    session.window.focus_window();
                    self.stdout.send(&Response::bare(id));
                }
                None => self.stdout.send(&Response::err(id, "unbekannte Sitzung")),
            },

            // Fernsteuerung, Seite des Steuernden: Erfassung ein-/ausschalten.
            // Das Gegenstueck sind die `player:input`-Ereignisse — der eine Op
            // schaltet, das eine Ereignis liefert (s. `crate::fernsteuerung`).
            "input_capture" => match self.input_capture(&req) {
                Ok(data) => self.stdout.send(&Response::ok(id, data)),
                Err(e) => self.stdout.send(&Response::err(id, e)),
            },

            // Fernsteuerung: welcher Traeger die Eingabe gerade traegt
            // (Direktverbindung/Serverweg) — reiner Anzeigetext fuers
            // Statistik-Feld, der Zustand lebt im Renderer.
            "remote_transport" => match self.remote_transport(&req) {
                Ok(()) => self.stdout.send(&Response::bare(id)),
                Err(e) => self.stdout.send(&Response::err(id, e)),
            },

            // Fernsteuerung: welche Form der Zeiger des Hosts gerade hat. Der
            // Player setzt sie auf den eigenen Zeiger — mehr steht hier nicht,
            // die Auswahl der Form trifft der Host (s. `eingabe.rs`).
            "remote_pointer" => match self.remote_pointer(&req, event_loop) {
                Ok(()) => self.stdout.send(&Response::bare(id)),
                Err(e) => self.stdout.send(&Response::err(id, e)),
            },

            // Fernsteuerung: welche Bildschirme der ferne Rechner hat. Das
            // Fenster zeigt sie im Menue am Griff und meldet die Wahl zurueck
            // (`player:remoteScreen`) — angefordert wird in der App.
            // Fernsteuerung: darf angefragt werden? Reine Anzeige — der Klick
            // kommt als `player:remoteRequest` zurueck, angefragt wird in der App.
            "remote_anfragbar" => match self.remote_anfragbar(&req) {
                Ok(()) => self.stdout.send(&Response::bare(id)),
                Err(e) => self.stdout.send(&Response::err(id, e)),
            },

            // Fernsteuerung: ein Rahmen der geteilten Zwischenablage. Der
            // Player DEUTET ihn (anders als der Renderer, s. `app::ablage`) —
            // das Format lebt in `pulse-ablage`, an genau einer Stelle im
            // Baum.
            "ablage" => match self.ablage(&req) {
                Ok(()) => self.stdout.send(&Response::bare(id)),
                Err(e) => self.stdout.send(&Response::err(id, e)),
            },

            "remote_screens" => match self.remote_screens(&req) {
                Ok(()) => self.stdout.send(&Response::bare(id)),
                Err(e) => self.stdout.send(&Response::err(id, e)),
            },

            // Direkter P2P-Weg (s. `crate::direkt`): der Player ist Offerer.
            // `direct_start` liefert den Offer-SDP als Antwortnutzlast, die
            // Electron-Huelle reicht ihn zum Sidecar durch; `direct_signal`
            // nimmt deren Answer entgegen. Ohne `session`-Feld gilt die eine
            // Direkt-Sitzung des Prozesses (s. `direct_op`). Das
            // `params`-Objekt der Vereinbarung liest der Player nicht — die
            // Ops tragen ihre Nutzlast wie alle anderen flach.
            "direct_start" => self.direct_op(
                id,
                req.session,
                |reply| SessionCommand::DirectStart { reply },
                move |data| Response::ok(id, data),
            ),

            "direct_signal" => match direct_answer(&req) {
                Some(answer) => self.direct_op(
                    id,
                    req.session,
                    |reply| SessionCommand::DirectSignal { answer, reply },
                    move |_| Response::bare(id),
                ),
                None => self.stdout.send(&Response::err(id, "answer fehlt")),
            },

            "stats" => match req.session.and_then(|s| self.sessions.get(&s)) {
                Some(session) => self.stdout.send(&Response::ok(id, self.stats_json(session))),
                None => self.stdout.send(&Response::err(id, "unbekannte Sitzung")),
            },

            // Aufnahme-Operationen laufen alle nach demselben Muster: Befehl
            // in die Sitzung schicken, auf die Antwort warten, Ergebnis als
            // RPC-Antwort schreiben. Das Warten muss im Tokio-Kontext
            // passieren — die Fensterschleife darf nicht blockieren.
            "record" => match req.path.clone() {
                None => self.stdout.send(&Response::err(id, "path fehlt")),
                Some(path) => self.session_reply(
                    id,
                    req.session,
                    |reply| SessionCommand::Record { path, reply },
                    // Die Nutzlast traegt den tatsaechlich benutzten Pfad: die
                    // Endung richtet sich nach dem Codec (AV1 -> mkv,
                    // H.264 -> ts), kann also von der angefragten abweichen.
                    move |data| Response::ok(id, data),
                ),
            },

            "stop_record" => self.session_reply(
                id,
                req.session,
                |reply| SessionCommand::StopRecord { reply },
                move |_| Response::bare(id),
            ),

            "clip" => match req.path.clone() {
                None => self.stdout.send(&Response::err(id, "path fehlt")),
                Some(path) => {
                    let seconds = req.seconds.unwrap_or(30.0);
                    self.session_reply(
                        id,
                        req.session,
                        |reply| SessionCommand::Clip { path, seconds, reply },
                        move |data| Response::ok(id, data),
                    )
                }
            },

            "shutdown" => {
                self.stdout.send(&Response::bare(id));
                // Sitzungen zuerst beenden. Sonst wird beim Verlassen der
                // Fensterschleife die Tokio-Laufzeit fallengelassen und die
                // Sitzungs-Tasks werden am Await-Punkt abgebrochen — das
                // `DELETE` an die WHEP-Resource bleibt aus und sie verwaist
                // beim Server bis zum ICE-Timeout. `close`/Fenster-Schliessen
                // machen das schon richtig, `shutdown` fehlte es.
                self.stop_all_sessions();
                event_loop.exit();
            }

            other => self
                .stdout
                .send(&Response::err(id, format!("unbekannte Operation: {other}"))),
        }
    }

    /// Uebernimmt einen `set_option`-Patch in Fenster und laufende Sitzung.
    fn set_option(&mut self, req: &Request) -> Result<(), String> {
        let session_id = req.session.ok_or("session fehlt")?;
        let patch = build_patch(req)?;
        if !self.sessions.contains_key(&session_id) {
            return Err("unbekannte Sitzung".into());
        }
        self.apply_options(session_id, patch);
        Ok(())
    }

    /// Optionen auf eine Sitzung anwenden — der EINE Weg dorthin, gleich ob der
    /// Wunsch per RPC kam oder aus der Bedienoberflaeche im Fenster
    /// (`app::apply_overlay_action`). Unbekannte Sitzungen werden still
    /// uebergangen; die Pruefung gehoert zum Aufrufer, der eine Antwort schuldet.
    pub(super) fn apply_options(&mut self, session_id: u64, patch: PlayerOptions) {
        let Some(session) = self.sessions.get_mut(&session_id) else { return };
        session.options.apply(&patch);
        session.options.clamp();
        // Der Schieber im Fenster muss zeigen, was wirklich anliegt — auch wenn
        // die Aenderung von aussen kam.
        if let (Some(overlay), Some(volume)) = (session.overlay.as_mut(), patch.volume) {
            overlay.set_volume(volume);
        }
        // Der Ausgabe-Takt lebt im Fenster-Thread, nicht in der Sitzung — er
        // muss deshalb HIER nachgezogen werden. Ginge er nur ueber
        // `SessionCommand::Options` mit, antwortete `set_option` mit
        // `ok: true`, ohne dass sich etwas aendert (genau die Falle, wegen der
        // `hwdec` unten den Decoder verwirft).
        if let Some(ms) = patch.ausgabetakt_ms {
            // **Ueber den Nutzer-Weg**, nicht direkt `setze_vorhalt`: laeuft
            // gerade eine Fernsteuerung, ist der geltende Vorhalt die
            // Absenkung und nicht der Wunsch. Der Wunsch wird deshalb gemerkt
            // und erst beim Fern-Ende gestellt (Begruendung dort) — sonst hoebe
            // ein `set_option` die Absenkung still auf und waere danach selbst
            // wieder weg. Derselbe Fall wie `fern_geduld` in `session.rs`.
            session.takt.setze_vorhalt_vom_nutzer(ms);
        }
        session.window.request_redraw();
        // **Der Weg zur Sitzung muss die Reihenfolge halten.** Jeder Patch
        // ginge sonst als eigene Task auf ein Multi-Thread-Runtime (`main.rs`),
        // und zwei schnell aufeinanderfolgende koennen sich ueberholen: am
        // Lautstaerkeregler im Fern-Menue zeigte das Overlay dann den neuen
        // Wert, waehrend der Ton beim alten blieb — bleibend, bis zum naechsten
        // Zug. Jede Task wartet deshalb auf ihre Vorgaengerin. Blockierend
        // senden ginge nicht: das liefe auf dem Fenster-Thread.
        let tx = session.commands.clone();
        let vorherige = session.optionskette.take();
        session.optionskette = Some(self.runtime.spawn(async move {
            if let Some(vorherige) = vorherige {
                let _ = vorherige.await;
            }
            let _ = tx.send(SessionCommand::Options(Box::new(patch))).await;
        }));
    }

    /// Schickt einen Befehl mit Rueckmeldung in die Sitzung und beantwortet den
    /// Request mit dem Ergebnis.
    ///
    /// `make` baut den Befehl um den Antwortkanal herum, `ok` formt den
    /// Erfolgsfall in die RPC-Antwort — leer bei `record`/`stop_record`, mit
    /// `units` beim Clip. Alles andere (fehlende Sitzung, abgerissener Kanal)
    /// ist fuer alle drei gleich.
    fn session_reply<T, F, R>(&self, id: Option<i64>, session: Option<u64>, make: F, ok: R)
    where
        T: Send + 'static,
        F: FnOnce(tokio::sync::oneshot::Sender<Result<T, String>>) -> SessionCommand,
        R: FnOnce(T) -> Response + Send + 'static,
    {
        let Some(tx) = self.command_sender(id, session) else { return };
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let stdout = self.stdout.clone();
        let cmd = make(reply_tx);
        self.runtime.spawn(async move {
            if tx.send(cmd).await.is_err() {
                return stdout.send(&Response::err(id, "Sitzung antwortet nicht"));
            }
            match reply_rx.await {
                Ok(Ok(value)) => stdout.send(&ok(value)),
                Ok(Err(e)) => stdout.send(&Response::err(id, e)),
                Err(_) => stdout.send(&Response::err(id, "Sitzung beendet")),
            }
        });
    }

    /// Loest die Sitzung fuer `direct_start`/`direct_signal` auf.
    ///
    /// **Ohne `session`-Feld gilt: genau eine Direkt-Sitzung des Prozesses.**
    /// Der Direktmodus ist pro Fenster einer, und der Offer-Weg kennt seine
    /// Sitzungsnummer meist gar nicht — das Angebot ueber die App erreicht
    /// den Renderer, nicht den Player. Sind es mehrere oder keine, wird
    /// abgelehnt statt geraten: eine Nummer zu erfinden fuehrte dazu, dass
    /// die Answer des Hosts in ein fremdes Fenster ginge.
    fn direct_op<T, F, R>(&mut self, id: Option<i64>, session: Option<u64>, make: F, ok: R)
    where
        T: Send + 'static,
        F: FnOnce(tokio::sync::oneshot::Sender<Result<T, String>>) -> SessionCommand,
        R: FnOnce(T) -> Response + Send + 'static,
    {
        let ziel = match session {
            Some(sid) if self.sessions.get(&sid).is_some_and(|s| s.direkt) => Some(sid),
            Some(_) => None,
            None => {
                let treffer: Vec<u64> = self
                    .sessions
                    .iter()
                    .filter(|(_, s)| s.direkt)
                    .map(|(sid, _)| *sid)
                    .collect();
                (treffer.len() == 1).then(|| treffer[0])
            }
        };
        match ziel {
            Some(sid) => self.session_reply(id, Some(sid), make, ok),
            None => {
                self.stdout
                    .send(&Response::err(id, "keine Direkt-Sitzung (open mit direct:true noetig)"))
            }
        }
    }

    /// Schickt allen Sitzungen `Stop` und gibt ihnen kurz Zeit, sauber
    /// abzubauen. Best effort mit Zeitschranke: ein haengender Abbau darf das
    /// Beenden nicht blockieren.
    ///
    /// MUSS auf JEDEM Weg gerufen werden, der die Fensterschleife verlaesst —
    /// auch bei geschlossenem stdin. Sonst wird die Tokio-Laufzeit
    /// fallengelassen, die Sitzungs-Tasks werden am Await-Punkt abgebrochen und
    /// das `DELETE` an die WHEP-Resource bleibt aus.
    pub(super) fn stop_all_sessions(&mut self) {
        let senders: Vec<_> = self.sessions.values().map(|s| s.commands.clone()).collect();
        if senders.is_empty() {
            return;
        }
        // **Vor dem Leeren**, sonst gibt es die Sitzungen nicht mehr, an denen
        // die Zwischenablage haengt (Review C3): der Vorbestand des Nutzers
        // muss zurueck, bevor der Player die Auswahl mit sich nimmt.
        for id in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.ablage_abbau(id);
        }
        self.sessions.clear();
        self.by_window.clear();
        self.runtime.block_on(async move {
            for tx in senders {
                // Zustellen ist billig; das eigentliche Warten kommt danach.
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    tx.send(SessionCommand::Stop),
                )
                .await;
            }
            // Den Sitzungen Zeit fuer `whep_session.close()` geben (schliesst
            // die PeerConnection und schickt das DELETE). Zeitschranke, damit
            // ein haengender Abbau das Beenden nicht blockiert.
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        });
    }

    /// Loest die Sitzung auf und beantwortet den Request selbst, wenn sie
    /// fehlt — dann gibt es nichts zu senden.
    fn command_sender(
        &self,
        id: Option<i64>,
        session: Option<u64>,
    ) -> Option<mpsc::Sender<SessionCommand>> {
        match session.and_then(|s| self.sessions.get(&s)) {
            Some(s) => Some(s.commands.clone()),
            None => {
                self.stdout.send(&Response::err(id, "unbekannte Sitzung"));
                None
            }
        }
    }

    /// Statistik plus alles, was nicht in der Sitzung selbst gezaehlt wird.
    /// `surface_format` ist bewusst dabei: nur damit ist von aussen belegbar,
    /// dass mehr als 8 bit ausgegeben werden.
    fn stats_json(&self, session: &Session) -> serde_json::Value {
        let mut v = serde_json::to_value(session.stats).unwrap_or_default();
        if let Some(obj) = v.as_object_mut() {
            obj.insert("decoder".into(), session.decoder.clone().into());
            obj.insert("hardware_decode".into(), session.hardware.into());
            obj.insert("state".into(), session.state.as_str().into());
            obj.insert(
                "surface_format".into(),
                session
                    .renderer
                    .as_ref()
                    .map_or_else(|| "n/a".to_string(), |r| r.surface_format().to_string())
                    .into(),
            );
            obj.insert(
                "frames_presented".into(),
                session.renderer.as_ref().map_or(0, render::Renderer::frames_presented).into(),
            );
            // Lautlos verworfene Bilder (s. `Session::frames_never_drawn`) —
            // ohne die Zahl sieht eine Kette mit 144 dekodierten und 60
            // gezeichneten Bildern voellig gesund aus.
            obj.insert("frames_never_drawn".into(), session.frames_never_drawn.into());
            // Latenz-Posten fuer den Pruefstand: dekodieren und
            // Netz-bis-Schirm, beide als Mittel und Ausschlag je Fenster.
            obj.insert("decode_avg_us".into(), session.stats.decode_avg_us().into());
            obj.insert("glass_avg_us".into(), session.phases.age_avg_us.into());
            // Ende-zu-Ende nur, wenn die Sonde laeuft — ein 0 im Normalbetrieb
            // waere eine Zahl, die Genauigkeit vorspiegelt.
            if let Some(p) = session.probe.as_ref() {
                obj.insert("e2e_avg_us".into(), p.avg_us().into());
                obj.insert("e2e_max_us".into(), p.max_us().into());
                obj.insert("e2e_misses".into(), p.misses().into());
            }
            obj.insert("glass_max_us".into(), session.phases.age_max_us_last.into());
            obj.insert(
                "acquire_misses".into(),
                session.renderer.as_ref().map_or(0, render::Renderer::acquire_misses).into(),
            );
        }
        v
    }
}

/// Baut aus `key`/`value` oder `options` eines `set_option`-Requests einen Patch.
fn build_patch(req: &Request) -> Result<PlayerOptions, String> {
    if let Some(o) = req.options.as_ref() {
        return Ok(o.clone());
    }
    let (Some(key), Some(value)) = (req.key.as_ref(), req.value.as_ref()) else {
        return Err("options oder key/value noetig".into());
    };
    let obj = serde_json::json!({ key.as_str(): value });
    let patch: PlayerOptions =
        serde_json::from_value(obj).map_err(|e| format!("ungueltiger Wert fuer {key}: {e}"))?;
    // serde ignoriert unbekannte Felder stillschweigend. Ohne diese Pruefung
    // quittiert ein vertippter Schluessel mit `ok: true`, ohne dass irgendetwas
    // passiert — der schlimmste Fall von "hat scheinbar funktioniert".
    if !patch.any_set() {
        return Err(format!("unbekannte Einstellung: {key}"));
    }
    Ok(patch)
}

/// Die Answer eines `direct_signal`-Requests — flach (`answer`) oder in der
/// `params`-Huelse der Schnittstellen-Vereinbarung. Reines Lesen; die
/// Begruendung, beides zu akzeptieren, steht an [`Request::params`].
///
/// Ein leeres oder nicht-Text-`params.answer` gilt als Fehlantwort (None) —
/// die Ops duerfen nicht mit einer LEEREN Answer `ok` melden, das haette der
/// Sidecar ohnehin abgelehnt, aber die Meldung hier ist eindeutiger.
fn direct_answer(req: &Request) -> Option<String> {
    req.answer.clone().or_else(|| {
        req.params
            .as_ref()?
            .get("answer")?
            .as_str()
            .map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(json: &str) -> Request {
        serde_json::from_str(json).expect("Request parst")
    }

    #[test]
    fn patch_aus_key_value() {
        let p =
            build_patch(&req(r#"{"op":"set_option","key":"deband","value":0.25}"#)).expect("Patch");
        assert_eq!(p.deband, Some(0.25));
        assert_eq!(p.zoom, None, "nicht genannte Felder bleiben offen");
    }

    #[test]
    fn patch_aus_options_objekt() {
        let p = build_patch(&req(r#"{"op":"set_option","options":{"zoom":2.0}}"#)).expect("Patch");
        assert_eq!(p.zoom, Some(2.0));
    }

    #[test]
    fn patch_ohne_angaben_ist_fehler() {
        assert!(build_patch(&req(r#"{"op":"set_option"}"#)).is_err());
    }

    /// Regression: ein Tippfehler im Schluessel darf nicht mit `ok: true`
    /// quittiert werden, ohne dass etwas passiert.
    #[test]
    fn unbekannter_schluessel_ist_fehler() {
        let e = build_patch(&req(r#"{"op":"set_option","key":"debandd","value":0.5}"#));
        assert!(e.is_err(), "unbekannter Schluessel muss abgelehnt werden");
    }

    #[test]
    fn patch_mit_falschem_typ_ist_fehler() {
        assert!(
            build_patch(&req(r#"{"op":"set_option","key":"deband","value":"viel"}"#)).is_err(),
            "Text fuer eine Zahl muss abgelehnt werden"
        );
    }

    /// Die beiden Schreibweisen der Direkt-Ops: das Protokoll traegt seine
    /// Felder flach, die Vereinbarung zeigt sie in der `params`-Huelse. Ohne
    /// den Doppelweg liesse serde die Huelse still fallen — und die Answer
    /// kaeme nie an, ohne dass eine der beiden Seiten es merkt.
    #[test]
    fn direct_signal_liest_answer_flach_und_in_params_huelle() {
        let flach = req(r#"{"op":"direct_signal","answer":"v=0\r\nm=video 9\r\n"}"#);
        assert_eq!(direct_answer(&flach).as_deref(), Some("v=0\r\nm=video 9\r\n"));

        let gehuellt =
            req(r#"{"op":"direct_signal","params":{"answer":"v=0\r\nm=audio 9\r\n"}}"#);
        assert_eq!(direct_answer(&gehuellt).as_deref(), Some("v=0\r\nm=audio 9\r\n"));
    }

    #[test]
    fn direct_signal_ohne_answer_ist_leer() {
        assert_eq!(direct_answer(&req(r#"{"op":"direct_signal"}"#)), None);
        // Eine nicht-Text-Answer ist keine: sie haette `set_remote_description`
        // ohnehin abgelehnt, aber die Fehlermeldung hier ist eindeutiger.
        assert_eq!(direct_answer(&req(r#"{"op":"direct_signal","params":{"answer":7}}"#)), None);
    }
}
