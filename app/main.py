"""
FastAPI Scaling Demo Application

A production-ready FastAPI application demonstrating performance optimization
and scaling patterns from 100 RPS to 1M RPS.

Performance optimizations:
- Async/await for I/O operations
- Uvloop for faster event loop
- Minimal dependencies
- Efficient request/response handling
- Proper health checks
- Prometheus metrics integration
"""

import time
import os
import socket
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

# Try to import uvloop (2-4x faster than asyncio)
try:
    import uvloop
    uvloop.install()
    print("✅ Uvloop enabled")
except ImportError:
    print("⚠️  Uvloop not available, using default asyncio")

# ============================================================================
# Metrics
# ============================================================================

# Request counters
request_count = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

# Latency histogram
request_duration = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'endpoint'],
    buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0]
)

# Active requests gauge
active_requests = Gauge(
    'http_active_requests',
    'Number of active HTTP requests',
    ['method', 'endpoint']
)

# Application info
app_info = Gauge('app_info', 'Application information', ['version', 'hostname', 'worker_id'])

# ============================================================================
# Application Lifecycle
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown logic"""
    # Startup
    hostname = socket.gethostname()
    worker_id = os.getpid()
    version = os.getenv('APP_VERSION', '1.0.0')

    print(f"🚀 Starting FastAPI worker {worker_id} on {hostname}")
    print(f"📦 Version: {version}")

    # Set app info metric
    app_info.labels(version=version, hostname=hostname, worker_id=str(worker_id)).set(1)

    yield

    # Shutdown
    print(f"👋 Shutting down worker {worker_id}")

# ============================================================================
# Application Configuration
# ============================================================================

app = FastAPI(
    title="FastAPI Scaling Demo",
    description="Production-ready FastAPI application demonstrating scaling from 100 RPS to 1M RPS",
    version=os.getenv('APP_VERSION', '1.0.0'),
    lifespan=lifespan,
    # Disable docs in production for slight performance gain
    docs_url="/docs" if os.getenv('ENVIRONMENT') == 'development' else None,
    redoc_url="/redoc" if os.getenv('ENVIRONMENT') == 'development' else None,
)

# ============================================================================
# Middleware
# ============================================================================

@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    """Record metrics for all requests"""
    method = request.method
    path = request.url.path

    # Skip metrics endpoint from metrics
    if path == '/metrics':
        return await call_next(request)

    # Track active requests
    active_requests.labels(method=method, endpoint=path).inc()

    # Time the request
    start_time = time.time()
    try:
        response = await call_next(request)
        status_code = response.status_code
    except Exception as e:
        # Track errors
        status_code = 500
        response = JSONResponse(
            status_code=500,
            content={"error": "internal_server_error", "detail": str(e)}
        )
    finally:
        # Record metrics
        duration = time.time() - start_time
        request_count.labels(method=method, endpoint=path, status=status_code).inc()
        request_duration.labels(method=method, endpoint=path).observe(duration)
        active_requests.labels(method=method, endpoint=path).dec()

    return response

# ============================================================================
# Request/Response Models
# ============================================================================

class HealthResponse(BaseModel):
    status: str
    timestamp: float
    hostname: str
    worker_id: int

class InfoResponse(BaseModel):
    version: str
    hostname: str
    worker_id: int
    workers: int

class ComputeRequest(BaseModel):
    iterations: int = Field(default=10000, ge=1, le=100000, description="Number of iterations")

class ComputeResponse(BaseModel):
    result: int
    timestamp: float
    duration_ms: float
    hostname: str

# ============================================================================
# Health & Info Endpoints
# ============================================================================

@app.get("/health", response_model=HealthResponse, tags=["health"])
async def health_check():
    """
    Health check endpoint for load balancers.

    Returns 200 OK if service is healthy.
    Used by:
    - Docker healthchecks
    - Kubernetes liveness/readiness probes
    - Load balancer health checks
    """
    return HealthResponse(
        status="healthy",
        timestamp=time.time(),
        hostname=socket.gethostname(),
        worker_id=os.getpid()
    )

@app.get("/ready", tags=["health"])
async def readiness_check():
    """
    Readiness check endpoint.

    Returns 200 OK if service is ready to accept traffic.
    Could check database connections, cache availability, etc.
    """
    # In a real app, check dependencies here:
    # - Database connection
    # - Cache availability
    # - Required services

    return {
        "status": "ready",
        "timestamp": time.time()
    }

@app.get("/info", response_model=InfoResponse, tags=["info"])
async def get_info():
    """Get application information"""
    return InfoResponse(
        version=os.getenv('APP_VERSION', '1.0.0'),
        hostname=socket.gethostname(),
        worker_id=os.getpid(),
        workers=int(os.getenv('WORKERS', 4))
    )

@app.get("/metrics", tags=["monitoring"])
async def get_metrics():
    """
    Prometheus metrics endpoint.

    Exposes metrics in Prometheus format for scraping.
    """
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )

# ============================================================================
# API Endpoints
# ============================================================================

@app.get("/api/v1/compute", response_model=ComputeResponse, tags=["api"])
async def compute_endpoint(iterations: int = 10000):
    """
    CPU-bound computation endpoint.

    Simulates 3-5ms of CPU work by computing sum of squares.
    This represents a typical lightweight API computation.

    Args:
        iterations: Number of iterations (1 to 100,000)

    Returns:
        Computation result with timing information
    """
    if iterations < 1 or iterations > 100000:
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_iterations", "detail": "Iterations must be between 1 and 100,000"}
        )

    start_time = time.time()

    # Simulate CPU-bound work
    result = sum(i * i for i in range(iterations))

    duration = (time.time() - start_time) * 1000  # Convert to ms

    return ComputeResponse(
        result=result,
        timestamp=time.time(),
        duration_ms=round(duration, 2),
        hostname=socket.gethostname()
    )

@app.post("/api/v1/compute", response_model=ComputeResponse, tags=["api"])
async def compute_endpoint_post(request: ComputeRequest):
    """
    CPU-bound computation endpoint (POST variant).

    Same as GET /api/v1/compute but accepts JSON body.
    """
    start_time = time.time()

    result = sum(i * i for i in range(request.iterations))
    duration = (time.time() - start_time) * 1000

    return ComputeResponse(
        result=result,
        timestamp=time.time(),
        duration_ms=round(duration, 2),
        hostname=socket.gethostname()
    )

@app.get("/", tags=["info"])
async def root():
    """Root endpoint with API information"""
    return {
        "service": "FastAPI Scaling Demo",
        "version": os.getenv('APP_VERSION', '1.0.0'),
        "docs": "/docs" if os.getenv('ENVIRONMENT') == 'development' else None,
        "health": "/health",
        "metrics": "/metrics",
        "endpoints": {
            "compute": "/api/v1/compute"
        }
    }

# ============================================================================
# Error Handlers
# ============================================================================

@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    """Custom 404 handler"""
    return JSONResponse(
        status_code=404,
        content={
            "error": "not_found",
            "detail": f"The path {request.url.path} does not exist"
        }
    )

@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    """Custom 500 handler"""
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_server_error",
            "detail": "An unexpected error occurred"
        }
    )

# ============================================================================
# Development Entry Point
# ============================================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        workers=4,
        loop="uvloop",
        log_level="info"
    )
