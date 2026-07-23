# 交接與審查文件（policy-gogogo）

> **產生日期**：2026-07-02
> **用途**：這份文件寫給「接手審查的新 Claude Code 對話串」。它記錄了上一個（很長的）對話串對本專案做的所有變更，並對**最後兩輪**（統一登入、網址與命名改版）做較詳細的說明，方便你獨立審查、驗證、找出潛在問題。
> **語言慣例**：對話請用繁體中文；程式碼／技術名詞保留原文。

---

## 0. 先讀這段（最重要的背景）

- **前端**（`public/`）：部署在 Cloudflare Pages，push 到 GitHub `master` 就會自動部署。
- **後端**（`party/`，PartyKit DurableObject）：**必須手動跑 `sync-deploy.bat`** 才會生效。本助理**無權**自行執行正式部署（會被權限管控擋下），所以每次動到 `party/` 的變更，是否已上線都取決於使用者有沒有跑 `sync-deploy.bat`。**審查時請先向使用者確認後端最新 commit（`b514ddd`）是否已部署。**
- **WebSocket 角色字串**（`'presenter'` / `'participant'` / `'assistant'`）與**三個 HTML 的實體檔名**（`presenter.html` / `participant.html` / `assistant.html`）**刻意保留未改**——它們是內部識別、被驗證腳本與通訊協定硬編碼引用，改了對使用者零可見差異卻高風險。使用者看到的網址已經是 `/pj`、`/ass`、`/gamer`（見第 2 節）。
- **驗證腳本**：`npm run verify:all`（typecheck + HTML 語法 + 事件契約 + DOM 參照 + npm audit）。
  - 已知**非問題**（既有 baseline，與本輪無關，不要當成 regression）：
    - `verify:dom-refs` 會報 2 筆：`presenter.html` 的 `snd-hint`、`participant.html` 的 `pgg-notice-veil`（皆為 runtime 動態建立 / 防呆守衛）。
    - `audit:check` 會報 `ws`（high）——dev-only、已知可接受。
    - `scan-html-load-errors` 會報 `PGG_ROOM_CODE missing`——jsdom 無 `?room=` 時的預期防呆行為。
- 開發過程用 jsdom 寫過多支 smoke test，但放在 session 暫存目錄、**未進版控**，新 session 看不到。可信賴的是 repo 內建的 `npm run verify:*` 與下方各節的「手動驗證」步驟。

---

## 1. 全對話串變更總覽（由舊到新）

| # | Commit | 主題 | 動到後端? | 需 `sync-deploy.bat`? |
|---|--------|------|:--------:|:--------------------:|
| 1 | `ce90dcc` | 部分給分(25/50/100/不計分)、手機詳解、選題九宮格鏡射、投影縮放、防雙擊放大 | 否 | 否 |
| 2 | `c8b5a4f` | 投影延遲修復(心跳+看門狗)、新手引導初版、賽後回顧保存 | **是** | 是 |
| 3 | `d15634a` | 三端 Screen Wake Lock（防螢幕熄滅） | 否 | 否 |
| 4 | `45f6ba8` | 聚光燈式新手導覽（重做）、**server 遊戲狀態持久化** | **是** | 是 |
| 5 | `4cead52` | 修「選題中改搶答模式蓋掉參賽者九宮格」 | 否 | 否 |
| 6 | `3656b01` | **揭曉後可同一題重新搶答** + 助理端「題目」分頁(主持人判定用) | **是** | 是 |
| 7 | `b514ddd` | **參賽者端統一「投影或助理登入」+ 助理端控制碼**（倒數第 2 輪） | **是** | 是 |
| 8 | `6e111ca` | **短網址 /pj /gamer /ass + 投影端/遊戲者命名改版**（倒數第 1 輪） | 否 | 否 |

> 動到後端的 commit：#2、#4、#6、#7。**#8 純前端。**

各主題的一句話說明：

