//! Zero-Copy-Pipeline für den GPU-Pfad (NVENC / AMF).
//!
//! WGC liefert ID3D11Texture2D-Frames; wir kopieren sie GPU-intern in einen
//! D3D11VA-Pool, von dem der Encoder direkt liest. Kein PCIe-Hin-und-Her, kein
//! BGRA→NV12-swscale auf der CPU. Downscale per `D3D11Scaler` (VideoProcessor).
//!
//! Aktiv für **NVIDIA** und für **AMD** (`h264_nvenc`/`hevc_nvenc`/`av1_nvenc`
//! bzw. `h264_amf`/`hevc_amf`/`av1_amf` nehmen D3D11-BGRA-Frames direkt
//! entgegen), Intel über die CPU-Pipeline (`run_cpu_pipeline`). **Welche
//! (Vendor, Codec)-Kombination hier statt über `pipeline_d3d12` läuft, steht
//! an genau einer Stelle** — `VideoCodec::encode_path` (`encode/codec.rs`),
//! hier nicht zweitgefasst; die Tabelle hat sich schon einmal verschoben
//! (2026-08-04, AMD ging vorher nur mit AV1 diesen Weg, H.264/HEVC über
//! `pipeline_d3d12`) und kann es wieder.
//!
//! **Warum AV1 auf AMD hier bleibt, ohne Gegenprobe-Schalter.** Über D3D12
//! ist AV1 auf AMD nicht benutzbar (`av1_d3d12va` liefert einen Bitstrom, den
//! kein Decoder liest — Messung in `pipeline_d3d12::run`), und der frühere
//! Ausweg über die CPU-Pipeline kostete gemessen 113 % eines CPU-Kerns und 42
//! übersprungene Bilder in 20 s; über diesen Pfad sind daraus 9 % und 2
//! geworden. Voraussetzung ist der **Einzeltextur-Pool** für AMD (`hwctx.rs`):
//! über den Texture-Array-Pool, den NVIDIA nutzt, liefert AMF ein zerrissenes
//! Bild (Herleitung am Wert in `HwContext::new`). Für AMD-H.264/HEVC gab es
//! denselben Grund dagegen nicht (`h264_d3d12va` funktioniert, und `h264_amf`
//! hat mit D3D11-Eingang die Vorgeschichte aus AMF-Issue #455) — deshalb
//! tragen die beiden einen Gegenprobe-Schalter zurück auf D3D12
//! (`PULSE_HQ_AMD_D3D12=1`, Begründung an `amd_forces_d3d12` in
//! `encode/codec.rs`) und AV1 nicht.
//!
//! Da `select_adapter()` auf Multi-GPU die dGPU statt der Display-GPU liefern
//! kann, verifiziert `run` die echte WGC-Capture-GPU und delegiert bei einer
//! unpassenden Vendor/Codec-Kombination selbst an `pipeline_d3d12` bzw.
//! `run_cpu_pipeline`. Kill-Switch `PULSE_HQ_DISABLE_ZERO_COPY=1` → CPU-Pfad.
//!
//! Capture-Start + Warten auf das erste Bild sitzt in [`capture_start`] —
//! herausgezogen, weil diese Datei mit den Messbegründungen über die harte
//! Größen-Grenze von 500 Zeilen gewachsen war (`PLAN.md` §12.1). Eigener
//! Verantwortungsbereich: bevor überhaupt feststeht, welcher Encode-Weg oder
//! Skalierer gebraucht wird, muss erst ein Bild da sein.

use anyhow::{Result, anyhow, bail};

use serde_json::json;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use crate::audio::AudioCapture;
use crate::capture::HwCaptureItem;
use crate::encode::{
    AudioStreamConfig, EncodePath, HwEncoderConfig, OwnedHwFrame,
};
use crate::events;
use crate::stream_controller::{StartParams, StreamController};
use crate::system::dxgi::Adapter;
use crate::tick_monitor::{TickMonitor, TickSample};

mod capture_start;
mod vorstufe;




