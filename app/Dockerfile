# FastAPI Production Dockerfile
#
# Multi-stage build for optimized production image
# Based on Python 3.11+ for best performance
#
# Build:
#   docker build -t fastapi-scale:latest .
#   docker build --build-arg PYTHON_VERSION=3.12 -t fastapi-scale:py312 .
#
# Run:
#   docker run -p 8000:8000 fastapi-scale:latest

# ============================================================================
# Stage 1: Builder - Install dependencies
# ============================================================================
ARG PYTHON_VERSION=3.11
FROM python:${PYTHON_VERSION}-slim as builder

# Set working directory
WORKDIR /build

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        make \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (cache layer)
COPY requirements.txt .

# Create virtual environment and install dependencies
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ============================================================================
# Stage 2: Runtime - Production image
# ============================================================================
FROM python:${PYTHON_VERSION}-slim

# Install runtime dependencies only
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r app && \
    useradd -r -g app -u 1000 -m -s /bin/bash app

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv

# Set environment variables
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONOPTIMIZE=2 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_VERSION=1.0.0 \
    WORKERS=4 \
    HOST=0.0.0.0 \
    PORT=8000

# Set working directory
WORKDIR /app

# Copy application code
COPY --chown=app:app . .

# Switch to non-root user
USER app

# Health check
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Expose port
EXPOSE 8000

# Default command: Gunicorn with Uvicorn workers
CMD ["sh", "-c", "\
    gunicorn main:app \
    --workers ${WORKERS} \
    --worker-class uvicorn.workers.UvicornWorker \
    --bind ${HOST}:${PORT} \
    --backlog 2048 \
    --max-requests 100000 \
    --max-requests-jitter 10000 \
    --timeout 30 \
    --graceful-timeout 30 \
    --keep-alive 5 \
    --worker-connections 1000 \
    --access-logfile - \
    --error-logfile - \
    --log-level ${LOG_LEVEL:-warning} \
"]

# Alternative: Uvicorn directly (simpler, single-process)
# CMD ["sh", "-c", "\
#     uvicorn main:app \
#     --host ${HOST} \
#     --port ${PORT} \
#     --workers ${WORKERS} \
#     --loop uvloop \
#     --backlog 2048 \
#     --limit-concurrency 1000 \
#     --timeout-keep-alive 5 \
# "]

# ============================================================================
# Image metadata
# ============================================================================
LABEL maintainer="SRE Team"
LABEL version="1.0.0"
LABEL description="FastAPI scaling demo application"
LABEL org.opencontainers.image.source="https://github.com/yourorg/fastapi-scale"

# ============================================================================
# Build arguments for documentation
# ============================================================================
# ARG PYTHON_VERSION - Python version (default: 3.11)
# ENV WORKERS - Number of Gunicorn workers (default: 4)
# ENV HOST - Bind host (default: 0.0.0.0)
# ENV PORT - Bind port (default: 8000)
# ENV LOG_LEVEL - Logging level (default: warning)
# ENV APP_VERSION - Application version (default: 1.0.0)
