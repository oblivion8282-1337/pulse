//! Stream controller — owns the single active capture→encode→push session.
//!
//! `start` spawns a worker thread that creates the [`Capturer`] + [`VideoEncoder`],
//! pumps BGRA frames through the encoder, and emits `state`/`fps`/`error`/`stopped`
//! events. `stop` signals the worker and joins it (the macOS sidecar stays warm
//! afterwards — no self-exit, unlike Windows). `state` returns a snapshot.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};

use crate::capture::{AudioFrame, Capturer, Postfach};
use crate::encode::VideoEncoder;
use crate::events;
use crate::proto::{Event, StreamState};

/// Resolved parameters for one stream (built by `ops::start` from the request).
pub struct StartParams {
    pub display_index: usize,
    /// When set, capture this single window instead of the display.
    pub window_id: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub codec: String,
    pub push_url: String,
    pub show_cursor: bool,
    pub enable_audio: bool,
    /// Audio capture scope (desktop-minus-excludes / specific app / none).
    pub audio_scope: crate::capture::AudioScope,
    /// Manual A/V trim in ms (UI slider). >0 shifts audio later. Applied to the
    /// audio anchor to correct any residual constant offset.
    pub av_offset_ms: i32,
}

pub struct StreamSnapshot {
    pub running: bool,
    pub state: String,
    pub fps: Option<f64>,
    pub uptime_s: Option<f64>,
    pub argv_redacted: Option<Vec<String>>,
}

struct Shared {
    running: AtomicBool,
    live: AtomicBool,
    /// fps × 1000 (atomic; the worker updates it once per second).
    fps_milli: AtomicU64,
    started_at: Mutex<Option<Instant>>,
}

struct Active {
    stop_tx: Sender<()>,
    worker: JoinHandle<()>,
    shared: Arc<Shared>,
    argv: Vec<String>,
}

pub struct StreamController {
    active: Mutex<Option<Active>>,
}

static INSTANCE: OnceLock<StreamController> = OnceLock::new();

fn emit(event: Event) {
    if let Ok(v) = serde_json::to_value(event) {
        events::emit(v);
    }
}

/// Setzt die Merker des Workers auch dann zurueck, wenn er **panict** —
/// das Abwickeln laeuft am regulaeren Pfad vorbei.
///
/// Ohne das bliebe `running = true` stehen, [`reap_finished`] griffe nie,
/// `state` meldete ewig „starting", und jeder neue `start` scheiterte mit
/// „ein Stream laeuft bereits".
///
/// **Abgeschaut vom Linux-Zwilling**, der genau diesen Fehler schon hatte
/// (`linux-hq-sidecar/src/stream_controller.rs`). Die Lehre war dort
/// aufgeschrieben und ist beim Bau des mac-Sidecars nicht mitgewandert.
struct WorkerDoneGuard(Arc<Shared>);

impl Drop for WorkerDoneGuard {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
        self.0.live.store(false, Ordering::SeqCst);
        if thread::panicking() {
            // Nur im Panik-Fall melden: auf dem regulaeren Weg hat der Worker
            // seine Ereignisse schon selbst geschickt, und ein zweites
            // `error` waere eine Falschmeldung.
            emit(Event::Error { message: "hq-stream-Faden abgestuerzt".to_string() });
            emit(Event::State { state: StreamState::Error, running: false, uptime_s: 0.0 });
        }
    }
}

/// Raeumt einen bereits beendeten, aber nie per `stop` abgeholten Strom ab.
///
/// Endet der Worker von selbst — Aufnahmequelle weg, Encoder-Fehler, eine
/// nicht laufende Ton-App —, setzt er nur `shared.running = false`; `active`
/// bleibt `Some`, denn nur `stop` ruft `take()`. Ohne dieses Einsammeln
/// scheitert der naechste `start` faelschlich mit „ein Stream laeuft bereits",
/// waehrend `state` gleichzeitig `running: false` meldet — der Sidecar sagt
/// also „es laeuft nichts" und verweigert den Start, weil etwas laeuft.
/// **Genau so am 2026-08-23 beim Zwei-Geraete-Test aufgefallen**, ausgeloest
/// von einer Ton-App, die nicht mehr lief.
///
/// `worker.join()` kehrt sofort zurueck, der Faden ist ja beendet. Wird nie
/// aus dem Worker selbst gerufen (nur aus `start`/`state`), also kein
/// Selbst-Join. Verlangt den gehaltenen `active`-Riegel.
fn reap_finished(guard: &mut Option<Active>) {
    let beendet = guard
        .as_ref()
        .is_some_and(|a| !a.shared.running.load(Ordering::SeqCst));
    if beendet {
        if let Some(tot) = guard.take() {
            let _ = tot.worker.join();
        }
    }
}

