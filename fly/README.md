# Trinket OSS on Fly.io — deployment runbook

Small-scale production deployment of self-hosted Trinket OSS for Teach Computing.
All apps pinned to **`lhr` (London)** for UK data residency. Python 3 and pygame
execution only (java/R disabled).

**Nothing in this directory contains secrets.** Secrets exist only in Fly
(`fly secrets set`) and in MongoDB Atlas.

## Topology

```
                      students / teachers
                            │
            ┌───────────────┴──────────────────┐
            │ https                            │ https (cross-origin: CORS on managers)
            ▼                                  ▼
    trinket.stem.org.uk              exec.trinket.stem.org.uk
 ┌───────────────────────┐        ┌────────────────────────────┐
 │ stem-trinket-app      │        │ stem-trinket-exec (nginx)  │      PUBLIC APPS
 │ Node/Hapi :3000       │        │ :80  /health               │
 │ 2× shared-1x-1GB      │        │ 1× shared-1x-256MB         │
 └──────────┬────────────┘        └────┬─────────┬─────────┬───┘
            │                          │         │         │     ── Fly private network ──
            │                 /python3/│   /pygame/   /pygame-vnc/
            │                          ▼         ▼         │
            │    stem-trinket-python3-manager  stem-trinket-pygame-manager
            │    .flycast:8100 (min 1)         .flycast:8100 (0/1)          PRIVATE,
            │               │                            │   │              no public IPs
            │               ▼                            ▼  ▼
            │    stem-trinket-python3-shell    stem-trinket-pygame-worker
            │    .flycast:8010, 0–3 auto       .flycast:8010 + :6080        PRIVATE,
            │                                  exactly 1, scale-to-0        CREDENTIAL-FREE
            ▼                                                     (untrusted code runs here)
  MongoDB Atlas (AWS eu-west-2) · Fly Redis (sessions) · Tigris (uploads + generated files)
```

Six apps rather than the four in the original sketch: Fly **process groups share
one image**, and each manager/shell pair uses a different base image
(node:18-alpine vs python:3.10; node:18-slim vs ubuntu:22.04), so manager and
shell can't cohabit an app. Splitting also makes the security posture
structural: the two apps that run untrusted code are separate Fly apps that
simply have no secrets.

All manager→shell and exec→manager links use **`.flycast`** (Fly's private
proxy-routed addresses), not `.internal` DNS — deliberately. The shell pool and
pygame worker auto-stop when idle, and only a fly-proxy-mediated connection can
*wake* a stopped Machine; `.internal` DNS for a stopped Machine just fails.
Flycast also load-balances the shell pool as it scales. This is the one
deviation from the brief's `.internal` example for `workerUrl`, and it's what
makes scale-to-zero actually work.

## Files

| File | Purpose |
|---|---|
| `fly.app.toml` | Main app (public) |
| `fly.exec.toml` | Execution ingress nginx (public) |
| `fly.python3-manager.toml` | Python3 Socket.IO manager (private, flycast :8100) |
| `fly.python3-shell.toml` | Python3 shell pool (private, flycast :8010, scales) |
| `fly.pygame-manager.toml` | Pygame manager (private, flycast :8100) |
| `fly.pygame-worker.toml` | Pygame worker (private, flycast :8010/:6080, exactly 1) |
| `docker/app.Dockerfile` | Stock app build + Fly config overlay |
| `docker/exec.Dockerfile` | nginx:alpine + Fly-patched nginx.conf |
| `config/exec/nginx.conf` | Fly resolver (`fdaa::3`), `.flycast` upstreams, WS upgrade locations |
| `config/app/production.yaml` | Non-secret app config (hostnames, features, buckets, exec URLs) |
| `config/app/custom-environment-variables.yaml` | Maps Fly secrets → app config keys |
| `Makefile` | validate / create / secrets / deploy / scale / certs targets |

