# Multi-stage: build a single static binary and run it as a non-root user.
# Build from the repo root:
#
#   docker build -f deploy/Dockerfile -t relay-backport .
#   docker run --rm relay-backport --version
#
# relay-backport is an ACP server: on its own it waits for a harness on stdin.
# A headless deployment pairs it with Block's `buzz-acp` in one image or pod
# (`BUZZ_ACP_AGENT_COMMAND=relay-backport`, see README "Headless: buzz-acp");
# this image is the building block for that. `/data` holds the delivery file.

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
ENV RELAY_BACKPORT_STATE_DIR=/data \
    RELAY_BACKPORT_LOG_FORMAT=json
ENTRYPOINT ["/usr/local/bin/relay-backport"]
CMD ["acp"]
