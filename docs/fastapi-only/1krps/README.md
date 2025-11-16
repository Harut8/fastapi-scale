# FastAPI-Only: 1,000 RPS (1k RPS)

**Target:** 1,000 requests per second
**Stack:** FastAPI + Uvicorn (no database, no cache, no queue)
**Deployment:** Single host (vertical scaling) or 2 hosts (horizontal scaling)
**Estimated Cost:** $200/month

## TL;DR (Executive Summary)

**What:** Vertically scaled FastAPI deployment handling 1,000 RPS on a single powerful server, or horizontally scaled across 2 smaller servers.

**Why this matters:** Crosses the threshold where optimization and tuning become critical. Demonstrates two scaling paths: vertical (simpler ops) vs horizontal (better redundancy).

**Key numbers:**
- **Option A (Vertical):** 1 server, 16 vCPU, 64 GB RAM, 16 workers → $150/month
- **Option B (Horizontal):** 2 servers, 8 vCPU each, 32 GB RAM, 8 workers/server → $200/month
- **Latency:** p50: 4ms, p95: 10ms, p99: 20ms
- **Headroom:** Can handle 2,000 RPS burst traffic

**When to use:** Production services with 500-2,000 concurrent users, internal APIs with moderate load.

**Next level:** At 1,500+ sustained RPS, plan migration to [10k RPS architecture](../10krps/README.md) with load balancing and auto-scaling.

---

## Architecture Overview

### Option A: Vertical Scaling (Recommended for simplicity)

```
                    ┌─────────────────────────────────┐
                    │         Nginx Reverse Proxy      │
                    │       (TLS termination + gzip)   │
                    └────────────┬────────────────────┘
                                 │
                    ┌────────────▼────────────────────┐
                    │    Single Large Host Server     │
                    │  ┌──────────────────────────┐  │
                    │  │  Uvicorn (16 workers)    │  │
                    │  │  ├─ Worker 1-4  (CPU 0-3)│  │
                    │  │  ├─ Worker 5-8  (CPU 4-7)│  │
                    │  │  ├─ Worker 9-12 (CPU 8-11)│ │
                    │  │  └─ Worker 13-16 (CPU 12-15)││
                    │  │                          │  │
                    │  │  Python 3.11 + uvloop    │  │
                    │  │  Per-worker GC tuning    │  │
                    │  └──────────────────────────┘  │
                    │                                 │
                    │  16 vCPU, 64 GB RAM            │
                    └─────────────────────────────────┘
```

### Option B: Horizontal Scaling (Recommended for HA)

```
                    ┌─────────────────────────────────┐
                    │    Load Balancer (HAProxy)      │
                    │  (Round-robin, health checks)   │
                    └──────┬──────────────┬───────────┘
                           │              │
          ┌────────────────▼───┐   ┌──────▼───────────────┐
          │  API Server 1      │   │  API Server 2        │
          │  ┌──────────────┐  │   │  ┌──────────────┐   │
          │  │ Uvicorn (8w) │  │   │  │ Uvicorn (8w) │   │
          │  │ 500 RPS      │  │   │  │ 500 RPS      │   │
          │  └──────────────┘  │   │  └──────────────┘   │
          │                    │   │                     │
          │  8 vCPU, 32 GB     │   │  8 vCPU, 32 GB      │
          └────────────────────┘   └─────────────────────┘
```

### Key Design Decisions

1. **Vertical vs Horizontal:**
   - Vertical: Simpler ops, lower latency, single point of failure
   - Horizontal: Better HA, easier to scale further, added network hop

2. **Worker count:** Match or slightly exceed vCPU count (16 workers for 16 cores)

3. **CPU pinning:** Pin workers to specific cores to reduce cache thrashing

4. **Connection pooling:** Reuse keep-alive connections to reduce overhead

---

## Capacity Planning & Formulas

### 1. Worker Count Formula (Updated for Higher Load)

