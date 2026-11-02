# 內容掃描與公開準備

每個 PR（包含 docs-only）都執行 legacy-names、環境識別值、秘密與資料／檔案政策掃描。這些啟發式檢查用來發現疑似資料，不能證明內容一定沒有私人資訊；人工審查仍然必要。

## 環境識別值

`ENV_IDENTIFIER_PATTERNS` 為 repository Actions secret，每行一個 regex，由維護者在私人環境設定。不要把 pattern 或比對到的文字寫入 repo、PR、日誌或 artifact。掃描只輸出路徑、行號與規則名稱。未設定或格式無效時，同 repo 的 CI 失敗；fork PR 的這一步由 workflow guard 明確 skipped，其餘掃描照常執行。

例外位於 `scripts/security/environment-allowlist.json`，目前只允許 repo／GHCR owner 參照，每筆綁定完整路徑與完整行 SHA-256。修改行後必須重新審查，不可使用整個資料夾或任意字串的排除規則。

## 秘密

gitleaks v8.30.1 從官方 release 下載，安裝腳本核對固定 SHA-256。PR 掃描 immutable base/head 的淨新增行，移除假秘密後即可通過；main／手動 CI 掃描 tracked text，全歷史則每週獨立報告。忽略行內 allow 指令與 repo 的 gitleaks ignore 檔，沿用官方預設規則。報告移除秘密與匹配內容，只保留規則、路徑、行號與歷史 commit。原始 redacted 暫存報告完成後刪除。

歷史報告不改寫 private repo 歷史。若查出疑似秘密，由維護者確認與撤銷後依 ADR-0015 決定後續處置；公開時另建乾淨 repo。

## 合成資料與檔案

檢查疑似身分證、Luhn 卡號、非 example.com email、發票及載具號碼。`fixture-registry.json` 登記合成 CSV／JSON fixture 與產生來源，綁定檔案 SHA-256；登記 fixture 只免除資料形狀檢查，仍掃描環境識別值與秘密。inline 合成案例、來源檔名與 UUID 誤判使用 `data-allowlist.json` 的路徑＋完整行 SHA＋規則，須寫明理由。

檔案上限 1 MiB。只接受列明的程式／文件文字類型；PNG、TTF 須登記資產及 SHA。拒絕 MDB、Office 試算表、dump、備份、憑證／私鑰、壓縮檔、`.env`、symlink 與未登記二進位內容。Big5 僅接受已登記合成 fixture。登記檔本身不能作為真實資料的豁免理由。

## 本機驗證

```sh
sh scripts/security/install-gitleaks.sh
node --test scripts/security/*.test.mjs
node scripts/security/content.mjs data
# 由私人設定提供 ENV_IDENTIFIER_PATTERNS，不要在終端輸入或印出內容
node scripts/security/content.mjs environment
node scripts/security/gitleaks.mjs
node scripts/security/gitleaks.mjs --history --report-only
```

[官方 gitleaks 文件](https://github.com/gitleaks/gitleaks)；[固定版本](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)。
