# FastAPI + PostgreSQL: 100,000 RPS (100k RPS)

**Target:** 100,000 requests per second with database queries
**Stack:** FastAPI + PostgreSQL + PgBouncer + Redis (optional cache layer)
**DB Hit Rate:** 60% (60,000 queries per second)
**Estimated Cost:** $45,000/month

## TL;DR (Executive Summary)

**What:** Multi-region FastAPI deployment with PostgreSQL cluster, featuring read replicas, connection pooling, optional caching layer, and sophisticated database architecture.

**Why this matters:** Enters enterprise-scale database operations. Requires database sharding strategy planning, advanced PostgreSQL tuning, multi-region replication, and dedicated DBA resources.

**Key numbers:**
- **80 API servers:** 8 vCPU, 32 GB RAM each (distributed across regions)
- **PostgreSQL:** 1 primary (db.r6i.8xlarge) + 8 read replicas (db.r6i.4xlarge)
- **Database Capacity:** 60,000 QPS (36k reads, 24k writes potential)
- **Optional Redis:** 3-node cluster for 40% cache hit rate
- **PgBouncer:** Transaction pooling (640 app connections → 200 DB connections)
- **Cost:** ~$45,000/month
- **Latency:** p50: 12ms, p95: 40ms, p99: 80ms
- **Multi-region:** Active-active with read replicas in each region

**When to use:** Large-scale SaaS platforms, multi-tenant applications, e-commerce platforms at scale, financial services applications.

**Warning:** At this scale, consider:
- **Database sharding:** Plan sharding strategy for > 100k QPS
- **Cache layer:** Redis highly recommended (40-60% cache hit = 40% cost savings)
- **Read replica lag:** Multi-region lag can be 100-500ms
- **Cost:** Database infrastructure alone: ~$25k/month

---

## Architecture Overview

### Multi-Region Active-Active with Database Replication

```
                     Global DNS (Route53)
                     Latency-based routing
                            │
              ┌─────────────┼─────────────┐
              │                           │
        ┌─────▼──────┐              ┌─────▼──────┐
        │  REGION 1  │              │  REGION 2  │
        │ (us-east-1)│              │ (eu-west-1)│
        │ 50 servers │              │ 30 servers │
        └─────┬──────┘              └─────┬──────┘
              │                           │
         ┌────▼────┐                 ┌────▼────┐
         │   ALB   │                 │   ALB   │
         └────┬────┘                 └────┬────┘
              │                           │
    ┌─────────┴──────────┐      ┌─────────┴──────────┐
    │  API Servers (50)  │      │  API Servers (30)  │
    │  8 workers each    │      │  8 workers each    │
    │  Pool: 8/worker    │      │  Pool: 8/worker    │
    └─────────┬──────────┘      └─────────┬──────────┘
              │                           │
              │ (400 workers × 8 = 3,200) │ (240 workers × 8 = 1,920)
              │                           │
         ┌────▼────┐                 ┌────▼────┐
         │PgBouncer│                 │PgBouncer│
         │Pool: 120│                 │Pool: 80 │
         └────┬────┘                 └────┬────┘
              │                           │
    ┌─────────┴──────────┐                │
    │  Optional Redis    │                │
    │  (3-node cluster)  │                │
    │  40% cache hit     │                │
    └─────────┬──────────┘                │
              │                           │
    ┌─────────┴──────────┬────────────────┴────────┐
    │                    │                          │
┌───▼──────────┐  ┌──────▼────────┐         ┌──────▼────────┐
│ PostgreSQL   │  │ PostgreSQL    │         │ PostgreSQL    │
│   PRIMARY    │  │  REPLICAS     │         │  REPLICAS     │
│  (Writes)    │  │  (Region 1)   │         │  (Region 2)   │
│              │  │  4 replicas   │         │  4 replicas   │
│ db.r6i.8xl   │  │  db.r6i.4xl   │         │  db.r6i.4xl   │
│              │  │               │         │               │
│ 24k write QPS│  │ 18k read QPS  │         │ 18k read QPS  │
│ 12k read QPS │  │ (4.5k each)   │         │ (4.5k each)   │
│ TOTAL: 36k   │  │               │         │               │
└──────────────┘  └───────────────┘         └───────────────┘
        │                                           │
        └──────────── Cross-region ─────────────────┘
                    Replication (async)
```

### Traffic Flow

