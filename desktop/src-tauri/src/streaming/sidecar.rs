//! GSR-sidecar process manager.
//!
//! Spawns `python3 streaming/gsr-sidecar/control.py` as a child, runs three
//! tasks against it:
//!
//! - **Reader** — line-wise `BufReader` on stdout; routes responses (those with
//!   `"id"`) to the matching waiter, forwards events to the frontend.
//! - **Stderr drain** — line-wise; logs each line via `tracing`/`log`. Python
//!   tracebacks land here.
//! - **Writer** — serialised writes to stdin through a queue so two concurrent
//!   `call()`s never interleave.
//!
//! Requests get a numeric `id`; the `control.py` protocol echoes it back. The
//! reader task looks up the pending oneshot by id and fulfils it.
//!
//! The sidecar's stdin-EOF / SIGTERM handler stops a running GSR before
//! exiting, so the shutdown path here is just "close stdin, wait briefly, kill
//! if still alive".

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;

/// Default request timeout. `start`/`stop` can be slower (Wayland portal
/// dialog, process teardown) — those overrides are per-call.
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(10);

/// The frontend listens on this event name for `{"ev": ...}` payloads.
pub const EVENT_NAME: &str = "gsr://event";

pub struct Sidecar {
    /// Pending request waiters keyed by numeric id.
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    /// Next outbound request id.
    next_id: AtomicU64,
    /// Sender side of the writer queue. `None` only briefly during shutdown.
    writer_tx: mpsc::Sender<String>,
    /// Child PID, kept around so we can `kill` it on shutdown.
    child: Mutex<Option<Child>>,
    /// Liveness flag, flipped by the reader task on stdout-EOF.
    alive: Arc<AtomicBool>,
}

impl Sidecar {
    /// Spawn `python3 <control.py>` and start the reader/writer tasks.
    pub async fn spawn<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<Self> {
        let script = resolve_script_path(app)?;
        log::info!("spawning gsr-sidecar: python3 {}", script.display());

        let mut child = Command::new("python3")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Keep `kill_on_drop` off: we want a deterministic shutdown via
            // close-stdin → wait → kill. Drop-kill is best-effort and can
            // strand the GSR child process.
            .kill_on_drop(false)
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("child stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("child stdout missing"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::other("child stderr missing"))?;

        let pending = Arc::new(Mutex::new(HashMap::<u64, oneshot::Sender<Value>>::new()));
        let alive = Arc::new(AtomicBool::new(true));

        // Reader task: parse stdout line-by-line, dispatch.
        {
            let pending = pending.clone();
            let alive = alive.clone();
            let app = app.clone();
            tokio::spawn(async move {
                reader_loop(stdout, pending, alive, app).await;
            });
        }

        // Stderr drain: surface Python tracebacks via the logger.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("gsr-sidecar stderr: {line}");
            }
        });

        // Writer task: pull lines off the queue, write to stdin.
        let (writer_tx, mut writer_rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            let mut stdin: ChildStdin = stdin;
            while let Some(line) = writer_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    log::warn!("gsr-sidecar stdin write failed — child likely gone");
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
            // Closing stdin via drop signals EOF to the sidecar, which makes
            // it stop GSR and exit cleanly.
            drop(stdin);
        });

        Ok(Self {
            pending,
            next_id: AtomicU64::new(1),
            writer_tx,
            child: Mutex::new(Some(child)),
            alive,
        })
    }

    /// True iff the reader task hasn't seen stdout-EOF.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// Send a request and await the matching response.
    ///
    /// `op` is the protocol operation (e.g. `"health"`). `params` is merged
    /// into the request object; pass `Value::Null` if there are no extra
    /// fields. `op_timeout` overrides the default for slow ops like `start`.
    pub async fn call(
        &self,
        op: &str,
        params: Value,
        op_timeout: Option<Duration>,
    ) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("sidecar process is not alive".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::AcqRel);
        let (tx, rx) = oneshot::channel::<Value>();
        {
            let mut p = self.pending.lock().await;
            p.insert(id, tx);
        }

        // Build the request: start from params (must be an object or Null) and
        // splice in op + id.
        let mut req = match params {
            Value::Null => serde_json::Map::new(),
            Value::Object(m) => m,
            other => return Err(format!("params must be an object, got {other:?}")),
        };
        req.insert("op".into(), Value::String(op.into()));
        req.insert("id".into(), Value::from(id));
        let line = match serde_json::to_string(&Value::Object(req)) {
            Ok(s) => s,
            Err(e) => {
                self.pending.lock().await.remove(&id);
                return Err(format!("serialize request: {e}"));
            }
        };

        if self.writer_tx.send(line).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err("sidecar writer channel closed".into());
        }

        let wait = op_timeout.unwrap_or(DEFAULT_RPC_TIMEOUT);
        match timeout(wait, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_canceled)) => Err("sidecar reader dropped the response".into()),
            Err(_elapsed) => {
                // Reader will fulfil the oneshot later; we tell it to drop it
                // by removing the entry.
                self.pending.lock().await.remove(&id);
                Err(format!("sidecar op '{op}' timed out after {wait:?}"))
            }
        }
    }

    /// Close stdin and best-effort kill. Idempotent.
    pub async fn shutdown(&self) {
        log::info!("shutting down gsr-sidecar");
        // SIGTERM the child, give it 2s for its own handler to stop GSR, then
        // kill if it's still around. The writer-task drops stdin when its
        // channel closes — but we don't bother waiting for that here.
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                let _ = unsafe { libc_sigterm(pid as i32) };
            }
            match timeout(Duration::from_secs(2), child.wait()).await {
                Ok(_) => {}
                Err(_) => {
                    log::warn!("gsr-sidecar didn't exit in 2s — killing");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }
        self.alive.store(false, Ordering::Release);
    }
}

