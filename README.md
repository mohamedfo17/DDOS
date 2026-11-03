# University DDoS Demonstration Server & Live Telemetry Dashboard

An educational Node.js/Express target server designed for live classroom demonstrations of **Layer 7 (Application Layer) DDoS attacks**, **Dynamic Rate-Limiting Mitigation**, **IP-Spoofing / Botnet Evasion**, and **Server Resource Exhaustion & Fatal Shutdown (Going Down)**.

---

## 🌟 Key Features

1. **Vulnerable by Default (Single Process)**:
   - Pure single-threaded Node.js event loop with no caching and no clustering.
   - Visibly struggles and queues requests under heavy HTTP floods.
2. **Resource Exhaustion & Server Shutdown (Gradual Degradation & Crash)**:
   - **Generous Presentation Default (512 MB Memory Ceiling, 2,000 Concurrent Sockets)**:
     The server doesn't crash in 1 second; it gives you **20–45 seconds of realistic presentation runway** under flood, allowing you to explain the dashboard metrics as they climb before the crash occurs.
   - **Adjustable on the Fly**: Change the ceiling anytime via the dashboard dropdown (**128MB, 256MB, 512MB, 1024MB**) without restarting.
   - **Natural Memory Recovery**: Drains ~1MB/sec in the background when traffic slows down, demonstrating real garbage collection behavior.
   - **Fatal Process Shutdown**: When sustained flood breaches the ceiling, the server broadcasts an OOM crash notification and terminates (`process.exit(137)`), triggering the skull crash modal and failing new connections with `ECONNREFUSED`.
3. **Dynamic Runtime DDoS Protection**:
   - Uses `express-rate-limit` (20 requests per 10s per IP).
   - Toggled **on/off at runtime via HTTP POST or Dashboard button** without restarting the server.
4. **IP-Spoofing / Dynamic IP Rotation (Bypassing Rate Limiting)**:
   - Attackers can randomize their source IP on every request (`--random-ips`).
   - Demonstrates why simple per-IP rate limiting is **insufficient against distributed botnets**: because each request comes from a new IP, no IP ever exceeds the 20-req quota, allowing 100% of the flood to pass through and crash the server!
5. **Live Socket.io Telemetry (Broadcasts every 1s)**:
   - System **CPU %** and **Memory Ceiling %** gauges.
   - System & Process **RAM in MB** (tracking progress toward OOM crash).
   - **Total Requests per Second (RPS)**.
   - **Per-IP Requests per Second Breakdown** (visualizes botnet attacker nodes).
   - **Blocked / Rejected Requests (HTTP 429)** since protection was activated.
   - **Node.js Event Loop Lag (ms)** to demonstrate single-thread blockage.
   - Current protection state (`enabled: true/false`).
6. **CORS Enabled**:
   - Socket.io and REST endpoints accept cross-origin requests (`*`), allowing separate frontends on different ports to connect.
7. **Turnkey Real-Time Dashboard Included**:
   - Accessible immediately at `http://localhost:3000/dashboard` with Tailwind CSS and Chart.js.
   - Live rolling line charts, IP distribution bar chart, memory ceiling progress meter, on-the-fly memory ceiling dropdown, one-click **"Enable / Disable Protection"** toggle, and a **"Simulate Crash"** button.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Target Server
```bash
npm start
```
Starts with the default **512 MB** memory ceiling and **2,000** socket limit.
- **Server Root**: `http://localhost:3000/`
- **Live Visual Dashboard**: `http://localhost:3000/dashboard`
- **REST Telemetry Snapshot**: `http://localhost:3000/api/stats`

> **Custom Resource Ceilings**:
> You can also start with custom ceilings via command line or environment variable:
> ```bash
> node server.js --memory 1024    # 1GB Tank mode
> node server.js --memory 256     # Faster crash mode
> ```
> Or simply change the ceiling anytime directly from the dashboard dropdown!

---

