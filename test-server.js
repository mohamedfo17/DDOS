/**
 * Automated Verification Test Suite for DDoS Demo Server
 * Tests REST Endpoints, Dynamic Rate Limiting, IP-Rotation Bypass, and Telemetry
 */
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function makeRequest(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: path,
      method: method,
      headers: { ...headers }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = res.headers['content-type'] && res.headers['content-type'].includes('application/json')
            ? JSON.parse(data)
            : data;
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting DDoS Server Verification Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Test GET /
    console.log('[Test 1] Testing GET /');
    const rootRes = await makeRequest('/');
    assert(rootRes.status === 200, 'GET / returned status 200');
    assert(rootRes.body && rootRes.body.service === 'Layer 7 DDoS Simulation Server', 'GET / returns expected service info');
    assert(rootRes.body.protectionEnabled === false, 'GET / reflects initial protectionEnabled = false');

    // 2. Test GET /api/data
    console.log('\n[Test 2] Testing GET /api/data');
    const dataRes = await makeRequest('/api/data');
    assert(dataRes.status === 200, 'GET /api/data returned status 200');
    assert(dataRes.body && dataRes.body.endpoint === '/api/data', 'GET /api/data executed CPU and async task');
    assert(Array.isArray(dataRes.body.data) && dataRes.body.data.length > 0, 'GET /api/data returns payload items');

    // 3. Test GET /dashboard
    console.log('\n[Test 3] Testing GET /dashboard');
    const dashRes = await makeRequest('/dashboard');
    assert(dashRes.status === 200, 'GET /dashboard returned status 200');
    assert(typeof dashRes.body === 'string' && dashRes.body.includes('DDoS Live Telemetry'), 'GET /dashboard returned dashboard HTML');

    // 4. Test GET /api/stats
    console.log('\n[Test 4] Testing GET /api/stats');
    const statsRes = await makeRequest('/api/stats');
    assert(statsRes.status === 200, 'GET /api/stats returned status 200');
    assert(typeof statsRes.body.cpuPercent === 'number', 'GET /api/stats includes cpuPercent');
    assert(typeof statsRes.body.ramPercent === 'number', 'GET /api/stats includes ramPercent');
    assert(typeof statsRes.body.maxMemoryMb === 'number', 'GET /api/stats includes maxMemoryMb ceiling');
    assert(typeof statsRes.body.memoryCeilingPercent === 'number', 'GET /api/stats includes memoryCeilingPercent');

    // 5. Test Socket.io Connection & Events
    console.log('\n[Test 5] Testing Socket.io Connection & Telemetry Stream');
    const socket = io(BASE_URL, { reconnection: false, timeout: 5000 });

    const initialStatePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for initial-state')), 4000);
      socket.on('initial-state', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });

    const statsEventPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for stats')), 4000);
      socket.on('stats', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });

    const initialData = await initialStatePromise;
    assert(initialData && typeof initialData.protectionEnabled === 'boolean', 'Socket.io received initial-state event');
    assert(initialData.rateLimitMax === 20, 'Initial state specifies rateLimitMax = 20');
    assert(typeof initialData.maxMemoryMb === 'number', 'Initial state specifies maxMemoryMb');

    const statsData = await statsEventPromise;
    assert(statsData && typeof statsData.totalRps === 'number', 'Socket.io received periodic stats event with totalRps');
    assert(typeof statsData.cpuPercent === 'number', 'stats event includes cpuPercent');
    assert(typeof statsData.processRssMb === 'number', 'stats event includes processRssMb');
    assert(typeof statsData.memoryCeilingPercent === 'number', 'stats event includes memoryCeilingPercent');

    // 6. Test POST /api/toggle-protection (Enable)
    console.log('\n[Test 6] Testing POST /api/toggle-protection (Turning ON)');
    const protectionChangePromise = new Promise((resolve) => {
      socket.once('protection-change', (data) => resolve(data));
    });

    const toggleOnRes = await makeRequest('/api/toggle-protection', 'POST', { enabled: true });
    assert(toggleOnRes.status === 200, 'POST /api/toggle-protection returned 200');
    assert(toggleOnRes.body.protectionEnabled === true, 'Protection is now enabled in HTTP response');

    const changeEvent = await protectionChangePromise;
    assert(changeEvent && changeEvent.protectionEnabled === true, 'Socket.io broadcasted protection-change event to all clients');

    // 7. Test Rate Limiting for Single IP (Max 20 req / 10s)
    console.log('\n[Test 7] Testing Single IP Rate Limiting (Should block after 20 req)');
    const singleIp = '192.168.99.1';
    let blockedCount = 0;
    let acceptedCount = 0;

    for (let i = 0; i < 25; i++) {
      const res = await makeRequest('/', 'GET', null, { 'X-Attacker-IP': singleIp });
      if (res.status === 200) acceptedCount++;
      if (res.status === 429) blockedCount++;
    }

    assert(acceptedCount === 20, `Single IP accepted exactly 20 requests (got ${acceptedCount})`);
    assert(blockedCount === 5, `Single IP blocked remaining 5 requests with HTTP 429 (got ${blockedCount})`);

    // 8. Test IP Rotation / Spoofing Bypass
    console.log('\n[Test 8] Testing IP Rotation Bypass (Random IPs should ALL pass through 200 OK)');
    let bypassAccepted = 0;
    let bypassBlocked = 0;

    for (let i = 0; i < 25; i++) {
      const randomIp = `198.51.100.${i + 1}`; // New IP per request
      const res = await makeRequest('/', 'GET', null, { 'X-Attacker-IP': randomIp });
      if (res.status === 200) bypassAccepted++;
      if (res.status === 429) bypassBlocked++;
    }

    assert(bypassAccepted === 25, `IP Rotation successfully bypassed rate limiter (all 25 accepted as 200 OK)`);
    assert(bypassBlocked === 0, `IP Rotation resulted in 0 blocked requests under per-IP policy`);

    // 9. Reset Memory Pool
    console.log('\n[Test 9] Testing POST /api/reset-memory');
    const resetRes = await makeRequest('/api/reset-memory', 'POST');
    assert(resetRes.status === 200, 'POST /api/reset-memory returned 200');
    assert(resetRes.body.success === true, 'Memory pool reset acknowledged');

    // 10. Test POST /api/toggle-protection (Disable)
    console.log('\n[Test 10] Testing POST /api/toggle-protection (Turning OFF)');
    const toggleOffRes = await makeRequest('/api/toggle-protection', 'POST', { enabled: false });
    assert(toggleOffRes.status === 200, 'POST /api/toggle-protection returned 200');
    assert(toggleOffRes.body.protectionEnabled === false, 'Protection is now disabled');

    socket.disconnect();

    console.log('\n============================================================');
    console.log(`Test Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test execution error:', err);
    process.exit(1);
  }
}

runTests();
