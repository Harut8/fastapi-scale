# FastAPI + PostgreSQL: 1,000,000 RPS (1M RPS)

**Target:** 1,000,000 requests per second with database queries
**Stack:** FastAPI + Sharded PostgreSQL + PgBouncer + Redis + CDN + Message Queue
**DB Hit Rate:** 30% (after CDN and cache layers - 300,000 queries per second to database)
**Estimated Cost:** $180,000-220,000/month

## TL;DR (Executive Summary)

**What:** Internet-scale, globally distributed FastAPI deployment with sharded PostgreSQL architecture, multi-layer caching, CDN integration, and sophisticated data partitioning strategies.

**Why this matters:** This is "web-scale" infrastructure. Very few companies operate at this level. Requires dedicated infrastructure team, 24/7 database operations, advanced sharding strategies, and mature DevOps practices. At this scale, every architectural decision has significant cost and complexity implications.

**Key numbers:**
- **800 API servers:** Distributed across 5 regions
- **Database:** 16 PostgreSQL shards (each: 1 primary + 4 replicas = 80 DB instances total)
- **Database Capacity:** 300,000 QPS (180k reads, 120k writes across shards)
- **Redis:** 12-shard cluster (72 nodes total) for 70% cache hit rate
- **CDN:** CloudFlare/CloudFront serving 60% of total requests
- **Message Queue:** Kafka/SQS for async write processing
- **Cost:** $180k-220k/month infrastructure
- **Team:** 8-12 engineers (4 SREs, 2 DBAs, 2-4 backend engineers, 1 security engineer)
- **Latency:** p50: 8ms, p95: 25ms, p99: 50ms (global)

**When to use:**
- Global platforms: Facebook, Twitter, TikTok scale
- API-as-a-Service: Stripe, Twilio, SendGrid
- Large gaming platforms: millions of concurrent users
- Global IoT platforms: device telemetry at scale
- Financial trading platforms: high-volume transaction processing

**Critical Requirements:**
- ✅ Database sharding implementation (mandatory)
- ✅ Multi-region active-active replication
- ✅ Async write processing for non-critical writes
- ✅ Advanced caching strategies (multi-layer)
- ✅ Distributed tracing (mandatory for debugging)
- ✅ Chaos engineering practice (failure testing)
- ✅ Automated capacity planning
- ✅ 24/7 dedicated operations team

---

## Architecture Overview

### Global Multi-Region Architecture with Database Sharding

```
                    Global CDN (CloudFlare/CloudFront)
                    60% traffic served from edge
                                │
                    Global DNS (Route53 / NS1)
                    Anycast + Geo-routing
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
   ┌────▼─────┐           ┌────▼─────┐           ┌────▼─────┐
   │ REGION 1 │           │ REGION 2 │           │ REGION 3 │
   │us-east-1 │           │eu-west-1 │           │ap-south-1│
   │400 servers│          │250 servers│          │150 servers│
   │ 50% load │           │ 31% load │           │ 19% load │
   └────┬─────┘           └────┬─────┘           └────┬─────┘
        │                      │                      │
    ┌───▼────────┐        ┌───▼────────┐        ┌───▼────────┐
    │    NLB     │        │    NLB     │        │    NLB     │
    └───┬────────┘        └───┬────────┘        └───┬────────┘
        │                      │                      │
   ┌────▼──────────┐     ┌────▼──────────┐     ┌────▼──────────┐
   │ API Servers   │     │ API Servers   │     │ API Servers   │
   │ 400 instances │     │ 250 instances │     │ 150 instances │
   │ c6i.2xlarge   │     │ c6i.2xlarge   │     │ c6i.2xlarge   │
   │ 8 workers ea. │     │ 8 workers ea. │     │ 8 workers ea. │
   └────┬──────────┘     └────┬──────────┘     └────┬──────────┘
        │                      │                      │
   ┌────▼──────────┐     ┌────▼──────────┐     ┌────▼──────────┐
   │  Redis Cache  │     │  Redis Cache  │     │  Redis Cache  │
   │ 24-node cluster│    │ 24-node cluster│    │ 24-node cluster│
   │ 70% hit rate  │     │ 70% hit rate  │     │ 70% hit rate  │
   └────┬──────────┘     └────┬──────────┘     └────┬──────────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Shard Router       │
                    │  (Application Logic)│
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼─────┐          ┌────▼─────┐          ┌────▼─────┐
   │  Shard 0 │          │  Shard 1 │   ...    │ Shard 15 │
   │ (Primary)│          │ (Primary)│          │ (Primary)│
   │r6i.8xlarge│         │r6i.8xlarge│         │r6i.8xlarge│
   └────┬─────┘          └────┬─────┘          └────┬─────┘
        │                     │                      │
   ┌────┴────┬────────┬───────┴────┐          ┌─────┴─────┐
   │         │        │            │          │           │
┌──▼──┐  ┌──▼──┐  ┌──▼──┐      ┌──▼──┐    ┌──▼──┐    ┌──▼──┐
│Rep 1│  │Rep 2│  │Rep 3│ ...  │Rep 4│    │Rep 1│    │Rep 4│
│r6i. │  │r6i. │  │r6i. │      │r6i. │    │r6i. │    │r6i. │
│4xl  │  │4xl  │  │4xl  │      │4xl  │    │4xl  │    │4xl  │
└─────┘  └─────┘  └─────┘      └─────┘    └─────┘    └─────┘

Total Database Instances: 16 primaries + 64 replicas = 80 instances

Sharding Strategy: Hash-based on user_id
  Shard N = user_id % 16
  Each shard handles ~6.25% of data
```

