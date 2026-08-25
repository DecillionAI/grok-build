# computer tool creature — an ORCHESTRATOR, not a desktop.
#
# Build context is assembled by scripts/deploy_computer_tool.py (ships the shared
# tools/_runtime/tool_runtime.py + caspar_bridge.py alongside this tool's tool.py
# + requirements). The COMPUTER_* tuning — and the sandbox tool's program id —
# are baked in as ENV by the deploy harness.
#
# This creature owns no graphical desktop of its own: the browser, VNC, noVNC and
# Cloudflare tunnel all run on the space's Modal/Vercel sandbox, which this
# creature drives through the `sandbox` tool over the gateway. So the image is
# thin — just Python + the shared runtime/bridge.
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir \
    --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org \
    -r requirements.txt

COPY . /app

RUN mkdir -p /app/input
ENV DAVINCI_INPUT_DIR=/app/input PYTHONUNBUFFERED=1 TOOL_ID=computer

CMD ["python", "tool_runtime.py"]
