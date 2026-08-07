#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# package-creature.sh — pre-build the Grok Build creature binary
# ─────────────────────────────────────────────────────────────
# Builds the `grok` CLI **from this repository's own Rust source** (never a
# downloaded release) and assembles a portable, self-contained bundle that a later
# deploy can drop into a Docker image with zero compilation.
#
# What it produces (under $OUT_DIR, default ./out):
#
#   bundle.tar.gz                 the deploy payload / docker build context:
#                                   bin/grok            (the compiled agent)
#                                   caspar/**           (the signaling bridge)
#   grok                          the raw binary, for a direct `./grok --version`
#   manifest.json                 version, git sha, sizes, build time, glibc
#
# `bundle.tar.gz` unpacks to `bin/` + `caspar/` at its root, which is exactly what
# `caspar/Dockerfile.prebuilt` expects (`ADD bundle.tar.gz /app`). The same tarball
# is what `deploy_grok_creature.py` ships to a Caspar node in prebuilt mode — so
# the heavy build happens here, once, and the deploy is a copy.
#
# glibc: the binary is dynamically linked, so the image it lands in must carry a
# glibc at least as new as this host's. The manifest records the build host's
# version and `caspar/Dockerfile.prebuilt` defaults to a Debian trixie base
# (glibc 2.41) for that reason. The image build runs `grok --version`, so a
# mismatch fails the build loudly rather than at an agent's first prompt.
#
# Usage:
#   scripts/package-creature.sh                 # build + package into ./out
#   OUT_DIR=/tmp/creature scripts/package-creature.sh
#   SKIP_BUILD=1 scripts/package-creature.sh    # reuse an existing bin/grok
#
# Env:
#   OUT_DIR       output directory                       (default ./out)
#   SKIP_BUILD    1 to skip the cargo build and package bin/grok as-is
#   CARGO_PROFILE cargo profile to build                 (default release)
#   PROTOC        protoc to use for the proto build      (default: bin/protoc via
#                 DotSlash when installed, else protoc on PATH)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${OUT_DIR:-$ROOT/out}"
PROFILE="${CARGO_PROFILE:-release}"

log() { printf '\033[36m[package]\033[0m %s\n' "$*"; }

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  command -v cargo >/dev/null 2>&1 || {
    echo "[package] ERROR: cargo not found — install the Rust toolchain (rustup) to build the creature" >&2
    exit 1
  }
  # protoc. `bin/protoc` is a DotSlash wrapper, so with DotSlash installed the build
  # resolves the repo's pinned protoc by itself and we stay out of the way.
  # Otherwise scripts/fetch_pinned_protoc.py finds one that can actually build this
  # tree: an explicit $PROTOC, a system protoc that is new enough, or — failing
  # both — a hash-verified download of exactly the version bin/protoc pins.
  # ("New enough" matters: the tools proto uses proto3 optional fields, which
  # protoc rejects before 3.15, and Ubuntu 22.04 still ships 3.12.)
  if command -v dotslash >/dev/null 2>&1 && [ -z "${PROTOC:-}" ]; then
    log "dotslash is installed — the build will use the pinned bin/protoc"
  else
    if PROTOC="$(python3 "$ROOT/scripts/fetch_pinned_protoc.py")" && [ -n "$PROTOC" ]; then
      export PROTOC
      log "protoc: $PROTOC ($("$PROTOC" --version 2>/dev/null || echo 'version unknown'))"
    else
      echo "[package] ERROR: could not resolve a usable protoc for the proto build." >&2
      echo "[package]        Install DotSlash ('cargo install dotslash') or set \$PROTOC to a protoc >= 3.15." >&2
      exit 1
    fi
  fi

  # The published creature bundle is a PORTABLE artifact: it must run on any deploy
  # host, not just this build runner. The repo's .cargo/config.toml pins
  # aarch64-unknown-linux-gnu to `target-cpu=neoverse-v2` (Graviton4), which emits
  # instructions that CRASH with SIGILL ("Illegal instruction", exit 132) on older
  # arm64 hosts (Graviton2/3 = Neoverse-N1/V1). For the creature we build the arm64
  # binary for a baseline CPU instead (the repo already uses `generic` for its musl
  # target). Set CREATURE_ARM64_TARGET_CPU to tune it (e.g. neoverse-n1). amd64 is
  # unaffected — its config carries no target-cpu, so it is already baseline.
  # A caller-provided RUSTFLAGS is respected as-is.
  case "$(uname -m)" in
    aarch64 | arm64)
      if [ -z "${RUSTFLAGS:-}" ]; then
        export RUSTFLAGS="-C target-cpu=${CREATURE_ARM64_TARGET_CPU:-generic} -C force-unwind-tables=yes"
        log "arm64: RUSTFLAGS=$RUSTFLAGS (portable baseline — overrides .cargo/config.toml neoverse-v2)"
      fi
      ;;
  esac

  log "building the agent (cargo build --$PROFILE -p xai-grok-pager-bin) — this takes a while"
  cargo build --locked "--$PROFILE" -p xai-grok-pager-bin

  mkdir -p bin
  cp "target/$PROFILE/xai-grok-pager" bin/grok
  strip bin/grok 2>/dev/null || true
  chmod +x bin/grok
