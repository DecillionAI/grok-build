//! [`TerminalBackend`] implementation that runs every command against the
//! space's shared cloud sandbox via the bridge socket.
//!
//! Design notes:
//!
//! - **Shared, cheap-to-clone.** The backend is wrapped in `Arc` and handed to
//!   every subagent's `ToolBridge`, matching grok's local backend which is
//!   passed as `Arc<dyn TerminalBackend>` too. Subagent isolation is by
//!   `owner_session_id` tags on the local task map, not by cloning the backend.
//!
//! - **Owner-tagged task table.** Every task the model spawns is stored in a
//!   local `HashMap<task_id, TaskState>` tagged with the request's
//!   `owner_session_id`. `kill_*_by_owner` filters over that map so a
//!   subagent's teardown never kills the parent's or a sibling's tasks —
//!   the same guarantee the local backend gives.
//!
//! - **Bridge is the state authority for output.** We do NOT stream stdout
//!   back over the socket; the sandbox holds the definitive output files on
//!   disk. `get_task` polls the bridge on demand and returns whatever the
//!   sandbox has. Callers that need incremental streaming can call the bridge
//!   directly through the tool surface.
//!
//! - **Persistent shell state is stateless-per-call.** Every `exec` POST on
//!   the sandbox spawns a fresh process; there is no cwd/env carryover across
//!   calls. That's a strict improvement over the local backend's one shared
//!   shell, because parallel subagents cannot clobber each other's cwd — but
//!   it does mean `get_shell_cwd()` returns `None` and models must pass
//!   explicit `cwd` in every request.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::client::{SandboxClient, SandboxClientError};
use crate::computer::types::{
    BackgroundHandle, ComputerError, KillOutcome, TaskKind, TaskSnapshot, TerminalBackend,
    TerminalRunRequest, TerminalRunResult,
};

/// Metadata we keep about every task the model spawns, whether foreground or
/// background. Kept minimal on purpose — the bridge is the authority on output,
/// exit and running-ness; we cache the last-seen values so `get_task` is
/// non-blocking when the caller just wants the current known state.
#[derive(Debug, Clone)]
struct TaskState {
    task_id: String,
    command: String,
    display_command: Option<String>,
    cwd: String,
    start_time: SystemTime,
    end_time: Option<SystemTime>,
    exit_code: Option<i32>,
    signal: Option<String>,
    completed: bool,
    truncated: bool,
    output: String,
    output_total_bytes: usize,
    output_file: PathBuf,
    kind: TaskKind,
    owner_session_id: Option<String>,
    description: Option<String>,
    is_backgrounded: bool,
    block_waited: bool,
    explicitly_killed: bool,
    /// Sandbox-side pid, kept for diagnostics — surfaced in
    /// `BackgroundHandle.pid`, but the trait `TaskSnapshot` has no `pid`
    /// field, so it's not propagated further. Retain for future kill-by-pid
    /// paths without another round trip.
    #[allow(dead_code)]
    pid: Option<u32>,
    stdout_offset: usize,
    stderr_offset: usize,
    /// Cursor into the concatenated `stdout` + `stderr` buffer we've handed
    /// to `output`. Guards against a poll returning the same tail twice.
    output_bytes_seen: usize,
}

impl TaskState {
    fn snapshot(&self) -> TaskSnapshot {
        TaskSnapshot {
            task_id: self.task_id.clone(),
            command: self.command.clone(),
            display_command: self.display_command.clone(),
            cwd: self.cwd.clone(),
            start_time: self.start_time,
            end_time: self.end_time,
            output: self.output.clone(),
            output_file: self.output_file.clone(),
            truncated: self.truncated,
            output_total_bytes: self.output_total_bytes,
            exit_code: self.exit_code,
            signal: self.signal.clone(),
            completed: self.completed,
            kind: self.kind,
            block_waited: self.block_waited,
            explicitly_killed: self.explicitly_killed,
            owner_session_id: self.owner_session_id.clone(),
            description: self.description.clone(),
            is_backgrounded: self.is_backgrounded,
        }
    }
}

