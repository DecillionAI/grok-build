#!/bin/sh
# Build the agent binary inside the creature image.
#
# Run by caspar/Dockerfile's builder stage, from the repo root. Three modes:
#
#   prebuilt (default) — do NOT compile; a `grok` binary built earlier (in CI, from
#                        this same source — scripts/package-creature.sh) is already
#                        in the build context. Just prove it runs. This is the
#                        lightweight deploy path: the heavy build happened once on
#                        the CI host, so the node-side build touches neither
#                        crates.io nor a compiler.
#   source             — compile this repository's Rust source into
#                        `target/release/xai-grok-pager`. Correct, but a full
#                        workspace build: tens of minutes and several GB inside the
#                        node's image builder.
#   release            — build nothing; the runtime stage downloads the published
#                        `grok` binary instead (a fallback for when this source
#                        snapshot cannot be built on the node at all).
#
# Env: GROK_CLI_SOURCE=prebuilt|source|release
set -eu

MODE="${GROK_CLI_SOURCE:-prebuilt}"
OUT=bin/grok

if [ "$MODE" = "release" ]; then
  echo "[caspar] GROK_CLI_SOURCE=release — skipping the source build (the runtime stage downloads the published CLI)"
  mkdir -p bin
  exit 0
fi

if [ "$MODE" = "prebuilt" ]; then
  echo "[caspar] GROK_CLI_SOURCE=prebuilt — using the binary shipped in the build context"
  if [ ! -x "$OUT" ]; then
    echo "[caspar] ERROR: prebuilt mode, but $OUT is not in the build context." >&2
    echo "[caspar]        Build it first (scripts/package-creature.sh) or use GROK_CLI_SOURCE=source." >&2
    exit 1
  fi
  echo "[caspar] verifying the prebuilt binary runs"
  "./$OUT" --version
  echo "[caspar] using prebuilt agent: $("./$OUT" --version)"
  exit 0
fi

echo "[caspar] building the agent from crates/ (cargo --release, this takes a while)"
# `bin/protoc` is a DotSlash wrapper that downloads its payload; the image has no
# DotSlash and (usually) no egress to fetch it, so point the proto build at the
# system protoc the builder stage installed. find_protoc() prefers $PROTOC.
PROTOC="${PROTOC:-$(command -v protoc || true)}"
export PROTOC
[ -n "$PROTOC" ] || { echo "[caspar] ERROR: no protoc available for the proto build" >&2; exit 1; }
# The tools proto uses proto3 optional fields, which protoc rejects before 3.15
# ("--experimental_allow_proto3_optional was not set") from deep inside a build
# script. Fail here instead, where the reason is obvious.
protoc_ver="$("$PROTOC" --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/')"
set -- $protoc_ver
if [ "${1:-0}" -lt 3 ] || { [ "${1:-0}" -eq 3 ] && [ "${2:-0}" -lt 15 ]; }; then
  echo "[caspar] ERROR: $PROTOC is $("$PROTOC" --version 2>/dev/null) — this tree needs protoc >= 3.15" >&2
  echo "[caspar]        (its proto3 optional fields are rejected by older releases)" >&2
  exit 1
fi

cargo build --release --locked -p xai-grok-pager-bin
mkdir -p bin
cp target/release/xai-grok-pager "$OUT"
strip "$OUT" 2>/dev/null || true
chmod +x "$OUT"
echo "[caspar] verifying the built binary runs"
"./$OUT" --version
echo "[caspar] agent built from source: $("./$OUT" --version)"
