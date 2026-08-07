//! [`AsyncFileSystem`] implementation backed by the space's sandbox creature.
//!
//! Every read/write/delete becomes one call over the bridge socket, translated
//! to a `vercel_sandbox` action. The tool exposes `read` / `write` / `mkdir` /
//! `list_dir` natively; `delete` is not a first-class action there yet, so we
//! implement it as an `exec` of `rm -f` — safer than nothing while a proper
//! action lands in the sandbox tool.

use std::{path::Path, time::Duration};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};

use super::client::{SandboxClient, SandboxClientError};
use crate::computer::types::{AsyncFileSystem, ComputerError};

/// The sandbox-backed file system.
#[derive(Clone)]
pub struct SandboxFileSystem {
    client: SandboxClient,
}

impl SandboxFileSystem {
    pub fn new(client: SandboxClient) -> Self {
        Self { client }
    }

    /// Build from `GROK_SANDBOX_SOCKET`. `None` means the caller should fall
    /// back to a local filesystem.
    pub fn from_env() -> Option<Self> {
        SandboxClient::from_env().map(Self::new)
    }

    pub fn client(&self) -> SandboxClient {
        self.client.clone()
    }
}

fn ce(err: SandboxClientError) -> ComputerError {
    // We map "remote said the file does not exist" to `NotFound` so grok's
    // file-tool retry logic (which checks `io_error_kind`) behaves the same
    // way it does with the local filesystem.
    match &err {
        SandboxClientError::Remote(msg)
            if msg.contains("not found") || msg.contains("404") || msg.contains("ENOENT") =>
        {
            ComputerError::io_with_kind(err.as_io_message(), std::io::ErrorKind::NotFound)
        }
        _ => ComputerError::io(err.as_io_message()),
    }
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

const FS_REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

#[async_trait]
impl AsyncFileSystem for SandboxFileSystem {
    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, ComputerError> {
        let reply = self
            .client
            .call(
                "read",
                json!({ "path": path_str(path) }),
                Some(FS_REQUEST_TIMEOUT),
            )
            .await
            .map_err(ce)?;
        // `read` returns `{content, encoding, bytes}`; `encoding` is `text` or
        // `base64`. Text is UTF-8; base64 for binaries.
        let content = reply
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let encoding = reply
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or("text");
        if encoding == "base64" {
            BASE64.decode(content).map_err(|e| {
                ComputerError::io(format!("sandbox read: invalid base64 body: {e}"))
            })
        } else {
            Ok(content.as_bytes().to_vec())
        }
    }

    async fn write_file(&self, path: &Path, data: &[u8]) -> Result<(), ComputerError> {
        // Send everything as base64 so we don't have to guess whether the bytes
        // are valid UTF-8 or need escaping through JSON.
        let body = json!({
            "path": path_str(path),
            "content": BASE64.encode(data),
            "encoding": "base64",
        });
        self.client
            .call("write", body, Some(FS_REQUEST_TIMEOUT))
            .await
            .map_err(ce)?;
        Ok(())
    }

    async fn delete_file(&self, path: &Path) -> Result<(), ComputerError> {
        // The sandbox creature has no dedicated delete action yet; use `exec`
        // with `rm -f` (quoted). `rm -f` is idempotent on missing files, which
        // matches the trait's semantic contract for delete.
        let cmd = format!("rm -f -- {}", shell_quote(&path_str(path)));
        let body = json!({ "command": cmd, "timeout_ms": 15000_u64 });
        let reply = self
            .client
            .call("exec", body, Some(FS_REQUEST_TIMEOUT))
            .await
            .map_err(ce)?;
        let exit_code = reply.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
        if exit_code != 0 {
            let stderr = reply.get("stderr").and_then(Value::as_str).unwrap_or("");
            return Err(ComputerError::io(format!(
                "sandbox delete failed (exit={exit_code}): {stderr}"
            )));
        }
        Ok(())
    }
}

/// Quote a single argument for POSIX `sh -c '...'` — we wrap in single quotes
/// and escape embedded single quotes. Suitable for a file path.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}
