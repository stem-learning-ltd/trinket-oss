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
| *(app secrets)* | One `NODE_CONFIG` JSON secret composed by `make secrets-app` — the app's config@0.4.x has no custom-environment-variables support |
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

The 159MB `public-components.tgz` frontend bundle the app image needs is
mirrored as a release on our fork (`frontend-components-v1.1.0`) and
SHA256-pinned in `docker/app.Dockerfile`, so builds don't depend on upstream
keeping (or not replacing) their release asset.

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
export SESSION_SECRET="$(openssl rand -hex 32)"   # save in the team password manager FIRST
make -C fly secrets-app
```

The app pins **config@0.4.x**, which predates `custom-environment-variables`
support — individual env vars never reach the config tree (found the hard way:
the app boots with `localhost` defaults). What 0.4.x does support is a single
`$NODE_CONFIG` env var of JSON merged over the yaml files, so `secrets-app`
composes ALL app secrets (Mongo URI, session secret, Redis, Tigris) into one
`NODE_CONFIG` Fly secret using `jq`. The Tigris `AWS_*` exports are optional
on first run — re-run `make secrets-app` with them exported when enabling
uploads (it recomposes the whole secret, so keep all the exports in place).

These exports are **one-time**: the target pushes the composed value into
Fly's secret store, and every deploy reads it from there — `make deploy` never
needs them again. Don't persist them in a `.env`/mise file (plaintext secrets
on disk, and a second source of truth that drifts from Fly). Note Fly secrets
are write-only (`fly secrets list` shows digests only): Atlas/Redis/Tigris
creds can be re-read or rotated from their consoles, but `SESSION_SECRET`
exists nowhere else — losing it means regenerating it, which logs every user
out. For a repeatable ceremony later, inject from a secret manager at
invocation time (e.g. `op run -- make -C fly secrets-app`), never from a file.

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
replica-set options, so it cannot reach Atlas. `db.mongo.uri` arrives via the
`NODE_CONFIG` secret (`make secrets-app`); teach `connect()` to prefer it:

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
endpoint (`aws.endpoint`, delivered via the `NODE_CONFIG` secret):

```js
var awsConfig = {
  accessKeyId       : config.aws.keyId
  , secretAccessKey : config.aws.key
  , region          : config.aws.region
};

// Tigris (S3-compatible) — custom endpoint, virtual-host style.
// NB the app pins config@0.4.x, which has no .has() — property access only.
if (config.aws && config.aws.endpoint) {
  awsConfig.endpoint = config.aws.endpoint;
}

AWS.config.update(awsConfig);
```

Then flip `features.assets: true` in `fly/config/app/production.yaml` and
redeploy the app. Upload paths to verify: `POST /file`, `POST /file/avatar`
(`lib/controllers/files.js`, `lib/util/file.js`). Note the thumbnail Lambda
(`aws.lambda.createThumbnail`) doesn't exist on Fly — the config points
thumbnails at the original asset host as a graceful fallback.

### F3 — ✅ APPLIED on fly-production: Python3 generated files to Tigris

Why: on the eval VM the manager wrote to a directory nginx served from a
shared volume; Fly Volumes are per-Machine, so generated-image URLs 404'd.

What's in place: `serverside/python/manager/storage.js` uploads to the bucket
when `manager.s3.bucket` is configured (set in `fly.python3-manager.toml`'s
NODE_CONFIG, with `prefix: python3` matching `generatedUrl`'s path); the
local-write path remains for docker-compose dev. Credentials come from the
standard `AWS_*` env vars as Fly secrets on the **manager only** — a key
scoped to the generated bucket, per the security posture.

To activate (one-time ops):

```sh
fly storage dashboard stem-trinket-generated   # -> Access Keys -> create key,
                                               #    Editor on THIS bucket only
export GEN_AWS_ACCESS_KEY_ID='tid_...'
export GEN_AWS_SECRET_ACCESS_KEY='tsec_...'
make -C fly secrets-python3-manager
make -C fly deploy-python3-manager
```

Then in the Tigris dashboard set an object lifecycle/expiry rule (~1 day) on
the bucket — the manager's local cleanup job is disabled on Fly since nothing
is written locally. Verify with a matplotlib trinket: the plot should render,
and its image URL should be
`https://stem-trinket-generated.t3.tigrisfiles.io/python3/<dir>/<file>`.

