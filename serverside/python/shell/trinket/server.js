import * as child_process from 'child_process';
const {
  createHash
} = await import('node:crypto');
import {
  mkdir,
  unlink,
  writeFile
} from 'node:fs/promises';
import {
  chownSync,
  constants,
  readFileSync,
  lstatSync,
  readdirSync,
  rmSync
} from 'node:fs';
import * as chokidar from 'chokidar';
import * as path from 'node:path';

import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';

import _ from 'underscore';

import https from 'https';

/*
let https;
try {
  https = await import('node:https');
} catch (err) {
  console.error('https support is disabled!');
}
*/

const httpServer = createServer();
const io = new Server(httpServer, {
  // ENG-2169: the manager relays the browser's whole trinket (all files in
  // one 'console' message); the engine.io default of 1MB silently drops the
  // connection for big data files. Must match the manager's value.
  maxHttpBufferSize: 16 * 1024 * 1024
});

const python = '/usr/local/bin/python3';
const uid = 1000;
const gid = 1000;

let connections = 0;
// ChildProcess -> its run-limit timer. Keyed by the process object, not its
// pid: a failed spawn has pid undefined, and every failed spawn would then
// share (and clear) one entry.
const childTimers = new Map();

// ---------------------------------------------------------------------------
// Session reaping (ENG-2463)
//
// Abandoned sessions repeatedly took python3 down. Connections and python
// children outlived the browser that started them. A Machine holding open
// connections never auto-stops, so shells stayed up for days, degraded, and
// eventually fly-proxy stopped routing to them -- every Run then failed with
// "Server connection lost" while each shell was still individually healthy.
//
// This server used to clean up only when its socket disconnected, and nothing
// disconnected a socket once its run had ended. Reproduced locally: if the
// browser leaves while the manager is still connecting to the shell, the
// manager never closes that connection, and it stays open with no process
// behind it until the manager restarts. Production also had python children
// blocked in input() for a day or more, cause not pinned down. So reaping is
// layered, and each layer works without the others:
//
//   1. per-run watchdog  - kills the run's whole process group, not just the
//                          socket
//   2. connection close  - after a run exits, and for idle connections
//   3. stray sweeper     - kills student processes in /proc that belong to no
//                          run node is tracking: leftovers of a crashed node,
//                          and anything that escaped its run's process group
//
// Limits are env-tunable so they can be changed without a code change. Values
// are whole milliseconds between 1s and 2^31-1: Node fires any longer timer
// after 1ms, so an oversized "effectively never" would instead act at once.
// Anything else (including "60s", which parseInt would read as 60) is ignored.
const MAX_TIMER_MS = 2147483647;
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (Number.isInteger(v) && v >= 1000 && v <= MAX_TIMER_MS) return v;
  console.log('reap: ignoring ' + name + '=' + JSON.stringify(raw) + ', using ' + fallback + 'ms');
  return fallback;
}

const MAX_RUN_MS     = envMs('TRINKET_MAX_RUN_MS', 60000);
const IDLE_SOCKET_MS = envMs('TRINKET_IDLE_SOCKET_MS', 5 * 60 * 1000);
const EXIT_GRACE_MS  = envMs('TRINKET_EXIT_GRACE_MS', 30 * 1000);
const SWEEP_EVERY_MS = envMs('TRINKET_SWEEP_EVERY_MS', 60 * 1000);
// Age at which leftover session folders are removed. Must exceed MAX_RUN_MS,
// so a live run's folder is never old enough to be swept.
let MAX_SESSION_MS   = envMs('TRINKET_MAX_SESSION_MS', 15 * 60 * 1000);
if (MAX_SESSION_MS <= MAX_RUN_MS) {
  console.log('reap: TRINKET_MAX_SESSION_MS must exceed the run limit, using ' + 2 * MAX_RUN_MS + 'ms');
  MAX_SESSION_MS = 2 * MAX_RUN_MS;
}
const SESSIONS_DIR   = '/tmp/sessions';