**Read queries (60% of DB traffic = 36,000 QPS):**
```
Client → ALB → API Server → Redis (40% hit) → PgBouncer → Read Replica
                                ↓ (60% miss)
                           PgBouncer → Read Replica (Round-robin)
```

**Write queries (40% of DB traffic = 24,000 QPS):**
```
Client → ALB → API Server → PgBouncer → Primary → Async Replication → Replicas
```

**Why 40/60 write/read split (not 20/80)?**
- At scale, more write operations (updates, analytics writes, audit logs)
- Multi-tenant apps have higher write ratios
- Caching reduces read load but not write load

---

## Capacity Planning

### 1. Database Query Load

```
Total RPS = 100,000
DB Hit Rate = 60% (40% served by application/CDN cache)
DB QPS = 100,000 * 0.60 = 60,000 queries per second

With Redis (40% cache hit):
  Cache hits: 60,000 * 0.40 = 24,000 QPS (served from Redis)
  DB QPS: 60,000 * 0.60 = 36,000 QPS

Read/Write Split (more writes at scale):
  Reads: 36,000 * 0.60 = 21,600 QPS → Read Replicas
  Writes: 36,000 * 0.40 = 14,400 QPS → Primary

Actual capacity needed:
  Primary handles: 14,400 writes + ~10% reads = ~16,000 QPS
  Read replicas: 21,600 QPS split across 8 replicas = ~2,700 QPS each
```

### 2. Connection Pool Sizing (Multi-Region)

**Region 1 (50 servers, 400 workers):**

```
Application Pool Size per Worker:
  Worker RPS = (50,000 / 400 workers) * 0.60 DB hit rate = 75 QPS
  With Redis: 75 * 0.60 = 45 QPS to database
  Avg Query Time = 8ms = 0.008s (slower due to scale)
  Concurrent Queries per Worker = 45 * 0.008 = 0.36
  Pool Size = ceiling(0.36 * 3.0 safety factor) = 8 connections

Total App Connections (Region 1):
  400 workers * 8 connections = 3,200 connections

PgBouncer Pooling (transaction mode, 25:1 ratio at scale):
  DB Connections = 3,200 / 25 = 128 connections

  To Primary: 50 connections (writes)
  To Read Replicas: 78 connections (split across 4 replicas = ~20 each)
  Total: 128 connections
```

**Region 2 (30 servers, 240 workers):**

```
Total App Connections: 240 workers * 8 = 1,920 connections
PgBouncer Pool: 1,920 / 25 = ~77 connections

  To Primary: 30 connections (writes)
  To Read Replicas: 47 connections (split across 4 replicas = ~12 each)
```

### 3. PostgreSQL Instance Sizing

**Primary Database (Handles all writes):**

```
Instance Type: db.r6i.8xlarge (RDS)
  vCPU: 32
  RAM: 256 GB
  Network: 10 Gbps
  IOPS: 40,000 (provisioned io2)
  Storage: 5 TB SSD (io2)

Expected Load:
  Writes: 14,400 QPS
  Reads (overflow from replicas): ~1,600 QPS
  Total: ~16,000 QPS

Connection Count:
  From Region 1 PgBouncer: 50
  From Region 2 PgBouncer: 30
  Replication slots: 8 (for read replicas)
  Total connections: ~100

CPU Utilization: ~50-60% (allowing headroom for spikes)
Memory: 160 GB active (shared_buffers 64GB + OS cache 90GB)

Configuration:
  shared_buffers = 64GB
  effective_cache_size = 192GB
  max_connections = 500
  max_wal_size = 16GB
  checkpoint_timeout = 15min
```

**Read Replicas (8 × db.r6i.4xlarge):**

```
Instance Type: db.r6i.4xlarge (per replica)
  vCPU: 16
  RAM: 128 GB
  Network: 10 Gbps
  IOPS: 20,000 (provisioned io2)
  Storage: 5 TB SSD (replicated from primary)

Deployment:
  Region 1 (us-east-1): 4 replicas
  Region 2 (eu-west-1): 4 replicas

Expected Load per Replica:
  Reads: 21,600 / 8 = ~2,700 QPS

CPU Utilization: ~30-40%
Replication Lag:
  Same-region: 50-100ms
  Cross-region: 200-500ms

Configuration:
  hot_standby = on
  max_standby_streaming_delay = 30s
  shared_buffers = 32GB
  effective_cache_size = 96GB
```

### 4. Redis Cache Layer (Optional but Recommended)

