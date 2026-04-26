# PartyBus Event Contract (extracted from current demo)

> **Phase 0 產出文件**
> 來源：`assistant.html` / `presenter.html` / `participant.html` / `testbed.html`
> 用途：作為 Phase 2 PartyKit server 實作的權威規格書。
> 任何欄位、authority 分類、模式邏輯有疑慮，先回到此文件對齊，再寫 server。

## Glossary

- **Assistant** (助理): Host-side control panel; holds authoritative game state, arbitrates round winners, manages categories, controls game flow. File: `assistant.html`
- **Presenter** (主持人): Display-only big-screen for the room; renders questions, shows rush sequences, displays scores and category grids. File: `presenter.html`
- **Participant** (參賽者): Phone-side player UI; shows questions, emits buzz presses, displays scores and team name. File: `participant.html`
- **Rush session**: Active period during which a single round's "answer mode" (speed/count/lightning/allhands/random) is running
- **Round**: One complete question cycle (1 question + reveal + next)
- **Answer mode** / **Rush mode**: One of `speed`, `count`, `lightning`, `allhands`, `random`
  - **speed** (電光石火): First team to buzz after armed wins immediately
  - **count** (狂點奪魁): 5-second tapping race; team with most taps wins
  - **lightning** (閃電一按): 0–3s window: taps disqualify player; ≥3s: first tap wins
  - **allhands** (全組到位): 8 seconds to achieve largest "0.5s sync cluster" (most players pressing within 500ms window)
  - **random** (隨機): System picks one of the four above at the start of each rush; revealed for 5s before countdown
- **Category** / **Framework** (分類): 9 difficulty/topic pairs (F1–F9); system picks questions from selected category
- **Purgatory** (煉獄): Special game state triggered either manually (assistant presses "確定煉獄" button) or probabilistically (when difficulty pool includes "purgatory" tier and a question is drawn from it)

---

## Event Catalog

### Events Emitted by ASSISTANT

#### `__ping__`
- **Payload:** `{ from: 'assistant', msg: string, t: string }`
- **Receivers:** presenter, participant
- **Purpose:** Diagnostic ping for testing PartyBus connectivity; recipients log to console.
- **Authority:** CLIENT-LOCAL — diagnostic only
- **Code ref:** assistant.html:1238

#### `game_start`
- **Payload:** `{ mode: 'ordinary'|'hell'|'paradise'|'custom', customTiers: string[], customTypes: string[], totalQ: number, spq: number, groups: [{name: string}], rushMode: string }`
- **Receivers:** presenter, participant
- **Purpose:** Assistant pressed "開始遊戲" button; initializes game state on all clients (locks group names, resets question counters, broadcasts team roster).
- **Authority:** AUTHORITATIVE — server must produce this after validating game config
- **Code ref:** assistant.html:1989–1997

#### `presenter_show_qr`
- **Payload:** `{ durationMs: number }`
- **Receivers:** presenter
- **Purpose:** Assistant clicked "在主持人介面顯示 QR Code"; triggers 60-second QR display on presenter screen.
- **Authority:** AUTHORITATIVE — server should rate-limit (e.g., once per 60s) to prevent spam
- **Code ref:** assistant.html:1712

#### `mode_preview`
- **Payload:** `{ mode: 'ordinary'|'hell'|'paradise'|'custom', customTiers?: string[], customTypes?: string[] }`
- **Receivers:** presenter, participant
- **Purpose:** Assistant switched game mode on settings tab; clients update theme accent color and custom tier UI immediately (before game starts).
- **Authority:** AUTHORITATIVE — server should broadcast on mode change
- **Code ref:** assistant.html:1769–1774

#### `custom_tiers_changed`
- **Payload:** `{ customTiers: string[], customTypes: string[] }`
- **Receivers:** presenter
- **Purpose:** Assistant toggled a difficulty tier or question type chip in "custom" mode; presenter syncs chip active states.
- **Authority:** AUTHORITATIVE — server should broadcast custom pool changes
- **Code ref:** assistant.html:1797–1800