else
  log "SKIP_BUILD=1 — packaging the existing bin/grok"
fi

if [ ! -x bin/grok ]; then
  echo "[package] ERROR: bin/grok not found — the build did not produce a binary" >&2
  exit 1
fi

log "verifying the binary runs"
BUILT_VERSION="$(./bin/grok --version 2>&1 | head -1)"
log "built CLI reports: $BUILT_VERSION"

# ── Assemble the portable bundle ─────────────────────────────
mkdir -p "$OUT_DIR"

# The tar arcnames are repo-relative (bin/…, caspar/…) so `ADD bundle.tar.gz /app`
# lands them at /app/bin and /app/caspar — the layout Dockerfile.prebuilt runs from.
# caspar/tests is shipped too (it is tiny) so the offline self-test image is
# self-contained; __pycache__ and node_modules never travel.
log "writing $OUT_DIR/bundle.tar.gz"
tar --exclude='__pycache__' --exclude='*.pyc' --exclude='node_modules' \
    -czf "$OUT_DIR/bundle.tar.gz" bin/grok caspar

cp bin/grok "$OUT_DIR/grok"

# ── Manifest ─────────────────────────────────────────────────
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
BIN_BYTES="$(wc -c < bin/grok | tr -d ' ')"
BUNDLE_BYTES="$(wc -c < "$OUT_DIR/bundle.tar.gz" | tr -d ' ')"
GLIBC="$(ldd --version 2>/dev/null | head -1 | awk '{print $NF}' || echo unknown)"
# The binary is a native ELF — it only runs on the CPU it was built for. Record
# the build arch so an amd64-vs-arm64 mismatch is visible in the manifest instead
# of surfacing as `Exec format error` at the image's `grok --version` smoke test.
BUILD_ARCH="$(uname -m 2>/dev/null || echo unknown)"

cat > "$OUT_DIR/manifest.json" <<JSON
{
  "cliVersion": "$(printf '%s' "$BUILT_VERSION" | sed 's/"/\\"/g')",
  "gitSha": "$GIT_SHA",
  "gitRef": "$GIT_REF",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "crates/ (this repository) — not a published release download",
  "buildGlibc": "$GLIBC",
  "buildArch": "$BUILD_ARCH",
  "buildRustflags": "$(printf '%s' "${RUSTFLAGS:-(from .cargo/config.toml)}" | sed 's/"/\\"/g')",
  "binBytes": $BIN_BYTES,
  "bundleBytes": $BUNDLE_BYTES
}
JSON

log "done — artifacts in $OUT_DIR:"
ls -lh "$OUT_DIR"