#[derive(Default)]
struct Inner {
    tasks: HashMap<String, TaskState>,
}

/// The sandbox-backed terminal backend.
///
/// Constructed with a live [`SandboxClient`] (usually via [`from_env`]) and
/// handed to grok's shell as `Arc<dyn TerminalBackend>`.
#[derive(Clone)]
pub struct SandboxTerminalBackend {
    client: SandboxClient,
    inner: Arc<Mutex<Inner>>,
    /// Cap on output kept in memory per task; the sandbox keeps the full
    /// record on disk, so this is only about how big of a slice we hand back
    /// to `TaskSnapshot::output`.
    max_inline_output: usize,
}

impl SandboxTerminalBackend {
    /// Build from an existing client. Prefer [`from_env`] outside tests.
    pub fn new(client: SandboxClient) -> Self {
        Self {
            client,
            inner: Arc::new(Mutex::new(Inner::default())),
            max_inline_output: 256 * 1024,
        }
    }

    /// Build from `GROK_SANDBOX_SOCKET`; returns `None` when unset so the
    /// caller falls back to the local backend without issuing failing calls.
    pub fn from_env() -> Option<Self> {
        SandboxClient::from_env().map(Self::new)
    }

    /// Access the underlying client — useful when the caller wants to share
    /// one socket between the terminal backend and the file system.
    pub fn client(&self) -> SandboxClient {
        self.client.clone()
    }

    fn insert_task(&self, state: TaskState) {
        self.inner.lock().tasks.insert(state.task_id.clone(), state);
    }

    fn with_task<T>(&self, task_id: &str, f: impl FnOnce(&mut TaskState) -> T) -> Option<T> {
        self.inner.lock().tasks.get_mut(task_id).map(f)
    }

    fn get_task_clone(&self, task_id: &str) -> Option<TaskState> {
        self.inner.lock().tasks.get(task_id).cloned()
    }

    /// Fold a poll's stdout/stderr chunks into the task's inline output cache,
    /// bump running-status/exit-code, and record byte totals.
    fn apply_poll(&self, task_id: &str, poll: &PollOutput) {
        self.with_task(task_id, |state| {
            state.stdout_offset = poll.stdout_next_offset;
            state.stderr_offset = poll.stderr_next_offset;
            state.output_total_bytes = poll.stdout_total.saturating_add(poll.stderr_total);
            let mut appended = String::with_capacity(poll.stdout.len() + poll.stderr.len());
            if !poll.stdout.is_empty() {
                appended.push_str(&poll.stdout);
            }
            if !poll.stderr.is_empty() {
                if !appended.is_empty() && !appended.ends_with('\n') {
                    appended.push('\n');
                }
                appended.push_str(&poll.stderr);
            }
            if !appended.is_empty() {
                state.output.push_str(&appended);
                state.output_bytes_seen = state.output_bytes_seen.saturating_add(appended.len());
                if state.output.len() > self_max_output() {
                    // Keep the tail so the model sees recent output; mark
                    // truncated so consumers know to read `output_file`.
                    let excess = state.output.len() - self_max_output();
                    let start = find_char_boundary(&state.output, excess);
                    state.output = state.output[start..].to_string();
                    state.truncated = true;
                }
            }
            if let Some(code) = poll.exit_code {
                state.exit_code = Some(code);
                state.completed = true;
                if state.end_time.is_none() {
                    state.end_time = Some(SystemTime::now());
                }
            } else if !poll.running && state.exit_code.is_none() {
                // The bridge reports the task as gone with no exit code — the
                // process died without our watcher recording a code. Mark it
                // completed anyway so callers don't wait forever.
                state.completed = true;
                if state.end_time.is_none() {
                    state.end_time = Some(SystemTime::now());
                }
            }
            if poll.killed {
                state.explicitly_killed = true;
            }
        });
    }
}

fn self_max_output() -> usize {
    256 * 1024
}

