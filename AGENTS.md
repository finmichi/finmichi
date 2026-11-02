# FinMichi — Contributor and Agent Instructions

請先讀取 README.md、CONTRIBUTING.md、SECURITY.md 與相關程式碼及測試。程式碼與測試是實作狀態的依據；規格衝突時先提出問題，不自行變更帳務口徑。

## 安全與範圍

- 只使用合成 fixtures。不得讀取、要求或提交真實帳務檔案、MDB、帳單、備份、憑證、token 或正式 secrets。
- 不得自行部署、發布、變更 repo 可見性，或繞過 CI 與資料來源的 challenge。
- 不得 force push 受保護分支。一般變更走 feature branch 與 PR；核准後才 merge。
- 原始碼授權 AGPL-3.0-only；每個 commit 必須 DCO sign-off，詳 CONTRIBUTING.md。名稱與 Logo 依 TRADEMARK.md。

## 實作與驗證

- Inspect → Plan → Implement → Test → Verify；一個變更只處理一個主題，回報實際驗證結果與限制。
- 沿用 Node 22、pnpm workspace、TypeScript strict、React、Fastify、PostgreSQL 17。
- 金額與匯率用十進位字串／BigInt／既有 decimal utility；不得用浮點數計算帳務。
- 每筆交易本位幣分錄總和為 0；沿用 core service 的權限、帳務與 audit 規則。
- migration 只能前進，已合併檔案逐 byte 不變；新 migration 從建立時即含 SPDX 標頭。
- 所有 mutation 維持 Origin 檢查；跨使用者資源存取回 404；session/PAT 只保存既有 hash，audit 不記錄敏感內容。
- CSV 文字欄位維持 formula injection 防護；系統數值欄位沿用 typed numeric 契約。
- UI 使用繁體中文、設計 token，驗證桌面／手機、明暗主題、對比與溢出。
- 容器維持非 root、read_only、cap_drop、no-new-privileges、log rotation；dev bind mount 保留 :Z。

## 常用指令

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:db
```

測試只能使用專用合成資料庫。更改前先讀取相關文件，完成後在 PR 說明範圍、測試、migration 影響與未驗證項目。
