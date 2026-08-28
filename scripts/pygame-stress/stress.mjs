#!/usr/bin/env node
/**
 * Pygame stress test — opens N concurrent pygame sessions against the exec
 * stack exactly the way the browser does, so the single worker is loaded on
 * BOTH axes that cost CPU: the Python game process AND the per-display VNC
 * encoder (Xvnc only encodes frames while a viewer is connected — a test
 * without VNC clients would understate the load by roughly half).
 *
 * Per session (mirrors public/js/embed/{server,pygame}.js):
 *   1. Socket.IO (websocket transport) to <exec>/pygame/socket.io/ with
 *      auth { token: <app-minted exec token> }            → manager claims a display
 *   2. wait 'instance ready' { rfbUrl }                  → open VNC drain on rfbUrl
 *   3. emit 'run' { code }                               → worker spawns python on :N
 *   4. count 'child ready' / 'stdout' / 'script error' / 'exit' / 'busy'
 *   5. after --duration: emit 'stop', disconnect          → display back to pool
 *
 * Zero dependencies: Node >= 22 (global WebSocket). Socket.IO/Engine.IO and
 * RFB are spoken by hand — only the handful of packets this test needs.
 *
 * Usage:
 *   node scripts/pygame-stress/stress.mjs --sessions 30 --duration 120 --metrics \
 *        --page https://ide.stem.org.uk/embed/pygame/<trinketId>
 *
 * Token: the managers verify an HMAC exec token minted by the app (24h TTL).
 * Give it one of three ways: --page <any pygame embed URL> (scraped from the
 * page), --token v1.<exp>.<sig>, or env EXEC_TOKEN. In a browser it's
 * `trinket.config.execToken` on any trinket page.
 *
 * Read the summary at the end: displays granted vs 'busy', time-to-ready,
 * VNC bytes per session-hour (→ egress cost), and (with --metrics) the
 * worker's CPU utilisation, load and memory sampled over `fly ssh console`.
 *
 * NB the manager force-exits every session 10 min after it accepts the
 * connection; --duration is capped so no session (warm-up included) runs into
 * that — ~590s on a warm tier, less after a cold start (see endAt in main).
 */

import { execFile } from 'node:child_process';

// Manager releaseTimer is 600s (serverside/pygame/manager/manager.js); leave a
// margin so we stop sessions ourselves rather than being cut off mid-report.
const SESSION_CAP_S = 590;

// ---------------------------------------------------------------- arguments

const DEFAULTS = {
  sessions: 30,
  duration: 120,        // seconds the games run before the test stops them
  ramp: 300,            // ms between session starts (a class hitting Run over ~10s)
  exec: 'https://exec.ide.stem.org.uk',
  page: '',             // pygame embed page to scrape the exec token from
  token: process.env.EXEC_TOKEN || '',
  vnc: true,            // open a VNC viewer per session (realistic load)
  metrics: false,       // sample the worker over `fly ssh console` every --every s
  every: 15,
  app: 'stem-trinket-pygame-worker',
  warmup: true,         // connect one session alone first (wakes manager+worker)
  report: 5,            // seconds between progress lines
  debug: false,         // log raw Socket.IO frames / VNC handshake per session
};

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'help' || key === 'h') { usage(); process.exit(0); }
    if (key.startsWith('no-')) { o[key.slice(3)] = false; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { o[key] = true; continue; }
    o[key] = typeof DEFAULTS[key] === 'number' ? Number(next) : next;
    i++;
  }
  return o;
}