- **部分給分**：公佈答案後計分鈕從「加分/不計分」改為 `+25% / +50% / +100% / 不計分`（依每題分數四捨五入）。
- **手機詳解**：參賽者端公佈答案時，申論題補「參考範文」、計算題補「解題步驟」（原本只有重點+答案）。
- **九宮格鏡射**：選題階段參賽者手機唯讀顯示 F1–F9，助理預覽時同步高亮。
- **投影縮放**：投影端右下角 +/−/填滿/重設（`localStorage`）。
- **防雙擊放大**：`touch-action: manipulation` + viewport `maximum-scale=1`。
- **投影延遲修復**：見第 4 節「更早幾輪重點」。
- **Wake Lock**：三端遊戲中防螢幕自動熄滅（`navigator.wakeLock`）。
- **狀態持久化**：見第 4 節。
- **同一題重新搶答**：見第 4 節。

---

## 2. 【倒數第 1 輪】短網址 /pj /gamer /ass + 命名改版（`6e111ca`，純前端）

### 需求
1. 投影端（原「主持人端」）：中文 主持人端→**投影端**、英文 Presenter→**Projector**、網址→**/pj**。
2. 遊戲者端（原「參賽者端」）：中文不變、英文 Participant→**Gamer**、網址→**/gamer**。
3. 助理端：名稱不變、網址→**/ass**。

### 實作方式
- **`public/_redirects`**（Cloudflare Pages）：
  ```
  /pj      /presenter.html    200
  /gamer   /participant.html  200
  /ass     /assistant.html    200
  /r/:code /gamer?room=:code  302
  ```
  `200` = rewrite（網址列保留 `/pj` 等短路徑，內容取自實體檔）；`/r/<房號>` 加入短連結改導向 `/gamer`。**舊網址 `/presenter.html` 等仍可直接開**（實體檔還在）。
- **導航**：`participant.html` 統一登入成功後，導向改為絕對短路徑 `/pj?...&controlCode=...`、`/ass?...`（原本是 `presenter.html` / `assistant.html`）。
- **命名（僅改使用者可見字串）**：
  - `presenter.html`：`<title>`、品牌列、斷線標題、登入提示的「主持人端」→「投影端」。
  - `assistant.html`：可見字串「主持人介面/主持人」在指涉投影端處→「投影端」（QR 按鈕、`搶答進行中…投影端倒數中`、重置狀態/確認框）。
  - `participant.html`：登入畫面英文 `Participant · 參與者`→`Gamer · 參與者`（**中文「參與者」不動**；其餘「主持人」指的是主持的「人」，依需求保留）。
- **文件**：`scripts/bank-uploader.mjs` 網址→`/ass`；`讀我.txt` 補三端短網址對照；`助理介面網址.txt`→`/ass`。

### 審查重點 / 潛在風險
- ⚠️ **最需人工在正式站驗證的部分**：`_redirects` 的行為只能在 Cloudflare 上驗（本機無法測）。要確認：
  1. `/pj`、`/gamer`、`/ass` 直接開得起來、且**網址列維持短路徑**；
  2. `/r/<房號>` → `/gamer?room=...` → 正常載入且帶到 room；
  3. **靜態資源路徑**：三個 HTML 都以**相對路徑**引入 `lib/partybus.js`（`<script src="lib/partybus.js">`）。在無尾斜線的 `/pj` 下，相對 base 是 `/`，會解析成 `/lib/partybus.js`（正確）。若 Cloudflare 對 rewrite 有加尾斜線行為，需再確認資源不會 404。
- `assistant.html` / `presenter.html` 在 `/ass`、`/pj` 開啟且無 `?room=` 時會自動產房號並 `history.replaceState(pathname + '?room=...')`，pathname 會是 `/ass`、`/pj`（短路徑保留，正常）。
- 投影端頁面目前畫面上**沒有對外英文字樣**，所以「Projector」主要體現在網址與文件；若要畫面上出現 Projector 字樣需另加（尚未做）。

---

## 3. 【倒數第 2 輪】統一「投影或助理登入」+ 助理端控制碼（`b514ddd`，動到後端）

### 需求
參賽者端右下角原「主持人登入」→改為「**投影或助理登入**」，並依輸入的控制碼路由：投影碼→投影端；助理碼→助理端。第二、三位助理都從這個入口進。

