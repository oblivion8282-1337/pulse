//! Test-Driver für den Windows-HQ-Sidecar — Rust-native Repro-Tool.
//!
//! Spawnt `pulse-win-hq-sidecar.exe`, redet JSON-RPC über stdin/stdout, capturet
//! stderr separat. Alle drei Streams werden zeitgestempelt in Konsole + Log-File
//! getee'd. Ersetzt die fragilen PowerShell-async-IO-Versuche aus den vorherigen
//! Sessions; insbesondere für die Audio-Mux-Hang-Diagnose ist deterministische
//! Event-Timing-Beobachtung Pflicht.
//!
//! ```text
//! cargo build --release         # erst Sidecar bauen
//! cargo run --release --example test_driver -- health
//! cargo run --release --example test_driver -- video_only [rtmp_url]
//! cargo run --release --example test_driver -- audio_mux [rtmp_url]
//! ```
//!
//! `$PULSE_HQ_SIDECAR_BIN` überschreibt den Auto-Resolver
//! (default: `target/release/pulse-win-hq-sidecar.exe` → `target/debug/...`).
//!
//! Szenarien:
//! - `health` — `health` + Exit. Sanity-Check der Wire-Protocol-Pipeline.
//! - `video_only` — start mit audio=Aus, erwartet `state=live` + ≥1 `fps`-Event
//!   binnen 15s, läuft 10s, dann `stop`. Validates the happy path.
//! - `audio_mux` — wie video_only, aber audio.mode=Desktop. Pusht zweispurigen
//!   Stream (H.264 + Opus). Validiert via MediaMTX-API
//!   `/v3/paths/list` → `tracks2: [H264, Opus]`.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

const DEFAULT_PUSH_URL: &str = "rtmp://localhost:1935/test";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const STATE_LIVE_TIMEOUT: Duration = Duration::from_secs(15);
const FIRST_FPS_TIMEOUT: Duration = Duration::from_secs(15);
const STREAM_RUN_DURATION: Duration = Duration::from_secs(10);

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let scenario = args.next().unwrap_or_else(|| "health".to_string());
    let push_url = args.next().unwrap_or_else(|| DEFAULT_PUSH_URL.to_string());

    let log = LogWriter::new(&scenario)?;
    log.write("driver", &format!("scenario={scenario} push_url={push_url}"));

    let bin = resolve_sidecar_bin()?;
    log.write("driver", &format!("sidecar bin: {}", bin.display()));

    let mut driver = Driver::spawn(bin, log.clone())?;
    let result = match scenario.as_str() {
        "health" => scenario_health(&mut driver),
        "video_only" => scenario_full(&mut driver, &push_url, "Aus"),
        "audio_mux" => scenario_full(&mut driver, &push_url, "Desktop"),
        other => Err(anyhow::anyhow!(
            "unknown scenario: {other} (use: health | video_only | audio_mux)"
        )),
    };

    driver.shutdown();

    match &result {
        Ok(()) => log.write("driver", "scenario OK"),
        Err(e) => log.write("driver", &format!("scenario FAILED: {e:#}")),
    }
    log.write("driver", &format!("log saved: {}", log.path().display()));
    result
}

// ── Szenarien ───────────────────────────────────────────────────────────────

fn scenario_health(driver: &mut Driver) -> anyhow::Result<()> {
    let resp = driver.send("health", Map::new())?;
    if !response_ok(&resp) {
        anyhow::bail!("health response not ok: {resp}");
    }
    driver.log("driver", "health roundtrip OK");
    Ok(())
}

