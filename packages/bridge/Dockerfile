FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl git fuse3 npm python3 python3-pip nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright for browser automation
RUN npx playwright install chromium 2>/dev/null || true

# computerd binary from @cloudflare/computerd
COPY --from=ghcr.io/cloudflare/computerd:latest /usr/local/bin/computerd /usr/local/bin/computerd

ENTRYPOINT ["computerd"]
