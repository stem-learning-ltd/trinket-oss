# Fly.io orchestration for self-hosted Trinket OSS.
# Paths resolve relative to this Makefile, so it works from any cwd:
#   make -C fly validate        (or: make -f fly/Makefile validate)
#
# ONLY `make validate` is read-only. Everything else creates/mutates billable
# Fly resources — run in the order documented by `make bootstrap` / fly/README.md.

FLY    ?= fly
# The STEM Learning Fly org — NOT the personal org flyctl would otherwise
# default to. Org placement is decided only at resource creation (apps-create,
# redis, storage); every later command inherits the app's org.
ORG    ?= stem-learning
REGION := lhr

FLY_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
REPO    := $(abspath $(FLY_DIR)/..)

# App names are GLOBAL on Fly. If any `apps create` fails with "taken",
# rename consistently: here, in the matching fly.*.toml, and (for the four
# internal apps) every .flycast reference in fly/config/exec/nginx.conf and
# the NODE_CONFIG blocks of the manager tomls.
APP_MAIN      := stem-trinket-app
APP_EXEC      := stem-trinket-exec
APP_PY3_MGR   := stem-trinket-python3-manager
APP_PY3_SHELL := stem-trinket-python3-shell
APP_PG_MGR    := stem-trinket-pygame-manager
APP_PG_WORKER := stem-trinket-pygame-worker

# Untrusted code runs on the shell/worker apps: they stay private (flycast
# only) and NEVER get secrets — there is no secrets target for them on
# purpose. The MANAGER apps hold exactly one credential: a key scoped to the
# generated-files bucket (secrets-python3-manager), nothing broader.
PRIVATE_APPS := $(APP_PY3_MGR) $(APP_PY3_SHELL) $(APP_PG_MGR) $(APP_PG_WORKER)
ALL_APPS     := $(APP_MAIN) $(APP_EXEC) $(PRIVATE_APPS)

REDIS_NAME      := stem-trinket-redis
TIGRIS_UPLOADS  := stem-trinket-uploads
TIGRIS_GENERATED:= stem-trinket-generated

HOST_MAIN := ide.stem.org.uk
HOST_EXEC := exec.ide.stem.org.uk

CONFIGS := $(FLY_DIR)/fly.app.toml \
           $(FLY_DIR)/fly.exec.toml \
           $(FLY_DIR)/fly.python3-manager.toml \
           $(FLY_DIR)/fly.python3-shell.toml \
           $(FLY_DIR)/fly.pygame-manager.toml \
           $(FLY_DIR)/fly.pygame-worker.toml

.PHONY: help validate apps-create flycast redis storage secrets-app secrets-python3-manager secrets-pygame-manager certs-check \
        deploy deploy-app deploy-exec deploy-python3-manager deploy-python3-shell \
        deploy-pygame-manager deploy-pygame-worker scale certs status bootstrap

help:
	@echo "Read-only:"
	@echo "  validate         fly config validate on all six fly.toml files"
	@echo "  status           fly status across all apps"
	@echo "  certs-check      cert validation progress for both hostnames"
	@echo "Mutating (see fly/README.md for the full ordered runbook):"
	@echo "  bootstrap        prints the first-time setup order"
	@echo "  apps-create      create the six Fly apps"
	@echo "  flycast          allocate private IPv6 on the four internal apps (BEFORE first deploy)"
	@echo "  redis            create Fly managed Redis ($(REDIS_NAME))"
	@echo "  storage          create Tigris buckets ($(TIGRIS_UPLOADS), $(TIGRIS_GENERATED))"
	@echo "  secrets-app      compose the NODE_CONFIG secret on $(APP_MAIN) (from env vars)"
	@echo "  secrets-python3-manager  bucket-scoped Tigris key on the python3 manager"
	@echo "  secrets-pygame-manager   bucket-scoped Tigris key on the pygame manager"
	@echo "  deploy           deploy all six apps in dependency order"
	@echo "  scale            seed Machine counts (app=2, shells=3)"
	@echo "  certs            add TLS certs for $(HOST_MAIN) and $(HOST_EXEC)"

## ---------- read-only ----------

validate:
	@for c in $(CONFIGS); do \
		echo "== $$c"; \
		$(FLY) config validate -c $$c || exit 1; \
	done
	@echo "All fly.toml files valid."

status:
	@for a in $(ALL_APPS); do echo "== $$a"; $(FLY) status -a $$a || true; done

## ---------- one-time resource creation ----------

apps-create:
	@for a in $(ALL_APPS); do $(FLY) apps create $$a --org $(ORG); done