#### `rush_mode_changed`
- **Payload:** `{ mode: 'speed'|'count'|'lightning'|'allhands'|'random', label: string }`
- **Receivers:** presenter, participant
- **Purpose:** Assistant switched rush mode card (e.g., from "電光石火" to "狂點奪魁"); affects next rush_reveal or start_rush event.
- **Authority:** AUTHORITATIVE — server should broadcast on mode change
- **Code ref:** assistant.html:1829–1832

#### `score_update`
- **Payload:** `{ scores: [{idx: number, name: string, score: number}], changedIdx: number, delta: number }`
- **Receivers:** presenter, participant
- **Purpose:** Assistant manually adjusted a team's score (via +/– buttons or via team_rename side-effect); clients update score bars and rankings.
- **Authority:** AUTHORITATIVE — server produces this after score change
- **Code ref:** assistant.html:1322–1326, 1999–2003, 2783–2787

#### `start_rush`
- **Payload:** `{ rushMode: 'speed'|'count'|'lightning'|'allhands', rerush?: boolean }`
- **Receivers:** presenter, participant
- **Purpose:** Assistant clicked "開始搶答" or "重新搶答"; triggers 3-second countdown (321) on all clients + arms buzz detection.
- **Authority:** AUTHORITATIVE — server must transition state to "rushing"
- **Code ref:** assistant.html:2080, 2098

#### `rush_reveal`
- **Payload:** `{ rushMode: 'speed'|'count'|'lightning'|'allhands', revealMs: number, rerush?: boolean }`
- **Receivers:** presenter, participant
- **Purpose:** Random mode only: reveals actual rush mode for 5 seconds before start_rush countdown begins.
- **Authority:** AUTHORITATIVE — server must emit this only for random mode
- **Code ref:** assistant.html:2089–2093

#### `rush_tick`
- **Payload:** `{ mode: 'count', teamCounts: [{idx: number, name: string, count: number}], remainingMs: number }` (count-mode-specific)
- **Receivers:** presenter, participant
- **Purpose:** During 5-second "count" mode: emitted every 100ms with updated tap counts per team and remaining time; clients render live progress bars.
- **Authority:** AUTHORITATIVE — server must compute tap counts authoritatively; clients must not trust local counts
- **Code ref:** assistant.html:2197–2215

#### `rush_winner`
- **Payload:** Variant by mode:
  - **speed:** `{ groupIdx: number, groupName: string, rushMode: 'speed', personName: string, elapsedMs: number }`
  - **lightning:** `{ groupIdx: number, groupName: string, rushMode: 'lightning', personName: string, pressedAtSec: number }`
  - **count:** `{ groupIdx: number, groupName: string, rushMode: 'count', personName: string, teamTotalClicks: number, mvpClicks: number, runnerUp?: {name: string, count: number} }`
  - **allhands:** `{ groupIdx: number, groupName: string, rushMode: 'allhands', clusterCount: number, totalCount: number, endAtSec: number }`
- **Receivers:** presenter, participant
- **Purpose:** Rush session ended (timer, fallback, or all players pressed); displays winner card with mode-specific stats (time, person, counts, cluster size).
- **Authority:** AUTHORITATIVE — server must determine winner by rush mode logic
- **Code ref:** assistant.html:2465–2469

#### `lightning_disqualify`
- **Payload:** `{ name: string, team: string, teamIdx: number, elapsedMs: number }`
- **Receivers:** presenter, participant
- **Purpose:** During lightning mode 0–3s window: a player pressed buzz and was disqualified; clients show brief "X太快了·已淘汰" notification.
- **Authority:** AUTHORITATIVE — server must determine disqualification logic
- **Code ref:** assistant.html:1410–1415

#### `allhands_progress`
- **Payload:** `{ teamProgress: [{idx: number, name: string, currentCluster: number, bestCluster: number, total: number}], remainingMs: number }`
- **Receivers:** presenter, participant
- **Purpose:** During 8-second allhands mode: emitted every 100ms with sliding-window cluster counts and best cluster achieved so far per team.
- **Authority:** AUTHORITATIVE — server must compute clusters authoritatively
- **Code ref:** assistant.html:2304–2326

