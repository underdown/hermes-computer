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

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git fuse3 libfuse2 npm python3 python3-pip nodejs ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# CRITICAL: computerd is a dynamically linked ELF (needs libstdc++6/libc6) even
# though it ships in a `scratch` image. Two FUSE packages are BOTH required or
# the container exits 1 before binding :8080:
#   libfuse2 -> provides libfuse.so.2, else "cannot open shared object file"
#   fuse3    -> provides the setuid fusermount helper, else "failed to exec fusermount"
# Only reproduces when /dev/fuse is present. Without it, FUSE_MOUNT=auto silently
# falls back to backend=shim and the bug hides — which is exactly why it survived
# until deployment on Cloudflare, where /dev/fuse IS exposed.
# Verify with: docker run --rm --device /dev/fuse --cap-add SYS_ADMIN <image>
# A healthy container prints "backend=fuse" and stays up (exit 124 under timeout).

# Install Playwright for browser automation
RUN npm install -g playwright 2>/dev/null
RUN npx playwright install chromium 2>/dev/null || true
RUN npx playwright install-deps chromium 2>/dev/null || true

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd defaults: HTTP+WS on :8080, FUSE mount at MOUNT_POINT.
#
# FUSE_MOUNT=shim, NOT auto. "auto" probes for /dev/fuse and selects the real
# FUSE backend when it finds one — but Cloudflare Containers expose /dev/fuse
# WITHOUT granting CAP_SYS_ADMIN, so the mount then fails and the process exits
# 1 before ever binding :8080. Reproduced exactly:
#   docker run --device /dev/fuse                      -> "fuse failed", exit 1
#   docker run --device /dev/fuse --cap-add SYS_ADMIN  -> backend=fuse, stays up
# The userspace shim needs no capabilities and serves the same HTTP/WS API, so
# pin it explicitly. The workspace is container-local either way, so there is
# nothing to lose by not using the kernel FUSE path.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=shim
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
