/**
 * ============================================================================
 * UNIVERSITY DDOS DEMONSTRATION SERVER
 * ============================================================================
 * 
 * Educational Objectives:
 * 1. Understand Layer 7 (Application Layer) HTTP flood attacks.
 * 2. Observe how single-threaded event loop architectures (like Node.js)
 *    degrade under high request volumes without caching/clustering.
 * 3. Inspect real-time server vitals (CPU, RAM, Event Loop Delay, Requests/sec).
 * 4. Demonstrate mitigation using dynamic Rate Limiting (express-rate-limit)
 *    toggled at runtime without restarting the server.
 * 5. Track source IP distribution to visualize attacker botnets.
 * 6. Demonstrate RESOURCE EXHAUSTION & SERVER CRASH / SHUTDOWN:
 *    - Generous resource ceilings (512MB RAM, 2,000 concurrent sockets) allow
 *      the server to withstand initial load and show gradual degradation.
 *    - IP-Spoofing / Botnet IP rotation completely bypasses per-IP rate limiting,
 *      causing memory pressure to build up gradually over 20-40 seconds of sustained flood.
 *    - When the ceiling is breached, the server gracefully shuts off (crashes).
 * 
 * Tech Stack: Node.js, Express, Socket.io, native 'os' module, express-rate-limit, cors.
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Helper to parse CLI flags
const cliArgs = process.argv.slice(2);
function getCliArg(flag, defaultValue) {
  const index = cliArgs.indexOf(flag);
  if (index !== -1 && cliArgs[index + 1]) {
    return cliArgs[index + 1];
  }
  return defaultValue;
}

// ==========================================
// 1. CONFIGURATION & RESOURCE BOUNDARIES
// ==========================================
const PORT = process.env.PORT || 3000;
const STATS_INTERVAL_MS = 1000; // Emit live telemetry every 1 second

// Rate Limiter Rules for the DDoS Mitigation demo:
// Limits each IP to 20 requests per 10-second rolling window
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // 10 seconds
const RATE_LIMIT_MAX_REQUESTS = 20;     // 20 requests per IP per window

// Resource Limits (Server shuts down when these limits are breached)
// Increased to generous levels (512MB, 2000 sockets) so server can survive
// and demonstrate realistic, gradual resource exhaustion during presentations.
let maxMemoryMb = parseInt(process.env.MAX_MEMORY_MB || getCliArg('--memory', '512'), 10);
let maxConcurrentConn = parseInt(process.env.MAX_CONCURRENT_CONN || getCliArg('--max-conn', '2000'), 10);
const ENABLE_SERVER_SHUTDOWN = process.env.ENABLE_SHUTDOWN !== 'false'; // Allow server to go down on OOM

// In-memory buffer accumulation pool (simulates unreleased connection buffers/session tables)
// When requests are accepted (not blocked by rate limiting), memory accumulates here.
const memoryPressurePool = [];

// Memory allocation size per accepted request (2KB)
// At 2,000 req/s, this produces ~4MB/s buildup, giving ~30-60s of presentation runway before crash
const BYTES_PER_ACCEPTED_REQUEST = 2048; // 2KB

// ==========================================
// 2. STATE & TELEMETRY TRACKERS (In-Memory)
// ==========================================
// Toggleable DDoS mitigation state:
// Start undefended by default so students can observe the impact of an attack.
let protectionEnabled = false;
let protectionToggledAt = null;

// Cumulative & interval counters
let totalRequestsCumulative = 0;
let totalBlockedCumulative = 0;
let blockedSinceProtection = 0;
let inFlightRequests = 0;

// Per-second rolling metrics (reset every STATS_INTERVAL_MS)
let currentSecondRequests = 0;
let currentSecondIpRequests = new Map();

// Last calculated rates (for emission and REST inspection)
let lastRpsTotal = 0;
let lastRpsByIp = {};

// Crash state
let isCrashing = false;
let crashReason = null;

// Event Loop Delay measurement (shows when Node.js event loop freezes)
let lastEventLoopCheck = Date.now();
let eventLoopLagMs = 0;

setInterval(() => {
  const now = Date.now();
  // We expect this callback every 100ms. Extra elapsed time indicates event loop blockage.
  eventLoopLagMs = Math.max(0, now - lastEventLoopCheck - 100);
  lastEventLoopCheck = now;
}, 100).unref();

// Periodic Natural Memory Drainage / Garbage Collection Simulation
// Drains ~1MB per second of idle buffer pressure if traffic slows down
setInterval(() => {
  if (memoryPressurePool.length > 0) {
    // Drain up to 500 chunks (~1MB) every second
    const drainCount = Math.min(500, memoryPressurePool.length);
    memoryPressurePool.splice(0, drainCount);
  }
}, 1000).unref();

// ==========================================
// 3. HARDWARE TELEMETRY HELPERS (CPU & RAM)
// ==========================================

/**
 * Returns instantaneous CPU idle and total ticks across all logical cores.
 */
function getCpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (let i = 0; i < cpus.length; i++) {
    const times = cpus[i].times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

let prevCpuSnapshot = getCpuSnapshot();

/**
 * Calculates CPU utilization percentage between the previous tick and now.
 * Formula: 100 * (1 - (idle_diff / total_diff))
 */
function getCpuUsagePercent() {
  const current = getCpuSnapshot();
  const idleDiff = current.idle - prevCpuSnapshot.idle;
  const totalDiff = current.total - prevCpuSnapshot.total;
  prevCpuSnapshot = current;

  if (totalDiff <= 0) return 0;
  const usage = (1 - idleDiff / totalDiff) * 100;
  return Math.min(100, Math.max(0, parseFloat(usage.toFixed(1))));
}

/**
 * Returns system and process memory metrics.
 */
function getMemoryStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const systemRamPercent = ((usedMem / totalMem) * 100).toFixed(1);

  const procMem = process.memoryUsage();
  const processRssMb = parseFloat((procMem.rss / (1024 * 1024)).toFixed(1));
  const processHeapMb = parseFloat((procMem.heapUsed / (1024 * 1024)).toFixed(1));

  return {
    systemPercent: parseFloat(systemRamPercent),
    usedMb: Math.round(usedMem / (1024 * 1024)),
    totalMb: Math.round(totalMem / (1024 * 1024)),
    processRssMb: processRssMb,
    processHeapMb: processHeapMb
  };
}

/**
 * Extracts and normalizes the client IP address.
 * Supports:
 * - Direct TCP connection remoteAddress
 * - Reverse proxies (X-Forwarded-For)
 * - Container networks (Docker bridge)
 * - Custom simulation header (X-Attacker-IP) for testing multiple IPs or IP rotation from 1 machine
 */
function getClientIp(req) {
  // Allow explicit attacker header if testing multi-IP botnet simulation from 1 client
  if (req.headers['x-attacker-ip']) {
    return String(req.headers['x-attacker-ip']).trim();
  }

  const forwarded = req.headers['x-forwarded-for'];
  let ip = forwarded ? forwarded.split(',')[0].trim() : req.ip || req.socket.remoteAddress || '127.0.0.1';

  // Strip IPv4-mapped IPv6 notation (::ffff:192.168.1.1 -> 192.168.1.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.replace('::ffff:', '');
  }
  // Normalize IPv6 localhost
  if (ip === '::1') {
    ip = '127.0.0.1';
  }
  return ip;
}

// ==========================================
// 4. RESOURCE WATCHDOG & SERVER SHUTDOWN (CRASH)
// ==========================================

/**
 * Shuts down the server process when resource boundaries are breached.
 * Demonstrates a fatal OOM or socket pool exhaustion crash under DDoS.
 */
function triggerServerCrash(reason) {
  if (isCrashing) return;
  isCrashing = true;
  crashReason = reason;

  const mem = getMemoryStats();

  console.error(`
======================================================================
💥 [FATAL SERVER CRASH - RESOURCE EXHAUSTION / OOM]
======================================================================
 Reason:          ${reason}
 Memory Used:     ${mem.processRssMb} MB (Hard Ceiling: ${maxMemoryMb} MB)
 Concurrent Open: ${inFlightRequests} sockets (Limit: ${maxConcurrentConn})
 Total Requests:  ${totalRequestsCumulative}
 Timestamp:       ${new Date().toISOString()}

 >> The target server process has SHUT OFF (Went DOWN).
 >> Incoming HTTP connections will now fail with ECONNREFUSED.
 >> Bring the server back online with: npm start
======================================================================
  `);

  // Broadcast fatal crash notification to dashboard clients immediately
  try {
    io.emit('server-crash', {
      crashed: true,
      reason: reason,
      memoryUsedMb: mem.processRssMb,
      memoryLimitMb: maxMemoryMb,
      totalRequests: totalRequestsCumulative,
      inFlightRequests: inFlightRequests,
      timestamp: new Date().toISOString()
    });
  } catch (e) {}

  if (ENABLE_SERVER_SHUTDOWN) {
    // Stop accepting new connections
    server.close(() => {
      process.exit(137); // Standard Linux/Docker OOM killer exit code
    });

    // Force exit if socket cleanup stalls
    setTimeout(() => {
      process.exit(137);
    }, 250).unref();
  }
}

