# FastAPI + PostgreSQL Stack

**Overview:** This stack adds a persistent data layer (PostgreSQL) to the FastAPI application, introducing database connection management, query optimization, and data layer scaling challenges.

## Stack Components

- **FastAPI:** Async ASGI application framework
- **PostgreSQL:** Relational database (primary + read replicas)
- **PgBouncer:** Connection pooler (reduces DB connection overhead)
- **asyncpg:** High-performance async PostgreSQL driver for Python

## Key Differences from FastAPI-Only

| Aspect | FastAPI-Only | FastAPI + PostgreSQL |
|--------|--------------|----------------------|
| **Latency** | p95: 10-15ms | p95: 50-100ms |
| **Bottleneck** | CPU (compute) | Database (I/O, connections) |
| **Scaling** | Horizontal (stateless) | Vertical (DB) + Horizontal (read replicas) |
| **Complexity** | Low | Medium-High |
| **Cost** | $50-150k/month | $150-450k/month |

---

## Scaling Roadmap by RPS

| RPS | DB Architecture | API Instances | DB Instances | Monthly Cost |
|-----|-----------------|---------------|--------------|--------------|
| [100](./100rps/README.md) | Single PostgreSQL | 1 | 1 primary | $150 |
| [1,000](./1krps/README.md) | Primary + 1 read replica | 2-4 | 1 primary + 1 replica | $600 |
| [10,000](./10krps/README.md) | Primary + 2-3 read replicas + PgBouncer | 8-12 | 1 primary + 3 replicas | $4,500 |
| [100,000](./100krps/README.md) | Sharded primary + 5 replicas per shard | 80-120 | 3 shards + 15 replicas | $65,000 |
| [1,000,000](./1mrps/README.md) | Multi-region sharded + read replicas | 800-1200 | 10 shards + 50 replicas | $550,000 |

---

## Key Patterns & Strategies

### 1. Connection Pooling

**Problem:** PostgreSQL connections are expensive (memory + CPU overhead per connection)

**Solution:** Use PgBouncer for connection pooling

```
Application (160 workers across 20 instances)
  ↓ (8 connections per worker)
PgBouncer (transaction pooling)
  ↓ (40 connections total)
PostgreSQL
```

**Benefits:**
- Reduce PostgreSQL connections from 1,280 → 40
- Lower memory usage on database server
- Better connection reuse

### 2. Read/Write Splitting

**Problem:** Write operations block on single primary

**Solution:** Route reads to replicas, writes to primary

```python
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine

# Primary (writes)
primary_engine = create_async_engine(
    "postgresql+asyncpg://user:pass@primary:5432/db",
    pool_size=20,
    max_overflow=10,
)

# Replica (reads)
replica_engine = create_async_engine(
    "postgresql+asyncpg://user:pass@replica:5432/db",
    pool_size=50,  # More connections for reads
    max_overflow=20,
)

@app.get("/api/v1/user/{user_id}")
async def get_user(user_id: int):
    # Read from replica
    async with replica_engine.connect() as conn:
        result = await conn.execute(
            "SELECT * FROM users WHERE id = $1", user_id
        )
        return result.fetchone()

@app.post("/api/v1/user")
async def create_user(user: UserCreate):
    # Write to primary
    async with primary_engine.connect() as conn:
        result = await conn.execute(
            "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id",
            user.email, user.name
        )
        return {"id": result.fetchone()[0]}
```

### 3. Query Optimization

**Critical for performance at scale:**

```sql
-- Bad: Full table scan
SELECT * FROM users WHERE email = 'user@example.com';

-- Good: Index scan
CREATE INDEX idx_users_email ON users(email);
SELECT * FROM users WHERE email = 'user@example.com';

-- Explain analyze to verify
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'user@example.com';
```

### 4. Connection Pool Sizing Formula

```
Pool Size per Worker = ceiling((Worker RPS * Avg Query Time) * Safety Factor)

where:
  Worker RPS = Total RPS / Total Workers * DB Hit Rate
  Avg Query Time = 0.005s (5ms typical)
  Safety Factor = 2.0

Example (10k RPS, 60% DB hit rate, 64 workers):
  Worker RPS = (10,000 / 64) * 0.60 = 93.75 RPS per worker
  Pool Size = ceiling((93.75 * 0.005) * 2.0)
  Pool Size = ceiling(0.9375)
  Pool Size = 5 connections per worker

  Total connections from app: 64 workers * 5 = 320

  With PgBouncer (4:1 pooling ratio):
    DB connections = 320 / 4 = 80
```

### 5. Database Sharding (100k+ RPS)

**When single primary can't handle write load, shard by key:**

```python
def get_shard_for_user(user_id: int, num_shards: int = 4) -> int:
    return user_id % num_shards

# Route to appropriate shard
shard_id = get_shard_for_user(user_id)
engine = shard_engines[shard_id]
```

---

## PostgreSQL Configuration Tuning

### For 1k RPS (Single Primary)

```ini
# postgresql.conf

# Memory
shared_buffers = 8GB  # 25% of RAM (32 GB instance)
effective_cache_size = 24GB  # 75% of RAM
work_mem = 64MB  # Per query
maintenance_work_mem = 2GB

# Connections
max_connections = 200

# WAL
wal_buffers = 16MB
checkpoint_completion_target = 0.9
checkpoint_timeout = 15min

# Query planning
random_page_cost = 1.1  # For SSD
effective_io_concurrency = 200

# Logging
log_min_duration_statement = 100  # Log queries > 100ms
```

### For 10k RPS (Primary + Replicas)

```ini
# Primary (writes)
max_connections = 500  # Higher for PgBouncer
shared_buffers = 16GB
wal_level = replica
max_wal_senders = 5  # For replication

# Replica (reads)
max_connections = 500
shared_buffers = 16GB
hot_standby = on
max_standby_streaming_delay = 30s
```

---

## Common Failure Modes

### 1. Connection Pool Exhausted

**Symptoms:**
- "connection pool exhausted" errors
- Requests timing out
- pg_stat_activity shows max_connections reached

**Solution:**
```bash
# Increase pool size (temporary)
# Or deploy PgBouncer

# Monitor with:
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
```

### 2. Slow Queries

**Symptoms:**
- High p95/p99 latency
- Database CPU at 100%

**Solution:**
```sql
-- Find slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Add indexes
CREATE INDEX CONCURRENTLY idx_name ON table(column);
```

### 3. Replication Lag

**Symptoms:**
- Stale data from read replicas
- Replication lag > 1 second

**Solution:**
```sql
-- Check lag
SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
       pg_last_wal_receive_lsn() - pg_last_wal_replay_lsn() AS lag_bytes;

-- If lag is high, check network or replica CPU
```

---

## Next Steps

1. Review [1k RPS guide](./1krps/README.md) for production-ready configuration
2. Review [10k RPS guide](./10krps/README.md) for high-scale patterns
3. See [Load Testing](../../load-tests/postgres/) for database-specific scenarios

---

**Last Updated:** 2025-11-16
**Status:** Documentation complete for 1k, 10k RPS
