# FastAPI-Only: 10,000 RPS (10k RPS)

**Target:** 10,000 requests per second
**Stack:** FastAPI + Uvicorn (no database, no cache, no queue)
**Deployment:** 8+ hosts with load balancing and auto-scaling
**Estimated Cost:** $1,500/month

## TL;DR (Executive Summary)

**What:** Distributed FastAPI deployment across multiple servers with load balancing, health checks, and auto-scaling capabilities.

**Why this matters:** First truly production-grade distributed system. Requires proper DevOps infrastructure, monitoring, and operational discipline. Demonstrates patterns that scale to 100k+ RPS.

**Key numbers:**
- **8 API servers:** 8 vCPU, 32 GB RAM each, 8 workers per server
- **Load balancer:** Layer 7 (HTTP) with SSL termination, health checks
- **Auto-scaling:** 6-12 instances based on CPU/RPS metrics
- **Cost:** ~$1,500/month (reserved instances + LB + bandwidth)
- **Latency:** p50: 5ms, p95: 15ms, p99: 30ms
- **Availability:** 99.95% (High Availability across 3 AZs)
- **Headroom:** Can handle 20k RPS burst traffic

**When to use:** Production applications with 5,000-15,000 concurrent users, customer-facing APIs, SaaS platforms.

**Next level:** At 15k+ sustained RPS or needing multi-region, move to [100k RPS architecture](../100krps/README.md).

---

## Architecture Overview

```
                            Internet
                               │
                     ┌─────────▼──────────┐
                     │   Cloud Load       │
                     │   Balancer (ALB)   │
                     │   - TLS termination │
                     │   - Health checks  │
                     │   - Sticky sessions│
                     └───┬────────────┬───┘
                         │            │
          ┌──────────────┴───┬────────┴──────────────┬─────────────┐
          │                  │                       │             │
   ┌──────▼──────┐    ┌──────▼──────┐       ┌───────▼───────┐    │
   │ API Server 1│    │ API Server 2│  ...  │ API Server 8  │   │
   │ (AZ-1)      │    │ (AZ-2)      │       │ (AZ-3)        │   │
   │ ┌─────────┐ │    │ ┌─────────┐ │       │ ┌──────────┐  │   │
   │ │Uvicorn  │ │    │ │Uvicorn  │ │       │ │Uvicorn   │  │   │
   │ │8 workers│ │    │ │8 workers│ │       │ │8 workers │  │   │
   │ │1,250 RPS│ │    │ │1,250 RPS│ │       │ │1,250 RPS │  │   │
   │ └─────────┘ │    │ └─────────┘ │       │ └──────────┘  │   │
   │             │    │             │       │               │   │
   │ 8 vCPU      │    │ 8 vCPU      │       │ 8 vCPU        │   │
   │ 32 GB RAM   │    │ 32 GB RAM   │       │ 32 GB RAM     │   │
   └─────────────┘    └─────────────┘       └───────────────┘   │
          │                  │                       │             │
   ┌──────▼──────────────────▼───────────────────────▼─────────────▼──┐
   │                Auto-Scaling Group (6-12 instances)                │
   │        - Target: 50% CPU utilization                              │
   │        - Min: 6, Desired: 8, Max: 12                              │
   │        - Scale-out: +2 instances when CPU > 60% for 2 min        │
   │        - Scale-in: -1 instance when CPU < 40% for 10 min         │
   └───────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Multi-AZ deployment:** Survive entire data center failure (99.95% availability)
2. **Auto-scaling:** Handle traffic spikes without over-provisioning
3. **Health checks:** Remove unhealthy instances automatically
4. **Connection draining:** Graceful shutdown during deployments
5. **CDN-ready:** Can add CloudFront/Cloudflare later for static assets

---

## Capacity Planning & Formulas

### 1. Instance Count Formula

```
required_instances = ceil(target_rps / rps_per_instance * safety_factor)

where:
  target_rps = 10,000
  rps_per_instance = 1,250 (from 1k RPS doc: 8 cores can handle ~4,500 RPS max)
  safety_factor = 1.5 (50% headroom for traffic spikes)

Calculation:
  base_instances = 10,000 / 1,250 = 8 instances
  with_safety = 8 * 1.5 = 12 instances (max for auto-scaling)

Recommendation:
  - Min instances: 6 (can handle 7,500 RPS)
  - Desired instances: 8 (can handle 10,000 RPS)
  - Max instances: 12 (can handle 15,000 RPS)