```
workers = cpu_cores

Rationale:
  At 1k RPS with 3ms CPU time per request:
  total_cpu_time = 1000 * 0.003 = 3 seconds of CPU work per second

  With 16 cores:
  utilization = 3 / 16 = 0.1875 = 18.75%

Recommendation:
  - Vertical scaling: 16 workers on 16-core instance
  - Horizontal scaling: 8 workers × 2 instances = 16 workers total
```

### 2. CPU Utilization Formula

```
cpu_utilization = (RPS * cpu_time_per_request) / (cores * worker_efficiency)

where:
  RPS = 1000
  cpu_time_per_request = 0.003s (3ms)
  cores = 16 (vertical) or 8 × 2 (horizontal)
  worker_efficiency = 0.85 (improved with CPU pinning)

Calculation (vertical):
  cpu_utilization = (1000 * 0.003) / (16 * 0.85)
  cpu_utilization = 3 / 13.6
  cpu_utilization = 0.22 = 22%

Result: ~22% CPU utilization at 1k RPS
Headroom: Can scale to ~4,400 RPS before CPU saturation (80% utilization)
```

### 3. Memory Requirements (Per Instance)

```
memory_per_worker = base_app_memory + (concurrent_requests * memory_per_request)

where:
  base_app_memory = 200 MB (FastAPI + more dependencies)
  concurrent_requests_per_worker = 50 (higher throughput)
  memory_per_request = 0.5 MB

Calculation:
  memory_per_worker = 200 + (50 * 0.5)
  memory_per_worker = 200 + 25 = 225 MB

Total for 16 workers (vertical):
  total_memory = 16 * 225 + 1000 (OS + Nginx + overhead)
  total_memory = 3600 + 1000 = 4,600 MB ≈ 4.6 GB

Recommendation: 64 GB RAM (14x headroom) or 32 GB (7x headroom)
```

### 4. Network Bandwidth

```
bandwidth = RPS * (avg_request_size + avg_response_size) * 8 / 1_000_000

where:
  RPS = 1000
  avg_request_size = 1,000 bytes
  avg_response_size = 2,000 bytes

Calculation:
  bandwidth = 1000 * (1000 + 2000) * 8 / 1_000_000
  bandwidth = 1000 * 3000 * 8 / 1_000_000
  bandwidth = 24,000,000 / 1_000_000
  bandwidth = 24 Mbps

Result: 24 Mbps network throughput
Network capacity: 10 Gbps (400x headroom)
```

### 5. Theoretical Maximum RPS

```
max_rps = (cores * worker_efficiency) / cpu_time_per_request

where:
  cores = 16
  worker_efficiency = 0.85
  cpu_time_per_request = 0.003s

Calculation:
  max_rps = (16 * 0.85) / 0.003
  max_rps = 13.6 / 0.003
  max_rps = 4,533 RPS

Safe operating point (60% of max): ~2,700 RPS
Recommended max (80% of max): ~3,600 RPS
```

---

## Hardware Sizing

### Option A: Vertical Scaling (Single Large Instance)

| Component | Specification | Rationale |
|-----------|---------------|-----------|
| **Instance Type** | c6i.4xlarge (AWS) or c2-standard-16 (GCP) | 16 vCPU, 32 GB RAM |
| **vCPUs** | 16 | Match worker count |
| **RAM** | 32-64 GB | 7-14x headroom |
| **Disk** | 100 GB SSD | Logs, app code |
| **IOPS** | 12,000 (gp3) | Logging at ~1,000 IOPS |
| **Network** | 12.5 Gbps | Dedicated network bandwidth |

**Pros:**
- Simpler deployment and operations
- No network latency between workers
- Lower total cost

**Cons:**
- Single point of failure
- Harder to achieve true zero-downtime deployments
- Limited by single-instance size

### Option B: Horizontal Scaling (2 × Medium Instances)

