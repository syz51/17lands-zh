FROM rust:1.99.1-slim-bookworm AS build
ARG DEBIAN_MIRROR=deb.debian.org
# Version ranges allow Debian revisions and security updates.
RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      'gcc=4:12.2.*' 'libc6-dev=2.36-*' 'make=4.3-*' \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/card-cache ./crates/card-cache
ARG CARGO_MIRROR=
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    if [ -n "$CARGO_MIRROR" ]; then \
      mkdir -p .cargo && printf '[source.crates-io]\nreplace-with = "build-mirror"\n[source.build-mirror]\nregistry = "%s"\n' "$CARGO_MIRROR" > .cargo/config.toml; \
    fi \
    && cargo build --release --locked -p mtga-card-cache --jobs 2 \
    && strip target/release/mtga-card-cache

FROM debian:bookworm-slim
ARG DEBIAN_MIRROR=deb.debian.org
RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      'ca-certificates=20250419~deb12u*' 'curl=7.88.1-*' 'libgcc-s1=12.2.*' \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cardcache \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin cardcache \
    && mkdir -p /data/tmp && chown -R 10001:10001 /data
COPY --from=build /src/target/release/mtga-card-cache /usr/local/bin/mtga-card-cache
USER 10001:10001
ENV TMPDIR=/data/tmp
WORKDIR /data
EXPOSE 17317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "--fail", "--silent", "--max-time", "3", "http://127.0.0.1:17317/healthz"]
ENTRYPOINT ["mtga-card-cache", "--db", "/data/cards.sqlite"]
CMD ["serve"]
