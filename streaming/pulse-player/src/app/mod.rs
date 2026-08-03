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

use crate::decode::{self, ColorMatrix};
use crate::overlay::{Overlay, OverlayAction, StatsView};
use crate::proto::{Event, PlayerOptions, Request, SessionState};
use crate::render;
use crate::rpc::StdoutWriter;
use crate::session::{self, SessionCommand, SessionEvent, SessionStats};

/// Wie frisch das letzte Bild sein muss, damit Eingaben KEINEN eigenen
/// Durchgang anfordern.
///
/// Fliessen Bilder, wird das Overlay mit dem naechsten ohnehin neu gezeichnet —
/// bei 144 fps also spaetestens nach 7 ms, beim Schieben eines Reglers
/// unmerklich. Ohne diese Bremse fordert jede Mausbewegung ihren eigenen
/// Durchgang an: gemessen bis zu 900 je Sekunde (Abtastrate der Maus), also ein
/// Vielfaches der Bildwiederholrate fuer nichts.
///
/// 50 ms heisst: ab etwa 20 Bildern je Sekunde uebernimmt der Bildfluss. Kommen
/// weniger (Standbild, Verbindungsabbruch), muessen Eingaben weiter selbst
/// zeichnen — sonst reagierte die Bedienung im Standbild nicht mehr.
const FRAME_FLOW_WINDOW: std::time::Duration = std::time::Duration::from_millis(50);

/// Wie lange die beiden Abschnitte eines Durchgangs brauchen, gemittelt ueber
/// jeweils eine Sekunde. Mikrosekunden, weil bei 144 fps das ganze Budget nur
/// 6900 davon betraegt.
#[derive(Default)]
struct PhaseTimes {
    upload_sum: u64,
    render_sum: u64,
    count: u64,
    since: Option<std::time::Instant>,
    /// Letztes vollstaendiges Fenster — das wird angezeigt.
    upload_avg_us: u64,
    render_avg_us: u64,
    /// Wann zuletzt ausgegeben wurde — Grundlage der ABSTAENDE.
    last_present: Option<std::time::Instant>,
    gap_min_us: u64,
    gap_max_us: u64,
    /// Abstaende von mehr als dem Doppelten des Sollwerts. Genau das sieht man
    /// als Ruckeln: die Summe je Sekunde kann stimmen, waehrend einzelne Bilder
    /// doppelt so lange stehen und andere sich draengeln.
    gap_late: u64,
    /// Fertige Werte des letzten Fensters.
    gap_min_us_last: u64,
    gap_max_us_last: u64,
    gap_late_last: u64,
    /// Alter des Bildes beim Ausgeben, gerechnet ab Ankunft des Pakets, das
    /// seine Zugriffseinheit abschloss. Das ist der Teil der Ende-zu-Ende-Kette,
    /// der in diesem Programm liegt: Jitter-Wartezeit + Zusammensetzen +
    /// Dekodieren + Hochladen + Ausgeben.
    age_sum_us: u64,
    age_count: u64,
    age_max_us: u64,
    age_avg_us: u64,
    age_max_us_last: u64,
}

impl PhaseTimes {
    /// Alter eines gerade ausgegebenen Bildes vermerken. Bilder ohne
    /// Ankunftszeit (Tests) zaehlen nicht mit, statt die Messung mit Nullen zu
    /// verwaessern.
    fn note_age(&mut self, arrived: Option<std::time::Instant>) {
        let Some(a) = arrived else { return };
        let us = a.elapsed().as_micros() as u64;
        self.age_sum_us += us;
        self.age_count += 1;
        self.age_max_us = self.age_max_us.max(us);
    }

    /// `expected_gap` = Soll-Abstand aus der gemessenen Bildrate der Quelle.
    fn note(
        &mut self,
        upload: std::time::Duration,
        render: std::time::Duration,
        expected_gap: Option<std::time::Duration>,
    ) {
        let now = std::time::Instant::now();
        if let Some(prev) = self.last_present {
            let gap = now.duration_since(prev).as_micros() as u64;
            self.gap_min_us = if self.gap_min_us == 0 { gap } else { self.gap_min_us.min(gap) };
            self.gap_max_us = self.gap_max_us.max(gap);
            if expected_gap.is_some_and(|e| gap > (e.as_micros() as u64).saturating_mul(2)) {
                self.gap_late += 1;
            }
        }
        self.last_present = Some(now);
        let since = self.since.get_or_insert(now);
        self.upload_sum += upload.as_micros() as u64;
        self.render_sum += render.as_micros() as u64;
        self.count += 1;
        if since.elapsed() >= std::time::Duration::from_secs(1) && self.count > 0 {
            self.upload_avg_us = self.upload_sum / self.count;
            self.render_avg_us = self.render_sum / self.count;
            self.gap_min_us_last = self.gap_min_us;
            self.gap_max_us_last = self.gap_max_us;
            self.gap_late_last = self.gap_late;
            if self.age_count > 0 {
                self.age_avg_us = self.age_sum_us / self.age_count;
                self.age_max_us_last = self.age_max_us;
            }
            self.age_sum_us = 0;
            self.age_count = 0;
            self.age_max_us = 0;
            self.upload_sum = 0;
            self.render_sum = 0;
            self.count = 0;
            self.gap_min_us = 0;
            self.gap_max_us = 0;
            self.gap_late = 0;
            self.since = Some(now);
        }
    }
}