```
Deployment: 3-node cluster (ElastiCache for Redis)
Instance Type: cache.r6g.2xlarge per node
  vCPU: 8
  RAM: 52 GB per node
  Network: 10 Gbps

Configuration:
  Mode: Cluster mode enabled
  Shards: 3
  Replicas per shard: 1 (for HA)
  Total nodes: 6 (3 primaries + 3 replicas)

Expected Load:
  Cache Requests: 60,000 QPS
  Cache Hits: 24,000 QPS (40%)
  Cache Misses: 36,000 QPS (60% → database)

Memory Usage:
  Working Set: ~120 GB (across 3 shards)
  Eviction Policy: allkeys-lru
  TTL: 60-300 seconds (application-dependent)

Cost Impact:
  Redis Cost: ~$1,800/month
  Database Cost Savings: ~$8,000/month (smaller replicas needed)
  Net Savings: ~$6,200/month
```

### 5. Cost Breakdown

```
COMPUTE (API Servers):
  Region 1: 50 × c6i.2xlarge reserved: $3,250/month
  Region 2: 30 × c6i.2xlarge reserved: $1,950/month
  Total API: $5,200/month

DATABASE (Primary):
  Primary (db.r6i.8xlarge Multi-AZ): $3,600/month
  Storage (5 TB io2, 40k IOPS): $2,500/month
  Backups (automated, 30-day): $500/month
  Total Primary: $6,600/month

DATABASE (Read Replicas):
  Region 1: 4 × db.r6i.4xlarge: $6,400/month
  Region 2: 4 × db.r6i.4xlarge: $6,800/month (EU pricing)
  Storage (5 TB × 8 replicas): $10,000/month
  Total Replicas: $23,200/month

CONNECTION POOLING:
  PgBouncer (2 × t3.large): $120/month

CACHE LAYER (Redis):
  6 nodes (cache.r6g.2xlarge): $1,800/month

LOAD BALANCERS:
  4 × ALB across regions: $200/month

NETWORK:
  Egress (with cache): $5,000/month
  Cross-region replication: $2,000/month
  Total Network: $7,000/month

MONITORING:
  DataDog Enterprise: $3,000/month
  CloudWatch detailed: $500/month
  Total Monitoring: $3,500/month

TOTAL MONTHLY COST:
  Compute: $5,200
  Database: $29,800
  Cache: $1,800
  Network: $7,000
  Monitoring: $3,500
  Misc (backups, DNS): $1,000

  TOTAL: $48,300/month

Rounded estimate with contingency: $45,000-50,000/month
```

**Cost per 1,000 requests:** $0.015 (1.5 cents per 1k requests)

---

## Software Configuration

### 1. FastAPI Application with Connection Routing

