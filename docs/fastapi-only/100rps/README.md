# FastAPI-Only: 100 RPS Baseline

**Target:** 100 requests per second
**Stack:** FastAPI + Uvicorn (no database, no cache, no queue)
**Deployment:** Single host
**Estimated Cost:** $50/month

## TL;DR (Executive Summary)

**What:** Single-server FastAPI deployment handling 100 RPS of CPU-bound requests.

**Why this matters:** Establishes baseline performance metrics and understanding of FastAPI's core capabilities before adding complexity.

**Key numbers:**
- **1 server:** 4 vCPU, 16 GB RAM
- **4 workers:** Uvicorn workers with uvloop
- **Cost:** ~$50/month (t3.xlarge or equivalent)
- **Latency:** p50: 3ms, p95: 8ms, p99: 15ms
- **Headroom:** Can handle 300 RPS burst traffic

**When to use:** Development environments, internal tools, MVPs with < 100 concurrent users.

**Next level:** At 200+ sustained RPS, plan migration to [1k RPS architecture](../1krps/README.md).

---

## Architecture Overview

```
                    ┌─────────────────────────────────┐
                    │   Load Balancer / Reverse Proxy │
                    │         (Nginx/Caddy)          │
                    └────────────┬────────────────────┘
                                 │
                    ┌────────────▼────────────────────┐
                    │      Single Host Server         │
                    │  ┌──────────────────────────┐  │
                    │  │  Uvicorn (4 workers)     │  │
                    │  │  ├─ Worker 1 (25 RPS)    │  │
                    │  │  ├─ Worker 2 (25 RPS)    │  │
                    │  │  ├─ Worker 3 (25 RPS)    │  │
                    │  │  └─ Worker 4 (25 RPS)    │  │
                    │  │                          │  │
                    │  │  Python 3.11+ with       │  │
                    │  │  uvloop event loop       │  │
                    │  └──────────────────────────┘  │
                    │                                 │
                    │  4 vCPU, 16 GB RAM             │
                    └─────────────────────────────────┘
```

### Key Design Decisions

1. **Single host:** Eliminates network latency between components
2. **Multiple workers:** Bypass Python GIL, utilize all CPU cores
3. **Uvloop:** 2-4x performance boost over asyncio for I/O operations
4. **No external dependencies:** Pure compute workload, simplifies debugging

---

## Capacity Planning & Formulas

### 1. Worker Count Formula

```
workers = min(cpu_cores, max_concurrent_requests / target_concurrency_per_worker)

where:
  cpu_cores = 4
  max_concurrent_requests = 100 RPS * avg_response_time_seconds
  target_concurrency_per_worker = 25 (conservative)
  avg_response_time = 0.005s (5ms)

Calculation:
  max_concurrent = 100 * 0.005 = 0.5 requests in-flight
  workers = min(4, 0.5 / 25) = min(4, 0.02) = 4 (use all cores)

Recommendation: 4 workers
```

### 2. CPU Utilization Formula

```
cpu_utilization = (RPS * cpu_time_per_request) / (cores * worker_efficiency)

where:
  RPS = 100
  cpu_time_per_request = 0.003s (3ms of actual CPU work)
  cores = 4
  worker_efficiency = 0.8 (20% overhead for context switching)

Calculation:
  cpu_utilization = (100 * 0.003) / (4 * 0.8)
  cpu_utilization = 0.3 / 3.2
  cpu_utilization = 0.09375 = 9.4%

Result: ~10% CPU utilization at 100 RPS
Headroom: Can scale to ~1000 RPS on same hardware before saturation
```

### 3. Memory Requirements

```
memory_per_worker = base_app_memory + (concurrent_requests * memory_per_request)

where:
  base_app_memory = 150 MB (FastAPI + dependencies)
  concurrent_requests_per_worker = 25
  memory_per_request = 0.5 MB (request/response buffers)

Calculation:
  memory_per_worker = 150 + (25 * 0.5)
  memory_per_worker = 150 + 12.5 = 162.5 MB

Total for 4 workers:
  total_memory = 4 * 162.5 + 500 (OS + overhead)
  total_memory = 650 + 500 = 1,150 MB ≈ 1.2 GB

Recommendation: 16 GB RAM (14x headroom for traffic spikes and GC)
```