#### `enter_category`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** Winner card displayed for 3.5s; now transition to category selection screen (九宮格).
- **Authority:** AUTHORITATIVE — triggers UI transition
- **Code ref:** assistant.html:2474–2475

#### `category_preview`
- **Payload:** `{ fid: string }` (e.g., 'F1', 'F2', ..., 'F9')
- **Receivers:** presenter
- **Purpose:** Assistant hovered/previewed a category button on the 九宮格; presenter highlights that category softly (breathing glow).
- **Authority:** CLIENT-LOCAL — visual hint only; no server-side effect
- **Code ref:** assistant.html:2850

#### `category_confirm`
- **Payload:** `{ fid: string }`
- **Receivers:** presenter
- **Purpose:** Assistant locked a category by clicking "確定"; presenter plays strong flash animation and locks the grid.
- **Authority:** AUTHORITATIVE — server must confirm category is locked
- **Code ref:** assistant.html:2928

#### `category_reset`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** After revealing answer and pressing "下一題", game resets to idle state (awaiting next rush); clears category selection and question display.
- **Authority:** AUTHORITATIVE — signals next round ready
- **Code ref:** assistant.html:2973

#### `question_pick`
- **Payload:** `{ id: string, difficulty: 'easy'|'medium'|'hard'|'hell'|'purgatory', framework: string }`
- **Receivers:** presenter, participant
- **Purpose:** Question drawn from selected category; clients fetch question from BANK cache and prepare for display.
- **Authority:** AUTHORITATIVE — server picks question from difficulty pool
- **Code ref:** assistant.html:2666–2670, 2880–2884, 2933–2937

#### `purgatory_summon`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** Purgatory triggered (either manually armed or probabilistic draw); triggers special visual effects (flame border, badge, countdown).
- **Authority:** AUTHORITATIVE — server decides purgatory state
- **Code ref:** assistant.html:2879–2880, 2930–2931

#### `purgatory_end`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** Purgatory effects finish; return to normal question display.
- **Authority:** AUTHORITATIVE — server-side timing
- **Code ref:** (implicitly emitted; handler in participant.html:2840)

#### `reveal_answer`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** Assistant clicked "公佈答案"; shows full answer and explanation to all clients.
- **Authority:** AUTHORITATIVE — server gates reveal to appropriate phase
- **Code ref:** assistant.html:2590

#### `next_question`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** Assistant clicked "下一題"; increment round counter, clear current question, return to "等待搶答" state.
- **Authority:** AUTHORITATIVE — server increments question number
- **Code ref:** assistant.html:2626

#### `skip_question`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** Assistant skipped the current question (same effect as next_question); round counter does NOT increment.
- **Authority:** AUTHORITATIVE — server tracks skip vs. next
- **Code ref:** assistant.html:2644

#### `game_restart`
- **Payload:** `{}` (empty)
- **Receivers:** presenter, participant
- **Purpose:** Assistant clicked "重新開始" and confirmed; all clients return to initial state (clear scores, clear question progress, unlock team names, return to mode selection or login).
- **Authority:** AUTHORITATIVE — server resets session
- **Code ref:** assistant.html:3044

#### `export_result`
- **Payload:** `{ mode: string, modeLabel: string, totalQ: number, spq: number, actualQ: number, groups: [{name: string, score: number, members: string[]}], sortedGroups: [{name: string, score: number}], askedQuestions: [...], exportTime: string }`
- **Receivers:** participant
- **Purpose:** Assistant clicked "匯出結果"; participant shows modal offering to view results, then displays end-game leaderboard and team stats.
- **Authority:** AUTHORITATIVE — server compiles final results
- **Code ref:** assistant.html:3111–3128

