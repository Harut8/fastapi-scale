# Load Testing Guide

This directory contains comprehensive load testing scripts and tools for validating FastAPI performance at various scales.

## Quick Start

```bash
# Install k6
# macOS
brew install k6

# Ubuntu/Debian
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-update && sudo apt install k6

# Run a test
cd k6/
k6 run fastapi-100rps-sustained.js
```

## Available Test Suites

### k6 Tests (Recommended)

| Script | Target RPS | Duration | Purpose |
|--------|------------|----------|---------|
| `fastapi-100rps-sustained.js` | 100 | 60s | Baseline single-host performance |
| `fastapi-100rps-burst.js` | 300 | 30s | Burst capacity validation |
| `fastapi-1krps-sustained.js` | 1,000 | 5m | Vertical scaling validation |
| `fastapi-1krps-burst.js` | 2,000 | 60s | Burst with vertical scaling |
| `fastapi-1krps-soak.js` | 1,000 | 24h | Memory leak detection |
| `fastapi-10krps-sustained.js` | 10,000 | 30m | Distributed system validation |
| `fastapi-10krps-burst.js` | 15,000 | 5m | Auto-scaling validation |
| `fastapi-10krps-spike.js` | 20,000 | 2m | Sudden traffic spike handling |

### wrk Tests (Lightweight Alternative)

Located in `wrk/` directory. Simpler, uses less client resources, but less feature-rich.

```bash
wrk -t8 -c100 -d60s --latency http://localhost:8000/api/v1/compute
```

### Vegeta Tests (Command-line Focused)

Located in `vegeta/` directory. Great for CI/CD pipelines.

```bash
echo "GET http://localhost:8000/api/v1/compute" | \
  vegeta attack -rate=100 -duration=60s | \
  vegeta report
```

## Test Architecture

### Load Generator Sizing

**For 100-1k RPS:**
- Any modern laptop (4+ cores)
- Network: 1 Gbps sufficient

**For 10k RPS:**
- Dedicated server: 16+ vCPU, 32+ GB RAM
- Instance type: c6i.4xlarge or equivalent
- Network: 10 Gbps

**For 100k+ RPS:**
- Multiple load generators in parallel
- Distributed k6 setup with k6 Cloud
- Instance type: c6i.8xlarge × 4-8 instances

### Load Generator Placement

**Same region, different VPC (recommended):**
```
┌─────────────────────────────────────┐
│         AWS Region us-east-1        │
│                                     │
│  ┌──────────────┐  ┌─────────────┐ │
│  │  VPC-App     │  │  VPC-Test   │ │
│  │              │  │             │ │
│  │  FastAPI     │◄─┤  k6 Load    │ │
│  │  Cluster     │  │  Generator  │ │
│  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────┘
```

**Benefits:**
- Realistic network latency
- Isolated from target resources
- Can test cross-VPC peering
- No impact from load generator on target

## Running Tests

### Basic Test

```bash
k6 run k6/fastapi-100rps-sustained.js
```

### With Custom Target

```bash
TARGET_URL=https://api.example.com k6 run k6/fastapi-1krps-sustained.js
```

### With Detailed Metrics Output

```bash
# Output to JSON
k6 run --out json=results.json k6/fastapi-10krps-sustained.js

# Output to InfluxDB
k6 run --out influxdb=http://localhost:8086/k6 k6/fastapi-10krps-sustained.js

# Output to k6 Cloud (for distributed testing)
k6 login cloud
k6 run --out cloud k6/fastapi-10krps-sustained.js
```

### Distributed Testing (100k+ RPS)

```bash
# Terminal 1 (coordinator)
k6 run --execution-mode=cloud k6/fastapi-100krps-sustained.js

# Or use k6 Cloud directly
k6 cloud k6/fastapi-100krps-sustained.js
```

## Interpreting Results

### Key Metrics

**http_req_duration:**
- **p50 (median):** Half of requests are faster than this
- **p95:** 95% of requests are faster than this (SLO boundary)
- **p99:** 99% of requests are faster than this (SLO boundary)
- **max:** Slowest request (watch for outliers)

**http_req_failed:**
- **rate:** Percentage of failed requests
- **Target:** < 0.001 (0.1%) for production SLOs

**http_reqs:**
- **rate:** Actual RPS achieved
- **Should match:** Target RPS ± 2%

### Example Good Output

```
✓ status is 200
✓ response time < 50ms
✓ has result field

http_req_duration..............: avg=4.2ms  p(95)=10ms   p(99)=18ms   max=45ms
http_req_failed................: 0.00%   ✓ 0      ✗ 300000
http_reqs......................: 300000  1000/s
```

