# github tool creature.
# Build context is assembled by scripts/deploy_github_tool.py (ships the shared
# tools/_runtime/tool_runtime.py + caspar_bridge.py alongside this tool's tool.py
# + requirements). The GitHub OAuth app credentials are baked in as ENV by the
# deploy harness — they are never read from a signal payload.
#
# No `git` is installed here on purpose: the tool never touches its own
# filesystem for repository work — every clone/commit/push and every file
# read/write happens on the space's vercel_sandbox creature, driven over Caspar
# signalling. This image only makes GitHub REST calls and signals the sandbox.
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir \
    --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org \
    -r requirements.txt

COPY . /app

RUN mkdir -p /app/input /workspace
ENV DAVINCI_INPUT_DIR=/app/input PYTHONUNBUFFERED=1 TOOL_ID=github GITHUB_WORKSPACE=/workspace

CMD ["python", "tool_runtime.py"]
