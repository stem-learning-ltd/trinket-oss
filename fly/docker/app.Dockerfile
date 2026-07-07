# Fly.io build of the main Trinket app.
# Mirrors the repo-root Dockerfile, then overlays config/production.yaml
# (non-secret prod values). Secrets arrive at runtime as the single
# NODE_CONFIG env var (JSON) — the app pins config@0.4.x, which predates
# custom-environment-variables support; NODE_CONFIG is the override it has.
# Build context must be the REPO ROOT (fly/Makefile handles this).
FROM node:16-bullseye

SHELL ["/bin/bash", "-c"]

RUN apt-get update \
    && apt-get install -y python3 build-essential \
    && apt-get -y autoclean

RUN npm install -g pm2@5

RUN groupadd -r trinket && \
    useradd -r -g trinket -m -c "trinket user" trinket

RUN mkdir -p /usr/local/node/trinket && chown trinket:trinket /usr/local/node/trinket

USER trinket

COPY --chown=trinket:trinket . /usr/local/node/trinket

WORKDIR /usr/local/node/trinket

# Frontend components bundle, mirrored to OUR fork's releases (not upstream's —
# upstream could remove/replace theirs) and integrity-pinned. To bump: upload
# the new tarball as a fork release, update the URL and hash together.
RUN curl -L --silent -o ./public-components.tgz \
    https://github.com/stem-learning-ltd/trinket-oss/releases/download/frontend-components-v1.1.0/public-components.tgz \
    && echo "58422c0d0c7d25c1e6fdd1e014ff690f41c899257703e416e85a0fb0a926181f  public-components.tgz" | sha256sum -c - \
    && tar xzf public-components.tgz \
    && rm public-components.tgz

RUN npm install --legacy-peer-deps

# Compile SCSS -> public/css/{base,embed}.css (vite). The repo ships no
# prebuilt CSS and no Dockerfile ran this — pages render unstyled without it.
RUN npm run build

# Fly config overlay. config@0.4.x load order (later wins):
# default.yaml < production.yaml < $NODE_CONFIG (JSON env var, set as a Fly secret)
RUN cp fly/config/app/production.yaml config/production.yaml

ENV NODE_ENV=production

EXPOSE 3000

CMD ["pm2-docker", "start", "app.js"]
