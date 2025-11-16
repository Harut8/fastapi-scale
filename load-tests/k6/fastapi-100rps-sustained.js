/**
 * k6 Load Test: FastAPI 100 RPS Sustained
 *
 * Purpose: Baseline performance test for single-host FastAPI deployment
 * Target: 100 RPS sustained for 60 seconds
 * Expected: p95 < 10ms, p99 < 20ms, error rate < 0.1%
 *
 * Usage:
 *   k6 run --vus 10 --duration 60s fastapi-100rps-sustained.js
 *
 * Or with environment variables:
 *   TARGET_URL=https://api.example.com k6 run fastapi-100rps-sustained.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('error_rate');
const successRate = new Rate('success_rate');
const requestDuration = new Trend('request_duration_ms');
const requestsPerSecond = new Counter('requests_per_second');

// Configuration
const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:8000';

export const options = {
  scenarios: {
    sustained_load: {
      executor: 'constant-arrival-rate',
      rate: 100,           // 100 requests per...
      timeUnit: '1s',      // ...second
      duration: '60s',     // Total test duration
      preAllocatedVUs: 10, // Initial VUs
      maxVUs: 20,          // Max VUs if needed
    },
  },

  thresholds: {
    // SLO: p50 < 10ms
    'http_req_duration': [
      'p(50)<10',
      'p(95)<25',
      'p(99)<50',
    ],
    // SLO: < 0.1% error rate
    'http_req_failed': ['rate<0.001'],
    'error_rate': ['rate<0.001'],
    'success_rate': ['rate>0.999'],

    // Ensure we're actually hitting target RPS
    'http_reqs': ['rate>=99', 'rate<=101'],
  },
};

// Setup function (runs once before test)
export function setup() {
  console.log(`🚀 Starting 100 RPS sustained load test`);
  console.log(`📍 Target: ${TARGET_URL}`);

  // Warm-up request
  const warmup = http.get(`${TARGET_URL}/health`);
  if (warmup.status !== 200) {
    console.error(`❌ Warmup failed: ${warmup.status}`);
    return { healthy: false };
  }

  console.log(`✅ Server is healthy, starting test...`);
  return { healthy: true, startTime: Date.now() };
}

// Main test function (runs for each VU)
export default function (data) {
  if (!data.healthy) {
    console.error('Server not healthy, aborting test');
    return;
  }

  const response = http.get(`${TARGET_URL}/api/v1/compute`, {
    tags: { name: 'ComputeEndpoint' },
  });

  // Record custom metrics
  requestsPerSecond.add(1);
  requestDuration.add(response.timings.duration);

  // Validate response
  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 50ms': (r) => r.timings.duration < 50,
    'response has result': (r) => r.json('result') !== undefined,
    'response has timestamp': (r) => r.json('timestamp') !== undefined,
  });

  if (success) {
    successRate.add(1);
    errorRate.add(0);
  } else {
    successRate.add(0);
    errorRate.add(1);
    console.error(`❌ Request failed: status=${response.status}, duration=${response.timings.duration}ms`);
  }

  // Small sleep to prevent VU from busy-looping
  sleep(0.1);
}

// Teardown function (runs once after test)
export function teardown(data) {
  if (!data.healthy) {
    console.log('⚠️  Test aborted due to unhealthy server');
    return;
  }

  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`\n✅ Test completed in ${duration.toFixed(2)}s`);
  console.log(`📊 Check full results above`);
}

/**
 * Expected Output:
 *
 * checks.........................: 100.00% ✓ 24000 ✗ 0
 * data_received..................: 3.6 MB  60 kB/s
 * data_sent......................: 1.2 MB  20 kB/s
 * http_req_blocked...............: avg=50µs   min=20µs  med=40µs   max=1ms   p(95)=100µs  p(99)=200µs
 * http_req_connecting............: avg=10µs   min=0s    med=0s     max=500µs p(95)=20µs   p(99)=50µs
 * http_req_duration..............: avg=3.5ms  min=1ms   med=3ms    max=15ms  p(95)=8ms    p(99)=12ms
 * http_req_failed................: 0.00%   ✓ 0     ✗ 6000
 * http_req_receiving.............: avg=100µs  min=50µs  med=80µs   max=500µs p(95)=200µs  p(99)=300µs
 * http_req_sending...............: avg=50µs   min=20µs  med=40µs   max=200µs p(95)=80µs   p(99)=120µs
 * http_req_tls_handshaking.......: avg=0s     min=0s    med=0s     max=0s    p(95)=0s     p(99)=0s
 * http_req_waiting...............: avg=3.4ms  min=1ms   med=3ms    max=14ms  p(95)=7.8ms  p(99)=11.5ms
 * http_reqs......................: 6000    100/s
 * iteration_duration.............: avg=103ms  min=101ms med=103ms  max=115ms p(95)=108ms  p(99)=112ms
 * iterations.....................: 6000    100/s
 * vus............................: 10      min=10  max=20
 * vus_max........................: 20      min=20  max=20
 */
