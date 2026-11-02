# PostgreSQL digest 查證與 Trivy 基準（2026-10-16）

使用者核准將「更新 digest」改為查證 PR：官方 registry 沒有更新的 image，不變更 Dockerfile 的 pin。

- Docker Hub API：https://hub.docker.com/v2/repositories/library/postgres/tags/17-bookworm
- `last_updated`: `2026-10-06T07:10:03.547701Z`
- `skopeo inspect --format '{{.Digest}}' docker://docker.io/library/postgres:17-bookworm` 與 API 結果一致。
- before = after = `postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826`（multi-platform index）。
- linux/amd64 child：`sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df`。改 pin 同一 image 的 child 不構成更新。

## 實際掃描

掃描對象為 `deploy/postgres.Dockerfile` 建出的 gosu-free image；Trivy 0.75.0，2026-10-16 12:52 UTC。掃描使用 image archive，不包含 DB volume。

| 掃描                                         | HIGH | CRITICAL | MEDIUM | LOW | UNKNOWN | exit |
| -------------------------------------------- | ---: | -------: | -----: | --: | ------: | ---: |
| blocking，ignore-unfixed=true，HIGH/CRITICAL |    0 |        0 |      — |   — |       — |    0 |
| full，ignore-unfixed=false，全 severity      |   71 |        3 |    164 | 170 |       4 |    0 |

before 與 after 使用相同 digest、相同 image、相同 vulnerability DB；故數字相同，沒有宣稱修補以上未修復的風險。CI 仍會獨立重掃並上傳 JSON/table，結果可能因 vulnerability DB 更新而不同。

重現：

```sh
docker build -f deploy/postgres.Dockerfile -t finmichi-postgres:baseline .
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 finmichi-postgres:baseline
trivy image --scanners vuln --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --exit-code 0 finmichi-postgres:baseline
```

沒有變更 `.trivyignore`、CI gate、runtime、版本 tag 或部署。後續更新應重新查證 registry 並比較掃描結果。
