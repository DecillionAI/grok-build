# web_search tool creature.
# Build context is assembled by scripts/deploy_web_search_tool.py (ships the
# shared tools/_runtime/tool_runtime.py + caspar_bridge.py alongside this tool's
# tool.py + requirements). The search-provider API key is baked in as ENV by the
# deploy harness — it is never read from a signal payload.
#
# This creature makes outbound HTTPS directly (search-provider APIs + fetching
# pages) and keeps no per-space state and no files of its own; the bridge is used
# only to reply to the caller over the gateway.
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir \
    --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org \
    -r requirements.txt

COPY . /app

RUN mkdir -p /app/input
ENV DAVINCI_INPUT_DIR=/app/input PYTHONUNBUFFERED=1 TOOL_ID=web_search

CMD ["python", "tool_runtime.py"]
