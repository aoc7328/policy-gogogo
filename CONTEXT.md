# policy-gogogo — 測試前專案脈絡

## Implementation record — 2026-08-27 現場事故修正（四項）

當日實戰回報的四個問題與處置：

1. **全組到位分出勝負卻不進題目（實為平手死鎖）**：`count.ts`／`allhands.ts` 的
   `lockWinner` 先設 `session.winnerLocked = true` 才呼叫 `noWinner()`，而
   `noWinner()` 開頭的防重入檢查看到旗標直接 return —— 平手／無人按時
   `rush_no_winner` 永遠發不出去、phase 卡在 rushing、三端凍結。全組到位兩隊
   「最佳同步人數」相同即判平手（隊伍人數相近時機率很高），故當日必然踩中。
   修正：`winnerLocked` 只在真的選出勝者時設；speed／lightning 的無效紀錄
   也不再消耗勝負鎖。平手判準維持 CONTEXT 定案（人數相同即平手，不比毫秒）。
2. **搶答進行中沒有任何恢復按鈕**：按鈕矩陣 rushing/won/picking 現在保持左鈕
   可按（藍色「重新搶答」，`doRoundControl` 分流），server 本就接受這三階段的
   `start_rush(rerush:true)`。投影端與參賽者端新增 `rush_no_winner` 顯示
   （平手／逾時／全員淘汰 + 「等待助理重新開始搶答」），不再無聲凍結。
3. **不計分後重新搶答卻跳回已公佈答案的原題**：`rebuzz_same` 改為棄置原題
   （`resume_question` 全面移除，`state.rebuzzPending` 一併移除），答錯隊列入
   失格，勝隊回九宮格抽新題、`roundQ` 不前進 —— 落實本檔「已確認的目標流程」
   第 5 點。主鈕文案改「重新搶答(換新題)」。
4. **缺單次／單輪重置**：新增「重新這一次」（= `start_rush(rerush:true)`，
   server 放寬到 answering/revealed 也接受：棄題、失格保留、立即重搶，棄置題
   在 `askedQuestions` 標 `replaced`）與「重新這一輪」（新指令＋事件
   `round_reset`：清失格名單、棄題、回 idle；分數與題號不變，已計分判定不
   撤銷；投影端 ROUND 不前進）。兩鈕位於助理控制列第三排，均有確認對話框。

驗證：`verify:all` 全綠（含新 `verify:round-controls-ui`、擴充後 13 項的
`verify:round-eligibility`）；本機 Worker 端到端 `verify:roundflow` 24 項
全過（count/allhands 平手、恢復重搶、rebuzz 換新題同回合、answering 棄題、
round_reset 後原失格隊恢復可搶、export 的 replaced 標記）；
`verify:fullgame`、`verify:rushmodes`、`verify:rush-flow` 迴歸皆過。
**尚未部署**：正式環境需重新部署即時 Worker 與 Pages 前端（兩者都有改動）。

## Implementation record — 2026-07-24 follow-up fixes

- **Round accounting:** `currQ` now means completed scored rounds. Drawing or redrawing after a no-score answer keeps the same displayed round and does not consume the configured question allowance. Only the formal 25% / 50% / 100% score action completes a round. Every draw remains in `askedQuestions` for the final report.
- **Post-game settings:** after `ended`, the assistant may change grouping mode or team count for the next game. Either action first sends `game_restart`, returning the room to lobby before applying the setting. Assistant tab order is Settings → Scores → Groups.
- **End-game cleanup:** `export_result` now clears the server timer and broadcasts `timer_update(0)`. Presenter cancels its interval and mutes already-scheduled WebAudio alarm notes. Participant result prompt no longer has an X or backdrop-close path; participants must enter the result report.
- **Production deployments:** Worker `f60dbc0e-40d7-40dc-b937-290739a6e0ec`; Pages deployments included the related frontend changes.
- **Regression checks added:** `verify:round-progress`, `verify:postgame-grouping`, and `verify:end-cleanup`. Related checks passed: `typecheck`, `verify:html`, `verify:dom-refs`, `verify:contract`, `verify:reload`, and `verify:restart`.