Tigris has TWO hostnames and they are NOT interchangeable — the single most
time-consuming gotcha here:
- **S3 API endpoint** `https://fly.storage.tigris.dev` — for the SDK
  (`AWS_ENDPOINT_URL_S3`, PutObject/GetObject). Authenticated only.
- **Public file-serving** `https://<bucket>.t3.tigrisfiles.io/<key>` — the
  anonymous browser-facing URL. This is what `generatedUrl`/`genUrl` and the
  uploads `host` values must use. The Tigris dashboard shows the correct
  serving URL under an object's details; copy it from there.

An anonymous GET to the *API* host returns AccessDenied even for a public
object — which looks exactly like a permissions problem and sent us chasing
bucket ACLs for hours. The bucket was public all along; the URL host was
wrong. Always confirm the serving host against the dashboard's object URL.

### F4 — ✅ APPLIED on fly-production: Pygame generated files to Tigris

Same treatment as F3, ported to the pygame manager: `serverside/pygame/manager/`
gets the same `storage.js`, uploads via `manager.s3` (set in
`fly.pygame-manager.toml`, `prefix: pygame`), and the same ordered-`pending`
guard so a program that saves a file just before exiting delivers it before
the browser disconnects. (Live gameplay streams over VNC and needs none of
this — F4 only matters for pygame code that writes image/HTML files.)

NB the pygame manager Dockerfile copies files individually, so `storage.js`
had to be added to it explicitly (unlike the python3 manager's `COPY . .`).

To activate — reuse the SAME bucket-scoped key as F3 (both managers write to
`stem-trinket-generated`, different prefixes):

```sh
export GEN_AWS_ACCESS_KEY_ID='tid_...'          # same key as secrets-python3-manager
export GEN_AWS_SECRET_ACCESS_KEY='tsec_...'
make -C fly secrets-pygame-manager
make -C fly deploy-pygame-manager
```

Verify with a pygame trinket that saves an image (e.g.
`pygame.image.save(screen, "out.png")`): the file resolves at
`https://stem-trinket-generated.t3.tigrisfiles.io/pygame/<dir>/out.png`.

### F5 — Nice-to-have: real health endpoints

The app has no `/health` route, so `fly.app.toml` checks `GET /`; the managers
get TCP checks. A tiny `/health` on the app (and managers) would make checks
cheaper and unambiguous.

## Releasing updates (day-2 operations)

Deploys build from **your local working tree**, not from GitHub — so always
release from a clean, pushed `fly-production` checkout (`git status` clean),
otherwise the running image can't be traced back to a commit.

### What changed → what to run

| Change | Command |
|---|---|
| App source (`app.js`, `lib/`, `config/`, `public/`) | `make -C fly deploy-app` |
| App config overlay (`fly/config/app/*.yaml`) | `make -C fly deploy-app` (baked into the image) |
| Exec nginx (`fly/config/exec/nginx.conf`) | `make -C fly deploy-exec` |
| Manager wiring (`NODE_CONFIG` in a `fly.*.toml`) | `make -C fly deploy-<that app>` — env changes still roll Machines |
| Execution runtime (`serverside/python/*`, `serverside/pygame/*`) | `make -C fly deploy-<matching app>` |
| Secrets | `fly secrets set -a stem-trinket-app K=V` — restarts the app itself; rotating `SESSION_SECRET` logs every user out |
| Capacity | `fly scale count N -a stem-trinket-python3-shell` (never scale the pygame worker) |

A full redeploy of everything is `make -C fly deploy` — safe to run any time;
apps whose inputs didn't change produce identical images.

### Release checklist

1. Merge/commit to `fly-production`, push.
2. Pre-flight (all local, no Fly resources touched):
   `make -C fly validate` · `node --check config/db.js config/aws.js` ·
   `docker run --rm -v $PWD/fly/config/exec/nginx.conf:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t`
3. Deploy the affected app(s) per the table.
4. Smoke-test (section above). `fly logs -a <app>` while a class-sized test runs.

### Admin users

GETTING_STARTED's docker command translates to `fly ssh console` (the machine
env already carries NODE_CONFIG, so the script reaches Atlas):

```sh
fly ssh console -a stem-trinket-app -C \
  "sh -c 'cd /usr/local/node/trinket && node scripts/make-admin.js <email-or-username>'"
```