The four execution apps reuse the **stock repo Dockerfiles** unchanged
(`serverside/python/{manager,shell}`, `serverside/pygame/{manager,worker}`);
their Fly-specific wiring (`shells`, `workerUrl`, `corsOrigins`,
`generatedUrl`/`genUrl`) is injected via the `NODE_CONFIG` env var in each
fly.toml. That matters because the stock `custom-environment-variables.json`
only maps `GENERATED_URL` and `CORS_ORIGINS` — a plain `SHELLS` env var would
be **silently ignored** (as discovered on the eval VM). `NODE_CONFIG` is
node-config's documented whole-tree override and needs no image patching.

## Source management

This directory lives in **our fork** of `trinketapp/trinket-oss` (we are not
upstream maintainers), on a deployment branch (e.g. `fly-production`), because
the deployment is not config-only: follow-ups F1–F4 below are source patches
this config depends on, and they must version together with it. Pull upstream
fixes with an ordinary merge of `trinketapp/trinket-oss` `master` into the
deployment branch. The source tree must be present at every deploy — the
images build from it as Docker context.

## Prerequisites

- `flyctl` installed and logged in: `fly auth login`
- Membership of the STEM Learning Fly org — the Makefile defaults to
  `ORG=stem-learning` so resources land there, not in anyone's personal org.
  Verify placement after creation: `fly apps list --org stem-learning`
- DNS control over `stem.org.uk` (two CNAMEs needed)
- App names are **globally unique** on Fly. If `make apps-create` reports a name
  taken, rename it consistently: `fly/Makefile`, the matching `fly.*.toml`, and
  (for internal apps) every `.flycast` reference in `config/exec/nginx.conf`
  and the `NODE_CONFIG` blocks of the two manager tomls.

## Runbook — first-time setup, in order

All `make` commands: `make -C fly <target>` (the org defaults to `stem-learning`).

### 0. Validate configs (read-only)

```sh
fly auth login
make -C fly validate
```

### 1. Create the apps

```sh
make -C fly apps-create
```

### 2. Allocate flycast addresses — BEFORE any deploy

```sh
make -C fly flycast
```

With a private IPv6 already present, flyctl won't auto-allocate public IPs for
the internal apps' services on first deploy. Verify after deploying:
`fly ips list -a stem-trinket-python3-shell` must show **only** a private address
(likewise for the other three internal apps). If a public IP ever appears:
`fly ips release <ip> -a <app>`.

### 3. MongoDB Atlas (your side; documented here)

- Cluster in **AWS `eu-west-2` (London)** — satisfies UK residency.
- Create a database user for the app; grab the **`mongodb+srv://` connection
  string** with that user, database `trinket`.
- **IP allow-list reality check:** Fly Machines have no stable egress IPs and
  Fly has no NAT gateway, so Atlas private endpoints/peering aren't available
  and a narrow allow-list isn't possible. Set the Atlas allow-list to
  `0.0.0.0/0` and lean on what actually protects the cluster: TLS + SCRAM auth
  with a strong password, and a least-privilege DB user (readWrite on
  `trinket` only). This is the standard Fly↔Atlas posture.
- Driver compatibility: the app uses mongoose ^6, which is fine with Atlas
  (real MongoDB) — but the stock `config/db.js` builds a bare
  `mongodb://host:port/db` string that can't express SRV/TLS options, so
  **follow-up F1 below is required before the app can connect**. Apply it now.

```sh
export MONGODB_URI='mongodb+srv://stem-trinket-app:<password>@<cluster>.mongodb.net/trinket?retryWrites=true&w=majority'
```

### 4. Fly managed Redis (sessions)

```sh
make -C fly redis
```

From the printed `redis://default:<password>@fly-stem-trinket-redis.upstash.io:6379`:

```sh
export REDIS_HOST='fly-stem-trinket-redis.upstash.io'
export REDIS_PASSWORD='<password>'
```

(The private endpoint is plaintext :6379 over Fly's private network; port is
already set in `config/app/production.yaml`.)

### 5. Tigris object storage

```sh
make -C fly storage
```

Creates `stem-trinket-uploads` (private — user uploads) and
`stem-trinket-generated` (**public** — execution-generated files; its public
URL is already baked into the managers' `GENERATED_URL`/`genUrl` values in the
tomls). From the output:

```sh
export AWS_ACCESS_KEY_ID='tid_...'
export AWS_SECRET_ACCESS_KEY='tsec_...'
export AWS_ENDPOINT_URL_S3='https://fly.storage.tigris.dev'
```

If a bucket name is taken, rename in `Makefile`, `config/app/production.yaml`
(uploads) and the two manager tomls' `NODE_CONFIG` (generated).

### 6. Set secrets — main app ONLY

```sh
export SESSION_SECRET="$(openssl rand -hex 32)"   # persist this somewhere safe
make -C fly secrets-app
make -C fly secrets-tigris
```

**Never set secrets on `trinket-python3-*` or `trinket-pygame-*`.** The
shell/worker apps run untrusted student code; keeping them credential-free
means there is nothing to exfiltrate. There is deliberately no make target
that touches their secrets.

### 7. Deploy

```sh
make -C fly deploy
```

Order (execution tiers first, public apps last) and `--ha=false` (flyctl
otherwise creates 2 Machines per new app; the pygame worker must be exactly 1)
are handled by the Makefile. First deploys build remotely from the repo's own
Dockerfiles; the app and exec images build from the repo root context.

### 8. Seed Machine counts

```sh
make -C fly scale     # app -> 2, python3 shells -> 3; everything else stays 1
```

Note Fly's autostart never *creates* Machines — `scale count 3` on the shell
app creates the pool; auto stop/start then runs 0–3 of them on demand.

### 9. TLS certs + DNS

```sh
make -C fly certs
```

Then create the DNS records `fly certs add` prints (CNAMEs are fine for both
names since neither is a zone apex):

```
trinket.stem.org.uk       CNAME  stem-trinket-app.fly.dev
exec.trinket.stem.org.uk  CNAME  stem-trinket-exec.fly.dev
```

Fly auto-provisions and renews Let's Encrypt certs — the eval VM's Certbot
retires with the VM. Check with `fly certs show trinket.stem.org.uk -a stem-trinket-app`.

### 10. Smoke tests

```sh
# exec ingress up
curl -s https://exec.trinket.stem.org.uk/health          # -> OK

# cross-origin Socket.IO handshake emits CORS headers (req 3 in the brief)
curl -si -H 'Origin: https://trinket.stem.org.uk' \
  'https://exec.trinket.stem.org.uk/python3/socket.io/?EIO=4&transport=polling' \
  | grep -i access-control-allow-origin
# -> access-control-allow-origin: https://trinket.stem.org.uk

# same for pygame (wakes the manager if stopped; first hit may take seconds)
curl -si -H 'Origin: https://trinket.stem.org.uk' \
  'https://exec.trinket.stem.org.uk/pygame/socket.io/?EIO=4&transport=polling' \
  | grep -i access-control-allow-origin

# app up
curl -sI https://trinket.stem.org.uk/ | head -1           # -> HTTP/2 200
```

Then run a real Python trinket in the browser (console output should work
immediately; **plot images need follow-up F3**), and a pygame trinket (expect
a cold-start pause while worker Machines wake).

## Application-side follow-ups (config alone cannot do these)

### F1 — ✅ APPLIED on fly-production: Atlas connection string in `config/db.js`

Stock code builds `mongodb://` from host/port/database parts — no TLS, SRV or
replica-set options, so it cannot reach Atlas. The overlay already maps the
`MONGODB_URI` secret to `db.mongo.uri`; teach `connect()` to prefer it:

```js
function connect() {
  // Atlas/Fly: a full connection string (mongodb+srv://, TLS, replicaSet)
  // can't be expressed through the piecewise host/port/database config.
  if (dbconfig.mongo.uri) {
    mongoose.connect(dbconfig.mongo.uri);
    return;
  }
  var connectStr = 'mongodb://'
  // ... rest unchanged
```

### F2 — endpoint patch ✅ APPLIED on fly-production; still to do: enable assets

`aws-sdk` v2 defaults to real AWS S3 endpoints; Tigris needs the custom
endpoint (already mapped from the `AWS_ENDPOINT_URL_S3` secret to `aws.endpoint`):