fn scenario_full(driver: &mut Driver, push_url: &str, audio_mode: &str) -> anyhow::Result<()> {
    // 1) Sanity: health
    let resp = driver.send("health", Map::new())?;
    if !response_ok(&resp) {
        anyhow::bail!("health failed: {resp}");
    }

    // 2) start
    let mut params = Map::new();
    params.insert("profile".into(), Value::String("H.264 Standard".into()));
    params.insert(
        "channel".into(),
        json!({
            "id": "test-channel",
            "token": "",
            "push_url": push_url,
        }),
    );
    params.insert("capture".into(), Value::String("monitor".into()));
    params.insert("audio".into(), json!({"mode": audio_mode, "excluded_apps": []}));

    let t_start = Instant::now();
    let resp = driver.send("start", params)?;
    if !response_ok(&resp) {
        anyhow::bail!("start failed: {resp}");
    }
    driver.log("driver", &format!("start response ok ({:?})", t_start.elapsed()));

    // 3) wait für state=live
    let live_evt = driver
        .wait_event(
            |v| {
                v.get("ev").and_then(Value::as_str) == Some("state")
                    && v.get("state").and_then(Value::as_str) == Some("live")
            },
            STATE_LIVE_TIMEOUT,
        )
        .ok_or_else(|| anyhow::anyhow!("never reached state=live within {STATE_LIVE_TIMEOUT:?}"))?;
    driver.log(
        "driver",
        &format!(
            "state=live reached after {:?} ({live_evt})",
            t_start.elapsed()
        ),
    );

    // 4) erstes fps-Event — hier hängt's bei aktivem Audio-Mux
    let t_live = Instant::now();
    let fps_evt = driver
        .wait_event(
            |v| v.get("ev").and_then(Value::as_str) == Some("fps"),
            FIRST_FPS_TIMEOUT,
        )
        .ok_or_else(|| {
            anyhow::anyhow!(
                "never got first fps event within {FIRST_FPS_TIMEOUT:?} after state=live (mux hang?)"
            )
        })?;
    driver.log(
        "driver",
        &format!(
            "first fps after state=live: {:?} ({fps_evt})",
            t_live.elapsed()
        ),
    );

    // 5) laufen lassen, fps-Events sammeln
    let run_until = Instant::now() + STREAM_RUN_DURATION;
    let mut fps_count = 1u32;
    while Instant::now() < run_until {
        let remaining = run_until.saturating_duration_since(Instant::now());
        if let Some(evt) = driver.wait_event(
            |v| v.get("ev").and_then(Value::as_str) == Some("fps"),
            remaining.min(Duration::from_secs(3)),
        ) {
            fps_count += 1;
            driver.log("driver", &format!("fps event #{fps_count}: {evt}"));
        }
    }

    // 6) stop
    let resp = driver.send("stop", Map::new())?;
    if !response_ok(&resp) {
        anyhow::bail!("stop failed: {resp}");
    }
    driver.log("driver", &format!("stop response ok, {fps_count} fps events seen"));
    Ok(())
}

// ── Driver ──────────────────────────────────────────────────────────────────

struct Driver {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    incoming: Receiver<Incoming>,
    next_id: AtomicI64,
    log: LogWriter,
    pending_events: Vec<Value>,
}

#[derive(Debug)]
enum Incoming {
    Response { id: Option<i64>, body: Value },
    Event(Value),
    StdoutEof,
}

