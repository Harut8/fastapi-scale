# Scaling FastAPI to 1M RPS: Staff-Level Engineering Guide

**Version:** 1.0
**Status:** Draft
**Target Audience:** SRE, Backend Engineering, Database Engineering, Product Owners
**Last Updated:** 2025-11-16

## Executive Summary

This document provides a comprehensive, reproducible engineering plan for scaling a FastAPI application from 100 RPS to 1M RPS across four technology stacks:

1. **FastAPI only** - Pure compute scaling
2. **FastAPI + PostgreSQL** - Adding persistent data layer
3. **FastAPI + PostgreSQL + Redis** - Adding caching layer
4. **FastAPI + PostgreSQL + Redis + RabbitMQ** - Full async messaging stack

Each configuration includes:
- Quantitative capacity formulas and calculations
- Hardware sizing and cost estimates
- Software tuning parameters
- Load testing plans and acceptance criteria
- Observability strategy and SLOs
- Runbooks for common failure modes
- Migration paths with risk analysis

## Quick Navigation

### By Stack
- [FastAPI Only](./docs/fastapi-only/README.md) - **START HERE**
- [FastAPI + PostgreSQL](./docs/fastapi-postgres/README.md)
- [FastAPI + PostgreSQL + Redis](./docs/fastapi-postgres-redis/README.md)
- [Full Stack (+ RabbitMQ)](./docs/full-stack/README.md)

### By Throughput Target
- [100 RPS](./docs/fastapi-only/100rps/README.md) - Single host baseline
- [1k RPS](./docs/fastapi-only/1krps/README.md) - Vertical scaling
- [10k RPS](./docs/fastapi-only/10krps/README.md) - Multi-host horizontal scaling
- [100k RPS](./docs/fastapi-only/100krps/README.md) - Auto-scaling clusters
- [1M RPS](./docs/fastapi-only/1mrps/README.md) - Large-scale distributed system

### Supporting Resources
- [Capacity Planning Formulas](./calculations/README.md)
- [Load Testing Guide](./load-tests/README.md)
- [Deployment Configurations](./deployments/README.md)
- [Runbooks](./runbooks/README.md)
- [Architecture Diagrams](./diagrams/README.md)
- [One-Week Sprint Plan](./docs/sprint-plan.md)

## Key Assumptions & Baseline Metrics

All calculations and recommendations are based on these standardized assumptions. Adjust for your specific workload:

### Request Profile
- **Average request payload:** 1 KB
- **Average response payload:** 2 KB
- **Request mix:**
  - 40% read-only operations
  - 40% read-write operations
  - 20% write-only operations

### Performance Targets (SLOs)
- **p50 latency:** < 10ms (FastAPI only), < 50ms (with DB)
- **p95 latency:** < 25ms (FastAPI only), < 100ms (with DB)
- **p99 latency:** < 50ms (FastAPI only), < 200ms (with DB)
- **Error rate:** < 0.1%
- **Availability:** 99.9% (three nines)

### Infrastructure Assumptions
- **Network:** 10 Gbps links between services
- **Cloud provider:** Generic cloud (AWS/GCP/Azure equivalent)
- **Region:** Single region, 3 availability zones
- **Instance baseline:** 4 vCPU, 16 GB RAM (mid-tier compute)

### Component Timing (per operation)
- **FastAPI handler (CPU-bound):** 2-5ms
- **PostgreSQL query (simple SELECT):** 1-2ms
- **PostgreSQL transaction (UPDATE):** 3-5ms
- **Redis GET:** 0.5-1ms
- **Redis SET:** 0.5-1ms
- **RabbitMQ publish:** 0.3-0.5ms
- **RabbitMQ consume + process:** 5-10ms

### Database Access Patterns
- **% requests hitting database:** 60%
- **% requests hitting Redis cache:** 50%
- **% requests publishing to queue:** 30%
- **Cache hit rate (target):** 80-90%

## Cost Summary (Monthly USD)

Approximate monthly costs for each target at production scale with 3x headroom:

| RPS Target | FastAPI Only | + PostgreSQL | + Redis | + RabbitMQ |
|------------|--------------|--------------|---------|------------|
| 100        | $50          | $150         | $180    | $220       |
| 1,000      | $200         | $600         | $720    | $850       |
| 10,000     | $1,500       | $4,500       | $5,200  | $6,000     |
| 100,000    | $15,000      | $45,000      | $52,000 | $60,000    |
| 1,000,000  | $150,000     | $450,000     | $520,000| $600,000   |

*Note: Estimates include compute, storage, network egress, and managed service fees. Does not include data transfer, backups, or DR.*

## Server Count Summary

Estimated server counts per stack/target (production + 50% headroom):

| RPS Target | API Servers | DB Primaries | DB Replicas | Redis Nodes | RabbitMQ Nodes |
|------------|-------------|--------------|-------------|-------------|----------------|
| 100        | 1           | -            | -           | -           | -              |
| 1,000      | 2           | 1            | 1           | 1           | 1              |
| 10,000     | 8           | 1            | 2           | 3 (cluster) | 3 (cluster)    |
| 100,000    | 80          | 1            | 5           | 6 (cluster) | 5 (cluster)    |
| 1,000,000  | 500         | 3 (sharded)  | 15          | 20 (cluster)| 10 (cluster)   |

