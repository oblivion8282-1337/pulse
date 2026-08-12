//! Stream-Controller — verwaltet den Capture-Encode-Push-Worker-Thread.
//!
//! Singleton (`StreamController::singleton()`) → genau eine aktive Stream-
//! Session zur Zeit (1:1 wie `gsr-sidecar/stream_controller.py`). Methoden:
//!
//! - `start(params)` — spawnt Worker, returnt sofort mit redaktierter argv
//!   (analog Linux). Worker emittiert `state`-Events (`starting`→`live`→
//!   `stopped`), `fps`-Events alle paar Sekunden, `log`/`error`-Events bei
//!   Bedarf.
//! - `stop()` — signalisiert dem Worker zu beenden. Worker schließt RTMP-
//!   Verbindung sauber (`encoder.finish()` schreibt FLV-Trailer).
//! - `state()` — gibt den aktuellen Zustand zurück (für `state`-Op).
//!
//! Threading-Modell: jede Methode hält den `state`-Mutex nur kurz; der Worker-
//! Thread läuft daneben und published Events asynchron via `crate::events::emit`.
//!
//! `run_cpu_pipeline` (der CPU-Encode-Loop, Intel/QSV + Fallback-Pfad) sitzt
//! wegen seiner Größe in einem eigenen Submodul, [`cpu_pipeline`] — hier bleibt
//! nur die Zustandsverwaltung (Start/Stop/Snapshot) und die Weiche, die pro
//! Adapter/Codec entscheidet, welche Pipeline läuft.

use anyhow::{Context, Result, anyhow};
use serde_json::json;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::audio::AudioSource;
use crate::capture::CaptureSource;
use crate::encode::{EncodePath, VideoCodec};
use crate::events;
use crate::profiles::StreamProfile;

mod cpu_pipeline;
mod helpers;
pub(crate) use cpu_pipeline::run_cpu_pipeline;
pub(crate) use helpers::{build_argv_redacted, emit_state, fit_within_box, zielmasse};
use helpers::select_adapter;

/// Wie lange `stop()` maximal auf das Auslaufen des Worker-Threads wartet,
/// bevor es ihn aufgibt. Der Worker terminiert nach dem Stop-Signal selbst
/// (`rw_timeout` im Encoder kappt jeden Netzwerk-Stall auf ~10 s) — dieser
/// Wert ist nur ein Sicherheitsnetz gegen einen wider Erwarten wedged Worker.
/// Bewusst unter dem `stop`-Op-Timeout in `sidecar.ts` (15 s).
const STOP_JOIN_TIMEOUT: Duration = Duration::from_secs(13);

/// Snapshot des Stream-Zustandes — was die `state`-Op zurückliefert.
#[derive(Debug, Clone)]
pub struct StreamSnapshot {
    pub running: bool,
    pub state: &'static str, // "idle" | "starting" | "live" | "error" | "stopped"
    pub fps: Option<f64>,
    pub uptime_s: Option<f64>,
    pub argv_redacted: Option<Vec<String>>,
}

impl StreamSnapshot {
    fn idle() -> Self {
        Self {
            running: false,
            state: "idle",
            fps: None,
            uptime_s: None,
            argv_redacted: None,
        }
    }
}

