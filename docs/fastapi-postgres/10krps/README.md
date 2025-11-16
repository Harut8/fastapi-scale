# FastAPI + PostgreSQL: 10,000 RPS (10k RPS)

**Target:** 10,000 requests per second with database queries
**Stack:** FastAPI + PostgreSQL + PgBouncer
**DB Hit Rate:** 60% (6,000 queries per second)
**Estimated Cost:** $4,500/month

## TL;DR (Executive Summary)

**What:** Distributed FastAPI deployment with PostgreSQL primary + read replicas, using PgBouncer for connection pooling and query optimization.

**Key numbers:**
- **8 API servers:** 8 vCPU, 32 GB RAM each
- **PostgreSQL:** 1 primary (db.r6i.2xlarge) + 2 read replicas (db.r6i.xlarge)
- **PgBouncer:** Connection pooling (320 app connections → 80 DB connections)
- **Cost:** ~$4,500/month
- **Latency:** p50: 15ms, p95: 50ms, p99: 100ms
- **DB QPS:** 6,000 (60% of requests hit database)

---

## Architecture Overview

```
                    Load Balancer (ALB)
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼──────┐  ┌──────▼─────┐  ┌──────▼─────┐
    │ API Server │  │ API Server │  │ API Server │ ... (8 total)
    │ 8 workers  │  │ 8 workers  │  │ 8 workers  │
    │ Pool: 5/w  │  │ Pool: 5/w  │  │ Pool: 5/w  │
    └─────┬──────┘  └──────┬─────┘  └──────┬─────┘
          │                │                │
          └────────────────┼────────────────┘
                           │ (64 workers × 5 connections = 320)
                           │
                    ┌──────▼──────┐
                    │  PgBouncer  │
                    │ (Pool:  80)  │
                    └──────┬──────┘
                           │ (40 write + 40 read)
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼──────┐  ┌──────▼─────┐  ┌──────▼─────┐
    │ PostgreSQL │  │ PostgreSQL │  │ PostgreSQL │
    │  PRIMARY   │  │  REPLICA 1 │  │  REPLICA 2 │
    │  (Writes)  │  │  (Reads)   │  │  (Reads)   │
    │ 2k QPS     │  │ 2k QPS     │  │ 2k QPS     │
    └────────────┘  └────────────┘  └────────────┘
```

### Traffic Flow

**Read queries (80% of DB traffic):**
```
Client → ALB → API Server → PgBouncer → Read Replica (Round-robin)
```

**Write queries (20% of DB traffic):**
```
Client → ALB → API Server → PgBouncer → Primary
```

---

## Capacity Planning

### 1. Database Query Load

```
Total RPS = 10,000
DB Hit Rate = 60%
DB QPS = 10,000 * 0.60 = 6,000 queries per second

Read/Write Split:
  Reads: 6,000 * 0.80 = 4,800 QPS → Read Replicas
  Writes: 6,000 * 0.20 = 1,200 QPS → Primary
```

### 2. Connection Pool Sizing

```
Application Pool Size per Worker:
  Worker RPS = (10,000 / 64 workers) * 0.60 DB hit rate = 93.75 QPS
  Avg Query Time = 5ms = 0.005s
  Concurrent Queries per Worker = 93.75 * 0.005 = 0.47
  Pool Size = ceiling(0.47 * 2.0 safety factor) = 5 connections

Total App Connections:
  64 workers * 5 connections = 320 connections

PgBouncer Pooling (transaction mode, 4:1 ratio):
  DB Connections = 320 / 4 = 80 connections
  To Primary: 40 connections (writes + some reads)
  To Replicas: 40 connections total (20 per replica)
```

### 3. PostgreSQL Instance Sizing

**Primary (handles writes + some reads):**
```
Instance Type: db.r6i.2xlarge
  vCPU: 8
  RAM: 64 GB
  IOPS: 16,000 (provisioned)
  Storage: 1 TB SSD

Expected Load:
  Writes: 1,200 QPS
  Reads (overflow): ~600 QPS
  Total: ~1,800 QPS

CPU Utilization: ~30-40%
Memory: 40 GB active (shared_buffers + OS cache)
```