✅ **PASS** - All thresholds met

### Example Failed Output

```
✗ status is 200
  ↳  98% — ✓ 294000 / ✗ 6000

http_req_duration..............: avg=45ms   p(95)=120ms  p(99)=250ms  max=5s
http_req_failed................: 2.00%   ✓ 6000   ✗ 294000
http_reqs......................: 300000  857/s
```

❌ **FAIL** - Error rate too high, latency SLOs breached, RPS below target

## Test Scenarios Explained

### 1. Sustained Load

**Purpose:** Validate system can handle target RPS continuously

**Pattern:**
```
RPS
 ^
 |  ┌──────────────────┐
 |  │                  │
 |  │                  │
 |──┘                  └───
 └─────────────────────────> Time
    Ramp  Sustain  Ramp-down
```

**Use when:**
- Initial performance validation
- After code changes
- Capacity planning

### 2. Burst Load

**Purpose:** Validate headroom for traffic spikes

**Pattern:**
```
RPS
 ^
 |      ┌────┐
 |      │    │
 |  ┌───┘    └───┐
 |  │            │
 |──┘            └────
 └─────────────────────> Time
```

**Use when:**
- Validating auto-scaling
- Testing buffer capacity
- Simulating viral traffic

### 3. Spike Test

**Purpose:** Validate behavior under sudden traffic increase

**Pattern:**
```
RPS
 ^
 |    ┌┐
 |    ││
 |    ││
 |    ││
 |────┘└────────────
 └─────────────────────> Time
```

**Use when:**
- Testing auto-scaler reaction time
- Validating circuit breakers
- Load balancer behavior

### 4. Soak Test

**Purpose:** Detect memory leaks, resource exhaustion over time

**Pattern:**
```
RPS
 ^
 |  ┌────────────────────────────────────┐
 |  │                                    │
 |──┘                                    └───
 └─────────────────────────────────────────> Time
    24 hours+
```

**Use when:**
- Before major releases
- After memory management changes
- Quarterly performance validation

### 5. Ramp Test

**Purpose:** Find breaking point and measure graceful degradation

**Pattern:**
```
RPS
 ^
 |                    ┌──
 |                 ┌──┘
 |              ┌──┘
 |           ┌──┘
 |        ┌──┘
 |     ┌──┘
 |  ┌──┘
 |──┘
 └─────────────────────────> Time
```

**Use when:**
- Capacity planning
- Finding saturation points
- Tuning auto-scaling policies

## Acceptance Criteria

### 100 RPS Tests

| Metric | Target | Status |
|--------|--------|--------|
| Sustained RPS | 100 ± 5% | ⏳ |
| p95 latency | < 25ms | ⏳ |
| p99 latency | < 50ms | ⏳ |
| Error rate | < 0.1% | ⏳ |

### 1k RPS Tests

| Metric | Target | Status |
|--------|--------|--------|
| Sustained RPS | 1,000 ± 2% | ⏳ |
| p95 latency | < 12ms | ⏳ |
| p99 latency | < 25ms | ⏳ |
| Error rate | < 0.01% | ⏳ |
| Soak test (24h) | No degradation | ⏳ |

### 10k RPS Tests

| Metric | Target | Status |
|--------|--------|--------|
| Sustained RPS | 10,000 ± 1% | ⏳ |
| Burst RPS | 15,000 | ⏳ |
| p95 latency | < 15ms | ⏳ |
| p99 latency | < 30ms | ⏳ |
| Error rate | < 0.01% | ⏳ |
| Auto-scale time | < 2 min | ⏳ |

## Monitoring During Tests

### Real-time Monitoring

While test is running, monitor these dashboards:

1. **Grafana Application Dashboard**
   - RPS (should match k6 target)
   - Latency percentiles
   - Error rate
   - CPU/memory per instance

2. **Grafana Infrastructure Dashboard**
   - Auto-scaling events
   - Instance health
   - Load balancer metrics
   - Network throughput

3. **CloudWatch (AWS) / Stackdriver (GCP)**
   - Instance CPU/memory
   - Load balancer request count
   - 5xx error count
   - Target group health

### Alert Silence

**Before starting load test:**

```bash
# Silence alerts for duration of test
# (Prevent false alarms during intentional load)

# Prometheus AlertManager
amtool silence add \
  alertname=~"HighLatency|HighCPU" \
  --duration=30m \
  --author="load-test" \
  --comment="Scheduled 10k RPS load test"

# Or via Grafana Silence UI
```

**After test:**
```bash
# Verify silences expire
amtool silence query
```

## Post-Test Analysis