/// Felder die `start` aus dem JSON-Request bekommt (analog zu `start` in
/// `gsr-sidecar/control.py`).
#[derive(Debug, Clone)]
pub struct StartParams {
    /// Encoder-Sockel für alle nicht gesetzten Overrides (`profiles::BASELINE`).
    pub profile: &'static StreamProfile,
    /// Reines Etikett aus der `start`-Anfrage — taucht nur in der Diagnose-argv
    /// auf und beeinflusst die Encoder-Konfiguration nicht.
    pub profile_name: String,
    pub channel_id: String,
    pub token: String,
    pub push_url: String,
    pub capture: CaptureSource,
    /// Welchen **Stream-Platz** dieser Prozess bedient (`slot` aus der
    /// `start`-Anfrage). Nur die Fernsteuerung liest ihn: sie muss den Slot aus
    /// der Eingabe-Hülle in eine Aufnahmequelle auflösen
    /// (`remote_input::ziel`). `None` = nicht genannt, der heutige Regelfall —
    /// Electron fährt je Platz einen eigenen Sidecar
    /// (`desktop/electron/sidecar.ts::getSidecar`) und braucht die Nummer
    /// deshalb nicht mitzuschicken.
    pub slot: Option<u32>,
    pub audio: Option<AudioSource>,
    pub override_codec: Option<VideoCodec>,
    pub override_bitrate_kbps: Option<u32>,
    pub override_fps: Option<u32>,
    /// Auflösungs-BOX (z.B. 1920x1080), in die das Capture-Bild aspektwahrend
    /// eingepasst wird (`fit_within_box`) — ein 21:9-Monitor wird bei "1080p"
    /// also 1920x804, nicht auf 16:9 gestaucht. `None` = capture-native.
    /// Upscale gibt es nie (Box größer als Capture → native Maße).
    pub override_resolution: Option<(u32, u32)>,
    /// Mauszeiger im Stream zeigen. Default `true` (entspricht GSRs `-cursor yes`).
    /// `false` → WGC `CursorCaptureSettings::WithoutCursor`.
    pub show_cursor: bool,
    /// Konstanter A/V-Trim in ms (>0 = Audio später) aus dem UI-Slider. 0 =
    /// neutral. Reicht bis in die `AudioPipeline` durch (dort Sample-Offset).
    pub av_offset_ms: i32,
    /// 10 bit je Kanal statt 8 — der WUNSCH aus dem Request, nicht das
    /// Ergebnis. **Trägt der effektive Encode-Weg gar kein 10 bit (CPU oder
    /// D3D12), verweigert `run_pipeline` den Start**
    /// (`encode::zehnbit::pruefen`) — seit dem 2026-08-11, vorher fiel der
    /// Wunsch dort still auf 8 bit zurück. Innerhalb des D3D11-Zero-Copy-Wegs
    /// bleibt die feinere Rücknahme bestehen: trägt der gewählte CODEC 10 bit
    /// nicht ([`VideoCodec::supports_ten_bit`](crate::encode::VideoCodec::supports_ten_bit)
    /// sagt nur AV1 zu) oder verlangt ein angemeldeter Encode-Weg einen
    /// 8-bit-Pool, entscheidet `pipeline_hw` das weiterhin mit einer
    /// Log-Zeile statt einem Abbruch (`bildencoder::pool_wahl`) — dort ist
    /// „8 bit statt 10" die einzig sichtbare Abweichung, kein ganzer Weg, der
    /// die Bittiefe nicht kennt. Als `bool` statt als Bittiefe, damit hier
    /// keine 12 stehen kann, die nirgends behandelt wird — gleiche Form wie
    /// im Linux-Sidecar (`StartParams::ten_bit`).
    ///
    /// **Das Frontend schickt `bit_depth` heute nicht.** Der Weg ist nur über
    /// einen von Hand gebauten Request erreichbar (Labor, `/app/dev/stream`).
    /// Wer ihn in die Oberfläche holt, muss den Abbruch aus
    /// `encode::zehnbit::pruefen` im Renderer abfangen und anzeigen — sonst
    /// meldet ein Schalter dort einfach nichts, wenn der Sidecar ablehnt.
    pub ten_bit: bool,
    /// HDR senden: die Aufnahme in scRGB holen und als PQ/BT.2020 encodieren.
    ///
    /// **Anders als [`ten_bit`](Self::ten_bit) ist das kein Wunsch, der still
    /// zurückgenommen wird — unerfüllbar heißt hier Startverweigerung**
    /// (`encode::hdr::pruefen`). Der Grund steht dort ausführlich: 10 bit
    /// weniger zu bekommen als bestellt sieht man höchstens an einem Verlauf,
    /// SDR statt HDR sieht man am ganzen Bild, und beides ohne Meldung wäre
    /// eine Fehlersuche am falschen Ende.
    ///
    /// Schaltet 10 bit **selbst** ein: PQ in 8 bit wäre in jedem Verlauf
    /// sichtbar geringelt. Der Nutzer muss also nicht zwei Kästchen finden,
    /// die zusammengehören.
    pub hdr: bool,
    /// Die Angaben des aufgenommenen Bildschirms, sobald [`hdr`](Self::hdr)
    /// geprüft ist — Leuchtdichten und Primärvalenzen für die
    /// Mastering-Metadaten.
    ///
    /// **Wird vom Verteiler gesetzt, nicht vom Request.** Sie hier
    /// mitzuführen statt sie später ein zweites Mal abzufragen ist kein
    /// Zwischenspeichern aus Bequemlichkeit: der Nutzer kann HDR mitten im
    /// Stream umschalten, und zwei Abfragen könnten dann verschiedene
    /// Antworten geben — die Bildpunkte trügen die eine, die Metadaten die
    /// andere.
    pub schirm: Option<crate::system::hdr::SchirmFarbe>,
}

