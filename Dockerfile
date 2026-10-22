FROM rust:1.99.1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/card-cache ./crates/card-cache
RUN cargo build --release --locked -p mtga-card-cache --jobs 2 \
    && strip target/release/mtga-card-cache

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgcc-s1 \
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