**Read Replicas (2 × db.r6i.xlarge):**
```
Instance Type: db.r6i.xlarge
  vCPU: 4
  RAM: 32 GB
  IOPS: 12,000
  Storage: 1 TB SSD (replicated from primary)

Expected Load per Replica:
  Reads: 2,400 QPS (split across 2 replicas)

CPU Utilization: ~25-35%
```

### 4. Cost Breakdown

```
COMPUTE:
  API Servers (8 × c6i.2xlarge): $520/month (reserved)

DATABASE:
  Primary (db.r6i.2xlarge): $800/month (Multi-AZ reserved)
  Replica 1 (db.r6i.xlarge): $400/month
  Replica 2 (db.r6i.xlarge): $400/month
  PgBouncer (t3.medium): $30/month
  Storage (1 TB × 3): $345/month
  Backups (automated, 7-day): $100/month
  Total Database: $2,075/month

LOAD BALANCER:
  ALB: $50/month

NETWORK:
  Egress: $100/month

MONITORING:
  DataDog/Prometheus: $50/month

TOTAL: ~$2,795/month

With contingency (+20%): ~$3,350/month
Rounded estimate: $4,500/month (includes staging, DR, etc.)
```

---

## Software Configuration

### 1. FastAPI Application with PostgreSQL

**Database connection setup:**

```python
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from contextlib import asynccontextmanager

# Database URLs (through PgBouncer)
PRIMARY_DB_URL = "postgresql+asyncpg://user:pass@pgbouncer:6432/mydb?server_settings=pool_mode=transaction"
REPLICA_DB_URL = "postgresql+asyncpg://user:pass@pgbouncer:6433/mydb?server_settings=pool_mode=transaction"

# Connection pools
primary_engine = create_async_engine(
    PRIMARY_DB_URL,
    pool_size=5,  # Per worker
    max_overflow=2,
    pool_pre_ping=True,
    pool_recycle=3600,  # Recycle connections every hour
    echo=False,
)

replica_engine = create_async_engine(
    REPLICA_DB_URL,
    pool_size=5,
    max_overflow=2,
    pool_pre_ping=True,
    pool_recycle=3600,
    echo=False,
)

# Session makers
PrimarySession = sessionmaker(
    primary_engine, class_=AsyncSession, expire_on_commit=False
)
ReplicaSession = sessionmaker(
    replica_engine, class_=AsyncSession, expire_on_commit=False
)

@asynccontextmanager
async def get_db_session(read_only=True):
    """Get database session (primary or replica)"""
    SessionClass = ReplicaSession if read_only else PrimarySession
    async with SessionClass() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise

# FastAPI endpoints
@app.get("/api/v1/user/{user_id}")
async def get_user(user_id: int):
    """Read from replica"""
    async with get_db_session(read_only=True) as session:
        result = await session.execute(
            "SELECT id, email, name FROM users WHERE id = :id",
            {"id": user_id}
        )
        user = result.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return {"id": user[0], "email": user[1], "name": user[2]}

@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    """Write to primary"""
    async with get_db_session(read_only=False) as session:
        result = await session.execute(
            "INSERT INTO users (email, name) VALUES (:email, :name) RETURNING id",
            {"email": user.email, "name": user.name}
        )
        user_id = result.fetchone()[0]
        return {"id": user_id}
```

### 2. PgBouncer Configuration

**/etc/pgbouncer/pgbouncer.ini:**

```ini
[databases]
mydb = host=postgres-primary port=5432 dbname=mydb
mydb_replica = host=postgres-replica port=5432 dbname=mydb

[pgbouncer]
listen_addr = *
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

# Connection pooling
pool_mode = transaction  # Most efficient
max_client_conn = 500    # From application
default_pool_size = 40   # To PostgreSQL (per database)
reserve_pool_size = 10
reserve_pool_timeout = 3

# Timeouts
server_idle_timeout = 600
server_lifetime = 3600

# Logging
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
```

**Load balancer configuration (split primary/replica):**