| Component | Specification | Rationale |
|-----------|---------------|-----------|
| **Instance Type** | c6i.2xlarge (AWS) × 2 | 8 vCPU, 16 GB RAM each |
| **vCPUs** | 8 per instance | Match worker count |
| **RAM** | 16 GB per instance | 3.5x headroom per instance |
| **Disk** | 50 GB SSD | Per instance |
| **IOPS** | 6,000 (gp3) | Per instance |
| **Network** | 10 Gbps | Per instance |
| **Load Balancer** | ALB or HAProxy | Health checks, SSL termination |

**Pros:**
- High availability (survive single instance failure)
- True rolling deployments with zero downtime
- Easier to scale horizontally later

**Cons:**
- Added load balancer complexity and cost
- Network hop adds ~1-2ms latency
- Higher total cost (~$200 vs $150/month)

### Cost Breakdown (Monthly)

**Option A (Vertical):**
| Item | Cost | Notes |
|------|------|-------|
| Compute (c6i.4xlarge, reserved) | $130/month | 1-year reserved |
| Storage (100 GB SSD) | $10/month | gp3 EBS |
| Network egress | $20/month | ~200 GB at $0.09/GB |
| **Total** | **$160/month** | |

**Option B (Horizontal):**
| Item | Cost | Notes |
|------|------|-------|
| Compute (c6i.2xlarge × 2, reserved) | $65 × 2 = $130/month | 1-year reserved |
| Storage (50 GB SSD × 2) | $5 × 2 = $10/month | gp3 EBS |
| Load Balancer (ALB) | $20/month | ~1 LCU average |
| Network egress | $20/month | ~200 GB |
| **Total** | **$180/month** | |

---

## Software Configuration

### 1. Uvicorn with CPU Pinning (Advanced)

**Vertical scaling (16 workers):**
```bash
# Use systemd to launch with CPU affinity
# /etc/systemd/system/uvicorn@.service

[Unit]
Description=Uvicorn Worker %i
After=network.target

[Service]
Type=notify
User=www-data
Group=www-data
WorkingDirectory=/app
ExecStart=/usr/bin/taskset -c %i /app/venv/bin/uvicorn main:app \
  --host 127.0.0.1 \
  --port 800%i \
  --loop uvloop \
  --backlog 2048 \
  --limit-concurrency 2000 \
  --timeout-keep-alive 75
Restart=always

[Install]
WantedBy=multi-user.target
```

**Enable 16 workers pinned to CPUs 0-15:**
```bash
for i in {0..15}; do
  systemctl enable uvicorn@$i
  systemctl start uvicorn@$i
done
```

**Nginx upstream configuration:**
```nginx
upstream fastapi_backend {
    least_conn;  # Use least connections algorithm

    server 127.0.0.1:8000;
    server 127.0.0.1:8001;
    server 127.0.0.1:8002;
    server 127.0.0.1:8003;
    server 127.0.0.1:8004;
    server 127.0.0.1:8005;
    server 127.0.0.1:8006;
    server 127.0.0.1:8007;
    server 127.0.0.1:8008;
    server 127.0.0.1:8009;
    server 127.0.0.1:8010;
    server 127.0.0.1:8011;
    server 127.0.0.1:8012;
    server 127.0.0.1:8013;
    server 127.0.0.1:8014;
    server 127.0.0.1:8015;

    keepalive 256;  # Persistent connections to workers
}

server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://fastapi_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Performance tuning
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
        proxy_busy_buffers_size 8k;
    }
}
```

### 2. Gunicorn Alternative (Simpler Management)

If systemd complexity is undesired, use Gunicorn with Uvicorn workers:

```bash
gunicorn main:app \
  --workers 16 \
  --worker-class uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:8000 \
  --backlog 2048 \
  --max-requests 100000 \
  --max-requests-jitter 10000 \
  --timeout 30 \
  --keep-alive 5 \
  --graceful-timeout 30 \
  --worker-connections 1000
```