```

### 2. Auto-Scaling Target Tracking

```
target_cpu_utilization = (target_rps / rps_capacity_at_100%_cpu) * 100

where:
  target_rps_per_instance = 1,250
  max_rps_per_instance = 4,500 (at 100% CPU)

Calculation:
  target_cpu = (1,250 / 4,500) * 100
  target_cpu = 27.7%

However, we add safety margin for bursts:
  target_cpu_with_margin = 50%

This means:
  - At 50% CPU, instance handles 2,250 RPS
  - Provides 80% headroom over target 1,250 RPS
  - Auto-scaler triggers at 60% CPU (before saturation)
```

### 3. Load Balancer Connection Math

```
concurrent_connections = RPS * avg_request_duration_seconds

where:
  RPS = 10,000
  avg_request_duration = 0.005s (5ms)

Calculation:
  concurrent_connections = 10,000 * 0.005
  concurrent_connections = 50 concurrent connections

Load balancer requirements:
  - Max connections: 1,000 (20x headroom)
  - New connections/second: 10,000
  - Connection timeout: 60 seconds (for keep-alive)
  - Keep-alive connections: ~500 (with connection reuse)
```

### 4. Network Bandwidth (Total)

```
bandwidth = RPS * (request_size + response_size) * 8 / 1_000_000

where:
  RPS = 10,000
  avg_request_size = 1,000 bytes
  avg_response_size = 2,000 bytes

Calculation:
  bandwidth = 10,000 * 3,000 * 8 / 1_000_000
  bandwidth = 240 Mbps total

Per instance (8 instances):
  bandwidth_per_instance = 240 / 8 = 30 Mbps

Network egress cost:
  data_per_month = (240 Mbps / 8) * 86400 * 30 / 1024
  data_per_month = 777.6 GB/month
  cost = 777.6 * $0.09 = ~$70/month
```

### 5. Health Check Overhead

```
health_check_rps = (instances * health_check_frequency) / interval

where:
  instances = 8
  health_check_frequency = 1 check every 10 seconds

Calculation:
  health_check_rps = 8 / 10 = 0.8 RPS

Overhead: Negligible (<0.01% of total traffic)
```

---

## Hardware Sizing

### Per-Instance Specification

| Component | Specification | Rationale |
|-----------|---------------|-----------|
| **Instance Type** | c6i.2xlarge (AWS) or c2-standard-8 (GCP) | 8 vCPU, 16 GB RAM |
| **vCPUs** | 8 | Match worker count |
| **RAM** | 16 GB | 3.5x headroom for workers |
| **Disk** | 50 GB SSD (gp3) | Logs, app code, instance storage |
| **IOPS** | 3,000 | Sufficient for logging |
| **Network** | Up to 10 Gbps | More than enough for 30 Mbps per instance |
| **Availability Zone** | Multi-AZ (3 zones) | Distribute: 3+3+2 instances |

### Load Balancer Specification

| Component | Specification | Notes |
|-----------|---------------|-------|
| **Type** | Application Load Balancer (Layer 7) | HTTP/HTTPS, path-based routing |
| **Capacity Units** | ~3 LCUs | Based on connections, requests, bandwidth |
| **SSL/TLS** | ACM certificate, TLS 1.2+ | Terminate SSL at LB |
| **Health Check** | `/health` endpoint, 10s interval | Remove unhealthy targets |
| **Connection Draining** | 60 seconds | Graceful shutdown |
| **Cross-Zone** | Enabled | Distribute traffic evenly |

### Cost Breakdown (Monthly, 8 instances)

| Item | Cost | Notes |
|------|------|-------|
| Compute (c6i.2xlarge × 8, reserved) | $65 × 8 = $520 | 1-year reserved |
| Storage (50 GB SSD × 8) | $5 × 8 = $40 | gp3 EBS |
| Load Balancer (ALB) | $25 + (3 LCU × $7) = $46 | Base + LCU hours |
| Network egress (778 GB) | $70 | First TB at $0.09/GB |
| CloudWatch metrics | $10 | Custom metrics for auto-scaling |
| Data transfer (inter-AZ) | $20 | Cross-AZ traffic |
| **Total (8 instances)** | **$706/month** | |
| **With auto-scaling avg (10 instances)** | **$836/month** | |
| **Peak (12 instances)** | **$966/month** | |

**Budget estimate:** $1,000/month for safety margin

---

## Software Configuration

### 1. FastAPI Application (Production-Hardened)

**main.py:**
```python
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import time
import logging
import signal
import sys

