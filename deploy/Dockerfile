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

# Base images are pinned by digest (Dependabot's docker ecosystem keeps them current).
# The oven/bun tag must equal .bun-version; CI fails if they drift.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
# No --target: compile for the build platform's own arch (amd64 or arm64).
RUN bun build --compile src/cli.ts --outfile /out/relay-backport

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
# ca-certificates is deliberately not version-pinned (hadolint DL3008): Debian drops
# superseded versions from its mirrors, so an exact pin breaks the build and holds
# back CA bundle security fixes. The digest-pinned base image is the reproducibility knob.
# A fixed numeric UID/GID lets Kubernetes `runAsNonRoot: true` verify the user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 relay \
  && useradd --system --uid 10001 --gid 10001 --home /data --shell /usr/sbin/nologin relay \
  && mkdir -p /data && chown 10001:10001 /data && chmod 0700 /data
COPY --from=build /out/relay-backport /usr/local/bin/relay-backport
USER 10001:10001
VOLUME ["/data"]
ENV RELAY_BACKPORT_STATE_DIR=/data \
    RELAY_BACKPORT_LOG_FORMAT=json
ENTRYPOINT ["/usr/local/bin/relay-backport"]
CMD ["acp"]