We run two PgBouncer instances:
- Port 6432: Routes to primary (for writes)
- Port 6433: Routes to read replicas (for reads)

### 3. PostgreSQL Configuration

**Primary (postgresql.conf):**

```ini
# Memory Configuration
shared_buffers = 16GB  # 25% of 64 GB RAM
effective_cache_size = 48GB  # 75% of RAM
work_mem = 128MB  # Per query sort/hash
maintenance_work_mem = 2GB

# Connections
max_connections = 500  # For PgBouncer

# WAL Settings (for replication)
wal_level = replica
max_wal_senders = 5
max_replication_slots = 5
wal_keep_size = 1GB

# Checkpoints
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_buffers = 16MB

# Query Tuning
random_page_cost = 1.1  # SSD
effective_io_concurrency = 200
default_statistics_target = 100

# Logging
log_min_duration_statement = 100  # Log slow queries (>100ms)
log_line_prefix = '%t [%p]: user=%u,db=%d,app=%a,client=%h '
log_checkpoints = on
log_connections = on
log_disconnections = on
log_lock_waits = on
log_temp_files = 0

# Performance
synchronous_commit = on  # For ACID compliance
max_worker_processes = 8
max_parallel_workers_per_gather = 4
max_parallel_workers = 8
```

**Read Replica (additional settings):**

```ini
hot_standby = on
max_standby_streaming_delay = 30s
hot_standby_feedback = on  # Prevent query cancellations
```

### 4. Database Schema Optimization

**Example optimized schema:**

```sql
-- Users table with proper indexes
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at DESC);

-- Partial index for active users
CREATE INDEX idx_users_active ON users(id) WHERE created_at > NOW() - INTERVAL '90 days';

-- Function to update updated_at automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

---

## Load Testing Plan

### Test Scenarios

#### Scenario 1: Read-Heavy (80% reads, 20% writes)

**k6 script:**

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    read_heavy_10k: {
      executor: 'constant-arrival-rate',
      rate: 10000,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<50', 'p(99)<100'],
    'errors': ['rate<0.0001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost';

export default function() {
  let response;

  // 80% reads
  if (Math.random() < 0.8) {
    const userId = Math.floor(Math.random() * 10000000) + 1;
    response = http.get(`${BASE_URL}/api/v1/user/${userId}`);
  } else {
    // 20% writes
    const payload = JSON.stringify({
      email: `user${Date.now()}@example.com`,
      name: `User ${Date.now()}`
    });
    response = http.post(`${BASE_URL}/api/v1/user`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const success = check(response, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'response time OK': (r) => r.timings.duration < 200,
  });

  if (!success) {
    errorRate.add(1);
  }
}
```

#### Scenario 2: Database Stress Test

**Gradual ramp to find database breaking point:**

```javascript
export const options = {
  stages: [
    { duration: '2m', target: 5000 },   // Ramp to 5k QPS
    { duration: '2m', target: 7500 },   // 7.5k QPS
    { duration: '2m', target: 10000 },  // 10k QPS
    { duration: '2m', target: 12500 },  // 12.5k QPS (125% capacity)
    { duration: '2m', target: 15000 },  // 15k QPS (150% capacity - should show degradation)
    { duration: '2m', target: 0 },      // Ramp down
  ],
};
```

### Acceptance Criteria

| Metric | Target | Measured | Status |
|--------|--------|----------|--------|
| Sustained 10k RPS | 10,000 ± 100 | TBD | ⏳ |
| DB QPS | ~6,000 | TBD | ⏳ |
| p50 latency | < 15ms | TBD | ⏳ |
| p95 latency | < 50ms | TBD | ⏳ |
| p99 latency | < 100ms | TBD | ⏳ |
| Error rate | < 0.01% | TBD | ⏳ |
| DB CPU (primary) | < 50% | TBD | ⏳ |
| DB CPU (replicas) | < 40% | TBD | ⏳ |
| PgBouncer connections | 70-80 | TBD | ⏳ |
| Replication lag | < 100ms | TBD | ⏳ |

---

## Observability

### Database Metrics to Monitor

**PostgreSQL metrics:**