```python
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from contextlib import asynccontextmanager
import redis.asyncio as redis
from typing import Optional
import json
import hashlib

# Database URLs (through PgBouncer)
PRIMARY_DB_URL = "postgresql+asyncpg://user:pass@pgbouncer-primary:6432/mydb"
REPLICA_DB_URLS = [
    "postgresql+asyncpg://user:pass@pgbouncer-replica-1:6432/mydb",
    "postgresql+asyncpg://user:pass@pgbouncer-replica-2:6432/mydb",
    "postgresql+asyncpg://user:pass@pgbouncer-replica-3:6432/mydb",
    "postgresql+asyncpg://user:pass@pgbouncer-replica-4:6432/mydb",
]

# Connection pools
primary_engine = create_async_engine(
    PRIMARY_DB_URL,
    pool_size=8,  # Per worker
    max_overflow=4,
    pool_pre_ping=True,
    pool_recycle=3600,
    echo=False,
    connect_args={
        "command_timeout": 5,
        "server_settings": {
            "application_name": "fastapi_primary",
            "jit": "off",  # Disable JIT for lower latency
        }
    }
)

# Create multiple replica engines for load distribution
replica_engines = [
    create_async_engine(
        url,
        pool_size=8,
        max_overflow=4,
        pool_pre_ping=True,
        pool_recycle=3600,
        echo=False,
        connect_args={
            "command_timeout": 10,  # Longer timeout for reads
            "server_settings": {
                "application_name": f"fastapi_replica_{i}",
                "jit": "off",
            }
        }
    )
    for i, url in enumerate(REPLICA_DB_URLS)
]

# Redis connection pool
redis_client = redis.Redis(
    host='redis-cluster.cache.amazonaws.com',
    port=6379,
    decode_responses=True,
    max_connections=50,  # Per worker
    socket_connect_timeout=0.1,  # 100ms timeout
    socket_timeout=0.2,
)

# Session makers
PrimarySession = sessionmaker(
    primary_engine, class_=AsyncSession, expire_on_commit=False
)

ReplicaSessions = [
    sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    for engine in replica_engines
]

# Round-robin counter for replica selection
_replica_counter = 0

def get_replica_session():
    """Get a replica session using round-robin"""
    global _replica_counter
    _replica_counter = (_replica_counter + 1) % len(ReplicaSessions)
    return ReplicaSessions[_replica_counter]

@asynccontextmanager
async def get_db_session(read_only=True):
    """Get database session (primary or replica)"""
    SessionClass = get_replica_session() if read_only else PrimarySession
    async with SessionClass() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise

# Cache helpers
def cache_key(prefix: str, **kwargs) -> str:
    """Generate cache key from parameters"""
    key_data = f"{prefix}:" + ":".join(f"{k}={v}" for k, v in sorted(kwargs.items()))
    return hashlib.md5(key_data.encode()).hexdigest()

async def get_cached(key: str) -> Optional[dict]:
    """Get value from cache"""
    try:
        value = await redis_client.get(key)
        return json.loads(value) if value else None
    except Exception as e:
        # Cache failure should not break the app
        print(f"Cache get error: {e}")
        return None

async def set_cached(key: str, value: dict, ttl: int = 60):
    """Set value in cache with TTL"""
    try:
        await redis_client.setex(key, ttl, json.dumps(value))
    except Exception as e:
        print(f"Cache set error: {e}")

# FastAPI endpoints with caching
@app.get("/api/v1/user/{user_id}")
async def get_user(user_id: int):
    """Read from cache → replica, with cache-aside pattern"""

    # Try cache first
    cache_key_str = cache_key("user", user_id=user_id)
    cached_user = await get_cached(cache_key_str)
    if cached_user:
        return cached_user

    # Cache miss, query replica
    async with get_db_session(read_only=True) as session:
        result = await session.execute(
            "SELECT id, email, name, created_at FROM users WHERE id = :id",
            {"id": user_id}
        )
        user = result.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        user_dict = {
            "id": user[0],
            "email": user[1],
            "name": user[2],
            "created_at": user[3].isoformat()
        }

        # Update cache
        await set_cached(cache_key_str, user_dict, ttl=300)  # 5 minute TTL

        return user_dict

@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    """Write to primary, invalidate cache"""
    async with get_db_session(read_only=False) as session:
        result = await session.execute(
            "INSERT INTO users (email, name) VALUES (:email, :name) RETURNING id",
            {"email": user.email, "name": user.name}
        )
        user_id = result.fetchone()[0]

        # Invalidate related caches (if needed)
        # await redis_client.delete(cache_key("user", user_id=user_id))

        return {"id": user_id}

@app.put("/api/v1/user/{user_id}")
async def update_user(user_id: int, user: UserUpdate):
    """Write to primary, invalidate cache"""
    async with get_db_session(read_only=False) as session:
        result = await session.execute(
            """UPDATE users
               SET name = :name, updated_at = NOW()
               WHERE id = :id
               RETURNING id""",
            {"id": user_id, "name": user.name}
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="User not found")

        # Invalidate cache
        cache_key_str = cache_key("user", user_id=user_id)
        await redis_client.delete(cache_key_str)

        return {"id": user_id, "status": "updated"}

# Health check with database connectivity test
@app.get("/health")
async def health_check():
    """Health check with DB connectivity"""
    try:
        # Check primary
        async with get_db_session(read_only=False) as session:
            await session.execute("SELECT 1")

        # Check one replica
        async with get_db_session(read_only=True) as session:
            await session.execute("SELECT 1")

        # Check Redis
        await redis_client.ping()

        return {"status": "healthy", "database": "connected", "cache": "connected"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Service unhealthy: {str(e)}")
```

### 2. PgBouncer Configuration (Primary)

**/etc/pgbouncer/pgbouncer-primary.ini:**

```ini
[databases]
mydb = host=postgres-primary.rds.amazonaws.com port=5432 dbname=mydb

[pgbouncer]
listen_addr = *
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# Connection pooling - aggressive for writes
pool_mode = transaction
max_client_conn = 5000    # From all application servers
default_pool_size = 100   # To primary PostgreSQL
reserve_pool_size = 25
reserve_pool_timeout = 1

# Timeouts
server_idle_timeout = 600
server_lifetime = 1800    # Shorter for primary
query_timeout = 30
query_wait_timeout = 10

# Performance
max_prepared_statements = 0  # Don't cache prepared statements in transaction mode

# Logging
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
log_stats = 1
stats_period = 60
```

