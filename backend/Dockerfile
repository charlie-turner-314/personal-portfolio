# syntax=docker/dockerfile:1.7

FROM python:3.11-slim-bookworm AS builder
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt .
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# frontend is a named BuildKit context; bundle React Email instead of shipping
# the entire Next.js dependency tree. No npm/network access is needed at runtime.
FROM node:20-bookworm-slim AS frontend-deps
WORKDIR /frontend
RUN corepack enable
COPY --from=frontend package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=frontend xlsx-0.20.3.tgz ./xlsx-0.20.3.tgz
RUN pnpm install --frozen-lockfile
COPY --from=frontend emails ./emails
COPY --from=frontend tsconfig.json ./
RUN pnpm exec esbuild emails/render-report.ts --bundle --platform=node --format=cjs --target=node20 --outfile=render-report.cjs

FROM python:3.11-slim-bookworm AS runner
WORKDIR /app
ARG APP_REVISION=unknown
ENV APP_REVISION=$APP_REVISION
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
ENV PATH="/opt/venv/bin:$PATH"
ENV PROCESS_TYPE=api CELERY_WORKER_CONCURRENCY=1
ENV REPORT_RENDERER_PATH=/frontend/render-report.cjs
# Match Node's Debian generation; copy only Node, not npm or its dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app \
    && chown app:app /app
COPY --from=frontend-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /opt/venv /opt/venv
COPY --chown=app:app . .
COPY --from=frontend-deps --chown=app:app /frontend/render-report.cjs /frontend/render-report.cjs
USER app
EXPOSE 8000
CMD ["sh", "-c", "if [ \"$PROCESS_TYPE\" = \"worker\" ]; then exec celery -A celery_app worker --loglevel=info --concurrency=${CELERY_WORKER_CONCURRENCY:-1}; elif [ \"$PROCESS_TYPE\" = \"beat\" ]; then exec celery -A celery_app beat --loglevel=info; elif [ \"$PROCESS_TYPE\" = \"mcp\" ]; then exec uvicorn mcp_server:app --host 0.0.0.0 --port ${PORT:-8001}; else exec gunicorn -k uvicorn.workers.UvicornWorker app.main:app --bind 0.0.0.0:${PORT:-8000} --workers 2 --timeout 240; fi"]
