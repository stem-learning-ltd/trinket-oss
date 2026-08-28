/**
 * Pygame Manager - Local Mode
 *
 * Simplified manager for local/single-instance deployments.
 * Proxies browser connections directly to a single worker container.
 *
 * For production scaling, see scaler.js (AWS) or scaler.gcp.js (GCP).
 */

import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client } from 'socket.io-client';
import { fileTypeFromBuffer } from 'file-type';
import isSvg from 'is-svg';
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from 'config';
import crypto from 'node:crypto';
import { storageEnabled, putGenerated } from './storage.js';

// Verify the app-minted execution token (v1.<exp>.<hmac>) before accepting a
// browser. Shared EXEC_TOKEN_SECRET with the app; fails OPEN when unset so
// local/dev and a misconfigured rollout keep working.
const EXEC_TOKEN_SECRET = process.env.EXEC_TOKEN_SECRET;
if (!EXEC_TOKEN_SECRET) {
  console.log('[auth] EXEC_TOKEN_SECRET unset — exec token verification DISABLED (fail-open)');
}
function execTokenValid(token) {
  if (!EXEC_TOKEN_SECRET) return true;
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = parseInt(parts[1], 10);
  if (!exp || exp * 1000 < Date.now()) return false;
  const expected = crypto.createHmac('sha256', EXEC_TOKEN_SECRET).update('v1.' + parts[1]).digest();
  let provided;
  try { provided = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
  catch (e) { return false; }
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

const PORT = config.get('manager.port');
const HOST = config.get('manager.host');
const WORKER_URL = config.get('manager.workerUrl');
const GEN_DIR = config.get('manager.genDir');
const GEN_URL = config.get('manager.genUrl');
const VNC_PATH = config.get('manager.vncPath');

// The worker runs this many X displays (:1..:N), each with its own VNC stream.
// MUST equal the worker's PYGAME_DISPLAYS. A session claims a free display so
// concurrent games don't share a screen; when all are busy, new sessions are
// turned away rather than overlaid.
const DISPLAYS = config.has('manager.displays') ? config.get('manager.displays') : 4;
const freeDisplays = [];
for (let i = 1; i <= DISPLAYS; i++) freeDisplays.push(i);

// Keep track of connections and stats
const connections = {};
const stats = {
  totalConnections: 0,
  totalRuns: 0
};

/**
 * HTTP request handler for stats endpoint
 */
function handleHttpRequest(req, res) {
  // CORS headers
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/stats.json') {
    const activeCount = Object.keys(connections).length;
    const response = {
      available: 1,  // Local mode: always 1 worker available
      active: activeCount,
      mode: 'local',
      totalConnections: stats.totalConnections,
      totalRuns: stats.totalRuns,
      averages: {
        active: [],
        available: []
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Let Socket.io handle other requests
}

// HTTP server for Socket.io and stats
const server = createServer(handleHttpRequest);
const io = new Server(server, {
  cors: {
    origin: config.get('manager.corsOrigins')
  },
  // ENG-2169: a run arrives as ONE socket.io message carrying every trinket
  // file JSON-serialized, so a large data file (e.g. 650k-line txt ~5.5MB on
  // the wire) blows the engine.io default of 1MB — which doesn't error, it
  // silently kills the connection ("Disconnected" in the embed). 16MB covers
  // the app's 10MB trinket-save cap plus JSON wire-escaping overhead. Must
  // match the worker's value (server.js) — the manager relays the same
  // payload there via 'eval'.
  maxHttpBufferSize: 16 * 1024 * 1024
});

console.log(`Pygame manager starting on ${HOST}:${PORT}`);
console.log(`Worker URL: ${WORKER_URL}`);
console.log(`VNC Path: ${VNC_PATH}`);

// Ensure generated files directory exists
try {
  await mkdir(GEN_DIR, { recursive: true });
} catch (e) {
  // Ignore if exists
}

/**
 * Write generated file (image, HTML) to web-accessible location
 */
async function writeGeneratedFile(data, opts) {
  const dirname = Math.random().toString(36).slice(-8);

  if (storageEnabled()) {
    await putGenerated(`${dirname}/${data.name}`, data.buffer, opts.contentType);
  } else {
    const filedir = join(GEN_DIR, dirname);
    await mkdir(filedir, { recursive: true });
    await fsWriteFile(join(filedir, data.name), data.buffer);
  }

  data.url = `${GEN_URL}/${dirname}/${data.name}`;
  data[opts.type] = true;
}

/**
 * Connect to worker and set up event proxying
 */
function connectToWorker(browserId) {
  const conn = connections[browserId];
  if (!conn) return;

  console.log(`Connecting to worker for ${browserId}`);

  const workerSocket = Client(WORKER_URL, {
    forceNew: true,
    reconnection: false,
    // websocket only — same fix as the python3 manager→shell leg. Socket.IO's
    // default polling-first handshake opens several short-lived HTTP
    // connections per session through fly-proxy, each counted against the
    // worker's :8010 connection hard_limit. A 30-student class hitting Run
    // together tripped that limit at ~7 sessions; the other 23 got
    // "xhr poll error" → 'shell connect error' with the display pool empty
    // (scripts/pygame-stress, 2026-08-28). One websocket per session is what
    // the limit is sized for.
    transports: ['websocket'],
    // The flycast connection may have to wake the scale-to-zero worker first
    // (seconds warm, up to ~1 min cold). Socket.IO's default is 20s; be explicit.
    timeout: 20000
  });

  conn.workerSocket = workerSocket;

  workerSocket.on('connect', () => {
    console.log(`Worker connected for ${browserId}`);

    // Construct VNC URL from browser's host header. The token selects this
    // session's display; the worker's single token-multiplexing websockify
    // routes it to display :<n>'s VNC.
    const host = conn.browserSocket.handshake.headers.host || 'localhost:8080';
    const protocol = conn.browserSocket.handshake.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const rfbUrl = `${protocol}://${host}${VNC_PATH}/websockify?token=display${conn.display}`;

    // Tell browser the instance is ready with VNC URL
    conn.browserSocket.emit('instance ready', {
      rfbUrl: rfbUrl,
      audioUrl: null  // Audio not implemented in local mode
    });

    conn.ready = true;
  });

  workerSocket.on('connect_error', (err) => {
    console.error(`Worker connect error for ${browserId}:`, err.message);
    conn.browserSocket.emit('shell connect error');
    conn.browserSocket.emit('exit');
  });

  // Proxy events from worker to browser
  workerSocket.on('child ready', () => {
    conn.browserSocket.emit('child ready');
  });

  workerSocket.on('stdout', (data) => {
    conn.browserSocket.emit('stdout', data);
  });

  workerSocket.on('clear', () => {
    conn.browserSocket.emit('clear');
  });

  workerSocket.on('script error', (data) => {
    conn.browserSocket.emit('script error', { error: data.error });
  });

  // Enqueued onto conn.pending so uploads/relays stay ordered and 'exit' can
  // wait for them (see the connection setup comment).
  workerSocket.on('file added', (data) => {
    conn.pending = conn.pending.then(async () => {
      try {
        // Determine file type
        const type = await fileTypeFromBuffer(data.buffer);

        if ((type && /^image/.test(type.mime)) || isSvg(data.buffer)) {
          await writeGeneratedFile(data, { type: 'image', contentType: type ? type.mime : 'image/svg+xml' });
        } else if (type) {
          // Binary file
          data.binary = true;
        } else if (/\.html$/.test(data.name)) {
          await writeGeneratedFile(data, { type: 'html', contentType: 'text/html; charset=utf-8' });
        } else {
          // Text file
          data.content = data.buffer.toString('utf8');
        }
      } catch (e) {
        console.error('File type detection error:', e);
        data.typeError = e.message;
      }

      delete data.buffer;
      conn.browserSocket.emit('file added', data);
    }).catch((e) => console.log('file added error:', e));
  });

  workerSocket.on('done', async (result) => {
    await conn.pending;
    conn.browserSocket.emit('done', result);
  });

  workerSocket.on('exit', async () => {
    await conn.pending;
    conn.browserSocket.emit('exit');
  });

  workerSocket.on('disconnect', () => {
    console.log(`Worker disconnected for ${browserId}`);
  });

  return workerSocket;
}

// Handle browser connections
io.on('connection', (browser) => {
  if (!browser || !browser.id) {
    console.error('Invalid browser connection');
    return;
  }

  const browserId = browser.id;
  console.log(`Browser connected: ${browserId}`);

  // Reject runs that don't carry a valid app-minted token (before claiming a
  // display, so a bad client can't consume one).
  if (!execTokenValid(browser.handshake.auth && browser.handshake.auth.token)) {
    console.log('[auth] rejected connection: missing/invalid exec token');
    browser.emit('shell connect error');
    browser.emit('exit');
    browser.disconnect(true);
    return;
  }

  // Claim a free display. The worker runs a fixed pool (:1..:DISPLAYS); when
  // all are in use, turn this session away with a clear message rather than
  // overlaying it onto someone else's screen.
  const display = freeDisplays.shift();
  if (display === undefined) {
    console.log(`No free pygame display for ${browserId} (all ${DISPLAYS} in use)`);
    browser.emit('busy', { message: 'All pygame sessions are in use. Please try again shortly.' });
    // Also emit shell connect error so older clients surface something.
    browser.emit('shell connect error');
    browser.emit('exit');
    return;
  }
  console.log(`Assigned display :${display} to ${browserId} (${freeDisplays.length} free)`);

  connections[browserId] = {
    browserSocket: browser,
    workerSocket: null,
    ready: false,
    display: display,
    // Ordered queue of async 'file added' work (upload to object storage,
    // then relay). 'exit'/'done'/'disconnect' await it so a program that ends
    // right after emitting a file can't disconnect the browser before the
    // file — and its upload — is delivered. See the python3 manager for the
    // full rationale; the race is identical.
    pending: Promise.resolve()
  };

  connectToWorker(browserId);

  // Handle run request from browser
  browser.on('run', (data) => {
    const conn = connections[browserId];
    if (!conn || !conn.workerSocket) {
      browser.emit('shell connect error');
      browser.emit('exit');
      return;
    }

    // Basic security check (prevent crypto miners)
    if (data.code && (/verushash/.test(data.code) || /xmrig/.test(data.code))) {
      console.log('Blocked suspicious code');
      browser.emit('shell connect error');
      browser.emit('exit');
      browser.disconnect();
      return;
    }

    conn.workerSocket.emit('eval', {
      interactive: false,
      init: true,
      code: data.code,
      display: conn.display
    });
  });

  // Handle stdin input from browser
  browser.on('write', (data) => {
    const conn = connections[browserId];
    if (conn && conn.workerSocket) {
      conn.workerSocket.emit('write', {
        input: data.input,
        from: 'user'
      });
    }
  });

  // Handle stop request
  browser.on('stop', () => {
    const conn = connections[browserId];
    if (conn && conn.workerSocket) {
      conn.workerSocket.emit('stop');
    }
  });

  // Handle browser disconnect
  browser.on('disconnect', () => {
    console.log(`Browser disconnected: ${browserId}`);
    const conn = connections[browserId];
    if (conn) {
      if (conn.workerSocket) {
        conn.workerSocket.disconnect();
      }
      // Return the display to the pool for the next session.
      if (conn.display !== undefined) {
        freeDisplays.push(conn.display);
        console.log(`Released display :${conn.display} (${freeDisplays.length} free)`);
      }
    }
    delete connections[browserId];
  });

  // Timeout - disconnect after 10 minutes of inactivity
  const releaseTimer = setTimeout(() => {
    const conn = connections[browserId];
    if (conn && conn.browserSocket) {
      console.log(`Releasing connection after timeout: ${browserId}`);
      conn.browserSocket.emit('exit');
      conn.browserSocket.disconnect();
    }
  }, 600000);

  browser.on('disconnect', () => {
    clearTimeout(releaseTimer);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Pygame manager listening on ${HOST}:${PORT}`);
});