#### `team_rename`
- **Payload:** `{ oldName: string, newName: string, by?: string }`
- **Receivers:** participant (as broadcast back to all; assistant sends to itself too)
- **Purpose:** A participant (or assistant editing input) changed their team name; all clients update team references.
- **Authority:** AUTHORITATIVE — server validates rename (8-char limit, no duplicates if enforced) and broadcasts
- **Code ref:** assistant.html:1936–1938

---

### Events Emitted by PRESENTER

#### `__ping__`
- **Payload:** `{ from: 'presenter', msg: string, t: string }`
- **Receivers:** assistant, participant
- **Purpose:** Diagnostic ping for testing connectivity.
- **Authority:** CLIENT-LOCAL — diagnostic only
- **Code ref:** presenter.html:1416

> **Note:** Presenter is mostly read-only; it does not emit game-changing events. Only `__ping__` is emitted.

---

### Events Emitted by PARTICIPANT

#### `__ping__`
- **Payload:** `{ from: 'participant', msg: string, t: string }`
- **Receivers:** assistant, presenter
- **Purpose:** Diagnostic ping for testing connectivity.
- **Authority:** CLIENT-LOCAL — diagnostic only
- **Code ref:** participant.html:2282

#### `player_join`
- **Payload:** `{ name: string, team: string }`
- **Receivers:** assistant
- **Purpose:** Participant entered their name and team on login screen; assistant adds them to the team roster and logs the join event.
- **Authority:** AUTHORITATIVE — server must validate name/team and record join
- **Code ref:** participant.html:1371–1374

#### `buzz_press`
- **Payload:** `{ name: string, team: string, ts: number }`
- **Receivers:** assistant
- **Purpose:** Participant pressed the search/buzz button during rush mode; assistant applies rush-mode-specific logic (speed: first wins; count: increment counter; lightning: check elapsed time; allhands: compute cluster).
- **Authority:** AUTHORITATIVE — server must validate timing and rule set
- **Code ref:** participant.html:1564–1568, 1580–1584, 1626–1630, 1677–1681

#### `team_rename`
- **Payload:** `{ oldName: string, newName: string, by: string }`
- **Receivers:** assistant
- **Purpose:** Participant edited their team name in the lobby or top bar; assistant updates all references and broadcasts team_rename back to all clients.
- **Authority:** AUTHORITATIVE — server must validate, deduplicate, and broadcast
- **Code ref:** participant.html:1906–1910, 1982–1986

---

## Five Answer Modes — Authoritative Logic

### Mode: speed (電光石火)

**Trigger event:** `start_rush` with `rushMode: 'speed'`

**Win condition:** First team to emit `buzz_press` after armed time (armedAt + 3000ms) wins immediately.

**End condition:** `_lockRushWinner()` called → rush_winner emitted.

**State held (assistant):**
- `S.rushSession.mode = 'speed'`
- `S.rushSession.armedAt = Date.now() + 3000`
- `S.rushSession.clicks = [{name, team, teamIdx, ts}, ...]` — tracks all buzz presses
- `S.rushSession.winnerLocked` — prevents double-winning

**Fallback:** If no one presses within 8 seconds of armed time, `_scheduleRushFallback()` randomly selects a winner.

**Code ref:** assistant.html:2148–2150 (logic), 1396–1399 (buzz_press handler), 2173–2180 (fallback)

**Details:**
- Participants press once per round; subsequent presses ignored.
- Winner details: personName (first presser), elapsedMs (press time - armed time).
- rush_winner payload includes `elapsedMs`.

---

### Mode: count (狂點奪魁)

**Trigger event:** `start_rush` with `rushMode: 'count'`

**Rush sequence:**
1. Armed for 3 seconds (filler period).
2. At armed + 3s, `_runCountSession()` starts 5-second counter.
3. Every 100ms: `rush_tick` emitted with `{ mode: 'count', teamCounts: [...], remainingMs }`.
4. Every buzz_press increments `S.rushSession.teamCounts[teamIdx]` (no lock).
5. After 5 seconds: team with highest count wins.

**Win condition:** Team with most accumulated button presses in 5-second window.