/// Resolve the path to `control.py`.
///
/// Order (first hit wins):
///
/// 1. `$PULSE_SIDECAR_PY` — explicit override, used by tests / power users.
/// 2. Dev heuristic: walk up from the current executable until we hit a dir
///    containing `streaming/gsr-sidecar/control.py`. Catches both `target/debug`
///    and `target/release`.
/// 3. Flatpak path (T6, not yet built): `/app/share/pulse/gsr-sidecar/control.py`.
///
/// Returns an `io::Error` of kind `NotFound` if none of these work, with a
/// message that names every path we tried.
fn resolve_script_path<R: Runtime>(_app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    if let Ok(override_path) = env::var("PULSE_SIDECAR_PY") {
        let p = PathBuf::from(override_path);
        if p.is_file() {
            return Ok(p);
        }
        log::warn!("PULSE_SIDECAR_PY set but not a file: {}", p.display());
    }

    if let Ok(exe) = env::current_exe() {
        // exe is e.g. <worktree>/desktop/src-tauri/target/debug/pulse-desktop
        // Walk up until we find <X>/streaming/gsr-sidecar/control.py.
        let mut cur: &Path = exe.as_path();
        while let Some(parent) = cur.parent() {
            let candidate = parent
                .join("streaming")
                .join("gsr-sidecar")
                .join("control.py");
            if candidate.is_file() {
                return Ok(candidate);
            }
            cur = parent;
        }
    }

    // Flatpak (T6) — install path TBD; this is a reasonable default.
    let flatpak = PathBuf::from("/app/share/pulse/gsr-sidecar/control.py");
    if flatpak.is_file() {
        return Ok(flatpak);
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "gsr-sidecar control.py not found — set PULSE_SIDECAR_PY or run from a Pulse worktree",
    ))
}

/// Read stdout line by line, dispatch responses and events.
async fn reader_loop<R: Runtime>(
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    alive: Arc<AtomicBool>,
    app: AppHandle<R>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("gsr-sidecar stdout: unparseable line ({e}): {line}");
                        continue;
                    }
                };
                // Events: `{"ev": ...}` — forward verbatim to the frontend.
                if value.get("ev").is_some() {
                    if let Err(e) = app.emit(EVENT_NAME, &value) {
                        log::warn!("emit {EVENT_NAME} failed: {e}");
                    }
                    continue;
                }
                // Responses: `{"id": <u64>, "ok": ..., ...}` — match a waiter.
                if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                    let waiter = {
                        let mut p = pending.lock().await;
                        p.remove(&id)
                    };
                    if let Some(tx) = waiter {
                        let _ = tx.send(value);
                    } else {
                        log::warn!("gsr-sidecar response for unknown id={id}: {value}");
                    }
                    continue;
                }
                log::warn!("gsr-sidecar message with neither ev nor id: {value}");
            }
            Ok(None) => {
                log::info!("gsr-sidecar stdout EOF — reader exiting");
                break;
            }
            Err(e) => {
                log::warn!("gsr-sidecar stdout read error: {e}");
                break;
            }
        }
    }
    alive.store(false, Ordering::Release);
    // Drain any pending waiters so callers don't hang.
    let mut p = pending.lock().await;
    p.clear();
}

// Tiny SIGTERM helper — we don't pull in nix/libc just for this on every
// platform; on unix we use a direct syscall via std::os::unix.
#[cfg(unix)]
unsafe fn libc_sigterm(pid: i32) -> i32 {
    // SAFETY: `kill(2)` with SIGTERM is a valid, side-effect-only syscall.
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    unsafe { kill(pid, SIGTERM) }
}