**Configuration explanation:**

| Flag | Value | Rationale |
|------|-------|-----------|
| `--workers` | 16 | Match CPU count |
| `--worker-class` | uvicorn.workers.UvicornWorker | ASGI server with uvloop |
| `--max-requests` | 100000 | Recycle workers after 100k requests (prevent leaks) |
| `--max-requests-jitter` | 10000 | Randomize recycling to avoid thundering herd |
| `--worker-connections` | 1000 | Max concurrent connections per worker |
| `--keep-alive` | 5 | Keep-alive timeout |

### 3. Python GC Tuning for High Throughput

**In main.py:**
```python
import gc
import os

# Disable automatic GC, run manually
gc.disable()

# Tune GC thresholds for less frequent collection
gc.set_threshold(50000, 10, 10)

# Background task to manually trigger GC during low traffic
from fastapi import BackgroundTasks
import asyncio

async def periodic_gc():
    """Run GC every 60 seconds during low load."""
    while True:
        await asyncio.sleep(60)
        gc.collect(generation=0)  # Young generation only

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(periodic_gc())
```

### 4. Operating System Tuning (Enhanced)

**TCP tuning for high throughput:**
```bash
# /etc/sysctl.conf
net.core.somaxconn = 8192
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10000 65000
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 3
net.ipv4.tcp_keepalive_intvl = 15

# Increase buffer sizes
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Enable BBR congestion control (requires kernel 4.9+)
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
```

**File descriptor limits:**
```bash
# /etc/security/limits.conf
* soft nofile 100000
* hard nofile 100000
```

---

## Load Testing Plan

### Test Scenarios

#### Scenario 1: Sustained Load (1,000 RPS for 5 minutes)
```bash
k6 run --vus 100 --duration 300s fastapi-1krps-sustained.js
```

**Expected results:**
- RPS: 1,000 ± 20
- p50 latency: < 5ms
- p95 latency: < 12ms
- p99 latency: < 25ms
- Error rate: 0%
- CPU: ~25% average

#### Scenario 2: Burst Traffic (2,000 RPS for 1 minute)
```bash
k6 run --vus 200 --duration 60s fastapi-1krps-burst.js
```

**Expected results:**
- RPS: 2,000 ± 40
- p50 latency: < 8ms
- p95 latency: < 20ms
- p99 latency: < 40ms
- Error rate: < 0.05%
- CPU: ~50% peak

#### Scenario 3: Gradual Ramp (0 → 1,500 RPS over 10 minutes)
```bash
k6 run --stage 0s:0,300s:150,300s:100,300s:0 fastapi-1krps-ramp.js
```

**Expected results:**
- Linear latency increase during ramp
- No errors during scaling
- CPU follows RPS linearly
- Memory stable throughout

#### Scenario 4: Soak Test (1,000 RPS for 24 hours)
```bash
k6 run --vus 100 --duration 24h fastapi-1krps-soak.js
```

**Expected results:**
- No memory leaks (RSS stable)
- No degradation in p99 latency
- Worker recycling happening correctly
- No file descriptor leaks

### Acceptance Criteria

| Metric | Target | Measured | Status |
|--------|--------|----------|--------|
| Sustained RPS | 1,000 | TBD | ⏳ |
| Burst RPS | 2,000 | TBD | ⏳ |
| p50 latency | < 5ms | TBD | ⏳ |
| p95 latency | < 12ms | TBD | ⏳ |
| p99 latency | < 25ms | TBD | ⏳ |
| Error rate | < 0.01% | TBD | ⏳ |
| CPU utilization (avg) | < 30% | TBD | ⏳ |
| CPU utilization (p95) | < 60% | TBD | ⏳ |
| Memory usage | < 8 GB | TBD | ⏳ |
| 24h soak test passes | Yes | TBD | ⏳ |

---

## Observability & SLO Strategy