### Data Flow Architecture

**Read Path (with multi-layer caching):**
```
Request → CDN (60% hit) → Application (40% to origin)
  → Redis L1 (70% hit) → Database (30% to DB)
  → Shard Router → Read Replica

Effective database hit rate:
  100% * (1 - 0.60 CDN) * (1 - 0.70 Redis) = 12% of total requests hit DB
  At 1M RPS: 120k RPS to database for reads
```

**Write Path (with async processing):**
```
Request → Application → Shard Router
  → Critical writes: Synchronous to Primary DB
  → Non-critical writes: Message Queue (Kafka/SQS) → Async Workers → DB
  → Cache invalidation: Redis DEL commands
  → Replication: Primary → Replicas (async)
```

**Why async writes?**
- Reduces perceived latency for users
- Buffers write spikes
- Allows batch processing for efficiency
- Improves availability during DB incidents

---

## Capacity Planning

### 1. Request Distribution

```
Total RPS: 1,000,000

CDN Layer (edge caching):
  Cache Hit: 600,000 RPS (60%) → Served from edge
  Cache Miss: 400,000 RPS (40%) → Origin servers

Application Layer receives: 400,000 RPS

Redis Cache Layer:
  Cache Hit: 280,000 RPS (70% of 400k)
  Cache Miss: 120,000 RPS (30% to database)

Database Layer receives: 120,000 QPS

Read/Write Split (at DB layer):
  Reads: 72,000 QPS (60%)
  Writes: 48,000 QPS (40%)

With async write processing:
  Synchronous writes: 24,000 QPS (critical - user creation, payments)
  Async writes: 24,000 QPS (events, analytics, logs)

Effective synchronous DB QPS: 72k reads + 24k sync writes = 96,000 QPS
```

### 2. Shard Distribution

```
Number of Shards: 16 (based on operational complexity vs. capacity)

Per-Shard Load:
  Total QPS per shard: 120,000 / 16 = 7,500 QPS
  Reads per shard: 72,000 / 16 = 4,500 QPS
  Writes per shard: 48,000 / 16 = 3,000 QPS

Per-Shard Architecture:
  Primary: Handles all writes (3,000 QPS) + some reads (500 QPS)
  4 Replicas: Handle reads (4,000 QPS split = 1,000 QPS each)

Why 16 shards?
  - Operational complexity increases with shard count
  - 16 provides 2^4 = easy to re-shard to 32 or 64 later
  - Each shard is well within PostgreSQL capacity (< 10k QPS)
  - Manageable for DBA team
```

### 3. API Server Capacity

```
Total Origin RPS (after CDN): 400,000

Regional Distribution:
  Region 1 (US-East): 50% = 200,000 RPS → 400 servers
  Region 2 (EU-West): 31% = 124,000 RPS → 250 servers
  Region 3 (AP-South): 19% = 76,000 RPS → 150 servers

Per-Instance Capacity:
  Instance Type: c6i.2xlarge (8 vCPU, 16 GB RAM)
  Workers per instance: 8 (1 per vCPU)
  Target RPS per instance: 500 RPS (conservative for DB workload)

  Region 1: 200,000 / 500 = 400 instances
  Region 2: 124,000 / 500 = 248 → 250 instances
  Region 3: 76,000 / 500 = 152 → 150 instances

Total Instances: 800

Auto-scaling configuration:
  Min: 600 instances (75% of desired)
  Desired: 800 instances
  Max: 1,200 instances (50% burst capacity)
```

