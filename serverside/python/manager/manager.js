import { createServer } from "http";
import { Server } from "socket.io";
import { io as Client } from "socket.io-client";

import { fileTypeFromBuffer } from 'file-type';
import isSvg from 'is-svg';
import { mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import config from 'config';
import { storageEnabled, putGenerated } from './storage.js';

/**
 * Cleanup old generated files to prevent disk space exhaustion.
 *
 * Generated files (images, HTML from user code) are stored in generatedDir.
 * This function removes files older than maxAgeHours to free disk space.
 *
 * Configuration (in config/default.json):
 *   manager.cleanup.enabled: boolean - Enable/disable cleanup (default: true)
 *   manager.cleanup.maxAgeHours: number - Delete files older than this (default: 24)
 *   manager.cleanup.intervalMinutes: number - How often to run cleanup (default: 60)
 */
async function cleanupOldFiles() {
  const configManager = config.get('manager');
  const cleanupConfig = configManager.cleanup || {};

  if (cleanupConfig.enabled === false) {
    return;
  }

  const maxAgeHours = cleanupConfig.maxAgeHours || 24;
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  const generatedDir = configManager.generatedDir;

  console.log(`[Cleanup] Starting cleanup of files older than ${maxAgeHours} hours in ${generatedDir}`);

  let deletedCount = 0;
  let errorCount = 0;

  try {
    const entries = await readdir(generatedDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = join(generatedDir, entry.name);
        try {
          const dirStat = await stat(dirPath);
          const age = now - dirStat.mtimeMs;

          if (age > maxAgeMs) {
            await rm(dirPath, { recursive: true, force: true });
            deletedCount++;
          }
        } catch (err) {
          console.error(`[Cleanup] Error processing ${dirPath}:`, err.message);
          errorCount++;
        }
      }
    }

    console.log(`[Cleanup] Complete. Deleted ${deletedCount} directories, ${errorCount} errors.`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[Cleanup] Directory ${generatedDir} does not exist yet, skipping.`);
    } else {
      console.error('[Cleanup] Error during cleanup:', err.message);
    }
  }
}

function startCleanupScheduler() {
  const configManager = config.get('manager');
  const cleanupConfig = configManager.cleanup || {};

  if (cleanupConfig.enabled === false) {
    console.log('[Cleanup] Disabled by configuration');
    return;
  }

  const intervalMinutes = cleanupConfig.intervalMinutes || 60;
  const intervalMs = intervalMinutes * 60 * 1000;

  // Run cleanup on startup
  cleanupOldFiles();

  // Schedule periodic cleanup
  setInterval(cleanupOldFiles, intervalMs);
  console.log(`[Cleanup] Scheduled to run every ${intervalMinutes} minutes`);
}

// Start cleanup scheduler
startCleanupScheduler();

/**
 * HTTP request handler for stats endpoint
 */
function handleHttpRequest(req, res) {
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
    const response = {
      active: connections,
      available: 1,
      mode: 'local'
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
}

const httpServer = createServer(handleHttpRequest);
const io = new Server(httpServer, {
  cors: {
    origin: config.get('manager.corsOrigins')
  }
});

let connections = 0;

// Get shells array from config, randomly select one
const getShellSocket = async () => {
  const shells = config.get('shells');
  const shellUrl = shells[Math.floor(Math.random() * shells.length)];
  console.log('shellUrl:', shellUrl);
  try {
    const shellClient = Client(shellUrl, {
      'forceNew' : true,
      'reconnectionAttempts' : 0,
      // websocket only: shells sit behind a flycast load balancer with no
      // session affinity, so long-polling breaks (handshake and follow-up
      // requests hit different shell Machines -> "xhr post error"). A single
      // websocket connection has no such requirement.
      'transports' : ['websocket'],
      // 2s was too tight: a flycast connection to a scaled-to-zero shell must
      // wake a Firecracker Machine first (~seconds).
      'timeout' : 10000
    });

    return new Promise((resolve, reject) => {
      shellClient.on("connect", () => {
        resolve(shellClient);
      });
      shellClient.on("connect_error", (error) => {
        reject(error);
      });
    });
  } catch (error) {
    console.log('io client error:', error);
  }
}

io.on("connection", (browser) => {
  let shellSocket;

  connections = connections + 1;

  const getSocket = async () => {
    if (shellSocket) {
      return shellSocket;
    }

    shellSocket = await getShellSocket();

    // shell is ready for input
    shellSocket.on('child ready', () => {
      browser.emit('child ready');
    });

    // output from the shell
    shellSocket.on('stdout', (data) => {
      console.log('shell stdout data:', data);
      try {
        const addr = browser.handshake.headers['x-forwarded-for'] || browser.handshake.address.address;
        console.log('stdout addr:', addr);
      } catch(e) {}
      browser.emit('stdout', data);
    });

    // clear console
    shellSocket.on('clear', () => {
      browser.emit('clear');
    });

    // an error in the code from the user
    shellSocket.on('script error', (data) => {
      browser.emit('script error', {
        error : data.error
      });
    });

    shellSocket.on('compile error', (data) => {
      browser.emit('compile error', {
        error : data.error
      });
    });

    // a new file was added by the user code
    shellSocket.on('file added', async (data) => {
      try {
        // try to determine what type of file was added
        data.type = await fileTypeFromBuffer(data.buffer);

        if ((data.type && /^image/.test(data.type.mime)) || isSvg(data.buffer)) {
          const configManager = config.get('manager');
          // write file contents to some web accessible folder
          const imagedir = Math.random().toString(36).slice(-8);
          const imagepath = `${configManager.generatedDir}/${imagedir}`;
          const filepath = `${imagepath}/${data.name}`;

          try {
            if (storageEnabled()) {
              await putGenerated(`${imagedir}/${data.name}`, data.buffer,
                data.type ? data.type.mime : 'image/svg+xml');
            } else {
              await mkdir(imagepath, { recursive: true });
              await writeFile(filepath, data.buffer);
            }
          } catch(addErr) {
            console.log('addErr:', addErr);
          }

          data.url = `${configManager.generatedUrl}/${imagedir}/${data.name}`;
          data.image = true;
        }
        else if (data.type || (data.type && data.type.mime && /sqlite/.test(data.type.mime))) {
          // assume some binary format
          data.binary = true;
        }
        else if (/\.html$/.test(data.name)) {
          const configManager = config.get('manager');
          // write file contents to some web accessible folder
          const htmldir = Math.random().toString(36).slice(-8);
          const htmlpath = `${configManager.generatedDir}/${htmldir}`;
          const filepath = `${htmlpath}/${data.name}`;

          try {
            if (storageEnabled()) {
              await putGenerated(`${htmldir}/${data.name}`, data.buffer,
                'text/html; charset=utf-8');
            } else {
              await mkdir(htmlpath, { recursive: true });
              await writeFile(filepath, data.buffer);
            }
          } catch(addErr) {
            console.log('addErr:', addErr);
          }

          data.url = `${configManager.generatedUrl}/${htmldir}/${data.name}`;
          data.html = true;
        }
        else {
          // convert buffer to a string
          data.content = data.buffer.toString('utf8');
        }
      } catch(e) {
        data.typeError = e;
      }

      delete data.buffer;

      browser.emit('file added', data);
    });

    // when an interactive command finishes
    // lets the browser know to print prompt and accept input
    shellSocket.on('done', (result) => {
      browser.emit('done', result);
    });

    // when a non-interactive program completes
    shellSocket.on('exit', () => {
      browser.emit('exit');
    });

    shellSocket.on('disconnect', () => {
      console.log('shellSocket on disconnect?');
      browser.emit('exit');
      browser.disconnect();
    });

    return shellSocket;
  }

  browser.on('run', async (data) => {
    try {
      const client = await getSocket();
      client.emit('eval', {
        init : true,
        code : data.code
      });
    } catch (error) {
      browser.emit('shell connect error');
      browser.emit('exit');
      browser.disconnect();
    }
  });

  // when a user interacts with the console in the browser
  browser.on('console', async (data) => {
    try {
      const client = await getSocket();
      if (data.init) {
        client.emit('eval', {
          interactive : true,
          init: true,
          files: data.files
        });
      }
      client.emit('write', {
        input: data.input,
        from: 'console'
      });
    } catch (error) {
      browser.emit('shell connect error');
      browser.emit('exit');
      browser.disconnect();
    }
  });

  // when a user inputs data from the browser
  browser.on('write', async (data) => {
    try {
      const client = await getSocket();
      client.emit('write', {
        input : data.input
      });
    } catch (error) {
      browser.emit('shell connect error');
      browser.emit('exit');
      browser.disconnect();
    }
  });

  // query how many connections there are
  browser.on('connections', () => {
    // don't count this connection
    browser.emit('current connections', connections - 1);
  });

  // when the browser disconnects
  browser.on('disconnect', () => {
    // disconnect from shell
    if (shellSocket) {
      shellSocket.disconnect();
    }
    connections = connections - 1;
  });
});

httpServer.listen(config.get('manager.port'));
