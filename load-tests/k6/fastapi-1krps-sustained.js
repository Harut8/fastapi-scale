/**
 * k6 Load Test: FastAPI 1,000 RPS Sustained
 *
 * Purpose: Vertically scaled FastAPI deployment test
 * Target: 1,000 RPS sustained for 5 minutes
 * Expected: p95 < 12ms, p99 < 25ms, error rate < 0.01%
 *
 * Usage:
 *   k6 run fastapi-1krps-sustained.js
 *   k6 run --out cloud fastapi-1krps-sustained.js  # With k6 Cloud
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics
const errorRate = new Rate('error_rate');
const successRate = new Rate('success_rate');
const requestDuration = new Trend('request_duration_ms');
const activeVUs = new Gauge('active_vus');

// Configuration
const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:8000';
const TEST_DURATION = __ENV.TEST_DURATION || '300s';  // 5 minutes default

export const options = {
  scenarios: {
    sustained_1k_rps: {
      executor: 'constant-arrival-rate',
      rate: 1000,          // 1,000 requests per second
      timeUnit: '1s',
      duration: TEST_DURATION,
      preAllocatedVUs: 100,
      maxVUs: 200,
    },
  },

  thresholds: {
    // Latency SLOs
    'http_req_duration': [
      'p(50)<5',           // p50 < 5ms
      'p(95)<12',          // p95 < 12ms
      'p(99)<25',          // p99 < 25ms
      'avg<8',             // avg < 8ms
    ],

    // Error rate SLO: < 0.01%
    'http_req_failed': ['rate<0.0001'],
    'error_rate': ['rate<0.0001'],
    'success_rate': ['rate>0.9999'],

    // Throughput validation (±2%)
    'http_reqs': ['rate>=980', 'rate<=1020'],

    // No request should take > 100ms
    'http_req_duration{expected_response:true}': ['max<100'],
  },

  // Load test metadata
  ext: {
    loadimpact: {
      projectID: 3482147,
      name: 'FastAPI 1k RPS Sustained',
    },
  },
};

export function setup() {
  console.log(`🚀 Starting 1,000 RPS sustained load test`);
  console.log(`📍 Target: ${TARGET_URL}`);
  console.log(`⏱️  Duration: ${TEST_DURATION}`);

  // Health check
  const health = http.get(`${TARGET_URL}/health`);
  check(health, {
    'server is healthy': (r) => r.status === 200,
  }) || console.error(`❌ Health check failed: ${health.status}`);

  // Get server info if available
  const info = http.get(`${TARGET_URL}/api/v1/info`);
  if (info.status === 200) {
    const data = info.json();
    console.log(`📦 Server version: ${data.version || 'unknown'}`);
    console.log(`⚙️  Workers: ${data.workers || 'unknown'}`);
  }

  return {
    healthy: health.status === 200,
    startTime: Date.now(),
  };
}

export default function (data) {
  if (!data.healthy) {
    return;
  }

  activeVUs.add(__VU);

  // Make request
  const response = http.get(`${TARGET_URL}/api/v1/compute`, {
    tags: {
      name: 'ComputeEndpoint',
      test_type: 'sustained',
    },
    timeout: '5s',
  });

  // Record metrics
  requestDuration.add(response.timings.duration);

  // Check response
  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time OK': (r) => r.timings.duration < 50,
    'has result field': (r) => r.json('result') !== undefined,
  });

  if (success) {
    successRate.add(1);
    errorRate.add(0);
  } else {
    successRate.add(0);
    errorRate.add(1);

    // Log failures (but not too often to avoid spamming)
    if (Math.random() < 0.01) {  // Log 1% of failures
      console.error(
        `❌ Request failed: ` +
        `status=${response.status} ` +
        `duration=${response.timings.duration.toFixed(2)}ms ` +
        `vu=${__VU} iter=${__ITER}`
      );
    }
  }

  // Tiny sleep to prevent tight loop
  sleep(0.01);
}

export function teardown(data) {
  if (!data.healthy) {
    console.log('⚠️  Test aborted - server was not healthy');
    return;
  }

  const durationSec = (Date.now() - data.startTime) / 1000;
  console.log(`\n✅ Test completed successfully`);
  console.log(`⏱️  Total duration: ${durationSec.toFixed(2)}s`);
  console.log(`📊 Review detailed metrics above`);
}

/**
 * Expected Output (5-minute test):
 *
 * ✓ status is 200
 * ✓ response time OK
 * ✓ has result field
 *
 * checks.........................: 100.00% ✓ 900000 ✗ 0
 * data_received..................: 540 MB  1.8 MB/s
 * data_sent......................: 180 MB  600 kB/s
 * error_rate.....................: 0.00%   ✓ 0      ✗ 300000
 * http_req_blocked...............: avg=45µs   p(95)=95µs   p(99)=180µs  max=5ms
 * http_req_connecting............: avg=8µs    p(95)=18µs   p(99)=35µs   max=2ms
 * http_req_duration..............: avg=4.2ms  p(95)=10ms   p(99)=18ms   max=45ms
 * http_req_failed................: 0.00%   ✓ 0      ✗ 300000
 * http_req_receiving.............: avg=95µs   p(95)=185µs  p(99)=320µs  max=3ms
 * http_req_sending...............: avg=42µs   p(95)=75µs   p(99)=115µs  max=1ms
 * http_req_waiting...............: avg=4.1ms  p(95)=9.8ms  p(99)=17.5ms max=44ms
 * http_reqs......................: 300000  1000/s
 * iteration_duration.............: avg=10.5ms p(95)=15ms   p(99)=22ms   max=55ms
 * iterations.....................: 300000  1000/s
 * request_duration_ms............: avg=4.2ms  p(95)=10ms   p(99)=18ms   max=45ms
 * success_rate...................: 100.00% ✓ 300000 ✗ 0
 * vus............................: 100     min=100  max=150
 * vus_max........................: 200     min=200  max=200
 *
 * ✅ All thresholds passed
 */