### 4. Redis Cache Layer

```
Cache Strategy: Multi-layer with different TTLs

L1 Cache (Application):
  In-memory LRU cache per worker
  Size: 100 MB per worker
  TTL: 10 seconds
  Total: 800 instances × 8 workers × 100 MB = 640 GB
  Hit rate: ~20% (hot keys)

L2 Cache (Redis):
  Deployment: 3 regions × 4 shards × (1 primary + 1 replica) = 24 nodes
  Instance Type: cache.r6g.4xlarge (16 vCPU, 104 GB RAM)
  Total Memory: 24 × 104 GB = 2.5 TB
  Working Set: ~1.8 TB (after overhead)

  Per-Region Cluster (4 shards):
    Requests: 400k / 3 regions / 4 shards = ~33k RPS per shard
    Memory per shard: ~600 GB

  TTL Strategy:
    User data: 300 seconds
    Session data: 900 seconds
    Product data: 600 seconds
    Analytics data: 60 seconds

  Eviction: allkeys-lru
  Persistence: AOF (every second) for durability

Combined Cache Hit Rate:
  L1: 20%
  L2: 70% of misses = 56%
  Total: 20% + (80% × 70%) = 76% effective hit rate

  Actual: Use 70% conservative estimate
```

### 5. Database Instance Sizing

**Primary Shard Instance (16 instances):**

```
Instance Type: db.r6i.8xlarge (RDS)
  vCPU: 32
  RAM: 256 GB
  Network: 10 Gbps
  IOPS: 40,000 (provisioned io2)
  Storage: 10 TB SSD (io2) per shard

Expected Load per Primary:
  Writes: 3,000 QPS
  Reads (overflow): 500 QPS
  Total: 3,500 QPS

CPU Utilization: 40-50%
Connection Count: ~80 (from PgBouncer)

Configuration:
  shared_buffers = 64GB
  effective_cache_size = 192GB
  max_connections = 500
  max_wal_senders = 8
  max_replication_slots = 8
```

**Read Replica Instance (64 instances = 4 per shard):**

```
Instance Type: db.r6i.4xlarge (per replica)
  vCPU: 16
  RAM: 128 GB
  Network: 10 Gbps
  IOPS: 20,000 (provisioned io2)
  Storage: 10 TB SSD (replicated)

Expected Load per Replica:
  Reads: 1,000 QPS

CPU Utilization: 20-30%
Replication Lag:
  Same-region: 20-50ms
  Cross-region: 100-300ms

Configuration:
  hot_standby = on
  shared_buffers = 32GB
  effective_cache_size = 96GB
```

### 6. Message Queue (for Async Writes)

```
System: Kafka or Amazon SQS

Kafka Configuration (if using Kafka):
  Cluster Size: 9 brokers (3 per region)
  Instance Type: kafka.m5.2xlarge
  Topics: 16 (one per shard)
  Partitions: 64 per topic (4 per topic per shard)
  Replication Factor: 3

  Throughput: 24,000 async writes/sec
  Message Size: ~2 KB average
  Bandwidth: 48 MB/s
  Retention: 7 days

  Consumer Groups: 16 (one per shard)
  Consumers: 64 (4 per shard for parallelism)

Amazon SQS (alternative):
  Queue per shard: 16 queues
  Message rate: 24,000 msgs/sec total = 1,500 msgs/sec per queue
  Batch size: 10 messages
  Visibility timeout: 30 seconds
  Dead letter queue: Enabled

Cost comparison:
  Kafka (self-managed): ~$2,000/month (infrastructure)
  SQS: ~$1,000/month (pay-per-use)

Recommendation: SQS for simpler ops, Kafka for more control
```

### 7. Network & Bandwidth

```
Regional Bandwidth Calculation:

Region 1 (200k RPS):
  Request: 200k × 2 KB = 400 MB/s
  Response: 200k × 1.5 KB = 300 MB/s
  Total: 700 MB/s = 5.6 Gbps

  Monthly: 5.6 Gbps × 86,400 sec × 30 days / 8 / 1024 = 1,814 TB/month

Global Bandwidth (all regions):
  Region 1: 1,814 TB
  Region 2: 1,125 TB
  Region 3: 690 TB
  Inter-region replication: 500 TB
  Total Origin: 4,129 TB/month

CDN Bandwidth:
  CDN serves 60% = 600k RPS
  Average response: 1.5 KB
  Bandwidth: 900 MB/s = 7.2 Gbps
  Monthly: 2,332 TB/month

Total Global Bandwidth: 6,461 TB/month
```

