//! Fenster- und Sitzungsverwaltung: nimmt Requests von stdin entgegen, haelt
//! je Sitzung ein Fenster samt Renderer und meldet Zustand und Statistik
//! ueber stdout zurueck.
//!
//! Alles hier laeuft auf dem Hauptthread — winit verlangt das. Netzwerk und
//! Decode leben im Tokio-Kontext und reichen ihre Ergebnisse ueber
//! [`UserEvent`] herein.
//!
//! Was die einzelnen RPC-Operationen bedeuten, steht in [`requests`].

mod requests;

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoopProxy};
use winit::window::{Window, WindowId};

use crate::decode;
use crate::proto::{Event, PlayerOptions, Request, SessionState};
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
        // Klein gehalten: Frames werden mit `try_send` eingestellt und bei
        // vollem Kanal verworfen. Ein grosser Puffer wuerde bei langsamer
        // Darstellung Latenz aufbauen statt Bilder zu ueberspringen — bei
        // 60 fps waeren 256 Eintraege ueber vier Sekunden Rueckstand.
        let (ev_tx, mut ev_rx) = mpsc::channel(8);
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
                // Bei Pause bleibt das zuletzt gezeigte Bild stehen, die
                // Verbindung laeuft aber weiter — beim Fortsetzen ist man
                // sofort wieder live.
                if !session.options.paused.unwrap_or(false) {
                    // Farbbereich zusammen mit dem Frame uebernehmen, den wir
                    // tatsaechlich zeigen. Sonst wuerde ein waehrend der Pause
                    // eintreffender Range-Wechsel auf das eingefrorene alte
                    // Bild angewendet — sichtbar falsche Farben.
                    session.full_range = frame.full_range;
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
            UserEvent::StdinClosed => {
                // Gleicher Abbau wie bei der `shutdown`-Operation: stdin kann
                // auch ohne sie wegfallen (Electron stuerzt ab, Prozess wird
                // beendet), und dann muessen die Sitzungen genauso sauber
                // schliessen.
                self.stop_all_sessions();
                event_loop.exit();
            }
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