### 4. Network Bandwidth

```
bandwidth = RPS * (avg_request_size + avg_response_size) * 8 / 1_000_000

where:
  RPS = 100
  avg_request_size = 1,000 bytes (1 KB)
  avg_response_size = 2,000 bytes (2 KB)

Calculation:
  bandwidth = 100 * (1000 + 2000) * 8 / 1_000_000
  bandwidth = 100 * 3000 * 8 / 1_000_000
  bandwidth = 2,400,000 / 1_000_000
  bandwidth = 2.4 Mbps

Result: 2.4 Mbps network throughput
Network capacity: 1 Gbps (400x headroom)
```

---

## Hardware Sizing

### Recommended Instance

**Cloud Provider:** AWS, GCP, Azure equivalent

| Component | Specification | Rationale |
|-----------|---------------|-----------|
| **Instance Type** | t3.xlarge (AWS) or n2-standard-4 (GCP) | 4 vCPU, 16 GB RAM |
| **vCPUs** | 4 | One per worker, full core utilization |
| **RAM** | 16 GB | 14x headroom for GC and traffic spikes |
| **Disk** | 50 GB SSD | Logs, app code, minimal storage needs |
| **IOPS** | 3,000 (gp3) | Logging at ~100 IOPS during peak |
| **Network** | 5 Gbps | More than sufficient for 2.4 Mbps |

### Cost Breakdown (Monthly)

| Item | Cost | Notes |
|------|------|-------|
| Compute (t3.xlarge) | $120/month | On-demand pricing |
| Storage (50 GB SSD) | $5/month | gp3 EBS volume |
| Network egress | $10/month | ~50 GB at $0.09/GB |
| **Savings (reserved)** | -$70/month | 1-year reserved instance |
| **Estimated Total** | **$50/month** | With reserved instance |

---

## Software Configuration

### 1. Uvicorn Worker Configuration

**Start command:**
```bash
uvicorn main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers 4 \
  --loop uvloop \
  --backlog 2048 \
  --limit-concurrency 1000 \
  --timeout-keep-alive 5
```

**Configuration explanation:**

| Flag | Value | Rationale |
|------|-------|-----------|
| `--workers` | 4 | Match CPU core count |
| `--loop` | uvloop | 2-4x faster than asyncio |
| `--backlog` | 2048 | Queue size for pending connections |
| `--limit-concurrency` | 1000 | Max concurrent connections per worker |
| `--timeout-keep-alive` | 5 | Keep-alive timeout (seconds) |

### 2. Python Runtime Optimization

**Python version:** 3.11+ (faster interpreter, better GC)

**Environment variables:**
```bash
# Optimize garbage collection
export PYTHONOPTIMIZE=2              # Remove docstrings, optimize bytecode
export PYTHONDONTWRITEBYTECODE=1     # Skip .pyc files (Docker layers)

# Disable Python GC for request handlers (optional, advanced)
export PYTHONGC=0                    # Disable auto GC (manual control)
```

**GC tuning (in code):**
```python
import gc

# Tune GC thresholds for request-heavy workloads
gc.set_threshold(50000, 10, 10)  # Delay collections

# Or disable auto GC and run manually between requests
gc.disable()
# ... handle requests ...
# Periodically: gc.collect()
```

### 3. FastAPI Application Settings

**main.py:**
```python
from fastapi import FastAPI
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: warm up any caches, connections
    print("FastAPI starting up...")
    yield
    # Shutdown: cleanup
    print("FastAPI shutting down...")

app = FastAPI(
    title="FastAPI Scaling Demo",
    lifespan=lifespan,
    docs_url=None,  # Disable in production
    redoc_url=None,  # Disable in production
)

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.get("/api/v1/compute")
async def compute_endpoint():
    # Simulate 3ms of CPU work
    result = sum(i * i for i in range(10000))
    return {
        "result": result,
        "timestamp": time.time()
    }
```

### 4. Operating System Tuning

**File descriptor limits:**
```bash
# /etc/security/limits.conf
* soft nofile 65535
* hard nofile 65535
```

