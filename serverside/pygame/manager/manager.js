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
import { storageEnabled, putGenerated } from './storage.js';

const PORT = config.get('manager.port');
const HOST = config.get('manager.host');
const WORKER_URL = config.get('manager.workerUrl');
const GEN_DIR = config.get('manager.genDir');
const GEN_URL = config.get('manager.genUrl');
const VNC_PATH = config.get('manager.vncPath');

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
  }
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
    reconnection: false
  });

  conn.workerSocket = workerSocket;

  workerSocket.on('connect', () => {
    console.log(`Worker connected for ${browserId}`);

    // Construct VNC URL from browser's host header
    const host = conn.browserSocket.handshake.headers.host || 'localhost:8080';
    const protocol = conn.browserSocket.handshake.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const rfbUrl = `${protocol}://${host}${VNC_PATH}`;

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

  connections[browserId] = {
    browserSocket: browser,
    workerSocket: null,
    ready: false,
    // Ordered queue of async 'file added' work (upload to object storage,
    // then relay). 'exit'/'done'/'disconnect' await it so a program that ends
    // right after emitting a file can't disconnect the browser before the
    // file — and its upload — is delivered. See the python3 manager for the
    // full rationale; the race is identical.
    pending: Promise.resolve()
  };

  // Connect to worker immediately (local mode - always available)
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
      code: data.code
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
    if (conn && conn.workerSocket) {
      conn.workerSocket.disconnect();
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
