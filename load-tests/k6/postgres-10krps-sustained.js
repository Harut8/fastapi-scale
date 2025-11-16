/**
 * k6 Load Test: FastAPI + PostgreSQL 10k RPS
 *
 * Purpose: Test FastAPI with PostgreSQL under realistic read/write workload
 * Target: 10,000 RPS with 60% DB hit rate (6,000 QPS to database)
 * Expected: p95 < 50ms, p99 < 100ms, error rate < 0.01%
 *
 * Usage:
 *   k6 run --vus 500 --duration 10m postgres-10krps-sustained.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics
const errorRate = new Rate('error_rate');
const dbQueryDuration = new Trend('db_query_duration_ms');
const readQueries = new Counter('read_queries');
const writeQueries = new Counter('write_queries');
const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const DB_HIT_RATE = parseFloat(__ENV.DB_HIT_RATE || '0.6');  // 60% hit DB
const READ_WRITE_RATIO = parseFloat(__ENV.READ_WRITE_RATIO || '0.8');  // 80% reads

export const options = {
  scenarios: {
    postgres_10k_rps: {
      executor: 'constant-arrival-rate',
      rate: 10000,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },

  thresholds: {
    // Latency SLOs (higher with database)
    'http_req_duration': [
      'p(50)<15',   // p50 < 15ms
      'p(95)<50',   // p95 < 50ms (critical)
      'p(99)<100',  // p99 < 100ms
      'avg<30',
    ],

    // Error rate
    'http_req_failed': ['rate<0.0001'],
    'error_rate': ['rate<0.0001'],

    // Throughput
    'http_reqs': ['rate>=9900', 'rate<=10100'],

    // Database-specific
    'db_query_duration_ms': ['p(95)<40', 'p(99)<80'],
  },
};

// Setup: Create test data (if needed)
export function setup() {
  console.log(`🚀 Starting FastAPI + PostgreSQL 10k RPS Test`);
  console.log(`📍 Target: ${BASE_URL}`);
  console.log(`🗄️  DB Hit Rate: ${DB_HIT_RATE * 100}%`);
  console.log(`📖 Read/Write Ratio: ${READ_WRITE_RATIO * 100}% reads`);

  // Health check
  const health = http.get(`${BASE_URL}/health`);
  if (health.status !== 200) {
    console.error(`❌ Health check failed: ${health.status}`);
    return { healthy: false };
  }

  console.log(`✅ Health check passed\n`);
  return {
    healthy: true,
    startTime: Date.now(),
  };
}

// Main test function
export default function(data) {
  if (!data.healthy) {
    return;
  }

  // Decide if this request should hit the database
  const shouldHitDB = Math.random() < DB_HIT_RATE;

  let response;

  if (shouldHitDB) {
    // Database request
    const isRead = Math.random() < READ_WRITE_RATIO;

    if (isRead) {
      // Read query (GET user by ID)
      const userId = Math.floor(Math.random() * 10000000) + 1;
      const startTime = Date.now();

      response = http.get(`${BASE_URL}/api/v1/user/${userId}`, {
        tags: {
          operation: 'db_read',
          endpoint: 'get_user',
        },
      });

      const duration = Date.now() - startTime;
      dbQueryDuration.add(duration);
      readQueries.add(1);

      check(response, {
        'read: status is 200 or 404': (r) => r.status === 200 || r.status === 404,
        'read: response time OK': (r) => r.timings.duration < 100,
      });

    } else {
      // Write query (POST create user)
      const payload = JSON.stringify({
        email: `user_${Date.now()}_${randomString(8)}@example.com`,
        name: `Test User ${randomString(10)}`,
      });

      const startTime = Date.now();

      response = http.post(`${BASE_URL}/api/v1/user`, payload, {
        headers: { 'Content-Type': 'application/json' },
        tags: {
          operation: 'db_write',
          endpoint: 'create_user',
        },
      });

      const duration = Date.now() - startTime;
      dbQueryDuration.add(duration);
      writeQueries.add(1);

      check(response, {
        'write: status is 201': (r) => r.status === 201,
        'write: has user ID': (r) => r.json('id') !== undefined,
        'write: response time OK': (r) => r.timings.duration < 150,
      });
    }

  } else {
    // Non-database request (compute-only, should be cached or fast)
    response = http.get(`${BASE_URL}/api/v1/compute?iterations=5000`, {
      tags: {
        operation: 'compute',
        endpoint: 'compute',
      },
    });

    // Check if response was cached (via headers)
    const wasCached = response.headers['X-Cache'] === 'HIT';
    if (wasCached) {
      cacheHits.add(1);
    } else {
      cacheMisses.add(1);
    }

    check(response, {
      'compute: status is 200': (r) => r.status === 200,
      'compute: has result': (r) => r.json('result') !== undefined,
      'compute: fast response': (r) => r.timings.duration < 20,
    });
  }

  // Track errors
  const success = response.status >= 200 && response.status < 400;
  errorRate.add(success ? 0 : 1);

  if (!success) {
    console.error(
      `❌ Request failed: status=${response.status}, ` +
      `body=${response.body.substring(0, 100)}`
    );
  }

  // Minimal sleep
  sleep(0.001);
}

// Teardown
export function teardown(data) {
  if (!data.healthy) {
    console.log('\n⚠️  Test aborted - server not healthy\n');
    return;
  }

  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`\n✅ Test completed in ${duration.toFixed(2)}s`);
  console.log(`📊 Check detailed results above\n`);
}

/**
 * Expected Output (10-minute test @ 10k RPS):
 *
 * ✓ read: status is 200 or 404
 * ✓ read: response time OK
 * ✓ write: status is 201
 * ✓ write: has user ID
 * ✓ write: response time OK
 * ✓ compute: status is 200
 * ✓ compute: has result
 * ✓ compute: fast response
 *
 * cache_hits........................: 240000  400/s
 * cache_misses......................: 0       0/s
 * data_received....................: 3.6 GB  6 MB/s
 * data_sent........................: 1.8 GB  3 MB/s
 * db_query_duration_ms.............: avg=12ms   p(95)=35ms  p(99)=65ms  max=150ms
 * error_rate.......................: 0.00%   ✓ 0        ✗ 6000000
 * http_req_blocked.................: avg=45µs   p(95)=95µs  p(99)=180µs max=15ms
 * http_req_connecting..............: avg=8µs    p(95)=18µs  p(99)=35µs  max=5ms
 * http_req_duration................: avg=18ms   p(95)=45ms  p(99)=85ms  max=200ms
 *   { operation:compute }...........: avg=5ms    p(95)=12ms  p(99)=20ms  max=50ms
 *   { operation:db_read }...........: avg=15ms   p(95)=40ms  p(99)=75ms  max=180ms
 *   { operation:db_write }..........: avg=25ms   p(95)=60ms  p(99)=100ms max=200ms
 * http_req_failed..................: 0.00%   ✓ 0        ✗ 6000000
 * http_req_receiving...............: avg=95µs   p(95)=185µs p(99)=320µs max=5ms
 * http_req_sending.................: avg=42µs   p(95)=75µs  p(99)=115µs max=2ms
 * http_req_waiting.................: avg=17.8ms p(95)=44.5ms p(99)=84ms max=195ms
 * http_reqs........................: 6000000 10000/s
 * iteration_duration...............: avg=18.5ms p(95)=46ms  p(99)=86ms  max=205ms
 * iterations.......................: 6000000 10000/s
 * read_queries.....................: 2880000 4800/s  (80% of 6000 DB QPS)
 * write_queries....................: 720000  1200/s  (20% of 6000 DB QPS)
 * vus..............................: 500     min=500    max=850
 * vus_max..........................: 1000    min=1000   max=1000
 *
 * ✅ All thresholds passed
 *
 * Database Metrics (verify separately):
 * - Primary QPS: ~1200 (writes)
 * - Replica QPS: ~2400 per replica (reads)
 * - Connection count: 70-80 (via PgBouncer)
 * - Replication lag: < 100ms
 * - Primary CPU: 30-40%
 * - Replica CPU: 25-35%
 */