// In the image, node runs as root and student code as `uid`, so that uid means
// student code and nothing else. The stray sweeper relies on that, so it only
// runs as root: run directly as an ordinary user (serverside/README.md,
// "without Docker"), that user is often uid 1000 as well, and the sweeper
// would kill their editor, shell and node.
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// socket.id -> { socket, children:Set<ChildProcess>, lastActivity:number, dir }
const sessions = new Map();

// Children are spawned detached, so each run is its own process group led by
// the python process. Signalling the group (a negative pid) also reaches
// whatever the program started itself -- subprocess, multiprocessing,
// os.fork -- which killing the python process alone leaves running. Returns
// false once the group is gone. True does not prove anything was running: a
// group holding only zombies can still be signalled.
function killGroup(child) {
  if (!child || !child.pid) return false;
  try {
    process.kill(-child.pid, 'SIGKILL');
    return true;
  } catch (e) {
    return false;
  }
}

// SIGKILL, not SIGTERM: student code can catch or ignore SIGTERM, and cannot
// catch SIGKILL.
function killChild(child, why) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { if (child.stdin) child.stdin.destroy(); } catch (e) {}
  try {
    if (killGroup(child) || child.kill('SIGKILL')) {
      console.log('reap: killed pid ' + child.pid + ' and its process group (' + why + ')');
    }
  } catch (e) {
    console.log('reap: kill failed for pid ' + child.pid + ' (' + why + '): ' + e.message);
  }
}

// Delete paths under /tmp/sessions as the student uid, not as root. The
// directory is world-writable and everything in it is student-controlled, so
// a recursive delete as root can be steered, by swapping a directory for a
// symlink mid-delete, into removing files anywhere on the Machine. As `uid`
// it can only remove what student code could remove anyway. Not as root there
// is nothing to escalate to, so delete directly.
//
// RM_SCRIPT takes the paths as "$@". It first makes every real directory
// writable, because rm -rf alone cannot empty a read-only subfolder. That is
// done with find, not chmod -R: chmod -R follows a symlink given as an
// argument and walks wherever it points, while find follows no symlinks, and
// -exec ... \; runs before find descends, so each folder opens before it is
// read. rm -rf removes links themselves without following them.
//
// The inner find's placeholder is written {\} (the shell makes it {}). Keep it
// that way: the dir sweep hands this script to an outer `find -exec ... +`,
// which refuses to run at all if any other argument contains a literal {}.
const RM_SCRIPT = 'find "$@" -type d ! -perm -u+rwx -exec chmod u+rwx {\\} \\; 2>/dev/null; rm -rf -- "$@"';
function removeAsStudent(paths) {
  if (!paths.length) return;
  if (!AS_ROOT) {
    for (const p of paths) {
      try { rmSync(p, { recursive: true, force: true }); } catch (e) {}
    }
    return;
  }
  try {
    const rm = child_process.spawn('/bin/sh', ['-c', RM_SCRIPT, 'sh'].concat(paths),
                                   { uid, gid, stdio: 'ignore' });
    rm.on('error', (e) => console.log('reap: rm failed: ' + e.message));
    rm.on('exit', (code, signal) => {
      if (code || signal) console.log('reap: rm exited ' + (signal || code) + ' for ' + paths.join(' '));
    });
  } catch (e) {
    console.log('reap: rm failed: ' + e.message);
  }
}

function clearRunTimer(child) {
  clearTimeout(childTimers.get(child));
  childTimers.delete(child);
}

// State and session id of a process from /proc/<pid>/stat (fields 3 and 6).
// comm (field 2) can contain spaces and parentheses, so parse from the LAST
// ')'.
function procStat(pid) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const sid = parseInt(rest[3], 10);
    if (!Number.isFinite(sid)) return null;
    return { state: rest[0], sid };
  } catch (e) {
    return null;
  }
}