impl StreamController {
    pub fn singleton() -> &'static StreamController {
        INSTANCE.get_or_init(|| StreamController { active: Mutex::new(None) })
    }

    /// Start a stream. `argv` is the redacted diagnostic argv (for `state`).
    pub fn start(&self, params: StartParams, argv: Vec<String>) -> Result<()> {
        let mut guard = self.active.lock().unwrap();
        // **Diese Zeile ist von keinem Test gedeckt** (nachgemessen: ihre
        // Entfernung bleibt gruen). `start` verlangt echte Aufnahme, ein
        // Unit-Test kommt nicht hierher; geprueft ist nur `reap_finished`
        // selbst. Wer den Aufruf anfasst, hat kein Netz — der Weg dorthin
        // waere ein Pruefling wie `examples/probe_ziel` beim Zwilling.
        reap_finished(&mut guard);
        if guard.is_some() {
            return Err(anyhow!("ein Stream läuft bereits"));
        }
        // Eine Vollbild-Anforderung, die nach dem letzten Bild des vorigen
        // Streams eintraf, gehoert nicht diesem hier — und vor allem darf seine
        // Drossel den neuen Stream nicht sperren (Begruendung an
        // `keyframe::reset`). Zwilling: `win-hq-sidecar` ruft es an derselben
        // Stelle im Ablauf.
        crate::keyframe::reset();
        // Die Fernsteuerung braucht zu wissen, worauf dieser Strom zeigt.
        // **Der Platz bleibt `None`**: der mac-`start` liest keinen `slot`, und
        // damit gilt „ein Strom ohne erklaerten Platz traegt jeden Platz"
        // (Begruendung in `remote_input::ziel`).
        match crate::remote_input::ziel::quelle_aus(params.window_id, params.display_index) {
            Some(quelle) => crate::remote_input::ziel::strom_gestartet(None, quelle),
            None => eprintln!(
                "[remote-input] Aufnahmequelle nicht bestimmbar — dieser Strom traegt keine Fernsteuerung"
            ),
        }
        let (stop_tx, stop_rx) = channel::<()>();
        let shared = Arc::new(Shared {
            running: AtomicBool::new(true),
            live: AtomicBool::new(false),
            fps_milli: AtomicU64::new(0),
            started_at: Mutex::new(None),
        });
        let shared_worker = shared.clone();
        let worker = thread::Builder::new()
            .name("hq-stream".into())
            .spawn(move || {
                // Steht VOR `run_stream`, damit er auch eine Panik darin faengt.
                let _fertig = WorkerDoneGuard(shared_worker.clone());
                let result = run_stream(params, stop_rx, &shared_worker);
                // **Abmelden ist hier Pflicht, nicht Hoeflichkeit** — der
                // mac-Sidecar bleibt zwischen zwei Streams warm. Am Ende des
                // Workers und nicht in `stop`, weil der Strom auch von selbst
                // enden kann (Fehler, Quelle weg); `stop` wartet ohnehin auf
                // diesen Faden.
                crate::remote_input::ziel::strom_beendet();
                shared_worker.running.store(false, Ordering::SeqCst);
                shared_worker.live.store(false, Ordering::SeqCst);
                if let Err(e) = result {
                    emit(Event::Error { message: format!("{e:#}") });
                    emit(Event::State {
                        state: StreamState::Error,
                        running: false,
                        uptime_s: 0.0,
                    });
                }
                emit(Event::State {
                    state: StreamState::Stopped,
                    running: false,
                    uptime_s: 0.0,
                });
                emit(Event::Stopped { code: None });
            })
            .map_err(|e| {
                // **Die Anmeldung zuruecknehmen, wenn der Faden nicht kommt.**
                // Sie steht bewusst VOR der Spawn und wird nicht dahinter
                // geschoben: der Worker meldet am Ende ab, und ein sofort
                // scheiterndes `run_stream` koennte das tun, bevor eine
                // nachgelagerte Anmeldung ueberhaupt laeuft — dann bliebe eine
                // Leiche stehen. Hier ist die Reihenfolge eindeutig.
                crate::remote_input::ziel::strom_beendet();
                anyhow!("spawn hq-stream thread: {e}")
            })?;

        *guard = Some(Active { stop_tx, worker, shared, argv });
        Ok(())
    }

    /// Stop the active stream (idempotent). Blocks until the worker has finished
    /// flushing + closing the RTMP connection.
    pub fn stop(&self) -> Result<()> {
        let active = self.active.lock().unwrap().take();
        if let Some(active) = active {
            let _ = active.stop_tx.send(());
            let _ = active.worker.join();
        }
        Ok(())
    }

    pub fn state(&self) -> StreamSnapshot {
        let mut guard = self.active.lock().unwrap();
        // Auch hier einsammeln: sonst meldet die Auskunft einen toten Strom
        // als „starting", bis jemand von Hand stoppt.
        reap_finished(&mut guard);
        match guard.as_ref() {
            Some(a) => {
                let running = a.shared.running.load(Ordering::SeqCst);
                let live = a.shared.live.load(Ordering::SeqCst);
                let fps = a.shared.fps_milli.load(Ordering::SeqCst) as f64 / 1000.0;
                let uptime = a
                    .shared
                    .started_at
                    .lock()
                    .unwrap()
                    .map(|t| t.elapsed().as_secs_f64());
                StreamSnapshot {
                    running,
                    state: if live { "live" } else { "starting" }.to_string(),
                    fps: if fps > 0.0 { Some(fps) } else { None },
                    uptime_s: uptime,
                    argv_redacted: Some(a.argv.clone()),
                }
            }
            None => StreamSnapshot {
                running: false,
                state: "idle".to_string(),
                fps: None,
                uptime_s: None,
                argv_redacted: None,
            },
        }
    }
}

