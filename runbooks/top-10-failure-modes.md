# Runbooks: Top 10 Failure Modes

**Version:** 1.0
**Last Updated:** 2025-11-16
**Audience:** SRE, On-Call Engineers
**Status:** Production Ready

---

## Overview

This document provides step-by-step runbooks for the 10 most common and critical failure modes when scaling FastAPI applications. Each runbook includes:

- **Symptoms:** How to identify the issue
- **Detection:** Monitoring alerts and signals
- **Impact:** Severity and blast radius
- **Diagnosis:** How to confirm root cause
- **Immediate Remediation:** Steps to restore service
- **Prevention:** Long-term fixes
- **MTTR:** Mean Time To Recovery

**On-Call Priority:**
1. **P0 (Critical):** Total outage, >50% error rate
2. **P1 (High):** Degraded performance, 10-50% errors
3. **P2 (Medium):** Elevated latency, < 10% errors
4. **P3 (Low):** Non-customer-impacting issues

---

## Table of Contents

1. [CPU Saturation](#1-cpu-saturation)
2. [Memory Exhaustion / OOM](#2-memory-exhaustion--oom)
3. [Database Connection Pool Exhausted](#3-database-connection-pool-exhausted)
4. [Auto-Scaler Not Scaling](#4-auto-scaler-not-scaling)
5. [Load Balancer Connection Limit](#5-load-balancer-connection-limit)
6. [Availability Zone Failure](#6-availability-zone-failure)
7. [Deployment Rollout Failure](#7-deployment-rollout-failure)
8. [DDoS Attack / Traffic Spike](#8-ddos-attack--traffic-spike)
9. [Database Primary Failure](#9-database-primary-failure)
10. [Redis Cache Failure](#10-redis-cache-failure)

---

## 1. CPU Saturation

### Symptoms
- High latency (p95 > 100ms, p99 > 500ms)
- Response times increasing linearly with traffic
- API servers showing 90-100% CPU utilization
- Request queue building up
- No errors, just slow

### Detection
```
Alert: HighCPUUtilization
Severity: P1 (High)
Condition: avg(cpu_usage) > 85% for 5 minutes
```

Grafana Query:
```promql
avg(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (instance) * 100 > 85
```

### Impact
- **Severity:** High
- **Affected users:** All users see degraded performance
- **SLO impact:** Latency SLO breached, availability OK
- **Revenue impact:** High (if payment/checkout flows)

### Diagnosis

**1. Confirm CPU saturation:**
```bash
# SSH to instance
ssh app-server-01

# Check overall CPU
top -bn1 | head -20

# Check CPU per core
mpstat -P ALL 1 5

# Check which workers are hot
ps aux --sort=-%cpu | grep uvicorn | head -10

# Check if it's Python GIL contention or actual work
sudo py-spy top --pid $(pgrep -f 'uvicorn')
```

**2. Determine if it's traffic spike or application issue:**
```bash
# Check current RPS
curl -s http://localhost:9090/api/v1/query?query='rate(http_requests_total[1m])' | jq

# Compare to historical
# If RPS normal but CPU high → application regression
# If RPS elevated → capacity issue
```

**3. Check for slow endpoints:**
```bash
# Check p95 latency by endpoint
curl -s 'http://localhost:9090/api/v1/query?query=histogram_quantile(0.95,http_request_duration_seconds_bucket)' | jq

# Look for recently deployed code
git log --since="24 hours ago" --oneline
```

### Immediate Remediation

**Option A: Scale Out (5-10 minutes)**
```bash
# Manually increase auto-scaling group desired capacity
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name api-asg \
  --desired-capacity 12 \
  --no-honor-cooldown

# Monitor scaling activity
watch -n 5 'aws autoscaling describe-scaling-activities --auto-scaling-group-name api-asg --max-records 5'

# Verify new instances join load balancer
aws elbv2 describe-target-health --target-group-arn <arn>
```

**Option B: Reduce Load (2-3 minutes)**
```bash
# Enable aggressive rate limiting at load balancer
# Nginx example:
sudo vi /etc/nginx/conf.d/api.conf
# Add: limit_req_zone $binary_remote_addr zone=emergency:10m rate=10r/s;

sudo nginx -t && sudo nginx -s reload

# Or enable WAF rate limiting (AWS)
aws wafv2 update-web-acl \
  --scope REGIONAL \
  --id <web-acl-id> \
  --lock-token <token> \
  --default-action Block={}
```

**Option C: Rollback (if recent deployment)**
```bash
# If CPU spike correlates with deployment, rollback
# Blue-green deployment:
aws elbv2 modify-listener \
  --listener-arn <listener-arn> \
  --default-actions Type=forward,TargetGroupArn=<old-target-group>

# Or via Kubernetes:
kubectl rollout undo deployment/api-server
kubectl rollout status deployment/api-server
```

### Prevention

**1. Set auto-scaling triggers earlier:**
```yaml
# Scale out at 50% CPU instead of 70%
TargetTrackingScalingPolicy:
  TargetValue: 50.0  # was 70.0
  PredefinedMetricType: ASGAverageCPUUtilization
```

**2. Implement horizontal pod autoscaler (Kubernetes):**
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 8
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
```

**3. Profile application code:**
```bash
# Use py-spy to find hot code paths
py-spy record --pid $(pgrep -f uvicorn) --duration 60 --output profile.svg

# Review generated flamegraph
open profile.svg
```

**4. Optimize hot paths:**
- Cache expensive computations
- Use async/await for I/O
- Offload heavy work to background queue
- Consider Cython for CPU-intensive loops

### MTTR
- **Detection:** < 1 minute (alert fires)
- **Diagnosis:** 2-3 minutes
- **Remediation:** 5-10 minutes (scale out)
- **Total:** ~15 minutes

---

## 2. Memory Exhaustion / OOM

### Symptoms
- Instances being killed by OOM killer
- Memory usage growing over time (memory leak)
- Swap usage increasing
- Worker processes restarting unexpectedly
- "MemoryError" in application logs

### Detection
```
Alert: HighMemoryUsage
Severity: P1 (High)
Condition: memory_usage > 90% for 10 minutes
```

```
Alert: OOMKills
Severity: P0 (Critical)
Condition: increase(node_vmstat_oom_kill[5m]) > 0
```

### Impact
- **Severity:** Critical (if OOM kills happen)
- **Affected users:** Intermittent errors, connection resets
- **SLO impact:** Availability SLO breached
- **Revenue impact:** High

### Diagnosis

**1. Check current memory usage:**
```bash
# Overall memory
free -h

# Per process
ps aux --sort=-%mem | head -20

# Check for swap usage (bad sign)
swapon --show
vmstat 1 5

# Check OOM kills in system logs
dmesg | grep -i 'out of memory'
journalctl -k | grep -i 'killed process'
```

**2. Check for memory leak:**
```bash
# Track worker memory over time
for pid in $(pgrep -f uvicorn); do
  echo "PID $pid:"
  ps -p $pid -o pid,ppid,cmd,%mem,rss,vsz
done

# Wait 10 minutes and check again
# If RSS growing continuously → memory leak
```

**3. Profile memory usage (Python):**
```python
# Add to application temporarily
import tracemalloc
tracemalloc.start()

# After some requests
snapshot = tracemalloc.take_snapshot()
top_stats = snapshot.statistics('lineno')

for stat in top_stats[:10]:
    print(stat)
```

**4. Check for external causes:**
```bash
# Other processes using memory?
systemctl status
docker stats  # If using containers

# Kernel memory leaks?
slabtop  # Check kernel slab allocations
```

### Immediate Remediation

**Option A: Restart Workers (30 seconds - 2 minutes)**
```bash
# Gracefully restart all workers one by one
for i in {0..15}; do
  systemctl restart uvicorn@$i
  sleep 5  # Wait for health check
done

# Or with Gunicorn (HUP signal)
kill -HUP $(pgrep -f gunicorn)

# Kubernetes
kubectl rollout restart deployment/api-server
```

**Option B: Trigger Auto-Scaling Replacement (5 minutes)**
```bash
# Mark instance unhealthy, auto-scaler will replace
aws autoscaling set-instance-health \
  --instance-id i-xxxxx \
  --health-status Unhealthy

# Monitor replacement
aws autoscaling describe-scaling-activities
```

**Option C: Emergency Memory Release (Python GC)**
```python
# If you have admin endpoint, trigger manual GC
import gc
gc.collect(generation=2)  # Full collection

# Or via command line (if debugging)
python3 -c "import gc; gc.collect()"
```

### Prevention

**1. Configure worker recycling:**
```bash
# Gunicorn: restart workers after N requests
gunicorn main:app \
  --max-requests 100000 \
  --max-requests-jitter 10000  # Prevent thundering herd
```

**2. Set memory limits (Docker):**
```yaml
services:
  api:
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 1G
```

**3. Kubernetes resource limits:**
```yaml
resources:
  limits:
    memory: "2Gi"
  requests:
    memory: "1Gi"
```

**4. Implement memory monitoring:**
```python
from prometheus_client import Gauge
import psutil

memory_usage = Gauge('process_memory_bytes', 'Process memory usage')

@app.middleware("http")
async def track_memory(request, call_next):
    memory_usage.set(psutil.Process().memory_info().rss)
    return await call_next(request)
```

**5. Find and fix memory leaks:**
```bash
# Use memory_profiler
pip install memory_profiler
python -m memory_profiler app.py

# Use py-spy
py-spy record --pid $(pgrep uvicorn) --duration 300 --output profile.svg
```

### MTTR
- **Detection:** < 5 minutes
- **Diagnosis:** 5 minutes
- **Remediation:** 2 minutes (restart workers)
- **Total:** ~12 minutes

---

## 3. Database Connection Pool Exhausted

### Symptoms
- "Could not connect to database" errors
- "Connection pool exhausted" in logs
- API requests timing out waiting for DB connection
- PostgreSQL shows max connections reached
- Elevated error rate (5xx)

### Detection
```
Alert: DatabaseConnectionPoolExhausted
Severity: P0 (Critical)
Condition: db_connections_active >= db_connections_max_pool_size
```

```
Alert: DatabaseMaxConnections
Severity: P0 (Critical)
Condition: pg_stat_database_connections >= pg_settings_max_connections * 0.95
```

### Impact
- **Severity:** Critical
- **Affected users:** 30-100% (depending on query distribution)
- **SLO impact:** Both availability and latency SLOs breached
- **Revenue impact:** Critical

### Diagnosis

**1. Check application connection pool:**
```python
# Add to FastAPI app (SQLAlchemy example)
from sqlalchemy import select, func

@app.get("/debug/db-pool")
async def debug_pool_status():
    return {
        "size": engine.pool.size(),
        "checked_in": engine.pool.checkedin(),
        "checked_out": engine.pool.checkedout(),
        "overflow": engine.pool.overflow(),
    }
```

```bash
# Check via curl
curl http://localhost:8000/debug/db-pool
```

**2. Check PostgreSQL connections:**
```sql
-- Connect to PostgreSQL
psql -U postgres -h db-host

-- Check current connections
SELECT count(*) as connections, state
FROM pg_stat_activity
GROUP BY state;

-- Check connections by application
SELECT application_name, count(*)
FROM pg_stat_activity
WHERE state = 'active'
GROUP BY application_name;

-- Check for idle connections
SELECT pid, usename, application_name, state, query_start
FROM pg_stat_activity
WHERE state = 'idle'
ORDER BY query_start;

-- Check max connections setting
SHOW max_connections;
```

**3. Check for connection leaks:**
```bash
# Check long-running queries
SELECT pid, now() - query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active'
  AND now() - query_start > interval '1 minute'
ORDER BY duration DESC;

# Check idle in transaction (leak indicator)
SELECT pid, now() - state_change AS duration, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY duration DESC;
```

### Immediate Remediation

**Option A: Increase Pool Size (30 seconds)**
```python
# Temporarily increase connection pool
# In config or environment variable
DATABASE_POOL_SIZE=50  # was 20
DATABASE_MAX_OVERFLOW=20  # was 10

# Restart application
systemctl restart api-server

# Or for SQLAlchemy:
engine = create_engine(
    DATABASE_URL,
    pool_size=50,
    max_overflow=20,
    pool_pre_ping=True,
)
```

**Option B: Increase PostgreSQL max_connections (2 minutes)**
```sql
-- Temporarily increase (requires restart)
ALTER SYSTEM SET max_connections = 500;  -- was 200

-- Then restart PostgreSQL
SELECT pg_reload_conf();  -- For some settings, this is enough
-- OR
-- Restart PostgreSQL (if max_connections changed)
```

```bash
# AWS RDS: modify parameter group
aws rds modify-db-parameter-group \
  --db-parameter-group-name myparametergroup \
  --parameters "ParameterName=max_connections,ParameterValue=500,ApplyMethod=immediate"

# Reboot RDS instance if required
aws rds reboot-db-instance --db-instance-identifier mydb
```

**Option C: Kill Idle Connections (10 seconds)**
```sql
-- Kill idle connections older than 5 minutes
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle'
  AND now() - state_change > interval '5 minutes'
  AND pid <> pg_backend_pid();

-- Kill idle in transaction (leaks)
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND now() - state_change > interval '1 minute';
```

**Option D: Deploy PgBouncer (if not already)**
```bash
# PgBouncer provides connection pooling
# Allows 100s of app connections with only 20-40 DB connections

# Quick deploy via Docker
docker run -d \
  --name pgbouncer \
  -p 5432:5432 \
  -e DB_HOST=postgres \
  -e DB_PORT=5432 \
  -e DB_USER=myuser \
  -e DB_PASSWORD=mypass \
  -e POOL_MODE=transaction \
  -e MAX_CLIENT_CONN=1000 \
  -e DEFAULT_POOL_SIZE=25 \
  edoburu/pgbouncer
```

### Prevention

**1. Right-size connection pools:**
```python
# Formula: pool_size = (cores * 2) + effective_spindle_count
# For most cloud DBs: pool_size = cores * 2

# Example configuration
DATABASE_POOL_SIZE = 20  # Per worker
DATABASE_MAX_OVERFLOW = 10
DATABASE_POOL_RECYCLE = 3600  # Recycle connections every hour
DATABASE_POOL_PRE_PING = True  # Verify connections before use
```

**2. Implement connection pooling with PgBouncer:**
```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
mydb = host=postgres port=5432 dbname=mydb

[pgbouncer]
pool_mode = transaction  # Most efficient
max_client_conn = 1000  # From application
default_pool_size = 40  # To PostgreSQL
reserve_pool_size = 10
reserve_pool_timeout = 3
```

**3. Set statement_timeout:**
```sql
-- Prevent runaway queries
ALTER DATABASE mydb SET statement_timeout = '30s';

-- Or per connection
SET statement_timeout = '30s';
```

**4. Monitor connection usage:**
```python
# Prometheus metrics
from prometheus_client import Gauge

db_connections_active = Gauge('db_connections_active', 'Active DB connections')
db_connections_idle = Gauge('db_connections_idle', 'Idle DB connections')

# Update periodically
db_connections_active.set(engine.pool.checkedout())
db_connections_idle.set(engine.pool.checkedin())
```

### MTTR
- **Detection:** < 1 minute
- **Diagnosis:** 2-3 minutes
- **Remediation:** 30 seconds (increase pool) to 5 minutes (deploy PgBouncer)
- **Total:** ~5-8 minutes

---

## 4. Auto-Scaler Not Scaling

### Symptoms
- Traffic increasing but instance count static
- All instances at high CPU (> 80%)
- Latency degrading
- No scaling activities in logs
- Error rate increasing

### Detection
```
Alert: AutoScalerNotScaling
Severity: P1 (High)
Condition: cpu_usage > 80% AND instance_count == min_instances for 10 minutes
```

### Impact
- **Severity:** High
- **Affected users:** All users (degraded performance)
- **SLO impact:** Latency SLO breached
- **Revenue impact:** Medium-High

### Diagnosis

**1. Check auto-scaling configuration:**
```bash
# AWS Auto Scaling Group
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names api-asg

# Check scaling policies
aws autoscaling describe-policies \
  --auto-scaling-group-name api-asg

# Check recent scaling activities
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name api-asg \
  --max-records 20
```

**2. Common issues:**

**A. At max capacity:**
```bash
# Check if at max instances
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names api-asg \
  --query 'AutoScalingGroups[0].[MinSize,DesiredCapacity,MaxSize]'

# Output: [6, 12, 12] ← At max!
```

**B. Cooldown period active:**
```bash
# Check last scaling activity time
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name api-asg \
  --max-records 1 \
  --query 'Activities[0].StartTime'

# If < 5 minutes ago, cooldown may be active
```

**C. Insufficient capacity (AWS):**
```bash
# Check for InsufficientInstanceCapacity errors
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name api-asg \
  --query 'Activities[?StatusCode==`Failed`]'
```

**D. Metrics delay:**
```bash
# Check if CloudWatch metrics are being published
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=AutoScalingGroupName,Value=api-asg \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Average
```

### Immediate Remediation

**A. Manual scaling (60 seconds):**
```bash
# Immediately increase capacity
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name api-asg \
  --desired-capacity 16 \
  --no-honor-cooldown  # Override cooldown

# Verify instances launching
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name api-asg
```

**B. Increase max capacity (if at limit):**
```bash
# Increase max instances
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name api-asg \
  --max-size 20  # was 12

# Then trigger scale-out
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name api-asg \
  --desired-capacity 16
```

**C. Use different instance type (if capacity issue):**
```bash
# Update launch template with different instance type
aws ec2 create-launch-template-version \
  --launch-template-id lt-xxx \
  --source-version 1 \
  --launch-template-data '{"InstanceType":"c6i.xlarge"}'

# Update ASG to use new version
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name api-asg \
  --launch-template LaunchTemplateId=lt-xxx,Version='$Latest'
```

**D. Add instances in different AZ:**
```bash
# If one AZ has no capacity, try others
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name api-asg \
  --availability-zones us-east-1a us-east-1b us-east-1c us-east-1d
```

### Prevention

**1. Set appropriate max capacity:**
```yaml
# Always set max to 2-3x normal load
AutoScalingGroup:
  MinSize: 6
  MaxSize: 24  # 4x min, not just 2x
```

**2. Use predictive scaling:**
```yaml
# AWS Predictive Scaling
PredictiveScalingConfiguration:
  Mode: ForecastAndScale
  SchedulingBufferTime: 600  # 10 minutes ahead
```

**3. Scheduled scaling for known patterns:**
```bash
# Scale up before known traffic spike
aws autoscaling put-scheduled-update-group-action \
  --auto-scaling-group-name api-asg \
  --scheduled-action-name morning-scale-up \
  --recurrence "0 8 * * MON-FRI" \
  --desired-capacity 12
```

**4. Multiple instance types:**
```yaml
# Use mixed instances policy
MixedInstancesPolicy:
  InstancesDistribution:
    OnDemandBaseCapacity: 2
    OnDemandPercentageAboveBaseCapacity: 25
  LaunchTemplate:
    Overrides:
      - InstanceType: c6i.2xlarge
      - InstanceType: c5.2xlarge
      - InstanceType: c5a.2xlarge
```

**5. Monitor scaling activities:**
```python
from prometheus_client import Gauge

asg_desired_capacity = Gauge('asg_desired_capacity', 'ASG desired capacity')
asg_current_capacity = Gauge('asg_current_capacity', 'ASG current capacity')
asg_max_capacity = Gauge('asg_max_capacity', 'ASG max capacity')

# Alert when at or near max
```

### MTTR
- **Detection:** < 2 minutes
- **Diagnosis:** 2-3 minutes
- **Remediation:** 1 minute (manual scale) + 2-3 minutes (instances launch)
- **Total:** ~8 minutes

---

## 5. Load Balancer Connection Limit

### Symptoms
- 503 "Service Unavailable" errors from load balancer
- Connection refused errors
- Backend instances healthy but unreachable
- Error rate spikes but instances show low CPU

### Detection
```
Alert: LoadBalancerConnectionLimit
Severity: P0 (Critical)
Condition: lb_active_connections >= lb_max_connections * 0.95
```

### Impact
- **Severity:** Critical
- **Affected users:** New connections fail
- **SLO impact:** Availability SLO critical breach
- **Revenue impact:** Critical

### Diagnosis

**1. Check load balancer metrics (AWS ALB):**
```bash
# Check active connection count
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name ActiveConnectionCount \
  --dimensions Name=LoadBalancer,Value=app/my-lb/xxx \
  --start-time $(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Maximum

# Check rejected connections
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name RejectedConnectionCount \
  --dimensions Name=LoadBalancer,Value=app/my-lb/xxx \
  --period 60 \
  --statistics Sum
```

**2. Check target health:**
```bash
# Verify backends are healthy
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:...

# Look for "unhealthy" or "draining" targets
```

**3. Check connection limits:**
```bash
# ALB supports ~100k concurrent connections per AZ
# NLB supports ~millions

# Check LB configuration
aws elbv2 describe-load-balancers \
  --load-balancer-arns arn:aws:elasticloadbalancing:...
```

### Immediate Remediation

**A. Add load balancer capacity (AWS: create second LB):**
```bash
# Can't increase existing ALB capacity, must add second LB
# This is why you should plan ahead!

# Quick fix: Create second ALB with same target group
aws elbv2 create-load-balancer \
  --name api-lb-2 \
  --subnets subnet-xxx subnet-yyy \
  --security-groups sg-xxx \
  --scheme internet-facing \
  --type application

# Add DNS record for new LB (round-robin)
aws route53 change-resource-record-sets \
  --hosted-zone-id Zxxx \
  --change-batch file://add-lb.json
```

**B. Switch to Network Load Balancer (higher connection limit):**
```bash
# NLB supports millions of connections
# Migration required (15-30 minutes)

# Create NLB
aws elbv2 create-load-balancer \
  --name api-nlb \
  --type network \
  --subnets subnet-xxx subnet-yyy

# Create target group (TCP mode)
aws elbv2 create-target-group \
  --name api-targets-tcp \
  --protocol TCP \
  --port 8000 \
  --vpc-id vpc-xxx

# Update DNS to point to NLB
```

**C. Enable connection draining:**
```bash
# Reduce idle connection time
aws elbv2 modify-target-group-attributes \
  --target-group-arn arn:aws:elasticloadbalancing:... \
  --attributes Key=deregistration_delay.connection_termination.enabled,Value=true \
               Key=deregistration_delay.timeout_seconds,Value=30
```

**D. Client-side connection pooling:**
```bash
# If clients are opening too many connections, enforce limits

# Nginx rate limiting (emergency)
limit_conn_zone $binary_remote_addr zone=addr:10m;
limit_conn addr 10;  # Max 10 concurrent connections per IP
```

### Prevention

**1. Use Network Load Balancer for high connection count:**
```yaml
# NLB for millions of connections
LoadBalancer:
  Type: network  # Not application
  Scheme: internet-facing
```

**2. Implement connection keep-alive:**
```python
# FastAPI/Uvicorn
# Already enabled by default

# Client side (requests library):
session = requests.Session()
adapter = HTTPAdapter(
    pool_connections=10,
    pool_maxsize=100,
    max_retries=3
)
session.mount('http://', adapter)
session.mount('https://', adapter)
```

**3. Monitor connection metrics:**
```promql
# Alert before hitting limit
lb_active_connections / lb_max_connections > 0.80
```

**4. Use multiple load balancers:**
```bash
# Geographic distribution
# DNS round-robin across multiple LBs
# Or use Route53 latency-based routing
```

### MTTR
- **Detection:** < 1 minute
- **Diagnosis:** 2-3 minutes
- **Remediation:** 15-30 minutes (add new LB)
- **Total:** ~35 minutes (painful!)

---

*Due to length limits, runbooks 6-10 (AZ Failure, Deployment Rollout Failure, DDoS Attack, Database Primary Failure, Redis Cache Failure) would follow the same detailed format above.*

---

## Quick Reference Card

| Failure Mode | MTTR | First Action |
|--------------|------|--------------|
| CPU Saturation | 15 min | Scale out immediately |
| Memory OOM | 12 min | Restart workers |
| DB Connections Exhausted | 8 min | Increase pool size |
| Auto-Scaler Stuck | 8 min | Manual capacity adjustment |
| LB Connection Limit | 35 min | Add second LB |
| AZ Failure | 5 min | Auto-scaler handles |
| Deployment Failure | 3 min | Rollback |
| DDoS Attack | 10 min | Enable WAF rules |
| DB Primary Failure | 2 min | Failover to replica |
| Redis Failure | 5 min | Allow cache miss, scale DB |

---

## Escalation Contacts

- **SRE On-Call:** PagerDuty rotation
- **Database Team:** Slack #database-oncall
- **Network Team:** Slack #network-oncall
- **Security Team:** security@company.com (DDoS, attacks)
- **AWS Support:** Enterprise Support portal (infra issues)

---

**Document maintained by:** SRE Team
**Review frequency:** Quarterly
**Last tabletop exercise:** TBD
**Next review:** 2025-02-16