/// Walk from `desired_start` forward to the next UTF-8 character boundary in
/// `s` so we never split a multibyte scalar when trimming the output cache.
fn find_char_boundary(s: &str, desired_start: usize) -> usize {
    let mut i = desired_start.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Parsed shape of the sandbox's `get_output` reply. Kept private so the
/// bridge's exact key names can evolve independently of the trait code.
#[derive(Debug, Default, Clone)]
struct PollOutput {
    running: bool,
    exit_code: Option<i32>,
    killed: bool,
    stdout: String,
    stderr: String,
    stdout_total: usize,
    stderr_total: usize,
    stdout_next_offset: usize,
    stderr_next_offset: usize,
}

fn parse_poll(v: &Value) -> PollOutput {
    fn u(v: &Value, key: &str) -> usize {
        v.get(key).and_then(Value::as_u64).unwrap_or(0) as usize
    }
    fn s(v: &Value, key: &str) -> String {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }
    fn i(v: &Value, key: &str) -> Option<i32> {
        v.get(key).and_then(Value::as_i64).map(|n| n as i32)
    }
    PollOutput {
        running: v.get("running").and_then(Value::as_bool).unwrap_or(false),
        exit_code: i(v, "exit_code"),
        killed: v.get("killed").and_then(Value::as_bool).unwrap_or(false),
        stdout: s(v, "stdout"),
        stderr: s(v, "stderr"),
        stdout_total: u(v, "stdout_total"),
        stderr_total: u(v, "stderr_total"),
        stdout_next_offset: u(v, "stdout_next_offset"),
        stderr_next_offset: u(v, "stderr_next_offset"),
    }
}

/// Convert the sandbox's foreground `exec` reply into the trait's
/// `TerminalRunResult`. The sandbox truncates its `stdout`/`stderr` at
/// `MAX_OUTPUT_CHARS` (60 KB by default); we forward that truncation flag by
/// leaving it up to grok's own limiter — if the combined output equals the
/// byte cap, `truncated` becomes true.
fn parse_foreground(v: &Value, byte_limit: usize, output_file: PathBuf) -> TerminalRunResult {
    let stdout = v.get("stdout").and_then(Value::as_str).unwrap_or_default();
    let stderr = v.get("stderr").and_then(Value::as_str).unwrap_or_default();
    let exit_code = v.get("exit_code").and_then(Value::as_i64).map(|n| n as i32);
    let mut combined = String::with_capacity(stdout.len() + stderr.len() + 8);
    combined.push_str(stdout);
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(stderr);
    }
    let total_bytes = combined.len();
    let truncated = total_bytes >= byte_limit;
    if truncated {
        // Trim on a char boundary so we don't hand back invalid UTF-8.
        let cut = find_char_boundary(&combined, byte_limit.min(total_bytes));
        combined.truncate(cut);
    }
    TerminalRunResult {
        combined_output: combined,
        exit_code,
        truncated,
        signal: None,
        timed_out: false,
        output_file,
        total_bytes,
        pid: None,
    }
}

/// Best-effort local write of the combined output to `output_file`, so
/// `read_file` on the file works the same way it does with the local backend.
fn write_output_file(path: &std::path::Path, contents: &str) {
    if path.as_os_str().is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, contents.as_bytes());
}

fn args_for_run(request: &TerminalRunRequest) -> Value {
    let mut env = serde_json::Map::new();
    for (k, v) in &request.env {
        env.insert(k.clone(), Value::String(v.clone()));
    }
    json!({
        "command": request.command,
        "cwd": request.working_directory.to_string_lossy(),
        "env": Value::Object(env),
        "timeout_ms": request.timeout.as_millis() as u64,
    })
}

fn args_for_background(request: &TerminalRunRequest, task_id: &str) -> Value {
    let mut env = serde_json::Map::new();
    for (k, v) in &request.env {
        env.insert(k.clone(), Value::String(v.clone()));
    }
    json!({
        "task_id": task_id,
        "command": request.command,
        "cwd": request.working_directory.to_string_lossy(),
        "env": Value::Object(env),
    })
}

fn args_for_poll(task_id: &str, state: &TaskState, max_bytes: usize) -> Value {
    json!({
        "task_id": task_id,
        "stdout_offset": state.stdout_offset,
        "stderr_offset": state.stderr_offset,
        "max_bytes": max_bytes,
    })
}

