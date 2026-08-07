//! Async NDJSON-over-unix-socket client for the sandbox bridge.
//!
//! One [`SandboxClient`] per backend instance. Requests are correlated by an
//! ever-increasing `id`; the reader task fans responses out to per-request
//! oneshot channels, so many calls can be in flight over the same socket.
//!
//! The socket is opened lazily on the first request and re-opened on drop —
//! that matches the bridge's lifecycle (per-run, tears down between prompts)
//! and means a bridge restart does not require the backend to be recreated.

use std::{
    io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{
        UnixStream,
        unix::{OwnedReadHalf, OwnedWriteHalf},
    },
    sync::{Mutex as AsyncMutex, oneshot},
    task::JoinHandle,
    time::timeout,
};

/// Maximum time we let a single request block waiting for a reply. Wraps the
/// bridge's own per-op timeouts so a wedged bridge cannot hang the caller
/// forever. Individual ops with legitimately long budgets (e.g. `wait_completion`)
/// pass a per-call timeout that overrides this.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The maximum length of a single NDJSON line we'll accept. Guards against a
/// malformed peer sending an unbounded reply that would OOM the reader.
const MAX_LINE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum SandboxClientError {
    #[error("sandbox bridge socket not configured (GROK_SANDBOX_SOCKET unset)")]
    NotConfigured,
    #[error("sandbox bridge io error: {0}")]
    Io(String),
    #[error("sandbox bridge closed the connection")]
    Closed,
    #[error("sandbox bridge did not reply within {} s", .0.as_secs())]
    Timeout(Duration),
    #[error("sandbox bridge returned an error: {0}")]
    Remote(String),
    #[error("sandbox bridge sent malformed json: {0}")]
    BadJson(String),
}

impl From<io::Error> for SandboxClientError {
    fn from(err: io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

impl SandboxClientError {
    /// Turn a client error into the string form the tool-runtime layer wants
    /// for its `ComputerError::io`.
    pub fn as_io_message(&self) -> String {
        format!("sandbox: {self}")
    }
}

#[derive(Serialize)]
struct Request<'a> {
    id: u64,
    op: &'a str,
    args: Value,
}

#[derive(Deserialize)]
struct Response {
    id: u64,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

type PendingMap = Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<Response>>>>;

/// A shared, cheap-to-clone handle to the sandbox bridge.
///
/// The connection state is behind an `AsyncMutex` so at most one reconnect can
/// happen at a time; a live connection is written back into the slot and every
/// subsequent request reuses it.
#[derive(Clone)]
pub struct SandboxClient {
    socket_path: PathBuf,
    next_id: Arc<AtomicU64>,
    conn: Arc<AsyncMutex<Option<Connection>>>,
    default_timeout: Duration,
}

struct Connection {
    writer: OwnedWriteHalf,
    pending: PendingMap,
    reader_task: JoinHandle<()>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        // Fail every outstanding request so callers unblock quickly, then let
        // the reader task exit on its own when the socket closes.
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(Response {
                id: 0,
                ok: Some(false),
                result: None,
                error: Some("connection dropped".to_string()),
            });
        }
        self.reader_task.abort();
    }
}