// node's own session. Processes node starts without `detached` -- the rm and
// find it runs as `uid` -- stay in it; no student process can join it.
const OWN_SID = AS_ROOT ? (procStat('self') || {}).sid : undefined;

// Real uid of a process, from the "Uid:" line of /proc/<pid>/status.
function procUid(pid) {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(readFileSync('/proc/' + pid + '/status', 'utf8'));
    return m ? parseInt(m[1], 10) : null;
  } catch (e) {
    return null;
  }
}

// Layer 3. Every run is spawned detached, which makes it a new session whose
// id is the python process's pid, and everything the program starts inherits
// that id. So a student process whose session is not a tracked run is a stray:
// left by a node that crashed (children outlive node), or one that called
// setsid() to escape its run. This goes by session, not age, so a stray that
// keeps respawning itself to stay young is still caught.
//
// Matches on uid, not command line: student code, and anything it forks or
// shells out to, runs as `uid`, and nothing else in the container does except
// node's own rm/find (OWN_SID). Matching '/tmp/sessions' in the command line
// missed interactive consoles (`python3 -i` has no path) and shell-outs, and
// could hit root processes such as an operator's `tail -f /tmp/sessions/...`.
function sweepStrayProcesses() {
  if (!AS_ROOT || OWN_SID === undefined) return; // no /proc: nothing to do

  const tracked = new Set();
  for (const s of sessions.values()) {
    for (const c of s.children) if (c.pid) tracked.add(c.pid);
  }

  let pids;
  try { pids = readdirSync('/proc'); } catch (e) { return; }

  for (const pid of pids) {
    if (!/^[0-9]+$/.test(pid)) continue;
    if (procUid(pid) !== uid) continue;
    const st = procStat(pid);
    // A zombie ('Z') is already dead and holds no memory. Only its parent, or
    // init once reparented, can reap it, and signalling it does nothing.
    if (!st || st.state === 'Z' || tracked.has(st.sid) || st.sid === OWN_SID) continue;
    try {
      process.kill(parseInt(pid, 10), 'SIGKILL');
      console.log('reap: killed stray pid ' + pid + ' (session ' + st.sid + ')');
    } catch (e) {
      if (e.code !== 'ESRCH') console.log('reap: stray kill failed pid ' + pid + ': ' + e.message);
    }
  }
}

