# browser_automation tool creature.
# Build context is assembled by scripts/deploy_browser_tool.py (ships the shared
# tools/_runtime/tool_runtime.py + caspar_bridge.py alongside this tool's tool.py
# + requirements).
#
# This creature runs a REAL headless Chromium via Playwright inside the container,
# so the image is large (browser + system libs). `playwright install --with-deps
# chromium` downloads the browser build that matches the pip-installed Playwright
# version and the OS packages Chromium needs — so the browser revision is always
# consistent with the library, and no browser is fetched at runtime.
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

# Keep the browser inside the image at a fixed path (not a per-user cache).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir \
    --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org \
    -r requirements.txt \
    # Downloads the Chromium build matching the installed Playwright + the apt
    # packages it needs. --with-deps needs apt, present in the slim base.
    && python -m playwright install --with-deps chromium

COPY . /app

RUN mkdir -p /app/input
ENV DAVINCI_INPUT_DIR=/app/input PYTHONUNBUFFERED=1 TOOL_ID=browser_automation \
    # Chromium under gVisor needs a big enough writable /dev/shm or --disable-dev-shm-usage
    # (the tool already passes the flag); keep the env explicit for clarity.
    BROWSER_HEADLESS=1

CMD ["python", "tool_runtime.py"]