function usage() {
  console.log(`Usage: node scripts/pygame-stress/stress.mjs [options]

  --sessions N      concurrent pygame sessions (default ${DEFAULTS.sessions})
  --duration S      seconds to keep the games running (default ${DEFAULTS.duration}; capped so no
                    session hits the manager's 10-min limit — ~${SESSION_CAP_S} warm, less after a cold start)
  --ramp MS         ms between session starts (default ${DEFAULTS.ramp})
  --exec URL        exec host (default ${DEFAULTS.exec})
  --page URL        a pygame embed page to scrape the exec token from
  --token TOKEN     exec token (v1.<exp>.<sig>); or env EXEC_TOKEN
  --no-vnc          don't open VNC viewers (python load only — understates CPU)
  --metrics         sample worker CPU (/proc/stat), load, memory via 'fly ssh console' (needs fly on PATH)
  --every S         metrics sample interval (default ${DEFAULTS.every})
  --no-warmup       don't connect one session first to wake the tier
  --report S        progress line interval (default ${DEFAULTS.report})
  --debug           log raw Socket.IO frames and VNC handshake per session`);
}

// ---------------------------------------------------------------- the game
// Representative student game: 30 bouncing balls at 60 fps on an 800x600
// window (matches the worker's Xvnc geometry). Solid background so the VNC
// encoder sees realistic partial-screen change per frame, not a full repaint.
// Prints a line every 5 s so stdout relay is exercised too. Runs until killed.

const PROGRAM = `import pygame, random, sys, time
pygame.init()
W, H = 800, 600
screen = pygame.display.set_mode((W, H))
pygame.display.set_caption("stress")
clock = pygame.time.Clock()
font = pygame.font.SysFont(None, 28)
balls = [[random.uniform(20, W-20), random.uniform(20, H-20),
          random.uniform(-4, 4), random.uniform(-4, 4),
          (random.randint(40, 255), random.randint(40, 255), random.randint(40, 255))]
         for _ in range(30)]
frames, t0 = 0, time.time()
while True:
    for e in pygame.event.get():
        if e.type == pygame.QUIT:
            sys.exit()
    screen.fill((20, 24, 40))
    for b in balls:
        b[0] += b[2]; b[1] += b[3]
        if b[0] < 12 or b[0] > W - 12: b[2] = -b[2]
        if b[1] < 12 or b[1] > H - 12: b[3] = -b[3]
        pygame.draw.circle(screen, b[4], (int(b[0]), int(b[1])), 12)
    frames += 1
    screen.blit(font.render("stress frame %d" % frames, True, (240, 240, 240)), (10, 10))
    pygame.display.flip()
    clock.tick(60)
    if frames % 300 == 0:
        print("%d frames, %.1f fps" % (frames, frames / (time.time() - t0)), flush=True)
`;