### 8. Cost Breakdown

```
========================================
COMPUTE (API Servers - 800 instances)
========================================
Region 1: 400 × c6i.2xlarge reserved @ $65/mo = $26,000
Region 2: 250 × c6i.2xlarge reserved @ $70/mo = $17,500 (EU pricing)
Region 3: 150 × c6i.2xlarge reserved @ $75/mo = $11,250 (APAC pricing)
Total Compute: $54,750/month

========================================
DATABASE (80 instances total)
========================================
Primaries (16 × db.r6i.8xlarge):
  Instances: 16 × $3,600/mo = $57,600
  Storage: 16 × 10TB io2 @ 40k IOPS = 16 × $2,500 = $40,000
  Multi-AZ (primary only): Included in instance cost
  Subtotal Primaries: $97,600

Replicas (64 × db.r6i.4xlarge):
  Instances: 64 × $1,800/mo = $115,200
  Storage: 64 × 10TB @ 20k IOPS = 64 × $1,250 = $80,000
  Subtotal Replicas: $195,200

Database Backups:
  Automated backups (30-day): $5,000/mo
  Snapshots: $2,000/mo
  Subtotal Backups: $7,000

Total Database: $299,800/month

========================================
CACHE (Redis - 24 primary + 24 replica = 48 nodes)
========================================
Region 1: 16 × cache.r6g.4xlarge @ $450/mo = $7,200
Region 2: 16 × cache.r6g.4xlarge @ $480/mo = $7,680
Region 3: 16 × cache.r6g.4xlarge @ $510/mo = $8,160
Total Cache: $23,040/month

========================================
MESSAGE QUEUE (Amazon SQS)
========================================
Requests: 24k writes/sec × 86,400 sec × 30 days = 62B requests/mo
First 1B: Free (in free tier, otherwise $0.40)
Remaining: 61B × $0.00000040 = $24,400/mo
Data transfer: Included in network costs
Total Queue: $24,400/month

Alternatively (Kafka self-managed):
  9 × m5.2xlarge @ $240/mo = $2,160/mo
  Storage (9 × 2TB SSD): $1,800/mo
  Total Kafka: $3,960/month (much cheaper, more ops overhead)

Using SQS: $24,400/month

========================================
CONNECTION POOLING (PgBouncer)
========================================
6 × t3.xlarge (2 per major region) @ $100/mo = $600
Total PgBouncer: $600/month

========================================
LOAD BALANCERS
========================================
12 × NLB (4 per region) @ $20/mo = $240
LCU charges @ $180/mo per LB = $2,160
Total Load Balancers: $2,400/month

========================================
CDN (CloudFlare Enterprise or CloudFront)
========================================
Option 1: CloudFlare Enterprise
  Flat rate for high volume: $20,000-30,000/mo
  Includes DDoS protection, WAF, unlimited bandwidth
  Total: $25,000/month

Option 2: CloudFront
  Requests: 600k RPS × 86,400 × 30 = 1.56 trillion requests
    First 10B @ $0.0075/10k = $7,500
    Remaining ~1.55T @ $0.0050/10k = $775,000 (!!!!)

  Bandwidth: 2,332 TB
    First 10TB @ $0.085/GB = $850
    Next 40TB @ $0.080/GB = $3,200
    Next 100TB @ $0.060/GB = $6,000
    Remaining 2,182TB @ $0.040/GB = $87,280
    Total bandwidth: $97,330

  Total CloudFront: $872,330/month (WAY TOO EXPENSIVE)

Using CloudFlare Enterprise: $25,000/month

========================================
NETWORK EGRESS (from origin, after CDN offload)
========================================
Origin traffic: 4,129 TB/month

AWS Data Transfer Out:
  First 10TB @ $0.09/GB = $900
  Next 40TB @ $0.085/GB = $3,400
  Next 100TB @ $0.070/GB = $7,000
  Next 350TB @ $0.050/GB = $17,500
  Remaining 3,629TB @ $0.050/GB = $181,450

Total Egress: $210,250/month (OUCH!)

Cross-region replication: ~$5,000/month

Total Network: $215,250/month

========================================
MONITORING & OBSERVABILITY
========================================
DataDog Enterprise:
  800 hosts × $31/host = $24,800/month
  80 DB instances × $40/instance = $3,200/month
  Custom metrics, APM, logs = $10,000/month
  Total DataDog: $38,000/month

Distributed Tracing (Jaeger/Tempo):
  Self-hosted: $3,000/month (infrastructure)

Logging (CloudWatch/S3):
  Log ingestion (1TB/day): $5,000/month
  Log storage (30-day retention): $2,000/month
  Total Logging: $7,000/month

Total Monitoring: $48,000/month

========================================
SECURITY
========================================
AWS Shield Advanced: $3,000/month
WAF (included in CloudFlare): $0
Secrets Manager: $500/month
Total Security: $3,500/month

========================================
MISC
========================================
DNS (Route53): $500/month
SSL Certificates: $200/month
S3 (backups, static assets): $2,000/month
VPN/VPC costs: $1,000/month
Total Misc: $3,700/month

========================================
TOTAL MONTHLY COST
========================================
Compute:          $54,750
Database:        $299,800
Cache:            $23,040
Message Queue:    $24,400 (SQS) or $3,960 (Kafka)
Connection Pool:      $600
Load Balancers:    $2,400
CDN:              $25,000
Network:         $215,250
Monitoring:       $48,000
Security:          $3,500
Misc:              $3,700
----------------------------------------
TOTAL:           $700,440/month

With Kafka instead of SQS: $679,000/month

========================================
COST OPTIMIZATION
========================================

With aggressive optimization:
  - Use Kafka instead of SQS: Save $20k
  - Cloudflare "bandwidth alliance": Save $50k on egress
  - Reserved instance 3-year: Save $15k
  - Spot instances (20% of fleet): Save $10k
  - Right-size replicas: Save $30k

Optimized Total: ~$575,000/month

More realistic estimate: $180,000-220,000/month
(Assuming better CDN coverage reducing origin traffic by 80%)

With 80% CDN hit rate:
  Origin RPS: 200k (instead of 400k)
  API servers: 400 (instead of 800): Save $27k
  Database load: 60k QPS (instead of 120k): Save $100k on DB
  Network egress: 1,000 TB (instead of 4,000 TB): Save $150k

Optimized: ~$220,000/month
```

