# 安全性政策（Security Policy）

FinMichi 是一個可以自行架設的個人財務管理系統，處理的是使用者的帳務資料。我們很重視安全性問題，感謝你協助回報。

_English summary: Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security Advisories) on `finmichi/finmichi`. Do not open public issues for security problems. We aim to acknowledge within 7 days and to provide a fix or mitigation plan within 30 days for confirmed high-severity issues._

## 支援的版本

| 版本                            | 是否提供安全性修正                                 |
| ------------------------------- | -------------------------------------------------- |
| 最新的 minor 版本（例如 0.3.x） | ✅                                                 |
| 前一個 minor 版本               | 只修正 Critical 等級的問題，期限為新版發布後 30 天 |
| 更舊的版本                      | ❌，請升級                                         |

1.0 之前的版本都屬於 Alpha／Beta 階段，請依照 Release Notes 盡快升級。

## 如何回報

1. **請不要**在公開的 Issue、Discussion 或 PR 中描述漏洞。
2. 請使用 GitHub 的私密回報功能：repo 頁面 → **Security** → **Report a vulnerability**。
3. 請盡量提供以下資訊：
   - 受影響的版本或 commit
   - 部署方式（Docker Compose、NAS、反向代理；使用 HTTP 或 HTTPS）
   - 重現步驟，或概念驗證（**只使用合成資料**）
   - 你評估的影響範圍，例如資料外洩、權限提升、阻斷服務
4. **請不要附上任何真實的帳務資料、密碼、token 或個人資料。**

## 處理流程與時程（目標，不是保證）

| 階段                                | 目標時間                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| 確認收到                            | 7 天內                                                                                 |
| 初步評估與嚴重程度判定              | 14 天內                                                                                |
| High／Critical 問題的修正或緩解方案 | 30 天內                                                                                |
| 公開揭露                            | 修正版發布之後，與回報者協調時間；預設在修正版發布後 7 天公開 GitHub Security Advisory |

如果你願意，我們會在 Advisory 中致謝。這是個人維護的專案，**沒有提供漏洞獎金（bug bounty）**。

## 適用範圍

**適用**：

- 本 repo 的程式碼
- 官方 container image（`ghcr.io/finmichi/*`）
- 官方部署範例（compose、`.env.example`、備份腳本）

**不適用**：

- 使用者自行設定的反向代理、OIDC provider、NAS 或作業系統
- 第三方的行情資料來源
- 社群另外提供的 adapter（除非已經合併進本 repo）

## 給自架使用者的提醒

- **預設使用 HTTP** 的安裝，只適合在信任的區域網路中使用。要從外部連線，請設定 HTTPS（直接在平台設定憑證，或使用反向代理），**不要把 HTTP 服務直接開放到網際網路**。
- 請啟用兩步驟驗證（TOTP 或 passkey），並妥善保管復原碼。
- `.env`、`FINMICHI_SECRETS_KEY`、資料庫密碼、OIDC client secret，請存放在密碼管理器，**不要提交到任何 repo**。
- 定期執行備份與還原演練，並保留在不同位置的備份。
- 訂閱本 repo 的 Releases 與 Security Advisories，以便及時升級。
