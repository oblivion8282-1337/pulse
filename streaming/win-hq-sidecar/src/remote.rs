//! Remote-Control-Controller — Modus A (geteilter Encode).
//!
//! Der reguläre RTMPS-Stream läuft unverändert weiter; parallel wird derselbe
//! encodete H.264-Bitstrom über eine WebRTC-`RemoteSession`
//! (`pulse-remote-webrtc`) an den Controller gefüttert. Der Encode-Loop ist
//! synchron, webrtc-rs ist async — diese Brücke löst das über:
//!
//! - **Data-Plane (heiß)**: `tee_packet` läuft im Encode-Thread. Bei INAKTIVER
//!   Session kostet es genau einen relaxed `AtomicBool`-Load und kehrt sofort
//!   zurück (kein Lock, keine Kopie, kein Overhead). Nur bei aktiver Session
//!   wird der Frame kopiert und über eine **bounded** tokio-mpsc-Queue
//!   (`try_send`, non-blocking, volle Queue → Frame droppen) an einen
//!   Runtime-Task gereicht, der `feed_frame().await` aufruft. NIEMALS
//!   `block_on` im Encode-Thread.
//! - **Control-Plane (kalt)**: `start_session`/`handle_signal`/`stop_session`
//!   laufen im Dispatch-Thread (stdin-Loop, single-threaded) und dürfen daher
//!   `runtime.block_on(...)` nutzen — das sind seltene, schnelle Setup-Calls
//!   (SDP-Answer, ICE-Add), keine Netzwerk-Warteschleifen (Trickle-ICE).
//!
//! Singleton analog `StreamController`, aber bewusst NICHT damit verschmolzen:
//! dessen „genau ein Stream"-Invariante passt nicht auf eine unabhängige
//! Steuer-Session.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use ffmpeg_next as ffmpeg;
use serde_json::{Map, Value, json};
use tokio::runtime::{Builder, Runtime};
use tokio::sync::mpsc;

use pulse_remote_webrtc::{IceServer, RemoteSession, SessionConfig};

use crate::events;
use crate::remote_input::InputInjector;

/// Tiefe der Frame-Queue zwischen Encode-Thread und Feed-Task. Klein gehalten:
/// bei einem Feed-Stall ist Aktualität wichtiger als Vollständigkeit — ältere
/// Frames werden verworfen (`try_send` scheitert → Drop), der nächste Keyframe
/// (GOP = 2 s) resynchronisiert den Viewer ohnehin. 8 ≈ 66–133 ms bei 60–120fps.
const FRAME_QUEUE_CAPACITY: usize = 8;

/// Ein encodeter Frame auf dem Weg vom Encode-Thread zum Feed-Task.
struct RemoteFrame {
    data: Bytes,
    duration: Duration,
}

/// State einer laufenden Session. Lebt hinter dem `inner`-Mutex.
struct Active {
    /// Geteilt zwischen Dispatch-Thread (Signaling) und Feed-Task — daher `Arc`.
    session: Arc<RemoteSession>,
    /// Producer-Ende der Frame-Queue; `try_send` aus dem Encode-Thread.
    frame_tx: mpsc::Sender<RemoteFrame>,
    /// Der Task, der die Queue leert und `feed_frame` aufruft.
    feed_task: tokio::task::JoinHandle<()>,
    /// Input-Injektor — eine Referenz lebt zusätzlich im `on_input`-Callback.
    /// Beim Stop rufen wir `release_all()` (keine hängenden Tasten/Klicks).
    injector: Arc<InputInjector>,
}

pub struct RemoteController {
    /// Lazy gebaut — erst wenn wirklich eine Session startet. So spinnt reines
    /// Streaming (ohne Remote) NIE eine tokio-Runtime hoch.
    runtime: OnceLock<Runtime>,
    /// Schnelles Gate für den Encode-Thread. `Relaxed` reicht: ein verpasster
    /// Frame am Start/Stop-Rand ist folgenlos (Video, nächster Keyframe heilt).
    active: AtomicBool,
    /// Vom PLI/FIR-Callback gesetzt (Controller braucht ein Keyframe), vom
    /// Encode-Thread beim nächsten Frame konsumiert → IDR forcen.
    force_keyframe: AtomicBool,
    inner: Mutex<Option<Active>>,
}

