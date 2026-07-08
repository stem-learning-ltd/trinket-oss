/**
 * Pygame Shell Server
 *
 * Spawns Python processes with pygame in a graphical environment.
 * Runs inside a container with Xvnc providing the display.
 */

import { spawn, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { watch } from 'chokidar';
import config from 'config';

const PYTHON = '/usr/bin/python3';
const PORT = config.get('shell.port');
const TMP_DIR = config.get('shell.tmpDir');

// Socket.io server
import { Server } from 'socket.io';
const io = new Server(PORT, {
  cors: {
    origin: config.get('shell.cors.origin'),
    credentials: true,
    methods: ['GET', 'POST']
  }
});

console.log(`Pygame shell listening on port ${PORT}`);

// Reset a specific display's background. Each concurrent session runs on its
// own display (:1, :2, ...) so a reset must target only that one — clearing
// :1 on every connect (the original behaviour) would wipe another session.
// execFileSync (no shell) — display is an int, but avoid shell interpolation.
function resetDisplay(display) {
  try {
    execFileSync('xsetroot', ['-display', `:${display}`, '-solid', 'GhostWhite']);
  } catch (e) {
    // Ignore errors if Xvnc not ready yet
  }
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  let child = null;
  let sessionDir = null;
  let watcher = null;
  let childReady = false;
  let childEnded = false;

  // Handle code execution
  socket.on('eval', async (data) => {
    try {
      // Which X display to render on — assigned by the manager per session so
      // concurrent games don't share a screen. Defaults to :1 for the
      // single-display / local-dev case.
      const display = parseInt(data.display, 10) || 1;
      resetDisplay(display);

      // Create session directory
      const hash = createHash('sha256');
      hash.update(Math.random().toString() + Date.now());
      const sessionId = hash.digest('hex').substring(0, 16);
      sessionDir = join(TMP_DIR, sessionId);

      await mkdir(sessionDir, { recursive: true });
      await chmod(sessionDir, 0o777);

      // Parse files from code payload
      let files = [];
      const ignoreFiles = [];

      if (data.code) {
        try {
          files = JSON.parse(data.code);
          if (!Array.isArray(files)) {
            throw new Error('Not an array');
          }
        } catch (e) {
          files = [{ name: 'main.py', content: data.code }];
        }

        // Write files to session directory
        for (const file of files) {
          if (file.name === 'assets' && Array.isArray(file.content)) {
            // Download assets
            for (const asset of file.content) {
              await downloadAsset(sessionDir, asset);
              ignoreFiles.push(join(sessionDir, asset.name));
            }
          } else {
            await writeFile(join(sessionDir, file.name), file.content, 'utf8');
          }
        }

        // Ignore the main file in watcher
        if (files[0] && files[0].name) {
          ignoreFiles.push(join(sessionDir, files[0].name));
        }
      }

      // Set up file watcher for generated files (matplotlib plots, etc.)
      const ignored = [...ignoreFiles, /[\/\\]\./];
      watcher = watch(sessionDir, {
        ignored,
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 500 }
      });

      watcher.on('add', (filepath) => {
        const filename = basename(filepath);
        import('node:fs').then(fs => {
          const buffer = fs.readFileSync(filepath);
          socket.emit('file added', { name: filename, buffer });
        });
      });

      watcher.on('change', (filepath) => {
        const filename = basename(filepath);
        import('node:fs').then(fs => {
          const buffer = fs.readFileSync(filepath);
          socket.emit('file added', { name: filename, buffer });
        });
      });

      watcher.on('error', (error) => {
        console.error('Watcher error:', error);
      });

      // Wait for watcher to be ready, then spawn Python
      watcher.on('ready', () => {
        const args = ['-u', '-B', join(sessionDir, 'main.py')];
        const options = {
          cwd: sessionDir,
          env: { ...process.env, DISPLAY: `:${display}` }
        };

        child = spawn(PYTHON, args, options);
        child.stdout.setEncoding('utf-8');
        child.stdin.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');

        const errors = [];

        child.stdout.on('data', (data) => {
          // Check for clear screen escape sequence
          if (/\x1b\[H\x1b\[2J/.test(data)) {
            socket.emit('clear');
          } else {
            socket.emit('stdout', data);
          }
        });

        child.stderr.on('data', (data) => {
          errors.push(data);
        });

        child.on('exit', async (code, signal) => {
          childEnded = true;

          if (errors.length) {
            const parsedError = parseError(errors);
            if (parsedError.trim()) {
              socket.emit('script error', { error: parsedError });
            }
          }

          // Small delay to allow file watcher to catch any final files
          setTimeout(async () => {
            socket.emit('exit');
            await cleanup();
          }, 500);
        });

        child.on('error', (err) => {
          console.error('Child process error:', err);
          socket.emit('script error', {
            error: 'Error: The Python process ended unexpectedly. Please try again.'
          });
        });

        childReady = true;
        socket.emit('child ready');
      });

    } catch (err) {
      console.error('Eval error:', err);
      socket.emit('script error', {
        error: 'Error: Failed to start Python process. Please try again.'
      });
    }
  });

  // Handle stdin input
  socket.on('write', (data) => {
    if (childReady && !childEnded && child && child.stdin.writable) {
      let input = data.input;

      // Ensure newline at end
      if (input && !input.endsWith('\n')) {
        input += '\n';
      }

      child.stdin.write(input);
    }
  });

  // Handle stop request
  socket.on('stop', () => {
    stopChild();
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    stopChild();
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });

  async function cleanup() {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    if (sessionDir) {
      try {
        await rm(sessionDir, { recursive: true, force: true });
      } catch (e) {
        console.error('Cleanup error:', e);
      }
      sessionDir = null;
    }
  }

  function stopChild() {
    if (child) {
      try {
        child.stdin.end();
        child.kill('SIGKILL');
      } catch (e) {
        console.error('Kill error:', e);
      }
      child = null;
    }
    cleanup();

    // Restart Xvnc to clear display (optional, may cause flicker)
    // execSync('/usr/bin/supervisorctl restart xvnc');
  }
});

function parseError(errors) {
  let errorStr = errors.join('');

  // Filter out noise messages that aren't actual errors
  const noisePatterns = [
    /Xlib:\s+extension "RANDR" missing on display[^\n]*\n?/g,
    /pygame \d+\.\d+\.\d+ \(SDL[^)]+\)[^\n]*\n?/g,
    /Hello from the pygame community\.[^\n]*\n?/g,
    /ALSA lib[^\n]*\n?/g,
    /Failed to create secure directory[^\n]*\n?/g,
    /Cannot connect to server socket[^\n]*\n?/g,
    /Cannot connect to server request channel[^\n]*\n?/g,
    /jack server is not running[^\n]*\n?/g,
  ];

  for (const pattern of noisePatterns) {
    errorStr = errorStr.replace(pattern, '');
  }

  // Handle "Original exception was:" pattern
  const origStr = 'Original exception was:';
  if (errorStr.includes(origStr)) {
    errorStr = errorStr.substring(errorStr.indexOf(origStr) + origStr.length);
  }

  // Clean up
  errorStr = errorStr.replace(/^\n+/g, '');
  errorStr = errorStr.replace(/\n*>>> \n*/g, '');
  errorStr = errorStr.replace(/\n*\.\.\. \n*/g, '');

  return errorStr;
}

async function downloadAsset(dir, asset) {
  const filepath = join(dir, asset.name);
  const file = createWriteStream(filepath);

  try {
    const response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(response.body, file);
  } catch (err) {
    console.error('Asset download error:', err);
    file.close();
    try {
      await rm(filepath);
    } catch (e) {}
    throw err;
  }
}
