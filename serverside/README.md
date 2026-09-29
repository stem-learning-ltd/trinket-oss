# Server-side Trinket Types

This directory contains the backend services for server-side trinket types (Python 3, Java, R, Pygame). These run actual language interpreters in Docker containers, allowing execution of code that can't run in the browser.

## Architecture

```
                                    ┌─────────────────┐
                                    │  python3-shell  │
                                    │   (Container)   │
                                    │  Python Process │
                                    └────────▲────────┘
                                             │ WebSocket
┌─────────┐      ┌─────────┐      ┌──────────┴────────┐
│ Browser │─────►│  nginx  │─────►│  python3-manager  │
│         │ WS   │  :8080  │      │    (Container)    │
└─────────┘      └────┬────┘      └───────────────────┘
                      │
                      │           ┌─────────────────┐
                      │           │    java-shell   │
                      │           │   (Container)   │
                      │           │   Java Process  │
                      │           └────────▲────────┘
                      │                    │ WebSocket
                      │           ┌────────┴──────────┐
                      └──────────►│   java-manager    │
                      │           │    (Container)    │
                      │           └───────────────────┘
                      │
                      │           ┌─────────────────┐
                      │           │     r-shell     │
                      │           │   (Container)   │
                      │           │    R Process    │
                      │           └────────▲────────┘
                      │                    │ WebSocket
                      │           ┌────────┴──────────┐
                      └──────────►│    r-manager      │
                                  │    (Container)    │
                                  └───────────────────┘
```

**Components:**

- **nginx**: Reverse proxy that routes WebSocket connections and serves generated files (images, HTML)
- **Manager**: Node.js process that accepts browser connections and routes to shells
- **Shell**: Docker container running the language interpreter