### 認證架構（審查重點所在）
- **兩組獨立控制碼**（`party/state.ts`）：
  - `controlCode` = **投影端控制碼**（沿用舊欄位名）；同時仍是**特權指令簽章**用的碼（助理端連上以 `role=assistant` 經 `__welcome__` 取得，未變）。
  - `assistantCode` = **新增的助理端控制碼**（純登入路由用）。
  - 兩碼都在建房時 `generateControlCode()` 產生，並**納入持久化**（`dehydrateState`/`hydrateState`；舊存檔無 `assistantCode` 時保留新產生的那組，避免 `undefined`）。
- **新指令 `staff_login { code }`**（`party/protocol.ts` + `server.ts` `onStaffLogin`，**非特權**，碼本身即憑證）：
  - `code === controlCode` → 設 `presenterClaimed`、廣播 `presenter_claimed`、私訊 `__staff_route__ { dest:'presenter', controlCode }`。
  - `code === assistantCode` → 私訊 `__staff_route__ { dest:'assistant' }`。
  - 皆不符 → `__error__ bad_code`。
- **參賽者端**（`participant.html`）：`submitHostLogin` 改 emit `staff_login`；新增 `PartyBus.on('__staff_route__')` 依 `dest` 導向 `/pj`（帶 `controlCode`）或 `/ass`。舊 `claim_presenter` 保留在協定與 dispatch（相容），但參賽者端不再 emit。
- **助理端房間分頁**（`assistant.html`）：「主持人控制碼」→「**投影端控制碼**」，新增「**助理端控制碼**」欄位（`__welcome__` 帶 `assistantCode`）；**移除**了原本只改本機顯示、會與 server 脫鉤的 `regenHost` 按鈕（要換碼→重新生成房號）。

### 審查重點 / 潛在風險
- `controlCode` 現在**跨重啟穩定**（因狀態持久化）——這是刻意的（活動中登入碼不該變）。確認 `hydrateState` 對兩碼都正確還原。
- 參賽者 → `/ass` 導航後，原 participant WS 連線會關閉（正常，可留意 roster/進退場紀錄有無雜訊）。
- 事件契約：`staff_login` 為新 client 指令（有 dispatch case）、`__staff_route__` 為 `__` 私訊事件（契約檢查略過 `__`）。`npm run verify:contract` 應全綠。
- 安全模型仍是「低威脅」（見 `party/auth.ts` 註解）：助理端本來就是任何人開 `assistant.html` 即取得特權——`assistantCode` 是**路由閘門與防誤操作**（投影人員只拿投影碼就進不了計分控制），非硬性安全邊界。

---

## 4. 更早幾輪的重點（審查者需要的上下文）

這些較早，但**同樣動到後端且尚屬近期**，一併列出關鍵機制：

### 4.1 揭曉後可同一題重新搶答 + 助理「題目」分頁（`3656b01`，後端）
- **流程**：計分（尤其「不計分」）後，「同一題重新搶答」與「下一題」同時解鎖；`server.ts onRebuzzSame` 放行 `revealed` 階段（原本只 `answering`）。
- **修既有 bug**：`participant.html` 的 `resume_question` 未復原 `G.currentQ`（`start_rush` 會清成 null），導致重搶後**第二次公佈答案參賽者手機看不到答案**——已補回。
- **助理「題目」分頁 `pg-qa`**：抽題當下同步顯示題目+完整答案（選項標正解／評分要點／範文／解題步驟／最終答案），手機優先排版；第二位助理可開 **`/ass#qa`** 全程停在此頁判定答案。`renderQaView()` 在 question_pick / 下一題 / 跳題 / 重抽 / 重新開始 / 快照還原時都會刷新。