# Graceful shutdown handler
shutdown_event = False

def signal_handler(sig, frame):
    global shutdown_event
    logging.info(f"Received signal {sig}, initiating graceful shutdown...")
    shutdown_event = True

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.info("FastAPI starting up...")
    # Warm up: pre-import heavy modules, pre-compile regex, etc.
    yield
    logging.info("FastAPI shutting down gracefully...")

app = FastAPI(
    title="FastAPI 10k RPS",
    lifespan=lifespan,
    docs_url=None,  # Disable Swagger in production
    redoc_url=None,
)

# Health check endpoint (used by load balancer)
@app.get("/health")
async def health_check():
    """Load balancer health check - must respond < 200ms"""
    if shutdown_event:
        return JSONResponse(
            status_code=503,
            content={"status": "shutting_down"}
        )
    return {"status": "healthy", "timestamp": time.time()}

# Readiness probe (Kubernetes)
@app.get("/ready")
async def readiness_check():
    """Readiness probe - checks if app can serve traffic"""
    # Could check dependencies here (DB, cache, etc.)
    return {"status": "ready"}

# Main compute endpoint
@app.get("/api/v1/compute")
async def compute_endpoint():
    if shutdown_event:
        return JSONResponse(
            status_code=503,
            content={"error": "service_unavailable"}
        )

    # Simulate 3ms CPU work
    result = sum(i * i for i in range(10000))
    return {
        "result": result,
        "timestamp": time.time(),
        "server": os.getenv("HOSTNAME", "unknown")
    }
```

### 2. Uvicorn Configuration (Systemd Service)

**/etc/systemd/system/uvicorn.service:**
```ini
[Unit]
Description=Uvicorn FastAPI Service
After=network.target

[Service]
Type=notify
User=www-data
Group=www-data
WorkingDirectory=/app

# Environment
Environment="PATH=/app/venv/bin"
Environment="PYTHONOPTIMIZE=2"
Environment="PYTHONUNBUFFERED=1"

# Uvicorn command
ExecStart=/app/venv/bin/gunicorn main:app \
  --workers 8 \
  --worker-class uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:8000 \
  --backlog 2048 \
  --max-requests 100000 \
  --max-requests-jitter 10000 \
  --timeout 30 \
  --graceful-timeout 60 \
  --keep-alive 5 \
  --worker-connections 1000 \
  --access-logfile /var/log/uvicorn/access.log \
  --error-logfile /var/log/uvicorn/error.log \
  --log-level warning

# Restart policy
Restart=always
RestartSec=5
StartLimitInterval=0

# Resource limits
LimitNOFILE=100000
LimitNPROC=8192

[Install]
WantedBy=multi-user.target
```

### 3. Auto-Scaling Configuration (AWS Example)

**CloudFormation / Terraform:**
```yaml
AutoScalingGroup:
  Type: AWS::AutoScaling::AutoScalingGroup
  Properties:
    MinSize: 6
    MaxSize: 12
    DesiredCapacity: 8
    HealthCheckType: ELB
    HealthCheckGracePeriod: 120
    VPCZoneIdentifier:
      - subnet-az1
      - subnet-az2
      - subnet-az3
    TargetGroupARNs:
      - !Ref APITargetGroup
    LaunchTemplate:
      LaunchTemplateId: !Ref APILaunchTemplate
      Version: !GetAtt APILaunchTemplate.LatestVersionNumber

ScalingPolicyCPU:
  Type: AWS::AutoScaling::ScalingPolicy
  Properties:
    AutoScalingGroupName: !Ref AutoScalingGroup
    PolicyType: TargetTrackingScaling
    TargetTrackingConfiguration:
      PredefinedMetricSpecification:
        PredefinedMetricType: ASGAverageCPUUtilization
      TargetValue: 50.0
      ScaleInCooldown: 300
      ScaleOutCooldown: 60

ScalingPolicyRPS:
  Type: AWS::AutoScaling::ScalingPolicy
  Properties:
    AutoScalingGroupName: !Ref AutoScalingGroup
    PolicyType: TargetTrackingScaling
    TargetTrackingConfiguration:
      CustomizedMetricSpecification:
        MetricName: RequestCountPerTarget
        Namespace: AWS/ApplicationELB
        Statistic: Sum
      TargetValue: 1250.0  # 1,250 RPS per instance
