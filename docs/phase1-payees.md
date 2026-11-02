# Phase 1.2：收付人 CRUD

依賴科目樹／帳本 stacked PR。此主題新增收付人的 API、可操作 UI 與其共用 metadata helper；不新增 migration。

`/api/ledgers/:ledger/payees`：GET、POST；`/:record`：GET、PATCH、DELETE。GET 預設隱藏封存，管理列表用 `include_archived=true`。新增接受 name（trim，1–200 字）、archived（預設 false）；PATCH 只接受這兩欄、至少一欄，省略保留。未知欄位、query、UUID 拒絕 400。

core service 驗 ledger owner，mutation 與無內容 audit 原子提交；foreign owner/ledger/record 404。table identifier 使用編譯期類型與 runtime allowlist，參數不拼 raw SQL。姓名 case-insensitive per-ledger 唯一，重複409；所有 mutation 沿用 session + Origin guard。

UI 的基本資料 Tabs 提供新增、改名、封存、復原與二次確認刪除。未被交易引用可刪；引用中 DELETE 回 409 `in_use`，可改封存，歷史交易不變。封存仍可讀單筆。未提供 MCP 刪除 tool。

驗證：`pnpm check` 通過（36 unit tests）；`pnpm test:db` 69 tests 通過（新增7）；合成 DB 驗 session、Origin、HTTP/core owner、strict schema、跨 ledger ID、唯一性、archive/read/restore、delete/FK、audit。Chrome 實際新增／改名／封存／復原／刪除通過，390px 無水平溢出，截圖 `payees-ui-390.png`。

僅本機合成資料與 TLS fixture。未部署、未建立 tag；專案與常用摘要由各自 PR 新增。
