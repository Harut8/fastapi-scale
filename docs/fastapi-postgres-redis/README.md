# FastAPI + PostgreSQL + Redis Stack

**Overview:** This stack adds a caching layer (Redis) to reduce database load and improve response times. Redis handles frequently accessed data, dramatically reducing database queries.

## Stack Components

- **FastAPI:** Async ASGI application framework
- **PostgreSQL:** Relational database (primary + read replicas)
- **Redis:** In-memory cache and session store
- **PgBouncer:** Connection pooler for PostgreSQL

## Key Benefits of Adding Redis

| Metric | Without Redis | With Redis (80% cache hit) |
|--------|---------------|----------------------------|
| **Database QPS** | 6,000 | 1,200 (80% reduction!) |
| **p95 Latency** | 50ms | 15ms (70% improvement) |
| **DB Instance Cost** | $2,075/month | $800/month (smaller instance) |
| **Redis Cost** | $0 | $360/month (3-node cluster) |
| **Net Savings** | - | ~$900/month |

---

## Architecture Pattern

```
Client Request
    ↓
FastAPI Application
    ↓
Check Redis Cache ──→ CACHE HIT (80%) ──→ Return cached data (< 5ms)
    ↓ CACHE MISS (20%)
Query PostgreSQL (60 QPS for 1k RPS target)
    ↓
Cache result in Redis (TTL: 60s)
    ↓
Return data to client
```

### Cache Hit Rate Calculation

```
Effective DB QPS = Total RPS * DB Hit Rate * (1 - Cache Hit Rate)

Example (10k RPS):
  Total RPS = 10,000
  DB Hit Rate = 60% (without cache)
  Cache Hit Rate = 80%

  Effective DB QPS = 10,000 * 0.60 * (1 - 0.80)
  Effective DB QPS = 10,000 * 0.60 * 0.20
  Effective DB QPS = 1,200 QPS

  Reduction: 6,000 → 1,200 QPS (80% reduction!)
```

---

## Redis Configuration for Different Scales

### 1k RPS: Single Redis Instance

```yaml
Instance: cache.r6g.large (2 vCPU, 13 GB RAM)
Cost: $120/month

Configuration:
  maxmemory: 10gb
  maxmemory-policy: allkeys-lru
  timeout: 300  # Close idle connections
```

### 10k RPS: Redis Cluster (3 nodes)

```yaml
Instances: 3 × cache.r6g.large
Cost: $360/month
Mode: Cluster mode with sharding

Configuration:
  cluster-enabled: yes
  cluster-node-timeout: 5000
  cluster-replica-validity-factor: 10
```

### 100k+ RPS: Redis Cluster (6-20 nodes)

```yaml
Primary Nodes: 3-10
Replicas per Primary: 1-2
Total Nodes: 6-20

Example: 6 nodes (3 primary + 3 replica)
Cost: $720/month
```

---

## FastAPI Integration with Redis

### Installation

```bash
pip install redis[hiredis] aioredis
```

### Code Example

```python
import redis.asyncio as aioredis
from fastapi import FastAPI
import json

app = FastAPI()

# Redis connection pool
redis_client = None

@app.on_event("startup")
async def startup():
    global redis_client
    redis_client = await aioredis.from_url(
        "redis://redis:6379",
        encoding="utf-8",
        decode_responses=True,
        max_connections=50,  # Pool size
    )

@app.on_event("shutdown")
async def shutdown():
    await redis_client.close()

# Cache decorator
def cache_response(ttl: int = 60):
    def decorator(func):
        async def wrapper(*args, **kwargs):
            # Generate cache key from function name and arguments
            cache_key = f"{func.__name__}:{str(args)}:{str(kwargs)}"

            # Try cache first
            cached = await redis_client.get(cache_key)
            if cached:
                return json.loads(cached)

            # Cache miss - call function
            result = await func(*args, **kwargs)

            # Store in cache
            await redis_client.setex(
                cache_key,
                ttl,
                json.dumps(result)
            )

            return result
        return wrapper
    return decorator

# Example endpoint with caching
@app.get("/api/v1/user/{user_id}")
@cache_response(ttl=60)  # Cache for 60 seconds
async def get_user(user_id: int):
    # This will only hit DB on cache miss
    async with get_db_session(read_only=True) as session:
        result = await session.execute(
            "SELECT id, email, name FROM users WHERE id = :id",
            {"id": user_id}
        )
        user = result.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return {"id": user[0], "email": user[1], "name": user[2]}
```

---

## Caching Strategies

### 1. Cache-Aside (Lazy Loading)

**Pattern:** Check cache first, load from DB on miss, populate cache

```python
async def get_user_cache_aside(user_id: int):
    # Check cache
    cached = await redis_client.get(f"user:{user_id}")
    if cached:
        return json.loads(cached)

    # Cache miss - load from DB
    user = await db.fetch_user(user_id)

    # Populate cache
    await redis_client.setex(f"user:{user_id}", 60, json.dumps(user))

    return user
```

**Pros:** Simple, only caches what's needed
**Cons:** Cache miss penalty, thundering herd on popular keys