```

### 4. Load Balancer Configuration (AWS ALB)

**Target Group:**
```yaml
APITargetGroup:
  Type: AWS::ElasticLoadBalancingV2::TargetGroup
  Properties:
    Port: 8000
    Protocol: HTTP
    VpcId: !Ref VPC
    HealthCheckEnabled: true
    HealthCheckPath: /health
    HealthCheckIntervalSeconds: 10
    HealthCheckTimeoutSeconds: 5
    HealthyThresholdCount: 2
    UnhealthyThresholdCount: 3
    Matcher:
      HttpCode: 200
    TargetType: instance
    Deregistration DelaConnectionDraining:
      ConnectionDraining: true
      DeregistrationDelay: 60  # Wait 60s before removing instance
```

**Listener:**
```yaml
HTTPSListener:
  Type: AWS::ElasticLoadBalancingV2::Listener
  Properties:
    LoadBalancerArn: !Ref ApplicationLoadBalancer
    Port: 443
    Protocol: HTTPS
    SslPolicy: ELBSecurityPolicy-TLS-1-2-2017-01
    Certificates:
      - CertificateArn: !Ref SSLCertificate
    DefaultActions:
      - Type: forward
        TargetGroupArn: !Ref APITargetGroup
```

---

## Load Testing Plan

### Test Infrastructure

**Load generator:**
- **Instance type:** c6i.8xlarge (32 vCPU) - to avoid bottlenecking the client
- **Location:** Same region, different VPC (realistic network path)
- **Tool:** k6 (can generate 30k+ RPS from single instance)

### Test Scenarios

#### Scenario 1: Sustained 10k RPS (30 minutes)

**k6 script:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    sustained_load: {
      executor: 'constant-arrival-rate',
      rate: 10000,  // 10k RPS
      timeUnit: '1s',
      duration: '30m',
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<15', 'p(99)<30'],  // 95th < 15ms, 99th < 30ms
    'http_req_failed': ['rate<0.001'],  // < 0.1% errors
    'errors': ['rate<0.001'],
  },
};

export default function () {
  const res = http.get('https://api.example.com/api/v1/compute');

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 50ms': (r) => r.timings.duration < 50,
  }) || errorRate.add(1);
}
```

**Expected results:**
- RPS: 10,000 ± 100
- p50: < 5ms
- p95: < 15ms
- p99: < 30ms
- Error rate: < 0.01%
- CPU avg: 50-55%
- Auto-scaling: Should stay at 8 instances

#### Scenario 2: Burst to 15k RPS (5 minutes)

```javascript
export const options = {
  scenarios: {
    burst_load: {
      executor: 'ramping-arrival-rate',
      startRate: 10000,
      timeUnit: '1s',
      preAllocatedVUs: 500,
      maxVUs: 1500,
      stages: [
        { duration: '1m', target: 10000 },  // Warmup
        { duration: '2m', target: 15000 },  // Ramp up
        { duration: '3m', target: 15000 },  // Sustain
        { duration: '2m', target: 10000 },  // Ramp down
      ],
    },
  },
};
```

**Expected results:**
- Peak RPS: 15,000
- p95 during burst: < 20ms
- p99 during burst: < 40ms
- Auto-scaling: Should scale to 10-11 instances within 2 minutes
- Scale-in: Should return to 8 instances after 10-minute cooldown

#### Scenario 3: Spike Test (Sudden 20k RPS)

```javascript
export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 1000,
      timeUnit: '1s',
      preAllocatedVUs: 1000,
      maxVUs: 2000,
      stages: [
        { duration: '1m', target: 1000 },   // Low baseline
        { duration: '10s', target: 20000 }, // Sudden spike
        { duration: '2m', target: 20000 },  // Hold spike
        { duration: '1m', target: 1000 },   // Return to baseline
      ],
    },
  },
};
```

**Expected results:**
- Peak RPS: 20,000 (2x normal)
- Latency spike during first 30s (auto-scaler lag)
- p99 may reach 100-150ms during spike
- Auto-scaler should trigger max instances (12)
- Minimal errors (< 0.5%) during scaling

#### Scenario 4: Soak Test (10k RPS for 24 hours)

**Purpose:** Detect memory leaks, connection leaks, worker fatigue

**Expected results:**
- Memory usage stable throughout
- No worker crashes
- Latency stable (< 5% degradation)
- No file descriptor leaks
- Worker recycling working correctly (max-requests)

### Acceptance Criteria