**End condition:** 5-second timer expires; `_lockRushWinner()` finds max and emits rush_winner.

**State held (assistant):**
- `S.rushSession.mode = 'count'`
- `S.rushSession.teamCounts = {0: 42, 1: 58, ...}` — tap count per team index
- Participants can tap unlimited times (no per-person lock, but server should throttle if desired)

**Code ref:** assistant.html:1421–1423 (buzz_press handler), 2192–2230 (_runCountSession), 2232–2248 (_mockCountClicksForOtherTeams)

**Details:**
- rush_tick emitted at 100ms intervals with current counts.
- If teams tied at 5s, current code falls back to index-order (first team in loop wins). See open question #1.
- DEMO includes fake team clicks; production server must track real clicks per team.

---

### Mode: lightning (閃電一按)

**Trigger event:** `start_rush` with `rushMode: 'lightning'`

**Rush sequence:**
1. Armed for 3 seconds.
2. At armed + 3s: **disqualification window opens** (0–3000ms from armed).
   - Any buzz_press in window: player added to `S.rushSession.disqualified[teamIdx]`; `lightning_disqualify` emitted.
   - Disqualified player cannot press again.
3. After 3000ms from armed: **valid window opens**.
   - First buzz_press: that team wins immediately; `_lockRushWinner()` called.
4. Fallback: if no valid press by armed + 11s, random winner.

**Win condition:** First team to press ≥ 3.5s after armed (first valid presser).

**End condition:** `_lockRushWinner()` emitted; rush_winner includes `pressedAtSec`.

**State held (assistant):**
- `S.rushSession.mode = 'lightning'`
- `S.rushSession.disqualified = {0: Set<name>, 1: Set<name>, ...}` — tracks disqualified players per team
- `S.rushSession.clicks = [{name, team, teamIdx, ts}, ...]` — valid presses only

**Code ref:** assistant.html:1400–1420 (buzz_press handler), 2151–2155 (armed logic), 2387–2427 (_mockLightningClicksForOtherTeams)

**Details:**
- Participants receive `lightning_disqualify` event immediately; update UI with "太快了·已淘汰".
- rush_winner payload includes `pressedAtSec` (seconds from armed to first valid press).
- Fallback time: 11s (3s arm + 3s disq window + 5s buffer).

---

### Mode: allhands (全組到位)

**Trigger event:** `start_rush` with `rushMode: 'allhands'`

**Rush sequence:**
1. Armed for 3 seconds.
2. At armed + 3s: **sliding-window phase opens** for 8 seconds.
   - Each buzz_press: recorded with timestamp.
   - Every 500ms window [now - 500, now]: count unique players who pressed.
   - If count > best cluster count (or same count but earlier endTs): update bestCluster.
   - Per-player cooldown: 1 second (ignore presses within 1s of last press by that player).
3. Every 100ms: `allhands_progress` emitted with currentCluster (now) and bestCluster (max so far).
4. After 8 seconds: team with highest bestCluster count wins.

**Win condition:** Team with largest sliding-window sync cluster (0.5s window of simultaneous presses).

**End condition:** 8-second timer expires; team with max `bestCluster.count` wins; emits rush_winner.

**State held (assistant):**
- `S.rushSession.mode = 'allhands'`
- `S.rushSession.teamClicks = {0: [{name, ts}, ...], ...}` — all press records per team
- `S.rushSession.bestCluster = {0: {count, endTs, members: [...]}, ...}` — best cluster per team
- `S.rushSession.lastPressedAt = {0: {name: ts, ...}, ...}` — per-player cooldown tracking
- `S.rushSession.totals = {0: total_members, ...}` — group sizes

**Code ref:** assistant.html:1424–1457 (buzz_press handler), 2256–2292 (_runAllhandsSession), 2331–2381 (_mockAllhandsClicksForOtherTeams), 2300–2326 (_emitAllhandsProgress)