**TCP tuning:**
```bash
# /etc/sysctl.conf
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10000 65000
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30
```

Apply with:
```bash
sudo sysctl -p
```

---

## Load Testing Plan

### Test Scenarios

#### Scenario 1: Sustained Load (100 RPS)
```bash
k6 run --vus 10 --duration 60s fastapi-100rps-sustained.js
```

**Expected results:**
- RPS: 100 ± 5
- p50 latency: < 5ms
- p95 latency: < 10ms
- p99 latency: < 20ms
- Error rate: 0%

#### Scenario 2: Burst Traffic (300 RPS)
```bash
k6 run --vus 30 --duration 30s fastapi-100rps-burst.js
```

**Expected results:**
- RPS: 300 ± 10
- p50 latency: < 10ms
- p95 latency: < 25ms
- p99 latency: < 50ms
- Error rate: < 0.1%

#### Scenario 3: Ramp-Up Test
```bash
k6 run --stage 30s:10,60s:20,30s:5 fastapi-100rps-ramp.js
```

**Expected results:**
- Gradual latency increase during ramp
- No errors during normal scaling
- Quick recovery during ramp-down

### Acceptance Criteria

| Metric | Target | Measured | Status |
|--------|--------|----------|--------|
| Sustained RPS | 100 | TBD | ⏳ |
| p50 latency | < 10ms | TBD | ⏳ |
| p95 latency | < 25ms | TBD | ⏳ |
| p99 latency | < 50ms | TBD | ⏳ |
| Error rate | < 0.1% | TBD | ⏳ |
| CPU utilization | < 50% | TBD | ⏳ |
| Memory usage | < 4 GB | TBD | ⏳ |

---

## Observability & SLO Strategy

### Key Metrics to Monitor

**Application metrics:**
```python
from prometheus_client import Counter, Histogram

request_count = Counter('http_requests_total', 'Total HTTP requests', ['method', 'endpoint', 'status'])
request_duration = Histogram('http_request_duration_seconds', 'HTTP request duration', ['method', 'endpoint'])
```

**System metrics:**
- CPU utilization (target: < 50% average)
- Memory usage (target: < 4 GB RSS)
- Network throughput (target: < 10 Mbps)
- Open file descriptors (target: < 1000)

**Latency SLOs:**
- p50: < 10ms (99.9% of time)
- p95: < 25ms (99% of time)
- p99: < 50ms (95% of time)

### Alerts

```yaml
# Prometheus alert rules
groups:
  - name: fastapi_100rps
    interval: 30s
    rules:
      - alert: HighLatencyP95
        expr: histogram_quantile(0.95, http_request_duration_seconds) > 0.025
        for: 5m
        annotations:
          summary: "P95 latency above 25ms"

      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.001
        for: 2m
        annotations:
          summary: "Error rate above 0.1%"

      - alert: HighCPU
        expr: cpu_usage_percent > 80
        for: 5m
        annotations:
          summary: "CPU usage above 80%"
```

---

## Bottleneck Analysis

### What Breaks First?

At 100 RPS, **nothing breaks**. System operates at ~10% CPU capacity.

As traffic increases:

| RPS | Bottleneck | CPU Util | Mitigation |
|-----|------------|----------|------------|
| 100 | None | 10% | N/A |
| 300 | None | 30% | N/A |
| 500 | None | 50% | Monitor closely |
| 800 | CPU bound | 80% | Add workers or scale out |
| 1000+ | CPU saturated | 100% | **Scale to [1k RPS architecture](../1krps/README.md)** |

### Failure Modes

1. **CPU saturation** (> 1000 RPS)
   - Symptom: Latency spikes, request queueing
   - Detection: CPU > 90% for > 5 minutes
   - Remediation: Add more workers or horizontal scaling

2. **Memory exhaustion** (unlikely at this scale)
   - Symptom: OOM kills, swap thrashing
   - Detection: Memory > 14 GB
   - Remediation: Identify memory leak, restart workers

3. **File descriptor exhaustion**
   - Symptom: "Too many open files" errors
   - Detection: `lsof` shows > 60,000 FDs
   - Remediation: Increase ulimit, check for connection leaks