> 2026-07-24 分組固定規則：一般／自由分組下，玩家加入後，「重新開始」與「結束本場」均不得重新分組。重開僅清除本場分數、題目與進度，保留組別、成員與組長。裝置對組別的鎖定與房間狀態保存期限皆為 24 小時；前綴分組另依其前綴規則處理。
>
> 分組控制：全員「重新分組」置於分組表，僅「隨機平均」可用；前綴分組時，各組才顯示強制的「通知改名」及非強制的「確認前綴」。伺服器也拒絕非前綴模式的這兩種通知。遊戲開始後，兩種分組方式與重新分組均鎖定。
>
> 九宮格高亮：投影端收到新的分類預覽時，必須清除上一輪殘留的 preview/locked 樣式；否則漏接換題事件或重連後，會同時顯示舊鎖定格與新預覽格。`verify:category-highlight` 覆蓋此情境。

## 實作紀錄：搶答流程調整（2026-07-24）

- 助理控制列現在只保留「開始搶答」、「公布答案」與單一最右側動態主按鈕；已移除一般流程的「跳題」、「同範圍重抽」、獨立「同一題重新搶答」及獨立「重新搶答」。
- 25%／50%／100% 判分後，主按鈕為「下一題」。不計分後，答題隊伍失去本回合資格；至少兩隊仍可答時顯示「同一題重新搶答」，僅剩最後一隊時顯示「進入九宮格」並直接指定該隊作答。
- 失格資格只會在新題，或所有隊伍皆曾實際取得答題權且都被判定不計分後清除；手動重新搶答不會清除失格資格。
- 逾時／無有效勝者新增 `rush_no_winner` 事件，主按鈕改為手動「重新搶答」。
- 新增 `npm run verify:round-eligibility`，驗證動態按鈕、資格保留與無有效勝者回歸條件。
- 無有效勝者時，左側回合控制鈕為藍色「重新搶答」，只重置該次搶答且保留失格資格；右側流程主鈕維持停用。一般 idle 時左側為藍色「開始搶答」。新增 `npm run verify:rush-recovery-ui` 覆蓋此亮燈與文案規則。

## 補充定案：最右側動態按鈕（三態）

在助理端的最下一排，最右側保留為單一、依狀態切換的主要動作按鈕：

1. `下一題`：助理按過任一加分選項（25%、50%、100%）後顯示；按下結束本回合並前進。
2. `同一題重新搶答`：助理按過 `不計分`，且還有至少兩組具資格隊伍時顯示；按下後直接開啟該回合的搶答，不再需要第二次按「開始搶答」。答錯隊伍持續排除；獲勝隊伍再由助理進入九宮格選題。
3. `進入九宮格`：助理按過 `不計分`，且只剩最後一組具資格隊伍時顯示；按下略過搶答，讓最後一組直接取得答題權，助理重新選擇九宮格並抽題。這是同一回合，不是下一題。

設計原則：按鈕名稱描述「按下後會發生什麼」；第二態的「同一題」指同一個未完成回合，而非重用剛才的題目內容。每次重新取得答題權，都由助理重新選九宮格抽題。

另保留「無有效勝者」時的人工恢復入口（全員閃電淘汰、逾時、平手等），它只重置該次搶答，不能解除本回合已答錯隊伍的資格限制。

> 建立日期：2026-07-24
>
> 本文件是開始實測前的基準。它描述目前程式碼與設定所呈現的架構；若文件與可執行程式衝突，以程式碼為準。

## 1. 系統邊界與啟動方式

本專案是保險教育訓練搶答遊戲，包含三個可獨立開啟的瀏覽器角色：

- 助理控場：`public/assistant.html`
- 投影畫面：`public/presenter.html`
- 學員手機端：`public/participant.html`

前端是靜態 HTML/JavaScript，由 Cloudflare Pages 從 `public/` 發佈。每個角色都用 `PartyBus` 連至 Cloudflare Worker 的 Durable Object；房間路徑為 `/parties/main/<room>`。

- 即時 Worker 設定：`worker/wrangler.jsonc`
- 即時伺服器入口：`party/server.ts`
- 本機 Worker：`npm run dev`（預設 port 1999）
- 本機靜態前端：`start-dev.bat` 使用 `serve public -l 3000`
- 用戶端 bundle：`npm run build:client`，將 `client/index.ts` 產生為 `public/lib/partybus.js`
- 型別檢查：`npm run typecheck`

