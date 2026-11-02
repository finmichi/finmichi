FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends mdbtools ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --chmod=0555 tools/mdb-export/entrypoint.sh /usr/local/bin/life-mdb-export
COPY --chmod=0555 tools/mdb-export/export.sh /usr/local/lib/life-mdb-export.sh
ENV MDBICONV=UTF-8 LC_ALL=C TZ=UTC
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/life-mdb-export"]
CMD ["export"]