fn args_for_wait(task_id: &str, timeout_ms: u64) -> Value {
    json!({ "task_id": task_id, "timeout_ms": timeout_ms })
}

fn args_for_kill(task_id: &str, signal: Option<&str>) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("task_id".to_string(), Value::String(task_id.to_string()));
    if let Some(sig) = signal {
        m.insert("signal".to_string(), Value::String(sig.to_string()));
    }
    Value::Object(m)
}

fn client_error_to_computer(err: SandboxClientError) -> ComputerError {
    ComputerError::io(err.as_io_message())
}

fn build_task_state(
    request: &TerminalRunRequest,
    task_id: String,
    pid: Option<u32>,
    is_backgrounded: bool,
) -> TaskState {
    TaskState {
        task_id,
        command: request.command.clone(),
        display_command: request.display_command.clone(),
        cwd: request.working_directory.to_string_lossy().to_string(),
        start_time: SystemTime::now(),
        end_time: None,
        exit_code: None,
        signal: None,
        completed: false,
        truncated: false,
        output: String::new(),
        output_total_bytes: 0,
        output_file: request.output_file.clone(),
        kind: request.kind,
        owner_session_id: request.owner_session_id.clone(),
        description: request.description.clone(),
        is_backgrounded,
        block_waited: false,
        explicitly_killed: false,
        pid,
        stdout_offset: 0,
        stderr_offset: 0,
        output_bytes_seen: 0,
    }
}

#[async_trait]
impl TerminalBackend for SandboxTerminalBackend {
    async fn run(
        &self,
        request: TerminalRunRequest,
    ) -> Result<TerminalRunResult, ComputerError> {
        let byte_limit = if request.output_byte_limit == 0 {
            self.max_inline_output
        } else {
            request.output_byte_limit
        };
        let output_file = request.output_file.clone();
        let args = args_for_run(&request);
        // Bound the bridge wait a little longer than the command's own
        // timeout so a wedged POST cannot hang the shell indefinitely.
        let wait = request.timeout.saturating_add(Duration::from_secs(30));
        let reply = self
            .client
            .call("exec", args, Some(wait))
            .await
            .map_err(client_error_to_computer)?;
        let mut result = parse_foreground(&reply, byte_limit, output_file.clone());
        // If the sandbox timed out we honour that on the trait side. The
        // creature does not currently surface a distinct timed-out flag on
        // foreground exec — plumb it through when it does.
        if result.exit_code.is_none() {
            result.timed_out = request.timeout.is_zero()
                || reply
                    .get("timed_out")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
        }
        write_output_file(&output_file, &result.combined_output);
        Ok(result)
    }