### 4.2 投影延遲修復（`c8b5a4f`，後端）
- **根因**：投影端 WebSocket「半死」（TCP 斷但瀏覽器沒收到 close）→ 漏接 `category_confirm` / `question_pick` → 約 30 秒後瀏覽器才發現重連、靠快照補畫面。
- **對策**：`client/partybus.ts` keepalive——閒置 8s 送 `ping`、25s 全無訊息強制 `reconnect()`；用 `_pongCapable` 閘門（收過 `__pong__` 才啟用強制重連，避免後端未部署時的重連風暴）。`server.ts` 對 `ping` 回私訊 `__pong__`。`presenter.html` 另加看門狗：`question_pick` 後 2s 未進題目頁就強制 `selectCategory()`。
- 註：`public/lib/partybus.js` 是 `client/*.ts` 經 `npm run build:client`（esbuild）打包產物，**已進版控**。改 `client/` 後要重跑 build。

### 4.3 Server 狀態持久化（`45f6ba8`，後端）
- **根因**：中場 `partykit deploy`（或 DO 回收）把記憶體狀態歸零 → 後續指令撞「不能在 lobby 階段送」（`start_rush lobby` 錯誤）。
- **對策**：核心狀態存 room storage（`STATE_STORAGE_KEY`），`onStart` 還原；每次 dispatch 後 `schedulePersist()`（1 秒 coalesce）。不存 `rushSession`（timer 已死，`rushing`→退回 `idle`）與 `participants`（重連重建）；過期 `timerDeadline` 清空；存檔 >24h 不還原。

### 4.4 聚光燈式新手導覽（`45f6ba8`）
- `participant.html`：全螢幕遮罩挖洞框住實際按鈕（名字組別/QR/戰況/題目區/搶答鈕），一頁一重點；`localStorage['pgg_onboard_seen_v1']` 記「看過」。**注意**：`強制重整` 不清此旗標；要重看首次導覽需清 `pgg_*`（testbed 的「完全重置」或手動刪 key）。首次進入自動跳，右上「?」可重看。

---

## 5. 建議審查者的檢查清單

- [ ] `npm run verify:all` 全綠（扣除第 0 節列的 3 項已知 baseline）。
- [ ] `git log --oneline -8` 對照第 1 節表格，確認 working tree 乾淨。
- [ ] **向使用者確認**：後端最新（`b514ddd`）是否已 `sync-deploy.bat` 部署？前端（`6e111ca`）Cloudflare 是否已生效？
- [ ] 正式站手動測短網址（第 2 節「審查重點」三點）。
- [ ] 統一登入：投影碼→`/pj`、助理碼→`/ass`、錯碼→提示錯誤；助理房間分頁兩碼都顯示得出來。
- [ ] 揭曉後「同一題重新搶答」全流程：搶答→公佈→不計分→重新搶答→他組搶到→再公佈→**參賽者手機看得到答案**。
- [ ] `/ass#qa` 第二位助理分頁：抽題即顯示題目+答案，換題同步。
- [ ] 投影端半死連線自救、Wake Lock 生效（console 有 `Wake Lock 已啟用`）。
- [ ] 兩碼持久化：中場重啟（或重跑 sync-deploy）後，登入碼與分數/進度不變。

## 6. 檔案地圖（快速定位）

- `party/server.ts` — DO 進入點、指令 dispatch、所有 handler、`onStart`/`schedulePersist`。
- `party/state.ts` — `RoomState`、`createInitialState`、`dehydrateState`/`hydrateState`、兩控制碼。
- `party/protocol.ts` — `ClientCommand` / `ServerEvent` 型別聯集（契約來源）。
- `client/partybus.ts` → build 成 `public/lib/partybus.js` — WS 連線、keepalive。
- `public/assistant.html` — 助理端（計分/流程/房間/題目分頁 pg-qa）。
- `public/presenter.html` — 投影端（純顯示 + 縮放）。
- `public/participant.html` — 遊戲者端（搶答/登入/導覽/賽後回顧）。
- `public/_redirects` — Cloudflare 短網址規則。
- `EVENTS.md` — 事件協定文件（較舊，未必逐條同步最新；以 `protocol.ts` 為準）。

---

*本檔為交接筆記，未進版控。若要讓未來 clone 的環境也看得到，可自行 `git add REVIEW-HANDOFF.md`。*
