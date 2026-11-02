# E-Money MDB exporter

This isolated tool exports CSV with mdbtools. Codex tests use generated CSV and command stubs only; no real MDB is accessed. Real source use requires separate user authorization on 驗收工作站.

```sh
mkdir -p /private/emoney-export
export MDB_SOURCE=/private/source.mdb MDB_OUTPUT=/private/emoney-export
export EXPORT_UID=$(id -u) EXPORT_GID=$(id -g)
docker compose -f tools/mdb-export/compose.yaml build
docker compose -f tools/mdb-export/compose.yaml run --rm mdb-export export
# inventory exports the same CSV plus schema.sql; use a separate empty output directory.
docker compose -f tools/mdb-export/compose.yaml run --rm mdb-export inventory
```

The source bind is read-only (`ro,Z`); the entrypoint verifies the mount flags. The container runs without network, capabilities, or root and has a read-only filesystem. Ensure the output directory belongs to the configured UID/GID. Do not commit source/export/inventory/report files.

Publication is atomic: CSV, optional PostgreSQL schema and manifest are staged in a private `.tmp.*` directory, each file renamed from `.tmp`, then the whole directory renamed to `/output/<source SHA256>`. Existing exports are never overwritten. Concurrent publishers use a per-source directory lock; after an interrupted process, inspect and remove only its stale `.tmp.*`/lock before retrying.

`manifest.txt` starts with `SOURCE_SHA256|<64 lowercase hex>`, then `SOURCE_DATE|YYYY-MM-DD` (source file mtime in Asia/Taipei (UTC+08:00), not today), then `EXPORTED_AT|YYYY-MM-DDTHH:mm:ssZ` (actual export time), then `TABLE|ROWS|FILE_SHA256`. Counts come from `mdb-count`, not line counting, so quoted multiline memos are supported. Table filenames are lowercase; unsupported/path-like names or case collisions fail closed. Output text is UTF-8; Jet3 charset, if needed, must be explicitly provided using `MDB_JET3_CHARSET` (never inferred).

See the [official mdb-export options](https://github.com/mdbtools/mdbtools/blob/dev/doc/mdb-export.txt) for CSV quoting and explicit date formats. Inventory files contain private schema and data and belong only in the private output directory.