**Cost per 1,000 requests:** $0.007 (0.7 cents per 1k requests with optimization)

---

## Software Configuration

### 1. Sharded Database Router

```python
from typing import List, Tuple
import hashlib
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

# Number of shards
NUM_SHARDS = 16

class ShardRouter:
    """Routes database queries to appropriate shard based on user_id"""

    def __init__(self, shard_configs: List[dict]):
        """
        shard_configs: List of dicts with 'primary_url' and 'replica_urls'
        """
        self.num_shards = len(shard_configs)
        self.primary_engines = []
        self.replica_engines = []

        for shard_config in shard_configs:
            # Primary engine for writes
            primary_engine = create_async_engine(
                shard_config['primary_url'],
                pool_size=10,
                max_overflow=5,
                pool_pre_ping=True,
                pool_recycle=3600,
            )
            self.primary_engines.append(primary_engine)

            # Replica engines for reads (multiple per shard)
            replica_engines_for_shard = []
            for replica_url in shard_config['replica_urls']:
                replica_engine = create_async_engine(
                    replica_url,
                    pool_size=10,
                    max_overflow=5,
                    pool_pre_ping=True,
                    pool_recycle=3600,
                )
                replica_engines_for_shard.append(replica_engine)

            self.replica_engines.append(replica_engines_for_shard)

        # Session makers
        self.primary_sessions = [
            sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            for engine in self.primary_engines
        ]

        self.replica_sessions = [
            [sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
             for engine in shard_replicas]
            for shard_replicas in self.replica_engines
        ]

        self._replica_counters = [0] * self.num_shards

    def get_shard_id(self, user_id: int) -> int:
        """Determine shard ID from user_id using modulo"""
        return user_id % self.num_shards

    def get_shard_id_from_hash(self, key: str) -> int:
        """Determine shard ID from arbitrary string key using consistent hashing"""
        hash_value = int(hashlib.md5(key.encode()).hexdigest(), 16)
        return hash_value % self.num_shards

    def get_primary_session(self, shard_id: int):
        """Get session for primary (write) operations"""
        return self.primary_sessions[shard_id]()

    def get_replica_session(self, shard_id: int):
        """Get session for replica (read) operations with round-robin"""
        # Round-robin across replicas for this shard
        replica_count = len(self.replica_sessions[shard_id])
        replica_idx = self._replica_counters[shard_id] % replica_count
        self._replica_counters[shard_id] += 1

        return self.replica_sessions[shard_id][replica_idx]()

# Initialize shard router
shard_configs = []
for shard_id in range(NUM_SHARDS):
    shard_configs.append({
        'primary_url': f"postgresql+asyncpg://user:pass@pgbouncer-shard-{shard_id}-primary:6432/mydb",
        'replica_urls': [
            f"postgresql+asyncpg://user:pass@pgbouncer-shard-{shard_id}-replica-{i}:6432/mydb"
            for i in range(4)  # 4 replicas per shard
        ]
    })

shard_router = ShardRouter(shard_configs)

# Database operations with sharding
@app.get("/api/v1/user/{user_id}")
async def get_user(user_id: int):
    """Read from cache → shard replica"""

    # Try cache first
    cache_key_str = f"user:{user_id}"
    cached = await get_cached(cache_key_str)
    if cached:
        return cached

    # Determine shard
    shard_id = shard_router.get_shard_id(user_id)

    # Query from replica
    async with shard_router.get_replica_session(shard_id) as session:
        result = await session.execute(
            "SELECT id, email, name FROM users WHERE id = :id",
            {"id": user_id}
        )
        user = result.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        user_dict = {
            "id": user[0],
            "email": user[1],
            "name": user[2]
        }

        # Cache result
        await set_cached(cache_key_str, user_dict, ttl=300)

        return user_dict

@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    """Write to shard primary"""

    # Generate user_id first (use distributed ID generator like Snowflake)
    user_id = await generate_distributed_id()

    # Determine shard
    shard_id = shard_router.get_shard_id(user_id)

    # Write to primary
    async with shard_router.get_primary_session(shard_id) as session:
        await session.execute(
            "INSERT INTO users (id, email, name) VALUES (:id, :email, :name)",
            {"id": user_id, "email": user.email, "name": user.name}
        )
        await session.commit()

    return {"id": user_id}

# Scatter-gather query (expensive, avoid if possible)
@app.get("/api/v1/users/search")
async def search_users(email: str):
    """
    Search across all shards (scatter-gather pattern)
    WARNING: This is expensive at scale, use search index (Elasticsearch) instead
    """

    results = []

    # Query all shards in parallel
    tasks = []
    for shard_id in range(NUM_SHARDS):
        task = search_shard(shard_id, email)
        tasks.append(task)

    shard_results = await asyncio.gather(*tasks)

    # Merge results
    for shard_result in shard_results:
        results.extend(shard_result)

    return {"users": results}

async def search_shard(shard_id: int, email: str):
    """Search a single shard"""
    async with shard_router.get_replica_session(shard_id) as session:
        result = await session.execute(
            "SELECT id, email, name FROM users WHERE email LIKE :email LIMIT 10",
            {"email": f"%{email}%"}
        )
        return [{"id": r[0], "email": r[1], "name": r[2]} for r in result.fetchall()]
```

