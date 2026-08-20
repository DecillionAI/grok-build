//! Translate grok's LOCAL session-workspace paths into sandbox paths.
//!
//! Grok resolves every model file path and the default shell cwd against the
//! CLI's own local session workspace (e.g. `/data/workspaces/grok-<session>`).
//! That directory does not exist inside the space's sandbox VM, whose current
//! directory is its own home (its workdir, `/workspace` by default). Without
//! translation a plain `bash ls` would `cd /data/workspaces/… || exit 127`, and
//! `read_file src/app.ts` — which grok first joins onto its local cwd — would
//! ask the sandbox for `/data/workspaces/…/src/app.ts`. Both miss.
//!
//! The map rewrites any path at or under the local root to a path RELATIVE to
//! the sandbox home: the local root itself becomes `""` (the home) and
//! `<root>/src/app.ts` becomes `src/app.ts`. The sandbox resolves a relative FS
//! path and an empty exec cwd against its home, so the agent's workspace and the
//! sandbox home line up without the CLI ever needing to know the sandbox's
//! absolute home path. Paths that are not under the local root (an absolute
//! sandbox path the model gave explicitly, `/etc/…`, `/tmp/…`) pass through
//! unchanged.

use std::path::Path;

/// Rewrites local-workspace paths to sandbox-relative ones. Cheap to clone.
#[derive(Clone, Debug, Default)]
pub struct PathMap {
    /// Canonical local workspace root, without a trailing separator. `None`
    /// disables translation (identity) — used in tests and whenever the host
    /// did not set `GROK_SANDBOX_LOCAL_ROOT` (e.g. a local self-test bridge).
    local_root: Option<String>,
}

impl PathMap {
    /// Identity map — every path passes through unchanged.
    pub fn identity() -> Self {
        Self { local_root: None }
    }

    /// Build from `GROK_SANDBOX_LOCAL_ROOT`. Empty or unset → identity.
    pub fn from_env() -> Self {
        match std::env::var(super::SANDBOX_LOCAL_ROOT_ENV) {
            Ok(v) if !v.is_empty() => Self::with_local_root(v),
            _ => Self::identity(),
        }
    }

    /// Build a map anchored at `root`. An empty root yields the identity map.
    pub fn with_local_root(root: impl Into<String>) -> Self {
        let mut root = root.into();
        // Normalise away trailing slashes so prefix matching is exact and the
        // root-equals-path case is unambiguous.
        while root.len() > 1 && root.ends_with('/') {
            root.pop();
        }
        Self {
            local_root: (!root.is_empty() && root != "/").then_some(root),
        }
    }

    /// Rewrite a filesystem path for the sandbox. Returns a sandbox-relative
    /// path when the input is at or under the local root, else the input
    /// unchanged.
    pub fn map_path(&self, path: &str) -> String {
        let Some(root) = self.local_root.as_deref() else {
            return path.to_string();
        };
        if path == root {
            // The workspace root itself → the sandbox home (empty relative path).
            return String::new();
        }
        if let Some(rest) = path.strip_prefix(root)
            && rest.starts_with('/')
        {
            return rest.trim_start_matches('/').to_string();
        }
        path.to_string()
    }

    /// Convenience wrapper for a [`Path`].
    pub fn map_os_path(&self, path: &Path) -> String {
        self.map_path(&path.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_passes_everything_through() {
        let m = PathMap::identity();
        assert_eq!(
            m.map_path("/data/workspaces/grok-x/src/app.ts"),
            "/data/workspaces/grok-x/src/app.ts"
        );
        assert_eq!(m.map_path("src/app.ts"), "src/app.ts");
        assert_eq!(m.map_path(""), "");
    }

    #[test]
    fn root_itself_maps_to_empty_home() {
        let m = PathMap::with_local_root("/data/workspaces/grok-x");
        assert_eq!(m.map_path("/data/workspaces/grok-x"), "");
    }

    #[test]
    fn descendant_maps_to_relative() {
        let m = PathMap::with_local_root("/data/workspaces/grok-x");
        assert_eq!(
            m.map_path("/data/workspaces/grok-x/src/app.ts"),
            "src/app.ts"
        );
        assert_eq!(m.map_path("/data/workspaces/grok-x/build"), "build");
    }

    #[test]
    fn trailing_slash_on_root_is_normalised() {
        let m = PathMap::with_local_root("/data/workspaces/grok-x/");
        assert_eq!(m.map_path("/data/workspaces/grok-x/src"), "src");
        assert_eq!(m.map_path("/data/workspaces/grok-x"), "");
    }

    #[test]
    fn paths_outside_root_are_unchanged() {
        let m = PathMap::with_local_root("/data/workspaces/grok-x");
        // A sibling that merely shares a textual prefix must NOT be rewritten.
        assert_eq!(
            m.map_path("/data/workspaces/grok-xtra/a"),
            "/data/workspaces/grok-xtra/a"
        );
        assert_eq!(m.map_path("/etc/hosts"), "/etc/hosts");
        assert_eq!(
            m.map_path("/workspace/already/there"),
            "/workspace/already/there"
        );
        assert_eq!(m.map_path("relative/path"), "relative/path");
    }

    #[test]
    fn empty_or_root_local_root_is_identity() {
        assert_eq!(PathMap::with_local_root("").map_path("/a/b"), "/a/b");
        assert_eq!(PathMap::with_local_root("/").map_path("/a/b"), "/a/b");
    }
}