## 📡 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Simple homepage returning a lightweight JSON payload. Primary target for volume floods. |
| `GET` | `/api/data` | Simulates heavier operations (synchronous CPU crunch + asynchronous DB latency). |
| `POST` | `/api/toggle-protection` | Dynamically enables or disables the rate limiter at runtime without server restart. |
| `POST` | `/api/set-limits` | Dynamically updates resource ceilings at runtime (e.g. `{"maxMemoryMb": 1024}`). |
| `POST` | `/api/crash` | Manually triggers an immediate fatal resource exhaustion crash (for classroom demonstrations). |
| `POST` | `/api/reset-memory` | Clears accumulated memory pressure pool back to baseline. |
| `GET` | `/api/stats` | REST fallback returning current CPU, RAM, RPS, IP breakdown, memory ceiling %, and blocked counts. |
| `GET` | `/dashboard` | Interactive real-time dark-mode telemetry dashboard. |

---

## ⚔️ Running the Attack Demonstrations

Open a second terminal window to run attack scenarios using `demo-attack.js`:

### Scenario A: Single Attacker Flood (Stops under Rate Limiting)
```bash
npm run attack
```
- **With Protection OFF**: Server handles high RPS.
- **With Protection ON**: Blocked after 20 requests (`HTTP 429 Too Many Requests`). Memory remains completely safe.

---

### Scenario B: Distributed Botnet Simulation (Fixed 7-Node Pool)
```bash
npm run attack:botnet
```
- **Observation**: Look at the **Source IP Distribution** bar chart on `http://localhost:3000/dashboard`. Traffic is divided among bot nodes.

---

### Scenario C: IP-Spoofing / IP Rotation (BYPASSES RATE LIMITING & SUSTAINED CRASH)
```bash
npm run attack:bypass
# Or: node demo-attack.js --random-ips --concurrency 25
```
- **Why this works**:
  1. Each request arrives with a unique random IP.
  2. Because each IP only sends 1 request, `express-rate-limit` (20 req / 10s) never trips.
  3. **100% of attack requests pass through as HTTP 200 OK.**
  4. Memory climbs gradually on the dashboard from ~50MB toward 512MB over 20–45 seconds.
  5. Once the ceiling is breached: **💥 THE SERVER CRASHES & GOES DOWN!**
  6. The dashboard displays the skull crash screen, and the attack terminal logs `TARGET DOWN (ECONNREFUSED)`.

---

## 🎓 University Presentation Walkthrough Guide

1. **Step 1: Baseline State**
   - Start the server: `npm start` and open `http://localhost:3000/dashboard`.
   - Point out that memory is at ~40MB / 512MB (<10%) and CPU is idle.
2. **Step 2: Single Attacker vs. Mitigation**
   - Run `npm run attack`.
   - Toggle **Protection ON** via the dashboard button.
   - Show that requests drop to `429 Too Many Requests` and memory is protected.
3. **Step 3: The Botnet Dilemma (IP Rotation)**
   - Keep protection **ON**.
   - In terminal 2, run `npm run attack:bypass` (`--random-ips`).
   - **Show the dashboard**:
     - 429 Blocked counter stops growing (0 dropped).
     - 200 OK responses skyrocket.
     - The **Memory Ceiling** gauge climbs steadily (20% -> 40% -> 60% -> 80%).
     - You have plenty of time to explain how attackers rotate proxies or botnet zombies to bypass Layer 7 per-IP rate limiting!
4. **Step 4: Target Server Goes DOWN (Crash)**
   - As memory hits 512MB, the server terminates (`process.exit(137)`).
   - The dashboard flashes the **"TARGET SERVER HAS CRASHED"** skull screen.
   - The attack terminal alerts: `💀 [TARGET IS DOWN!] Connection Refused`.
5. **Step 5: Restart**
   - Run `npm start` again in terminal 1 to restart the demo.

---

## 📁 Project Structure

```
DDOS/
├── server.js            # Express server with dynamic rate limiting, telemetry, and OOM crash watchdog
├── demo-attack.js       # CLI attack generator (single, botnet, and IP-spoofing bypass modes)
├── package.json         # Node dependencies and convenience scripts
├── README.md            # Complete documentation & classroom demo script
└── public/
    └── dashboard.html   # Real-time Tailwind + Chart.js Socket.io monitor with live ceiling selector & crash overlay
```