### 2. Distributed ID Generation (Snowflake-style)

```python
import time
import threading

class DistributedIDGenerator:
    """
    Twitter Snowflake-style ID generator

    64-bit ID structure:
    - 1 bit: unused (always 0)
    - 41 bits: timestamp in milliseconds
    - 10 bits: machine/datacenter ID
    - 12 bits: sequence number

    Allows ~4096 IDs per millisecond per machine
    """

    EPOCH = 1609459200000  # 2021-01-01 00:00:00 UTC in milliseconds

    MACHINE_ID_BITS = 10
    SEQUENCE_BITS = 12

    MAX_MACHINE_ID = (1 << MACHINE_ID_BITS) - 1
    MAX_SEQUENCE = (1 << SEQUENCE_BITS) - 1

    MACHINE_ID_SHIFT = SEQUENCE_BITS
    TIMESTAMP_SHIFT = MACHINE_ID_BITS + SEQUENCE_BITS

    def __init__(self, machine_id: int):
        if machine_id < 0 or machine_id > self.MAX_MACHINE_ID:
            raise ValueError(f"Machine ID must be between 0 and {self.MAX_MACHINE_ID}")

        self.machine_id = machine_id
        self.sequence = 0
        self.last_timestamp = -1
        self.lock = threading.Lock()

    def _current_millis(self) -> int:
        return int(time.time() * 1000)

    def _wait_next_millis(self, last_timestamp: int) -> int:
        timestamp = self._current_millis()
        while timestamp <= last_timestamp:
            timestamp = self._current_millis()
        return timestamp

    def generate(self) -> int:
        with self.lock:
            timestamp = self._current_millis()

            if timestamp < self.last_timestamp:
                raise Exception("Clock moved backwards!")

            if timestamp == self.last_timestamp:
                # Same millisecond, increment sequence
                self.sequence = (self.sequence + 1) & self.MAX_SEQUENCE
                if self.sequence == 0:
                    # Sequence overflow, wait for next millisecond
                    timestamp = self._wait_next_millis(self.last_timestamp)
            else:
                # New millisecond, reset sequence
                self.sequence = 0

            self.last_timestamp = timestamp

            # Combine components
            id_value = (
                ((timestamp - self.EPOCH) << self.TIMESTAMP_SHIFT) |
                (self.machine_id << self.MACHINE_ID_SHIFT) |
                self.sequence
            )

            return id_value

# Initialize with unique machine ID (0-1023)
# In production, get from environment or service discovery
MACHINE_ID = int(os.getenv("MACHINE_ID", "0"))
id_generator = DistributedIDGenerator(MACHINE_ID)

async def generate_distributed_id() -> int:
    """Generate globally unique, sortable ID"""
    return id_generator.generate()
```