### Enhanced Metrics Collection

**Application-level metrics (Prometheus):**
```python
from prometheus_client import Counter, Histogram, Gauge
import time

# Request metrics
request_count = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

request_duration = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration',
    ['method', 'endpoint'],
    buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
)

# Worker metrics
active_requests = Gauge(
    'active_requests',
    'Currently active requests',
    ['worker_id']
)

# Middleware to track metrics
@app.middleware("http")
async def metrics_middleware(request, call_next):
    worker_id = os.getpid()
    active_requests.labels(worker_id=worker_id).inc()

    start_time = time.time()
    response = await call_next(request)
    duration = time.time() - start_time

    request_count.labels(
        method=request.method,
        endpoint=request.url.path,
        status=response.status_code
    ).inc()

    request_duration.labels(
        method=request.method,
        endpoint=request.url.path
    ).observe(duration)

    active_requests.labels(worker_id=worker_id).dec()

    return response
```

### Grafana Dashboard Panels

**Key visualizations:**
1. **RPS graph:** `rate(http_requests_total[1m])`
2. **Latency heatmap:** `http_request_duration_seconds`
3. **Error rate:** `rate(http_requests_total{status=~"5.."}[5m])`
4. **CPU by core:** `node_cpu_seconds_total{mode="user"}`
5. **Memory RSS:** `process_resident_memory_bytes`
6. **Active connections:** `node_netstat_Tcp_CurrEstab`

### Alerts (Updated Thresholds)

```yaml
groups:
  - name: fastapi_1krps
    interval: 30s
    rules:
      - alert: HighLatencyP95
        expr: histogram_quantile(0.95, http_request_duration_seconds) > 0.015
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P95 latency above 15ms for 5 minutes"

      - alert: HighLatencyP99
        expr: histogram_quantile(0.99, http_request_duration_seconds) > 0.030
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P99 latency above 30ms"

      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.001
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Error rate above 0.1%"

      - alert: HighCPU
        expr: avg(rate(node_cpu_seconds_total{mode!="idle"}[5m])) > 0.70
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "CPU usage above 70% for 10 minutes - consider scaling"

      - alert: MemoryLeak
        expr: process_resident_memory_bytes > 10 * 1024 * 1024 * 1024  # 10 GB
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Memory usage above 10 GB - possible leak"

      - alert: WorkerCrash
        expr: changes(process_start_time_seconds[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Worker process restarted unexpectedly"
```

---

## Bottleneck Analysis

### Performance Degradation Points

| RPS | CPU % | p50 (ms) | p95 (ms) | p99 (ms) | Bottleneck | Action |
|-----|-------|----------|----------|----------|------------|--------|
| 1,000 | 22% | 4 | 10 | 20 | None | Normal operation |
| 2,000 | 44% | 5 | 12 | 25 | None | Acceptable burst |
| 3,000 | 66% | 7 | 18 | 35 | CPU warming | Monitor closely |
| 3,500 | 77% | 10 | 25 | 50 | CPU strain | **Scale soon** |
| 4,000 | 88% | 15 | 40 | 80 | CPU saturated | **Scale now** |
| 4,500+ | 100% | >50 | >100 | >200 | CPU maxed | **Emergency scaling** |

### Failure Mode Matrix

| Failure Mode | Probability | Impact | Detection Time | MTTR | Mitigation |
|--------------|-------------|--------|----------------|------|------------|
| CPU saturation | Medium | High | < 1 min | 10 min | Add workers or horizontal scale |
| Memory leak | Low | High | 30 min | 5 min | Restart workers |
| Worker crash | Low | Medium | < 1 min | 1 min | Systemd auto-restart |
| Network saturation | Very Low | High | < 1 min | 30 min | Upgrade instance network |
| Disk full (logs) | Low | Medium | 1 hour | 10 min | Log rotation, monitoring |
| DNS failure | Very Low | Critical | < 1 min | 5 min | Local DNS caching |
| NTP drift | Very Low | Low | 1 day | 5 min | Chrony/NTP monitoring |
| Kernel OOM | Very Low | Critical | < 1 sec | 5 min | Tune OOM killer, add swap |