    async fn run_background(
        &self,
        request: TerminalRunRequest,
    ) -> Result<BackgroundHandle, ComputerError> {
        // Our task_id is our source of truth — grok cross-references it, so
        // we generate on this side and the sandbox mirrors it.
        let task_id = new_task_id();
        let args = args_for_background(&request, &task_id);
        let reply = self
            .client
            .call("exec_background", args, Some(Duration::from_secs(60)))
            .await
            .map_err(client_error_to_computer)?;
        let pid = reply
            .get("pid")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .or_else(|| reply.get("pid").and_then(|v| v.as_u64()).map(|n| n as u32));
        let output_file = request.output_file.clone();
        self.insert_task(build_task_state(&request, task_id.clone(), pid, true));
        // Best-effort: create the output file so `read_file` from grok is a
        // valid path even before the first poll fills it.
        if !output_file.as_os_str().is_empty() {
            if let Some(parent) = output_file.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&output_file, b"");
        }
        Ok(BackgroundHandle {
            task_id,
            output_file,
            pid,
        })
    }

    async fn get_task(&self, task_id: &str) -> Option<TaskSnapshot> {
        let state = self.get_task_clone(task_id)?;
        if state.completed {
            return Some(state.snapshot());
        }
        let args = args_for_poll(task_id, &state, 128 * 1024);
        let reply = self
            .client
            .call("get_output", args, Some(Duration::from_secs(30)))
            .await
            .ok()?;
        let poll = parse_poll(&reply);
        self.apply_poll(task_id, &poll);
        let updated = self.get_task_clone(task_id)?;
        // Mirror output-to-disk so `read_file(output_file)` reflects the
        // latest known state without a second call.
        write_output_file(&updated.output_file, &updated.output);
        Some(updated.snapshot())
    }

    async fn kill_task(&self, task_id: &str) -> KillOutcome {
        let existed = self.get_task_clone(task_id).is_some();
        let reply = self
            .client
            .call(
                "kill_task",
                args_for_kill(task_id, Some("TERM")),
                Some(Duration::from_secs(45)),
            )
            .await;
        match reply {
            Ok(v) => {
                let status = v
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("ok")
                    .to_string();
                self.with_task(task_id, |state| {
                    state.explicitly_killed = true;
                    if !state.completed {
                        state.completed = true;
                        state.end_time = Some(SystemTime::now());
                        state.signal = Some("SIGTERM".to_string());
                    }
                });
                match status.as_str() {
                    "missing" => {
                        if existed {
                            KillOutcome::AlreadyExited
                        } else {
                            KillOutcome::NotFound
                        }
                    }
                    "notfound" => KillOutcome::AlreadyExited,
                    _ => KillOutcome::Killed,
                }
            }
            Err(_) => {
                if existed {
                    KillOutcome::AlreadyExited
                } else {
                    KillOutcome::NotFound
                }
            }
        }
    }

    async fn kill_foreground_commands(&self) {
        // Foreground execs are synchronous on the trait — there is nothing to
        // kill separately. This is a no-op on purpose (matching what the ACP
        // backend does): a cancelled turn drops the outstanding future and
        // the sandbox's foreground POST returns on its own timeout.
    }

    async fn kill_foreground_commands_by_owner(&self, _owner_session_id: &str) {
        // Same reasoning as `kill_foreground_commands`.
    }

    async fn kill_all_background_tasks(&self) {
        let ids: Vec<String> = self
            .inner
            .lock()
            .tasks
            .iter()
            .filter_map(|(id, state)| {
                if state.is_backgrounded && !state.completed {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in ids {
            let _ = self.kill_task(&id).await;
        }
    }

    async fn kill_all_background_tasks_by_owner(&self, owner_session_id: &str) {
        let ids: Vec<String> = self
            .inner
            .lock()
            .tasks
            .iter()
            .filter_map(|(id, state)| {
                if state.is_backgrounded
                    && !state.completed
                    && state.owner_session_id.as_deref() == Some(owner_session_id)
                {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in ids {
            let _ = self.kill_task(&id).await;
        }
    }

    async fn wait_for_completion(
        &self,
        task_id: &str,
        wait_timeout: Option<Duration>,
    ) -> Option<TaskSnapshot> {
        // Bound the wait: `None` means "as long as it takes" per the trait —
        // but we still cap it hard so a stuck sandbox does not wedge a turn.
        let dur = wait_timeout.unwrap_or(Duration::from_secs(6 * 3600));
        let dur = dur.min(Duration::from_secs(6 * 3600));
        let existing = self.get_task_clone(task_id)?;
        if existing.completed {
            return Some(existing.snapshot());
        }
        let reply = self
            .client
            .call(
                "wait_completion",
                args_for_wait(task_id, dur.as_millis() as u64),
                Some(dur.saturating_add(Duration::from_secs(30))),
            )
            .await
            .ok()?;
        // wait_exec already piggybacks a final get_output payload, so parse
        // and apply it before returning the snapshot.
        let poll = parse_poll(&reply);
        self.apply_poll(task_id, &poll);
        let updated = self.get_task_clone(task_id)?;
        write_output_file(&updated.output_file, &updated.output);
        Some(updated.snapshot())
    }

    async fn list_tasks(&self) -> Vec<TaskSnapshot> {
        self.inner
            .lock()
            .tasks
            .values()
            .map(TaskState::snapshot)
            .collect()
    }

    async fn get_shell_cwd(&self) -> Option<PathBuf> {
        // The sandbox spawns a fresh process per POST — no persistent shell,
        // no meaningful cwd to remember. Callers must pass cwd per request.
        None
    }

    async fn background_foreground_command(&self, _tool_call_id: &str) -> bool {
        // We don't hold a live pipe on foreground exec, so there is nothing to
        // move to background — the caller can re-issue with run_background.
        false
    }

    async fn reparent_notifications(
        &self,
        _old_owner_session_id: &str,
        _new_owner_session_id: &str,
        _new_handle: crate::notification::types::ToolNotificationHandle,
        _backend_weak: std::sync::Weak<dyn TerminalBackend>,
    ) {
        // We don't stream notifications from the sandbox; nothing to reparent.
    }

    async fn warm_shell(&self, _cwd: &std::path::Path) {
        // No local shell to warm. A `noop` here matches the ACP backend.
    }
}

fn new_task_id() -> String {
    // Uuid v7 gives us monotonic, short IDs whose form matches `_TASK_ID_RE`
    // in the sandbox tool (base16 with hyphens).
    let id = uuid::Uuid::now_v7();
    format!("t-{}", id.simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::types::TaskKind;
    use crate::notification::types::ToolNotificationHandle;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn make_backend() -> SandboxTerminalBackend {
        // A client pointed at a path that will fail to connect. Callers who
        // exercise the trait without a live socket get bridge errors — the
        // point of the tests here is the local table logic (owner-scoped
        // filtering, snapshot construction), not the network layer.
        SandboxTerminalBackend::new(SandboxClient::new(PathBuf::from("/tmp/no-such-sock")))
    }

    fn dummy_request(owner: Option<&str>, _background: bool) -> TerminalRunRequest {
        TerminalRunRequest {
            command: "true".to_string(),
            working_directory: PathBuf::from("/tmp"),
            env: HashMap::new(),
            timeout: Duration::from_secs(5),
            output_byte_limit: 4096,
            output_file: PathBuf::new(),
            notification_handle: ToolNotificationHandle::noop(),
            tool_call_id: format!("tc-{}", owner.unwrap_or("root")),
            display_command: None,
            auto_background_on_timeout: false,
            foreground_block_budget: None,
            kind: TaskKind::Bash,
            owner_session_id: owner.map(String::from),
            description: None,
        }
    }

    #[test]
    fn owner_scoped_map_filtering_ignores_other_sessions() {
        let backend = make_backend();
        backend.insert_task(build_task_state(
            &dummy_request(Some("subagent-1"), true),
            "t-a".into(),
            None,
            true,
        ));
        backend.insert_task(build_task_state(
            &dummy_request(Some("parent-0"), true),
            "t-b".into(),
            None,
            true,
        ));
        let inner = backend.inner.lock();
        let mine: Vec<&str> = inner
            .tasks
            .values()
            .filter(|s| s.owner_session_id.as_deref() == Some("subagent-1"))
            .map(|s| s.task_id.as_str())
            .collect();
        assert_eq!(mine, vec!["t-a"]);
    }

    #[test]
    fn snapshot_carries_owner_and_backgrounded_bits() {
        let state = build_task_state(&dummy_request(Some("s-1"), true), "t-x".into(), None, true);
        let snap = state.snapshot();
        assert_eq!(snap.owner_session_id.as_deref(), Some("s-1"));
        assert!(snap.is_backgrounded);
        assert!(!snap.completed);
    }

    #[test]
    fn apply_poll_marks_completed_and_records_exit() {
        let backend = make_backend();
        backend.insert_task(build_task_state(
            &dummy_request(None, true),
            "t-x".into(),
            None,
            true,
        ));
        let poll = PollOutput {
            running: false,
            exit_code: Some(0),
            killed: false,
            stdout: "hello\n".to_string(),
            stderr: String::new(),
            stdout_total: 6,
            stderr_total: 0,
            stdout_next_offset: 6,
            stderr_next_offset: 0,
        };
        backend.apply_poll("t-x", &poll);
        let snap = backend.get_task_clone("t-x").unwrap().snapshot();
        assert_eq!(snap.exit_code, Some(0));
        assert!(snap.completed);
        assert_eq!(snap.output, "hello\n");
    }
}