Cloudflare Pages Functions 位於 `functions/api/**`，使用 D1 binding `DB`；它與即時 Worker 是兩個部署單位。`sync-deploy.bat` 會 pull、push 及部署即時 Worker，屬於具外部副作用的操作。

## 2. 角色與核心訓練流程

| 角色 | 入口 | 職責 |
| --- | --- | --- |
| Assistant | `assistant.html` | 建房／控場、遊戲設定、分組、選題、計分、結算 |
| Presenter | `presenter.html` | 大螢幕唯讀呈現題目、搶答、分類與比分 |
| Participant | `participant.html` | 學員入房、改名／隊名、搶答、查看個人與結算資訊 |

典型流程：房間 lobby → 學員加入與分組 → `game_start` → idle → `start_rush` → winner → 分類選擇 → 題目作答 → 揭曉 → 下一題或結束。

搶答模式為 `speed`、`count`、`lightning`、`allhands` 與 `random`；真實模式、計時、勝方與分數均由伺服器判定。

## 3. 權威資料、通訊與持久化

- `party/protocol.ts`：ClientCommand / ServerEvent 的 wire contract。
- `party/state.ts`：房間狀態、階段、隊伍、題目歷程、裝置鎖定、計時與搶答的集中不變條件。
- `party/server.ts`：連線、訊息路由、授權、廣播及 Durable Object state 保存／回復。
- `party/rush/**`：四種實際搶答模式的伺服器判定。
- `client/partybus.ts`：WebSocket、重連、控制碼、事件分派；由 `client/index.ts` 匯出 bundle。

伺服器於連線時私送 `__welcome__` 與 `__room_state__`。Durable Object 的房間狀態以 storage 保存，最大保存年齡為 24 小時。Participant 以 deviceId 防止同裝置多分頁重複加入。

助理命令會附帶 room `controlCode`；`party/protocol.ts` 的 `PRIVILEGED_COMMAND_TYPES` 決定哪些會改變狀態且必須通過該驗證。此機制的註解明示其低威脅模型，目的是防止活動中誤操作，而非對抗惡意使用者。

## 4. 題庫、Pages API 與 D1

題庫資料在 `public/data/`：五個難度 JSON、metadata 與 app config。前端透過 `client/bankloader.ts` 讀取 `/data/`；Worker 的 `party/bank.ts` 將相同 JSON 打進 bundle，以維持出題權威一致。

| API | 用途 | 驗證 |
| --- | --- | --- |
| `POST /api/log` | 學員端連線／錯誤／凍結等體驗遙測 | 輸入欄位驗證 |
| `POST /api/game` | 儲存與更新遊戲結算 | 輸入欄位驗證 |
| `GET /api/report/sessions` | 場次清單 | 目前以 room／limit 查詢 |
| `GET /api/report/game` | 單場結算與連線品質 | 目前以 game key 查詢 |
| `GET /api/admin/*` | 管理總覽、場次、事件 | `ADMIN_KEY` |

D1 的 `games` 保留最近 10 筆完整 payload；較舊的完整 payload 會清除，但 summary 保留。正式 D1 schema／migration 位置尚待確認。

## 5. 高風險與共用修改區

1. `party/protocol.ts`：改動需同步三個頁面、PartyBus、伺服器、驗證腳本。
2. `party/state.ts`、`party/rush/**`、`party/server.ts`：即時狀態機、搶答裁決、計時、重連與持久化。
3. `client/partybus.ts`：變動後需重新產生並檢查 `public/lib/partybus.js`。
4. `party/bank.ts`、`public/data/*`：題庫 schema、分類與前後端挑題一致性。
5. `functions/_shared.ts`、`functions/api/**`：D1 資料生命週期及管理存取邊界。
6. 根目錄與 `public/` 均存在同名 HTML；Pages 部署來源是 `public/`，但副本同步策略尚待確認。

## 6. 測試與回饋迴圈

靜態與契約檢查：

