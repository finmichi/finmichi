# Phase 1.2：專案 CRUD

本 stacked PR 依賴收付人 PR，以相同 core metadata service 新增 `projects` runtime allowlist、REST 路由、專案管理 Tab 與獨立 API/DB 測試。沒有修改 migration、收付人語意或交易程式。

`/api/ledgers/:ledger/projects`：GET、POST；`/:record`：GET、PATCH、DELETE。欄位 name（trim，1–200 字）與 archived；預設列表排除封存，`include_archived=true` 可查全部。PATCH 省略保留，未知欄位拒絕。權限、Origin、audit、per-ledger case-insensitive 名稱唯一、未引用可刪／引用中409並可封存，與收付人契約一致。

驗證：`pnpm check` exit 0（36 unit tests）；`pnpm test:db` 76 tests 通過（新增7）。涵蓋真實 session、HTTP/core owner、跨帳本 ID、strict schema、重複名稱、封存／復原、FK 歷史保護與 audit。Chrome UI 實際新增、改名、封存、復原、刪除專案均通過，390px 無水平溢出，截圖 `projects-ui-390.png`。

僅合成資料、本機 TLS fixture，未部署或建立 tag。常用摘要由下一個 PR 提供。
