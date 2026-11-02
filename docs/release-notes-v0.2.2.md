# v0.2.2 Release notes 草稿

此文件只累積已開發範圍，不代表已核准發布；後續 PR 完成後再補齊版本內容及 migration 清單。

## PR-N：環境設定與 CI

升級前請先備份。部署 `.env` **必須新增 `OIDC_HAIRPIN_HOST`**，填入 OIDC issuer 的主機名稱，並替換 compose；缺值時 Compose 會清楚拒絕啟動。保留既有 `NAS_LAN_IP`、私人 secrets 與 DB volume。詳細步驟見部署 README。PR-N 本身沒有 migration，也不改帳務口徑。

文件中的主機、網域及 IP 改為中性範例。CI 加入 docs-only 也執行的環境識別值、秘密、疑似私人資料及檔案政策檢查；只有 pull_request 自動取消舊 run。runtime smoke 保留，Trivy 改在 Release dry-run／tag blocking 與每週完整報告執行，HIGH／CRITICAL 可修補漏洞門檻不變；weekly 另包含 worker image 與全歷史秘密報告。