impl RemoteController {
    pub fn singleton() -> &'static RemoteController {
        static INSTANCE: OnceLock<RemoteController> = OnceLock::new();
        // Billige Konstruktion (kein Thread, keine Runtime) — die `tee_packet`-
        // Prüfung darf diese Funktion pro Frame aufrufen.
        INSTANCE.get_or_init(|| RemoteController {
            runtime: OnceLock::new(),
            active: AtomicBool::new(false),
            force_keyframe: AtomicBool::new(false),
            inner: Mutex::new(None),
        })
    }

    /// Encode-Thread-Gate. Ein einzelner relaxed Load — Null-Overhead-Pfad.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    /// Vom PLI/FIR-Callback der Session gesetzt: der Controller braucht (jetzt)
    /// ein Keyframe — beim Verbindungsstart und nach Paketverlust.
    pub fn request_keyframe(&self) {
        self.force_keyframe.store(true, Ordering::Relaxed);
    }

    /// Der Encode-Thread prüft dies VOR dem Encode: gibt `true` genau einmal
    /// zurück, wenn ein Keyframe erbeten wurde (und setzt das Flag zurück). Ein
    /// einzelner Atomic-Swap; bei nichts angefragt folgenloser `false`.
    pub fn take_keyframe_request(&self) -> bool {
        self.force_keyframe.swap(false, Ordering::Relaxed)
    }

    /// Eigene Multi-Thread-Runtime für webrtc-rs. Multi-Thread ist nötig, weil
    /// die Session-Tasks (ICE/DTLS/SRTP/RTP-Pacing) im Hintergrund laufen
    /// müssen, auch während der Dispatch-Thread NICHT in `block_on` steht.
    /// Zwei Worker reichen — die Last ist leicht, der Encode läuft außerhalb.
    fn runtime(&self) -> &Runtime {
        self.runtime.get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("remote-rt")
                .enable_all()
                .build()
                .expect("build remote tokio runtime")
        })
    }

    /// Baut eine neue Session aus den `remote_start`-Params (ICE/TURN) und
    /// startet den Feed-Task. Fehler, wenn schon eine Session läuft.
    pub fn start_session(&self, params: &Map<String, Value>) -> Result<()> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return Err(anyhow!("remote session already active; stop it first"));
        }

        let ice_servers = parse_ice_servers(params);
        let (frame_tx, frame_rx) = mpsc::channel::<RemoteFrame>(FRAME_QUEUE_CAPACITY);
        // Injektor an die Quelle des laufenden Streams binden (Koordinaten-Mapping).
        // Eine Referenz geht in den `on_input`-Callback (webrtc-Task), eine bleibt
        // in `Active` für das Release-all beim Stop.
        let injector = Arc::new(InputInjector::for_active_stream());
        let config = SessionConfig {
            ice_servers,
            on_input: {
                let inj = Arc::clone(&injector);
                Arc::new(move |data: Bytes| inj.handle(&data))
            },
            // Lokaler ICE-Kandidat → als Event raus, das Signaling relayt ihn.
            on_local_ice: Arc::new(|json_candidate: String| {
                events::emit(json!({
                    "ev": "remote_signal",
                    "kind": "ice",
                    "data": json_candidate,
                }));
            }),
            on_state: Arc::new(|state: String| {
                // Backstop: bei terminalem WebRTC-Zustand Input freigeben + Tee
                // stilllegen, falls der Renderer kein `remote_stop` mehr schickt
                // (Browser-Crash). Der volle Teardown folgt über remote_stop/Exit.
                RemoteController::singleton().note_connection_state(&state);
                events::emit(json!({"ev": "remote_state", "state": state}));
            }),
            // PLI/FIR vom Controller → Keyframe-Flag setzen; der Encode-Thread
            // forced beim nächsten Frame ein IDR (behebt Startverzögerung +
            // Verlust-Recovery, statt bis zum nächsten GOP-Keyframe zu warten).
            on_keyframe_request: Arc::new(|| {
                RemoteController::singleton().request_keyframe();
            }),
        };

        // Setup ist async → im Dispatch-Thread per block_on (kalt, schnell).
        let rt = self.runtime();
        let session = Arc::new(
            rt.block_on(RemoteSession::new(config))
                .context("RemoteSession::new")?,
        );

        let feed_session = Arc::clone(&session);
        let feed_task = rt.spawn(feed_loop(feed_session, frame_rx));

        *guard = Some(Active { session, frame_tx, feed_task, injector });
        // Erst NACH dem vollständigen Setup scharf schalten — vorher greift der
        // Tee nicht (is_active == false), der Encode-Thread bleibt unberührt.
        self.active.store(true, Ordering::Release);
        Ok(())
    }

    /// Ein Signaling-Frame vom Controller: `offer` → Answer-Event, `ice` → add.
    /// Läuft im Dispatch-Thread; der `inner`-Lock wird VOR `block_on`
    /// freigegeben, damit Netzwerk-I/O nicht den Encode-Push (`push_frame`) oder
    /// `stop_session` blockiert.
    pub fn handle_signal(&self, kind: &str, data: &str) -> Result<()> {
        let session = {
            let guard = self.inner.lock().unwrap();
            let active = guard
                .as_ref()
                .ok_or_else(|| anyhow!("no active remote session for signal {kind:?}"))?;
            Arc::clone(&active.session)
        };

        let rt = self.runtime();
        match kind {
            "offer" => {
                let answer = rt
                    .block_on(session.handle_offer(data))
                    .context("handle_offer")?;
                events::emit(json!({
                    "ev": "remote_signal",
                    "kind": "answer",
                    "data": answer,
                }));
            }
            "ice" => {
                rt.block_on(session.add_ice(data)).context("add_ice")?;
            }
            other => return Err(anyhow!("unknown remote signal kind: {other}")),
        }
        Ok(())
    }

    /// Beendet die Session: Tee sofort scharf ab, Queue schließen (Feed-Task
    /// endet), PeerConnection schließen, Task abbrechen. Idempotent.
    pub fn stop_session(&self) -> Result<()> {
        self.active.store(false, Ordering::Release);
        self.force_keyframe.store(false, Ordering::Relaxed); // kein Leak in die nächste Session
        let active = self.inner.lock().unwrap().take();
        if let Some(active) = active {
            // Injektor stilllegen (poison ZUERST, dann Freigabe) BEVOR die Session
            // verschwindet — sonst re-injiziert eine späte Key-Down-Nachricht nach
            // dem Freigeben, oder eine Taste bliebe im Host „hängen".
            active.injector.disable();
            // frame_tx droppen → Feed-Loop sieht `None` und endet.
            drop(active.frame_tx);
            let _ = self.runtime().block_on(active.session.close());
            active.feed_task.abort();
        }
        Ok(())
    }

    /// Nur Input freigeben + Tee stilllegen — OHNE `close()`/`block_on`, also aus
    /// JEDEM Kontext sicher (webrtc-rs-Task, Exit-Pfad). Der volle Teardown ist
    /// `stop_session`; dies ist der Backstop, der garantiert keine Taste hängen
    /// lässt, auch wenn `stop_session` nicht mehr läuft.
    fn release_input_now(&self) {
        self.force_keyframe.store(false, Ordering::Relaxed);
        if let Ok(guard) = self.inner.lock() {
            if let Some(active) = guard.as_ref() {
                active.injector.disable();
            }
        }
        self.active.store(false, Ordering::Release);
    }

    /// Vom `on_state`-Callback. `failed`/`closed` sind terminal → Input sofort
    /// freigeben (Backstop). `disconnected` ist transient (ICE erholt sich oft) →
    /// bewusst ignoriert; der Controller-Grace + ein späteres `failed` fangen es.
    pub fn note_connection_state(&self, state: &str) {
        if matches!(state, "failed" | "closed") {
            self.release_input_now();
        }
    }

    /// Für Prozess-Exit-Pfade (stdin-EOF / Fehler-Exit): gibt Input frei, ohne auf
    /// `close()` zu warten. SendInput-Key-Downs sind globaler OS-Zustand und
    /// überleben den Prozesstod — ohne das bliebe eine Taste nach dem Exit gedrückt.
    pub fn release_on_exit(&self) {
        self.release_input_now();
    }

    /// Schiebt einen encodeten Frame in die Queue. Non-blocking: volle Queue →
    /// Frame droppen (Video, kein Muss). Wird nur bei aktiver Session erreicht
    /// (der Aufrufer prüft `is_active` vorher); der Lock ist unumstritten (nur
    /// dieser Thread schiebt, der Feed-Task nutzt das mpsc-Receiver-Ende).
    fn push_frame(&self, frame: RemoteFrame) {
        if let Ok(guard) = self.inner.lock() {
            if let Some(active) = guard.as_ref() {
                let _ = active.frame_tx.try_send(frame);
            }
        }
    }
}