### 3. PgBouncer Configuration (Replicas)

**/etc/pgbouncer/pgbouncer-replica.ini:**

```ini
[databases]
; Round-robin DNS or load balancer to replicas
mydb = host=postgres-replicas.rds.amazonaws.com port=5432 dbname=mydb

[pgbouncer]
listen_addr = *
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# Connection pooling - can be more aggressive for reads
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 150   # More connections for read replicas
reserve_pool_size = 50
reserve_pool_timeout = 2

# Timeouts - longer for complex reads
server_idle_timeout = 600
server_lifetime = 3600
query_timeout = 60        # Longer timeout for analytical queries
query_wait_timeout = 5

# Logging
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
```

### 4. PostgreSQL Configuration (Primary)

**RDS Parameter Group for Primary:**

```ini
# Memory Configuration
shared_buffers = 64GB              # 25% of 256 GB RAM
effective_cache_size = 192GB       # 75% of RAM
work_mem = 256MB                   # Per query operation
maintenance_work_mem = 4GB
autovacuum_work_mem = 2GB

# Connections
max_connections = 500

# WAL Settings (Critical for replication)
wal_level = logical                # For potential future sharding
max_wal_senders = 16               # 8 replicas + buffer
max_replication_slots = 16
wal_keep_size = 10GB               # Keep WAL for lagging replicas
max_wal_size = 16GB
min_wal_size = 4GB

# Checkpoints
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_buffers = 64MB

# Query Tuning
random_page_cost = 1.1             # SSD
effective_io_concurrency = 200
default_statistics_target = 100

# Parallelism
max_worker_processes = 32
max_parallel_workers_per_gather = 8
max_parallel_workers = 24
max_parallel_maintenance_workers = 8

# Logging (for slow query detection)
log_min_duration_statement = 100   # Log queries > 100ms
log_line_prefix = '%t [%p]: user=%u,db=%d,app=%a,client=%h '
log_checkpoints = on
log_connections = off              # Too noisy at scale
log_disconnections = off
log_lock_waits = on
log_temp_files = 0
log_autovacuum_min_duration = 0

# Performance
synchronous_commit = on            # For ACID
commit_delay = 0
commit_siblings = 5

# Autovacuum (critical at scale)
autovacuum = on
autovacuum_max_workers = 6
autovacuum_naptime = 10s           # More frequent
autovacuum_vacuum_threshold = 50
autovacuum_analyze_threshold = 50
autovacuum_vacuum_scale_factor = 0.05   # Vacuum at 5% change
autovacuum_analyze_scale_factor = 0.02  # Analyze at 2% change

# Statistics
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
pg_stat_statements.max = 10000
track_activity_query_size = 2048
track_io_timing = on
```

### 5. PostgreSQL Configuration (Read Replicas)

**Additional settings for replicas:**

```ini
hot_standby = on
max_standby_streaming_delay = 30s
max_standby_archive_delay = 60s
hot_standby_feedback = on          # Prevent query cancellations
wal_receiver_status_interval = 1s
wal_receiver_timeout = 30s

# Read-only optimizations
synchronous_commit = local         # Faster commits for read replicas
```

---

## Database Schema Optimization

### Optimized Schema for 100k RPS

```sql
-- Users table with partitioning preparation
CREATE TABLE users (
    id BIGSERIAL NOT NULL,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (id, created_at)  -- Composite for future partitioning
) PARTITION BY RANGE (created_at);

-- Create partitions (monthly)
CREATE TABLE users_2025_01 PARTITION OF users
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE users_2025_02 PARTITION OF users
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

-- Indexes
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at DESC);
CREATE INDEX idx_users_id_name ON users(id, name);  -- Covering index

-- Partial indexes for common queries
CREATE INDEX idx_users_active_30d ON users(id)
    WHERE created_at > NOW() - INTERVAL '30 days';

-- Function to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Table for high-volume writes (orders, events, etc.)
CREATE TABLE events (
    id BIGSERIAL NOT NULL,
    user_id BIGINT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions (daily for high-volume)
CREATE TABLE events_2025_01_01 PARTITION OF events
    FOR VALUES FROM ('2025-01-01') TO ('2025-01-02');

-- Indexes
CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_events_type_created ON events(event_type, created_at DESC);
CREATE INDEX idx_events_data ON events USING GIN(event_data);  -- JSONB index

-- Materialized view for analytics (refreshed periodically)
CREATE MATERIALIZED VIEW user_stats AS
SELECT
    DATE_TRUNC('day', created_at) AS day,
    COUNT(*) AS user_count,
    COUNT(DISTINCT email) AS unique_emails
FROM users
GROUP BY DATE_TRUNC('day', created_at);

CREATE UNIQUE INDEX ON user_stats(day);

-- Refresh schedule (run via cron or pg_cron extension)
-- REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats;
```