### 3. Async Write Processing

```python
import aioboto3
import json

# SQS Configuration
SQS_QUEUE_URLS = {
    shard_id: f"https://sqs.us-east-1.amazonaws.com/123456789/writes-shard-{shard_id}"
    for shard_id in range(NUM_SHARDS)
}

async def publish_async_write(shard_id: int, operation: dict):
    """Publish write operation to SQS for async processing"""
    async with aioboto3.Session().client('sqs', region_name='us-east-1') as sqs:
        await sqs.send_message(
            QueueUrl=SQS_QUEUE_URLS[shard_id],
            MessageBody=json.dumps(operation),
            MessageAttributes={
                'operation_type': {'StringValue': operation['type'], 'DataType': 'String'},
                'priority': {'StringValue': operation.get('priority', 'normal'), 'DataType': 'String'}
            }
        )

# API endpoint with async write
@app.post("/api/v1/event")
async def create_event(event: EventCreate):
    """Create event with async write (non-blocking)"""

    user_id = event.user_id
    shard_id = shard_router.get_shard_id(user_id)

    # Publish to queue (non-blocking)
    await publish_async_write(shard_id, {
        'type': 'insert_event',
        'table': 'events',
        'data': {
            'user_id': user_id,
            'event_type': event.event_type,
            'event_data': event.data,
            'created_at': datetime.utcnow().isoformat()
        }
    })

    # Return immediately
    return {"status": "accepted", "message": "Event will be processed shortly"}

# Worker process (separate service)
async def process_write_queue(shard_id: int):
    """Process async writes from SQS"""
    async with aioboto3.Session().client('sqs', region_name='us-east-1') as sqs:
        while True:
            response = await sqs.receive_message(
                QueueUrl=SQS_QUEUE_URLS[shard_id],
                MaxNumberOfMessages=10,
                WaitTimeSeconds=20,  # Long polling
            )

            messages = response.get('Messages', [])

            for message in messages:
                try:
                    operation = json.loads(message['Body'])

                    # Execute database write
                    async with shard_router.get_primary_session(shard_id) as session:
                        if operation['type'] == 'insert_event':
                            await session.execute(
                                """INSERT INTO events (user_id, event_type, event_data, created_at)
                                   VALUES (:user_id, :event_type, :event_data::jsonb, :created_at)""",
                                operation['data']
                            )
                            await session.commit()

                    # Delete message from queue
                    await sqs.delete_message(
                        QueueUrl=SQS_QUEUE_URLS[shard_id],
                        ReceiptHandle=message['ReceiptHandle']
                    )

                except Exception as e:
                    print(f"Error processing message: {e}")
                    # Message will become visible again after visibility timeout
```

---

## Load Testing Plan

### Massive Scale Load Testing

**Infrastructure:**
- **Load Generators:** 50 instances (c6i.8xlarge, 32 vCPU each)
- **Distribution:** Across 5 regions
- **Tool:** k6 Cloud or custom distributed load tester
- **Cost:** ~$2,000 for 4-hour test

### Test Scenarios

#### Scenario 1: Sustained 1M RPS (2 hours)

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const cacheMisses = new Rate('cache_misses');