```sql
-- Active connections
SELECT count(*), state FROM pg_stat_activity GROUP BY state;

-- Slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Replication lag
SELECT
    client_addr,
    state,
    pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS sending_lag,
    pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag
FROM pg_stat_replication;

-- Table sizes
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

### Grafana Dashboard Queries

```promql
# Database connections
pg_stat_database_numbackends{datname="mydb"}

# Transaction rate
rate(pg_stat_database_xact_commit{datname="mydb"}[5m])
+ rate(pg_stat_database_xact_rollback{datname="mydb"}[5m])

# Replication lag
pg_replication_lag_seconds

# Cache hit rate
rate(pg_stat_database_blks_hit{datname="mydb"}[5m])
/ (rate(pg_stat_database_blks_hit{datname="mydb"}[5m])
   + rate(pg_stat_database_blks_read{datname="mydb"}[5m]))
```

---

## Common Issues & Solutions

### Issue 1: High Replication Lag

**Symptoms:**
- Replication lag > 1 second
- Stale data from read replicas

**Diagnosis:**
```sql
-- Check lag
SELECT
    application_name,
    pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) / 1024 / 1024 AS lag_mb,
    replay_lag
FROM pg_stat_replication;
```

**Solutions:**
- Increase replica instance size
- Check network bandwidth between primary/replica
- Reduce write load on primary
- Add more replicas to distribute read load

### Issue 2: Connection Pool Exhaustion

**Symptoms:**
- "connection pool exhausted" errors
- High wait times for connections

**Diagnosis:**
```bash
# PgBouncer
psql -h localhost -p 6432 -U pgbouncer pgbouncer -c "SHOW POOLS;"
psql -h localhost -p 6432 -U pgbouncer pgbouncer -c "SHOW CLIENTS;"
```

**Solutions:**
```ini
# Increase PgBouncer pool size
default_pool_size = 60  # was 40

# Or optimize application queries to be faster
```

### Issue 3: Slow Queries

**Symptoms:**
- p95/p99 latency high
- Database CPU at 80%+

**Diagnosis:**
```sql
-- Enable pg_stat_statements if not already
CREATE EXTENSION pg_stat_statements;

-- Find slowest queries
SELECT
    substring(query, 1, 50) AS short_query,
    round(mean_exec_time::numeric, 2) AS avg_ms,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Explain analyze the slow query
EXPLAIN (ANALYZE, BUFFERS) <your_query>;
```

**Solutions:**
- Add missing indexes
- Optimize query (avoid SELECT *, use WHERE efficiently)
- Denormalize data if needed
- Consider materialized views for complex aggregations

---

## Migration from 1k RPS → 10k RPS

**Steps:**

1. **Add Read Replicas (Week 1):**
   - Deploy 2 read replicas
   - Verify replication is working
   - Test read queries against replicas

2. **Deploy PgBouncer (Week 1):**
   - Install PgBouncer on dedicated instance
   - Configure transaction pooling
   - Update application connection strings

3. **Scale API Tier (Week 2):**
   - Increase from 2 to 8 API instances
   - Update load balancer configuration
   - Verify even traffic distribution

4. **Load Testing (Week 2):**
   - Run 5k RPS test
   - Run 7.5k RPS test
   - Run 10k RPS sustained test
   - Validate all metrics within targets

5. **Production Migration (Week 3):**
   - Route 10% traffic → new stack
   - Gradually increase: 25% → 50% → 100%
   - Monitor replication lag and error rates
   - Keep old stack warm for 48h rollback window

---

## Next Steps

1. Deploy infrastructure using [Terraform configs](../../../deployments/terraform/postgres-10krps/)
2. Run load tests with [k6 scripts](../../../load-tests/k6/postgres-10krps.js)
3. Set up [Grafana dashboards](../../../observability/dashboards/postgres-10krps.json)
4. Review [runbooks](../../../runbooks/postgres-failure-modes.md)

---

**Document Version:** 1.0
**Last Updated:** 2025-11-16
**Validated By:** ⏳ Pending
**Estimated Cost:** $4,500/month