/// Der Feed-Task: leert die Queue und gibt jeden Frame an den WebRTC-Track.
/// Ein einzelner `feed_frame`-Fehler killt die Session NICHT — nur loggen und
/// weiter (transienter Track-Fehler soll den Stream nicht abreißen lassen).
async fn feed_loop(session: Arc<RemoteSession>, mut rx: mpsc::Receiver<RemoteFrame>) {
    while let Some(frame) = rx.recv().await {
        if let Err(e) = session.feed_frame(frame.data, frame.duration).await {
            eprintln!("[remote] feed_frame failed: {e:#}");
        }
    }
}

/// **Tee-Punkt** — aus dem Encode-Thread direkt vor `mux.send` aufgerufen.
///
/// Bei inaktiver Session: ein relaxed `AtomicBool`-Load, dann `return`. Kein
/// Lock, keine Kopie — der RTMPS-Pfad bleibt byte-identisch und ungebremst.
/// Nur bei aktiver Session wird die Access-Unit kopiert (`packet.data()` ist
/// Annex-B, unverändert vom vorherigen `rescale_ts` — das berührt nur die
/// Timestamps) und mit `duration = 1/fps` (aus der Encoder-Timebase) in die
/// Queue gereicht.
pub fn tee_packet(packet: &ffmpeg::Packet, encoder_time_base: ffmpeg::Rational) {
    let ctrl = RemoteController::singleton();
    if !ctrl.is_active() {
        return;
    }
    let Some(bytes) = packet.data() else {
        return;
    };
    let (num, den) = (encoder_time_base.numerator(), encoder_time_base.denominator());
    let duration = if num > 0 && den > 0 {
        Duration::from_secs_f64(num as f64 / den as f64)
    } else {
        // Defensive: unplausible Timebase → ~60fps annehmen (nur RTP-Pacing).
        Duration::from_micros(16_667)
    };
    ctrl.push_frame(RemoteFrame {
        data: Bytes::copy_from_slice(bytes),
        duration,
    });
}