// ---------------------------------------------------------------- helpers

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtMs = (ms) => (ms == null ? '   -  ' : (ms / 1000).toFixed(1).padStart(5) + 's');
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function scrapeToken(pageUrl) {
  const res = await fetch(pageUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${pageUrl} → HTTP ${res.status}`);
  const html = await res.text();
  // lib/views/embed/base.html:  execToken : '{{ execToken() }}',
  const m = html.match(/execToken\s*:\s*'(v1\.\d+\.[A-Za-z0-9_-]+)'/);
  if (!m) throw new Error('no execToken found in page (is it a trinket embed page, and is EXEC_TOKEN_SECRET set on the app?)');
  return m[1];
}

function tokenExpiry(token) {
  const exp = parseInt((token.split('.')[1] || '0'), 10) * 1000;
  return exp ? new Date(exp) : null;
}

// ---------------------------------------------------------------- VNC drain
// Minimal RFB 3.3/3.7/3.8 client: handshake with security type None (the
// worker's Xtightvnc runs without -rfbauth), ClientInit, then a continuous
// stream of incremental FramebufferUpdateRequests. Received bytes are counted
// and discarded — we never decode, we just make the server encode.

const ENC_TIGHT = 7, ENC_HEXTILE = 5, ENC_RAW = 0;

class VncDrain {
  constructor(url, session) {
    this.session = session;
    this.bytes = 0;
    this.buf = Buffer.alloc(0);
    this.state = 'version';
    this.minor = 8;
    this.timer = null;
    this.error = null;
    this.open = false;
    try {
      this.ws = new WebSocket(url, ['binary']);
    } catch (e) {
      this.error = e.message; return;
    }
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('open', () => { this.open = true; });
    this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    // Node fires 'error' when we close() a live stream at the end of the run;
    // that isn't a failure — only errors before streaming began count.
    this.ws.addEventListener('error', () => { if (this.state !== 'streaming') this.error = this.error || 'websocket error'; });
    this.ws.addEventListener('close', (ev) => {
      this.open = false;
      if (this.timer) clearInterval(this.timer);
      if (this.state !== 'streaming' && !this.error) this.error = `closed during ${this.state} (code ${ev.code})`;
    });
  }

  send(buf) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf); }

  onMessage(ev) {
    const chunk = Buffer.from(ev.data);
    this.bytes += chunk.length;
    if (this.state === 'streaming') return;        // drain only
    this.buf = Buffer.concat([this.buf, chunk]);
    this.step();
  }

  step() {
    for (;;) {
      const b = this.buf;
      switch (this.state) {
        case 'version': {
          if (b.length < 12) return;
          const ver = b.toString('latin1', 0, 12);       // "RFB 003.008\n"
          this.minor = parseInt(ver.slice(8, 11), 10) || 3;
          this.buf = b.subarray(12);
          if (this.minor >= 7) {
            this.send(Buffer.from(`RFB 003.00${this.minor >= 8 ? 8 : 7}\n`, 'latin1'));
            this.state = 'secTypes';
          } else {
            this.send(Buffer.from('RFB 003.003\n', 'latin1'));
            this.state = 'sec33';
          }
          break;
        }
        case 'secTypes': {
          if (b.length < 1) return;
          const n = b[0];
          if (n === 0) { this.fail('server refused connection (0 security types)'); return; }
          if (b.length < 1 + n) return;
          const types = [...b.subarray(1, 1 + n)];
          this.buf = b.subarray(1 + n);
          if (!types.includes(1)) { this.fail(`no 'None' security type offered (got ${types.join(',')})`); return; }
          this.send(Buffer.from([1]));
          this.state = this.minor >= 8 ? 'secResult' : 'clientInit';
          break;
        }
        case 'sec33': {
          if (b.length < 4) return;
          const t = b.readUInt32BE(0);
          this.buf = b.subarray(4);
          if (t !== 1) { this.fail(`RFB 3.3 security type ${t} (need None)`); return; }
          this.state = 'clientInit';
          break;
        }
        case 'secResult': {
          if (b.length < 4) return;
          const r = b.readUInt32BE(0);
          this.buf = b.subarray(4);
          if (r !== 0) { this.fail('security handshake failed'); return; }
          this.state = 'clientInit';
          break;
        }
        case 'clientInit': {
          this.send(Buffer.from([1]));                  // shared-flag = 1
          this.state = 'serverInit';
          break;
        }
        case 'serverInit': {
          if (b.length < 24) return;
          const nameLen = b.readUInt32BE(20);
          if (b.length < 24 + nameLen) return;
          this.width = b.readUInt16BE(0);
          this.height = b.readUInt16BE(2);
          this.buf = Buffer.alloc(0);
          // SetEncodings: prefer Tight (what noVNC negotiates) so the server
          // does realistic compression work; Hextile/Raw as fallbacks.
          const encs = [ENC_TIGHT, ENC_HEXTILE, ENC_RAW];
          const se = Buffer.alloc(4 + 4 * encs.length);
          se[0] = 2; se.writeUInt16BE(encs.length, 2);
          encs.forEach((e, i) => se.writeInt32BE(e, 4 + 4 * i));
          this.send(se);
          this.requestUpdate(false);                    // one full frame
          this.state = 'streaming';
          this.session.t.vncReady = now();
          // Keep an update request outstanding ~30×/s; Xvnc coalesces extras.
          this.timer = setInterval(() => this.requestUpdate(true), 33);
          return;
        }
        default: return;
      }
    }
  }

  requestUpdate(incremental) {
    const m = Buffer.alloc(10);
    m[0] = 3; m[1] = incremental ? 1 : 0;
    m.writeUInt16BE(0, 2); m.writeUInt16BE(0, 4);
    m.writeUInt16BE(this.width || 800, 6); m.writeUInt16BE(this.height || 600, 8);
    this.send(m);
  }

  fail(msg) { this.error = msg; this.close(); }

  close() {
    if (this.timer) clearInterval(this.timer);
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- session
// Socket.IO v4 over Engine.IO v4 websocket transport, by hand:
//   server → "0{sid,pingInterval,...}"   client → "40{auth}"
//   server → "40{sid}" (connected)        server → "2" ping, client → "3" pong
//   events   "42[\"name\", data]"         binary events "45<n>-[...]" (+ frames, ignored)
//   server → "44{message}" connect_error  either → "41" disconnect

class Session {
  constructor(index, opts, token) {
    this.index = index;
    this.opts = opts;
    this.token = token;
    this.t = { start: null, connected: null, ready: null, run: null, childReady: null, vncReady: null, exit: null };
    this.display = null;
    this.status = 'pending';   // pending → connecting → connected → ready → running → stopped | busy | error
    this.error = null;
    this.stdoutLines = 0;
    this.scriptError = null;
    this.vnc = null;
    this.closed = false;
  }

  start() {
    this.t.start = now();
    this.status = 'connecting';
    const url = `${this.opts.exec.replace(/^http/, 'ws')}/pygame/socket.io/?EIO=4&transport=websocket`;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.fail(e.message); return;
    }
    this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    this.ws.addEventListener('error', (ev) => {
      const detail = ev.message || (ev.error && (ev.error.message || ev.error.code)) || 'no detail';
      this.debug(`error event: ${detail}`);
      this.fail(`websocket error: ${detail}`);
    });
    this.ws.addEventListener('close', (ev) => {
      this.debug(`close code=${ev.code} reason=${JSON.stringify(ev.reason)} wasClean=${ev.wasClean}`);
      if (!this.closed && this.status !== 'error' && this.status !== 'busy') {
        this.status = this.status === 'running' ? 'dropped' : this.status;
        this.error = this.error || `socket closed (code ${ev.code})`;
      }
      if (this.vnc) this.vnc.close();
    });
  }

  debug(msg) { if (this.opts.debug) console.log(`  [s${this.index}] ${msg}`); }
  send(s) {
    this.debug(`-> ${s.length > 100 ? s.slice(0, 100) + '…' : s}`);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
  }
  emit(event, data) { this.send('42' + JSON.stringify(data === undefined ? [event] : [event, data])); }

  onMessage(ev) {
    if (typeof ev.data !== 'string') { this.debug(`<- (binary ${ev.data.byteLength || ev.data.size} bytes)`); return; }
    const d = ev.data;
    this.debug(`<- ${d.length > 140 ? d.slice(0, 140) + '…' : d}`);
    switch (d[0]) {
      case '0':                                          // engine.io OPEN
        this.send('40' + JSON.stringify({ token: this.token }));
        return;
      case '2': this.send('3'); return;                  // ping → pong
      case '4': break;                                   // socket.io packet
      default: return;
    }
    const kind = d[1];
    const payload = d.slice(2);
    if (kind === '0') {                                  // CONNECT ack
      this.t.connected = now();
      this.status = 'connected';
      return;
    }
    if (kind === '4') {                                  // CONNECT_ERROR (e.g. bad token)
      let msg = payload;
      try { msg = JSON.parse(payload).message || payload; } catch { /* keep raw */ }
      this.fail(`connect_error: ${msg}`);
      return;
    }
    if (kind === '1') { this.closed = true; return; }    // server DISCONNECT
    if (kind === '2' || kind === '5') {                  // EVENT / BINARY_EVENT
      const json = kind === '5' ? payload.slice(payload.indexOf('-') + 1) : payload;
      let arr;
      try { arr = JSON.parse(json); } catch { return; }
      this.onEvent(arr[0], arr[1]);
    }
  }

  onEvent(name, arg) {
    switch (name) {
      case 'instance ready': {
        this.t.ready = now();
        this.status = 'ready';
        const m = /token=display(\d+)/.exec(arg && arg.rfbUrl || '');
        this.display = m ? parseInt(m[1], 10) : null;
        if (this.opts.vnc && arg && arg.rfbUrl) this.vnc = new VncDrain(arg.rfbUrl, this);
        this.t.run = now();
        this.emit('run', { code: PROGRAM });
        this.status = 'running';
        break;
      }
      case 'child ready': this.t.childReady = now(); break;
      case 'stdout': this.stdoutLines++; break;
      case 'script error': this.scriptError = (arg && arg.error) || String(arg); break;
      case 'busy': this.status = 'busy'; this.error = (arg && arg.message) || 'busy'; break;
      case 'shell connect error':
        // The manager emits this both for a rejected exec token (before any
        // display is claimed) and when it can't reach the worker.
        if (this.status !== 'busy') this.fail(this.status === 'connected' && !this.t.ready
          ? 'shell connect error (exec token rejected — expired/invalid? — or manager could not reach the worker)'
          : 'shell connect error (manager lost the worker)');
        break;
      case 'exit': this.t.exit = now(); if (this.status === 'running') this.status = 'exited'; break;
      default: break;
    }
  }

  fail(msg) {
    if (this.status === 'error') return;
    this.status = 'error';
    this.error = msg;
  }

  stop() {
    this.closed = true;
    if (this.status === 'running') this.status = 'stopped';
    try { this.emit('stop'); this.send('41'); } catch { /* ignore */ }
    if (this.vnc) this.vnc.close();
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- worker metrics

// CPU% is the /proc/stat busy/total delta between this sample and the previous
// one — true utilisation for the interval. The 1-min load average is shown
// alongside but NOT used for the verdict: it's an exponential average that
// only reaches ~86% of the real value after 120 s of steady load, so on the
// recommended 2-minute run it understates a saturated worker and biases the
// sizing verdict toward a smaller VM.
// "games" counts student processes (python3 … main.py). `ps -C python3` would
// also count supervisord and websockify — both are python3 scripts.
function sampleWorker(app, prev) {
  const fly = process.platform === 'win32' ? 'fly.exe' : 'fly';
  const cmd = 'sh -c \'cat /proc/loadavg; head -1 /proc/stat; free -m | sed -n 2p; nproc; ps -eo args= | grep -c "[m]ain.py" || true\'';
  return new Promise((resolve) => {
    execFile(fly, ['ssh', 'console', '-a', app, '-C', cmd], { timeout: 25000, windowsHide: true }, (err, stdout, stderr) => {
      const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l && !/^(No machine specified|Connecting to|Warning:)/.test(l));
      if (lines.length < 5) {
        const detail = String(stderr || '').trim().split('\n')[0] || (err && err.message) || 'unexpected output';
        return resolve({ error: `fly ssh failed: ${detail.split('\n')[0]}` });
      }
      const [loadavg, stat, mem, nproc, games] = lines.slice(-5);
      const [l1, l5] = loadavg.split(/\s+/).map(Number);
      const cpu = stat.split(/\s+/).slice(1).map(Number);   // user nice system idle iowait irq softirq steal …
      const cpuTotal = cpu.reduce((a, b) => a + (b || 0), 0);
      const cpuIdle = (cpu[3] || 0) + (cpu[4] || 0);
      const memF = mem.split(/\s+/);           // Mem: total used free shared buff/cache available
      const cores = Number(nproc) || 1;
      let cpuPct = null;                       // needs a previous sample to diff against
      if (prev && !prev.error && cpuTotal > prev.cpuTotal) {
        const busy = (cpuTotal - cpuIdle) - (prev.cpuTotal - prev.cpuIdle);
        cpuPct = Math.round((busy / (cpuTotal - prev.cpuTotal)) * 100);
      }
      return resolve({
        load1: l1, load5: l5, cores, cpuTotal, cpuIdle, cpuPct,
        memUsedMB: Number(memF[2]), memTotalMB: Number(memF[1]),
        games: Number(games),
      });
    });
  });
}

const fmtSample = (s) => s.error
  ? `worker: ${s.error}`
  : `worker: cpu ${s.cpuPct == null ? '–' : s.cpuPct + '%'}, load ${s.load1.toFixed(1)}/${s.cores} cores, mem ${s.memUsedMB}/${s.memTotalMB} MB, games ${s.games}`;

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof WebSocket === 'undefined') {
    console.error('Node 22+ required (global WebSocket). You have ' + process.version);
    process.exit(2);
  }
  if (opts.duration > SESSION_CAP_S) {
    console.log(`--duration ${opts.duration}s clamped to ${SESSION_CAP_S}s: the manager hard-caps sessions at 10 min`);
    opts.duration = SESSION_CAP_S;
  }

  let token = opts.token;
  if (!token && opts.page) {
    process.stdout.write(`Scraping exec token from ${opts.page} … `);
    token = await scrapeToken(opts.page);
    console.log(`ok (expires ${tokenExpiry(token)?.toISOString()})`);
  }
  if (!token) {
    console.error('No exec token. Pass --page <pygame embed URL>, --token v1.<exp>.<sig>, or set EXEC_TOKEN.\n' +
      'In a browser on any trinket page: trinket.config.execToken');
    process.exit(2);
  }
  const exp = tokenExpiry(token);
  if (exp && exp < new Date()) { console.error(`Token expired at ${exp.toISOString()}`); process.exit(2); }

  console.log(`\nPygame stress test → ${opts.exec}`);
  console.log(`  sessions ${opts.sessions}, duration ${opts.duration}s, ramp ${opts.ramp}ms, VNC viewers ${opts.vnc ? 'on' : 'OFF (CPU understated)'}, metrics ${opts.metrics ? `every ${opts.every}s` : 'off'}\n`);

  const sessions = Array.from({ length: opts.sessions }, (_, i) => new Session(i + 1, opts, token));
  const samples = [];
  let metricsTimer = null;
  const stopAll = () => sessions.forEach((s) => s.stop());
  process.on('SIGINT', () => { console.log('\nInterrupted — stopping sessions'); stopAll(); setTimeout(() => process.exit(130), 1500); });

  const t0 = now();

  // Warm-up: one session alone wakes the (scale-to-zero) manager + worker.
  // The very first connection into a stopped Machine is sometimes reset while
  // fly-proxy starts it, so retry a few times before giving up.
  let first = 0;
  if (opts.warmup) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      process.stdout.write(`Warm-up ${attempt}/4: connecting session 1 (wakes manager + worker; cold start can take ~1 min) … `);
      sessions[0] = new Session(1, opts, token);
      sessions[0].start();
      const deadline = now() + 120000;
      while (sessions[0].status === 'connecting' || sessions[0].status === 'connected') {
        if (now() > deadline) break;
        await sleep(200);
      }
      console.log(`${sessions[0].status} after ${fmtMs(now() - sessions[0].t.start).trim()}${sessions[0].error ? ' — ' + sessions[0].error : ''}`);
      if (sessions[0].status !== 'error') break;
      const tokenProblem = /token rejected/.test(sessions[0].error || '');
      if (tokenProblem || attempt === 4) {
        console.error(tokenProblem
          ? 'The manager rejected the exec token — get a fresh one (--page, or trinket.config.execToken in a browser).'
          : 'Warm-up failed 4×; aborting before ramping. Check: fly status -a stem-trinket-pygame-manager / -worker, fly logs -a stem-trinket-pygame-manager');
        stopAll(); process.exit(1);
      }
      sessions[0].stop();
      await sleep(5000);
    }
    first = 1;
  }

  if (opts.metrics) {
    const take = async () => { const s = await sampleWorker(opts.app, samples[samples.length - 1]); s.at = Math.round((now() - t0) / 1000); samples.push(s); };
    take();
    metricsTimer = setInterval(take, opts.every * 1000);
  }

  // Ramp the rest.
  for (let i = first; i < sessions.length; i++) {
    sessions[i].start();
    await sleep(opts.ramp);
  }
  const rampDone = now();

  // Run for --duration from the end of the ramp, but never past the point
  // where the EARLIEST-accepted session hits the manager's 10-min cap. The
  // manager's per-session clock starts when it accepts the Socket.IO
  // connection — for the warm-up session that's BEFORE the worker's ~1 min
  // cold start, and for ramped sessions before the ramp finishes — so without
  // this a long run has healthy sessions force-exited mid-test and reported
  // as "exited early" / "socket closed" errors.
  const earliest = Math.min(...sessions.map((s) => s.t.connected || s.t.start || rampDone));
  let endAt = rampDone + opts.duration * 1000;
  if (endAt > earliest + SESSION_CAP_S * 1000) {
    endAt = earliest + SESSION_CAP_S * 1000;
    opts.duration = Math.max(0, Math.round((endAt - rampDone) / 1000));
    console.log(`Run shortened to ${opts.duration}s: warm-up + ramp used ${fmtMs(rampDone - earliest).trim()} of the manager's 10-min per-session cap`);
  }
  console.log(`All ${sessions.length} sessions started (${fmtMs(rampDone - t0).trim()} elapsed). Running for ${opts.duration}s …\n`);

  // Progress lines.
  let lastBytes = 0, lastTick = now();
  while (now() < endAt) {
    await sleep(opts.report * 1000);
    const c = count(sessions);
    const bytes = vncBytes(sessions);
    const rate = (bytes - lastBytes) / ((now() - lastTick) / 1000);
    lastBytes = bytes; lastTick = now();
    const m = samples.length ? '  ' + fmtSample(samples[samples.length - 1]) : '';
    console.log(`[${String(Math.round((now() - t0) / 1000)).padStart(4)}s] running ${c.running}/${sessions.length}  childReady ${c.childReady}  busy ${c.busy}  error ${c.error}  exited ${c.exited}  vnc ${fmtMB(bytes)} (${(rate / 1024).toFixed(0)} KB/s)${m}`);
  }

  console.log('\nStopping all sessions …');
  stopAll();
  if (metricsTimer) clearInterval(metricsTimer);
  await sleep(1500);
  if (opts.metrics) { const s = await sampleWorker(opts.app, samples[samples.length - 1]); s.at = Math.round((now() - t0) / 1000); samples.push(s); }

  report(sessions, samples, opts, first);
  process.exit(0);
}