---

## Load Testing Plan

### Test Infrastructure

**Load Generators:**
- **Count:** 10 instances
- **Type:** c6i.8xlarge (32 vCPU each)
- **Distribution:** 6 in us-east-1, 4 in eu-west-1
- **Tool:** k6 OSS with distributed execution

### Test Scenarios

#### Scenario 1: Sustained 100k RPS with Database Load

**k6 distributed test:**

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    db_heavy_100k: {
      executor: 'constant-arrival-rate',
      rate: 100000,
      timeUnit: '1s',
      duration: '30m',
      preAllocatedVUs: 4000,
      maxVUs: 8000,
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<40', 'p(99)<80'],
    'http_req_failed': ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost';

export default function() {
  const rand = Math.random();
  let response;

  // 60% reads (cache + DB)
  if (rand < 0.6) {
    const userId = Math.floor(Math.random() * 10000000) + 1;
    response = http.get(`${BASE_URL}/api/v1/user/${userId}`);
  }
  // 30% writes
  else if (rand < 0.9) {
    const payload = JSON.stringify({
      email: `user${Date.now()}-${Math.random()}@example.com`,
      name: `User ${Date.now()}`
    });
    response = http.post(`${BASE_URL}/api/v1/user`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // 10% updates
  else {
    const userId = Math.floor(Math.random() * 10000000) + 1;
    const payload = JSON.stringify({
      name: `Updated ${Date.now()}`
    });
    response = http.put(`${BASE_URL}/api/v1/user/${userId}`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const success = check(response, {
    'status is 200-201': (r) => r.status >= 200 && r.status < 300,
    'response time OK': (r) => r.timings.duration < 200,
  });

  if (!success) {
    errorRate.add(1);
  }
}
```

#### Scenario 2: Database Failover Test

**Test replica failure handling:**

```bash
#!/bin/bash
# Start load test
k6 run --vus 4000 --duration 10m postgres-100k.js &
K6_PID=$!

# Wait for steady state
sleep 180

# Simulate replica failure
echo "Terminating one read replica..."
aws rds reboot-db-instance --db-instance-identifier postgres-replica-1

# Monitor recovery
echo "Monitoring error rate during failover..."
watch -n 1 'curl -s http://localhost:8000/metrics | grep error_rate'

# Wait for test completion
wait $K6_PID
```

#### Scenario 3: Cache Effectiveness Test

**Compare with/without Redis:**

```javascript
// Test 1: With cache enabled
export const options_with_cache = {
  scenarios: {
    with_cache: {
      executor: 'constant-arrival-rate',
      rate: 100000,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 4000,
      maxVUs: 8000,
    },
  },
};

// Test 2: Cache disabled (bypass Redis)
// Measure database load increase

export function setup() {
  // Warm up cache
  for (let i = 0; i < 10000; i++) {
    http.get(`${BASE_URL}/api/v1/user/${i}`);
  }
}
```

### Acceptance Criteria

| Metric | Target | Measured | Status |
|--------|--------|----------|--------|
| Sustained 100k RPS | 100,000 ± 500 | TBD | ⏳ |
| DB QPS (with cache) | ~36,000 | TBD | ⏳ |
| Cache hit rate | > 35% | TBD | ⏳ |
| p50 latency | < 12ms | TBD | ⏳ |
| p95 latency | < 40ms | TBD | ⏳ |
| p99 latency | < 80ms | TBD | ⏳ |
| Error rate | < 0.1% | TBD | ⏳ |
| Primary DB CPU | < 60% | TBD | ⏳ |
| Replica DB CPU | < 45% | TBD | ⏳ |
| Replication lag (same region) | < 100ms | TBD | ⏳ |
| Replication lag (cross region) | < 500ms | TBD | ⏳ |
| Replica failover time | < 30s | TBD | ⏳ |

---

## Observability

### Key Metrics to Monitor

**Database Metrics:**

```sql
-- Connection count by state
SELECT
    state,
    COUNT(*) AS connections,
    MAX(query_start) AS oldest_query
FROM pg_stat_activity
WHERE datname = 'mydb'
GROUP BY state;

-- Replication lag (run on primary)
SELECT
    application_name,
    client_addr,
    state,
    pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS send_lag_bytes,
    pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
    replay_lag
FROM pg_stat_replication
ORDER BY replay_lag DESC;

-- Top 20 slowest queries
SELECT
    substring(query, 1, 80) AS short_query,
    calls,
    round(mean_exec_time::numeric, 2) AS avg_ms,
    round(total_exec_time::numeric, 2) AS total_ms,
    round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 2) AS percent
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;

-- Cache hit ratio
SELECT
    'index hit rate' AS metric,
    round(sum(idx_blks_hit) / NULLIF(sum(idx_blks_hit + idx_blks_read), 0) * 100, 2) AS ratio
FROM pg_statio_user_indexes
UNION ALL
SELECT
    'table hit rate' AS metric,
    round(sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit + heap_blks_read), 0) * 100, 2) AS ratio
FROM pg_statio_user_tables;

-- Table bloat
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
    n_dead_tup AS dead_tuples,
    n_live_tup AS live_tuples,
    round((n_dead_tup::numeric / NULLIF(n_live_tup, 0)) * 100, 2) AS dead_ratio
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 20;
```

**Redis Metrics:**

```bash
# Redis CLI commands
INFO stats
INFO replication
INFO memory

# Key metrics
DBSIZE
INFO commandstats
SLOWLOG GET 10
```

**Grafana Dashboard Queries:**

```promql
# Database connections
sum(pg_stat_database_numbackends{datname="mydb"}) by (instance)

# Transaction rate
rate(pg_stat_database_xact_commit{datname="mydb"}[5m])
+ rate(pg_stat_database_xact_rollback{datname="mydb"}[5m])

# Replication lag
pg_replication_lag_seconds

# Cache hit rate
rate(pg_stat_database_blks_hit{datname="mydb"}[5m])
/ (rate(pg_stat_database_blks_hit{datname="mydb"}[5m])
   + rate(pg_stat_database_blks_read{datname="mydb"}[5m]))

# Redis cache hit rate
rate(redis_keyspace_hits_total[5m])
/ (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m]))