The account must exist first. Either machine works — the role is written to
the database.

### Rolling back

Fly keeps prior images. Find the last good one and redeploy it by reference:

```sh
fly releases --image -a stem-trinket-app        # note the previous image ref
fly deploy -c fly/fly.app.toml --image registry.fly.io/stem-trinket-app:<ref>
```

Then revert the offending commit on `fly-production` so the next source deploy
doesn't reintroduce it.

### Pulling in upstream changes

```sh
git remote add upstream https://github.com/trinketapp/trinket-oss  # once
git fetch upstream && git merge upstream/master   # on fly-production
```

Review the merge for three things before deploying: (1) changes under
`config/` defaults or `serverside/*/config/` that our `production.yaml` /
`NODE_CONFIG` overrides assume; (2) changes to the stock root `Dockerfile` —
`fly/docker/app.Dockerfile` duplicates it and must be updated to match by
hand; (3) a new upstream `public-components.tgz` release (next section).

### The frontend components bundle

`public-components.tgz` (Ace editor, Trinket's Skulpt fork, etc.) has **no
build script** — upstream assembles it out-of-band and publishes it as a
release asset. We build the app from our own mirror
(`frontend-components-v1.1.0` on the fork), SHA256-pinned in
`fly/docker/app.Dockerfile`. To ship a new bundle (upstream published one, or
we need to patch a frontend lib):

```sh
# 1. Start from the current bundle
curl -LO https://github.com/stem-learning-ltd/trinket-oss/releases/download/frontend-components-v1.1.0/public-components.tgz
tar xzf public-components.tgz            # or fetch upstream's new tarball instead

# 2. (If patching) edit public/components/..., then re-pack
tar czf public-components.tgz public/

# 3. Publish as a NEW fork release (never replace an existing asset in place —
#    the old hash must stay valid for rollbacks)
sha256sum public-components.tgz
gh release create frontend-components-v<X.Y.Z> public-components.tgz \
  --repo stem-learning-ltd/trinket-oss --target main \
  --title "Frontend components bundle v<X.Y.Z>" \
  --notes "sha256: <hash>; <what changed>"

# 4. Update URL and sha256 TOGETHER in fly/docker/app.Dockerfile, commit, then
make -C fly deploy-app
```

## Cloudflare proxy (app hostname only)

`trinket.stem.org.uk` is proxied through Cloudflare for WAF/bot protection.
`exec.trinket.stem.org.uk` must stay **DNS-only forever** — it carries
long-lived Socket.IO/noVNC WebSocket streams that don't tolerate a second
proxy layer's idle timeouts.

Required with the proxy on (all records DNS-only/grey):

```
CNAME  _acme-challenge.trinket.stem.org.uk → trinket.stem.org.uk.12okern.flydns.net.
TXT    _fly-ownership.trinket.stem.org.uk  → app-12okern
```

Without the `_acme-challenge` CNAME, Fly cannot renew the cert it presents to
Cloudflare (the hostname no longer resolves to Fly) and the origin leg breaks
~3 months later. Get current values: `fly certs setup trinket.stem.org.uk -a stem-trinket-app`.

Settings: SSL/TLS mode **Full (strict)** for this hostname (Fly always has a
valid cert). Managed challenges CANNOT be solved inside third-party iframes —
and embedded trinkets are the core use case — so test an embed from another
origin and add a WAF skip rule for embed/static paths if it challenges.
curl-based uptime probes on the custom domain will get challenge 403s; probe
`stem-trinket-app.fly.dev` instead or add a skip rule.

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

### Socket.IO over flycast needs websocket transport (no polling)

A flycast address load-balances across Machines with **no session affinity**.
Socket.IO long-polling makes several separate HTTP requests per session; behind
flycast they land on different Machines and the session breaks (`xhr post
error` → the browser sees "Server connection lost"). The manager→shell client
is therefore pinned to `transports: ['websocket']` (a single persistent
connection — no affinity needed). Consequence for scaling: the
**python3-manager must stay at 1 Machine** (`min_machines_running = 1`, not
scaled up). If it were ever scaled >1, the *browser→manager* Socket.IO leg
would hit the same polling problem, since the frontend's client isn't under our
control to force websocket. Scale the shell pool freely — that leg is now
websocket-only.