/// Worker body: capture → encode → push until stopped.
fn run_stream(params: StartParams, stop_rx: std::sync::mpsc::Receiver<()>, shared: &Shared) -> Result<()> {
    *shared.started_at.lock().unwrap() = Some(Instant::now());
    emit(Event::State {
        state: StreamState::Starting,
        running: true,
        uptime_s: 0.0,
    });

    // Die Bild-Post (Ein-Slot, neuestes gewinnt): der ungebundene Kanal von
    // vorher konnte bei blockiertem Verbraucher hunderte zurueckbehaltene
    // 4K-Puffer aufstauen — Begruendung in `capture::postfach`.
    let bildpost = Arc::new(Postfach::neu());
    let (audio_tx, audio_rx) = if params.enable_audio {
        let (t, r) = channel::<AudioFrame>();
        (Some(t), Some(r))
    } else {
        (None, None)
    };
    let cap = Capturer::start(
        params.display_index,
        params.window_id,
        params.audio_scope.clone(),
        params.width as usize,
        params.height as usize,
        params.fps,
        params.show_cursor,
        bildpost.clone(),
        audio_tx,
    )?;
    let mut enc = VideoEncoder::start(
        &params.push_url,
        params.width,
        params.height,
        params.fps,
        params.bitrate_kbps,
        &params.codec,
        params.enable_audio,
    )?;

    shared.live.store(true, Ordering::SeqCst);
    let started = Instant::now();
    // Manual A/V trim: ms → samples (48 @ 48kHz). >0 shifts audio later.
    let audio_offset_samples = params.av_offset_ms as i64 * 48;
    // A/V sync anchors on the capture timestamps (CMSampleBuffer PTS — the same
    // host clock for video + audio), NOT on processing time. Using emit/drain
    // wall-clock skewed audio ~300ms late (SCK audio buffering + FIFO latency).
    // `epoch_s` = first media sample seen; video duplicates project the last
    // real frame's capture time forward by the wall clock since it arrived.
    let mut epoch_s = f64::NAN;
    let mut last_frame_pts_s = 0.0_f64;
    let mut last_frame_at = Instant::now();
    emit(Event::State {
        state: StreamState::Live,
        running: true,
        uptime_s: 0.0,
    });

    // Sendetakt — zwei Arten, je nachdem, wer zusieht:
    //
    // * **ZUSEHEN**: festes Raster. Alle `frame_interval` geht das neueste Bild
    //   hinaus, identisch dupliziert, wenn die Quelle stillsteht. Das Raster
    //   glaettet, und SCK liefert bei statischem Bild gar nichts — ohne die
    //   stete Ausgabe kroeche die Medienzeit hinter der Wanduhr her und
    //   MediaMTX naehme den Publish erst nach seinem 10-s-readTimeout an (der
    //   seinerzeitige „i/o timeout"-Fehler); Ton ist immer echtzeit, das Bild
    //   muss mit ihm Schritt halten.
    // * **FERNSTEUERUNG**: Versand bei ANKUNFT. Ein frisch erfasstes Bild
    //   wartet nicht auf den naechsten Rasterschlag — der kostete im Mittel
    //   einen halben Bildabstand (8,3 ms bei 60 fps), und beim Steuern zahlt
    //   der geschlossene Kreis aus Eingabe hin und Bild zurueck (Herleitung
    //   und A/B-Zahlen: `win-hq-sidecar/src/pipeline_hw/warten.rs`, derselbe
    //   Umbau dort vom 2026-08-13). Die Frist bleibt als Herzschlag stehen:
    //   Kommt laenger als ein Bildabstand nichts, geht das letzte Bild
    //   dupliziert hinaus — MediaMTX und A/V-Sync brauchen das auch mitten in
    //   einer Sitzung mit stillstehendem Bild.
    //
    //   **Keine PTS-Platz-Bremse wie im Zwilling** (`Bildplatz::traegt` haelt
    //   dort die Encoderate auf fps): SCK liefert wegen des
    //   `setMinimumFrameInterval` oben ohnehin hoechstens alle `frame_interval`
    //   ein Bild — oefter als die Zielrate kann nichts ankommen. Trottet eine
    //   Ankunft dennoch knapp hinter einem Herzschlag her (Uhrendrift zwischen
    //   Display- und Wanduhr), geht sie sofort hinaus; `push_pixel_buffer`
    //   klemmt den pts monoton, ein Zusammenrasseln bleibt folgenlos.
    //
    //   A/B-Notausgang, wortgleich mit dem Zwilling:
    //   `PULSE_HQ_FERN_TICKRASTER=1` erzwingt das feste Raster auch waehrend
    //   einer Fernsteuerung.
    let frame_interval = Duration::from_secs_f64(1.0 / params.fps.max(1) as f64);
    let fern_sofort = !crate::remote_input::ziel::schalter_an("PULSE_HQ_FERN_TICKRASTER");
    let mut next_emit = Instant::now();
    // Ein Bild ist seit dem letzten Versand angekommen — egal ob im Abholen
    // oder im Wartefenster darunter. Nur der Fern-Wert versendet daraufhin
    // sofort; das Zusehen-Raster ignoriert ihn.
    let mut frisch = false;
    let mut last_frame = None;
    let mut window_start = Instant::now();
    let mut window_frames = 0u64;

    let run_result = (|| -> Result<()> {
        loop {
            // Stop requested?
            match stop_rx.try_recv() {
                Ok(()) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
            // Fernsteuerung aktiv? Pro Runde neu gelesen — der Sendetakt
            // wechselt mit der Sitzung, nicht mit dem Stream.
            let fern = fern_sofort && crate::remote_input::fern_aktiv();
            // Drain pending audio (non-blocking). Anchor the first frame to the
            // audio sample's own capture pts (shared epoch with video) + the
            // manual trim — so audio sits where it was captured, not where it
            // was drained.
            if let Some(arx) = &audio_rx {
                while let Ok(af) = arx.try_recv() {
                    if epoch_s.is_nan() {
                        epoch_s = af.pts_seconds;
                    }
                    let anchor = ((af.pts_seconds - epoch_s) * 48_000.0).round() as i64
                        + audio_offset_samples;
                    enc.push_audio(&af.samples, anchor)?;
                }
            }
            // Das frischeste Bild aus der Post nehmen. Ein-Slot: das Fach hat
            // bereits alles Aeltere verworfen — der Loop sieht nach einem Stau
            // den NEUESTEN Stand, nicht den Stall-Anfang; die pts + die
            // Ankunftszeit gehoeren zur Duplikat-Fortschreibung. `frisch`
            // ueberlebt die Wartephase darunter: Ein Bild, das WAHREND des
            // Wartens ankommt, geht in der naechsten Runde sofort hinaus
            // (Fern) — nicht erst zur Frist.
            if let Some(f) = bildpost.nehmen() {
                if epoch_s.is_nan() {
                    epoch_s = f.pts_seconds;
                }
                last_frame_pts_s = f.pts_seconds;
                last_frame_at = Instant::now();
                last_frame = Some(f);
                frisch = true;
            }

            let now = Instant::now();
            // Versand: zur Frist (Zusehen-Raster oder Fern-Herzschlag) — oder,
            // nur waehrend einer Fernsteuerung, sofort bei frischer Ankunft.
            if now >= next_emit || (fern && frisch) {
                // Neuestes Bild hinaus, identisch dupliziert bei stehender
                // Quelle (SCK liefert dann nichts). Zero-Copy:
                // `retained_ptr()` reicht den zurueckbehaltenen CVPixelBuffer
                // direkt an den Encoder. Vor dem ersten Bild wird nur gewartet
                // (kein Schwarz-Vorlauf auf dem hw-Weg); SCK liefert es ein,
                // zwei Bildabstaende nach dem Start.
                if let Some(f) = &last_frame {
                    // Video pts from the frame's capture time (shared epoch with
                    // audio → A/V sync), projecting the last real frame forward by
                    // the wall clock since it arrived so static-screen duplicates
                    // keep advancing. push_pixel_buffer clamps it monotonic.
                    let cap_s = last_frame_pts_s + last_frame_at.elapsed().as_secs_f64();
                    let pts_v = ((cap_s - epoch_s) * params.fps as f64).round().max(0.0) as i64;
                    enc.push_pixel_buffer(f.retained_ptr(), pts_v)?;
                    window_frames += 1;
                    if window_start.elapsed() >= Duration::from_secs(1) {
                        let fps = window_frames as f64 / window_start.elapsed().as_secs_f64();
                        shared.fps_milli.store((fps * 1000.0) as u64, Ordering::SeqCst);
                        emit(Event::Fps {
                            fps,
                            uptime_s: started.elapsed().as_secs_f64(),
                        });
                        window_start = Instant::now();
                        window_frames = 0;
                    }
                }
                // Die Frist zieht erst weiter, wenn diese Runde ein Bild
                // hinausgeschickt hat (oder anlaufweise leer ausging) — ein
                // Durchlauf, der nur haelt, schiebt sie nicht vor sich her,
                // sonst bricht die Bildrate ein (selbe Lehre wie im Zwilling,
                // `bildplatz.rs`, Fehler vom 2026-08-22).
                next_emit = frist_nach_versand(fern, next_emit, now, frame_interval);
                frisch = false;
            } else {
                // Bis zur Frist warten oder bis ein Bild ankommt. Ein Kanalende
                // gibt es seit der Bild-Post nicht mehr: Die Post kennt keinen
                // Verbindungsabbruch, der Loop endet am stop_rx — und den
                // Stillstand der Quelle traegt der Herzschlag (Duplikat zur
                // Frist).
                match bildpost.warten_bis(next_emit) {
                    Some(f) => {
                        if epoch_s.is_nan() {
                            epoch_s = f.pts_seconds;
                        }
                        last_frame_pts_s = f.pts_seconds;
                        last_frame_at = Instant::now();
                        last_frame = Some(f);
                        frisch = true;
                    }
                    None => {}
                }
            }
        }
        // Drain any audio buffered after the last video frame.
        if let Some(arx) = &audio_rx {
            while let Ok(af) = arx.try_recv() {
                if epoch_s.is_nan() {
                    epoch_s = af.pts_seconds;
                }
                let anchor = ((af.pts_seconds - epoch_s) * 48_000.0).round() as i64
                    + audio_offset_samples;
                enc.push_audio(&af.samples, anchor)?;
            }
        }
        Ok(())
    })();

    // Teardown in order: stop capture, then flush + close the encoder/mux.
    cap.stop();
    let finish_result = enc.finish();
    run_result.and(finish_result)
}

/// Wie die Frist nach einem Rasterschlag weiterzieht — Fern und Zusehen
/// unterschiedlich:
///
/// * **Zusehen** bleibt im Raster (`frist + abstand`): genau diese
///   Phasen-Verankerung ist die Glaettung, um derentwegen das Raster existiert.
///   Liegt das Raster bereits zurueck (langer Encode-Stall), wird auf `jetzt`
///   resynct statt eine Aufholjagd zu fahren.
/// * **Fern** haengt die Frist an `jetzt`: Herzschlag und Bildabstands-Bremse
///   in einem. Sie wird erst nach einem echten Versand vergeben — ein
///   Durchlauf, der nur haelt, schiebt sie nicht vor sich her.
fn frist_nach_versand(fern: bool, frist: Instant, jetzt: Instant, abstand: Duration) -> Instant {
    if fern {
        jetzt + abstand
    } else {
        let raster = frist + abstand;
        if raster <= jetzt {
            jetzt + abstand
        } else {
            raster
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein `Active`, dessen Faden schon beendet ist — genau die Leiche, die
    /// ein von selbst gestorbener Strom hinterlaesst.
    fn beendeter_platz(running: bool) -> Active {
        let (stop_tx, _rx) = channel::<()>();
        let worker = thread::Builder::new().spawn(|| {}).expect("Faden");
        // Warten, bis er wirklich durch ist: sonst pruefte der Test eine
        // Gleichzeitigkeit statt der Regel.
        while !worker.is_finished() {
            std::hint::spin_loop();
        }
        Active {
            stop_tx,
            worker,
            shared: Arc::new(Shared {
                running: AtomicBool::new(running),
                live: AtomicBool::new(false),
                fps_milli: AtomicU64::new(0),
                started_at: Mutex::new(None),
            }),
            argv: Vec::new(),
        }
    }

    /// Die eigentliche Zusage: ein toter Strom blockiert den Platz nicht.
    ///
    /// Ohne sie meldet `state` `running: false` und `start` verweigert
    /// gleichzeitig mit „ein Stream laeuft bereits" — der Sidecar sagt „es
    /// laeuft nichts" und laesst trotzdem nichts starten.
    #[test]
    fn ein_beendeter_strom_wird_eingesammelt() {
        let mut platz = Some(beendeter_platz(false));
        reap_finished(&mut platz);
        assert!(platz.is_none(), "toter Strom blieb liegen");
    }

    /// Die Gegenprobe, und sie ist die wichtigere: ein LAUFENDER Strom darf
    /// nicht eingesammelt werden. Ein `reap_finished`, das immer raeumt,
    /// bestuende den Test oben und risse jeden laufenden Stream ab.
    #[test]
    fn ein_laufender_strom_bleibt_stehen() {
        let mut platz = Some(beendeter_platz(true));
        reap_finished(&mut platz);
        assert!(platz.is_some(), "laufender Strom wurde abgeraeumt");
    }

    /// Auf einem leeren Platz ist das Einsammeln ein Nichts-Tun — `start`
    /// ruft es bedingungslos.
    #[test]
    fn ein_leerer_platz_bleibt_leer() {
        let mut platz: Option<Active> = None;
        reap_finished(&mut platz);
        assert!(platz.is_none());
    }

    /// Zusehen: die Frist bleibt im Raster verankert — ein Versand, der nach
    /// dem Rasterschlag passiert, verschiebt die Phase nicht. Genau diese
    /// Verankerung ist die Glaettung des Zusehen-Wegs.
    #[test]
    fn zusehen_bleibt_im_raster_verankert() {
        let t0 = Instant::now();
        let abstand = Duration::from_millis(16);
        let frist = t0 + abstand;
        let jetzt = frist + Duration::from_millis(3);
        assert_eq!(
            frist_nach_versand(false, frist, jetzt, abstand),
            t0 + 2 * abstand,
            "die naechste Frist muss beim naechsten Rasterschlag liegen, nicht 3 ms dahinter"
        );
    }

    /// Zusehen hinter dem Raster: Resync auf jetzt statt Aufholjagd — der
    /// Rueckstand wuerde sonst mit jeder Runde weiter wachsen.
    #[test]
    fn zusehen_hinter_dem_raster_resynct() {
        let t0 = Instant::now();
        let abstand = Duration::from_millis(16);
        let frist = t0;
        let jetzt = t0 + 3 * abstand;
        assert_eq!(
            frist_nach_versand(false, frist, jetzt, abstand),
            jetzt + abstand,
            "drei Raster Rueckstand duerfen nicht aufgeholt werden"
        );
    }

    /// Fern: die Frist haengt am echten Versandzeitpunkt, nicht am Raster —
    /// eine Ankunft VOR der alten Frist verschiebt auch die naechste nach
    /// vorn. Das ist der Kern der Ereignissteuerung: die Frist folgt der
    /// Ankunft, das Raster hat dabei nichts zu sagen.
    #[test]
    fn fern_vergibt_die_frist_ab_jetzt() {
        let t0 = Instant::now();
        let abstand = Duration::from_millis(16);
        let frist = t0 + abstand;
        let versand = t0 + abstand - Duration::from_millis(5);
        assert_eq!(
            frist_nach_versand(true, frist, versand, abstand),
            versand + abstand,
            "die Frist muss ab dem Versand neu beginnen, nicht am alten Raster haengen"
        );
    }
}