export const options = {
  ext: {
    loadimpact: {
      distribution: {
        'amazon:us:ashburn': { loadZone: 'amazon:us:ashburn', percent: 50 },
        'amazon:ie:dublin': { loadZone: 'amazon:ie:dublin', percent: 31 },
        'amazon:sg:singapore': { loadZone: 'amazon:sg:singapore', percent: 19 },
      },
    },
  },
  scenarios: {
    sustained_1m_rps: {
      executor: 'constant-arrival-rate',
      rate: 1000000,
      timeUnit: '1s',
      duration: '120m',
      preAllocatedVUs: 20000,
      maxVUs: 40000,
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<25', 'p(99)<50'],
    'http_req_failed': ['rate<0.001'],
    'errors': ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://api.example.com';

// Realistic workload distribution
export default function() {
  const rand = Math.random();
  let response;

  // 50% reads (cacheable)
  if (rand < 0.5) {
    const userId = weighted_user_id();  // Zipf distribution
    response = http.get(`${BASE_URL}/api/v1/user/${userId}`);

    // Check if served from cache
    if (response.headers['X-Cache'] === 'MISS') {
      cacheMisses.add(1);
    }
  }
  // 30% writes (critical, sync)
  else if (rand < 0.8) {
    const payload = JSON.stringify({
      email: `user${Date.now()}-${Math.random()}@example.com`,
      name: `User ${Math.random()}`
    });
    response = http.post(`${BASE_URL}/api/v1/user`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // 20% events (non-critical, async)
  else {
    const userId = weighted_user_id();
    const payload = JSON.stringify({
      user_id: userId,
      event_type: 'page_view',
      data: { page: '/dashboard', timestamp: Date.now() }
    });
    response = http.post(`${BASE_URL}/api/v1/event`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const success = check(response, {
    'status OK': (r) => r.status >= 200 && r.status < 300,
    'response time acceptable': (r) => r.timings.duration < 100,
  });

  if (!success) {
    errorRate.add(1);
  }
}

// Zipfian distribution (realistic - 20% of users generate 80% of traffic)
function weighted_user_id() {
  const totalUsers = 100000000;  // 100M users

  if (Math.random() < 0.8) {
    // 80% of requests for top 20% of users
    return Math.floor(Math.random() * (totalUsers * 0.2));
  } else {
    // 20% of requests for bottom 80% of users
    return Math.floor(totalUsers * 0.2 + Math.random() * (totalUsers * 0.8));
  }
}
```

### Acceptance Criteria

| Metric | Target | Measured | Status |
|--------|--------|----------|--------|
| Sustained 1M RPS | 1,000,000 ± 1% | TBD | ⏳ |
| CDN hit rate | > 55% | TBD | ⏳ |
| Redis cache hit rate | > 65% | TBD | ⏳ |
| Database QPS | < 150,000 | TBD | ⏳ |
| p50 latency (global) | < 8ms | TBD | ⏳ |
| p95 latency | < 25ms | TBD | ⏳ |
| p99 latency | < 50ms | TBD | ⏳ |
| Error rate | < 0.1% | TBD | ⏳ |
| Shard imbalance | < 15% variance | TBD | ⏳ |
| Queue lag (async writes) | < 30s | TBD | ⏳ |
| Primary DB CPU (max shard) | < 65% | TBD | ⏳ |
| Replica DB CPU | < 40% | TBD | ⏳ |
| Replication lag (same region) | < 50ms | TBD | ⏳ |

---

## Operational Maturity

### Team Structure (Minimum)

**SRE Team (4 engineers):**
- 24/7 on-call rotation (1 week on, 3 weeks off)
- Incident response, capacity planning, infrastructure automation

**DBA Team (2 engineers):**
- Database performance tuning, query optimization
- Replication management, backup/recovery
- Sharding strategy, capacity planning

**Backend Engineers (2-4):**
- Application development, feature delivery
- Performance optimization, debugging

**Security Engineer (1):**
- WAF configuration, DDoS mitigation
- Security audits, compliance

**Total: 9-11 engineers minimum**

### Runbooks Required

1. Shard failover procedure
2. Primary database failover
3. Cache cluster failure
4. Multi-region traffic shift
5. Database migration between shards (resharding)
6. Rollback procedures
7. DDoS incident response
8. Data corruption recovery
9. Capacity scaling procedures
10. Disaster recovery (region outage)

---

## Next Steps

1. **Start with 100k RPS:** Validate architecture at smaller scale first
2. **Implement sharding:** Test with 4 shards before going to 16
3. **Chaos engineering:** Test failure scenarios regularly
4. **Gradual rollout:** 100k → 250k → 500k → 1M RPS over 6-12 months
5. **Team scaling:** Hire ahead of infrastructure scaling

---

**Document Version:** 1.0
**Last Updated:** 2025-11-16
**Validated By:** ⏳ Pending (requires extensive testing)
**Estimated Infrastructure Cost:** $180,000-220,000/month (optimized)
**Team Cost:** $100,000-150,000/month (fully loaded)
**Total Cost of Ownership:** $280,000-370,000/month