# Query latency histogram
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket{endpoint="/api/v1/user"}[5m])) by (le)
)
```

---

## Common Issues & Solutions

### Issue 1: High Replication Lag

**Symptoms:**
- Cross-region lag > 1 second
- Stale data from replicas

**Diagnosis:**
```sql
-- Check current lag
SELECT
    application_name,
    pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) / 1024 / 1024 AS lag_mb,
    replay_lag
FROM pg_stat_replication;

-- Check write volume
SELECT
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')) AS wal_generated;
```

**Solutions:**
1. Increase replica instance size (more CPU for replay)
2. Check network bandwidth between regions
3. Reduce `wal_keep_size` if disk is full
4. Consider logical replication for better cross-region performance
5. Implement eventual consistency patterns in application

### Issue 2: Connection Pool Exhaustion

**Symptoms:**
- "sorry, too many clients" errors
- Requests timing out waiting for connections

**Diagnosis:**
```sql
-- On PostgreSQL
SELECT count(*), state FROM pg_stat_activity GROUP BY state;

-- On PgBouncer
SHOW POOLS;
SHOW CLIENTS;
```

**Solutions:**
```ini
# Increase PgBouncer pool
default_pool_size = 150  # was 100

# Or add more PgBouncer instances
# Deploy 2-3 PgBouncer instances with load balancer

# Or optimize queries to be faster
# Or reduce pool_size per worker in application
```

### Issue 3: Primary Database CPU Saturation

**Symptoms:**
- Primary CPU at 80%+
- Write latency increasing

**Diagnosis:**
```sql
-- Find expensive queries
SELECT
    substring(query, 1, 100) AS query,
    calls,
    mean_exec_time,
    total_exec_time
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- Check for lock contention
SELECT
    pid,
    wait_event_type,
    wait_event,
    query