impl StartParams {
    /// Der effektiv gewählte Codec: Override schlägt Profil-Sockel.
    ///
    /// Stand wörtlich an vier Stellen, seit der Dispatcher ihn ebenfalls
    /// braucht. Das ist ab jetzt keine Bequemlichkeit mehr, sondern eine
    /// Bedingung: Dispatcher und Pipeline MÜSSEN dieselbe Codec-Entscheidung
    /// treffen, sonst landet ein Stream auf einem Pfad, der sich für einen
    /// anderen Codec hält.
    pub(crate) fn codec(&self) -> VideoCodec {
        self.override_codec
            .unwrap_or_else(|| VideoCodec::from_slug(self.profile.codec))
    }
}

pub struct StreamController {
    inner: Mutex<Inner>,
}

struct Inner {
    snapshot: StreamSnapshot,
    stop_tx: Option<Sender<()>>,
    worker: Option<JoinHandle<()>>,
    started_at: Option<Instant>,
}

impl StreamController {
    pub fn singleton() -> &'static StreamController {
        static INSTANCE: OnceLock<StreamController> = OnceLock::new();
        INSTANCE.get_or_init(|| StreamController {
            inner: Mutex::new(Inner {
                snapshot: StreamSnapshot::idle(),
                stop_tx: None,
                worker: None,
                started_at: None,
            }),
        })
    }

    pub fn state(&self) -> StreamSnapshot {
        let mut inner = self.inner.lock().unwrap();
        // Live-Uptime aktualisieren ohne Worker zu blockieren.
        if let Some(started_at) = inner.started_at {
            inner.snapshot.uptime_s = Some(started_at.elapsed().as_secs_f64());
        }
        inner.snapshot.clone()
    }

    pub fn start(&self, params: StartParams) -> Result<Vec<String>> {
        let mut inner = self.inner.lock().unwrap();
        if inner.snapshot.running {
            return Err(anyhow!("a stream is already running; stop it first"));
        }

        let (stop_tx, stop_rx) = channel();
        let argv = build_argv_redacted(&params);

        inner.snapshot = StreamSnapshot {
            running: true,
            state: "starting",
            fps: None,
            uptime_s: Some(0.0),
            argv_redacted: Some(argv.clone()),
        };
        inner.stop_tx = Some(stop_tx);
        inner.started_at = Some(Instant::now());

        // Die Aufnahmequelle für die Fernsteuerung sichtbar machen: sie löst den
        // Slot einer Eingabe-Nachricht daraus in das Quell-Rechteck auf. Vor dem
        // Spawn, weil `params` gleich in den Worker wandert.
        crate::remote_input::ziel::strom_gestartet(params.slot, params.capture.clone());

        // Worker spawnen — der hält den ganzen Pipeline-State, wir behalten
        // hier nur ein Stop-Signal + JoinHandle.
        let worker = thread::Builder::new()
            .name("stream-pipeline".into())
            .spawn(move || run_pipeline(params, stop_rx))
            .context("spawn stream-pipeline thread")?;
        inner.worker = Some(worker);

        // state-Event sofort emittieren, ohne den Mutex gehalten zu haben.
        drop(inner);
        emit_state("starting", true, 0.0);
        Ok(argv)
    }

    pub fn stop(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.snapshot.running {
            return Ok(()); // No-op; aufrufer-seitig ist das idempotent.
        }
        if let Some(tx) = inner.stop_tx.take() {
            let _ = tx.send(());
        }
        // Sofort abmelden, nicht erst wenn der Worker ausgelaufen ist: bis dahin
        // vergehen im schlimmsten Fall Sekunden, und in denen zeigte die
        // Fernsteuerung noch auf eine Quelle, die keiner mehr aufnimmt.
        crate::remote_input::ziel::strom_beendet();
        let worker = inner.worker.take();
        drop(inner);

        // Worker auslaufen lassen — aber NICHT unbegrenzt blockierend. Der
        // Dispatch-Loop ist single-threaded (`main.rs`); ein direktes `join()`
        // hier fror den ganzen Sidecar ein, wenn der Worker auf Netzwerk-I/O
        // blockierte (toter RTMPS-Connect). Das `join()` läuft jetzt auf einem
        // Hilfsthread, wir warten nur mit Timeout. Der Worker terminiert nach
        // dem Stop-Signal selbst (`rw_timeout` im Encoder kappt jeden Stall auf
        // ~10 s); `STOP_JOIN_TIMEOUT` ist nur das Sicherheitsnetz.
        if let Some(w) = worker {
            let (done_tx, done_rx) = channel();
            let _ = thread::Builder::new()
                .name("stream-joiner".into())
                .spawn(move || {
                    let _ = w.join();
                    let _ = done_tx.send(());
                });
            if done_rx.recv_timeout(STOP_JOIN_TIMEOUT).is_err() {
                eprintln!(
                    "[stream-controller] Worker nicht in {STOP_JOIN_TIMEOUT:?} beendet — \
                     aufgegeben (Sidecar bleibt responsiv)"
                );
            }
        }
        // Worker hat im Erfolgsfall schon einen `stopped`-Event emittiert;
        // hier ist nur Aufräumen. Nicht "error" überschreiben — worker_finished
        // kann diesen State während des join-Windows setzen.
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.running = false;
        if inner.snapshot.state != "error" {
            inner.snapshot.state = "stopped";
        }
        // Finale Laufzeit festhalten (nur falls `worker_finished` sie nicht
        // schon geschrieben und `started_at` genommen hat) — s. Kommentar dort.
        if let Some(t) = inner.started_at.take() {
            inner.snapshot.uptime_s = Some(t.elapsed().as_secs_f64());
        }
        Ok(())
    }

    /// Vom Worker-Thread aufgerufen wenn die Pipeline beendet (regular oder Fehler).
    fn worker_finished(&self, error: Option<String>) {
        // Kein Stream mehr → die Fernsteuerung findet zu diesem Slot keine
        // Quelle mehr und verwirft ankommende Frames still (unbekannter Slot).
        crate::remote_input::ziel::strom_beendet();
        // „Quell-Fenster geschlossen" (Spiel beendet) läuft technisch über den
        // Fehler-Kanal des Capture-Workers, ist aber GEWOLLTES Verhalten —
        // auf den sauberen Stop-Pfad mappen statt ein error-Event zu zeigen.
        // `reason` im stopped-Event lässt den Renderer erklären, WARUM der
        // Stream endete (Toast statt Fehlerbanner).
        let source_closed = error
            .as_ref()
            .is_some_and(|m| m.contains(crate::capture::SOURCE_CLOSED_MARKER));
        let error = if source_closed { None } else { error };
        let mut inner = self.inner.lock().unwrap();
        // Uptime ablesen BEVOR `started_at` auf None gesetzt wird.
        let measured = inner.started_at.take().map(|t| t.elapsed().as_secs_f64());
        let uptime = measured.unwrap_or(0.0);
        inner.snapshot.running = false;
        inner.snapshot.state = if error.is_some() { "error" } else { "stopped" };
        inner.snapshot.fps = None;
        // Finale Laufzeit in den Snapshot — der `state()`-Getter aktualisiert
        // `uptime_s` nur bei gesetztem `started_at` (jetzt None); ohne das
        // lieferte ein `state`-Op nach dem Ende einen stale Wert. NUR bei
        // eigener Messung schreiben: kommt ein nach `STOP_JOIN_TIMEOUT`
        // aufgegebener Worker doch noch hier an, hat `stop()` `started_at`
        // schon genommen und den korrekten Wert geschrieben — den darf das
        // 0.0-Fallback nicht überschreiben.
        if let Some(u) = measured {
            inner.snapshot.uptime_s = Some(u);
        }
        drop(inner);
        if let Some(msg) = error {
            // Fehlerfall: NUR error-Events. KEIN nachfolgendes "stopped" — das
            // würde im Renderer-Reducer den error-State überschreiben
            // (state → 'stopped'), ein Crash wäre dann nicht mehr von einem
            // sauberen Stopp unterscheidbar. Gleiche Disziplin wie der
            // Linux-Sidecar (`if self._state != "error"`). Der `state`-Frame mit
            // `"error"` treibt den reaktiven Renderer-State (#5).
            emit_state("error", false, uptime);
            // Redigiert: scheitert der Push-Start, trägt die Fehlerkette die
            // volle Ziel-URL inklusive Stream-Key — und Electron schreibt jede
            // stdout-Zeile in eine persistente Log-Datei (s. `crate::redact`).
            let mut ev = json!({"ev": "error", "message": crate::redact::secrets(&msg)});
            // Maschinenlesbarer Code statt Text-Matching im Client: bei einer
            // geänderten Quellgröße startet der Renderer den Stream automatisch
            // neu (`web/src/lib/stream/autoRestart.ts`). Feld ist additiv —
            // der Linux-Sidecar schickt es (noch) nicht, der Reducer toleriert
            // sein Fehlen.
            if msg.contains(crate::capture::RESIZE_ERROR_MARKER) {
                ev["code"] = json!("capture_size_changed");
            }
            events::emit(ev);
        } else {
            emit_state("stopped", false, uptime);
            let mut ev = json!({"ev": "stopped"});
            if source_closed {
                ev["reason"] = json!("source_closed");
            }
            events::emit(ev);
        }
    }

    pub(crate) fn set_fps(&self, fps: f64) {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.fps = Some(fps);
    }

    pub(crate) fn set_state(&self, state: &'static str) {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.state = state;
    }
}