| Metric | Target | Measured | Status |
|--------|--------|----------|--------|
| Sustained 10k RPS | 10,000 ± 1% | TBD | ⏳ |
| Burst 15k RPS | 15,000 ± 2% | TBD | ⏳ |
| Spike 20k RPS | 20,000 ± 5% | TBD | ⏳ |
| p50 latency | < 5ms | TBD | ⏳ |
| p95 latency | < 15ms | TBD | ⏳ |
| p99 latency | < 30ms | TBD | ⏳ |
| Error rate (sustained) | < 0.01% | TBD | ⏳ |
| Error rate (burst) | < 0.1% | TBD | ⏳ |
| Auto-scale out time | < 2 minutes | TBD | ⏳ |
| Auto-scale in time | < 10 minutes | TBD | ⏳ |
| Soak test passes | 24h stable | TBD | ⏳ |

---

## Observability & SLO Strategy

### Distributed Tracing (Recommended at This Scale)

**Add OpenTelemetry:**
```python
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# Configure tracing
trace.set_tracer_provider(TracerProvider())
tracer = trace.get_tracer(__name__)

# Export to Jaeger/Tempo
otlp_exporter = OTLPSpanExporter(endpoint="http://tempo:4317")
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(otlp_exporter)
)

# Auto-instrument FastAPI
FastAPIInstrumentor.instrument_app(app)
```

### Enhanced Metrics

**Per-instance metrics:**
```python
from prometheus_client import Counter, Histogram, Gauge, Info

# Instance identity
instance_info = Info('instance', 'Instance metadata')
instance_info.info({
    'instance_id': os.getenv('INSTANCE_ID'),
    'availability_zone': os.getenv('AZ'),
    'version': os.getenv('APP_VERSION'),
})

# Request metrics with more dimensions
request_count = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status', 'instance_id', 'az']
)

# Connection metrics
active_connections = Gauge(
    'http_active_connections',
    'Currently active connections',
    ['instance_id']
)
```

### SLO Definitions (Formalized)

**SLO 1: Availability**
```
SLO: 99.95% availability over 30-day window
SLI: (successful_requests / total_requests) * 100
Error budget: 0.05% = 21.6 minutes of downtime per month

Measurement:
  - Success: HTTP 200-299, latency < 1s
  - Failure: HTTP 5xx, timeouts, connection errors
```

**SLO 2: Latency**
```
SLO: 99% of requests complete in < 15ms
SLI: histogram_quantile(0.99, http_request_duration_seconds)
Error budget: 1% of requests can be slower

Alerts:
  - Warning: 95% of requests > 15ms for 5 minutes
  - Critical: 99% of requests > 30ms for 2 minutes
```

**SLO 3: Throughput**
```
SLO: Handle 10,000 sustained RPS with < 0.01% errors
SLI: rate(http_requests_total{status=~"2.."}[5m])
Error budget: 1 failed request per 10,000 = 0.6 req/sec

Measurement window: 5-minute rolling average
```

### Dashboards (Grafana)

**Dashboard 1: Real-Time Traffic**
- RPS (total and per-instance)
- Latency heatmap (all percentiles)
- Error rate (5xx, timeouts)
- Active instances in auto-scaling group

**Dashboard 2: Resource Utilization**
- CPU per instance and aggregate
- Memory per instance
- Network throughput
- Disk I/O

**Dashboard 3: Auto-Scaling**
- Instance count over time
- Scale-out events
- Scale-in events
- Target tracking metric (CPU or RPS)

**Dashboard 4: SLO Compliance**
- Availability % (30-day rolling)
- Error budget remaining
- Latency vs SLO
- Incidents and outages

---

## Bottleneck Analysis

### Theoretical Limits

| Component | Max Throughput | Bottleneck When | Mitigation |
|-----------|----------------|-----------------|------------|
| Single instance | ~4,500 RPS | CPU 100% | Add more instances |
| Network (10 Gbps) | ~400,000 RPS | Network saturation | Impossible at this scale |
| Load balancer | ~100,000 RPS | LB connection limit | Use multiple LBs or NLB |
| Auto-scaler lag | ~10k → 15k RPS spike | 2-minute scale-out | Pre-warm instances or use scheduled scaling |

### Failure Mode Analysis

**Top 10 Failure Modes at 10k RPS:**

1. **Cascading failure during auto-scale-out**
   - **Probability:** Medium
   - **Impact:** High (total outage for 1-2 minutes)
   - **Detection:** Sudden 100% error rate
   - **MTTR:** 2-5 minutes (auto-scaler adds instances)
   - **Prevention:** Over-provision min instances (6 instead of 4)