**Details:**
- `currentCluster` in progress event = number of unique players pressing in [now - 500ms, now].
- `bestCluster` = the largest cluster achieved so far in the round.
- Tiebreak: earliest endTs wins (first to achieve that cluster size).
- Per-person 1s cooldown enforced server-side.
- rush_winner payload: `{ clusterCount, totalCount, endAtSec }` — achieved cluster size, total team members, time of achievement.

---

### Mode: random (隨機)

**Trigger event:** `start_rush` with `rushMode: 'random'`

**Rush sequence:**
1. Assistant's `doStartRush()` calls `_runRandomReveal()`.
2. `rush_reveal` emitted with actual mode (randomly chosen from [speed, count, lightning, allhands]).
3. Presenter/participant show 5-second reveal screen (displaying the actual mode).
4. After 5 seconds: `start_rush` emitted with actual mode; normal rush session logic for that mode begins.

**Win condition:** Same as the revealed actual mode.

**End condition:** Depends on actual mode (e.g., first press for speed, 5s timer for count).

**State held (assistant):**
- `S.rushMode = 'random'` (user-selected mode on UI)
- `S.rushModeActual = 'speed'|'count'|'lightning'|'allhands'` (randomly resolved at rush time)
- Falls through to selected mode's session state once actual mode is armed.

**Code ref:** assistant.html:2075–2101 (_runRandomReveal), 2103–2108 (_resolveRushMode), 1556–1568 (participant UI shows mode during reveal)

**Details:**
- Purely a UI revelation delay; all logic is delegated to the actual mode.
- Allows dramatic 5-second pause for audience suspense.

---

## Host-code (controlCode) Mechanism

**Current status:** No host-code concept currently implemented in the codebase. The "room code" (房號) and "host code" (主控碼) exist but are **NOT used for access control** — they are display-only identifiers.

**Generation (current):**
```javascript
S.roomCode = genCode(4, false);  // 4 alphanumeric chars, no symbol, for public sharing
S.hostCode = genCode(6, true);   // 6 alphanumeric + symbol, for UI display
```

**Storage:** Both stored in `S` (in-memory) only; not persisted or validated.

**Current uses:**
- `roomCode` displayed in QR code (for participant login).
- `hostCode` displayed in assistant UI (informational only).

**Phase 2 target — privileged commands that MUST require server-side controlCode:**
- `game_start`
- `score_update`
- `start_rush` / `rush_reveal`
- `reveal_answer`
- `next_question` / `skip_question`
- `game_restart`
- `category_preview` / `category_confirm` / `category_reset`
- `question_pick`
- `purgatory_summon` / `purgatory_end`
- `presenter_show_qr`
- `mode_preview` / `custom_tiers_changed` / `rush_mode_changed`
- `enter_category`
- `export_result`

Participant events (`player_join`, `buzz_press`, `team_rename`) and presenter events (`__ping__`) do NOT require controlCode.

---

## State to Migrate to Server

### Assistant-held state to move to server

**Game session state:**
- `S.mode` — current game mode (ordinary/hell/paradise/custom)
- `S.customTiers` — active difficulty tiers for custom mode
- `S.customTypes` — active question types for custom mode
- `S.totalQ` — total questions in this session
- `S.spq` — points per correct answer (score per question)
- `S.currQ` — current question index (0-based)
- `S.gameStarted` — boolean; has `game_start` been emitted?
- `S.rushMode` — user-selected rush mode (random or specific)
- `S.rushModeActual` — resolved actual rush mode (for random mode)
- `S.phase` — current phase ('idle', 'rushing', 'won', 'picking', 'answering', 'revealed', 'ended')

**Participant roster:**
- `S.groups[i]` — array of {id, name, score, members: [name1, name2, ...]}

**Question tracking:**
- `S.currentQuestion`, `S.currentDifficulty`, `S.currentFramework`, `S.currentCat`
- `S.usedIds` — Set of question IDs already asked
- `S.askedQuestions` — full array (for export)

**Rush session state (transient, cleared after round ends):**
- Whole `S.rushSession` object — see mode-specific states above

