# Capacity Planning Formulas & Calculator

This document provides detailed mathematical models and worked examples for capacity planning across all RPS targets and technology stacks.

## Table of Contents

1. [Core Formulas](#core-formulas)
2. [FastAPI-Only Calculations](#fastapi-only-calculations)
3. [FastAPI + PostgreSQL Calculations](#fastapi--postgresql-calculations)
4. [FastAPI + PostgreSQL + Redis Calculations](#fastapi--postgresql--redis-calculations)
5. [Full Stack Calculations](#full-stack-calculations)
6. [Cost Estimation](#cost-estimation)
7. [Network Capacity](#network-capacity)
8. [Storage Capacity](#storage-capacity)

---

## Core Formulas

### 1. Required Instance Count

```
Required Instances = ceiling((Target RPS / RPS per Instance) * Safety Factor)

where:
  Target RPS           = Desired throughput (requests/second)
  RPS per Instance     = Measured or calculated capacity per instance
  Safety Factor        = Headroom multiplier (typically 1.5 for 50% buffer)
  ceiling()            = Round up to nearest integer
```

**Example: 10,000 RPS target**
```
Target RPS = 10,000
RPS per Instance = 1,250 (from load testing)
Safety Factor = 1.5

Required Instances = ceiling((10,000 / 1,250) * 1.5)
                  = ceiling(8 * 1.5)
                  = ceiling(12)
                  = 12 instances

Recommendation:
  Min: 6  (handles 7,500 RPS)
  Desired: 8  (handles 10,000 RPS)
  Max: 12  (handles 15,000 RPS)
```

---

### 2. CPU Utilization

```
CPU Utilization = (RPS * CPU Time per Request) / (Cores * Worker Efficiency)

where:
  RPS                  = Requests per second
  CPU Time per Request = Seconds of CPU work per request
  Cores                = Number of CPU cores available
  Worker Efficiency    = Effective utilization (0.7-0.9 typically)
```

**Example: 1,000 RPS on 16-core instance**
```
RPS = 1,000
CPU Time per Request = 0.003s (3ms)
Cores = 16
Worker Efficiency = 0.85

CPU Utilization = (1,000 * 0.003) / (16 * 0.85)
                = 3 / 13.6
                = 0.22
                = 22%

Conclusion: System has 78% CPU headroom
```

---

### 3. Maximum Theoretical RPS

```
Max RPS = (Cores * Worker Efficiency) / CPU Time per Request

This gives the theoretical maximum before CPU saturation.
```

**Example: 16-core instance**
```
Cores = 16
Worker Efficiency = 0.85
CPU Time per Request = 0.003s

Max RPS = (16 * 0.85) / 0.003
        = 13.6 / 0.003
        = 4,533 RPS

Safe Operating Point (60%): 2,720 RPS
Recommended Max (80%):      3,626 RPS
```

---

### 4. Memory Requirements

```
Total Memory = (Workers * Memory per Worker) + OS Overhead

Memory per Worker = Base App Memory + (Concurrent Requests * Memory per Request)

where:
  Workers              = Number of worker processes
  Base App Memory      = Memory for application code + libraries
  Concurrent Requests  = Active requests per worker
  Memory per Request   = Memory for request/response buffers
  OS Overhead          = Operating system + auxiliary processes
```

**Example: 16 workers handling 1,000 RPS**
```
Workers = 16
Base App Memory = 200 MB
Concurrent Requests per Worker = 50
Memory per Request = 0.5 MB
OS Overhead = 1,000 MB

Memory per Worker = 200 + (50 * 0.5)
                  = 200 + 25
                  = 225 MB

Total Memory = (16 * 225) + 1000
             = 3,600 + 1,000
             = 4,600 MB
             ≈ 4.6 GB

Recommended RAM: 16-32 GB (3.5x - 7x headroom)
```

---

### 5. Network Bandwidth

```
Bandwidth (Mbps) = RPS * (Avg Request Size + Avg Response Size) * 8 / 1,000,000

where:
  RPS              = Requests per second
  Sizes in bytes
  * 8              = Convert bytes to bits
  / 1,000,000      = Convert to Mbps
```

**Example: 10,000 RPS with 1 KB requests, 2 KB responses**
```
RPS = 10,000
Avg Request Size = 1,000 bytes
Avg Response Size = 2,000 bytes

Bandwidth = 10,000 * (1,000 + 2,000) * 8 / 1,000,000
          = 10,000 * 3,000 * 8 / 1,000,000
          = 240,000,000 / 1,000,000
          = 240 Mbps

Per instance (8 instances):
  Bandwidth per Instance = 240 / 8 = 30 Mbps

Network egress per month:
  Bandwidth in MB/s = 240 / 8 = 30 MB/s
  Monthly = 30 MB/s * 86,400 sec/day * 30 days / 1,024
  Monthly = 777.6 GB
```

---

### 6. Connection Pool Sizing

```
Pool Size = (Expected RPS / Workers) * Avg Query Time * Safety Factor

where:
  Expected RPS     = Peak RPS to database
  Workers          = Number of application workers
  Avg Query Time   = Average database query duration (seconds)
  Safety Factor    = Buffer (1.5-2.0)
```

**Example: 5,000 RPS to PostgreSQL**
```
Expected RPS = 5,000 (50% of total 10,000 hit DB)
Workers = 16
Avg Query Time = 0.005s (5ms)
Safety Factor = 2.0

Pool Size per Worker = (5,000 / 16) * 0.005 * 2.0
                     = 312.5 * 0.005 * 2.0
                     = 3.125

Pool Size per Worker = 5 connections (rounded up)
Total Pool Size = 16 * 5 = 80 connections

With PgBouncer (transaction pooling):
  Application Pools = 80
  PgBouncer Pool to DB = 20-40 (4:1 to 2:1 ratio)
```

---

## FastAPI-Only Calculations

### 100 RPS Baseline

**Given:**
- Target RPS: 100
- Avg CPU time per request: 3ms
- Avg request size: 1 KB
- Avg response size: 2 KB

**Instance Sizing:**
```
Workers = 4 (match typical 4-core instance)

CPU Utilization = (100 * 0.003) / (4 * 0.8)
                = 0.3 / 3.2
                = 0.09375
                = 9.4%

Memory per Worker = 150 MB + (25 * 0.5 MB)
                  = 150 + 12.5
                  = 162.5 MB

Total Memory = (4 * 162.5) + 500
             = 650 + 500
             = 1,150 MB

Recommended Instance: 4 vCPU, 16 GB RAM
Cost: ~$50/month (t3.xlarge reserved)
```

### 1,000 RPS (1k)

**Given:**
- Target RPS: 1,000
- Same CPU/request profile

**Option A: Vertical Scaling**
```
Workers = 16
Cores = 16

CPU Utilization = (1,000 * 0.003) / (16 * 0.85)
                = 3 / 13.6
                = 22%

Memory = (16 * 225 MB) + 1,000 MB
       = 4.6 GB

Recommended Instance: 16 vCPU, 32 GB RAM (c6i.4xlarge)
Cost: ~$160/month (1 instance, reserved)
```

**Option B: Horizontal Scaling**
```
Instance Count = ceiling(1,000 / 500)
               = 2 instances

Per Instance:
  Workers = 8
  CPU = 8 vCPU
  RAM = 16 GB

Cost: ~$200/month (2 × c6i.2xlarge + ALB)
Benefit: High availability, easier scaling
```

### 10,000 RPS (10k)

**Required Instances:**
```
RPS per Instance = 1,250 (from load testing)
Safety Factor = 1.5

Instances = ceiling((10,000 / 1,250) * 1.5)
          = ceiling(12)
          = 12 instances (max)

Recommended:
  Min: 6
  Desired: 8
  Max: 12

Per Instance:
  Type: c6i.2xlarge
  vCPU: 8
  RAM: 16 GB
  Workers: 8

Total Cost: ~$1,000/month
  Compute: $65 × 8 = $520 (reserved)
  Load Balancer: $46
  Network: $70
  Other: $50
```

### 100,000 RPS (100k)

**Required Instances:**
```
RPS per Instance = 1,250
Safety Factor = 1.5

Instances = ceiling((100,000 / 1,250) * 1.5)
          = ceiling(120)
          = 120 instances (max)

Recommended:
  Min: 60
  Desired: 80
  Max: 120

Instance Type: c6i.2xlarge

Total Cost: ~$15,000/month
  Compute: $65 × 80 = $5,200
  Load Balancers (3): $150
  Network egress (8 TB): $720
  CloudWatch: $100
  Data transfer: $500
  Misc: $500
```

### 1,000,000 RPS (1M)

**Required Instances:**
```
RPS per Instance = 1,250
Safety Factor = 1.5

Instances = ceiling((1,000,000 / 1,250) * 1.5)
          = ceiling(1,200)
          = 1,200 instances (max)

Recommended:
  Min: 600
  Desired: 800
  Max: 1,200

Multi-region deployment required:
  Region 1: 400 instances (40%)
  Region 2: 400 instances (40%)
  Region 3: 200 instances (20%)

Per Region Infrastructure:
  - Multiple load balancers (NLB preferred)
  - Auto-scaling groups across 3 AZs
  - CDN (CloudFront/Cloudflare) for edge caching

Total Cost: ~$150,000/month
  Compute: $52,000
  Load Balancing: $2,000
  Network: $15,000
  CDN: $10,000
  Multi-region data transfer: $20,000
  Monitoring: $1,000
  Storage (logs, metrics): $5,000
  Misc: $5,000
```

---

## FastAPI + PostgreSQL Calculations

### Additional Considerations

**Database Connection Math:**
```
Max Connections per Worker = Pool Size per Worker
Total App Connections = Workers × Pool Size
Database Max Connections = Total App Connections × Instance Count

With PgBouncer:
  Database Connections = (Total App Connections / Pooling Ratio)
  Pooling Ratio = 4-10 (transaction pooling)
```

### 1,000 RPS with PostgreSQL

**Assumptions:**
- 60% of requests hit database
- Avg query time: 3ms
- Read/write ratio: 80/20

**Database RPS:**
```
DB RPS = Total RPS * DB Hit Rate
       = 1,000 * 0.60
       = 600 queries per second
```

**Connection Pool Sizing:**
```
API Instances = 2
Workers per Instance = 8
Total Workers = 16

Pool per Worker = ceiling((600 / 16) * 0.003 * 2.0)
                = ceiling(37.5 * 0.003 * 2.0)
                = ceiling(0.225)
                = 5 connections

Total Connections = 16 * 5 = 80

With PgBouncer (4:1 pooling):
  PgBouncer → PostgreSQL = 80 / 4 = 20 connections
```

**PostgreSQL Instance:**
```
Type: db.r6i.xlarge (4 vCPU, 32 GB RAM)
IOPS: 12,000 (provisioned)
Storage: 500 GB SSD

max_connections = 200
shared_buffers = 8 GB
effective_cache_size = 24 GB
work_mem = 64 MB

Cost: ~$400/month (reserved, Multi-AZ)
```

**Total Cost (1k RPS with PostgreSQL):**
```
API Servers (2 × c6i.2xlarge): $130
PostgreSQL (db.r6i.xlarge): $400
PgBouncer (t3.small): $15
Load Balancer: $20
Network: $20
Total: ~$585/month
```

### 10,000 RPS with PostgreSQL

**Database RPS:**
```
DB RPS = 10,000 * 0.60 = 6,000 QPS
```

**PostgreSQL Sizing:**
```
Primary: db.r6i.2xlarge (8 vCPU, 64 GB RAM)
  IOPS: 16,000
  Storage: 1 TB

Read Replicas: 2 × db.r6i.xlarge
  For read-heavy queries (80% reads)

Total DB Capacity:
  Primary handles: 2,000 writes/sec
  Replicas handle: 4,000 reads/sec (2,000 each)

Connection Pool:
  API Workers = 64 (8 instances × 8 workers)
  Pool per Worker = 5
  Total = 320 connections

  With PgBouncer:
    To Primary: 40 connections
    To Each Replica: 40 connections
    Total DB connections: 120
```

**Cost:**
```
Primary (db.r6i.2xlarge): $800/month
Replicas (2 × db.r6i.xlarge): $400 each = $800
PgBouncer (t3.medium): $30
Storage (1 TB × 3): $345
Backups: $100
Total DB: ~$2,075/month

Total Stack:
  API (8 × c6i.2xlarge): $520
  Database: $2,075
  Load Balancer: $50
  Network: $100
  Total: ~$2,745/month
```

---

## FastAPI + PostgreSQL + Redis Calculations

### Redis Capacity Planning

**Cache hit rate formula:**
```
Effective DB RPS = Total RPS * DB Hit Rate * (1 - Cache Hit Rate)

where:
  DB Hit Rate = % of requests that would hit DB without cache
  Cache Hit Rate = % of DB requests served by cache
```

**Example: 10,000 RPS with 80% cache hit rate**
```
Total RPS = 10,000
DB Hit Rate = 60% (without cache)
Cache Hit Rate = 80%

Redis RPS = 10,000 * 0.60 = 6,000
DB RPS = 6,000 * (1 - 0.80) = 1,200

Result:
  - Redis handles 6,000 queries/sec
  - PostgreSQL handles only 1,200 queries/sec (5x reduction!)
```

### Redis Cluster Sizing (10k RPS)

**Memory Requirements:**
```
Cache Entry Size = Key Size + Value Size + Overhead
                 = 50 bytes + 500 bytes + 100 bytes
                 = 650 bytes per entry

Cache Entries = Working Set Size
              = Unique queries in N minutes * Avg Result Size

Example (10-minute working set):
  Unique Queries = 100,000 (in 10 minutes)
  Avg Value Size = 650 bytes

  Memory Required = 100,000 * 650
                  = 65,000,000 bytes
                  = 65 MB (working set)

  With fragmentation & overhead (2x):
    Memory = 65 MB * 2 = 130 MB

  With safety buffer (3x total):
    Memory = 65 MB * 3 = 195 MB

Recommended: 2 GB per node (10x headroom)
```

**Redis Cluster Configuration:**
```
Nodes: 3 (for quorum in cluster mode)
Type: cache.r6g.large (2 vCPU, 13 GB RAM)

Cost per node: $120/month (reserved)
Total Redis: 3 × $120 = $360/month

Configuration:
  maxmemory-policy: allkeys-lru
  maxmemory: 10gb (leave 3 GB for overhead)
  cluster-enabled: yes
  cluster-node-timeout: 5000
```

**Total Cost (10k RPS with Redis):**
```
API Servers: $520
PostgreSQL: $2,075
Redis Cluster: $360
Load Balancers: $50
Network: $150
Total: ~$3,155/month
```

---

## Full Stack Calculations (+ RabbitMQ)

### RabbitMQ Capacity Planning

**Queue throughput:**
```
Messages per Second = Publish Rate = Consume Rate (at steady state)

Queue Depth = (Publish Rate - Consume Rate) * Time

Ideal: Publish Rate ≈ Consume Rate (queue depth near 0)
```

**Example: 3,000 messages/sec**
```
Publish Rate = 3,000 msg/sec (30% of 10k RPS)
Consume Rate = 3,000 msg/sec (balanced)

Message Size = 1 KB avg
Throughput = 3,000 * 1 KB = 3 MB/sec = 259 GB/day

Storage (1-day retention):
  Storage = 259 GB/day * 1 day = 259 GB
  With safety: 500 GB disk
```

### RabbitMQ Cluster (10k RPS)

**Configuration:**
```
Nodes: 3 (HA cluster)
Type: c6i.xlarge (4 vCPU, 8 GB RAM)

Per Node:
  Max Connections: 10,000
  Max Channels: 50,000
  Max Messages/sec: 10,000-20,000

Cluster Total:
  Throughput: 30,000 msg/sec (10x headroom)
  Storage: 500 GB per node (mirrored)

Cost: 3 × $80 = $240/month (reserved)
```

**Total Cost (Full Stack, 10k RPS):**
```
API Servers (8): $520
PostgreSQL: $2,075
Redis (3): $360
RabbitMQ (3): $240
Load Balancers: $50
Network: $200
Total: ~$3,445/month
```

---

## Cost Estimation Formulas

### Per-Request Cost

```
Cost per Million Requests = (Monthly Cost / Monthly Requests) * 1,000,000

where:
  Monthly Cost = Total infrastructure cost
  Monthly Requests = RPS * 86,400 sec/day * 30 days
```

**Example: 10k RPS**
```
Monthly Cost = $3,445
RPS = 10,000
Monthly Requests = 10,000 * 86,400 * 30
                 = 25,920,000,000
                 = 25.92 billion requests

Cost per Million = ($3,445 / 25,920) * 1,000
                 = $0.133 per million requests
                 = $0.000133 per thousand requests
```

### ROI Break-Even

```
Break-Even Requests = Development Cost / Cost Savings per Request

where:
  Development Cost = Engineer time + infra setup
  Cost Savings = Cost difference between implementations
```

---

## Network Capacity

### Egress Cost Calculation

```
Monthly Egress = RPS * Response Size * 86,400 * 30 / (1024^3)

Cost = Monthly Egress (GB) * Cost per GB
```

**Example: 10k RPS, 2 KB responses**
```
Monthly Egress = 10,000 * 2,000 * 86,400 * 30 / (1024^3)
               = 51,840,000,000,000 / 1,073,741,824
               = 48,279 GB
               ≈ 48 TB

Cost (AWS):
  First 10 TB: 10,000 × $0.09 = $900
  Next 40 TB: 40,000 × $0.085 = $3,400
  Total: $4,300/month (egress only!)

Optimization:
  - Add CloudFront CDN: $0.02-0.05/GB = $960-2,400
  - 50% reduction in origin egress
  - New cost: ~$1,500-2,000/month
```

---

## Storage Capacity

### Log Storage

```
Log Size = RPS * Log Entry Size * 86,400 * Retention Days

where:
  RPS = Requests per second
  Log Entry Size = Bytes per log line (typically 200-500 bytes)
  Retention Days = How long to keep logs
```

**Example: 10k RPS, 30-day retention**
```
Log Entry Size = 300 bytes
Retention = 30 days

Log Size = 10,000 * 300 * 86,400 * 30 / (1024^3)
         = 7,776,000,000,000 / 1,073,741,824
         = 7,243 GB
         ≈ 7.2 TB

Cost (S3):
  Standard: 7,200 × $0.023 = $165/month
  Infrequent Access (after 7 days): ~$100/month
```

---

## Quick Reference Table

| RPS Target | Instances | DB | Redis | Queue | Monthly Cost |
|------------|-----------|----|----- |-------|--------------|
| 100        | 1 small   | -  | -     | -     | $50          |
| 1,000      | 2 medium  | 1  | 1     | 1     | $600         |
| 10,000     | 8 medium  | 3  | 3     | 3     | $3,500       |
| 100,000    | 80 medium | 10 | 6     | 5     | $45,000      |
| 1,000,000  | 800 medium| 30 | 20    | 10    | $450,000     |

---

**Last Updated:** 2025-11-16
**Version:** 1.0
**Validated:** ⏳ Pending load test results