/**
 * Checks resource limits continuously.
 */
function checkResourceLimits() {
  if (isCrashing) return;

  const mem = getMemoryStats();

  // Check 1: Memory boundary exceeded
  if (mem.processRssMb >= maxMemoryMb) {
    triggerServerCrash(`Out Of Memory (OOM) - Memory usage (${mem.processRssMb}MB) exceeded ceiling (${maxMemoryMb}MB)`);
    return;
  }

  // Check 2: Concurrent connection ceiling exceeded
  if (inFlightRequests >= maxConcurrentConn) {
    triggerServerCrash(`Socket Pool Exhaustion - Concurrent connections (${inFlightRequests}) exceeded capacity (${maxConcurrentConn})`);
    return;
  }
}

// Periodically check resource limits
setInterval(checkResourceLimits, 200).unref();

// ==========================================
// 5. RATE LIMITER SETUP (express-rate-limit)
// ==========================================

/**
 * Standard express-rate-limit instance.
 * Notice: This instance is wrapped in a dynamic middleware below so that it
 * can be activated and deactivated dynamically via HTTP POST without server restart.
 */
const limiterInstance = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true, // Send RateLimit-* standard headers
  legacyHeaders: false,  // Do not send X-RateLimit-* deprecated headers
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res, next, options) => {
    // Increment blocked counters
    totalBlockedCumulative++;
    if (protectionEnabled) {
      blockedSinceProtection++;
    }

    const clientIp = getClientIp(req);
    res.status(429).json({
      error: 'Too Many Requests',
      status: 429,
      message: `DDoS Mitigation Active: Exceeded limit of ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s.`,
      clientIp: clientIp,
      retryAfterSeconds: Math.ceil(options.windowMs / 1000),
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Dynamic wrapper middleware:
 * If protection is ON, pass the request to express-rate-limit.
 * If protection is OFF, bypass the limiter completely (demonstrating undefended state).
 */
const dynamicProtectionMiddleware = (req, res, next) => {
  if (protectionEnabled) {
    return limiterInstance(req, res, next);
  }
  next();
};

// ==========================================
// 6. APPLICATION INITIALIZATION & MIDDLEWARE
// ==========================================
const app = express();
const server = http.createServer(app);

// Allow trust proxy so X-Forwarded-For headers from Docker/Reverse-proxy work
app.set('trust proxy', true);

// Enable CORS for all routes (so dashboards on different ports/domains can access)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Parse JSON request bodies
app.use(express.json());

// Serve static assets (dashboard HTML)
app.use(express.static(path.join(__dirname, 'public')));

// Request tracking middleware (logs traffic volume and per-IP distribution)
app.use((req, res, next) => {
  // If server is in crash state, refuse immediately
  if (isCrashing) {
    res.status(503).send('Server Crashed - Resource Exhaustion');
    return;
  }

  // Skip telemetry polling itself from cluttering stats if requested
  if (req.path === '/api/stats' && req.query.internal === 'true') {
    return next();
  }

  const clientIp = getClientIp(req);
  totalRequestsCumulative++;
  currentSecondRequests++;

  // Record IP in current interval
  const count = currentSecondIpRequests.get(clientIp) || 0;
  currentSecondIpRequests.set(clientIp, count + 1);

  // In-flight connection tracker
  inFlightRequests++;
  res.on('finish', () => {
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  });

  // Check resource limits before processing
  checkResourceLimits();

  next();
});

// Apply toggleable DDoS mitigation to all subsequent API and flood routes
app.use(dynamicProtectionMiddleware);

// Middleware that simulates server memory pressure for ACCEPTED requests
// If rate-limited (429), this is NEVER reached, so rate limiting protects memory!
// But if attackers rotate their IP, every request is accepted, causing memory to build up gradually!
app.use((req, res, next) => {
  // Allocate a 2KB buffer chunk for each accepted request (simulating session state / packet buffers)
  if (req.path === '/' || req.path === '/api/data') {
    memoryPressurePool.push(Buffer.alloc(BYTES_PER_ACCEPTED_REQUEST));
    checkResourceLimits();
  }
  next();
});

// ==========================================
// 7. ENDPOINTS
// ==========================================

/**
 * GET /
 * Simple homepage route. Returns lightweight JSON or HTML.
 * This is the primary target that attackers flood with requests.
 * Without rate limiting, rapid requests consume socket descriptors and event loop ticks.
 */
app.get('/', (req, res) => {
  res.json({
    service: 'University DDoS Demo Server',
    status: 'online',
    path: '/',
    description: 'Target endpoint. Under DDoS flood, this server will struggle when unprotected.',
    protectionEnabled: protectionEnabled,
    clientIp: getClientIp(req),
    memoryLimitMb: maxMemoryMb,
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/data
 * Simulates a heavier workload (CPU-bound loop and small async delay).
 * This endpoint demonstrates how compute/database-heavy routes are
 * orders of magnitude more vulnerable to Layer 7 exhaustion attacks.
 */
app.get('/api/data', (req, res) => {
  const startTime = process.hrtime();

  // Simulating synchronous CPU crunch (e.g., cryptographic hashing, complex parsing)
  // 300,000 math operations blocks the single thread for ~3-6ms per request.
  // 500 concurrent requests = ~2.5 seconds of locked event loop!
  let mathResult = 0;
  for (let i = 0; i < 300000; i++) {
    mathResult += Math.sin(i) * Math.cos(i);
  }

  // Simulating small asynchronous database / disk latency (20ms)
  setTimeout(() => {
    const diff = process.hrtime(startTime);
    const executionTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

    res.json({
      status: 'success',
      endpoint: '/api/data',
      simulatedOperation: 'CPU Hash + Database Query',
      executionTimeMs: `${executionTimeMs}ms`,
      clientIp: getClientIp(req),
      data: [
        { id: 1, item: 'Research Dataset Alpha', sizeKb: 142 },
        { id: 2, item: 'Student Registry Records', sizeKb: 890 },
        { id: 3, item: 'Exam Grades Database', sizeKb: 54 }
      ]
    });
  }, 20);
});

/**
 * POST /api/toggle-protection
 * Toggles the express-rate-limit protection ON or OFF dynamically.
 * Body (optional): { "enabled": true } or { "enabled": false }
 * If body is empty, toggles current state.
 */
app.post('/api/toggle-protection', (req, res) => {
  if (typeof req.body.enabled === 'boolean') {
    protectionEnabled = req.body.enabled;
  } else {
    protectionEnabled = !protectionEnabled;
  }

  protectionToggledAt = new Date().toISOString();

  // When turning ON, reset the blocked counter for this protection window
  if (protectionEnabled) {
    blockedSinceProtection = 0;
  }

  // Notify all connected dashboard clients immediately
  io.emit('protection-change', {
    protectionEnabled: protectionEnabled,
    blockedSinceProtection: blockedSinceProtection,
    toggledAt: protectionToggledAt
  });

  res.json({
    success: true,
    protectionEnabled: protectionEnabled,
    blockedSinceProtection: blockedSinceProtection,
    toggledAt: protectionToggledAt,
    message: protectionEnabled 
      ? `DDoS Protection ENABLED (Rate Limit: ${RATE_LIMIT_MAX_REQUESTS} req / ${RATE_LIMIT_WINDOW_MS / 1000}s)`
      : 'DDoS Protection DISABLED (Server is undefended)'
  });
});

/**
 * POST /api/set-limits
 * Allows adjusting the resource ceiling dynamically at runtime.
 * Body: { "maxMemoryMb": 512, "maxConcurrentConn": 2000 }
 */
app.post('/api/set-limits', (req, res) => {
  if (typeof req.body.maxMemoryMb === 'number' && req.body.maxMemoryMb >= 64) {
    maxMemoryMb = Math.round(req.body.maxMemoryMb);
  }
  if (typeof req.body.maxConcurrentConn === 'number' && req.body.maxConcurrentConn >= 50) {
    maxConcurrentConn = Math.round(req.body.maxConcurrentConn);
  }

  // Notify dashboard clients
  io.emit('limits-updated', {
    maxMemoryMb: maxMemoryMb,
    maxConcurrentConn: maxConcurrentConn
  });

  res.json({
    success: true,
    maxMemoryMb: maxMemoryMb,
    maxConcurrentConn: maxConcurrentConn,
    message: `Resource limits updated: Memory ceiling = ${maxMemoryMb}MB, Concurrency ceiling = ${maxConcurrentConn}`
  });
});

/**
 * POST /api/crash
 * Allows the presenter to trigger a resource exhaustion shutdown on demand.
 */
app.post('/api/crash', (req, res) => {
  res.json({ message: 'Triggering fatal resource exhaustion crash...' });
  setTimeout(() => {
    triggerServerCrash('Manual Demonstration: Simulated Fatal Resource Exhaustion');
  }, 100);
});

/**
 * POST /api/reset-memory
 * Clears accumulated memory pressure pool back to baseline.
 */
app.post('/api/reset-memory', (req, res) => {
  memoryPressurePool.length = 0;
  if (global.gc) {
    global.gc();
  }
  const mem = getMemoryStats();
  res.json({
    success: true,
    message: 'Memory pressure pool reset',
    currentRssMb: mem.processRssMb
  });
});

/**
 * GET /api/stats
 * REST fallback to retrieve current server telemetry snapshot without Socket.io.
 */
app.get('/api/stats', (req, res) => {
  const ram = getMemoryStats();
  res.json({
    timestamp: Date.now(),
    protectionEnabled: protectionEnabled,
    cpuPercent: getCpuUsagePercent(),
    ramPercent: ram.systemPercent,
    ramUsedMb: ram.usedMb,
    ramTotalMb: ram.totalMb,
    processRssMb: ram.processRssMb,
    maxMemoryMb: maxMemoryMb,
    memoryCeilingPercent: parseFloat(((ram.processRssMb / maxMemoryMb) * 100).toFixed(1)),
    requestsPerSecondTotal: lastRpsTotal,
    requestsPerSecondByIp: lastRpsByIp,
    blockedRequests: blockedSinceProtection,
    totalBlockedCumulative: totalBlockedCumulative,
    totalRequestsCumulative: totalRequestsCumulative,
    activeConnections: inFlightRequests,
    maxConcurrentConnections: maxConcurrentConn,
    eventLoopLagMs: eventLoopLagMs,
    isCrashing: isCrashing
  });
});

/**
 * GET /dashboard
 * Direct route to serve the built-in real-time dashboard.
 */
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ==========================================
// 8. SOCKET.IO REAL-TIME TELEMETRY STREAM
// ==========================================
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  // Send immediate initial state on client connect
  const ram = getMemoryStats();
  socket.emit('initial-state', {
    protectionEnabled: protectionEnabled,
    blockedSinceProtection: blockedSinceProtection,
    rateLimitMax: RATE_LIMIT_MAX_REQUESTS,
    rateLimitWindowSec: RATE_LIMIT_WINDOW_MS / 1000,
    serverUptimeSec: Math.floor(process.uptime()),
    ramTotalMb: ram.totalMb,
    maxMemoryMb: maxMemoryMb,
    maxConcurrentConnections: maxConcurrentConn,
    isCrashing: isCrashing
  });
});

// Main Telemetry Interval Loop: emits live metrics every 1 second
setInterval(() => {
  if (isCrashing) return;

  // Compute Rates for the elapsed 1-second window
  lastRpsTotal = currentSecondRequests;
  lastRpsByIp = Object.fromEntries(currentSecondIpRequests);

  // Reset per-second counters for the next window
  currentSecondRequests = 0;
  currentSecondIpRequests.clear();

  // Read hardware vitals
  const cpu = getCpuUsagePercent();
  const ram = getMemoryStats();
  const memoryCeilingPercent = parseFloat(((ram.processRssMb / maxMemoryMb) * 100).toFixed(1));

  // Construct telemetry payload
  const telemetryData = {
    timestamp: Date.now(),
    cpuPercent: cpu,
    ramPercent: ram.systemPercent,
    ramUsedMb: ram.usedMb,
    ramTotalMb: ram.totalMb,
    processRssMb: ram.processRssMb,
    maxMemoryMb: maxMemoryMb,
    memoryCeilingPercent: memoryCeilingPercent,
    totalRps: lastRpsTotal,
    rpsByIp: lastRpsByIp,
    blockedRequests: blockedSinceProtection,
    totalBlockedCumulative: totalBlockedCumulative,
    totalRequestsCumulative: totalRequestsCumulative,
    activeConnections: inFlightRequests,
    maxConcurrentConnections: maxConcurrentConn,
    protectionEnabled: protectionEnabled,
    eventLoopLagMs: eventLoopLagMs,
    isCrashing: isCrashing
  };

  // Broadcast to all connected dashboard frontend clients
  io.emit('stats', telemetryData);
}, STATS_INTERVAL_MS);

// ==========================================
// 9. START SERVER
// ==========================================
server.listen(PORT, () => {
  console.log(`
============================================================
 [DDoS Demo Target Server] running on http://localhost:${PORT}
 Dashboard URL:           http://localhost:${PORT}/dashboard
 Protection Initial State: ${protectionEnabled ? 'ENABLED' : 'DISABLED (Undefended)'}
 Rate Limit:               ${RATE_LIMIT_MAX_REQUESTS} req / ${RATE_LIMIT_WINDOW_MS / 1000}s per IP
 Memory Hard Ceiling:      ${maxMemoryMb} MB (Server shuts down when exceeded)
 Max Concurrent Sockets:   ${maxConcurrentConn}
 Telemetry Broadcast:      Every ${STATS_INTERVAL_MS}ms via Socket.io
============================================================
  `);
});
