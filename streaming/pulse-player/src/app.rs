//! Fenster- und Sitzungsverwaltung: nimmt Requests von stdin entgegen, haelt
//! je Sitzung ein Fenster samt Renderer und meldet Zustand und Statistik
//! ueber stdout zurueck.
//!
//! Alles hier laeuft auf dem Hauptthread — winit verlangt das. Netzwerk und
//! Decode leben im Tokio-Kontext und reichen ihre Ergebnisse ueber
//! [`UserEvent`] herein.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoopProxy};
use winit::window::{Window, WindowId};

use crate::decode;
use crate::proto::{Event, PlayerOptions, Request, Response, SessionState};
use crate::render;
use crate::rpc::StdoutWriter;
use crate::session::{self, SessionCommand, SessionEvent, SessionStats};

/// Ereignisse, die von aussen in die Fenster-Schleife getragen werden.
pub enum UserEvent {
    Request(Box<Request>),
    Session { id: u64, event: SessionEvent },
    StdinClosed,
}

struct Session {
    window: Arc<Window>,
    renderer: Option<render::Renderer>,
    commands: mpsc::Sender<SessionCommand>,
    options: PlayerOptions,
    stats: SessionStats,
    decoder: String,
    hardware: bool,
    full_range: bool,
    /// Zuletzt dekodiertes Bild — wird bei Pause weiter gezeigt.
    pending: Option<Box<decode::DecodedFrame>>,
    state: SessionState,
}

pub struct App {
    sessions: HashMap<u64, Session>,
    by_window: HashMap<WindowId, u64>,
    next_id: u64,
    proxy: EventLoopProxy<UserEvent>,
    runtime: tokio::runtime::Handle,
    stdout: StdoutWriter,
}

impl App {
    pub fn new(proxy: EventLoopProxy<UserEvent>, runtime: tokio::runtime::Handle) -> Self {
        Self {
            sessions: HashMap::new(),
            by_window: HashMap::new(),
            next_id: 1,
            proxy,
            runtime,
            stdout: StdoutWriter::new(),
        }
    }