### 2. Write-Through Cache

**Pattern:** Update cache immediately when writing to DB

```python
async def update_user(user_id: int, data: dict):
    # Update database
    await db.update_user(user_id, data)

    # Update cache immediately
    await redis_client.setex(f"user:{user_id}", 60, json.dumps(data))
```

**Pros:** Cache always fresh, no cache miss penalty
**Cons:** Extra write overhead, caches rarely-accessed data

### 3. Refresh-Ahead

**Pattern:** Refresh cache proactively before expiration

```python
async def get_user_refresh_ahead(user_id: int):
    cached = await redis_client.get(f"user:{user_id}")
    ttl = await redis_client.ttl(f"user:{user_id}")

    # If TTL < 10 seconds, refresh in background
    if ttl < 10:
        asyncio.create_task(refresh_cache(user_id))

    if cached:
        return json.loads(cached)

    # Cache miss
    return await load_and_cache_user(user_id)
```

**Pros:** No cache miss penalty for popular keys
**Cons:** Complex, requires background tasks

---

## Cache Invalidation

### Time-Based (TTL)

```python
# Simple TTL
await redis_client.setex("user:123", 60, json.dumps(user_data))
```

### Event-Based

```python
# Invalidate on update
@app.put("/api/v1/user/{user_id}")
async def update_user(user_id: int, user: UserUpdate):
    # Update DB
    await db.update_user(user_id, user)

    # Invalidate cache
    await redis_client.delete(f"user:{user_id}")

    return {"status": "updated"}
```

### Pub/Sub for Distributed Invalidation

```python
# Publisher (when data changes)
await redis_client.publish("cache_invalidation", f"user:{user_id}")

# Subscriber (on each API instance)
pubsub = redis_client.pubsub()
await pubsub.subscribe("cache_invalidation")

async for message in pubsub.listen():
    if message['type'] == 'message':
        cache_key = message['data']
        await local_cache.delete(cache_key)  # Invalidate local cache
```

---

## Monitoring Redis

### Key Metrics

```bash
# Redis CLI
redis-cli INFO stats
redis-cli INFO memory

# Key metrics to track:
- keyspace_hits / keyspace_misses (hit rate)
- used_memory / maxmemory (memory usage)
- connected_clients (connection count)
- evicted_keys (how many keys evicted due to memory pressure)
- expired_keys (TTL-based evictions)
```

### Prometheus Metrics

```python
from prometheus_client import Counter, Histogram

cache_hits = Counter('cache_hits_total', 'Total cache hits')
cache_misses = Counter('cache_misses_total', 'Total cache misses')
cache_latency = Histogram('cache_operation_duration_seconds', 'Cache operation latency')

# Track in code
@cache_latency.time()
async def get_from_cache(key):
    result = await redis_client.get(key)
    if result:
        cache_hits.inc()
    else:
        cache_misses.inc()
    return result
```

---

## Cost-Benefit Analysis

### 10k RPS Example

**Without Redis:**
- DB Primary: db.r6i.2xlarge ($800/month)
- DB Replicas: 2 × db.r6i.xlarge ($800/month)
- Total DB: $1,600/month

**With Redis (80% cache hit rate):**
- DB Primary: db.r6i.large ($200/month) - Smaller instance!
- DB Replica: 1 × db.r6i.large ($200/month) - Fewer replicas needed
- Redis Cluster: 3 × cache.r6g.large ($360/month)
- Total: $760/month

**Savings: $840/month (52% reduction!)**

Plus:
- Better latency (50ms → 15ms p95)
- Lower database load
- Better user experience

---

## When to Add Redis

**✅ Add Redis when:**
- Database is the bottleneck (CPU > 60%)
- Read-heavy workload (> 70% reads)
- Same data queried repeatedly
- Acceptable to serve slightly stale data (TTL)

**❌ Don't add Redis if:**
- Write-heavy workload (> 50% writes)
- Every query is unique (low cache hit rate)
- Data must be 100% real-time
- Queries are already fast (< 10ms)

---

## Testing Cache Effectiveness

### Load Test with Cache Metrics

```javascript
// k6 script
export default function() {
  const response = http.get(`${BASE_URL}/api/v1/user/${userId}`);

  // Check cache header
  const cacheStatus = response.headers['X-Cache-Status'];

  check(response, {
    'cache hit': (r) => cacheStatus === 'HIT',
    'cache miss': (r) => cacheStatus === 'MISS',
  });
}
```

### Expected Results

```
Cache Hit Rate: 80-90%
p95 latency (cache hit): < 5ms
p95 latency (cache miss): < 50ms
DB QPS reduction: 70-90%
```

---

## Next Steps

1. Review [10k RPS with Redis](./10krps/README.md) for detailed configuration
2. See [Caching Patterns](./patterns/caching-strategies.md) for advanced techniques
3. Load test with [redis-k6-tests](../../load-tests/k6/redis-10krps.js)

---

**Last Updated:** 2025-11-16
**Status:** Overview complete, detailed guides pending for specific RPS levels