// ── Worker-Thread ───────────────────────────────────────────────────────────

fn run_pipeline(params: StartParams, stop_rx: Receiver<()>) {
    let ctrl = StreamController::singleton();
    // Eine Vollbild-Anforderung, die nach dem letzten Bild des vorigen Streams
    // eintraf, gehoert nicht diesem hier (Begruendung an `keyframe::reset`).
    crate::keyframe::reset();
    // `catch_unwind`: ein Panic in der Pipeline (statt eines `Err`) würde sonst
    // an `worker_finished` VORBEI unwinden — kein `error`-Event, `running`
    // bliebe für immer `true`, der Renderer sähe einen Stream, der wortlos in
    // „starting"/„live" hängt. Der Linux-Sidecar hat diese Garantie über sein
    // generisches `except`; hier stellt sie dieses Netz her. Die geleakten
    // Pipeline-Objekte (`ManuallyDrop`) werden vom Unwind nicht angefasst —
    // der Teardown-Crash-Schutz gilt also auch auf dem Panic-Pfad.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
        let adapter = select_adapter()?;

        // Welcher Encode-Weg zuständig ist, steht an genau einer Stelle:
        // `VideoCodec::encode_path` (`encode/encoder.rs`) — dort auch die
        // Begründung je Zelle. Hier wird sie nur noch ausgeführt.
        //
        // `select_adapter()` liefert auf Multi-GPU evtl. die dGPU statt der
        // Display-GPU; `pipeline_hw` wertet `encode_path` deshalb mit der
        // ECHTEN WGC-GPU noch einmal aus und delegiert nötigenfalls weiter.
        // Kill-Switch `PULSE_HQ_DISABLE_ZERO_COPY=1` erzwingt den CPU-Pfad —
        // auch das ist ein Grund, aus dem 10 bit ausfallen kann, s.
        // `encode::zehnbit::pruefen` unten.
        let disable_zc = crate::env::flag("PULSE_HQ_DISABLE_ZERO_COPY");
        let codec = params.codec();
        // Roh ausgewertet, VOR dem Schalter — dieselbe Auswertung, die gleich
        // beim Dispatch nochmal gebraucht wird (`pfad`, unten), und dieselbe,
        // die `encode::zehnbit::pruefen` als effektiven Weg braucht (den
        // Schalter prüft sie selbst zuerst). Eine Stelle statt zwei, damit
        // Prüfung und Dispatch nicht auseinanderlaufen können.
        let pfad = codec.encode_path(adapter.vendor(), &params.push_url);
        // **HDR wird HIER entschieden, vor der Aufnahme** — und nicht in
        // `pipeline_hw`, wo die übrige Bildarbeit sitzt. Zwei Gründe:
        //
        // * Das Aufnahmeformat hängt an der Antwort (`capture::bildformat`).
        //   Eine Aufnahme, die schon in BGRA läuft, ließe sich hinterher nicht
        //   mehr zu HDR machen — die Spitzlichter sind dann weg.
        // * Nur hier ist die Absage für ALLE drei Wege zu haben. In
        //   `pipeline_hw` stünde sie an einem Weg, und ein HDR-Wunsch auf dem
        //   D3D12- oder CPU-Weg liefe daran vorbei; der Strom liefe dann in
        //   SDR unter dem HDR-Etikett, also genau der Ausgang, gegen den
        //   `encode::hdr` gebaut ist.
        //
        // Der Rückgabewert wird gebraucht (die Leuchtdichten des Schirms gehen
        // als Metadaten in den Strom), deshalb wandert er in die Params statt
        // später ein zweites Mal abgefragt zu werden — die Antwort könnte sich
        // zwischen zwei Abfragen ändern, und dann sagten Bildpunkte und
        // Metadaten Verschiedenes.
        let mut params = params;
        if params.hdr {
            let schirm = crate::encode::hdr::pruefen(
                adapter.vendor(),
                codec,
                &params.push_url,
                &params.capture,
            )?;
            eprintln!("[hdr] Bildschirm: {}", schirm.beschreibung());
            params.schirm = Some(schirm);
            // PQ in 8 bit wäre in jedem Verlauf sichtbar geringelt —
            // Begründung an `StartParams::hdr`.
            params.ten_bit = true;
        } else if params.ten_bit {
            // Ein reiner 10-bit-Wunsch (ohne HDR) verdient dieselbe
            // Disziplin wie HDR: abbrechen statt still auf 8 bit
            // zurückzufallen (`encode::zehnbit`, Gegenstück zu `encode::hdr`).
            //
            // **Bewusst NICHT im HDR-Zweig oben** — HDR hat mit
            // `hdr::pruefen` bereits die genauere Absage geprüft (`traegt_hdr`
            // schließt „kein 10 bit" mit ein, s. Modulkopf dort). Ein zweiter
            // Check hier würde bei einem HDR-Start entweder dieselbe Absage
            // doppeln oder die genauere HDR-Meldung durch die allgemeinere
            // 10-bit-Meldung verdrängen.
            crate::encode::zehnbit::pruefen(disable_zc, pfad)?;
        }
        let params = params;
        if !disable_zc {
            match pfad {
                EncodePath::D3d11ZeroCopy => {
                    return crate::pipeline_hw::run(adapter, params, stop_rx);
                }
                EncodePath::D3d12ZeroCopy => {
                    return crate::pipeline_d3d12::run(params, stop_rx, codec);
                }
                EncodePath::Cpu => {}
            }
        }
        run_cpu_pipeline(params, stop_rx)
    }))
    .unwrap_or_else(|payload| Err(anyhow!("pipeline worker panicked: {}", panic_message(&payload))));

    let error_msg = result.err().map(|e| format!("{e:#}"));
    let had_error = error_msg.is_some();
    ctrl.worker_finished(error_msg);
    // Nach einem Fehler den Prozess geordnet beenden (Sentinel läuft HINTER
    // den error-Events durch den Writer) — Begründung: `events::request_exit`.
    // Beim regulären Ende übernimmt das der `stop`-Op (`exit_after`).
    // WICHTIG: `had_error` deckt auch den source_closed-Fall ab (Spiel
    // beendet → `SOURCE_CLOSED_MARKER`-Err aus der Capture): worker_finished
    // mappt den zwar auf einen SAUBEREN Stop, aber ein `stop`-Op kommt nie —
    // ohne diesen Exit bliebe der Prozess für immer stehen.
    if had_error {
        events::request_exit();
    }
}

/// Panic-Payload → lesbarer Text. `panic!`-Payloads sind praktisch immer
/// `&str` oder `String`; alles andere bekommt einen Platzhalter.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("<non-string panic payload>")
}