// Session directories outlive their process whenever cleanup is skipped.
// Anything not owned by a live session and unchanged for MAX_SESSION_MS is
// garbage. The whole sweep is one `find` run as `uid` (see removeAsStudent),
// not a loop in node: a student can fill the world-writable /tmp/sessions with
// millions of entries, and reading those here would stall every session on
// the Machine. find also handles names that are not valid UTF-8, which node
// cannot pass back to rm, and never follows symlinks. As root it skips entries
// root owns, which it could not remove as `uid` anyway.
//
// find runs as `uid`, so student code can signal it, including stopping it.
// A sweep still running after DIR_SWEEP_DEADLINE_MS is killed, so one stuck
// find cannot switch folder sweeping off for the life of this node.
// -ignore_readdir_race: a session's own delete can remove an entry while find
// is looking at it, which is not an error.
const DIR_SWEEP_DEADLINE_MS = 3 * SWEEP_EVERY_MS;
let dirSweep = null;
let dirSweepStartedAt = 0;
function sweepSessionDirs() {
  if (dirSweep) {
    if (Date.now() - dirSweepStartedAt < DIR_SWEEP_DEADLINE_MS) return; // still going
    console.log('reap: dir sweep overran, killing it');
    try { dirSweep.kill('SIGKILL'); } catch (e) {}
    dirSweep = null;
  }
  try { lstatSync(SESSIONS_DIR); } catch (e) { return; }

  const args = [SESSIONS_DIR, '-ignore_readdir_race', '-mindepth', '1', '-maxdepth', '1'];
  if (AS_ROOT) args.push('-uid', String(uid));
  args.push('!', '-newermt', '@' + Math.floor((Date.now() - MAX_SESSION_MS) / 1000));
  for (const s of sessions.values()) {
    if (s.dir) args.push('!', '-name', path.basename(s.dir));
  }
  args.push('-print', '-exec', '/bin/sh', '-c', RM_SCRIPT, 'sh', '{}', '+');

  let removed = 0;
  let failed = false;
  let sweep;
  try {
    sweep = child_process.spawn('find', args,
      AS_ROOT ? { uid, gid, stdio: ['ignore', 'pipe', 'ignore'] } : { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    console.log('reap: dir sweep failed: ' + e.message);
    return;
  }
  dirSweep = sweep;
  dirSweepStartedAt = Date.now();
  // Each handler clears dirSweep only if it still refers to this sweep: an
  // overrun sweep that was killed and replaced must not clear its successor.
  const done = () => { if (dirSweep === sweep) dirSweep = null; };
  sweep.stdout.on('data', (chunk) => {
    for (const b of chunk) if (b === 10) removed++; // one path per line
  });
  sweep.on('error', (e) => {
    // A failed spawn also emits 'close'; report it once, here.
    failed = true;
    console.log('reap: dir sweep failed: ' + e.message);
    done();
  });
  sweep.on('close', (code, signal) => {
    const entries = removed + ' stale session entr' + (removed === 1 ? 'y' : 'ies');
    if (failed) {
      // already reported
    } else if (code || signal) {
      console.log('reap: dir sweep exited ' + (signal || code) + ' (' + entries + ' found)');
    } else if (removed) {
      console.log('reap: removed ' + entries);
    }
    done();
  });
}

// Layer 2. A connection with no process behind it still counts against the
// Machine's fly-proxy connection limit and stops it ever auto-stopping.
function sweepIdleSockets() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.children.size > 0) continue;
    const idleFor = now - s.lastActivity;
    if (idleFor < IDLE_SOCKET_MS) continue;
    console.log('reap: closing idle socket ' + id + ' after ' + Math.round(idleFor / 1000) + 's');
    try { s.socket.disconnect(true); } catch (e) {}
  }
}

const sweepTimer = setInterval(() => {
  try { sweepIdleSockets(); }     catch (e) { console.log('reap: idle sweep error: ' + e.message); }
  try { sweepStrayProcesses(); }  catch (e) { console.log('reap: stray sweep error: ' + e.message); }
  try { sweepSessionDirs(); }     catch (e) { console.log('reap: dir sweep error: ' + e.message); }
}, SWEEP_EVERY_MS);
// Never hold the event loop open just for the sweeper.
if (sweepTimer.unref) sweepTimer.unref();

// Runs are in their own sessions, so a terminal's Ctrl-C (sent to its
// foreground process group) no longer reaches them when node is run by hand.
// Take them down on the way out. pm2 is unaffected: its treekill follows
// parent pids.
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    for (const s of sessions.values()) {
      for (const c of s.children) killGroup(c);
    }
    process.exit(code);
  });
}