impl SandboxClient {
    /// Build a client bound to `socket_path`. No socket work is done until the
    /// first request — a missing bridge only fails a call, not construction.
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
            next_id: Arc::new(AtomicU64::new(1)),
            conn: Arc::new(AsyncMutex::new(None)),
            default_timeout: DEFAULT_REQUEST_TIMEOUT,
        }
    }

    /// Build a client from the `GROK_SANDBOX_SOCKET` env var, or `None` when
    /// unset — the caller then knows to fall back to a local backend rather
    /// than issue calls that would all fail.
    pub fn from_env() -> Option<Self> {
        std::env::var(super::SANDBOX_SOCKET_ENV)
            .ok()
            .filter(|v| !v.is_empty())
            .map(Self::new)
    }

    /// Send a request and wait for the paired response, subject to a per-call
    /// timeout when supplied (defaults to [`DEFAULT_REQUEST_TIMEOUT`]).
    ///
    /// A dropped connection is transparently reconnected on the next call —
    /// but this one still fails so a caller waiting on it isn't hidden from
    /// the fault.
    pub async fn call(
        &self,
        op: &str,
        args: Value,
        request_timeout: Option<Duration>,
    ) -> Result<Value, SandboxClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let mut line = serde_json::to_vec(&Request { id, op, args }).map_err(|e| {
            SandboxClientError::BadJson(format!("failed to encode request: {e}"))
        })?;
        line.push(b'\n');

        let pending = self.ensure_connection(id, tx).await?;
        let write_result = {
            let mut conn = self.conn.lock().await;
            match conn.as_mut() {
                Some(c) => c.writer.write_all(&line).await,
                None => {
                    pending.lock().remove(&id);
                    return Err(SandboxClientError::Closed);
                }
            }
        };
        if let Err(err) = write_result {
            pending.lock().remove(&id);
            // Drop the connection so the next call reconnects.
            *self.conn.lock().await = None;
            return Err(err.into());
        }

        let wait_for = request_timeout.unwrap_or(self.default_timeout);
        let reply = timeout(wait_for, rx).await;
        let response = match reply {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => {
                pending.lock().remove(&id);
                return Err(SandboxClientError::Closed);
            }
            Err(_) => {
                pending.lock().remove(&id);
                return Err(SandboxClientError::Timeout(wait_for));
            }
        };
        if response.ok == Some(false) {
            return Err(SandboxClientError::Remote(
                response.error.unwrap_or_else(|| "unknown".to_string()),
            ));
        }
        Ok(response.result.unwrap_or(Value::Null))
    }

    async fn ensure_connection(
        &self,
        id: u64,
        tx: oneshot::Sender<Response>,
    ) -> Result<PendingMap, SandboxClientError> {
        let mut slot = self.conn.lock().await;
        if slot.is_none() {
            *slot = Some(self.open_connection().await?);
        }
        let conn = slot.as_ref().expect("just filled");
        conn.pending.lock().insert(id, tx);
        Ok(conn.pending.clone())
    }

    async fn open_connection(&self) -> Result<Connection, SandboxClientError> {
        let stream = UnixStream::connect(&self.socket_path).await?;
        let (read_half, write_half) = stream.into_split();
        let pending: PendingMap = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let reader_pending = pending.clone();
        let reader_task = tokio::spawn(async move {
            reader_loop(read_half, reader_pending).await;
        });
        Ok(Connection {
            writer: write_half,
            pending,
            reader_task,
        })
    }
}

async fn reader_loop(read_half: OwnedReadHalf, pending: PendingMap) {
    let reader = BufReader::new(read_half);
    let mut lines = reader.lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.len() as u64 > MAX_LINE_BYTES {
                    // Fail all pending: a stream this broken cannot be recovered.
                    for (_, tx) in pending.lock().drain() {
                        let _ = tx.send(Response {
                            id: 0,
                            ok: Some(false),
                            result: None,
                            error: Some("bridge sent a line larger than MAX_LINE_BYTES".to_string()),
                        });
                    }
                    return;
                }
                match serde_json::from_str::<Response>(&line) {
                    Ok(response) => {
                        if let Some(tx) = pending.lock().remove(&response.id) {
                            let _ = tx.send(response);
                        }
                    }
                    Err(err) => {
                        // Log-worthy but do not tear the connection down for a
                        // single malformed line — the peer might have written
                        // a debug diagnostic that the framing swallowed.
                        tracing::warn!(target: "sandbox_bridge", %err, "malformed json from bridge; skipping");
                        continue;
                    }
                }
            }
            Ok(None) => {
                // EOF: bridge closed. Fail every pending, then return so the
                // task ends. The next `call` opens a fresh connection.
                for (_, tx) in pending.lock().drain() {
                    let _ = tx.send(Response {
                        id: 0,
                        ok: Some(false),
                        result: None,
                        error: Some("bridge closed the connection".to_string()),
                    });
                }
                return;
            }
            Err(err) => {
                tracing::warn!(target: "sandbox_bridge", %err, "read error, closing connection");
                for (_, tx) in pending.lock().drain() {
                    let _ = tx.send(Response {
                        id: 0,
                        ok: Some(false),
                        result: None,
                        error: Some(format!("bridge read error: {err}")),
                    });
                }
                return;
            }
        }
    }
}