/// **Keyframe-Gate** — aus dem Encode-Thread VOR dem Encode aufgerufen. Gibt
/// `true` (genau einmal) zurück, wenn der Controller per PLI/FIR ein Keyframe
/// erbeten hat; der Aufrufer forced dann ein IDR. Bei inaktiver Session oder
/// ohne offene Anfrage ein folgenloser Atomic-Swap.
pub fn take_keyframe_request() -> bool {
    RemoteController::singleton().take_keyframe_request()
}

/// `ice_servers`-Array aus den `remote_start`-Params → `Vec<IceServer>`.
/// Fehlt es, bleibt die Liste leer (dann nur Host-/Server-Reflexive-Kandidaten;
/// das Signaling ist dafür verantwortlich, STUN/TURN mitzuliefern).
fn parse_ice_servers(params: &Map<String, Value>) -> Vec<IceServer> {
    params
        .get("ice_servers")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_ice_server).collect())
        .unwrap_or_default()
}

/// Ein einzelner ICE-Server-Eintrag. `urls` akzeptiert String ODER Array
/// (WebRTC-`RTCIceServer`-Konvention). Leere URL-Liste → Eintrag verworfen.
fn parse_ice_server(v: &Value) -> Option<IceServer> {
    let obj = v.as_object()?;
    let urls = match obj.get("urls") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|u| u.as_str().map(str::to_string))
            .collect::<Vec<_>>(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => return None,
    };
    if urls.is_empty() {
        return None;
    }
    let string_field = |k: &str| {
        obj.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(IceServer {
        urls,
        username: string_field("username"),
        credential: string_field("credential"),
    })
}
