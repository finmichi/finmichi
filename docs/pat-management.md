# 唯讀 MCP PAT 管理（ADR-0009）

登入後展開「唯讀 MCP 權杖」，選擇 1–90 天、全部或指定帳本及文字遮罩（預設開啟）。scope 固定 read。建立成功只顯示一次完整權杖，隱藏後無法取回；遺失請撤銷並重建。

`GET /api/pats` 僅列出自己的前綴、範圍與狀態，不回傳 hash 或完整權杖。`POST /api/pats` 建立；`POST /api/pats/:id/revoke` 撤銷。均使用既有 session；寫入需要同源 Origin。回應禁止快取。並行建立以 FOR NO KEY UPDATE 鎖定 owner（相容一般操作的 FK 檢查，避免 audit／帳本鎖死結），最多十個未撤銷且未到期的權杖；過期或撤銷立即失效。指定帳本建立時逐一驗證 owner。

migration 0014 只新增資料表及 audit action。資料庫保留 draft/write 的 schema 空間，API 與認證目前只接受 read。憑證只存 SHA-256 和前八字元，不記入 audit；pat.create／pat.revoke 僅記動作與結果。

驗證：`pnpm check`、`pnpm test:db`、`pnpm test:pat-ui`。UI 測試僅使用 localhost 合成帳本，截圖前隱藏完整權杖並撤銷；`test-results/pat/pat-390.png` 不含完整權杖。MCP transport 與工具在後續依賴 PR 提供，本 PR 不新增對外 MCP 路由。