---

## Migration Path

### From 100 RPS → 1k RPS

**Trigger conditions:**
- Sustained 200+ RPS for > 1 hour
- CPU > 60% on 100 RPS setup
- p95 latency > 20ms

**Migration steps (Blue-Green, Zero Downtime):**

1. **Preparation (Day 1):**
   ```bash
   # Provision new c6i.4xlarge instance
   # Deploy application with 16 workers
   # Run smoke tests
   ```

2. **Validation (Day 2):**
   ```bash
   # Run load tests on new instance
   k6 run --vus 100 --duration 300s fastapi-1krps.js

   # Verify metrics
   # - RPS: 1,000 ±2%
   # - p95: < 12ms
   # - No errors
   ```

3. **Traffic Migration (Day 3):**
   ```bash
   # Add new instance to load balancer with weight=0
   # Gradually increase weight: 10% → 25% → 50% → 100%
   # Monitor error rates and latency
   # Rollback if error rate > 0.1%
   ```

4. **Decommission (Day 4):**
   ```bash
   # Remove old instance from load balancer
   # Monitor for 24 hours
   # Terminate old instance
   ```

### To 10k RPS → [Next Guide](../10krps/README.md)

**Trigger conditions:**
- Sustained 1,500+ RPS
- CPU > 50% on 1k RPS setup
- Need for better HA/redundancy

**Overview of changes:**
- Multiple API servers with load balancing
- Auto-scaling groups
- CDN for static assets
- Potentially add caching layer

---

## Security Considerations (Enhanced)

### Rate Limiting (Per-IP and Global)

```python
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["1000/minute", "50/second"],
    storage_uri="redis://localhost:6379"  # Required for multi-worker
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

@app.get("/api/v1/compute")
@limiter.limit("100/minute")  # Stricter limit for expensive endpoints
async def compute_endpoint():
    # ...
```

### DDoS Protection

**Nginx level:**
```nginx
# Limit connections per IP
limit_conn_zone $binary_remote_addr zone=addr:10m;
limit_conn addr 10;

# Limit request rate
limit_req_zone $binary_remote_addr zone=req_limit_per_ip:10m rate=50r/s;
limit_req zone=req_limit_per_ip burst=100 nodelay;

# Block common attack patterns
if ($http_user_agent ~* (bot|crawler|spider|scraper)) {
    return 403;
}
```

### Input Validation (Strict)

```python
from pydantic import BaseModel, Field, validator
from typing import Optional

class ComputeRequest(BaseModel):
    value: int = Field(..., ge=0, le=1000000)
    iterations: Optional[int] = Field(default=100, ge=1, le=10000)

    @validator('value')
    def validate_value(cls, v):
        if v % 2 != 0:  # Example: only even numbers
            raise ValueError('Value must be even')
        return v
```

---

## Runbooks

### Runbook 1: High CPU Utilization (> 70%)

**Symptoms:**
- CPU > 70% for > 10 minutes
- p95 latency increasing
- Alert firing

**Diagnosis:**
```bash
# Check overall CPU
top
mpstat -P ALL 1 10  # Per-core utilization

# Check if specific workers are hot
ps aux --sort=-%cpu | grep uvicorn
htop -p $(pgrep -d, -f uvicorn)

# Check if traffic spike or application issue
tail -f /var/log/nginx/access.log | awk '{print $4}' | cut -d: -f2 | sort | uniq -c
```

**Remediation:**

**Short-term:**
```bash
# If traffic spike, enable rate limiting
# Edit nginx config, add:
# limit_req_zone $binary_remote_addr zone=emergency:10m rate=100r/s;

nginx -s reload
```