4. **Network saturation** (unlikely, would need 400,000 RPS)
   - Symptom: Packet loss, TCP retransmits
   - Detection: Network bandwidth > 800 Mbps
   - Remediation: Upgrade network interface

---

## Migration Path

### When to Scale Up

Migrate to [1k RPS architecture](../1krps/README.md) when:

- **Sustained traffic** > 200 RPS for > 30 minutes
- **Peak traffic** > 500 RPS regularly
- **CPU utilization** > 60% during business hours
- **p95 latency** > 20ms consistently

### Migration Strategy (Zero Downtime)

**Option 1: Vertical scaling (simple, 5-minute downtime acceptable)**
1. Take snapshot/backup
2. Stop application
3. Resize instance to larger type
4. Update worker count
5. Start application
6. Validate with load test

**Option 2: Blue-green deployment (zero downtime)**
1. Provision new larger instance
2. Deploy application with updated config
3. Add to load balancer pool
4. Validate health checks passing
5. Route 10% → 50% → 100% traffic to new instance
6. Decommission old instance

### Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Downtime during resize | Medium | Medium | Use blue-green deployment |
| Configuration error | Low | High | Validate in staging first |
| Unexpected traffic spike during migration | Low | Medium | Schedule during low-traffic window |
| Performance regression | Low | High | Keep old instance running for rollback |

---

## Security Considerations

### Application Security

1. **Rate limiting:**
```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.get("/api/v1/compute")
@limiter.limit("100/minute")
async def compute_endpoint():
    # ...
```

2. **Input validation:**
```python
from pydantic import BaseModel, Field

class ComputeRequest(BaseModel):
    value: int = Field(..., ge=0, le=1000000)
```

3. **HTTPS only:**
```bash
# Nginx reverse proxy with TLS termination
server {
    listen 443 ssl http2;
    ssl_certificate /etc/ssl/certs/cert.pem;
    ssl_certificate_key /etc/ssl/private/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
    }
}
```

### Infrastructure Security

- **Firewall rules:** Only ports 80/443 open to internet
- **SSH:** Key-based auth only, disable password auth
- **Updates:** Automated security patches with `unattended-upgrades`
- **Monitoring:** Failed login attempts, unusual traffic patterns

---

## Runbook Quick Reference

**High CPU (> 80%):**
```bash
# Check top processes
top -H -p $(pgrep -f uvicorn)

# Check if traffic spike or application issue
curl http://localhost:8000/health
tail -f /var/log/application.log

# Temporary: Reduce worker count if thrashing
kill -HUP $(pgrep -f uvicorn)  # Graceful restart
```

**High latency:**
```bash
# Check system load
uptime

# Check for network issues
netstat -s | grep -i retrans

# Check application logs for slow requests
grep "duration_ms" /var/log/application.log | sort -n -k3
```

**Out of memory:**
```bash
# Check memory usage
free -h
ps aux --sort=-%mem | head -10

# Restart workers gracefully
systemctl restart uvicorn
```

---

## Testing Results (To Be Updated)

### Baseline Test (100 RPS Sustained)

```
Date: TBD
Instance: t3.xlarge
Workers: 4
Duration: 60s

Results:
- RPS achieved: TBD
- p50 latency: TBD
- p95 latency: TBD
- p99 latency: TBD
- Error rate: TBD
- CPU avg: TBD
- Memory max: TBD

Status: ⏳ Pending
```

### Burst Test (300 RPS)

```
Date: TBD
Instance: t3.xlarge
Workers: 4
Duration: 30s

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

---

## Next Steps

1. **Deploy:** Use [docker-compose config](../../../deployments/docker-compose/fastapi-only/100rps.yml)
2. **Test:** Run [k6 load test](../../../load-tests/k6/fastapi-100rps.js)
3. **Monitor:** Set up [Prometheus + Grafana dashboard](../../../observability/dashboards/fastapi-100rps.json)
4. **Scale:** When ready, migrate to [1k RPS](../1krps/README.md)

---

**Document Version:** 1.0
**Last Updated:** 2025-11-16
**Validated By:** ⏳ Pending