console.log('reap: enabled (run ' + MAX_RUN_MS + 'ms, idle ' + IDLE_SOCKET_MS +
            'ms, exit grace ' + EXIT_GRACE_MS + 'ms, session ' + MAX_SESSION_MS +
            'ms, sweep ' + SWEEP_EVERY_MS + 'ms, stray sweep ' +
            (AS_ROOT ? 'on' : 'OFF, not running as root') + ')');
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  let watcher;
  const watchesInProgress = {}
  const watchInProgressLimit = 2000
  const watchInProgressInterval = 250
  const watcherStabilityThreshold = 500
  let watchInProgressCurrent = 0;

  let child;
  let childReady = false;
  let childEnded = false;
  let childEndedLog = undefined;

  const childReadyLimit = 5000;
  const childReadyInterval = 250;
  let childReadyCurrent = 0;

  let dir;

  // ?
  // let readingUserInput = false;

  connections = connections + 1;

  // Reaping bookkeeping for this connection. `children` is a Set, not a single
  // reference: each 'eval' spawns a new process on the SAME socket, and the old
  // code only ever tracked the most recent one, orphaning any earlier child.
  const session = { socket, children: new Set(), lastActivity: Date.now(), dir: undefined };
  sessions.set(socket.id, session);
  const touch = () => { session.lastActivity = Date.now(); };
  // Both the exit path and the disconnect handler remove the session
  // directory; only the first needs to start a delete.
  let removedDir;
  const removeDir = () => {
    if (!dir || dir === removedDir) return;
    removedDir = dir;
    removeAsStudent([dir]);
  };

  let stdoutEmits = 0;
  const stdoutEmitsThreshold = 100;
  const checkEmitsInterval = setInterval(() => {
    // console.log("checking emits", stdoutEmits);
    if (stdoutEmits > stdoutEmitsThreshold) {
      console.log("too many emits", stdoutEmits, "- disconnect");
      socket.disconnect();
    } else {
      stdoutEmits = 0;
    }
  }, 250);

  // setup child process and event listeners
  socket.on('eval', async (data) => {
    touch();
    const args = [];
    let error = [];
    const options = {};
    const ignoreFiles = [];
    const assetPromises = [];

    let firstPrompt = true;

    if (data.init) {
      const sha = createHash('sha256');
      sha.update(Math.random().toString());
      const sessionId = sha.digest('hex').substr(0, 16);

      dir = `/tmp/sessions/${sessionId}`;
      session.dir = dir;
      await mkdir(dir, { recursive: true });
      chownSync(dir, uid, gid);

      let files;

      if (data.code) {
        try {
          files = JSON.parse(data.code);
          if (!Array.isArray(files)) {
            throw new Error();
          }
        } catch(e) {
          files = [{
            name: 'main.py',
            content: data.code
          }];
        }

        for (const file of files) {
          if (file.name === 'assets') {
            if (Array.isArray(file.content)) {
              for (let i = 0; i < file.content.length; i++) {
                // download asset and write to local file
                await downloadAsset(dir, file.content[i]);
                chownSync(`${dir}/${file.content[i].name}`, uid, gid);
                ignoreFiles.push(`${dir}/${file.content[i].name}`);
              }
            }
          }
          else if (file.name.length) {
            await writeFile(`${dir}/${file.name}`, file.content);
            chownSync(`${dir}/${file.name}`, uid, gid);
          }
        }

        ignoreFiles.push(`${dir}/${files[0].name}`);
      }
      else if (data.files) {
        try {
          files = JSON.parse(data.files);
          if (!_.isObject(files)) {
            files = {};
          }
        } catch(e) {
          files = {};
        }

        const filenames = _.keys(files);
        for (const name of filenames) {
          await writeFile(`${dir}/${name}`, files[name]);
          chownSync(`${dir}/${name}`, uid, gid);
        }

        if (filenames.length) {
          ignoreFiles.push(`${dir}/${filenames[0].name}`);
        }
      }
    }

    // add files from above to ignored
    const ignored = ignoreFiles.concat(/[\/\\]\./);

    watcher = chokidar.watch(dir, {
      ignored: ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish : {
        stabilityThreshold: watcherStabilityThreshold
      }
    });

    watcher.on('add', (added) => {
      var fileinfo = {
        name: path.basename(added),
        buffer: readFileSync(added)
      };
      socket.emit('file added', fileinfo);
      if (watchesInProgress[ fileinfo.name ]) {
        delete watchesInProgress[ fileinfo.name ];
      }
    });
    watcher.on('change', (changed) => {
      var fileinfo = {
        name: path.basename(changed),
        buffer: readFileSync(changed)
      };
      socket.emit('file added', fileinfo);
      if (watchesInProgress[ fileinfo.name ]) {
        delete watchesInProgress[ fileinfo.name ];
      }
    });
    watcher.on('raw', (event, filepath, details) => {
      var watching = filepath || path.basename(details.watchedPath);
      if (watching) {
        watchesInProgress[watching] = true;
        watchInProgressCurrent = 0;
      }
    });

    watcher.on('error', (error) => {
      console.log('watcher error:', error);
    });

    // arguments to python
    if (data.interactive) {
      args.push('-i');
      args.push('-q');
    }

    args.push('-u');
    args.push('-B');

    if (!data.interactive) {
      args.push(`${dir}/main.py`);
    }

    options.cwd = dir;
    options.uid = uid;
    options.gid = gid;
    // Its own process group, so the whole run can be killed at once (killGroup).
    options.detached = true;

    watcher.on('ready', () => {
      // The browser can leave during the async setup above. The disconnect
      // handler has then already cleaned up and started deleting the session
      // directory, so start nothing: a child spawned now would have no socket
      // and only the run limit would stop it.
      if (socket.disconnected) {
        try { watcher.close(); } catch (e) {}
        return;
      }
      // eventually chroot
      // Captured in a const: `child` is reassigned by the next 'eval' on this
      // same socket, so any timer or handler that closed over `child` could
      // act on the WRONG process.
      const spawned = child_process.spawn(python, args, options);
      child = spawned;
      session.children.add(spawned);
      touch();

      const startedAt = Date.now();
      childTimers.set(spawned, setTimeout(() => {
        childTimers.delete(spawned);
        console.log(`reap: run limit reached, pid ${spawned.pid} after ${(Date.now() - startedAt) / 1000}s`);
        // Kill the process FIRST, then close the socket. The old code only
        // called socket.disconnect() and left the killing to the disconnect
        // handler, so the process lived exactly as long as node's view of
        // that socket did.
        killChild(spawned, 'run time limit');
        session.children.delete(spawned);
        // Stderr node has already read (a warning, say) goes before the limit
        // message, not after it from the exit path. Anything still unread in
        // the pipe at the kill can still arrive after it. In a console,
        // `error` holds prompts, which the exit path deals with.
        if (error.length && !data.interactive) {
          const _error = _parseError(error);
          try { socket.emit('script error', { type: _error.type, error: _error.message }); } catch (e) {}
          error = [];
        }
        // Tell the student what happened. Previously the output just stopped.
        // The limit is wall-clock and applies to the console too, so the
        // message must not suggest the console as a way round it. It names no
        // button: the toolbar's label can read "Run" or "Console" in either
        // mode (changeRunOption changes the icon, not the label).
        const secs = Math.round(MAX_RUN_MS / 1000);
        const limit = secs + (secs === 1 ? ' second' : ' seconds');
        const msg = data.interactive
          ? `\nYour console session was stopped after ${limit}.\nStart a new one to carry on.\n`
          : `\nYour program was stopped after ${limit}.\nThe time limit includes time spent waiting for input.\n`;
        try { socket.emit('script error', { error: msg }); } catch (e) {}
        // Close shortly after, not in this tick, so the exit path the kill
        // sets off (any last stderr, then 'exit') reaches the manager first.
        // For a console this timer is what closes the socket. In Run mode the
        // browser disconnects on 'exit' itself, with the grace timer as backstop.
        const closeTimer = setTimeout(() => {
          try { socket.disconnect(true); } catch (e) {}
        }, 1000);
        if (closeTimer.unref) closeTimer.unref();
      }, MAX_RUN_MS));

      // strings rather than buffers
      child.stdout.setEncoding('utf-8');
      child.stdin.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');

      // any time the child process writes to stdout
      child.stdout.on('data', (data) => {
        // clear console escape sequence
        if (/\x1b\[H\x1b\[2J/.test(data)) {
          socket.emit('clear');
        }
        else {
          socket.emit('stdout', data);
          stdoutEmits++;
        }
      });

      // any time the child process writes to stderr
      // these could be real errors or the prompt when in interactive mode

      child.stderr.on('data', (err) => {
        // capture everything
        // but call _parseError before emitting
        error.push(err);

        if (data.interactive) {
          // a prompt, meaning last command finished
          // (or the child process was just spawned)
          // tell the browser so a new prompt can be started
          if (/^(\.\.\. )*>>> /m.test(err)) {
            if (!firstPrompt) {
              // done means the last input from the console finished
              const _error = _parseError(error);
              const _done = {
                type: _error.type,
                error: _error.message
              };
              socket.emit('done', _done);
              error = [];
            }
            firstPrompt = false;
          }
        }
      });

      // catch stdout, stdin, stderr errors
      const pipeErrorHandler = (err) => {
        console.log("pipe error:", err);
        socket.emit('script error', {
          error : "Error: The python3 process ended unexpectedly. Please try running your program again."
        }, () => {
          // force disconnect
          socket.disconnect();
        });
      }

      child.stdout.on('error', pipeErrorHandler);
      child.stdin.on('error', pipeErrorHandler);
      child.stderr.on('error', pipeErrorHandler);

      // process ended
      spawned.on('exit', (code, signal) => {
        session.children.delete(spawned);
        clearRunTimer(spawned);
        // Anything the program started and left running has no purpose once
        // it has finished: the watcher and session directory go next. Not
        // logged, as killGroup cannot tell a live leftover from a zombie.
        killGroup(spawned);
        touch();

        childEnded = true;

        if (error.length) {
          // tell the browser if there was an error with the script
          const _error = _parseError(error);
          const _script = {
            type: _error.type,
            error: _error.message
          };
          socket.emit('script error', _script);
          childEndedLog = error.join('');
        }
        else {
          childEndedLog = `Code: ${code}, Signal: ${signal}`;
        }

        (function exitFunc() {
          if (!_.isEmpty(watchesInProgress) && watchInProgressCurrent <= watchInProgressLimit) {
            setTimeout( exitFunc, watchInProgressInterval );
            watchInProgressCurrent += watchInProgressInterval;
          }
          else {
            socket.emit('exit');
            // Do not let the connection outlive the run. A socket with no
            // process behind it still counts against the Machine's fly-proxy
            // connection limit, and that is precisely what stopped shells ever
            // auto-stopping. The browser opens a fresh connection for every
            // Run, so nothing here needs keeping alive. Interactive sessions are left
            // to the idle reaper, since the student may still be typing.
            if (!data.interactive) {
              const graceTimer = setTimeout(() => {
                try { socket.disconnect(true); } catch (e) {}
              }, EXIT_GRACE_MS);
              if (graceTimer.unref) graceTimer.unref();
            }
            if (watcher) {
              watcher.close();
            }
            removeDir();
          }
        })();
      });

      spawned.on('error', (err) => {
        console.log('child error:', err);
        // A failed spawn (e.g. EAGAIN when student processes have hit the pid
        // limit) has no pid and never emits 'exit', so undo its bookkeeping
        // here. Otherwise the idle reaper sees this socket as busy forever, and
        // the watchdog later reports a run that never started. Errors on a
        // live process, such as a failed kill, are only logged.
        if (spawned.pid !== undefined) return;
        session.children.delete(spawned);
        clearRunTimer(spawned);
        childEnded = true;
        try {
          socket.emit('script error', {
            error : "Error: The python3 process could not be started. Please try running your program again."
          });
        } catch (e) {}
        const closeTimer = setTimeout(() => {
          try { socket.disconnect(true); } catch (e) {}
        }, 1000);
        if (closeTimer.unref) closeTimer.unref();
      });

      childReady = true;

      socket.emit('child ready');

    }); // end watcher.on ready
  });

  // received input from browser
  socket.on('write', (data) => {
    touch();
    let inputLines = data.input.split('\n');
    let lastLine = inputLines.pop();

    // remove any leading spaces from last line
    lastLine = lastLine.replace(/^\s+/g, '');

    // add newline to last line if it doesn't have one
    if (lastLine.length && !/\n$/.test(lastLine)) {
      lastLine += '\n';
    }

    inputLines.push(lastLine);
    let input = inputLines.join('\n');

    // a multiline statement (from console mode) where the next to last line was indented needs an extra newline
    if (inputLines.length > 1 && /^[\s\#]+/.test(inputLines[inputLines.length - 2]) && data.from === 'console') {
      input += '\n';
    }

    // it's possible the child isn't ready yet...
    (function stdinWrite(input) {
      if (childReady && !childEnded) {
        child.stdin.write(input);
      }
      else if (childReadyCurrent <= childReadyLimit) {
        setTimeout(() => {
          stdinWrite(input);
        }, childReadyInterval);
        childReadyCurrent += childReadyInterval;
      }
      else {
        if (childEnded) {
          console.log('child process ended:', childEndedLog);
        }
        else {
          console.log('child process never ready!');
        }

        socket.emit('script error', {
          error : "Error: The python3 process ended unexpectedly. Please try running your program again."
        }, () => {
          // force disconnect
          socket.disconnect();
        });
      }
    })(input);
  });

  // catch any errors
  // probably need a better way to expose these
  // and do something when they occur
  socket.on('error', (err) => {
    console.log('socket error:', err);
  });

  // query how many connections there are
  socket.on('connections', () => {
    // don't count this connection
    socket.emit('current connections', connections - 1);
  });

  socket.on('disconnect', () => {
    connections = connections - 1;
    sessions.delete(socket.id);

    // Every step below is guarded individually, so a failure in one cannot
    // skip the kill, the watcher close or the directory removal.
    for (const c of session.children) {
      clearRunTimer(c);
      killChild(c, 'browser disconnected');
    }
    session.children.clear();

    try {
      if (checkEmitsInterval) clearInterval(checkEmitsInterval);
    } catch (e) {
      console.log('socket disconnect, clearInterval error:', e);
    }

    try {
      if (watcher) watcher.close();
    } catch (e) {
      console.log('socket disconnect, watcher close error:', e);
    }

    try {
      removeDir();
    } catch (e) {
      console.log('socket disconnect, remove dir error:', e);
    }
  });
});

const _parseError = (error) => {
  if (!error.length) {
    return null;
  }

  // in interactive mode, other errors are thrown
  // so we look for the "original exception"

  let errorStr = error.join('');
  const origStr = 'Original exception was:';
  const origRe = new RegExp(origStr);
  let lang = 'python';

  // get everytihng after original text
  if (origRe.test(errorStr)) {
    errorStr = errorStr.substring(errorStr.indexOf(origStr) + origStr.length, errorStr.length);
  }

  // possible leading newline after stripping original message above
  errorStr = errorStr.replace(/^\n+/g, '');

  // prompts are sent to stderr in interactive mode - strip those out
  errorStr = errorStr.replace(/\n*>>> \n*/g, '');
  errorStr = errorStr.replace(/\n*\.\.\. \n*/g, '');

  if (/TrinketException/.test(errorStr) || /_tkinter\.TclError/.test(errorStr)) {
    lang = 'pygame';
  }

  return {
    type: lang,
    message: errorStr
  };
}

const downloadAsset = (dir, asset) => {
  let file = fs.createWriteStream(`${dir}/${asset.name}`);

  return new Promise((resolve, reject) => {
    const request = https.get(asset.url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
      }
      else {
        reject();
      }
    });

    file.on('finish', () => {
      resolve();
    });

    file.on('error', (err) => {
      reject(err);
    });

    request.on('error', (err) => {
      reject(err);
    });
  });
}

httpServer.listen(8010);

