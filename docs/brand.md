# FinMichi 品牌資產（R2）

方向 1「M 字山路」。SVG 是向量 path，無嵌入點陣圖、外部資源或文字字型。
品牌主色 navy；收入、支出、警告與其他語意色維持不變。gold 僅作圖案點綴，不作文字色。

## 字標與離線重製

Manrope 800，SIL OFL；原檔與授權位於 `scripts/brand/source/`，不會複製到 web public/build。
來源為 [google/fonts](https://github.com/google/fonts/tree/b31870aff700ab7a1d74fa0c6887d95beb9e0037/ofl/manrope)，固定 commit `b31870aff700ab7a1d74fa0c6887d95beb9e0037`。
TTF SHA-256：`3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6`。
字距 −0.01em；只有 Michi 的第一個 i（第 5 個字元）的原點替換為金色圓點。
其餘字母全部保留原 glyph 外框。前端維持原有自託管字型，不新增字型請求。

在獨立 Python venv 安裝 `fonttools==4.60.1`、`cairosvg==2.8.2` 後，執行：

```sh
python scripts/brand/generate.py
```

生成時不連網，CI／網站執行時不需要這些 Python 套件。資產放在 `apps/web/public/brand/`。
`og-image.png` 為 1200×630，只有品牌符號與外框字標，沒有帳務資料。

## 幾何與小尺寸

標準符號保留草稿的主路徑與 8 單位筆寬；太陽與筆畫的最近間距約 3.346 單位。
App／maskable 圖示的太陽微調為 (57,9)，以確保縮小後間距仍 ≥3；maskable 使用中央 65% 縮放，
全不透明底色，實際 PNG 每個前景像素都在半徑 40% 的安全圓內（Playwright 像素驗證）。
Favicon 筆寬 11、太陽半徑 5.5、中心 (57,5)，避免 16px 時山峰與太陽黏合。

Manifest 的 id、start_url、scope 仍為 `/`；只更新圖示、theme_color、background_color。
桌面側欄使用反白符號與字標，登入頁隨深淺主題切換；手機標題列新增 28px mark，保留目前頁面名稱與 100px 精簡帳本選單；頁名過長截短，選單不因 mark 縮小。

## 對比計算

使用 WCAG sRGB linearization：c ≤ 0.04045 時 c/12.92，否則 ((c+0.055)/1.055)^2.4；
L = 0.2126R + 0.7152G + 0.0722B，contrast = (L亮+0.05)/(L暗+0.05)。

| 文字／背景                | 前景    | 背景    | 比值     |
| ------------------------- | ------- | ------- | -------- |
| 淺色 primary／surface     | #0F2D3D | #ffffff | 14.354:1 |
| 淺色 primary／bg          | #0F2D3D | #eef1f5 | 12.669:1 |
| 淺色按鈕文字／primary     | #ffffff | #0F2D3D | 14.354:1 |
| 深色 primary／bg          | #94b5da | #0d121b | 8.827:1  |
| 深色 primary／surface     | #94b5da | #151c28 | 8.042:1  |
| 深色 primary／surface-2   | #94b5da | #1a2230 | 7.512:1  |
| 深色 primary／accent-soft | #94b5da | #1c2a47 | 6.715:1  |
| 深色按鈕文字／primary     | #0d121b | #94b5da | 8.827:1  |

深色 primary 色相 211.71°，income 綠 154.22°，相差 57.50°。
所有一般文字組合 ≥4.5:1；既有完整對比矩陣仍在 `theme.test.ts` 執行。
Logo 與字標提供單一可讀名稱 FinMichi，內部圖像 alt 為空以免重複朗讀。

## 回復

回復本 PR 即可還原舊視覺資產與 token；無 DB migration、API 或備份格式異動。

## v0.2.1 PR-D 小尺寸檢查

在實際側欄 154×30 的字標尺寸檢視 Manrope 800：各字母內部空間可辨識，沒有筆畫黏合，保留原外框資產；沒有替換或新增 runtime 字型。手機只顯示 mark，沒有塞入字標。

側欄採 filled 主操作：`nav-accent` 為品牌 stone、`on-nav-accent` 為 navy，在深色側欄與導覽項目間清楚可辨。鍵盤焦點使用相同明亮 token 並有 2px 外框；theme 單元測試驗證文字與焦點／按鈕輪廓對比，Playwright 驗證 Tab → Enter 開抽屜及 Esc 關閉。收入／支出色與其他操作不變。
