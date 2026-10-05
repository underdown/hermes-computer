# Container image for the hermes-computer bridge.
#
# The computerd daemon is published as a public, anonymous-pullable GHCR image
# under the name `computer-computerd-linux-x64` (NOT `computerd`, which does
# not exist and 401s). It is a single layer over scratch containing only the
# SEA binary, so we copy that binary out and run it inside a slim Debian that
# also carries Node, Python and Playwright for the bridge's tool endpoints.
#
# Tag pinned to 0.1.1 to match the installed @cloudflare/computer SDK.
# Bump both together.
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1 AS computerd

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl git fuse3 npm python3 python3-pip nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright for browser automation
RUN npm install -g playwright 2>/dev/null
RUN npx playwright install chromium 2>/dev/null || true
RUN npx playwright install-deps chromium 2>/dev/null || true

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd defaults: HTTP+WS on :8080, FUSE mount at MOUNT_POINT.
# FUSE_MOUNT=auto picks the real FUSE backend on Cloudflare Containers (where
# /dev/fuse is exposed) and falls back to the userspace shim under wrangler dev.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