function count(sessions) {
  const c = { running: 0, childReady: 0, busy: 0, error: 0, exited: 0, granted: 0 };
  for (const s of sessions) {
    if (s.status === 'running') c.running++;
    if (s.t.childReady) c.childReady++;
    if (s.status === 'busy') c.busy++;
    if (s.status === 'error' || s.status === 'dropped') c.error++;
    if (s.status === 'exited') c.exited++;
    if (s.display) c.granted++;
  }
  return c;
}

const vncBytes = (sessions) => sessions.reduce((n, s) => n + (s.vnc ? s.vnc.bytes : 0), 0);

function report(sessions, samples, opts, first) {
  const c = count(sessions);
  const ramped = sessions.slice(first);
  const ready = ramped.filter((s) => s.t.ready).map((s) => s.t.ready - s.t.start);
  const child = sessions.filter((s) => s.t.childReady).map((s) => s.t.childReady - s.t.run);
  const vncOk = sessions.filter((s) => s.vnc && s.vnc.state === 'streaming');
  const vncErr = sessions.filter((s) => s.vnc && s.vnc.error && s.vnc.state !== 'streaming');
  const bytes = vncBytes(sessions);
  const sessionSeconds = sessions.filter((s) => s.t.run).reduce((n, s) => n + ((s.t.exit || now()) - s.t.run) / 1000, 0);
  const gbPerSessionHour = sessionSeconds ? (bytes / 1e9) / (sessionSeconds / 3600) : 0;

  console.log('\n================ RESULT ================');
  console.log(`Sessions requested            ${sessions.length}`);
  console.log(`Displays granted              ${c.granted}   (busy: ${c.busy}, errors: ${c.error}, exited early: ${c.exited})`);
  console.log(`Python 'child ready' reached  ${c.childReady}`);
  if (first) console.log(`Cold start (session 1 → ready)  ${fmtMs(sessions[0].t.ready ? sessions[0].t.ready - sessions[0].t.start : null).trim()}`);
  console.log(`Time to 'instance ready'      p50 ${fmtMs(percentile(ready, 50)).trim()}  p95 ${fmtMs(percentile(ready, 95)).trim()}  max ${fmtMs(ready.length ? Math.max(...ready) : null).trim()}   (warm, ${ready.length} sessions)`);
  console.log(`Run → python 'child ready'    p50 ${fmtMs(percentile(child, 50)).trim()}  p95 ${fmtMs(percentile(child, 95)).trim()}  max ${fmtMs(child.length ? Math.max(...child) : null).trim()}`);
  console.log(`stdout lines relayed          ${sessions.reduce((n, s) => n + s.stdoutLines, 0)}`);
  if (opts.vnc) {
    console.log(`VNC viewers streaming         ${vncOk.length}/${sessions.filter((s) => s.vnc).length}${vncErr.length ? `   (${vncErr.length} failed: ${vncErr[0].vnc.error})` : ''}`);
    console.log(`VNC bytes received            ${fmtMB(bytes)} over ${(sessionSeconds / 60).toFixed(1)} session-minutes`);
    console.log(`  ≈ ${gbPerSessionHour.toFixed(2)} GB per session-hour → ${(gbPerSessionHour * 0.02 * 30).toFixed(2)} $/class-hour egress at $0.02/GB × 30 students`);
  }
  const errs = sessions.filter((s) => s.error && s.status !== 'busy');
  if (errs.length) {
    console.log(`\nErrors (${errs.length}):`);
    const seen = new Map();
    for (const s of errs) seen.set(s.error, (seen.get(s.error) || 0) + 1);
    for (const [msg, n] of seen) console.log(`  ${n}× ${msg}`);
  }
  const se = sessions.find((s) => s.scriptError);
  if (se) console.log(`\nFirst script error (session ${se.index}):\n${String(se.scriptError).split('\n').slice(-5).join('\n')}`);

  if (samples.length) {
    const ok = samples.filter((s) => !s.error);
    const withCpu = ok.filter((s) => s.cpuPct != null);
    console.log('\nWorker samples (fly ssh; cpu = /proc/stat utilisation since the previous sample):');
    for (const s of samples) console.log(`  t+${String(s.at).padStart(4)}s  ${fmtSample(s)}`);
    if (withCpu.length) {
      const peak = withCpu.reduce((a, b) => (b.cpuPct > a.cpuPct ? b : a));
      const peakMem = Math.max(...ok.map((s) => s.memUsedMB));
      console.log(`\nPeak: cpu ${peak.cpuPct}% of ${peak.cores} cores (load ${peak.load1.toFixed(1)}), mem ${peakMem}/${peak.memTotalMB} MB`);
      const verdict = peak.cpuPct > 85 ? 'CPU-bound at this size — keep performance-16x or reduce displays'
        : peak.cpuPct < 45 && peakMem < peak.memTotalMB * 0.5 ? 'plenty of headroom — performance-8x/32gb (−34%) is worth trying'
        : peak.cpuPct < 65 ? 'moderate headroom — performance-12x/24gb is a candidate if memory allows'
        : 'reasonably sized — keep as is';
      console.log(`Verdict: ${verdict}`);
    } else if (ok.length) {
      console.log('\n(no CPU utilisation: needs two successful samples — lower --every or run longer)');
    }
  } else {
    console.log('\n(no worker metrics — rerun with --metrics, or watch: fly ssh console -a stem-trinket-pygame-worker -C "top -bn1 | head -15")');
  }
  console.log('=========================================');
}

main().catch((e) => { console.error('\nFatal:', e.message || e); process.exit(1); });
