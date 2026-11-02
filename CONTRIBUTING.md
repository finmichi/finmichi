# 參與貢獻（Contributing）

感謝你願意協助 FinMichi！FinMichi 是一個以複式記帳為核心、可以自行架設的個人財務管理系統，以臺灣的使用情境為主。

_English summary: Bug reports, docs and code are welcome. Use synthetic data only — never commit real financial records, statements, receipts or credentials. Sign off your commits (DCO). Open an issue before large changes. All contributions are licensed under AGPL-3.0-only._

## 最重要的規則：只使用合成資料

- **絕對不要**在 Issue、PR、測試 fixture、截圖或 log 中放入真實的帳務資料。這些都屬於真實資料：
  - 銀行與信用卡的對帳單
  - 薪資單、發票、載具資料
  - 身分證字號、帳號、卡號
  - 密碼與 token
- 測試資料請自行產生，或修改既有的合成 fixture。新增的 fixture 要登記在 fixture 清單中，並說明產生的方式。
- CI 會自動掃描類似身分證字號的字串、通過 Luhn 檢查的卡號、不是 `example.com` 的 email，以及秘密。偵測到就會失敗。
- 文件與範例只能使用中性的值：`example.com`、`192.0.2.x`（RFC 5737）。

## 回報問題

- **一般 bug 或功能建議**：請開 Issue，並附上以下資訊：
  - 版本
  - 部署方式（Docker Compose、NAS、反向代理、HTTP 或 HTTPS）
  - 重現步驟
  - 預期的結果與實際的結果
- **安全性問題**：**請不要開公開 Issue**，依 [SECURITY.md](SECURITY.md) 私下回報。

## 開發環境

```bash
corepack enable
pnpm install --frozen-lockfile
bash deploy/setup-dev.sh        # 建立本機開發用設定（mock OIDC、合成 DB）
docker compose -f deploy/compose.dev.yaml up -d --wait
pnpm check                      # lint、typecheck、單元測試與 property test
pnpm test:db                    # DB 與 MCP 測試（需要測試資料庫）
pnpm test:ux-<suite>            # Playwright UI 回歸
```

- Node.js 22、pnpm（版本以 `package.json` 為準）、Docker 24 以上。
- 官方 image 只支援 **linux/amd64**。

## 提交 PR 的流程

1. **較大的修改請先開 Issue 討論**，例如新的資料表、新的報表、新的 adapter、會改變帳務語意的修改。
2. 從最新的 `main` 建立分支。一個 PR 只處理一件事。
3. 必須通過：
   - `pnpm check`、`pnpm test:db`，以及相關的 UI 測試
   - 新的 API 要有**跨使用者的負向測試**：使用者 B 不能讀取或修改使用者 A 的資料
   - UI 修改要在 1440 與 390、淺色與深色主題下，溢出 0、對比 0
4. **資料庫 migration**：
   - 只能新增，不得修改已經合併的 migration。
   - 新增 migration 建立時即須包含 `-- SPDX-License-Identifier: AGPL-3.0-only` 標頭，之後連同全文固定 checksum。歷史 migration 的排除清單見 [授權標頭清單](docs/spdx-exclusions.md)。
   - 必須能在既有資料上直接執行。
   - 在 PR 中說明影響與回復方式。
5. **金額與帳務**：
   - 金額一律使用十進位字串或 BigInt，**不得使用浮點數**。
   - 每筆交易的分錄必須零和。
   - 修改報表語意時，請引用或新增對應的 ADR。
6. **秘密與設定**：秘密只能來自環境變數或 `*_FILE`，不得寫進程式、範例或 log。
7. **外部連線**：除了文件中列出的行情來源與使用者設定的 OIDC，不得新增任何對外連線，也不收集任何遙測資料。**不得繞過任何資料來源的機器人驗證機制。**
8. PR 說明請包含：修改了什麼、為什麼修改、如何驗證、是否有 migration、對使用者升級的影響。

## 新增資料來源 adapter

收件匣的資料來源（銀行、信用卡、電子發票、薪資單、集保等）都以 adapter 實作，規範見 ADR-0014：

- 放在 `packages/adapters/<adapter-id>/`，並在 registry 中登記。
- adapter 必須是**純函式**：不能存取網路、資料庫或檔案系統，相同的輸入必須產生相同的輸出。
- 要有版本號；格式改版時，版本號要遞增。
- **只用合成 fixture 測試**：依照文件的欄位格式自行產生。**不得提交真實文件，即使已經遮蔽也不行。**
- 核心程式中不得出現機構名稱或版面判斷。

## 程式風格

- TypeScript strict、ESLint、Prettier，以 CI 的設定為準。
- 註解說明「為什麼」，不需要說明「做了什麼」。
- 使用者介面的文字預設使用繁體中文（臺灣用語）。新的文字請放進訊息檔（i18n）。

## 授權與簽署（DCO）

- 本專案使用 **AGPL-3.0-only** 授權（Copyright (C) 2026 FinMichi contributors，貢獻者名單見 [AUTHORS](AUTHORS)）。提交貢獻即表示你同意以相同條款授權你的貢獻。
- 每個 commit 都要以 `git commit -s` 加上 **Developer Certificate of Origin** 簽署（`Signed-off-by: 姓名 <email>`），表示你有權提交這些內容。DCO 全文：<https://developercertificate.org/>
- **不需要**簽署 CLA。
- FinMichi 的名稱與 Logo **不在**程式碼授權的範圍內，見 [TRADEMARK.md](TRADEMARK.md)。

## 行為準則

參與本專案時，請遵守行為準則：[繁體中文](CODE_OF_CONDUCT.zh-TW.md)（非官方翻譯）／[English](CODE_OF_CONDUCT.md)（以英文版為準）。
