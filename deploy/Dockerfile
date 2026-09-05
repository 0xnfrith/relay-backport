# Multi-stage: build a single static binary, run it as a non-root user with
# /data as the state volume. Build from the repo root:
#
#   docker build -f deploy/Dockerfile -t relay-backport .
#   docker run -v relay-backport-data:/data -v /path/to/key:/run/secrets/key:ro \
#     -e RELAY_URL=wss://relay.example.com -e PRIVATE_KEY_FILE=/run/secrets/key \
#     -e OWNER_PUBKEY=<hex> -e SINKS=webhook -e WEBHOOK_URL=https://... \
#     relay-backport
#
# The health endpoint binds 127.0.0.1 inside the container (unreachable from
# the host) unless you opt in:
#     -e HEALTH_PORT=8080 -e HEALTH_HOST=0.0.0.0 -p 127.0.0.1:8080:8080

FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
# No --target: compile for the build platform's own arch (amd64 or arm64).
RUN bun build --compile src/cli.ts --outfile /out/relay-backport

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system relay \
  && useradd --system --gid relay --home /data --shell /usr/sbin/nologin relay \
  && mkdir -p /data && chown relay:relay /data && chmod 0700 /data
COPY --from=build /out/relay-backport /usr/local/bin/relay-backport
USER relay
VOLUME ["/data"]
ENV STATE_DIR=/data \
    HEALTH_HOST=127.0.0.1 \
    LOG_FORMAT=json
ENTRYPOINT ["/usr/local/bin/relay-backport"]
CMD ["watch"]