**UI selection state:**
- `S.selectedIdx`, `S.pendingIdx`, `S.catPreview`, `S.catLocked`, `S.purgArmed`

**Logging:** `S.log` (join/leave/rename transcript)

### Server should compute & broadcast

- `rush_winner` (from rushSession + mode logic)
- `score_update` (after adjustments)
- `category_confirm` (locked state)
- `rush_tick` (every 100ms during count)
- `allhands_progress` (every 100ms during allhands)
- `lightning_disqualify` (when rule triggers)
- `game_start`, `game_restart`

### localStorage persistence (client-side, NOT server)

- `BANK_STORAGE_KEY = 'pgg_quiz_bank_v1'` — question bank cache (BANK object)

---

## State That Stays Client-Local

### Participant-only state

- `G.name`, `G.team` (sent on join, then locally cached)
- `G.buzzer` button visual state (locked / armed / flashing)
- `G.lightningArmedAt` (local UI timer)
- `G.lightningEliminated` (local optimistic UI)
- `G.buzzed` (per-round one-press flag)
- `G.buzzCooldownUntil` (per-person 1s cooldown UI)
- Color scheme / language / page zoom / font size
- Modal open state, scroll position, current question phase view

### Presenter-only state

- `isRevealed`, cached `currentQuestion` / `currentDifficulty` / `currentFramework`
- `presenterUsedIds` (local mirror)
- `presenterRushMode`, `round`
- Scene/modal state (which screen is visible, animation timers)

---

## Room/Session Concept

**Current state of affairs:**
- No true multi-room concept today.
- All participants in a browser origin share the same BroadcastChannel (`'pgg_bus'`).
- Within that origin, all three endpoints broadcast/receive on the same channel.
- "Room code" (房號) is generated client-side (in `assistant.html`) and shown as QR, but **not validated** anywhere.

**Phase 2 target (per agreed plan):**
1. Assistant opens UI → auto-generates 6-char alphanumeric `roomId` (e.g. `KFG71M`); registers room with server; displays QR + room code.
2. Presenter / participant URLs include `?room=KFG71M`.
3. PartyKit room name = `roomId`; all three endpoints subscribe to that room.
4. Server generates a separate `controlCode` and returns it to assistant only; required for privileged commands.
5. Participant identity = nickname + team (no auth); `player_join` records them in room state.

---

## Decisions Locked (2026-04-26)

| # | Decision | Notes |
|---|---|---|
| 1 | **Count tiebreak** = "earliest team to reach max count wins" | Server records `ts` for each click; on lock, find the time at which each team first reached its final count, take the min. |
| 4 | **Purgatory has two trigger paths**, both server-authoritative: (a) BANK draws a `difficulty: 'purgatory'` question naturally; (b) Assistant explicitly arms purgatory before category confirm | Current `S.purgArmed` is client-only — Phase 2 must introduce a server-recognized "arm purgatory" command (likely a new event `arm_purgatory` or a flag inside `category_confirm`). |
| 11 | **BANK = static JSON files** at `/public/data/insurance-quiz-bank-{easy,medium,hard,hell,purgatory}.json` | Phase 1: all 5 JSONs ship to all clients (assistant + presenter + participant). Server holds a copy too and is authoritative for question selection (`usedIds`, difficulty pool filtering). Server broadcasts only the question `id`; clients resolve from local BANK. **Phase 2-late hardening (optional):** server holds back `model_answer` / sensitive fields until `reveal_answer` fires — clients only get `stem` / `options` / `topic` until then. Phase 1 ships full JSON to keep scope tight. |
| 12 | **Delete `_mockCountClicksForOtherTeams` / `_mockLightningClicksForOtherTeams` / `_mockAllhandsClicksForOtherTeams`** from assistant.html in Phase 3 | These are demo fallbacks for solo-testing without participants. Once on PartyKit, real participants drive all counts. Removing them avoids a tech-debt branch. |

Other items (★) accepted as proposed: 2, 3, 5, 6, 7, 8, 9, 10, 13.

---

