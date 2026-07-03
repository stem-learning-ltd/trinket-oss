# Fly.io build of the execution-stack ingress (nginx).
# The stock serverside/nginx/nginx.conf is Docker-specific (127.0.0.11 resolver,
# Docker-DNS upstream names, shared-volume alias locations) — this image copies
# in the Fly-specific config instead of editing the stock file.
# Build context must be the REPO ROOT (fly/Makefile handles this).
FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf

COPY fly/config/exec/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