2. **Unhealthy instance not removed**
   - **Probability:** Low
   - **Impact:** Medium (10-15% requests fail)
   - **Detection:** Elevated error rate from specific AZ
   - **MTTR:** 30 seconds (health check fails, instance removed)
   - **Prevention:** Aggressive health check settings

3. **Load balancer connection limit**
   - **Probability:** Very Low (limit is ~100k connections)
   - **Impact:** High (503 errors)
   - **Detection:** LB metrics show rejected connections
   - **MTTR:** 15 minutes (add second LB)
   - **Prevention:** Monitor LB connection metrics

4. **AZ failure**
   - **Probability:** Low (AWS: 99.99% AZ uptime)
   - **Impact:** Medium (33% capacity loss if 3 AZs)
   - **Detection:** Immediate (all instances in AZ fail)
   - **MTTR:** 2-3 minutes (auto-scaler replaces in other AZs)
   - **Prevention:** Multi-AZ with N+2 redundancy

5. **SSL/TLS certificate expiration**
   - **Probability:** Very Low (with ACM auto-renewal)
   - **Impact:** Critical (100% traffic fails)
   - **Detection:** Immediate (client SSL errors)
   - **MTTR:** 5 minutes (emergency cert update)
   - **Prevention:** Monitoring + alerts 30 days before expiry

6. **Deployment rollout failure**
   - **Probability:** Medium (bad code push)
   - **Impact:** High (could affect 100% of traffic)
   - **Detection:** 1-5 minutes (elevated errors during rollout)
   - **MTTR:** 3 minutes (rollback)
   - **Prevention:** Blue-green deployment, canary releases

7. **DDoS attack**
   - **Probability:** Medium (public API)
   - **Impact:** High (saturates all instances)
   - **Detection:** Unusual traffic spike, abnormal patterns
   - **MTTR:** 10-30 minutes (enable WAF rules, rate limiting)
   - **Prevention:** AWS Shield, WAF, rate limiting

8. **Memory leak causing OOM**
   - **Probability:** Low (with max-requests recycling)
   - **Impact:** Medium (gradual degradation)
   - **Detection:** 10-30 minutes (memory metrics growing)
   - **MTTR:** 5 minutes (auto-scaler replaces unhealthy)
   - **Prevention:** Worker recycling, memory alerts