## Quick Start: Testing Each Level

```bash
# 1. FastAPI only - 100 RPS
cd deployments/docker-compose/fastapi-only
docker-compose up -d
cd ../../../load-tests/k6
k6 run --vus 10 --duration 60s fastapi-only-100rps.js

# 2. FastAPI + PostgreSQL - 1k RPS
cd ../../deployments/docker-compose/fastapi-postgres
docker-compose up -d
cd ../../../load-tests/k6
k6 run --vus 100 --duration 60s fastapi-postgres-1krps.js

# 3. Full stack - 10k RPS (requires Kubernetes)
kubectl apply -f deployments/kubernetes/full-stack/
cd load-tests/k6
k6 run --vus 1000 --duration 300s full-stack-10krps.js
```

## Document Structure

### 1. Stack-Specific Analysis
Each stack (`fastapi-only`, `fastapi-postgres`, etc.) contains:
- **Overview:** Architecture patterns and scaling philosophy
- **RPS-level guides:** Detailed analysis per throughput target
- **Capacity formulas:** Mathematical models for sizing
- **Configuration templates:** Production-ready configs

### 2. RPS-Level Deep Dives
Each RPS target includes:
- **Architecture diagram:** Component topology
- **Bottleneck analysis:** What breaks first and why
- **Hardware sizing:** CPU, memory, network, IOPS
- **Software tuning:** Worker counts, connection pools, GC settings
- **Load test results:** Actual measurements from staging
- **Cost breakdown:** Per-component pricing
- **Migration path:** How to upgrade from previous level

### 3. Operational Guides
- **Runbooks:** Step-by-step failure recovery procedures
- **Observability:** Metrics, dashboards, alerts
- **SLO definitions:** Quantitative success criteria
- **Capacity planning:** When to scale up/out

## Validation Criteria

This document is considered complete when:

✓ All formulas are traceable and reproducible
✓ Load tests validate at least 2 scenarios per stack/RPS level
✓ Hardware sizing matches observed resource usage within 20%
✓ Runbooks cover top 10 failure modes with tabletop validation
✓ Migration paths tested in staging environment
✓ Cost estimates verified against actual cloud pricing

## How to Use This Document

**For SREs:**
Start with [Runbooks](./runbooks/README.md) and [Observability Strategy](./docs/observability.md). Review capacity formulas for on-call sizing decisions.

**For Backend Engineers:**
Begin with [FastAPI Tuning Guide](./docs/fastapi-only/tuning.md). Progress through each stack incrementally. Reference load test scripts for validation.

**For Database Engineers:**
Jump to [PostgreSQL Scaling](./docs/fastapi-postgres/README.md) and [Sharding Strategies](./docs/fastapi-postgres/1mrps/README.md#sharding).

**For Product Owners:**
Review [Cost Summary](#cost-summary) and [Executive Summaries](./docs/executive-summaries.md). Each RPS level includes a one-page TL;DR.

## Priority Roadmap

**Phase 1: FastAPI-Only (Weeks 1-2)**
✓ 100 RPS baseline
✓ 1k RPS vertical scaling
✓ 10k RPS horizontal scaling
- 100k RPS auto-scaling
- 1M RPS large-scale deployment

**Phase 2: Add PostgreSQL (Weeks 3-4)**
- Connection pooling and read replicas
- Query optimization and indexing
- Partitioning and sharding at scale

**Phase 3: Add Redis (Week 5)**
- Caching strategies
- Redis Cluster configuration
- Cache invalidation patterns

**Phase 4: Add RabbitMQ (Week 6)**
- Async processing patterns
- Queue clustering and HA
- Message durability and delivery guarantees

**Phase 5: Integration & Validation (Week 7)**
- End-to-end load testing
- Failure mode validation
- Documentation review and finalization

## Contributing Authors

- SRE Team: Capacity planning, runbooks, observability
- Backend Team: FastAPI tuning, code patterns, load testing
- Database Team: PostgreSQL optimization, sharding strategies
- Infrastructure Team: Kubernetes configs, auto-scaling policies

## References

- [FastAPI Official Docs](https://fastapi.tiangolo.com/)
- [Uvicorn Deployment](https://www.uvicorn.org/deployment/)
- [PostgreSQL Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Redis Cluster Specification](https://redis.io/topics/cluster-spec)
- [RabbitMQ Clustering Guide](https://www.rabbitmq.com/clustering.html)
- [Google SRE Book - Capacity Planning](https://sre.google/sre-book/service-level-objectives/)

## Next Steps

1. **Read:** [FastAPI-Only 100 RPS Guide](./docs/fastapi-only/100rps/README.md)
2. **Deploy:** Use [docker-compose](./deployments/docker-compose/) for local testing
3. **Test:** Run [k6 scripts](./load-tests/k6/) to validate
4. **Scale:** Follow migration paths to reach your target RPS

---

**Questions?** Open an issue or contact the SRE team.
**Found an error?** Submit a PR with corrections and test results.
