# Pygame stress test

Opens N concurrent pygame sessions against the exec stack the way real browsers
do — Socket.IO to the pygame manager, `run` a 60 fps game, **and** a VNC viewer
per session — so the single worker is loaded on both axes that cost CPU (the
Python process and the per-display Xvnc encoder). Use it to size the worker VM
after changing `PYGAME_DISPLAYS` (see `fly/README.md` → "Raising the stopgap
limit").

Zero dependencies; needs Node ≥ 22 (global `WebSocket`). `fly` on PATH only if
you want `--metrics`.

## Run

```sh
# 30 students for 2 minutes, sampling the worker's CPU/memory every 15 s
node scripts/pygame-stress/stress.mjs --sessions 30 --duration 120 --metrics \
  --page https://ide.stem.org.uk/embed/pygame/<trinketId>
```

The managers only accept connections carrying the app-minted exec token
(24 h TTL), so give the script one of:

- `--page <any pygame embed URL>` — scraped from the page (public trinkets work);
- `--token v1.<exp>.<sig>` — from a browser: `trinket.config.execToken` on any trinket page;
- env `EXEC_TOKEN`.

Options: `--ramp MS` (gap between session starts, default 300), `--no-vnc`
(python load only — understates CPU by roughly half), `--no-warmup` (skip the
single session that wakes the scale-to-zero manager + worker first),
`--exec URL` (default `https://exec.ide.stem.org.uk`). `--duration` counts from
the end of the ramp and is capped so that no session runs into the manager's
10-minute per-session limit — that clock starts when the manager *accepts* a
connection, which for the warm-up session is before the worker's cold start —
so the effective maximum is ~590 s on a warm tier and less after a cold start
(the script says so when it shortens a run).

## Read the result

- **Displays granted vs busy** — `busy` > 0 with sessions ≤ `PYGAME_DISPLAYS`
  means the two display counts (worker `[env]`, manager `NODE_CONFIG`) don't
  match, a fly.toml `hard_limit` is below the display count, or someone else
  is holding a display (`fly logs -a stem-trinket-pygame-manager` shows
  `Assigned display`).
- **Time to `instance ready` / `child ready`** — warm p95 should be a few
  seconds; the cold-start line is the first session waking the tier (~1 min).
- **VNC GB per session-hour** — measured egress; the summary converts it to
  $/class-hour at $0.02/GB so the cost model in `fly/README.md` can be checked.
- **Worker samples** (`--metrics`) — CPU utilisation from `/proc/stat` deltas
  between samples, memory, and the number of student `main.py` processes,
  with a verdict: > 85 % CPU is CPU-bound, < 45 % with memory under half means
  `performance-8x/32gb` (−34 %) is worth trying. The 1-min load average is
  printed alongside but isn't used for the verdict: it's an exponential
  average that only reaches ~86 % of the true value after 120 s, so on a
  2-minute run it would understate a saturated worker.

It runs against production by default — it *is* a class-worth of real load.
Run it outside lesson hours, and expect the worker to auto-stop a few minutes
after the test ends (check with `fly status -a stem-trinket-pygame-worker`).
