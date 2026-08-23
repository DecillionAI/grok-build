# Grok Build Caspar creature image (source / release variants).
#
# Built and run by a Caspar node as a gVisor-sandboxed `docker` creature: the node
# builds this context, starts one container, and the container's only route to the
# outside world is the docker-host bridge gateway (see caspar/bridge.mjs).
#
# The agent is **this repository's own Grok Build source**, compiled here by the
# builder stage. That is a full cargo build of the workspace — correct, but slow
# and heavy for a node-side image build, so the *default* deploy path is
# caspar/Dockerfile.prebuilt (compile once on the CI host, ship the binary).
# Deploy with GROK_CLI_SOURCE=release to download the published `grok` binary
# instead — a fallback, not the default.
#
# The ECR mirror of the official images avoids Docker Hub anonymous-pull rate
# limits during node-side builds.

ARG RUNTIME_BASE=public.ecr.aws/docker/library/node:22-trixie-slim
ARG RUST_BASE=public.ecr.aws/docker/library/rust:1-trixie

# ── Stage 1: build the agent from this repo's source ─────────────────────────
FROM ${RUST_BASE} AS builder

WORKDIR /build

# >>> caspar-ca <<<
# (the deployer substitutes the host CA bundle here when it has one — an
# intercepting egress proxy would otherwise break every crate download)

# protobuf-compiler: the proto build resolves `bin/protoc` through DotSlash, which
# needs egress and a DotSlash install; the system protoc is what `$PROTOC` points
# the build at instead (see caspar/build/imageBuild.sh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends protobuf-compiler pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# The repo's source, shipped by the deployer (crates/, caspar/, Cargo.*, …).
ADD bundle.tar.gz /build

ARG GROK_CLI_SOURCE=source
RUN sh caspar/build/imageBuild.sh

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM ${RUNTIME_BASE}

# git: the agent works in a real repo-shaped workspace.
# ripgrep: the CLI's search tools.
# ca-certificates: outbound TLS (the xAI API, and the node's egress gateway).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# >>> caspar-ca <<<

# The signaling bridge, and the binary built from this repo's source.
COPY --from=builder /build/caspar /app/caspar
COPY --from=builder /build/bin /app/bin

# Fallback path only: with GROK_CLI_SOURCE=release nothing was built above, so
# install the published CLI. The runtime resolves `GROK_BIN` first and falls back
# to `grok` on PATH when that file does not exist, so both modes work with one
# entrypoint.
ARG GROK_CLI_SOURCE=source
RUN if [ "$GROK_CLI_SOURCE" = "release" ]; then \
      curl -fsSL https://x.ai/cli/install.sh | bash \
      && install -m 0755 "$(command -v grok || echo "$HOME/.grok/bin/grok")" /app/bin/grok; \
    fi \
    && /app/bin/grok --version

# The node uploads runtime inputs to /app/input before starting the container; the
# directory must exist for the upload (and the container start) to succeed. /data is
# the VM's persistent mount — session workspaces and the CLI's per-thread config
# live there so a conversation's files survive a container restart.
RUN mkdir -p /app/input /data/workspaces /data/grok-config \
    && useradd --create-home --shell /bin/bash grok \
    && chown -R grok:grok /app /data

# An autonomous agent has no human to approve tool calls, and nothing it does needs
# root — so the creature runs unprivileged.
USER grok
ENV HOME=/home/grok \
    NODE_ENV=production \
    GROK_BIN=/app/bin/grok \
    GROK_CREATURE_INPUT_DIR=/app/input \
    GROK_CREATURE_WORKSPACE_ROOT=/data/workspaces \
    GROK_CREATURE_CONFIG_DIR=/data/grok-config \
    GROK_CREATURE_BILLING_REQUIRED=1 \
    GROK_CREATURE_PERMISSION_MODE=bypassPermissions

# Serve prompts over the signaling API (the gateway path). With no gateway env
# injected, the same entrypoint answers one task from /app/input and exits — the
# offline self-test.
CMD ["node", "/app/caspar/runtime.mjs"]