/// Ereignisse, die von aussen in die Fenster-Schleife getragen werden.
pub enum UserEvent {
    Request(Box<Request>),
    Session { id: u64, event: SessionEvent },
    StdinClosed,
}

struct Session {
    window: Arc<Window>,
    renderer: Option<render::Renderer>,
    /// Bedienoberflaeche IM Fenster. `None`, wenn sie sich nicht aufbauen liess
    /// — dann laeuft das Bild ohne Bedienung weiter, statt die Sitzung zu
    /// verlieren (Fernsteuerung per RPC funktioniert ohnehin).
    overlay: Option<Overlay>,
    commands: mpsc::Sender<SessionCommand>,
    options: PlayerOptions,
    stats: SessionStats,
    decoder: String,
    hardware: bool,
    full_range: bool,
    /// Welche YUV-Matrix der laufende Strom verlangt.
    matrix: ColorMatrix,
    /// Zuletzt dekodiertes Bild — wird bei Pause weiter gezeigt.
    pending: Option<Box<decode::DecodedFrame>>,
    /// Ende-zu-Ende-Sonde, nur mit `PULSE_PLAYER_LATENCY_PROBE=1` vorhanden
    /// (s. `crate::probe`). Ohne die Umgebungsvariable ist das `None` und
    /// kostet nichts.
    probe: Option<crate::probe::LatencyProbe>,
    /// Wie viele Bilder hier ueberschrieben wurden, bevor sie gezeichnet
    /// werden konnten. Das ist der EINZIGE Ort, an dem ein Bild lautlos
    /// verschwinden kann, und er war bis 2026-07-26 ungezaehlt — bei 144 fps
    /// genau die Zahl, die fehlt, wenn Decode und Anzeige auseinanderlaufen.
    frames_never_drawn: u64,
    /// Zeitmessung der beiden Abschnitte auf dem Fenster-Thread (s.
    /// [`PhaseTimes`]). Ohne sie waere bei zu wenigen gezeichneten Bildern nicht
    /// entscheidbar, ob das Hochladen oder das Warten auf die Ausgabe bremst —
    /// und die beiden verlangen voellig verschiedene Gegenmassnahmen.
    phases: PhaseTimes,
    /// Wann das letzte Bild eintraf. Entscheidet, ob Eingaben einen eigenen
    /// Durchgang brauchen (s. [`FRAME_FLOW_WINDOW`]).
    last_frame_at: Option<std::time::Instant>,
    /// Bezugspunkt der Statistik-Zeile (s. `App::stats_log`).
    last_log: Option<std::time::Instant>,
    presented_at_last_log: u64,
    state: SessionState,
    /// Kopie von `req.can_reattach` (s. `proto.rs`) — steht bisher nur im
    /// Overlay (fuer den Reattach-Knopf), aber der Fenster-Schliessen-Handler
    /// braucht sie ebenso und hat kein `overlay` (kann `None` sein, wenn die
    /// Bedienoberflaeche nicht aufgebaut werden konnte). Deshalb hier zusaetzlich
    /// direkt an der Sitzung, statt sie ueber das Overlay umzuleiten.
    can_reattach: bool,
}

pub struct App {
    /// Schreibt einmal je Sekunde eine Statistik-Zeile auf stderr, wenn
    /// `PULSE_PLAYER_STATS_LOG` gesetzt ist.
    ///
    /// Hinter einem Schalter, nicht dauerhaft an: eine Zeile je Sekunde und
    /// Sitzung sind in einem ausgelieferten Build 3600 Zeilen je Stunde in
    /// Pulses Log. Fuer die Fehlersuche ist genau das aber das Werkzeug — die
    /// Zahlen liegen sonst nur im Overlay, und wer beim Zuschauen die Maus
    /// bewegt, veraendert die Messung (das Zeichnen des Overlays kostet selbst).
    stats_log: bool,
    sessions: HashMap<u64, Session>,
    by_window: HashMap<WindowId, u64>,
    next_id: u64,
    proxy: EventLoopProxy<UserEvent>,
    runtime: tokio::runtime::Handle,
    stdout: StdoutWriter,
}