    fn handle_request(&mut self, req: Request, event_loop: &ActiveEventLoop) {
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

            "open" => match self.open(req, event_loop) {
                Ok(session_id) => self
                    .stdout
                    .send(&Response::ok(id, serde_json::json!({ "session": session_id }))),
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

            "stats" => match req.session.and_then(|s| self.sessions.get(&s)) {
                Some(session) => self.stdout.send(&Response::ok(id, self.stats_json(session))),
                None => self.stdout.send(&Response::err(id, "unbekannte Sitzung")),
            },

            // Aufnahme-Operationen laufen alle nach demselben Muster: Befehl
            // in die Sitzung schicken, auf die Antwort warten, Ergebnis als
            // RPC-Antwort schreiben. Das Warten muss im Tokio-Kontext
            // passieren — die Fensterschleife darf nicht blockieren.
            "record" => {
                let path = match req.path.clone() {
                    Some(p) => p,
                    None => return self.stdout.send(&Response::err(id, "path fehlt")),
                };
                self.session_reply(id, req.session, |reply| SessionCommand::Record {
                    path,
                    reply,
                });
            }

            "stop_record" => {
                self.session_reply(id, req.session, |reply| SessionCommand::StopRecord { reply });
            }

            "clip" => {
                let path = match req.path.clone() {
                    Some(p) => p,
                    None => return self.stdout.send(&Response::err(id, "path fehlt")),
                };
                let seconds = req.seconds.unwrap_or(30.0);
                self.session_reply_with(id, req.session, |reply| SessionCommand::Clip {
                    path,
                    seconds,
                    reply,
                });
            }

            "shutdown" => {
                self.stdout.send(&Response::bare(id));
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
        let session = self.sessions.get_mut(&session_id).ok_or("unbekannte Sitzung")?;

        session.options.apply(&patch);
        session.options.clamp();
        session.window.request_redraw();
        let tx = session.commands.clone();
        self.runtime.spawn(async move {
            let _ = tx.send(SessionCommand::Options(Box::new(patch))).await;
        });
        Ok(())
    }

    /// Statistik plus alles, was nicht in der Sitzung selbst gezaehlt wird.
    /// `surface_format` ist bewusst dabei: nur damit ist von aussen belegbar,
    /// dass mehr als 8 bit ausgegeben werden.
    /// Schickt einen Befehl mit Rueckmeldung in die Sitzung und beantwortet
    /// den Request mit dem Ergebnis. Fuer Befehle ohne Nutzdaten.
    fn session_reply<F>(&self, id: Option<i64>, session: Option<u64>, make: F)
    where
        F: FnOnce(tokio::sync::oneshot::Sender<Result<(), String>>) -> SessionCommand,
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
                Ok(Ok(())) => stdout.send(&Response::bare(id)),
                Ok(Err(e)) => stdout.send(&Response::err(id, e)),
                Err(_) => stdout.send(&Response::err(id, "Sitzung beendet")),
            }
        });
    }

    /// Wie [`Self::session_reply`], aber die Antwort traegt eine Zahl
    /// (geschriebene Einheiten).
    fn session_reply_with<F>(&self, id: Option<i64>, session: Option<u64>, make: F)
    where
        F: FnOnce(tokio::sync::oneshot::Sender<Result<u64, String>>) -> SessionCommand,
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
                Ok(Ok(units)) => {
                    stdout.send(&Response::ok(id, serde_json::json!({ "units": units })))
                }
                Ok(Err(e)) => stdout.send(&Response::err(id, e)),
                Err(_) => stdout.send(&Response::err(id, "Sitzung beendet")),
            }
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
                    .map_or_else(|| "n/a".to_string(), |r| r.surface_format())
                    .into(),
            );
            obj.insert(
                "frames_presented".into(),
                session.renderer.as_ref().map_or(0, render::Renderer::frames_presented).into(),
            );
        }
        v
    }

    fn open(&mut self, req: Request, event_loop: &ActiveEventLoop) -> Result<u64> {
        let url = req.url.clone().ok_or_else(|| anyhow::anyhow!("url fehlt"))?;
        let mut options = PlayerOptions::defaults();
        if let Some(o) = req.options.as_ref() {
            options.apply(o);
        }
        options.clamp();

        let title = req.title.clone().unwrap_or_else(|| "Pulse — HQ-Stream".into());
        let attrs = Window::default_attributes()
            .with_title(title)
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 720.0));
        let window = Arc::new(event_loop.create_window(attrs)?);
        if req.fullscreen.unwrap_or(false) {
            window.set_fullscreen(Some(winit::window::Fullscreen::Borderless(None)));
        }

        let size = window.inner_size();
        let renderer =
            pollster::block_on(render::Renderer::new(window.clone(), size.width, size.height))?;

        let id = self.next_id;
        self.next_id += 1;

        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let (ev_tx, mut ev_rx) = mpsc::channel(256);
        let proxy = self.proxy.clone();
        self.runtime.spawn(async move {
            while let Some(event) = ev_rx.recv().await {
                if proxy.send_event(UserEvent::Session { id, event }).is_err() {
                    return;
                }
            }
        });
        let opts = options.clone();
        self.runtime
            .spawn(async move { session::run(url, vec![], opts, ev_tx, cmd_rx).await });

        self.by_window.insert(window.id(), id);
        self.sessions.insert(
            id,
            Session {
                window,
                renderer: Some(renderer),
                commands: cmd_tx,
                options,
                stats: SessionStats::default(),
                decoder: String::new(),
                hardware: false,
                full_range: false,
                pending: None,
                state: SessionState::Connecting,
            },
        );
        self.emit_state(id, SessionState::Connecting, None);
        Ok(id)
    }

    fn emit_state(&self, id: u64, state: SessionState, error: Option<&str>) {
        let mut data = serde_json::json!({ "session": id, "state": state.as_str() });
        if let (Some(err), Some(obj)) = (error, data.as_object_mut()) {
            obj.insert("error".into(), err.into());
        }
        self.stdout.send(&Event::new("player:state", data));
    }

    fn close_session(&mut self, id: u64) {
        if let Some(session) = self.sessions.remove(&id) {
            self.by_window.remove(&session.window.id());
            let tx = session.commands;
            self.runtime.spawn(async move {
                let _ = tx.send(SessionCommand::Stop).await;
            });
        }
    }

    fn on_session_event(&mut self, id: u64, event: SessionEvent) {
        let Some(session) = self.sessions.get_mut(&id) else { return };
        match event {
            SessionEvent::Frame(frame) => {
                session.full_range = frame.full_range;
                // Bei Pause bleibt das zuletzt gezeigte Bild stehen, die
                // Verbindung laeuft aber weiter — beim Fortsetzen ist man
                // sofort wieder live.
                if !session.options.paused.unwrap_or(false) {
                    session.pending = Some(frame);
                    session.window.request_redraw();
                }
            }
            SessionEvent::Stats(stats) => session.stats = stats,
            SessionEvent::Playing { decoder, hardware } => {
                session.decoder = decoder;
                session.hardware = hardware;
                session.state = SessionState::Playing;
                self.emit_state(id, SessionState::Playing, None);
            }
            SessionEvent::Ended { reason, failed } => {
                let state = if failed { SessionState::Failed } else { SessionState::Closed };
                self.emit_state(id, state, failed.then_some(reason.as_str()));
                self.close_session(id);
            }
        }
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Request(req) => self.handle_request(*req, event_loop),
            UserEvent::StdinClosed => event_loop.exit(),
            UserEvent::Session { id, event } => self.on_session_event(id, event),
        }
    }

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(&id) = self.by_window.get(&window_id) else { return };
        match event {
            WindowEvent::CloseRequested => {
                // Der Nutzer hat das Fenster geschlossen — nach vorne melden,
                // damit die App ihren Zustand nachziehen kann.
                self.emit_state(id, SessionState::Closed, None);
                self.close_session(id);
            }
            WindowEvent::Resized(size) => {
                if let Some(session) = self.sessions.get_mut(&id) {
                    if let Some(r) = session.renderer.as_mut() {
                        r.resize(size.width, size.height);
                    }
                    session.window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                let Some(session) = self.sessions.get_mut(&id) else { return };
                let Some(renderer) = session.renderer.as_mut() else { return };
                if let Some(frame) = session.pending.take() {
                    renderer.upload(&frame);
                }
                if let Err(e) = renderer.render(&session.options, session.full_range) {
                    eprintln!("pulse-player: Darstellung: {e:#}");
                }
            }
            _ => {}
        }
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
    serde_json::from_value(obj).map_err(|e| format!("ungueltiger Wert fuer {key}: {e}"))
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

    #[test]
    fn patch_mit_falschem_typ_ist_fehler() {
        assert!(
            build_patch(&req(r#"{"op":"set_option","key":"deband","value":"viel"}"#)).is_err(),
            "Text fuer eine Zahl muss abgelehnt werden"
        );
    }
}