## Open Questions / Ambiguities (resolved above; kept for context)

### 1. Count mode tiebreak undefined
- **Issue:** If two or more teams tie at the 5-second mark with identical tap counts, code does not define a tiebreak rule. Currently: index-order (first team in loop wins).
- **Need:** Server-side rule. Options: (a) earliest team to reach max count wins; (b) lowest team index; (c) random tiebreaker.

### 2. Lightning disqualification race
- **Issue:** Participant's local `G.lightningEliminated` is set optimistically on press; server's `disqualified` set is updated on receipt. Network latency can desync the UI.
- **Recommendation:** Server-authoritative; participant must wait for `lightning_disqualify` echo. May cause feel of "0.05s delay before button greys out" — confirm acceptable.

### 3. Allhands clustering uses client timestamps
- **Issue:** Sliding-window cluster is computed from `buzz_press.ts` (client time). On variable network jitter, ordering can be wrong.
- **Recommendation:** Server uses server-receive time, ignore client `ts`. Side effect: tiny delay from press → cluster register, but consistent.

### 4. Purgatory probability not documented
- **Issue:** Code probabilistically draws "purgatory" tier when included in difficulty pool, but probability is not stated. Triggers FX via `purgatory_summon`.
- **Need:** Decide explicit probability (e.g., 1/N when pool includes purgatory) or leave as "any draw of `difficulty:'purgatory'` triggers purgatory FX". Document on server.

### 5. Per-person allhands cooldown UI mismatch
- **Issue:** Local `G.buzzCooldownUntil` may unlock UI before server's cooldown check on bad networks, causing dropped presses.
- **Recommendation:** Server-authoritative cooldown; participant should be forgiving (server silently drops, no error).

### 6. `purgArmed` (秘技) is assistant-only
- **Confirmed intentional**: hidden flag visible to assistant only; server should not receive a "purgatory intent" — server infers purgatory from final question's tier.

### 7. `player_leave` defined but never emitted today
- **Today:** `player_leave` listener exists in assistant; nobody emits.
- **Phase 2:** PartyKit will emit on connection close → server must clean up roster and broadcast.

### 8. Custom mode question pool requires both tier AND type selected
- **Confirmed:** UI disables "開始遊戲" if either is empty (`chk()` line 1956). Server must mirror this validation.

### 9. Score updates outside of rush_winner
- **Today:** Manual ± buttons allow score changes any phase.
- **Recommendation:** Server allows manual score change in any phase (assistant has UI gating during 'rushing'). No server gating.

### 10. Team rename concurrent edits not resolved
- **Issue:** If two participants rename the same team simultaneously, current code's first-match-wins behavior may drop one.
- **Recommendation:** Server validates: oldName must match a real team, ≤8 chars, optional dedup; broadcasts canonical result. Last-write-wins is acceptable.

### 11. BANK distribution to participants
- **Today:** BANK uploaded by assistant, cached in localStorage, persists across sessions. New participants joining mid-session may see "題目不在 BANK".
- **Need decision:**
  - (a) BANK lives on PartyKit server; pushed to clients on join (simplest, but ~? KB transfer per join)
  - (b) BANK stays in client localStorage; participant must visit a "loader" URL once before joining (operational risk)
  - (c) BANK served as static asset from Cloudflare Pages; clients fetch on first load (clean separation)
- **Recommended:** (c) — BANK is a static JSON file deployed alongside HTML; assistant can still upload to overwrite locally for testing.

### 12. DEMO mock functions (`_mockCountClicksForOtherTeams` etc.)
- **Today:** Assistant fakes other teams' clicks for solo testing.
- **Phase 2:** These must not be carried to server; server uses real `buzz_press` events only. Keep mock code in assistant client behind a "demo mode" flag if helpful, otherwise delete.

### 13. Export result + team rename interaction
- **Today:** Code comment notes this is unresolved (line 3108).
- **Recommendation:** Server tracks team members by stable team `idx`/`id` throughout session; rename only updates the `name` field. Export uses current name + idx-stable member list.