```js
var awsConfig = {
  accessKeyId       : config.aws.keyId
  , secretAccessKey : config.aws.key
  , region          : config.aws.region
};

// Tigris (S3-compatible) — custom endpoint, virtual-host style
if (config.has('aws.endpoint') && config.aws.endpoint) {
  awsConfig.endpoint = config.aws.endpoint;
}

AWS.config.update(awsConfig);
```

Then flip `features.assets: true` in `fly/config/app/production.yaml` and
redeploy the app. Upload paths to verify: `POST /file`, `POST /file/avatar`
(`lib/controllers/files.js`, `lib/util/file.js`). Note the thumbnail Lambda
(`aws.lambda.createThumbnail`) doesn't exist on Fly — the config points
thumbnails at the original asset host as a graceful fallback.

### F3 — Python3 generated files (matplotlib images, HTML) to Tigris

On the eval VM the manager wrote to a directory nginx served from a **shared
volume**. Fly Volumes are per-Machine and unshared, and the manager doesn't
serve these files itself, so today generated-image URLs would 404 — code
execution and console output work; plots don't render.

Change `serverside/python/manager/manager.js` (~lines 218–249, where it writes
to `configManager.generatedDir` and builds `data.url` from
`configManager.generatedUrl`) to `PutObject` the file to the
`stem-trinket-generated` bucket under `python3/<dir>/<name>` instead of the
local write. `generatedUrl` in `fly.python3-manager.toml` already points at
the bucket's public URL, so `data.url` construction is unchanged. The
manager's local-directory cleanup job becomes redundant for uploaded files —
set a Tigris lifecycle rule (expire after 24h) to match.

### F4 — Pygame generated files, same change

Same pattern in `serverside/pygame/manager/manager.js` (`GEN_DIR` / `GEN_URL`);
`genUrl` in `fly.pygame-manager.toml` already points at
`.../pygame`. (Live gameplay itself streams over VNC and needs nothing here.)

### F5 — Nice-to-have: real health endpoints

The app has no `/health` route, so `fly.app.toml` checks `GET /`; the managers
get TCP checks. A tiny `/health` on the app (and managers) would make checks
cheaper and unambiguous.

## Security posture (untrusted student code)

- **Isolation:** every Machine is a Firecracker microVM — that's the
  host/tenant boundary for untrusted code. No gVisor or similar added, per
  the platform decision.
- **Blast radius:** the shell/worker apps hold **zero secrets** and have **no
  public IPs**; Atlas/Redis/Tigris credentials exist only on `stem-trinket-app`.
  The managers hold only public URLs and CORS origins.
- **Residual risk — outbound abuse:** Fly has no per-Machine egress firewall
  (unlike an AWS security group), so student code *can* make outbound
  connections. Monitor for mining/DoS patterns: sustained CPU on shell
  Machines while idle of sessions (`fly machine list -a stem-trinket-python3-shell`,
  Fly metrics dashboard), unexpected egress volume on the org billing page.
  Concurrency hard-limits and auto-stop bound how much free compute an abuser
  can hold.
- **Public surface:** only `stem-trinket-app` and `stem-trinket-exec` have public IPs
  and certs. Everything else is reachable solely over the org's private
  6PN network.

## Cost & scaling notes

- Idle state: 1× app (1GB), 1× python3 manager (512MB) always on; exec, pygame
  manager, shells and worker sleep at ~zero compute cost. Rough idle spend is
  in the $10–20/mo range; classroom-hours peak (2 app + manager + 3 shells +
  pygame pair) roughly doubles that, pro-rated by the hours they're awake.
- Cold starts: exec nginx wakes in <1s; a shell Machine in a few seconds; the
  pygame worker (supervisord + Xvfb + VNC) up to ~1 min — hence
  `min_machines_running = 1` on the python3 manager but not the pygame tier.
- To grow python3 capacity: `fly scale count N -a stem-trinket-python3-shell` and/or
  raise the per-shell `soft_limit`/`hard_limit` in `fly.python3-shell.toml`.
  Do **not** scale the pygame worker.