9. **DNS failure**
   - **Probability:** Very Low (Route53: 100% uptime SLA)
   - **Impact:** Critical (clients can't resolve)
   - **Detection:** Immediate (DNS query failures)
   - **MTTR:** 5-10 minutes (DNS propagation)
   - **Prevention:** Multi-provider DNS, long TTLs

10. **Auto-scaling policy misconfiguration**
    - **Probability:** Low (after initial testing)
    - **Impact:** Medium (over/under-provisioning)
    - **Detection:** 5-10 minutes (wrong instance count)
    - **MTTR:** 2 minutes (adjust policy)
    - **Prevention:** IaC + peer review, staging validation

---

## Migration Path

### From 1k RPS → 10k RPS

**Trigger conditions:**
- Sustained 1,500+ RPS for > 2 hours
- Regular traffic spikes > 2k RPS
- Need for high availability (99.95%+)
- Outgrowing single-instance limits

**Migration Strategy (3-Week Timeline):**

**Week 1: Infrastructure Preparation**
1. Create load balancer and target group
2. Set up auto-scaling group with 2 instances (10% of target)
3. Deploy application to new instances
4. Configure health checks
5. Test LB → instances routing

**Week 2: Traffic Migration (Gradual Cutover)**
1. **Monday:** Route 10% traffic to new architecture
   - Monitor error rates, latency
   - Validate auto-scaling works
   - Check health checks removing unhealthy instances

2. **Wednesday:** Route 50% traffic
   - Confirm auto-scaler handles increased load
   - Verify even distribution across AZs

3. **Friday:** Route 100% traffic
   - Keep old infrastructure warm for 24h (rollback ready)

**Week 3: Optimization & Cleanup**
1. Run full load test suite (10k, 15k, 20k RPS)
2. Tune auto-scaling policies based on actual traffic
3. Decommission old infrastructure
4. Update documentation and runbooks

**Rollback Plan:**
- DNS TTL: 60 seconds (allows quick failback)
- Keep old infrastructure running for 7 days post-migration
- Monitor error rates; if > 0.5%, immediate rollback

### To 100k RPS → [Next Guide](../100krps/README.md)

**Trigger conditions:**
- Sustained 15k+ RPS
- Need for multi-region deployment
- Latency requirements tighten (< 10ms p95)
- Regulatory data residency requirements

**Preview of changes:**
- Multi-region active-active deployment
- CDN for static content and edge caching
- More sophisticated auto-scaling (predictive scaling)
- Potentially introduce caching layer (Redis)

---

## Security Considerations

### DDoS Mitigation (Critical at This Scale)

**Layer 3/4 protection:**
```
AWS Shield Standard (free):
  - SYN flood protection
  - UDP reflection attacks
  - Automatic detection and mitigation

AWS Shield Advanced ($3,000/month):
  - Advanced DDoS protection
  - 24/7 DDoS Response Team
  - Cost protection (no overage charges during attack)
```

**Layer 7 protection (AWS WAF):**
```yaml
WebACL:
  - Rate limiting: 2,000 requests per 5 minutes per IP
  - Geo-blocking: Block known malicious countries
  - SQL injection protection
  - XSS protection
  - Bot management (AWS Managed Rules)

Cost: ~$5/month + $1 per 1M requests = ~$15/month
```

### Authentication & Authorization

**API Key-based:**
```python
from fastapi import Security, HTTPException
from fastapi.security import APIKeyHeader

API_KEY_HEADER = APIKeyHeader(name="X-API-Key")

async def verify_api_key(api_key: str = Security(API_KEY_HEADER)):
    # Check against database or cache (Redis recommended)
    if not await is_valid_api_key(api_key):
        raise HTTPException(status_code=403, detail="Invalid API key")
    return api_key

@app.get("/api/v1/compute")
async def compute_endpoint(api_key: str = Depends(verify_api_key)):
    # ...
```

**Rate limiting per API key:**
```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(
    key_func=lambda: request.state.api_key,  # Rate limit per API key
    storage_uri="redis://redis:6379/1"
)

@app.get("/api/v1/compute")
@limiter.limit("1000/minute")  # 1k req/min per API key
async def compute_endpoint(api_key: str = Depends(verify_api_key)):
    # ...
```

---

## Runbooks

### Runbook 1: Auto-Scaler Not Scaling Out During Traffic Spike

**Symptoms:**
- Traffic increasing past 10k RPS
- All instances at > 80% CPU
- Latency degrading (p95 > 30ms)
- Instance count not increasing

**Diagnosis:**
```bash
# Check auto-scaling group status
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names api-asg

# Check scaling activities
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name api-asg \
  --max-records 20

# Check if at max instance count
# Check if cooldown period active
# Check if insufficient capacity in region
```

**Remediation:**

**Immediate (manual override):**
```bash
# Manually set desired capacity
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name api-asg \
  --desired-capacity 12 \
  --no-honor-cooldown
```

**Root cause investigation:**
- Was max capacity reached? → Increase max in ASG config
- Was there an insufficient capacity error? → Add more AZs or instance types
- Is scaling policy broken? → Check CloudWatch alarms

**Long-term fix:**
- Implement scheduled scaling for known traffic patterns
- Use predictive scaling (AWS Auto Scaling Predictive Scaling)
- Set up alerts for "approaching max capacity"

### Runbook 2: Single AZ Failure

**Symptoms:**
- 33% of instances unreachable (assuming 3 AZs)
- Sudden spike in 503 errors
- CloudWatch showing instance failures in one AZ

**Diagnosis:**
```bash
# Check instance health by AZ
aws ec2 describe-instance-status \
  --filters "Name=instance-state-name,Values=running" \
  --query 'InstanceStatuses[?AvailabilityZone==`us-east-1a`]'

# Check target group health
aws elbv2 describe-target-health \
  --target-group-arn <arn>
```

**Remediation:**

**Automatic (should happen via auto-scaling):**
- Health checks fail for affected instances
- Load balancer removes unhealthy targets (30 seconds)
- Auto-scaler launches replacement instances in healthy AZs (2-3 minutes)

**Manual intervention if auto-scaler fails:**
```bash
# Force replacement of unhealthy instances
aws autoscaling set-instance-health \
  --instance-id i-xxx \
  --health-status Unhealthy

# Manually adjust capacity to compensate
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name api-asg \
  --desired-capacity 12
```

**Post-incident:**
- Verify all instances in failed AZ were terminated
- Confirm traffic redistributed evenly to remaining AZs
- File AWS support ticket for AZ failure RCA

### Runbook 3: Load Balancer SSL Certificate Expiration

**Prevention (automated):**
```bash
# Use AWS Certificate Manager with auto-renewal
# ACM automatically renews certs 60 days before expiration
# Set up CloudWatch alarm for expiration:

aws cloudwatch put-metric-alarm \
  --alarm-name cert-expiration-warning \
  --alarm-description "SSL cert expiring in 30 days" \
  --metric-name DaysToExpiry \
  --namespace AWS/CertificateManager \
  --statistic Minimum \
  --period 86400 \
  --threshold 30 \
  --comparison-operator LessThanThreshold
```

**Emergency remediation (manual cert renewal):**
```bash
# Request new cert
aws acm request-certificate \
  --domain-name api.example.com \
  --validation-method DNS

# Add DNS validation records
# Wait for validation

# Update listener to use new cert
aws elbv2 modify-listener \
  --listener-arn <arn> \
  --certificates CertificateArn=<new-cert-arn>

# Zero downtime: LB supports multiple certs
```

---

## Deployment Strategy

### Blue-Green Deployment (Zero Downtime)

**Architecture:**
```
                Load Balancer
                     │
         ┌───────────┴───────────┐
         │                       │
   Blue ASG (v1.0)          Green ASG (v1.1)
   - 8 instances            - 8 instances
   - 100% traffic           - 0% traffic
   - Production             - Staging validation
```

**Deployment steps:**
1. **Deploy to Green ASG** (v1.1)
2. **Smoke test** Green ASG (internal testing)
3. **Route 10% traffic** to Green, monitor for 10 minutes
4. **Route 50% traffic**, monitor for 20 minutes
5. **Route 100% traffic**, monitor for 1 hour
6. **Decommission Blue ASG** after 24 hours (keep for rollback)

**Rollback:** Switch traffic back to Blue ASG (< 60 seconds)

### Canary Deployment (Lower Risk)

**Architecture:**
```
                Load Balancer
                     │
         ┌───────────┼───────────┐
         │ 95%       │ 5%        │
   Stable ASG       Canary ASG
   - 8 instances    - 1 instance
   - v1.0           - v1.1
```

**Deployment steps:**
1. Deploy v1.1 to 1 instance (canary)
2. Route 5% traffic to canary
3. Monitor error rate, latency for 30 minutes
4. If successful: gradually roll out to all instances
5. If failed: terminate canary, rollback

---

## Testing Results (To Be Updated)

### Sustained 10k RPS Test

```
Date: TBD
Infrastructure: 8 × c6i.2xlarge, AWS ALB
Workers: 8 per instance (64 total)
Duration: 30 minutes
Target RPS: 10,000

Results:
- RPS achieved: TBD
- RPS variance: TBD
- p50 latency: TBD
- p95 latency: TBD
- p99 latency: TBD
- Error rate: TBD
- CPU average: TBD
- CPU p95: TBD
- Memory max: TBD
- Auto-scaling events: TBD
- Instance count (min/avg/max): TBD

Status: ⏳ Pending
```

### Burst 15k RPS Test

```
Date: TBD
Infrastructure: 8 × c6i.2xlarge → auto-scale to 10-11
Duration: 5 minutes burst
Target RPS: 15,000

Results:
- Peak RPS: TBD
- Time to scale out: TBD
- Instances added: TBD
- p95 latency during burst: TBD
- p99 latency during burst: TBD
- Error rate during scale-out: TBD
- Time to return to baseline: TBD

Status: ⏳ Pending
```

### Soak Test (24 hours)

```
Date: TBD
Duration: 24 hours
Target RPS: 10,000 sustained

Results:
- Memory leak detected: TBD
- Worker crashes: TBD
- Latency degradation: TBD
- File descriptor leaks: TBD
- Auto-scaling behavior: TBD

Status: ⏳ Pending
```

---

## Next Steps

1. **Infrastructure:** Deploy [Terraform configs](../../../deployments/terraform/10krps/)
2. **Testing:** Run [k6 test suite](../../../load-tests/k6/fastapi-10krps/)
3. **Monitoring:** Set up [Grafana dashboards](../../../observability/dashboards/10krps/)
4. **Ops:** Review [runbook collection](../../../runbooks/10krps/)
5. **Scale:** When ready, migrate to [100k RPS](../100krps/README.md)

---

**Document Version:** 1.0
**Last Updated:** 2025-11-16
**Validated By:** ⏳ Pending
**Next Review:** After first production deployment