**Medium-term:**
```bash
# Scale horizontally: add second instance
# Update load balancer configuration
```

**Long-term:**
```bash
# Migrate to 10k RPS architecture with auto-scaling
```

### Runbook 2: Memory Leak Detection & Restart

**Symptoms:**
- Memory usage growing over time
- Alert: "MemoryLeak" firing
- Eventually: OOM killer or swap thrashing

**Diagnosis:**
```bash
# Check memory trends
free -m
ps aux --sort=-%mem | head -10

# Check for worker memory growth
for pid in $(pgrep -f uvicorn); do
  echo "PID $pid: $(ps -p $pid -o rss= | awk '{print $1/1024 " MB"}')"
done

# Check Python object counts (if debug mode enabled)
# (Requires objgraph or similar)
```

**Remediation:**

**Immediate:**
```bash
# Gracefully restart workers one by one
for i in {0..15}; do
  systemctl restart uvicorn@$i
  sleep 10  # Wait for health check
done
```

**Investigation:**
```python
# Add memory profiling
import tracemalloc
tracemalloc.start()

# In endpoint:
snapshot = tracemalloc.take_snapshot()
top_stats = snapshot.statistics('lineno')
for stat in top_stats[:10]:
    print(stat)
```

### Runbook 3: Worker Crashes

**Symptoms:**
- Alert: "WorkerCrash" firing
- Gaps in logs
- Error rate spike

**Diagnosis:**
```bash
# Check systemd logs
journalctl -u uvicorn@* -n 100

# Check for segfaults
dmesg | grep segfault

# Check Python tracebacks
tail -n 200 /var/log/application.log | grep -A 20 "Traceback"
```

**Remediation:**
```bash
# Systemd should auto-restart, but verify
systemctl status uvicorn@*

# If not auto-restarting, check systemd config
systemctl cat uvicorn@0

# Ensure Restart=always is set
```

---

## Testing Results (To Be Updated)

### Sustained Load Test (1,000 RPS, 5 minutes)

```
Date: TBD
Instance: c6i.4xlarge (16 vCPU, 32 GB RAM)
Workers: 16
Duration: 300s
VUs: 100

Results:
- RPS achieved: TBD
- p50 latency: TBD
- p95 latency: TBD
- p99 latency: TBD
- Error rate: TBD
- CPU average: TBD
- CPU p95: TBD
- Memory max: TBD
- Memory stable: TBD

Status: ⏳ Pending
```

### Burst Test (2,000 RPS, 60 seconds)

```
Date: TBD
Instance: c6i.4xlarge
Workers: 16
Duration: 60s
VUs: 200

Results:
- RPS achieved: TBD
- p50 latency: TBD
- p95 latency: TBD
- p99 latency: TBD
- Error rate: TBD
- CPU peak: TBD
- Memory peak: TBD

Status: ⏳ Pending
```

### Soak Test (1,000 RPS, 24 hours)

```
Date: TBD
Instance: c6i.4xlarge
Workers: 16
Duration: 24h
VUs: 100

Results:
- Memory start: TBD
- Memory end: TBD
- Memory growth rate: TBD
- Latency degradation: TBD
- Worker restarts: TBD
- Errors: TBD

Status: ⏳ Pending
```

---

## Next Steps

1. **Deploy:** Use [docker-compose](../../../deployments/docker-compose/fastapi-only/1krps.yml) or [systemd configs](../../../deployments/systemd/)
2. **Test:** Run [k6 suite](../../../load-tests/k6/fastapi-1krps.js)
3. **Monitor:** Import [Grafana dashboard](../../../observability/dashboards/fastapi-1krps.json)
4. **Optimize:** Review [Python profiling guide](../tuning/profiling.md)
5. **Scale:** When ready, migrate to [10k RPS](../10krps/README.md)

---

**Document Version:** 1.0
**Last Updated:** 2025-11-16
**Validated By:** ⏳ Pending
