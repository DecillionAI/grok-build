//! Remote terminal + filesystem backed by the space's Vercel Sandbox creature.
//!
//! Grok's built-in shell + file tools (`bash`, `read_file`, `edit`, `list_dir`,
//! `glob`, `grep`, `task`/`get_task_output`/`kill_task`, …) route through two
//! traits — [`TerminalBackend`](super::types::TerminalBackend) and
//! [`AsyncFileSystem`](super::types::AsyncFileSystem). Swapping in the sandbox
//! implementations makes every one of them execute against the space's shared
//! cloud VM instead of the CLI's private container, without touching the tools
//! themselves. See `caspar/sandboxBridge.mjs` in the deploy bridge for the JS
//! half of the seam.
//!
//! The wire is newline-delimited JSON over a unix domain socket whose path the
//! host exposes as `GROK_SANDBOX_SOCKET`. Every request is `{id, op, args}`;
//! every response is `{id, ok, result | error}`. See
//! [`client::SandboxClient`] for the protocol details.

pub mod client;
pub mod file_system;
pub mod path_map;
pub mod terminal;

pub use client::{SandboxClient, SandboxClientError};
pub use file_system::SandboxFileSystem;
pub use path_map::PathMap;
pub use terminal::SandboxTerminalBackend;

/// The env var the host sets on the grok child pointing at the sandbox bridge
/// socket. When present, the shell picks the sandbox backends over the local
/// ones. Absent means "use the local backend" (self-tests, development runs).
pub const SANDBOX_SOCKET_ENV: &str = "GROK_SANDBOX_SOCKET";

/// The env var the host sets to grok's LOCAL session-workspace root. The
/// sandbox backends rewrite any path at or under it to a path relative to the
/// sandbox home (see [`PathMap`]), so the agent's workspace lines up with the
/// sandbox VM's current directory. Absent means "no translation" (identity).
pub const SANDBOX_LOCAL_ROOT_ENV: &str = "GROK_SANDBOX_LOCAL_ROOT";