pub fn run(adapter: Adapter, params: StartParams, stop_rx: Receiver<()>) -> Result<()> {
    let ctrl = StreamController::singleton();

    let fps = params.override_fps.unwrap_or(params.profile.fps);
    let codec = params.codec();
    let bitrate = params
        .override_bitrate_kbps
        .unwrap_or(params.profile.bitrate_kbps);

    let (capture, hw, width, height, first, first_qpc, origin_instant) =
        capture_start::start_and_wait_for_setup(
            params.capture.clone(),
            fps,
            params.show_cursor,
            params.hdr,
        )?;
    // Vendor der ECHTEN Capture/Encode-GPU (WGC-D3D11-Device). `adapter` aus
    // `select_adapter()` kann auf Multi-GPU eine andere GPU sein (dGPU-Default).
    // Massgeblich ist die GPU, auf der WGC sein Device gebaut hat (= die des
    // primaeren Displays), nicht die aus `select_adapter()` — der Encoder muss
    // zu ihr passen (h264_nvenc / h264_amf).
    let vendor =
        crate::system::dxgi::device_vendor(hw.device()).unwrap_or_else(|| adapter.vendor());

    // `encode_path` hier ein zweites Mal auswerten — jetzt mit dem ECHTEN
    // Vendor der WGC-Capture-GPU. Der Dispatcher entscheidet auf
    // `select_adapter()`, und das kann auf Multi-GPU die dGPU sein. Die Regel
    // selbst steht nur einmal (`encode/encoder.rs`).
    // Wohin delegiert wird, sagt `encode_path` selbst — die Zuordnung wird hier
    // NICHT ein zweites Mal ausgeschrieben. Genau das war der Fehler, den die
    // Zusammenführung in `encode_path` beseitigen sollte: zwei Fassungen
    // derselben Regel laufen auseinander, sobald eine Zelle dazukommt.
    let path = codec.encode_path(vendor, &params.push_url);
    if path != EncodePath::D3d11ZeroCopy {
        drop(capture);
        drop(first);
        drop(hw);
        // **Bei HDR wird hier NICHT delegiert, sondern abgebrochen.** Der
        // Verteiler hat gegen den Adapter aus `select_adapter()` geprüft; auf
        // Multi-GPU kann die echte Aufnahme-GPU eine andere sein, und dann
        // stimmt seine Antwort nicht mehr. Weder der D3D12- noch der CPU-Weg
        // trägt HDR (`encode::hdr`) — sie würden den Strom klaglos in SDR
        // weiterfahren, unter dem Etikett, das der Nutzer bestellt hat.
        if params.hdr {
            bail!(
                "HDR verlangt, aber die Aufnahme läuft auf einer {vendor}-GPU, für die {codec:?} \
                 über {path:?} encodiert würde — dieser Weg trägt HDR nicht. Auf Rechnern mit \
                 zwei Grafikchips hängt das daran, welcher den aufgenommenen Bildschirm \
                 versorgt. Begründung je Weg: encode/hdr.rs"
            );
        }
        eprintln!(
            "[pipeline-hw] Capture-GPU ist {vendor}, Codec {codec:?} — Delegation an {path:?}"
        );
        return match path {
            EncodePath::D3d12ZeroCopy => crate::pipeline_d3d12::run(params, stop_rx, codec),
            _ => crate::stream_controller::run_cpu_pipeline(params, stop_rx),
        };
    }
    // Capture aspektwahrend in die Override-Box einpassen (`fit_within_box`:
    // kein Upscale, gerade Maße — deckt auch die NV12-Anforderung #7 ab). Bei
    // dst==src geht der Capture-Frame direkt in den Encoder; sonst skaliert der
    // `D3D11Scaler` per `VideoProcessorBlt` auf der GPU davor.
    let (dst_w, dst_h) = match params.override_resolution {
        Some((box_w, box_h)) => {
            crate::stream_controller::fit_within_box(width, height, box_w, box_h)
        }
        // Native: nur die NV12-Gerade-Rundung (Fenster-Capture liefert
        // beliebige Client-Größen), sonst unverändert.
        None => (width & !1, height & !1),
    };
    // **Das Aufnahmeformat gehört in diese Zeile**, nicht nur die Maße. Es ist
    // die erste von vier Stufen, an denen HDR verlorengehen kann, und die
    // einzige, die man später am fertigen Strom NICHT mehr nachweisen kann:
    // eine in BGRA aufgenommene Szene, die danach korrekt nach PQ gewandelt
    // wird, trägt alle HDR-Merkmale und enthält trotzdem kein HDR. Ohne diese
    // Angabe bliebe die Frage „war die Quelle überhaupt HDR" unbeantwortbar.
    let aufnahmeformat = if params.hdr { "RGBA16F (scRGB)" } else { "BGRA8" };
    eprintln!(
        "[pipeline-hw] capture {width}x{height} {aufnahmeformat} → encode {dst_w}x{dst_h}@{fps} on {} (vendor={vendor})",
        adapter.description
    );

    // Audio-Pipeline gleicher Pfad wie CPU-Variante (WASAPI → libopus → 2. Spur).
    let audio_capture: Option<AudioCapture> = params.audio.as_ref().and_then(|src| {
        match AudioCapture::start(src.clone(), crate::encode::audio::capture_chunk_frames()) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[pipeline-hw] audio capture failed, video-only: {e:#}");
                None
            }
        }
    });
    let audio_cfg: Option<AudioStreamConfig> = audio_capture.as_ref().map(|_| AudioStreamConfig {
        av_offset_ms: params.av_offset_ms,
        ..AudioStreamConfig::DEFAULT
    });

    // 10 bit: Wunsch aus dem Request UND ein Codec, der ihn trägt. Die Regel
    // steht am Codec (`supports_ten_bit`), nicht hier — sonst hätte der nächste
    // Codec sie wieder zu suchen. Den Rest entscheidet der Ziel-Pool, und zwar
    // an EINER Stelle (`bildencoder::pool_wahl`): dort weiss man, ob sich ein
    // Encode-Weg angemeldet hat und welches Format der braucht.
    let pool = crate::encode::bildencoder::pool_wahl(params.ten_bit && codec.supports_ten_bit());
    // **Die Bittiefe kommt aus dem Pool zurück, nicht aus dem Wunsch.** Sonst
    // liefe „10 bit" unverändert in die Encoder-Konfiguration weiter, während
    // der Pool NV12 führt — ein Auftrag, der sich selbst widerspricht, ohne
    // dass irgendwo etwas auffiele.
    let ten_bit = pool.ten_bit;
    if params.ten_bit && !ten_bit {
        // Ein Nutzer, der einen 10-bit-Schalter umlegt und 8 bit bekommt, muss
        // herausfinden können, warum — beide Gründe deshalb getrennt.
        let grund = if !codec.supports_ten_bit() {
            "nur mit AV1 (10-bit-H.264 waere High 10, das dekodiert kein Browser)"
        } else {
            "der angemeldete Encode-Weg verlangt einen 8-bit-Pool"
        };
        eprintln!("[pipeline-hw] 10 bit {grund} -> 8 bit");
    }
    let (dst_format, geteilt) = (pool.format, pool.geteilt);

    // Was zwischen Aufnahme und Encoder passiert — Verkleinern, Farbwandlung,
    // beides oder nichts. Die Entscheidung samt Begründungen steht in
    // [`vorstufe::bauen`].
    let scaler = vorstufe::bauen(
        &params, &hw, width, height, dst_w, dst_h, fps, dst_format, geteilt,
    )?;

    let hw_frames_ref = match &scaler {
        Some(s) => s.dst_frames_ref(),
        None => hw.frames_ref(),
    };
    let cfg = HwEncoderConfig {
        codec,
        vendor: vendor.to_string(),
        fps,
        bitrate_kbps: bitrate,
        dst_w,
        dst_h,
        ten_bit,
        // Die Angaben des Schirms sind bei HDR gesetzt und sonst `None` — der
        // Encoder leitet daraus BEIDES ab: die Farb-Signalisierung im Strom
        // und die Mastering-Metadaten. Ein getrenntes `hdr: bool` daneben
        // wären zwei Wahrheiten über denselben Sachverhalt.
        schirm: params.schirm,
    };
    // SAFETY: `hw_frames_ref` zeigt auf den Frames-Kontext des Scalers oder des
    // Capture-Pools. Beide leben in dieser Funktion (`scaler`, `hw`) und damit
    // laenger als der Encoder, der hier entsteht; das Format passt zu den
    // Bildern, die derselbe Pool spaeter liefert. `lock_ptr` gehoert dem
    // Capture-`HwContext` und ueberlebt den Encoder ebenso.
    use crate::encode::bildencoder::{Gebaut, baue_mit_rueckfall};
    let gebaut = unsafe {
        baue_mit_rueckfall(
            &cfg,
            hw_frames_ref,
            hw.device(),
            hw.device_context(),
            hw.lock_ptr(),
            audio_cfg,
            &params.push_url,
            vendor,
        )
    }?;
    let encoder = match gebaut {
        Gebaut::Encoder(enc) => enc,
        Gebaut::AnD3d12 => {
            // `audio_capture` MUSS mit weg. Ohne das liefe der WASAPI-Thread
            // die ganze Laufzeit des delegierten Streams weiter, während
            // `pipeline_d3d12` sich eine zweite Aufnahme startet — der
            // verwaiste Kanal läuft voll und der Worker dreht danach dauerhaft
            // in seiner Sende-Warteschleife.
            drop(scaler);
            drop(capture);
            drop(first);
            drop(hw);
            drop(audio_capture);
            // **Den angeforderten Codec weiterreichen, nicht H.264 einsetzen.**
            // Hier stand bis 2026-08-04 fest `VideoCodec::H264`, anders als an
            // den beiden Schwesterstellen (Z. 95 und `stream_controller`).
            // Folge: ein AV1-Wunsch wurde beim Rückfall stillschweigend zu
            // H.264 — der Stream lief, sah gesund aus und trug den falschen
            // Codec.
            //
            // Seit AMD mit JEDEM Codec über AMF geht (`encode_path`), ist
            // dieser Rückfall nicht mehr die Ausnahme für einen Randfall,
            // sondern der Auffangweg für alles — die Verwechslung war damit
            // deutlich leichter zu treffen als vorher.
            //
            // `pipeline_d3d12::run` weiß selbst, was es mit AV1 tut: es gibt
            // sofort an den CPU-Weg ab (`av1_amf` mit Software-NV12). Teuer,
            // aber es bleibt AV1 — und ein teurer Weg mit dem richtigen Codec
            // schlägt einen billigen mit dem falschen.
            return crate::pipeline_d3d12::run(params, stop_rx, codec);
        }
    };

    // ── Ab hier wird NICHTS mehr gedroppt ────────────────────────────────────
    // Die *grafische* Teardown-Sequenz (WGC-FramePool/Session schließen,
    // D3D11-Device + NVENC + Audio-Client freigeben, `nvEncodeAPI64.dll`
    // entladen) lässt einen treiber-internen Threadpool-Timer dangling zurück —
    // feuert der danach, springt er in freigegebenen Speicher → `0xC0000005`
    // exec-Fault auf einem `TpWaitForTimer`-Thread (mit Audio zuverlässig
    // reproduzierbar). Darum: gar kein Teardown. Capture-, Audio- und
    // Encoder-Objekte bleiben am Leben, ihre Threads laufen weiter. Der
    // Per-Stream-Sidecar endet unmittelbar nach dem `stop` (`dispatch`/`main` →
    // Prozess-Exit); `ExitProcess` terminiert ALLE Threads abrupt, bevor
    // irgendein Timer feuern kann, und gibt GPU-/COM-/Datei-Handles vollständig
    // frei.
    //
    // `ManuallyDrop` am Binding statt `mem::forget` am Funktionsende: Letzteres
    // deckte nur den Erfolgspfad ab. Jedes `?` im Pacing-Loop (Encoder-Fehler
    // bei RTMP-Stall, Capture-Disconnect) lief daran vorbei und droppte doch —
    // also genau der Crash, den die Konstruktion verhindern soll, und zwar
    // BEVOR `worker_finished` das `error`-Event senden konnte (der Renderer sah
    // einen toten Prozess statt einer Fehlermeldung). Am Binding gilt die
    // Zusage für JEDEN Ausgang, auch für später hinzukommende.
    let mut capture = std::mem::ManuallyDrop::new(capture);
    // `_hw`: wird ab hier nicht mehr gelesen, muss aber gebunden bleiben —
    // der Pool trägt die Frames, die noch durch den Loop laufen.
    let _hw = std::mem::ManuallyDrop::new(hw);
    let audio_capture = std::mem::ManuallyDrop::new(audio_capture);
    let mut scaler = std::mem::ManuallyDrop::new(scaler);
    let mut encoder = std::mem::ManuallyDrop::new(encoder);

    ctrl.set_state("live");
    super::stream_controller::emit_state("live", true, 0.0);

    // Frame-Pacing wie GSR: der Encode-Loop läuft mit fester Kadenz (Ziel-fps),
    // NICHT im Capture-Takt. WGC ist change-driven — bei statischem Bild liefert
    // es 0 Frames; ohne Pacing stockt der RTMP-Push komplett (→ MediaMTX-
    // readTimeout → Verbindungsabbruch). Pro Tick wird der zuletzt gecapturete
    // Frame encodet (dupliziert, wenn kein neuer da ist); die PTS kommt aus der
    // Wanduhr → Stream-Zeit läuft mit Echtzeit statt mit der Capture-Rate.
    let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);
    let started = Instant::now();
    // A/V-Sync über echte Hardware-Timestamps (QPC): Video-PTS aus dem WGC-QPC
    // relativ zum QPC des ersten Frames (origin_qpc); Audio am selben origin
    // verankert → exakter Offset ohne Kalibrierung. qpc_sync aus / origin_qpc==0
    // (Timestamp n/a) → Fallback auf reine Wall-clock. Kill: PULSE_HQ_NO_AV_OFFSET=1.
    let qpc_sync = !crate::env::flag("PULSE_HQ_NO_AV_OFFSET") && first_qpc != 0;
    let origin_qpc = first_qpc;
    crate::syncprobe::video_origin(origin_qpc);
    let mut newest_qpc = first_qpc;
    // Anker muss zum tatsächlichen Video-Origin passen: mit QPC-Sync ist PTS 0
    // der erste Frame (origin_instant), ohne die Wanduhr-Basis der Loop.
    encoder.set_audio_origin(
        if qpc_sync { origin_instant } else { started },
        if qpc_sync { Some(origin_qpc) } else { None },
    );
    let mut last_frame: Option<OwnedHwFrame> = Some(first);
    let mut last_pts: i64 = -1;
    let mut audio_dead = false;
    let mut frames_sent: u64 = 0;
    let mut next_tick = started;
    let mut last_fps_emit = started;
    // Mikro-Stutter-Diagnose — misst pro Tick die einzelnen Stufen, erkennt
    // langsame Ticks/pts-Gaps und loggt sie. Details: `tick_monitor.rs`.
    let mut monitor = TickMonitor::new(fps);
    let mut prev_pts: i64 = 0;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        // Bis zum nächsten Tick warten. `thread::sleep` nutzt auf Win10+/aktuellem
        // Rust einen High-Resolution-Waitable-Timer (~1 ms genau).
        let planned = next_tick;
        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        }
        next_tick += frame_dur;
        // Rückstand nicht akkumulieren — sonst Frame-Burst nach einem Stall.
        let now = Instant::now();
        if next_tick < now {
            next_tick = now;
        }

        // Ab hier wird Arbeit gemessen (ohne den Pacing-Sleep): `iter_start`
        // ist der echte Wieder-Aufwach-Zeitpunkt, `wake_jitter` der Verzug
        // gegenüber dem geplanten Tick (Sleep-Überschuss + Vortick-Rückstand).
        let iter_start = Instant::now();
        let wake_jitter = iter_start.saturating_duration_since(planned);

        // Alle wartenden Capture-Frames abholen, nur den neuesten behalten.
        // Ältere droppen → zurück in den Pool. Kommt nichts Neues, bleibt
        // `last_frame` erhalten = Duplizierung bei statischem Bild.
        let t_capture = Instant::now();
        let mut captured: u32 = 0;
        loop {
            match capture.items.try_recv() {
                Ok(HwCaptureItem::Frame { frame: f, qpc }) => {
                    last_frame = Some(f);
                    if qpc != 0 {
                        newest_qpc = qpc;
                    }
                    captured += 1;
                }
                Ok(HwCaptureItem::Setup { .. }) => {
                    return Err(anyhow!("unexpected Setup item after pipeline init"));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    let worker_err = capture.join_error();
                    return Err(anyhow!(
                        "hw capture channel disconnected mid-stream{}",
                        crate::capture::worker_err_suffix(
                            worker_err,
                            "clean exit, keine Fehlermeldung"
                        )
                    ));
                }
            }
        }
        let capture_drain = t_capture.elapsed();

        // Audio non-blocking nachziehen.
        let t_audio = Instant::now();
        if let Some(ac) = audio_capture.as_ref() {
            loop {
                match ac.samples.try_recv() {
                    // Audio-Fehler NICHT verschlucken (#3): bricht die Audio-Spur
                    // weg, stockt der 2-Stream-Muxer (rw_timeout) und der Stream
                    // stirbt ohnehin — dann lieber mit klarer Fehlermeldung.
                    Ok(chunk) => encoder
                        .send_audio(&chunk)
                        .map_err(|e| anyhow!("send_audio: {e:#}"))?,
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    // WASAPI-Worker gestorben (Gerät weg/invalidiert): video-only
                    // weiterlaufen, aber EINMAL sichtbar melden.
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        if !audio_dead {
                            audio_dead = true;
                            eprintln!("[pipeline-hw] audio capture beendet — Stream läuft ohne Ton weiter");
                            events::emit(json!({"ev": "log", "line": "Audio-Aufnahme abgebrochen (Gerät entfernt?) — Stream läuft ohne Ton weiter"}));
                        }
                        break;
                    }
                }
            }
        }
        let audio_drain = t_audio.elapsed();

        // Video-PTS aus dem Hardware-Capture-Timestamp (QPC) relativ zum origin;
        // Fallback auf Wall-clock. Streng monoton.
        let elapsed = if qpc_sync {
            (newest_qpc - origin_qpc) as f64 / 10_000_000.0
        } else {
            started.elapsed().as_secs_f64()
        };
        let mut pts = (elapsed * fps as f64).round() as i64;
        if pts <= last_pts {
            pts = last_pts + 1;
        }
        // Convert-Zeit: GPU-Scaler bei Downscale, 0 bei Native (NVENC macht
        // den BGRA→NV12-Convert selbst).
        let mut convert = Duration::ZERO;
        if let Some(frame) = last_frame.as_mut() {
            match &mut *scaler {
                // Downscale: GPU-Resize in einen frischen Ziel-Pool-Frame,
                // dann den skalierten Frame encoden.
                Some(s) => {
                    let t_conv = Instant::now();
                    // Der Encoder bekommt das Ziel-Bild ZU SEHEN, bevor der
                    // Video-Prozessor hineinschreibt — Begründung an
                    // `BildEncoder::vor_dem_schreiben`. Für den Regelweg ist
                    // das ein leerer Aufruf.
                    let mut scaled = s.verarbeiten(frame, |ziel| encoder.vor_dem_schreiben(ziel))?;
                    convert = t_conv.elapsed();
                    encoder.send_hw(&mut scaled, pts)?;
                }
                // Native: Capture-Frame direkt in den Encoder.
                None => encoder.send_hw(frame, pts)?,
            }
            last_pts = pts;
            frames_sent += 1;
        }

        // Tick verbuchen. `send`/`mux` kommen aus dem Encoder (NVENC-Submit
        // bzw. RTMPS-Socket-Write des letzten `send_hw`); `iter` ist die
        // Arbeitszeit ohne Pacing-Sleep, ohne das fps/Summary-Emit unten.
        let iter = iter_start.elapsed();
        monitor.record(&TickSample {
            wake_jitter,
            capture_drain,
            captured,
            audio_drain,
            convert,
            send: Duration::from_micros(encoder.last_send_us()),
            mux: Duration::from_micros(encoder.last_mux_us()),
            iter,
            pts,
            pts_delta: pts - prev_pts,
            capture_drops: capture.dropped(),
            enc_latency: encoder.take_encode_latency(),
        });
        prev_pts = pts;

        if last_fps_emit.elapsed() >= Duration::from_secs(2) {
            let el = started.elapsed().as_secs_f64();
            let fps_now = frames_sent as f64 / el;
            ctrl.set_fps(fps_now);
            events::emit(json!({"ev": "fps", "fps": fps_now, "uptime_s": el}));
            monitor.flush_summary();
            last_fps_emit = Instant::now();
        }
    }

    // Stream finalisieren: FLV-Trailer schreiben, RTMP sauber schließen. Das
    // gibt nichts frei (`finish` nimmt `&mut self`); capture/hw/scaler/encoder
    // sind `ManuallyDrop` (s.o.) und werden weder gestoppt noch freigegeben.
    // `last_frame` ist kein eigenes Binding oben, weil es im Loop neu zugewiesen
    // wird (der alte Frame MUSS dabei in den Pool zurück); nur der allerletzte
    // wird hier vom Teardown ausgenommen.
    std::mem::forget(last_frame);
    encoder.finish()?;
    Ok(())
}

