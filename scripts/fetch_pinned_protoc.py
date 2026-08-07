#!/usr/bin/env python3
"""Resolve a protoc new enough to build this workspace, printing its path.

The proto build needs `protoc`, and this repo pins an exact one in `bin/protoc` —
a DotSlash manifest naming a release URL and its sha256 per platform. Developers
get it through DotSlash; a CI runner or a deploy host usually has neither DotSlash
nor a protoc recent enough.

"Recent enough" is not a detail: the tools proto uses **proto3 optional fields**,
which protoc rejects before 3.15 with

    grok-tools.proto: This file contains proto3 optional fields, but
    --experimental_allow_proto3_optional was not set.

and that surfaces as a build-script panic ten crates deep. Ubuntu 22.04's
`protobuf-compiler` is 3.12.4, so "just apt-get install protobuf-compiler" is a
trap on the very runner we pin for its old glibc.

So: use `$PROTOC` if the caller set one, else a system protoc that is new enough,
else download exactly the version `bin/protoc` pins and verify its digest. The
download is cached by digest, so a repeat run (or a bumped pin) does the right
thing without a version hardcoded anywhere but `bin/protoc`.

Usage:  PROTOC="$(python3 scripts/fetch_pinned_protoc.py)"   # path on stdout
Notes on output: progress/diagnostics go to stderr, the path alone to stdout, so
this is safe to use in a command substitution.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
# proto3 optional support landed in 3.15; anything older cannot build this tree.
MIN_VERSION = (3, 15)


def note(message: str) -> None:
    print(f"[protoc] {message}", file=sys.stderr)


def protoc_version(binary: str) -> tuple[int, ...] | None:
    """`protoc --version` → (major, minor, patch), or None when it will not run."""
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", out.stdout or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups(default="0"))


def platform_key() -> str:
    """The DotSlash platform key for this host."""
    machine = platform.machine().lower()
    arch = "aarch64" if machine in ("aarch64", "arm64") else "x86_64"
    system = "macos" if platform.system() == "Darwin" else "linux"
    return f"{system}-{arch}"


def pinned_entry() -> dict:
    """The `bin/protoc` DotSlash manifest entry for this platform."""
    raw = (REPO / "bin" / "protoc").read_text(encoding="utf-8")
    # Strip the `#!/usr/bin/env dotslash` shebang (and any comment lines) so what
    # is left is the JSON body.
    body = "\n".join(line for line in raw.splitlines() if not line.startswith("#"))
    manifest = json.loads(body[body.index("{") :])
    key = platform_key()
    entry = manifest.get("platforms", {}).get(key)
    if not entry:
        raise SystemExit(f"[protoc] bin/protoc pins no build for {key}")
    return entry


def extract(archive: bytes, fmt: str, member: str, target_dir: Path) -> Path:
    """Pull one member out of the downloaded archive; returns its path."""
    target_dir.mkdir(parents=True, exist_ok=True)
    if fmt == "zip":
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            with zf.open(member) as src, open(target_dir / "protoc", "wb") as dst:
                shutil.copyfileobj(src, dst)
    elif fmt in ("tar.gz", "tar.zst", "tar.xz", "tar"):
        mode = "r:gz" if fmt == "tar.gz" else ("r:xz" if fmt == "tar.xz" else "r:*")
        with tarfile.open(fileobj=io.BytesIO(archive), mode=mode) as tf:
            src = tf.extractfile(member)
            if src is None:
                raise SystemExit(f"[protoc] {member} is not a file in the pinned archive")
            with open(target_dir / "protoc", "wb") as dst:
                shutil.copyfileobj(src, dst)
    else:
        raise SystemExit(f"[protoc] unsupported archive format in bin/protoc: {fmt}")
    path = target_dir / "protoc"
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def download_pinned() -> Path:
    entry = pinned_entry()
    digest = entry["digest"]
    cache = Path(os.environ.get("PROTOC_CACHE_DIR", REPO / ".protoc-cache")) / digest
    cached = cache / "protoc"
    if cached.exists():
        note(f"using the cached pinned protoc ({cached})")
        return cached

    providers = entry.get("providers") or []
    url = next((p.get("url") for p in providers if p.get("url")), None)
    if not url:
        raise SystemExit("[protoc] bin/protoc names no download URL for this platform")

    note(f"downloading the protoc this repo pins: {url}")
    with urllib.request.urlopen(url, timeout=180) as response:  # noqa: S310 (URL comes from the repo)
        blob = response.read()

    actual = hashlib.sha256(blob).hexdigest()
    if entry.get("hash", "sha256") != "sha256":
        raise SystemExit(f"[protoc] unsupported hash type in bin/protoc: {entry.get('hash')}")
    if actual != digest:
        # A mismatch means the pinned artifact is not what the repo expects. Never
        # build against it.
        raise SystemExit(f"[protoc] digest mismatch for {url}\n  expected {digest}\n  got      {actual}")

    path = extract(blob, entry.get("format", "zip"), entry.get("path", "bin/protoc"), cache)
    note(f"pinned protoc ready at {path}")
    return path


def main() -> int:
    # 1. An explicit $PROTOC is the caller's decision — honour it if it runs.
    explicit = os.environ.get("PROTOC", "").strip()
    if explicit:
        version = protoc_version(explicit)
        if version:
            if version < MIN_VERSION:
                note(f"WARNING: $PROTOC is {'.'.join(map(str, version))}, older than "
                     f"{'.'.join(map(str, MIN_VERSION))} — the proto3 optional fields in this tree will fail to compile")
            print(explicit)
            return 0
        note(f"WARNING: $PROTOC={explicit} does not run; looking for another protoc")

    # 2. A system protoc, but only when it is new enough to build this tree.
    system = shutil.which("protoc")
    if system:
        version = protoc_version(system)
        if version and version >= MIN_VERSION:
            note(f"using the system protoc {'.'.join(map(str, version))} at {system}")
            print(system)
            return 0
        found = ".".join(map(str, version)) if version else "unknown"
        note(f"the system protoc at {system} is {found}, older than {'.'.join(map(str, MIN_VERSION))} — "
             "falling back to the version this repo pins")

    # 3. The repo's own pin, hash-verified.
    print(download_pinned())
    return 0


if __name__ == "__main__":
    sys.exit(main())
