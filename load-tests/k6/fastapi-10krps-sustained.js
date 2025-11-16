/**
 * k6 Load Test: FastAPI 10,000 RPS Sustained
 *
 * Purpose: Distributed FastAPI deployment with load balancing
 * Target: 10,000 RPS sustained for 30 minutes
 * Expected: p95 < 15ms, p99 < 30ms, error rate < 0.01%
 *
 * Requirements:
 *   - Load generator: c6i.8xlarge or equivalent (32 vCPU minimum)
 *   - k6 version: 0.45+ (for high RPS support)
 *
 * Usage:
 *   k6 run --vus 500 --duration 30m fastapi-10krps-sustained.js
 *   k6 run --out json=results.json fastapi-10krps-sustained.js
 *   k6 run --out influxdb=http://influxdb:8086 fastapi-10krps-sustained.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Custom metrics
const errorRate = new Rate('error_rate');
const successRate = new Rate('success_rate');
const requestDuration = new Trend('request_duration_ms', true);  // Enable time series
const timeouts = new Counter('timeout_errors');
const serverErrors = new Counter('5xx_errors');
const clientErrors = new Counter('4xx_errors');
const activeConnections = new Gauge('active_connections');

// Configuration
const TARGET_URL = __ENV.TARGET_URL || 'https://api.example.com';
const TEST_DURATION = __ENV.TEST_DURATION || '30m';
const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '10000');
const ENABLE_LOGGING = __ENV.ENABLE_LOGGING === 'true';

export const options = {
  scenarios: {
    sustained_10k_rps: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: TEST_DURATION,
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },

  thresholds: {
    // Latency SLOs for 10k RPS
    'http_req_duration': [
      'p(50)<5',           // p50 < 5ms
      'p(95)<15',          // p95 < 15ms  ⚠️ Critical SLO
      'p(99)<30',          // p99 < 30ms  ⚠️ Critical SLO
      'avg<10',            // avg < 10ms
      'max<200',           // No request should take > 200ms
    ],

    // Error rate SLO: < 0.01% (1 error per 10,000 requests)
    'http_req_failed': ['rate<0.0001'],
    'error_rate': ['rate<0.0001'],
    'success_rate': ['rate>0.9999'],

    // Throughput validation (±1% tolerance)
    'http_reqs': ['rate>=9900', 'rate<=10100'],

    // Connection metrics
    'http_req_connecting': ['p(95)<10'],  // Connection establishment < 10ms
    'http_req_tls_handshaking': ['p(95)<20'],  // TLS handshake < 20ms

    // Specific error type thresholds
    '5xx_errors': ['count<10'],  // < 10 server errors total
    '4xx_errors': ['count<100'], // < 100 client errors total
    'timeout_errors': ['count<5'],  // < 5 timeouts total
  },

  // Output configuration
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'p(99.99)'],

  // HTTP settings
  insecureSkipTLSVerify: false,  // Validate SSL certificates
  noConnectionReuse: false,      // Enable connection reuse
  userAgent: 'k6-load-test/1.0 (FastAPI 10k RPS)',

  // Batch settings (for performance)
  batch: 10,
  batchPerHost: 10,
};

// Setup: Validate target is ready for testing
export function setup() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 FastAPI 10,000 RPS Load Test`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📍 Target:          ${TARGET_URL}`);
  console.log(`⏱️  Duration:        ${TEST_DURATION}`);
  console.log(`📊 Target RPS:      ${TARGET_RPS.toLocaleString()}`);
  console.log(`👥 Max VUs:         1,000`);
  console.log(`🔍 Logging:         ${ENABLE_LOGGING ? 'enabled' : 'disabled'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Validate health endpoint
  console.log('🔍 Validating target health...');
  const healthResponse = http.get(`${TARGET_URL}/health`, {
    timeout: '10s',
  });

  if (healthResponse.status !== 200) {
    console.error(`❌ Health check failed!`);
    console.error(`   Status: ${healthResponse.status}`);
    console.error(`   Body: ${healthResponse.body}`);
    return { healthy: false };
  }

  console.log(`✅ Health check passed`);

  // Warmup: Send small load to warm up server
  console.log('🔥 Warming up server (10 seconds @ 100 RPS)...');
  const warmupStart = Date.now();
  let warmupRequests = 0;
  let warmupErrors = 0;

  while ((Date.now() - warmupStart) < 10000) {
    const warmupRes = http.get(`${TARGET_URL}/api/v1/compute`);
    warmupRequests++;
    if (warmupRes.status !== 200) warmupErrors++;
    sleep(0.01);
  }

  console.log(`✅ Warmup complete: ${warmupRequests} requests, ${warmupErrors} errors`);

  if (warmupErrors > warmupRequests * 0.05) {
    console.error(`❌ Warmup error rate too high: ${(warmupErrors/warmupRequests*100).toFixed(2)}%`);
    return { healthy: false };
  }

  console.log(`\n🏁 Starting main load test...\n`);

  return {
    healthy: true,
    startTime: Date.now(),
    warmupRequests,
    warmupErrors,
  };
}

// Main test logic
export default function (data) {
  if (!data || !data.healthy) {
    console.error('❌ Test aborted - setup failed');
    return;
  }

  activeConnections.add(1);

  // Execute request with timeout
  const response = http.get(`${TARGET_URL}/api/v1/compute`, {
    tags: {
      name: 'ComputeEndpoint',
      test_type: 'sustained_10k',
      iteration: __ITER,
    },
    timeout: '5s',
  });

  // Record timing metrics
  requestDuration.add(response.timings.duration);

  // Detailed response validation
  const checks = check(response, {
    'status is 200': (r) => r.status === 200,
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'response time < 50ms': (r) => r.timings.duration < 50,
    'response time < 100ms': (r) => r.timings.duration < 100,
    'has result field': (r) => {
      try {
        return r.json('result') !== undefined;
      } catch (e) {
        return false;
      }
    },
    'has timestamp': (r) => {
      try {
        return r.json('timestamp') !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  // Track success/failure
  const isSuccess = response.status === 200;
  successRate.add(isSuccess ? 1 : 0);
  errorRate.add(isSuccess ? 0 : 1);

  // Track specific error types
  if (response.status === 0) {
    timeouts.add(1);
    if (ENABLE_LOGGING) {
      console.error(`⏱️  Timeout: VU=${__VU} Iter=${__ITER}`);
    }
  } else if (response.status >= 500) {
    serverErrors.add(1);
    if (ENABLE_LOGGING && Math.random() < 0.1) {  // Log 10% of 5xx errors
      console.error(`🔴 5xx Error: status=${response.status} VU=${__VU}`);
    }
  } else if (response.status >= 400 && response.status < 500) {
    clientErrors.add(1);
    if (ENABLE_LOGGING && Math.random() < 0.01) {  // Log 1% of 4xx errors
      console.warn(`🟡 4xx Error: status=${response.status} VU=${__VU}`);
    }
  }

  // Log slow requests (> 50ms) occasionally
  if (ENABLE_LOGGING && response.timings.duration > 50 && Math.random() < 0.01) {
    console.warn(
      `🐌 Slow request: ${response.timings.duration.toFixed(2)}ms ` +
      `(waiting=${response.timings.waiting.toFixed(2)}ms) ` +
      `VU=${__VU}`
    );
  }

  activeConnections.add(-1);

  // Minimal sleep to prevent CPU spin
  sleep(0.001);
}

// Teardown: Summarize results
export function teardown(data) {
  if (!data || !data.healthy) {
    console.log('\n⚠️  Test was aborted - setup failed\n');
    return;
  }

  const totalDuration = (Date.now() - data.startTime) / 1000;
  const totalMinutes = Math.floor(totalDuration / 60);
  const totalSeconds = Math.floor(totalDuration % 60);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 Test Summary`);
  console.log(`${'='.repeat(60)}`);
  console.log(`⏱️  Total duration: ${totalMinutes}m ${totalSeconds}s`);
  console.log(`🔥 Warmup: ${data.warmupRequests} requests, ${data.warmupErrors} errors`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n✅ Load test completed. Check detailed metrics above.\n`);
}

// Custom summary for better reporting
export function handleSummary(data) {
  const testPassed = (
    data.metrics.http_req_failed?.values?.rate < 0.0001 &&
    data.metrics['http_req_duration']?.values?.['p(95)'] < 15 &&
    data.metrics['http_req_duration']?.values?.['p(99)'] < 30
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎯 SLO Validation`);
  console.log(`${'='.repeat(60)}`);
  console.log(`p95 latency:  ${data.metrics['http_req_duration']?.values?.['p(95)']?.toFixed(2)}ms  ${data.metrics['http_req_duration']?.values?.['p(95)'] < 15 ? '✅' : '❌'} (< 15ms)`);
  console.log(`p99 latency:  ${data.metrics['http_req_duration']?.values?.['p(99)']?.toFixed(2)}ms  ${data.metrics['http_req_duration']?.values?.['p(99)'] < 30 ? '✅' : '❌'} (< 30ms)`);
  console.log(`Error rate:   ${(data.metrics.http_req_failed?.values?.rate * 100 || 0).toFixed(4)}%  ${data.metrics.http_req_failed?.values?.rate < 0.0001 ? '✅' : '❌'} (< 0.01%)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n${testPassed ? '✅ ALL SLOs PASSED' : '❌ SOME SLOs FAILED'}\n`);

  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data, null, 2),
    'summary.html': htmlReport(data, testPassed),
  };
}

// Generate simple HTML report
function htmlReport(data, testPassed) {
  const metrics = data.metrics;
  return `
<!DOCTYPE html>
<html>
<head>
  <title>FastAPI 10k RPS Load Test Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: ${testPassed ? '#2ecc71' : '#e74c3c'}; }
    .metric { display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid #eee; }
    .metric-name { font-weight: bold; }
    .metric-value { color: #555; }
    .pass { color: #2ecc71; font-weight: bold; }
    .fail { color: #e74c3c; font-weight: bold; }
    .section { margin-top: 30px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${testPassed ? '✅' : '❌'} FastAPI 10,000 RPS Load Test Results</h1>

    <div class="section">
      <h2>SLO Validation</h2>
      <div class="metric">
        <span class="metric-name">p95 Latency:</span>
        <span class="metric-value ${metrics['http_req_duration']?.values?.['p(95)'] < 15 ? 'pass' : 'fail'}">
          ${metrics['http_req_duration']?.values?.['p(95)']?.toFixed(2)}ms (target: < 15ms)
        </span>
      </div>
      <div class="metric">
        <span class="metric-name">p99 Latency:</span>
        <span class="metric-value ${metrics['http_req_duration']?.values?.['p(99)'] < 30 ? 'pass' : 'fail'}">
          ${metrics['http_req_duration']?.values?.['p(99)']?.toFixed(2)}ms (target: < 30ms)
        </span>
      </div>
      <div class="metric">
        <span class="metric-name">Error Rate:</span>
        <span class="metric-value ${metrics.http_req_failed?.values?.rate < 0.0001 ? 'pass' : 'fail'}">
          ${((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(4)}% (target: < 0.01%)
        </span>
      </div>
    </div>

    <div class="section">
      <h2>Performance Metrics</h2>
      <div class="metric"><span class="metric-name">Average RPS:</span><span class="metric-value">${metrics.http_reqs?.values?.rate?.toFixed(2)}</span></div>
      <div class="metric"><span class="metric-name">Total Requests:</span><span class="metric-value">${metrics.http_reqs?.values?.count?.toLocaleString()}</span></div>
      <div class="metric"><span class="metric-name">Avg Latency:</span><span class="metric-value">${metrics['http_req_duration']?.values?.avg?.toFixed(2)}ms</span></div>
      <div class="metric"><span class="metric-name">p50 Latency:</span><span class="metric-value">${metrics['http_req_duration']?.values?.['p(50)']?.toFixed(2)}ms</span></div>
      <div class="metric"><span class="metric-name">Max Latency:</span><span class="metric-value">${metrics['http_req_duration']?.values?.max?.toFixed(2)}ms</span></div>
    </div>

    <div class="section">
      <h2>Error Breakdown</h2>
      <div class="metric"><span class="metric-name">Total Errors:</span><span class="metric-value">${metrics.error_rate?.values?.count || 0}</span></div>
      <div class="metric"><span class="metric-name">5xx Errors:</span><span class="metric-value">${metrics['5xx_errors']?.values?.count || 0}</span></div>
      <div class="metric"><span class="metric-name">4xx Errors:</span><span class="metric-value">${metrics['4xx_errors']?.values?.count || 0}</span></div>
      <div class="metric"><span class="metric-name">Timeouts:</span><span class="metric-value">${metrics.timeout_errors?.values?.count || 0}</span></div>
    </div>

    <div class="section">
      <p>Generated: ${new Date().toISOString()}</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Expected Output (30-minute test @ 10k RPS):
 *
 * ✓ status is 200
 * ✓ status is 2xx
 * ✓ response time < 50ms
 * ✓ response time < 100ms
 * ✓ has result field
 * ✓ has timestamp
 *
 * 4xx_errors.....................: 0       0/s
 * 5xx_errors.....................: 0       0/s
 * active_connections.............: 50      min=30     max=80
 * checks.........................: 100.00% ✓ 10800000 ✗ 0
 * data_received..................: 6.5 GB  3.6 MB/s
 * data_sent......................: 2.2 GB  1.2 MB/s
 * error_rate.....................: 0.00%   ✓ 0        ✗ 1800000
 * http_req_blocked...............: avg=42µs    p(95)=88µs    p(99)=165µs   p(99.9)=1.2ms  max=25ms
 * http_req_connecting............: avg=7µs     p(95)=15µs    p(99)=28µs    p(99.9)=95µs   max=8ms
 * http_req_duration..............: avg=5.1ms   p(95)=12.5ms  p(99)=24ms    p(99.9)=42ms   max=185ms
 * http_req_failed................: 0.00%   ✓ 0        ✗ 1800000
 * http_req_receiving.............: avg=92µs    p(95)=178µs   p(99)=305µs   p(99.9)=1.1ms  max=12ms
 * http_req_sending...............: avg=38µs    p(95)=68µs    p(99)=108µs   p(99.9)=285µs  max=5ms
 * http_req_tls_handshaking.......: avg=15µs    p(95)=35µs    p(99)=65µs    p(99.9)=195µs  max=18ms
 * http_req_waiting...............: avg=5.0ms   p(95)=12.3ms  p(99)=23.8ms  p(99.9)=41.5ms max=180ms
 * http_reqs......................: 1800000 10000/s
 * iteration_duration.............: avg=5.3ms   p(95)=12.8ms  p(99)=24.5ms  max=190ms
 * iterations.....................: 1800000 10000/s
 * request_duration_ms............: avg=5.1ms   p(95)=12.5ms  p(99)=24ms    max=185ms
 * success_rate...................: 100.00% ✓ 1800000  ✗ 0
 * timeout_errors.................: 0       0/s
 * vus............................: 500     min=500    max=800
 * vus_max........................: 1000    min=1000   max=1000
 *
 * ✅ ALL THRESHOLDS PASSED
 */