# Run BEFORE the first deploy of the internal apps: with a flycast address
# already present, flyctl won't auto-allocate public IPs for their services.
flycast:
	@for a in $(PRIVATE_APPS); do $(FLY) ips allocate-v6 --private -a $$a; done

redis:
	$(FLY) redis create --name $(REDIS_NAME) --region $(REGION) --org $(ORG) \
		--no-replicas --disable-eviction
	@echo ">> Copy the host and password from the printed redis:// URL into"
	@echo ">> REDIS_HOST / REDIS_PASSWORD, then run: make secrets-app"

storage:
	$(FLY) storage create --name $(TIGRIS_UPLOADS) --org $(ORG)
	$(FLY) storage create --name $(TIGRIS_GENERATED) --org $(ORG) --public
	@echo ">> Copy AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL_S3"
	@echo ">> from the output into your env, then (re)run: make secrets-app"

## ---------- secrets (main app only — execution apps stay credential-free) ----------

# The app pins config@0.4.x, which predates custom-environment-variables
# support — individual env vars never reach the config tree. What 0.4.x DOES
# support is a single $NODE_CONFIG env var of JSON, deep-merged over the yaml
# files. So all app secrets ship as ONE Fly secret, composed here with jq
# (which also handles quoting/escaping of arbitrary passwords).
# Tigris AWS_* vars are optional at first run; re-run this target with them
# exported when enabling uploads.
secrets-app:
	@command -v jq >/dev/null  || { echo "jq is required to compose NODE_CONFIG"; exit 1; }
	@test -n "$$MONGODB_URI"    || { echo "MONGODB_URI not set (Atlas connection string)"; exit 1; }
	@test -n "$$SESSION_SECRET" || { echo "SESSION_SECRET not set (32+ random chars)"; exit 1; }
	@test -n "$$REDIS_HOST"     || { echo "REDIS_HOST not set (fly-$(REDIS_NAME).upstash.io)"; exit 1; }
	@test -n "$$REDIS_PASSWORD" || { echo "REDIS_PASSWORD not set"; exit 1; }
	$(FLY) secrets set -a $(APP_MAIN) NODE_CONFIG="$$(jq -cn \
		--arg uri  "$$MONGODB_URI" \
		--arg sess "$$SESSION_SECRET" \
		--arg rh   "$$REDIS_HOST" \
		--arg rp   "$$REDIS_PASSWORD" \
		--arg ak   "$${AWS_ACCESS_KEY_ID:-}" \
		--arg as   "$${AWS_SECRET_ACCESS_KEY:-}" \
		--arg ae   "$${AWS_ENDPOINT_URL_S3:-}" \
		'{db: {mongo: {uri: $$uri}, redis: {app: {host: $$rh, pass: $$rp}, exports: {host: $$rh, password: $$rp, family: 6}, sandbox: {host: $$rh, pass: $$rp, password: $$rp, family: 6}}}, app: {plugins: {session: {cookieOptions: {password: $$sess}}}}, aws: {keyId: $$ak, key: $$as, endpoint: $$ae}}')"
# ^ default.yaml defines THREE redis configs (app/exports/sandbox) and the Bull
#   exports queue reads db.redis.exports directly — localhost unless overridden
#   (its ECONNREFUSED is fatal). Key spelling differs by consumer: the app
#   client (config/redis.js, lib/util/store.js) reads `pass`, Bull queues
#   (lib/util/queues.js) read `password`. family: 6 because ioredis looks up
#   IPv4-only by default and fly-*.upstash.io is AAAA-only (guaranteed
#   ENOTFOUND otherwise).

# The managers upload generated files (matplotlib images, HTML) to Tigris.
# Give them a key scoped to $(TIGRIS_GENERATED) ONLY: fly storage dashboard
# $(TIGRIS_GENERATED) -> Access Keys -> create with Editor on that bucket. Do
# NOT reuse the org-wide key from `make storage`. GEN_-prefixed env names so
# the two key pairs can't be mixed up. Both managers share one bucket (with
# different prefixes: python3/ and pygame/), so the SAME key works for both.
secrets-python3-manager:
	@test -n "$$GEN_AWS_ACCESS_KEY_ID"     || { echo "GEN_AWS_ACCESS_KEY_ID not set (bucket-scoped Tigris key)"; exit 1; }
	@test -n "$$GEN_AWS_SECRET_ACCESS_KEY" || { echo "GEN_AWS_SECRET_ACCESS_KEY not set"; exit 1; }
	$(FLY) secrets set -a $(APP_PY3_MGR) \
		AWS_ACCESS_KEY_ID="$$GEN_AWS_ACCESS_KEY_ID" \
		AWS_SECRET_ACCESS_KEY="$$GEN_AWS_SECRET_ACCESS_KEY" \
		AWS_ENDPOINT_URL_S3="$${AWS_ENDPOINT_URL_S3:-https://fly.storage.tigris.dev}" \
		AWS_REGION="auto"