/// Wie lange nach dem letzten Bild des Hauptstroms das Auffangnetz noch
/// unterdrückt bleibt.
///
/// Grosszuegiger als ein Bildabstand: Bei 60 fps kaeme sonst schon eine
/// einzelne verspaetete Ankunft als Umschaltung durch, und das Bild spraenge
/// zwischen scharf und grob hin und her. 400 ms sind kurz genug, dass ein
/// echter Aussetzer sofort aufgefangen wird, und lang genug, dass normales
/// Zappeln nichts ausloest.
const FALLBACK_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

impl App {
    pub fn new(proxy: EventLoopProxy<UserEvent>, runtime: tokio::runtime::Handle) -> Self {
        Self {
            stats_log: std::env::var_os("PULSE_PLAYER_STATS_LOG").is_some(),
            sessions: HashMap::new(),
            by_window: HashMap::new(),
            next_id: 1,
            proxy,
            runtime,
            stdout: StdoutWriter::new(),
        }
    }

    /// Hauptstrom und Auffangnetz nebeneinander laufen lassen, in EIN Fenster.
    ///
    /// Beide Sitzungen melden unter derselben Kennung, also zeigt der Renderer
    /// unverändert, was ihn erreicht. Die Auswahl passiert davor:
    ///
    /// * Der Hauptstrom geht durch, und jedes seiner Bilder stempelt die Uhr
    ///   `zuletzt_haupt`.
    /// * Vom Netz gehen NUR Bilder durch, und nur wenn diese Uhr älter ist als
    ///   [`FALLBACK_GRACE`]. Seine Zustandsmeldungen werden verworfen: Ein
    ///   `failed` des Netzes darf die Sitzung nicht beenden, und ein `playing`
    ///   des Netzes darf nicht als "der Stream läuft" durchgehen.
    ///
    /// Endet der Hauptstrom, wird auch das Netz gestoppt — sonst liefe es
    /// weiter und hielte ein Fenster am Leben, das niemand mehr füttert.
    fn spawn_with_fallback(
        &self,
        url: String,
        fallback_url: String,
        options: PlayerOptions,
        ev_tx: mpsc::Sender<SessionEvent>,
        cmd_rx: mpsc::Receiver<SessionCommand>,
    ) {
        let zuletzt_haupt = Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));

        let (haupt_tx, mut haupt_rx) = mpsc::channel::<SessionEvent>(8);
        let (netz_tx, mut netz_rx) = mpsc::channel::<SessionEvent>(8);
        let (netz_cmd_tx, netz_cmd_rx) = mpsc::channel::<SessionCommand>(4);

        // Hauptstrom: unverändert durchreichen, Bilder stempeln.
        let uhr = zuletzt_haupt.clone();
        let weiter = ev_tx.clone();
        self.runtime.spawn(async move {
            while let Some(event) = haupt_rx.recv().await {
                if matches!(event, SessionEvent::Frame(_)) {
                    *uhr.lock().unwrap() = Some(std::time::Instant::now());
                } else if matches!(event, SessionEvent::Ended { .. }) {
                    let _ = netz_cmd_tx.send(SessionCommand::Stop).await;
                }
                if weiter.send(event).await.is_err() {
                    break;
                }
            }
            // Fenster zu oder Sitzung vorbei: das Netz mit beenden.
            let _ = netz_cmd_tx.send(SessionCommand::Stop).await;
        });

        // Netz: nur Bilder, nur wenn der Hauptstrom gerade nichts liefert.
        let uhr = zuletzt_haupt.clone();
        self.runtime.spawn(async move {
            while let Some(event) = netz_rx.recv().await {
                let SessionEvent::Frame(_) = event else { continue };
                let frisch = uhr
                    .lock()
                    .unwrap()
                    .is_some_and(|t| t.elapsed() < FALLBACK_GRACE);
                if frisch {
                    continue;
                }
                if ev_tx.send(event).await.is_err() {
                    break;
                }
            }
        });

        let netz_opts = options.clone();
        self.runtime
            .spawn(async move { session::run(url, vec![], options, haupt_tx, cmd_rx).await });
        self.runtime.spawn(async move {
            session::run(fallback_url, vec![], netz_opts, netz_tx, netz_cmd_rx).await
        });
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
            .with_title(title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 720.0))
            // NICHT aktivieren: das Fenster soll den Tastatur-Fokus nicht
            // wegnehmen. Pulses Tastenkuerzel hoeren am Fenster der Web-App zu
            // und wirken nicht mehr, sobald ein anderes Fenster aktiv ist —
            // beim Zuschauen will man weiter in Pulse tippen koennen.
            .with_active(false);
        let window = Arc::new(event_loop.create_window(attrs)?);
        if req.fullscreen.unwrap_or(false) {
            window.set_fullscreen(Some(winit::window::Fullscreen::Borderless(None)));
        }

        let size = window.inner_size();
        let renderer =
            pollster::block_on(render::Renderer::new(window.clone(), size.width, size.height))?;
        // Overlay in DASSELBE Oberflaechenformat zeichnen wie das Bild.
        let overlay = match Overlay::new(
            renderer.device(),
            renderer.surface_texture_format(),
            &window,
            options.volume.unwrap_or(1.0),
        ) {
            Ok(mut o) => {
                // Die Leiste im Fenster ist die einzige Bedienung dieses
                // Streams, solange er hier laeuft — sie braucht denselben
                // Namen und dieselben Knoepfe wie die Kachel in der App.
                o.set_title(title);
                o.set_can_reattach(req.can_reattach.unwrap_or(true));
                Some(o)
            }
            Err(e) => {
                eprintln!("pulse-player: Bedienoberflaeche nicht verfuegbar: {e:#}");
                None
            }
        };

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
            let mut announced_end = false;
            while let Some(event) = ev_rx.recv().await {
                announced_end |= matches!(&event, SessionEvent::Ended { .. });
                if proxy.send_event(UserEvent::Session { id, event }).is_err() {
                    return;
                }
            }
            // Der Kanal ist zu, ohne dass `session::run` sein Ende gemeldet
            // hat — der Task ist also gestorben, statt zurueckzukehren (Panik).
            // Ohne diese Ersatzmeldung bliebe die Sitzung ewig in `connecting`:
            // der Renderer wartet auf `state`, der Rueckfall auf das
            // <video>-Element haengt an `failed` und griffe nie. Genau so
            // verhielt sich der fehlende rustls-Krypto-Provider (s. `main.rs`).
            if !announced_end {
                let _ = proxy.send_event(UserEvent::Session {
                    id,
                    event: SessionEvent::Ended {
                        reason: "Sitzung unerwartet beendet".to_string(),
                        failed: true,
                    },
                });
            }
        });
        let opts = options.clone();
        match req.fallback_url.clone() {
            None => {
                self.runtime
                    .spawn(async move { session::run(url, vec![], opts, ev_tx, cmd_rx).await });
            }
            Some(fallback) => {
                // Zwei Sitzungen, EIN Fenster: beide melden unter derselben
                // Kennung, deshalb landet ihr Bild in derselben Anzeige. Was
                // gezeigt wird, entscheidet der Filter unten — nicht der
                // Renderer, der davon nichts wissen muss.
                self.spawn_with_fallback(url, fallback, opts, ev_tx, cmd_rx);
            }
        }

        self.by_window.insert(window.id(), id);
        self.sessions.insert(
            id,
            Session {
                window,
                renderer: Some(renderer),
                overlay,
                commands: cmd_tx,
                options,
                stats: SessionStats::default(),
                decoder: String::new(),
                hardware: false,
                full_range: false,
                matrix: ColorMatrix::Bt709,
                pending: None,
                probe: crate::probe::LatencyProbe::from_env(),
                frames_never_drawn: 0,
                phases: PhaseTimes::default(),
                last_frame_at: None,
                last_log: None,
                presented_at_last_log: 0,
                state: SessionState::Connecting,
                can_reattach: req.can_reattach.unwrap_or(true),
            },
        );
        // Einmal zeichnen, bevor das erste Bild da ist: sonst zeigt das Fenster
        // undefinierten Inhalt, bis der Strom laeuft — und die Bedienoberflaeche
        // waere nicht auffindbar, weil sie ohne Durchgang nie erscheint.
        if let Some(session) = self.sessions.get(&id) {
            session.window.request_redraw();
        }
        self.emit_state(id, SessionState::Connecting, None);
        Ok(id)
    }

    /// Ein Durchgang: Bild hochladen, zeichnen, Overlay darueber. Gibt zurueck,
    /// was der Nutzer im Fenster ausgeloest hat — angewandt wird es erst danach
    /// (`apply_overlay_action`), weil dafuer die Sitzung erneut geliehen wird.
    fn draw(&mut self, id: u64) -> Vec<OverlayAction> {
        let Some(session) = self.sessions.get_mut(&id) else { return Vec::new() };
        // Feldweise leihen: Renderer und Overlay brauchen beide `&mut`, sind
        // aber getrennte Felder — ueber Methoden waere das dem Borrow-Checker
        // nicht vermittelbar.
        let Session {
            window,
            renderer,
            overlay,
            options,
            stats,
            decoder,
            hardware,
            full_range,
            matrix,
            pending,
            frames_never_drawn,
            phases,
            probe,
            ..
        } = session;
        let Some(renderer) = renderer.as_mut() else { return Vec::new() };
        // Nur zeichnen, wenn es etwas Neues gibt.
        //
        // Vorher gab die Schleife auch ohne neues Bild aus — gemessen 2500-mal
        // je Sekunde bei 144 ankommenden Bildern, also 17-mal dasselbe Bild.
        // Das kostete dauerhaft einen halben Kern und erklaerte die Kernlast,
        // die zunaechst nach teuren Bildern aussah. `ControlFlow::Wait` hilft
        // dagegen nichts: die Anforderungen kamen aus dem Zeichnen selbst.
        let has_frame = pending.is_some();
        // Zwei verschiedene Fragen, die vorher eine waren:
        //   * `wants_redraw` = gibt es einen GRUND, ohne neues Bild zu zeichnen
        //   * `visible`      = soll das Overlay in DIESEM Durchgang mitgezeichnet
        //                      werden (sonst verschwaende es beim Bildwechsel)
        let overlay_wants = overlay.as_ref().is_some_and(|o| o.wants_redraw());
        if !has_frame && !overlay_wants {
            return Vec::new();
        }
        let upload_started = std::time::Instant::now();
        let mut frame_arrived = None;
        if let Some(frame) = pending.take() {
            frame_arrived = frame.arrived;
            // Vor dem Hochladen: die Sonde braucht die Ebenen im Hauptspeicher.
            if let Some(p) = probe.as_mut() {
                p.note(&frame);
            }
            renderer.upload(&frame);
        }
        let upload_took = upload_started.elapsed();

        // Nur wenn das Overlay diesen Durchgang wirklich zeichnet, lohnt sich
        // ueberhaupt Arbeit fuer die Anzeige — sonst faellt hier alles weg.
        let want_overlay =
            overlay.as_ref().is_some_and(|o| o.visible() || o.wants_redraw());
        let surface_format =
            if want_overlay { renderer.surface_format().to_string() } else { String::new() };
        let frames_presented = renderer.frames_presented();
        let acquire_misses = renderer.acquire_misses();
        let view = StatsView {
            width: stats.width,
            height: stats.height,
            decoder,
            hardware: *hardware,
            surface_format: &surface_format,
            fps: stats.fps,
            kbps: stats.kbps,
            frames_presented,
            never_drawn: *frames_never_drawn,
            upload_us: phases.upload_avg_us,
            render_us: phases.render_avg_us,
            acquire_misses,
            frames_dropped: stats.frames_dropped,
            frames_skipped: stats.frames_skipped,
            packets_lost: stats.packets_lost,
            buffered_packets: stats.buffered_packets,
            jitter_target_ms: stats.jitter_target_ms,
            ten_bit_source: stats.ten_bit_source,
            audio_active: stats.media.audio_active,
            audio_underruns: stats.media.audio_underruns,
            recording: stats.media.recording,
        };
        let mut pass = overlay
            .as_mut()
            .filter(|_| want_overlay)
            .map(|o| render::OverlayPass::new(o, window, window.fullscreen().is_some(), &view));
        let render_started = std::time::Instant::now();
        if let Err(e) = renderer.render(options, *full_range, *matrix, pass.as_mut()) {
            eprintln!("pulse-player: Darstellung: {e:#}");
        }
        // Soll-Abstand aus der gemessenen Bildrate der Quelle — nicht aus einer
        // angenommenen: die Rate bestimmt der Sender.
        let expected_gap = stats
            .fps
            .filter(|f| *f > 0)
            .map(|f| std::time::Duration::from_micros(1_000_000 / f));
        phases.note_age(frame_arrived);
        phases.note(upload_took, render_started.elapsed(), expected_gap);
        pass.map(|p| p.actions).unwrap_or_default()
    }

    /// Eine Zeile mit allen Zahlen, hoechstens einmal je Sekunde und Sitzung.
    ///
    /// Getrieben von den Statistik-Ereignissen der Sitzung (alle 250 ms), NICHT
    /// vom Zeichnen: bliebe die Anzeige stehen, waere genau dann keine Zeile
    /// mehr da, wenn man sie am dringendsten braucht.
    fn log_stats_if_due(&mut self, id: u64) {
        if !self.stats_log {
            return;
        }
        let now = std::time::Instant::now();
        let Some(session) = self.sessions.get_mut(&id) else { return };
        let elapsed = session.last_log.map(|t| now.duration_since(t));
        if elapsed.is_some_and(|d| d < std::time::Duration::from_secs(1)) {
            return;
        }
        let presented = session.renderer.as_ref().map_or(0, render::Renderer::frames_presented);
        let misses = session.renderer.as_ref().map_or(0, render::Renderer::acquire_misses);
        // Beim ersten Aufruf gibt es keinen Bezugspunkt — dann nur die
        // Zaehlerstaende, keine erfundene Rate.
        let drawn = elapsed.map(|d| {
            let secs = d.as_secs_f64().max(0.001);
            ((presented.saturating_sub(session.presented_at_last_log)) as f64 / secs).round() as u64
        });
        // Fenster der Sonde im GLEICHEN Rhythmus abschliessen wie das Log —
        // sonst gehoerten Mittelwert und Zeitpunkt nicht zusammen.
        if let Some(p) = session.probe.as_mut() {
            p.roll();
        }
        let probe_line = session.probe.as_ref().map(|p| {
            format!(
                ", Ende-zu-Ende {:.1}/{:.1} ms ({} ohne Muster)",
                p.avg_us() as f64 / 1000.0,
                p.max_us() as f64 / 1000.0,
                p.misses()
            )
        });
        let st = &session.stats;
        // `concat!` statt Zeilenfortsetzungen: mit `\` am Zeilenende ist beim
        // Schreiben dieser Datei schon einmal eine einzige lange Zeile mit
        // Leerraum-Ketten entstanden, die im Log als klaffende Luecken auftauchte.
        eprintln!(
            concat!(
                "pulse-player: Sitzung {}: dekodiert {}/s, gezeichnet {}/s, ",
                "nie gezeichnet {}, ohne Oberflaeche {}, ",
                "hochladen {:.1} ms, ausgeben {:.1} ms, ",
                "Abstand {:.1}-{:.1} ms ({} zu spaet), ",
                "Ankunft max {:.1} ms ({} ueber 5 ms), ",
                "dekodieren {:.1}/{:.1} ms, Netz-bis-Schirm {:.1}/{:.1} ms, ",
                "{} kbit/s, Paketverlust {}, Puffer {} Pakete, uebersprungen {}"
            ),
            id,
            st.fps.map_or_else(|| "?".to_string(), |v| v.to_string()),
            drawn.map_or_else(|| "?".to_string(), |v| v.to_string()),
            session.frames_never_drawn,
            misses,
            session.phases.upload_avg_us as f64 / 1000.0,
            session.phases.render_avg_us as f64 / 1000.0,
            session.phases.gap_min_us_last as f64 / 1000.0,
            session.phases.gap_max_us_last as f64 / 1000.0,
            session.phases.gap_late_last,
            st.arrival_gap_max_us as f64 / 1000.0,
            st.arrival_gaps_over_5ms,
            // Mittel und Ausschlag je Fenster, beide in ms.
            st.decode_avg_us() as f64 / 1000.0,
            st.decode_max_us as f64 / 1000.0,
            session.phases.age_avg_us as f64 / 1000.0,
            session.phases.age_max_us_last as f64 / 1000.0,
            st.kbps.map_or_else(|| "?".to_string(), |v| v.to_string()),
            st.packets_lost,
            st.buffered_packets,
            st.frames_skipped,
        );
        // Getrennte Zeile statt eines weiteren Platzhalters in der grossen:
        // die Sonde laeuft nur im Pruefstand, und die Zeile oben soll im
        // Normalbetrieb unveraendert bleiben (der Pruefstand liest sie).
        if let Some(line) = probe_line {
            eprintln!("pulse-player: Sitzung {id}{line}");
        }
        // Der Ton ebenfalls in einer eigenen Zeile, aus demselben Grund.
        //
        // **Warum ueberhaupt:** Die Zahlen liegen seit jeher an (`counters()`
        // → `MediaStats`), gingen aber nur ins Overlay — und wer beim Zuschauen
        // die Maus bewegt, um sie zu lesen, veraendert die Messung. Beim
        // Knacksen wurde deshalb bisher geraten. Ein Unterlauf ist genau das,
        // was man hoert: der Geraete-Rueckruf fand zu wenig im Ring und hat mit
        // Stille aufgefuellt. Steigen stattdessen die verworfenen Samples,
        // liegt es am anderen Ende — es kommt mehr an, als ausgegeben wird.
        let media = &st.media;
        if media.audio_active || media.audio_underruns > 0 {
            // `concat!` wie oben, nicht `\` am Zeilenende — aus demselben Grund.
            eprintln!(
                concat!(
                    "pulse-player: Sitzung {}: Ton — Unterlaeufe {}, verworfen {}, ",
                    "Puffer {} Samples"
                ),
                id, media.audio_underruns, media.audio_dropped, media.audio_buffered,
            );
        }
        session.last_log = Some(now);
        session.presented_at_last_log = presented;
    }

    /// Setzt um, was im Fenster bedient wurde.
    fn apply_overlay_action(&mut self, id: u64, action: OverlayAction) {
        match action {
            OverlayAction::Volume(volume) => {
                // Denselben Weg wie die RPC-Operation nehmen, damit es nur EINE
                // Stelle gibt, die Optionen anwendet.
                self.apply_options(id, PlayerOptions { volume: Some(volume), ..Default::default() });
                // Nach vorne melden: die App haelt die Lautstaerke je Streamer
                // dauerhaft, und ohne diese Meldung waere ein Regeln im Fenster
                // beim naechsten Oeffnen wieder weg.
                self.stdout.send(&Event::new(
                    "player:option",
                    serde_json::json!({ "session": id, "volume": volume }),
                ));
            }
            OverlayAction::Fullscreen(on) => {
                let Some(session) = self.sessions.get(&id) else { return };
                session.window.set_fullscreen(
                    on.then(|| winit::window::Fullscreen::Borderless(None)),
                );
                session.window.request_redraw();
            }
            // Zurueck in die Kachel — dasselbe wie das Fensterkreuz (der
            // Reattach-Knopf existiert nur, wenn `can_reattach` ohnehin gilt,
            // s. `overlay/controls.rs`): gemeinsame Entscheidung in
            // `on_window_closed`, damit beide Wege nicht auseinanderlaufen
            // koennen.
            OverlayAction::Reattach => self.on_window_closed(id),
            // „Diesen Stream nicht mehr ansehen." Der Unterschied zu `Reattach`
            // liegt allein in der Meldung nach vorne: die App schliesst darauf
            // die Kachel, statt das Bild zurueckzuholen. Ohne diese
            // Unterscheidung war ein erzwungenes Fenster nicht loszuwerden — es
            // ging sofort wieder auf.
            OverlayAction::Close => {
                self.stdout.send(&Event::new(
                    "player:closeRequest",
                    serde_json::json!({ "session": id }),
                ));
                self.emit_state(id, SessionState::Closed, None);
                self.close_session(id);
            }
            // Der Chat lebt in der App. Hier nur die Bitte, ihn zu zeigen —
            // ihn im Fenster nachzubauen hiesse Nachrichtenliste, Eingabe und
            // eine eigene Serververbindung zu doppeln.
            OverlayAction::Chat => {
                self.stdout.send(&Event::new(
                    "player:chatRequest",
                    serde_json::json!({ "session": id }),
                ));
            }
            OverlayAction::ToggleStats => {
                let Some(session) = self.sessions.get_mut(&id) else { return };
                if let Some(overlay) = session.overlay.as_mut() {
                    overlay.toggle_stats();
                }
                session.window.request_redraw();
            }
        }
    }

    fn emit_state(&self, id: u64, state: SessionState, error: Option<&str>) {
        let mut data = serde_json::json!({ "session": id, "state": state.as_str() });
        if let (Some(err), Some(obj)) = (error, data.as_object_mut()) {
            obj.insert("error".into(), err.into());
        }
        self.stdout.send(&Event::new("player:state", data));
    }

    /// Fenster wurde OHNE den expliziten „Schliessen"-Knopf beendet — Titelleisten-
    /// Kreuz, Alt+F4, Fenstermanager, oder der Reattach-Knopf. Anders als bei
    /// `OverlayAction::Close` gibt es hier keine ausdrueckliche „nicht mehr
    /// ansehen"-Absicht, also muss aus `can_reattach` folgen, was gemeint ist:
    /// Steht ein Zurueck zur Verfuegung, heisst das Ende nur „Bild zurueck in
    /// die Kachel" (die App holt es beim `closed`-Zustand automatisch ab, kein
    /// `closeRequest` noetig). Bei einem erzwungenen Fenster (10 bit, kein
    /// Zurueck moeglich) gibt es dieses Zurueck nicht — bliebe die Meldung hier
    /// gleich, wuerde die App weiter `active` halten und das Fenster ueber
    /// `ensure()` prompt neu oeffnen (der eigentliche Fehler). EINE Stelle fuer
    /// die Entscheidung, damit OS-Schliessweg und Reattach-Knopf nicht
    /// auseinanderlaufen koennen.
    fn on_window_closed(&mut self, id: u64) {
        let can_reattach = self.sessions.get(&id).is_some_and(|s| s.can_reattach);
        if !can_reattach {
            self.stdout.send(&Event::new(
                "player:closeRequest",
                serde_json::json!({ "session": id }),
            ));
        }
        self.emit_state(id, SessionState::Closed, None);
        self.close_session(id);
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
                if session.options.paused.unwrap_or(false) {
                    return;
                }
                // Wartet noch ein ungezeichnetes Bild, dann zeichne es JETZT,
                // statt es zu verwerfen: winit fasst mehrere `request_redraw`
                // eines Durchlaufs zu EINEM Zeichnen zusammen, treffen also
                // zwei Bilder im selben Durchlauf ein, ueberlebte vorher nur
                // das zweite. Gemessen gingen so bei 144 ankommenden Bildern
                // rund 95 je Sekunde verloren, obwohl ein Durchgang nur 0,4 ms
                // braucht.
                //
                // Das passiert VOR der Uebernahme der Farbwerte des neuen
                // Bildes — sonst wuerde das alte Bild mit fremdem Wertebereich
                // oder fremder Matrix gezeichnet (sichtbar falsche Farben, s.
                // die Pause-Begruendung oben).
                if self.sessions.get(&id).is_some_and(|s| s.pending.is_some()) {
                    let actions = self.draw(id);
                    for action in actions {
                        self.apply_overlay_action(id, action);
                    }
                    // Kommt der Player trotzdem nicht mit (sehr hohe Bildrate,
                    // langsame GPU), bleibt das Verwerfen der Ausweg — dann
                    // aber gezaehlt.
                    if let Some(session) = self.sessions.get_mut(&id) {
                        if session.pending.is_some() {
                            session.frames_never_drawn += 1;
                        }
                    }
                }
                let Some(session) = self.sessions.get_mut(&id) else { return };
                session.last_frame_at = Some(std::time::Instant::now());
                session.full_range = frame.full_range;
                session.matrix = frame.matrix;
                session.pending = Some(frame);
                session.window.request_redraw();
            }
            SessionEvent::Stats(stats) => {
                session.stats = stats;
                self.log_stats_if_due(id);
                let Some(session) = self.sessions.get_mut(&id) else { return };
                if let Some(overlay) = session.overlay.as_mut() {
                    overlay.mark_stats_dirty();
                }
                // Nur dann: bei ausgeblendetem Overlay traegt ein Neuzeichnen
                // nichts bei, und das Bild treibt seine Durchgaenge selbst.
                if session.overlay.as_ref().is_some_and(Overlay::wants_redraw) {
                    session.window.request_redraw();
                }
            }
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
        if let Some(session) = self.sessions.get_mut(&id) {
            // egui zuerst sehen lassen: es braucht auch Groessen- und
            // Skalierungswechsel. Sein `consumed` wird bewusst NICHT beachtet —
            // die drei Faelle unten (Schliessen, Groesse, Zeichnen) gehoeren
            // uns, egui reklamiert nur Zeiger- und Tastenereignisse.
            let repaint = session
                .overlay
                .as_mut()
                .is_some_and(|o| o.on_window_event(&session.window, &event));
            // Nur wenn gerade KEINE Bilder fliessen — sonst zeichnet das
            // naechste Bild das Overlay ohnehin mit (s. `FRAME_FLOW_WINDOW`).
            let frames_flowing =
                session.last_frame_at.is_some_and(|t| t.elapsed() < FRAME_FLOW_WINDOW);
            if repaint && !frames_flowing {
                session.window.request_redraw();
            }
        }
        match event {
            WindowEvent::CloseRequested => {
                // Der Nutzer hat das Fenster ueber das OS geschlossen (Kreuz,
                // Alt+F4, Fenstermanager) — dieselbe Entscheidung wie beim
                // Reattach-Knopf, s. `on_window_closed`.
                self.on_window_closed(id);
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
                let actions = self.draw(id);
                for action in actions {
                    self.apply_overlay_action(id, action);
                }
            }
            _ => {}
        }
    }
}