> **Note:** Pygame uses a different architecture with VNC for graphical output. See the [Pygame](#pygame) section below.

## Quick Start

```bash
cd serverside

# Start Python 3 only
docker compose --profile python3 up --build

# Start Python 3 and Java
docker compose --profile python3 --profile java up --build

# Start all languages
docker compose --profile python3 --profile java --profile r --profile pygame up --build
```

The services will be available at `http://localhost:8080`.

## How It Works

1. Browser loads a trinket embed page (e.g., `/embed/python3/{trinketId}`)
2. The main app injects the WebSocket URL into the page (`http://localhost:8080/python3`)
3. Frontend JavaScript connects via Socket.io through nginx
4. nginx proxies the WebSocket to the appropriate manager
5. Manager connects to an available shell container
6. Shell spawns the language process, executes code, and streams output back
7. If code generates files (e.g., matplotlib images), the shell sends them to the manager
8. Manager writes files to a shared volume, nginx serves them to the browser

## Configuration

### Main App (`config/default.yaml`)

Enable the trinket types you want to support:

```yaml
features:
  trinkets:
    python3: true   # Enable Python 3
    java: false     # Disable Java
    R: false        # Disable R

app:
  serverside:
    python3:
      api:
        default: 'http://localhost:8080/python3'
    java8:
      api:
        default: 'http://localhost:8080/java'
    r3:
      api:
        default: 'http://localhost:8080/r'
```

### Manager Configuration

Each manager reads from `{language}/manager/config/`. The `node-config` library merges files:

- `default.json` - Base configuration (local development)
- `docker.json` - Docker Compose overrides (Python 3 and pygame; loaded because docker-compose.yml sets `NODE_CONFIG_ENV=docker`)
- `production.json` - Docker overrides for Java and R. Both managers expect one, but upstream deleted them, so under Compose they fall back to `default.json`'s `localhost` shell address and can't reach their shells until they're restored. (The Fly deployment is configured in `fly/`, not here.)
- `custom-environment-variables.json` - Environment variable mappings

**Environment Variables:**

| Variable | Description | Example |
|----------|-------------|---------|
| `GENERATED_URL` | Base URL for generated files | `https://code.example.com/python3-generated` |
| `CORS_ORIGINS` | Allowed CORS origins (JSON array) | `["https://example.com"]` |

### Scaling Shells

To handle more concurrent users, run multiple shell containers and list them in the manager's `shells` array:

```json
{
  "shells": [
    "http://python3-shell-1:8010",
    "http://python3-shell-2:8010",
    "http://python3-shell-3:8010"
  ]
}
```

The manager randomly selects a shell for each connection.

## Production Deployment

### SSL/TLS Setup

For production, you should enable HTTPS. Two options:

#### Option 1: Self-signed certificate (development/testing)

```bash
# Generate self-signed certificate
mkdir -p nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/key.pem \
  -out nginx/ssl/cert.pem \
  -subj "/CN=localhost"
```

#### Option 2: Let's Encrypt (production)

Use certbot or your preferred ACME client to obtain certificates, then mount them:

```bash
# In docker-compose.yml, uncomment:
volumes:
  - /etc/letsencrypt/live/your-domain/fullchain.pem:/etc/nginx/ssl/cert.pem:ro
  - /etc/letsencrypt/live/your-domain/privkey.pem:/etc/nginx/ssl/key.pem:ro
```

Then update nginx to use the SSL config:

```dockerfile
# In nginx/Dockerfile, change:
COPY nginx-ssl.conf /etc/nginx/nginx.conf
```

And in docker-compose.yml:

```yaml
nginx:
  ports:
    - "443:443"
    - "80:80"  # For redirect
```

### Security Hardening

The shell containers run untrusted user code. Apply these security measures:

#### Docker Compose (recommended settings)

Uncomment the security options in `docker-compose.yml`:

```yaml
python3-shell:
  mem_limit: 500m           # Hard memory limit
  mem_reservation: 375m     # Soft limit for scheduling
  cpus: 1.0                 # Limit to 1 CPU core
  cpu_shares: 512           # Relative CPU weight
  pids_limit: 50            # Prevent fork bombs
  read_only: true           # Read-only root filesystem
  tmpfs:
    - /tmp:size=100m        # Writable /tmp with size limit
```

#### Production Docker Run

For production deployments outside compose:

```bash
docker run -d \
  -p 8010:8010 \
  --restart unless-stopped \
  --memory="500m" \
  --memory-reservation="375m" \
  --cpus="1.0" \
  --cpu-shares="512" \
  --pids-limit=50 \
  --read-only \
  --tmpfs /tmp:size=100m \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  trinket/python3-shell:latest
```

#### Network Isolation

Consider running shells in an isolated network with no external access:

```yaml
networks:
  shell-internal:
    internal: true  # No external connectivity

services:
  python3-shell:
    networks:
      - shell-internal
```

### Environment-specific Configuration

For production, override the generated URL to match your domain:

```yaml
# docker-compose.override.yml
services:
  python3-manager:
    environment:
      - GENERATED_URL=https://code.example.com/python3-generated
      - CORS_ORIGINS=["https://example.com","https://www.example.com"]
```

## Directory Structure

```
serverside/
├── docker-compose.yml       # Main compose file
├── nginx/
│   ├── Dockerfile
│   ├── nginx.conf           # HTTP config
│   └── nginx-ssl.conf       # HTTPS config
├── python/
│   ├── manager/
│   │   ├── Dockerfile
│   │   ├── manager.js
│   │   ├── package.json
│   │   └── config/
│   │       ├── default.json
│   │       ├── docker.json
│   │       └── custom-environment-variables.json
│   └── shell/
│       ├── Dockerfile
│       ├── requirements.txt
│       └── trinket/
│           ├── server.js
│           └── package.json
├── java/
│   ├── manager/
│   └── shell/
├── r/
│   ├── manager/
│   └── shell/
└── pygame/
    ├── manager/
    └── worker/          # Uses 'worker' (not 'shell') due to VNC components
```

## Ports (Internal)

These ports are internal to the Docker network. Only nginx port 8080 is exposed externally.

| Service | Internal Port | Purpose |
|---------|--------------|---------|
| nginx | 80 (external: 8080) | Reverse proxy |
| python3-manager | 8100 | WebSocket routing |
| python3-shell | 8010 | Code execution |
| java-manager | 8200 | WebSocket routing |
| java-shell | 8010 | Code execution |
| r-manager | 8300 | WebSocket routing |
| r-shell | 8010 | Code execution |
| pygame-manager | 8400 | WebSocket routing |
| pygame-worker | 8010, 6080 | Code execution + VNC |

## Troubleshooting

### Check service status

```bash
docker compose --profile python3 ps
docker compose --profile python3 logs -f
```

### Test nginx routing

```bash
# Health check
curl http://localhost:8080/health

# Check WebSocket upgrade headers
curl -v -H "Upgrade: websocket" -H "Connection: upgrade" \
  http://localhost:8080/python3/socket.io/
```

### Debug manager connections

```bash
# View manager logs
docker compose --profile python3 logs -f python3-manager

# Check shell connectivity
docker compose --profile python3 exec python3-manager \
  wget -qO- http://python3-shell:8010 || echo "Shell not responding"
```

### Generated files not loading

1. Check the volume is mounted correctly:
   ```bash
   docker compose exec nginx ls -la /var/www/generated/python/
   ```

2. Verify the manager's `generatedUrl` config matches nginx routing

3. Check browser console for CORS errors

## Generated File Cleanup

When users run code that produces files (matplotlib plots, R graphics, etc.), these files are stored in Docker volumes and served via nginx. To prevent disk space exhaustion, each manager automatically cleans up old generated files.

### How It Works

- Cleanup runs on manager startup and then periodically (default: every 60 minutes)
- Files older than `maxAgeHours` (default: 24 hours) are deleted
- Cleanup is based on directory modification time (each generated file gets its own subdirectory)

### Configuration

Each manager's cleanup is configured in its `config/default.json`:

```json
{
  "manager": {
    "cleanup": {
      "enabled": true,
      "maxAgeHours": 24,
      "intervalMinutes": 60
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable automatic cleanup |
| `maxAgeHours` | `24` | Delete files older than this many hours |
| `intervalMinutes` | `60` | How often to run cleanup (in minutes) |

### Monitoring

Cleanup progress is logged to the manager's stdout:

```
[Cleanup] Starting cleanup of files older than 24 hours in /tmp/python-generated
[Cleanup] Complete. Deleted 15 directories, 0 errors.
```

### Manual Cleanup

To manually clear all generated files:

```bash
# Clear all Python generated files
docker compose exec python3-manager rm -rf /tmp/python-generated/*

# Or from the host (if volumes are named)
docker volume rm serverside_python-generated
docker volume rm serverside_java-generated
docker volume rm serverside_r-generated
```

Note: Removing volumes requires restarting the containers.

### Shell timeouts

Python 3 programs and console sessions are stopped after 60 seconds, including time spent waiting for `input()`, along with anything the program started itself. The Python 3 shell's limits are environment variables on the `python3-shell` service. Neither config sets them yet: to change one, add an `environment:` list to the service in `docker-compose.yml`, or an `[env]` section to `fly/fly.python3-shell.toml`. Values are whole milliseconds, at least 1000; anything invalid is ignored and logged at startup.

| Variable | Default | What it limits |
|----------|---------|----------------|
| `TRINKET_MAX_RUN_MS` | 60000 | How long one run or console session can last |
| `TRINKET_IDLE_SOCKET_MS` | 300000 | How long a connection with nothing running stays open. Checked once per sweep, so it can be up to one sweep longer |
| `TRINKET_EXIT_GRACE_MS` | 30000 | How long a Run connection stays open after the program finishes. A console is left to the idle limit instead |
| `TRINKET_MAX_SESSION_MS` | 900000 | How long a leftover session folder goes unchanged before it is removed. Must be more than `TRINKET_MAX_RUN_MS` |
| `TRINKET_SWEEP_EVERY_MS` | 60000 | How often idle connections, leftover folders and stray student processes are checked. Stray processes (ones that belong to no current run) are only removed when the shell runs as root, as it does in its image |

For long-running computations, consider breaking code into smaller chunks.

## Development (without Docker)

For local development, you can run services directly:

**Shell** (requires language runtime):
```bash
cd python/shell/trinket
npm install
node server.js  # Listens on port 8010
```

Run this way as an ordinary user, the Python 3 shell does not remove stray student processes, and its startup log says `stray sweep OFF`. Removing them needs root, and it treats every process owned by uid 1000 as student code. That is only true inside the shell's image, which reserves uid 1000 for students. Don't run the shell with `sudo` outside its image: on most Linux machines uid 1000 is the first real user, and the shell would kill that user's processes.

**Manager**:
```bash
cd python/manager
npm install
node manager.js  # Listens on port 8100, connects to shell
```

Update `config/default.json` shell URLs to match your local setup.

## Pygame

Pygame has a different architecture than other languages because it needs a graphical display for game windows.

### How It Works

```
┌─────────┐      ┌─────────┐      ┌─────────────────┐      ┌─────────────────────┐
│ Browser │─────►│  nginx  │─────►│  pygame-manager │─────►│    pygame-worker    │
│         │      │         │      │                 │      │  ┌───────────────┐  │
│ noVNC   │◄─────│         │◄─────│                 │◄─────│  │    Xvfb       │  │
│ Client  │ WS   │         │ WS   │                 │      │  │  (Virtual X)  │  │
└─────────┘      └─────────┘      └─────────────────┘      │  └───────┬───────┘  │
                                                           │          │          │
                                                           │  ┌───────▼───────┐  │
                                                           │  │    pygame     │  │
                                                           │  │    process    │  │
                                                           │  └───────────────┘  │
                                                           │          │          │
                                                           │  ┌───────▼───────┐  │
                                                           │  │ TightVNC +    │  │
                                                           │  │ noVNC server  │──┼──► VNC stream
                                                           │  └───────────────┘  │
                                                           └─────────────────────┘
```

The worker container runs:
- **Xvfb**: Virtual X11 framebuffer (headless display)
- **TightVNC**: VNC server capturing the display
- **noVNC + websockify**: WebSocket-to-VNC proxy for browser access
- **Supervisor**: Process manager coordinating all services

### Quick Start

```bash
docker compose --profile pygame up --build
```

### Configuration

Enable pygame in the main app:

```yaml
features:
  trinkets:
    pygame: true

app:
  serverside:
    pygame:
      api:
        default: 'http://localhost:8080/pygame'
```

### Resource Requirements

Pygame workers need more resources than text-based languages due to the graphical environment:

```yaml
pygame-worker:
  mem_limit: 1g
  cpus: 2.0
```

### Production Scaling (Not Yet Included)

The current pygame setup runs a single worker container, suitable for development and small deployments.

For production with many concurrent users, Trinket used a dynamic scaling system that:
- Spins up cloud VM instances (AWS EC2 or GCP) on demand
- Uses Redis to coordinate instance state across the scaler and workers
- Workers "phone home" on startup to register with the scaler
- Automatically scales down idle instances to reduce costs

This infrastructure (scaler, stats server, worker images, phone-home scripts) is not yet included in the OSS release. Contributions welcome.