- `npm run typecheck`
- `npm run verify:html`
- `npm run verify:contract`
- `npm run verify:dom-refs`
- `npm run verify:reload`
- `npm run verify:restart`
- `npm run verify:buzzux`
- `npm run audit:check`
- `npm run verify:all`（上述預設整合）

需可連 Worker 的即時驗證腳本包括 `verify-ws-connect.mjs`、`verify-rush-flow.mjs`、`verify-startgame-roster.mjs`、`verify-buzz-integrity.mjs`、`verify-regroup-names.mjs` 等。`testbed.html` 可同時嵌入三角色，`/admin` 與 `/report` 是活動後回饋介面。

## 7. 已確認測試邊界與待釐清事項

已確認：實測以「本機 Worker + 靜態前端」為預設隔離環境；正式 Cloudflare Pages／D1 僅作最終唯讀驗收，避免污染活動資料。

待釐清：

- D1 schema／migration 的來源與本機替代方案。
- 根目錄與 `public/` HTML 副本的同步責任。
- 舊文件中 PartyKit／階段性描述與現行 partyserver Worker 實作的差異。
- 是否需要以受控 staging 驗證 Pages Functions／D1 的寫入路徑。

## 8. 第一輪隔離測試結果（2026-07-24）

已在本機 Worker（`localhost:1999`）與臨時房號完成：

- `npm run verify:all`：通過（型別、HTML 語法、事件契約、DOM 引用、重載回復、助理重開場、搶答 UX、依賴稽核）。
- `verify-ws-connect.mjs`：通過（`__welcome__`、`__room_state__` 握手）。
- `verify-rush-flow.mjs`：通過（從分類畫面 re-rush，以及 game restart 對三角色廣播）。
- `verify-startgame-roster.mjs 127.0.0.1:1999`：通過（改名、重開場後名單保存、speed 搶答）。
- `verify-buzz-integrity.mjs 127.0.0.1:1999`：通過（伺服器身分權威、節流、同名拒絕）。
- `verify-regroup-names.mjs 127.0.0.1:1999`：通過（重新分組名單完整與自訂組名清除）。
- `verify-broadcast-route.mjs`、`verify-bug-fixes.mjs`：通過（assistant → server → presenter 的事件路徑）。

觀測：

- `npm run verify:live` 未能直接使用：其中 `verify-startgame-roster.mjs` 預設為 `127.0.0.1:1998`，而 `npm run dev` 預設為 `1999`；使用明確 `1999` 參數後該測試通過。
- `scan-html-load-errors.mjs` 對 presenter 和 participant 報出缺少 `PGG_ROOM_CODE`。其 JSDOM 測試 URL 未提供 `?room=`，而這兩頁刻意拒絕連入預設房間；此項目前記為測試 harness 與頁面 precondition 的待釐清項，尚未判定為產品缺陷。
- JSDOM/CSS 解析過程可見 `[csstree-match] BREAK after 15000 iterations` 診斷訊息，但相關驗證斷言皆通過；尚未歸類為產品問題。

### 兩隊事件驅動流程賽（2026-07-24）

已於本機 Worker 以臨時房間完成一回合、兩隊各兩位自動化學員的端到端流程。判定依據為 Durable Object 實際廣播事件與各角色收到的訊息，不以截圖或固定等待時間判定遊戲階段。

通過路徑：學員加入與伺服器分組 → `game_start` → `start_rush` → speed `rush_winner` → `score_adjust` / `score_update` → `enter_category` → `category_confirm` / `question_pick` → `reveal_answer` → `next_question` → `export_result`。

驗證：助理、投影、兩隊代表均收到每個應收事件；偽造的學員姓名／隊名未影響勝者身分（伺服器以連線中的 canonical 身分判定）；分數與一題結算資料正確出現在 export payload。

觀測：`next_question` 在最後一題會將房間內部 phase 轉成 `ended`，但不會主動再推送新的 `__room_state__`。因此流程測試以該事件及隨後可收到的 `export_result` 作為可觀測結束證據；此為目前事件契約特性，未判定為缺陷。

### 同題重新搶答分支（2026-07-24）