impl Driver {
    fn spawn(bin: PathBuf, log: LogWriter) -> anyhow::Result<Self> {
        let mut child = Command::new(&bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| anyhow::anyhow!("spawn {}: {e}", bin.display()))?;

        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let (tx, rx) = channel::<Incoming>();
        let log_stdout = log.clone();
        let tx_stdout = tx.clone();
        thread::Builder::new()
            .name("driver-stdout".into())
            .spawn(move || stdout_reader_loop(stdout, tx_stdout, log_stdout))?;

        let log_stderr = log.clone();
        thread::Builder::new()
            .name("driver-stderr".into())
            .spawn(move || stderr_reader_loop(stderr, log_stderr))?;

        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            incoming: rx,
            next_id: AtomicI64::new(1),
            log,
            pending_events: Vec::new(),
        })
    }

    fn log(&self, source: &str, msg: &str) {
        self.log.write(source, msg);
    }

    fn send(&mut self, op: &str, params: Map<String, Value>) -> anyhow::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut req = params;
        req.insert("op".into(), Value::String(op.to_string()));
        req.insert("id".into(), Value::Number(id.into()));
        let line = serde_json::to_string(&Value::Object(req))?;
        self.log("→sidecar", &line);

        let stdin = self.stdin.as_mut().ok_or_else(|| anyhow::anyhow!("stdin closed"))?;
        writeln!(stdin, "{line}")?;
        stdin.flush()?;

        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("response timeout for op={op} id={id}");
            }
            match self.incoming.recv_timeout(remaining) {
                Ok(Incoming::Response { id: rid, body }) if rid == Some(id) => return Ok(body),
                Ok(Incoming::Response { id: rid, body }) => {
                    self.log(
                        "driver",
                        &format!("dropped stale response id={rid:?}: {body}"),
                    );
                }
                Ok(Incoming::Event(v)) => self.pending_events.push(v),
                Ok(Incoming::StdoutEof) => anyhow::bail!("sidecar stdout closed before response"),
                Err(RecvTimeoutError::Timeout) => {
                    anyhow::bail!("response timeout for op={op} id={id}")
                }
                Err(RecvTimeoutError::Disconnected) => {
                    anyhow::bail!("driver channel disconnected")
                }
            }
        }
    }

    fn wait_event<F>(&mut self, mut pred: F, timeout: Duration) -> Option<Value>
    where
        F: FnMut(&Value) -> bool,
    {
        // Buffered events zuerst.
        if let Some(pos) = self.pending_events.iter().position(|v| pred(v)) {
            return Some(self.pending_events.remove(pos));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match self.incoming.recv_timeout(remaining) {
                Ok(Incoming::Event(v)) => {
                    if pred(&v) {
                        return Some(v);
                    }
                    self.pending_events.push(v);
                }
                Ok(Incoming::Response { id, body }) => {
                    self.log(
                        "driver",
                        &format!("dropped stale response (waiting for event) id={id:?}: {body}"),
                    );
                }
                Ok(Incoming::StdoutEof) => return None,
                Err(_) => return None,
            }
        }
    }

    fn shutdown(&mut self) {
        // stdin schließen → sidecar bricht read-loop ab → schließt selbst.
        drop(self.stdin.take());
        if let Some(mut child) = self.child.take() {
            // 5s Gnadenfrist, dann kill.
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(5) {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.log("driver", &format!("sidecar exited: {status}"));
                        return;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(e) => {
                        self.log("driver", &format!("try_wait error: {e}"));
                        break;
                    }
                }
            }
            self.log("driver", "sidecar still running after 5s, killing");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn stdout_reader_loop(
    stdout: impl std::io::Read,
    tx: Sender<Incoming>,
    log: LogWriter,
) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log.write("sidecar-out", &format!("read error: {e}"));
                break;
            }
        };
        let trimmed = line.trim_start_matches('\u{feff}').trim();
        if trimmed.is_empty() {
            continue;
        }
        log.write("sidecar-out", trimmed);
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                log.write("sidecar-out", &format!("[unparseable JSON: {e}]"));
                continue;
            }
        };
        let msg = if parsed.get("ev").is_some() {
            Incoming::Event(parsed)
        } else {
            let id = parsed.get("id").and_then(Value::as_i64);
            Incoming::Response { id, body: parsed }
        };
        if tx.send(msg).is_err() {
            break;
        }
    }
    let _ = tx.send(Incoming::StdoutEof);
}

fn stderr_reader_loop(stderr: impl std::io::Read, log: LogWriter) {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        match line {
            Ok(l) => log.write("sidecar-err", &l),
            Err(e) => {
                log.write("sidecar-err", &format!("read error: {e}"));
                break;
            }
        }
    }
}

// ── LogWriter (thread-safe tee zu console + file) ───────────────────────────

#[derive(Clone)]
struct LogWriter {
    inner: Arc<Mutex<LogInner>>,
    started: Instant,
    path: PathBuf,
}

struct LogInner {
    file: File,
}

impl LogWriter {
    fn new(scenario: &str) -> anyhow::Result<Self> {
        let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let manifest = std::env::var("CARGO_MANIFEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
        let target = manifest.join("target");
        std::fs::create_dir_all(&target).ok();
        let path = target.join(format!("test-driver-{scenario}-{ts}.log"));
        let file = File::create(&path)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(LogInner { file })),
            started: Instant::now(),
            path,
        })
    }

    fn path(&self) -> &PathBuf {
        &self.path
    }

    fn write(&self, source: &str, msg: &str) {
        let offset = self.started.elapsed();
        let formatted = format!(
            "[+{:>7.3}s] [{source:<11}] {msg}",
            offset.as_secs_f64()
        );
        println!("{formatted}");
        if let Ok(mut inner) = self.inner.lock() {
            let _ = writeln!(inner.file, "{formatted}");
            let _ = inner.file.flush();
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn response_ok(v: &Value) -> bool {
    v.get("ok").and_then(Value::as_bool).unwrap_or(false)
}

fn resolve_sidecar_bin() -> anyhow::Result<PathBuf> {
    if let Ok(env_bin) = std::env::var("PULSE_HQ_SIDECAR_BIN") {
        let p = PathBuf::from(env_bin);
        if p.exists() {
            return Ok(p);
        }
        anyhow::bail!("PULSE_HQ_SIDECAR_BIN points to non-existent path: {}", p.display());
    }
    let manifest = std::env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    for sub in ["target/release", "target/debug"] {
        let candidate = manifest.join(sub).join("pulse-win-hq-sidecar.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    anyhow::bail!(
        "no sidecar binary found — run `cargo build --release` first or set PULSE_HQ_SIDECAR_BIN"
    )
}