### 1. Generate Report

```bash
# HTML report generated automatically by k6
open summary.html

# Or generate custom report
k6 run --out json=results.json k6/fastapi-10krps-sustained.js
python3 ../scripts/generate-report.py results.json
```

### 2. Compare with Baseline

```bash
# Compare two test runs
k6-compare results-baseline.json results-current.json
```

### 3. Identify Regressions

```python
# Example: Check for latency regressions
import json

with open('results-baseline.json') as f:
    baseline = json.load(f)

with open('results-current.json') as f:
    current = json.load(f)

baseline_p95 = baseline['metrics']['http_req_duration']['values']['p(95)']
current_p95 = current['metrics']['http_req_duration']['values']['p(95)']

if current_p95 > baseline_p95 * 1.1:  # 10% regression threshold
    print(f"❌ REGRESSION: p95 latency increased by {((current_p95/baseline_p95 - 1) * 100):.2f}%")
else:
    print("✅ No regression detected")
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Load Test

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 2 * * 1'  # Weekly on Monday 2am

jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Install k6
        run: |
          sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt update && sudo apt install k6

      - name: Run 100 RPS test
        run: |
          k6 run --out json=results.json load-tests/k6/fastapi-100rps-sustained.js

      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: load-test-results
          path: results.json

      - name: Check SLOs
        run: |
          python3 scripts/check-slos.py results.json
```

## Troubleshooting

### Issue: Can't reach target RPS

**Symptoms:**
- k6 reports `http_reqs rate` < target
- Warnings about VU shortage

**Solutions:**
```bash
# Increase VUs
k6 run --vus 200 script.js

# Increase maxVUs in script
# preAllocatedVUs: 500,
# maxVUs: 1000,

# Use more powerful load generator
# Upgrade to instance with more CPU
```

### Issue: High client-side latency

**Symptoms:**
- `http_req_duration` high in k6
- Server-side metrics show low latency

**Causes:**
- Network saturation on load generator
- Load generator CPU saturated
- DNS resolution issues

**Solutions:**
```bash
# Use dedicated load generator server
# Not shared with other processes

# Enable HTTP/2 (parallel connections)
# http.setResponseCallback(...)

# Disable SSL verification if in test env
# insecureSkipTLSVerify: true
```

### Issue: Connection errors

**Symptoms:**
- `http_req_failed` rate high
- Connection refused errors

**Causes:**
- Server file descriptor limit
- Load balancer connection limit
- Firewall rules

**Solutions:**
```bash
# Server side: increase file descriptors
ulimit -n 100000

# Check server backlog
sysctl net.core.somaxconn

# Verify load balancer limits
aws elbv2 describe-load-balancers
```

## Best Practices

### 1. Start Small, Scale Up

```bash
# Day 1: Validate 100 RPS works
k6 run k6/fastapi-100rps-sustained.js

# Day 2: Test 1k RPS
k6 run k6/fastapi-1krps-sustained.js

# Day 3: Test 10k RPS
k6 run k6/fastapi-10krps-sustained.js

# Don't jump straight to high load
```

### 2. Always Warmup

```javascript
// In setup() function
export function setup() {
  // Send warmup traffic
  for (let i = 0; i < 100; i++) {
    http.get(`${TARGET_URL}/api/v1/compute`);
  }
  sleep(5);  // Let server stabilize
}
```

### 3. Monitor Client AND Server

- k6 metrics (client view)
- Grafana dashboards (server view)
- Compare: if client latency high but server low, network issue

### 4. Version Control Results

```bash
# Save baseline
k6 run --out json=results-baseline-v1.0.json script.js

# Compare after changes
k6 run --out json=results-v1.1.json script.js
diff results-baseline-v1.0.json results-v1.1.json
```

### 5. Document Everything

After each test, record:
- Date/time
- Target and actual RPS
- Instance types and counts
- Code version (git commit)
- Configuration changes
- SLO pass/fail
- Anomalies observed

## Additional Resources

- [k6 Official Docs](https://k6.io/docs/)
- [Load Testing Best Practices](https://k6.io/docs/test-types/load-testing-best-practices/)
- [Distributed k6](https://k6.io/docs/testing-guides/running-distributed-tests/)
- [k6 Cloud](https://k6.io/cloud/)

## Next Steps

1. **Run baseline tests** for your current deployment
2. **Establish SLO baselines** from actual measurements
3. **Automate in CI/CD** for regression detection
4. **Schedule weekly soak tests** to catch memory leaks early
5. **Tune based on results** - iterate on configuration

---

**Questions?** Check [runbooks](../runbooks/) or open an issue.
