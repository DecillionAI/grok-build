# zapier tool creature.
# Build context is assembled by scripts/deploy_zapier_tool.py (ships the shared
# tools/_runtime/tool_runtime.py + caspar_bridge.py alongside this tool's tool.py
# + requirements). The Zapier MCP connection token is baked in as ENV by the
# deploy harness from the repository's GitHub secret — it is never read from a
# signal payload an agent's prompt could influence.
#
# This creature makes outbound HTTPS directly (Zapier's MCP server) and keeps its
# per-space connections in the node's key/value store over the bridge, mirrored to
# /app/state so a warm container reads without a round trip. It also serves the
# Zapier MCP Embed "connect your apps" page on the node's VM HTTP ingress.
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir \
    --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org \
    -r requirements.txt

COPY . /app

RUN mkdir -p /app/input /app/state
ENV DAVINCI_INPUT_DIR=/app/input ZAPIER_STATE_DIR=/app/state PYTHONUNBUFFERED=1 TOOL_ID=zapier

CMD ["python", "tool_runtime.py"]