secrets-pygame-manager:
	@test -n "$$GEN_AWS_ACCESS_KEY_ID"     || { echo "GEN_AWS_ACCESS_KEY_ID not set (bucket-scoped Tigris key)"; exit 1; }
	@test -n "$$GEN_AWS_SECRET_ACCESS_KEY" || { echo "GEN_AWS_SECRET_ACCESS_KEY not set"; exit 1; }
	$(FLY) secrets set -a $(APP_PG_MGR) \
		AWS_ACCESS_KEY_ID="$$GEN_AWS_ACCESS_KEY_ID" \
		AWS_SECRET_ACCESS_KEY="$$GEN_AWS_SECRET_ACCESS_KEY" \
		AWS_ENDPOINT_URL_S3="$${AWS_ENDPOINT_URL_S3:-https://fly.storage.tigris.dev}" \
		AWS_REGION="auto"

## ---------- deploys ----------
# --ha=false everywhere: flyctl otherwise creates 2 Machines per new app.
# Counts are seeded explicitly by `make scale`. The pygame worker must NEVER
# exceed 1 Machine (single-worker design).
# Execution tiers deploy before exec/app so first user traffic finds them.

deploy-python3-shell:
	$(FLY) deploy $(REPO)/serverside/python/shell -c $(FLY_DIR)/fly.python3-shell.toml --ha=false

deploy-python3-manager:
	$(FLY) deploy $(REPO)/serverside/python/manager -c $(FLY_DIR)/fly.python3-manager.toml --ha=false

deploy-pygame-worker:
	$(FLY) deploy $(REPO)/serverside/pygame/worker -c $(FLY_DIR)/fly.pygame-worker.toml --ha=false

deploy-pygame-manager:
	$(FLY) deploy $(REPO)/serverside/pygame/manager -c $(FLY_DIR)/fly.pygame-manager.toml --ha=false

# No --dockerfile flag: flyctl takes the dockerfile from each toml's [build]
# section (config-file-relative) and ignores the flag when both are present.
deploy-exec:
	$(FLY) deploy $(REPO) -c $(FLY_DIR)/fly.exec.toml --ha=false

deploy-app:
	$(FLY) deploy $(REPO) -c $(FLY_DIR)/fly.app.toml --ha=false

deploy: deploy-python3-shell deploy-python3-manager deploy-pygame-worker \
        deploy-pygame-manager deploy-exec deploy-app

## ---------- post-deploy ----------

scale:
	$(FLY) scale count 2 -a $(APP_MAIN) -y
	$(FLY) scale count 3 -a $(APP_PY3_SHELL) -y
	# exec, managers and the pygame worker stay at 1 (from --ha=false deploys)

certs:
	$(FLY) certs add $(HOST_MAIN) -a $(APP_MAIN)
	$(FLY) certs add $(HOST_EXEC) -a $(APP_EXEC)
	@echo ">> Create the DNS records shown above, then run: make certs-check"

# Read-only. Plain `fly certs check <host>` fails outside a fly.toml dir —
# the -a flag is required, which this target supplies.
certs-check:
	$(FLY) certs check $(HOST_MAIN) -a $(APP_MAIN)
	$(FLY) certs check $(HOST_EXEC) -a $(APP_EXEC)

bootstrap:
	@echo "First-time setup order (each step detailed in fly/README.md):"
	@echo "  1. fly auth login"
	@echo "  2. make apps-create              # rename apps first if names are taken"
	@echo "  3. make flycast                  # BEFORE any deploy of the internal apps"
	@echo "  4. Create MongoDB Atlas cluster (AWS eu-west-2) -> export MONGODB_URI"
	@echo "  5. make redis                    # -> export REDIS_HOST, REDIS_PASSWORD"
	@echo "  6. make storage                  # -> export AWS_* Tigris creds"
	@echo "  7. Apply follow-up F1 (config/db.js Atlas URI patch) — required to boot"
	@echo "  8. export SESSION_SECRET=... ; make secrets-app"
	@echo "  9. make deploy"
	@echo " 10. make scale"
	@echo " 11. make certs                    # then create the DNS records it prints"
	@echo " 12. Smoke-test per fly/README.md, then work through follow-ups F2-F4"
