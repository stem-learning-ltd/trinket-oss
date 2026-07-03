# Fly.io build of the main Trinket app.
# Mirrors the repo-root Dockerfile, then overlays Fly production config:
#   - config/production.yaml               (non-secret prod values)
#   - config/custom-environment-variables.yaml (maps Fly secrets -> config keys)
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

# Download frontend components from GitHub release
RUN curl -L --silent -o ./public-components.tgz \
    https://github.com/trinketapp/trinket-oss/releases/download/v1.1.0/public-components.tgz \
    && tar xzf public-components.tgz \
    && rm public-components.tgz

RUN npm install --legacy-peer-deps

# Fly config overlay. node-config load order (later wins):
# default.yaml < production.yaml < custom-environment-variables.yaml (env vars)
RUN cp fly/config/app/production.yaml config/production.yaml \
    && cp fly/config/app/custom-environment-variables.yaml config/custom-environment-variables.yaml

ENV NODE_ENV=production

EXPOSE 3000

CMD ["pm2-docker", "start", "app.js"]
