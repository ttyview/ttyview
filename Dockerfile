# Multi-stage build for ttyview-daemon. Demo + read-only deployments
# don't need tmux at runtime; the binary embeds everything (UI bundle,
# community plugins, demo transcript) via rust-embed.
#
# Build:
#   docker build -t ttyview-daemon .
#
# Run (Tier 1 demo, no tmux):
#   docker run --rm -p 8080:8080 ttyview-daemon \
#     --bind 0.0.0.0:8080 --demo
#
# Run (Tier 2 read-only, sharing the host's tmux server):
#   docker run --rm --network host \
#     -v /tmp/tmux-1000:/tmp/tmux-1000 \
#     ttyview-daemon --bind 0.0.0.0:8080 --read-only

# ---------------- builder ----------------
FROM rust:1-slim AS builder
WORKDIR /src
# Cache deps separately from sources — touching a .rs file shouldn't
# rebuild the entire dependency graph.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --bin ttyview-daemon

# ---------------- runtime ----------------
FROM debian:bookworm-slim AS runtime
# `tmux` is needed for non-demo modes (Tier 2 reads from `tmux capture-pane`,
# Tier 3 spawns its own tmux servers). For demo-only deployments it's still
# only ~600 KB so we ship it always.
# `ca-certificates` lets reqwest reach a remote --registry-url over HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/target/release/ttyview-daemon /usr/local/bin/ttyview-daemon

# Cloud Run injects PORT; bind to 0.0.0.0:$PORT by default. Override the
# entire CMD for local docker runs that want a different bind/flags.
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "-c", "exec /usr/local/bin/ttyview-daemon --bind 0.0.0.0:$PORT \"$@\"", "--"]
CMD ["--demo"]