FROM pg_stat_activity
WHERE wait_event IS NOT NULL;
```

**Solutions:**
1. **Vertical scaling:** Upgrade to db.r6i.12xlarge or db.r6i.16xlarge
2. **Query optimization:** Add indexes, rewrite expensive queries
3. **Write batching:** Batch inserts/updates in application
4. **Consider sharding:** If writes > 20k QPS, plan database sharding

### Issue 4: Cache Stampede

**Symptoms:**
- Periodic spikes in database load
- Many requests for same key after expiration

**Solution:**

```python
import asyncio
from typing import Optional

# Probabilistic early expiration to prevent stampede
async def get_cached_with_pee(key: str, ttl: int = 60, beta: float = 1.0) -> Optional[dict]:
    """
    Get from cache with Probabilistic Early Expiration (PEE)
    to prevent cache stampede
    """
    try:
        # Get value and TTL
        pipe = redis_client.pipeline()
        pipe.get(key)
        pipe.ttl(key)
        value, remaining_ttl = await pipe.execute()

        if value is None:
            return None

        # Probabilistic early expiration
        if remaining_ttl > 0:
            import random
            import math
            delta = ttl - remaining_ttl
            expiry = delta * beta * math.log(random.random())

            if expiry >= remaining_ttl:
                # Trigger early refresh
                return None

        return json.loads(value)
    except Exception as e:
        print(f"Cache error: {e}")
        return None
```

---

## Migration Path

### From 10k RPS → 100k RPS

**Prerequisites:**
- Database team with PostgreSQL expertise
- 24/7 DBA on-call
- Budget approval ($45k/month)
- Capacity for 2-3 month migration

**Timeline: 8-12 Weeks**

**Weeks 1-2: Infrastructure Planning**
1. Deploy additional read replicas (scale from 2 to 8)
2. Set up multi-region replication
3. Deploy Redis cache layer
4. Upgrade primary database instance

**Weeks 3-4: Application Changes**
1. Implement connection routing logic
2. Add Redis caching layer to application
3. Implement cache invalidation strategies
4. Add distributed tracing

**Weeks 5-6: Testing**
1. Load test 50k RPS with database load
2. Test 75k RPS
3. Test 100k RPS
4. Test failover scenarios (replica failure, primary failover)
5. Test cache failure scenarios

**Weeks 7-8: Production Migration**
1. Enable Redis cache for 10% traffic
2. Monitor cache hit rate and database load
3. Gradually scale: 25% → 50% → 75% → 100%
4. Enable multi-region traffic routing
5. Validate replication lag acceptable

**Weeks 9-12: Optimization & Tuning**
1. Optimize cache TTLs based on real traffic
2. Tune database queries based on slow query logs
3. Adjust connection pool sizes
4. Implement partitioning for high-volume tables
5. Create runbooks for all failure scenarios

---

## Sharding Strategy (Future: > 100k QPS)

**When to shard:** When primary database writes exceed 20-25k QPS consistently.

**Sharding approaches:**

### 1. Horizontal Sharding by User ID

```
Shard 0: user_id % 4 = 0 → postgres-shard-0
Shard 1: user_id % 4 = 1 → postgres-shard-1
Shard 2: user_id % 4 = 2 → postgres-shard-2
Shard 3: user_id % 4 = 3 → postgres-shard-3

Each shard:
  - 1 primary + 2 replicas
  - Handles 25% of traffic
  - Write capacity: ~6k QPS per shard
```

### 2. Application-Level Sharding Logic

```python
def get_shard_id(user_id: int, num_shards: int = 4) -> int:
    return user_id % num_shards

def get_shard_engine(user_id: int):
    shard_id = get_shard_id(user_id)
    return shard_engines[shard_id]

@app.get("/api/v1/user/{user_id}")
async def get_user(user_id: int):
    engine = get_shard_engine(user_id)
    # Use sharded engine...
```

**Trade-offs:**
- ✅ Linear write scaling
- ✅ Each shard is independent
- ❌ Cross-shard queries expensive
- ❌ Application complexity increases
- ❌ Rebalancing shards is difficult

---

## Next Steps

1. **Deploy infrastructure:** Use Terraform for multi-region database setup
2. **Implement caching:** Add Redis layer to application
3. **Load testing:** Validate 100k RPS with database load
4. **Monitoring:** Set up comprehensive database observability
5. **Runbooks:** Document all failure scenarios and responses

---

**Document Version:** 1.0
**Last Updated:** 2025-11-16
**Validated By:** ⏳ Pending
**Estimated Cost:** $45,000-50,000/month
**Team Requirements:** 2 SREs + 1 DBA (24/7 on-call)