已通過兩隊同題重搶流程：首輪 speed 勝者進入選題／出題後，助理送出 `rebuzz_same`；伺服器的 `buzz_lockout` 列出首輪勝隊，第二隊在新的 `start_rush` 之後成功勝出。判定器用每一步命令送出前的事件游標，只接受其後的新事件，避免把第一輪 `rush_winner` 誤讀成第二輪結果。

### 其餘搶答模式（2026-07-24）

已在三個獨立本機房間、兩隊各兩位學員的條件下通過：

- `count`：目標隊累積較多有效點擊，收到 `rush_tick`，並在計時結束後以正確 team total 獲勝。
- `lightning`：一位學員在淘汰窗口觸發 `lightning_disqualify`，對手隊在合法窗口獲勝。
- `allhands`：同隊兩位學員在同步窗口內按下，`allhands_progress` 顯示 best cluster，該隊以至少兩人的 cluster 獲勝。

### 助理端題目控制鈕盤點（2026-07-24）

在本機真實助理頁面確認：idle 時只有「開始搶答」可用；按下後進入 rushing，開始鈕鎖住且「重新搶答」啟用。再以獨立本機房間驗證相關伺服器事件：

- `同範圍重抽`（`redraw_question`）：僅 answering 階段；抽取同分類的新題，`roundQ` 不變、題目 id 改變。
- `跳題`（`skip_question`）：answering 或 revealed 階段；清除當前題，回到 idle，並清除本題失格名單。
- `公佈答案`（`reveal_answer`）：僅 answering 階段；進入 revealed。
- `下一題`（`next_question`）：answering 或 revealed 階段；清除當前題並回 idle（最後一題會再轉 ended）。
- `同一題重新搶答`（`rebuzz_same`）：answering 或 revealed 階段；保留同一題、將目前答題隊加入本題失格名單、重開搶答。

UI 矩陣的特殊行為：一般 revealed 狀態中上述題目控制鈕皆鎖住；但助理端的 `afterScore()` 不論「加分」或「不計分」，都同時手動解鎖「下一題」和「同一題重新搶答」。這使「不計分後仍可直接下一題」成為目前實際可走的路徑，屬於後續流程設計討論的核心證據。

依使用者定義補測：一般 `重新搶答` 會清除前一輪的勝者／失格限制；同一位剛搶到的人可在新一輪再次搶到，符合「所有人重新參與」的語意。相對地，`同範圍重抽` 在 `reveal_answer` 後會收到 `wrong_phase`，目前只能在 answering（尚未公佈答案）階段使用，不能處理「公佈答案後確認全場不會、改抽同分類新題」的情境。

### 已確認的目標流程（待使用者授權實作）

目標將「題號」定義為尚未完成的競賽回合，而非固定的一題題目。助理一律操作九宮格；搶到答題權的隊伍以現場口頭方式選題／作答，不新增學員端分類選擇。

1. 助理按「開始搶答」；勝隊由助理選九宮格並抽題。
2. 助理一律先按「公佈答案」。
3. 任一 25%／50%／100% 加分代表本回合完成；最右側動態鈕為「下一題」。
4. 按「不計分」代表該答題隊本回合答錯；題號不前進，該隊加入本回合失格名單，原題與分類結束。
5. 最右側動態鈕改為「重新搶答」；按下後由剩餘隊伍搶答，勝隊重新選九宮格並抽題。
6. 若所有隊伍都已答錯，清空本回合失格名單，讓所有隊伍重新搶答；回合持續至有隊答對。

目標主控制列只保留「開始搶答」、「公佈答案」與最右側動態鈕。現有的「重新搶答」（搶答中重開）、「同一題重新搶答」、「跳題」與「同範圍重抽」將不再屬於主流程。

補充的人工恢復規則：當一輪搶答沒有有效勝者時，助理可手動按「重新搶答」；適用於閃電一按全員淘汰、電光石火無人有效搶答、狂點奪魁完全無有效點擊或平手、全組到位無有效成果或平手。這種重新搶答只重置「這一次搶答」的計時、點擊、平手或個人淘汰結果；先前曾答錯而被排除的隊伍仍不可參加。

只有每一隊都曾實際取得答題權，且助理都按過「不計分」時，才清除本回合的答錯隊伍限制，讓全員再次搶答。平手、無人按鈕與閃電一按全員淘汰均不算隊伍答錯。
