/**
 * state.ts — RoomState type, factory, and pure-ish mutation helpers.
 *
 * The DurableObject behind each PartyKit room is single-threaded, so we
 * mutate state in place rather than producing immutable copies. The
 * exported helpers exist mainly to centralize invariants (e.g. score
 * floor at 0, deduped usedIds) so server.ts and the rush/* modules
 * don't reinvent them.
 */

import type {
  ActualRushMode,
  AssistantInfo,
  AssistantRole,
  Difficulty,
  GameConfig,
  GroupingMode,
  GroupNoticeKind,
  Phase,
  RushMode,
  RoomStateSnapshot,
} from './protocol';
import { PREFIX_FALLBACK_GROUP } from './protocol';
import { FRAMEWORKS_A, FRAMEWORKS_B, BRANDING } from './bank';

// ──────────────────────────────────────────────────────────────────────
// Rush session sub-types
// ──────────────────────────────────────────────────────────────────────

export interface BuzzRecord {
  name: string;
  team: string;
  teamIdx: number;
  ts: number;            // server-receive timestamp (Date.now() at onMessage)
}

export interface SpeedData {
  clicks: BuzzRecord[];   // every press in order
}

export interface CountData {
  // Per-team running tally. Map keyed by teamIdx → count.
  teamCounts: Map<number, number>;
  // Phase 0 Q1 tiebreak: when a team first reached its current count.
  // Updated on every increment so we always know "earliest time this team
  // arrived at its present count value".
  teamReachedAt: Map<number, Map<number, number>>; // teamIdx → (count → ts)
  // Per-team MVP tracking: who clicked the most.
  perPerson: Map<number, Map<string, number>>;     // teamIdx → (name → count)
  clicks: BuzzRecord[];
}

export interface LightningData {
  // Disqualified players per team (pressed in 0–3000ms window).
  disqualified: Map<number, Set<string>>;          // teamIdx → set<name>
  validClicks: BuzzRecord[];                       // presses in valid window only
}

export interface AllhandsData {
  // Per-team list of valid presses.
  teamClicks: Map<number, BuzzRecord[]>;
  // Per-team best cluster achieved so far.
  bestCluster: Map<number, { count: number; endTs: number; members: string[] }>;
  // Per-person 1s cooldown (Phase 0 Q5: server-authoritative).
  lastPressedAt: Map<number, Map<string, number>>; // teamIdx → (name → ts)
}

export type RushSessionData = {
  speed?: SpeedData;
  count?: CountData;
  lightning?: LightningData;
  allhands?: AllhandsData;
};

export interface RushSession {
  mode: ActualRushMode;
  armedAt: number;          // Date.now() when arming completes (presses before this are pre-arm)
  startedAt: number;        // Date.now() when start_rush emitted (countdown began)
  rerush: boolean;
  winnerLocked: boolean;
  data: RushSessionData;
  timers: ReturnType<typeof setTimeout>[];
}

// ──────────────────────────────────────────────────────────────────────
// Room participant + team state
// ──────────────────────────────────────────────────────────────────────

export interface TeamState {
  idx: number;
  name: string;
  score: number;
  members: string[];        // distinct player nicknames currently on this team
  leader: string | null;    // 組長(開賽時隨機抽);null = 尚未指派/無成員
}

export interface ParticipantRef {
  connId: string;
  name: string;
  team: string;
  joinedAt: number;
  /** 裝置識別碼(pgg_device_id_v1)。舊 client / URL 沒帶時為 null。 */
  deviceId: string | null;
}

/**
 * 裝置 → 組別鎖定(30 人實戰後加上)。
 * 目的:同一支手機在 24 小時內永遠回到第一次被分到的組,不因斷線、
 * 重整、重連、開賽凍結時剛好不在線而被當成新人重新分組。
 * key = deviceId;name 記「最後一次用這個裝置入房的名字」,
 * 供重洗名單時把離線者也能對回名字。
 */
export interface DeviceTeamLock {
  name: string;
  team: string;
  at: number;             // 最後一次確認/寫入的時間(epoch ms)
}

/** 鎖定有效期:24 小時(Vincent 規格)。 */
export const DEVICE_TEAM_TTL_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────
// 助理身分與角色(伺服器權威)
// ──────────────────────────────────────────────────────────────────────

/**
 * 一位助理的持久身分。key = assistantId(助理端 deviceId,localStorage 綁定;
 * 無 localStorage 時退回臨時碼,則不具跨連線持久性)。
 * 角色與名字隨房間存檔保存,24 小時內同裝置重連即恢復原角色(Vincent 規格)。
 */
export interface AssistantRec {
  id: string;
  name: string;
  role: AssistantRole;
  createdAt: number;
  lastSeenAt: number;   // 最後一次連線時間;>24h 未見即 prune
}

/** 助理身分有效期:24 小時(與裝置鎖一致)。 */
export const ASSISTANT_TTL_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────
// Room state — the single source of truth per Durable Object
// ──────────────────────────────────────────────────────────────────────

export interface RoomState {
  roomId: string;
  controlCode: string;      // 投影端控制碼:presenter 登入 + 特權指令簽章(沿用舊名)
  assistantCode: string;    // 助理端控制碼:參賽者端輸入此碼 → 路由到助理介面
  createdAt: number;

  phase: Phase;

  // Game config; null until game_start fires.
  game: GameConfig | null;

  // 分組方式(lobby 設定,預設 random)。決定 player_join 怎麼分組。
  groupingMode: GroupingMode;

  // 參賽者新手導覽是否自動跳出。預設 false —— 30 人實戰回饋:年長學員
  // 多半不看,反而擋住畫面。助理端可開;關閉時「?」按鈕仍可手動叫出。
  onboardingEnabled: boolean;

  // Team scoreboards — created on game_start, persist till game_restart.
  groups: TeamState[];

  // Question progression
  currQ: number;                                // 1-based; 0 before any question
  currentQuestion:
    | { id: string; difficulty: Difficulty; framework: string }
    | null;
  currentCat: string | null;                    // F1..F9 / L1..L4
  catLocked: boolean;
  purgArmed: boolean;                           // assistant 秘技 (Phase 0 Q4)
  usedIds: Set<string>;
  // replaced=true 代表這一筆是「被同範圍重抽換掉」的舊題:它在台上亮過,
  // 所以照設計仍計入實際題數,但賽後回顧要標示出來,免得看的人以為
  // 有一題沒人答過卻被列進去(2026-07-23 實測回饋)。
  askedQuestions: { id: string; difficulty: Difficulty; framework: string; replaced?: boolean }[];
  // 一字千金 cap 計數:本場已抽出的 word_game 題數(含被 redraw 換掉的;
  // 換掉的題目已在台上亮過,保守起見照算)。
  wordGameAsked: number;

  // 搶答 MVP 累計:teamIdx → (玩家名 → 替全組搶下的輪數)。
  // 只累計 speed/lightning/count(全組到位 allhands 不算個人)。
  // 每位玩家在 rush_winner 被標為該組 personName 時 +1。game_start/restart 清空。
  mvpTally: Map<number, Map<string, number>>;

  // 答題倒數截止時間(epoch ms);null = 無倒數。reconnect 端據此續跑。
  timerDeadline: number | null;

  // 同一題重新搶答:true 表示這輪 rush 結束後要回到同一題作答,而非進九宮格。
  rebuzzPending: boolean;

  // 本題已喪失搶答資格的組(teamIdx):答不出來被重新搶答時排除,累積。
  // 進新題(next/skip)或新一輪 start_rush 時清空。
  excludedTeams: number[];
  // 最近一次搶到的組(teamIdx)= 當前答題者;重新搶答時把它加進 excludedTeams。
  lastBuzzWinnerTeam: number | null;

  // Rush mode selection (UI choice) + resolved mode for current/last rush
  rushMode: RushMode;
  rushModeActual: ActualRushMode | null;

  // Active rush; null when no rush running.
  rushSession: RushSession | null;

  // Live participants (by connection). Used for player_leave broadcasts.
  participants: Map<string, ParticipantRef>;

  // 裝置 → 組別鎖定表(deviceId → lock)。入組時優先查這裡;隨持久化
  // 保存、跨 game_restart 保留,只有「重新分組」(明示 reshuffle)會重建。
  deviceTeams: Map<string, DeviceTeamLock>;

  // True after someone has successfully claimed the presenter role for this
  // room. Persists across game_restart (presenter is per-room infra, not
  // per-game) — only resets when the DurableObject itself is destroyed.
  presenterClaimed: boolean;

  // ── 助理身分與角色(伺服器權威;取代舊「所有助理平權」模型)──────
  // assistantId → 助理紀錄。含離線者(24h 內可重連恢復角色);>24h prune。
  assistants: Map<string, AssistantRec>;
  // 總助理(建房者)的 assistantId;第一個連上的助理取得,null = 尚無總助理。
  chiefId: string | null;

  // 分組助理巡檢(前綴分組時用):置頂組名清單(人工勾選,房間共用)+
  // 各組最近一次通知操作(kind → {by 姓名, at 時間}),供按鈕旁顯示「誰、多久前」。
  pinnedGroups: string[];
  groupNotices: { team: string; kind: GroupNoticeKind; by: string; at: number }[];
}

// ──────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────

export function createInitialState(
  roomId: string,
  controlCode: string,
  assistantCode: string
): RoomState {
  return {
    roomId,
    controlCode,
    assistantCode,
    createdAt: Date.now(),
    phase: 'lobby',
    game: null,
    groupingMode: 'random',
    onboardingEnabled: false,
    groups: [],
    currQ: 0,
    currentQuestion: null,
    currentCat: null,
    catLocked: false,
    purgArmed: false,
    usedIds: new Set(),
    askedQuestions: [],
    wordGameAsked: 0,
    mvpTally: new Map(),
    timerDeadline: null,
    rebuzzPending: false,
    excludedTeams: [],
    lastBuzzWinnerTeam: null,
    rushMode: 'speed',
    rushModeActual: null,
    rushSession: null,
    participants: new Map(),
    deviceTeams: new Map(),
    presenterClaimed: false,
    assistants: new Map(),
    chiefId: null,
    pinnedGroups: [],
    groupNotices: [],
  };
}

// ──────────────────────────────────────────────────────────────────────
// 助理身分/角色 helpers(伺服器權威)
// ──────────────────────────────────────────────────────────────────────

/** 把過期(>24h 未見)的助理紀錄清掉。回傳同一個 Map。 */
export function pruneAssistants(
  map: Map<string, AssistantRec>
): Map<string, AssistantRec> {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - v.lastSeenAt > ASSISTANT_TTL_MS) map.delete(k);
  }
  return map;
}

/**
 * 助理連上時登記/恢復身分。回傳該助理紀錄。
 * - 已存在(24h 內)→ 續用原角色,只更新 lastSeenAt(重連恢復)。
 * - 全新且房間尚無總助理 → 成為總助理(chief,自動命名「總助理」),設 chiefId。
 * - 全新且已有總助理 → 未指派(unassigned);若沒帶有效姓名則 name=''(前端出現
 *   「請輸入姓名」畫面,由助理自己命名),命名後才進入等待指派。
 * preferredName 只在「新建」時採用(且去重);重連不覆蓋既有名字。
 */
export function attachAssistant(
  state: RoomState,
  id: string,
  preferredName?: string | null
): AssistantRec {
  pruneAssistants(state.assistants);
  // 總助理若曾存在但已 prune 掉 → 釋放 chiefId,讓下一位遞補建房者身分。
  if (state.chiefId && !state.assistants.has(state.chiefId)) state.chiefId = null;

  const existing = state.assistants.get(id);
  if (existing) {
    existing.lastSeenAt = Date.now();
    return existing;
  }

  const isChief = state.chiefId === null;
  let name = (preferredName ?? '').trim().slice(0, 20);
  // 名字去重:撞名 → 清空(要求重新命名),保持「助理姓名不可重複」。
  const dup = name.length > 0 &&
    [...state.assistants.values()].some((a) => a.name === name);
  if (dup) name = '';
  // 總助理(建房者)自動命名,不需輸入;其餘無有效名字 → 留空,前端請輸入姓名。
  if (isChief && !name) name = '總助理';

  const rec: AssistantRec = {
    id,
    name,
    role: isChief ? 'chief' : 'unassigned',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  state.assistants.set(id, rec);
  if (isChief) state.chiefId = id;
  return rec;
}

/** 讀某助理的角色;不存在回 null。 */
export function assistantRoleOf(
  state: RoomState,
  id: string | null | undefined
): AssistantRole | null {
  if (!id) return null;
  return state.assistants.get(id)?.role ?? null;
}

/** 目前是否已有管理助理(admin);用於「每房至多一位」限制。 */
export function hasAdmin(state: RoomState, exceptId?: string): boolean {
  for (const a of state.assistants.values()) {
    if (a.id === exceptId) continue;
    if (a.role === 'admin') return true;
  }
  return false;
}

/** 純設定角色(授權由呼叫端 server 負責)。回傳是否有此助理。 */
export function setAssistantRole(
  state: RoomState,
  id: string,
  role: AssistantRole
): boolean {
  const rec = state.assistants.get(id);
  if (!rec) return false;
  rec.role = role;
  rec.lastSeenAt = Date.now();
  return true;
}

/** 改助理名字(去重;授權由 server 負責)。 */
export function renameAssistant(
  state: RoomState,
  id: string,
  rawName: string
): { ok: boolean; reason?: string } {
  const rec = state.assistants.get(id);
  if (!rec) return { ok: false, reason: 'not_found' };
  const name = (rawName ?? '').trim();
  if (!name) return { ok: false, reason: 'empty' };
  if (name.length > 20) return { ok: false, reason: 'too_long' };
  const taken = [...state.assistants.values()].some(
    (a) => a.id !== id && a.name === name
  );
  if (taken) return { ok: false, reason: 'duplicate' };
  rec.name = name;
  return { ok: true };
}

/** 移除某助理紀錄(撤銷角色)。回傳被移除者(或 null)。移除的若是總助理則一併清 chiefId。 */
export function removeAssistant(state: RoomState, id: string): AssistantRec | null {
  const rec = state.assistants.get(id);
  if (!rec) return null;
  state.assistants.delete(id);
  if (state.chiefId === id) state.chiefId = null;
  return rec;
}

// ── 分組助理巡檢共用狀態 ──────────────────────────────────────────

/** 人工勾選/取消把某組置頂巡檢。「其他組」固定置頂,不進此清單。 */
export function setGroupPin(state: RoomState, team: string, pinned: boolean): void {
  const has = state.pinnedGroups.includes(team);
  if (pinned && !has) state.pinnedGroups.push(team);
  else if (!pinned && has) state.pinnedGroups = state.pinnedGroups.filter((t) => t !== team);
}

/** 記錄某組某種通知的最近操作者與時間(同組同種類只留最新一筆)。 */
export function recordGroupNotice(
  state: RoomState,
  team: string,
  kind: GroupNoticeKind,
  by: string
): void {
  state.groupNotices = state.groupNotices.filter((n) => !(n.team === team && n.kind === kind));
  state.groupNotices.push({ team, kind, by, at: Date.now() });
}

/** 組出巡檢共用狀態(過濾掉已不存在的組)。給 snapshot / group_watch 廣播。 */
export function groupWatchPayload(state: RoomState): {
  pinned: string[];
  notices: { team: string; kind: GroupNoticeKind; by: string; at: number }[];
} {
  const names = new Set(state.groups.map((g) => g.name));
  return {
    pinned: state.pinnedGroups.filter((t) => names.has(t)),
    notices: state.groupNotices.filter((n) => names.has(n.team)).map((n) => ({ ...n })),
  };
}

/** 組出助理名冊(給 snapshot / assistant_roster);online 依傳入的連線集合判定。 */
export function assistantList(
  state: RoomState,
  onlineIds: Set<string>
): AssistantInfo[] {
  return [...state.assistants.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((a) => ({ id: a.id, name: a.name, role: a.role, online: onlineIds.has(a.id) }));
}

// ──────────────────────────────────────────────────────────────────────
// Mutation helpers (centralize invariants)
// ──────────────────────────────────────────────────────────────────────

export function startGame(state: RoomState, config: GameConfig): void {
  state.game = config;
  if (config.groupingMode) state.groupingMode = config.groupingMode;
  state.phase = 'idle';
  state.rushMode = config.rushMode;
  state.rushModeActual = null;
  state.currQ = 0;
  state.currentQuestion = null;
  state.currentCat = null;
  state.catLocked = false;
  state.purgArmed = false;
  state.usedIds = new Set();
  state.askedQuestions = [];
  state.wordGameAsked = 0;
  state.mvpTally = new Map();
  state.timerDeadline = null;
  state.excludedTeams = [];
  state.lastBuzzWinnerTeam = null;
  // 開賽前的完整名單(含當下剛好斷線的人)。30 人實戰教訓:只從
  // participants(僅在線連線)重建名單,會把「按開始遊戲那一刻剛好
  // WS 斷線」的玩家整個踢出名單,之後他重整頁面就被當新人重新分組。
  //
  // ⚠ 2026-07-23 實測事故:名單原本是用「組名」當 key 還原的。助理端一旦
  // 重整過頁面,本機組名欄位會退回預設值「第一組/第二組」,送過來的
  // config.groups 就跟 server 上玩家自己取的組名(勇腳團/不老松)對不上
  // → prevMembers.get(g.name) 取到 undefined → 全場 8 個人從名單消失、
  // 誰都搶答不了(投影幕顯示「第一組 · (無人) 搶答耗時 8.000 秒」)。
  // 修法:組數沒變就一律「按 idx 對位」還原,不看名字;組數變了才退回
  // 名字比對。組名仍然可以被 config 改(助理端「分組設定」的組名欄位),
  // 但改名不再會把人洗掉。
  const prev = state.groups.map((g) => ({
    name: g.name,
    members: [...g.members],
    leader: g.leader,
  }));
  const sameCount = prev.length === config.groups.length;
  state.groups = config.groups.map((g, i) => {
    const src = sameCount ? prev[i] : prev.find((p) => p.name === g.name);
    return {
      idx: i,
      name: g.name,
      score: 0,
      members: src ? [...src.members] : [],
      leader: src?.leader ?? null,
    };
  });
  // 組名若被改掉,所有「以組名為鍵」的資料都要跟著搬,否則會出現
  // 「人還在名單裡、但 participant.team 指向一個不存在的組」→ buzz_press
  // 找不到組直接丟棄、裝置鎖(deviceTeams)也整個失效。
  const renamed = new Map<string, string>();
  if (sameCount) {
    prev.forEach((p, i) => {
      const next = state.groups[i];
      if (next && next.name !== p.name) renamed.set(p.name, next.name);
    });
  }
  if (renamed.size > 0) {
    for (const p of state.participants.values()) {
      const to = renamed.get(p.team);
      if (to) p.team = to;
    }
    for (const lock of state.deviceTeams.values()) {
      const to = renamed.get(lock.team);
      if (to) lock.team = to;
    }
  }
  // Re-attach existing participants to their teams (preserve roster across
  // game_start so participants who joined before pressing start aren't lost).
  for (const p of state.participants.values()) {
    const team = state.groups.find((g) => g.name === p.team);
    if (team && !team.members.includes(p.name)) team.members.push(p.name);
  }
  // 最後一道防呆:若還原完的名單總人數比「目前在線人數」還少,代表上面
  // 的對位邏輯出了意料外的狀況 —— 寧可用在線名單硬補回去,也不要開出一場
  // 空的遊戲。
  const listed = new Set(state.groups.flatMap((g) => g.members));
  for (const p of state.participants.values()) {
    if (listed.has(p.name)) continue;
    const target =
      state.groups.find((g) => g.name === p.team) ??
      state.groups.reduce((a, b) => (a.members.length <= b.members.length ? a : b));
    if (!target) continue;
    target.members.push(p.name);
    p.team = target.name;
  }
}

export function restartGame(state: RoomState): void {
  // Cancel any pending rush timers.
  if (state.rushSession) {
    for (const t of state.rushSession.timers) clearTimeout(t);
  }
  // Preserve roomId, controlCode, participants, presenterClaimed
  // (presenter 是房層設施,不會因為按了「重新開始」就解鎖 → 必須帶過來)。
  // groupingMode 也保留 — 重新開始通常還是同一場活動的同一種分組方式。
  const prevGroupingMode = state.groupingMode;
  const fresh = createInitialState(state.roomId, state.controlCode, state.assistantCode);
  Object.assign(state, fresh, {
    participants: state.participants,
    presenterClaimed: state.presenterClaimed,
    // ⚠ 助理名冊與總助理身分是「房層設施」,絕不可因「重新開始」而清空!
    // 否則:總助理送指令變成「未指派」被擋、chiefId 歸 null 讓下一個連進來的
    // 助理(甚至用助理碼進來的參賽者)自動變成總助理 —— 嚴重權限漏洞。
    // 總助理從開房到關房自始至終唯一,任何重開/重連都不得改變。
    assistants: state.assistants,
    chiefId: state.chiefId,
    groupingMode: prevGroupingMode,
    // 組別結構+成員跨「重新開始」保留、只歸零分數與組長(30 人實戰教訓:
    // 兩場之間組員必須不變,否則獎勵沒辦法發)。舊行為是清空 groups 等
    // 助理重新設定,結果第二場全員被隨機重洗。要打散重分 → 助理按
    // 「重新分組」按鈕(明示 reshuffle)。
    groups: state.groups.map((g) => ({
      ...g,
      score: 0,
      // leader 保留 —— 組長 24 小時內固定(Vincent 規格),不因換一場而重抽。
      // 要換人 → 助理端「重抽組長」;組長離開名單 → ensureLeaders 自動接任。
      members: [...g.members],
    })),
    // 裝置鎖組表同樣跨場保留(24h 內同裝置固定同組)。
    deviceTeams: pruneDeviceTeams(state.deviceTeams),
  });
  // prefix 模式:重新開始後把仍在線的 participant 依名字前綴重新整組
  // (組是從名字長出來的,維持既有行為)。
  if (prevGroupingMode === 'prefix') {
    regroupByPrefix(state);
  }
}

export function adjustScore(
  state: RoomState,
  teamIdx: number,
  delta: number
): { ok: boolean; team?: TeamState } {
  const team = state.groups[teamIdx];
  if (!team) return { ok: false };
  team.score = Math.max(0, team.score + delta);
  return { ok: true, team };
}

export function setPhase(state: RoomState, next: Phase): void {
  state.phase = next;
}

// ──────────────────────────────────────────────────────────────────────
// Roster helpers
// ──────────────────────────────────────────────────────────────────────

export function upsertParticipant(
  state: RoomState,
  connId: string,
  name: string,
  team: string,
  deviceId: string | null = null
): void {
  state.participants.set(connId, { connId, name, team, joinedAt: Date.now(), deviceId });
  // If a game is in progress, add to team roster too.
  const teamRow = state.groups.find((g) => g.name === team);
  if (teamRow && !teamRow.members.includes(name)) {
    teamRow.members.push(name);
  }
  // 記錄/更新裝置鎖:這支手機 24h 內固定回到這一組。
  if (deviceId) {
    state.deviceTeams.set(deviceId, { name, team, at: Date.now() });
  }
}

/**
 * 查某裝置的鎖定組。回傳組名;以下情況回 null(呼叫端 fallback 到
 * 名字比對 → 最少人組):
 * - 沒有鎖 / 鎖超過 24h
 * - 鎖定的組已不存在(組數改過、重新分組過、組名不符)
 */
export function lockedTeamForDevice(
  state: RoomState,
  deviceId: string
): string | null {
  const lock = state.deviceTeams.get(deviceId);
  if (!lock) return null;
  if (Date.now() - lock.at > DEVICE_TEAM_TTL_MS) {
    state.deviceTeams.delete(deviceId);
    return null;
  }
  return state.groups.some((g) => g.name === lock.team) ? lock.team : null;
}

/** 把過期(>24h)的裝置鎖清掉。回傳同一個 Map(方便 inline 使用)。 */
export function pruneDeviceTeams(
  map: Map<string, DeviceTeamLock>
): Map<string, DeviceTeamLock> {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - v.at > DEVICE_TEAM_TTL_MS) map.delete(k);
  }
  return map;
}

// ──────────────────────────────────────────────────────────────────────
// Team setup + auto-assignment (server-authoritative)
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_TEAM_NAMES = [
  '第一組', '第二組', '第三組', '第四組', '第五組',
  '第六組', '第七組', '第八組', '第九組', '第十組',
];

/**
 * Replace state.groups with `count` teams. Existing names + scores are
 * preserved for the first min(count, existing) teams; new teams get
 * default names. Members are cleared — caller is expected to follow
 * with reshuffleParticipants(), or let subsequent player_join calls
 * repopulate via pickTeamForParticipant.
 *
 * resetNames=true:組名一併回到「第一組/第二組…」。
 * 全員重洗時一定要帶這個(2026-07-23 實測回饋):組名是綁在「組別位置」
 * 上的,不會跟著人走 —— 王秀琴把自己那組取名「勇腳團」,重洗後她被分到
 * 「不老松」,「勇腳團」變成別人那組,現場會非常錯亂。與其讓名字錯位,
 * 不如清乾淨請大家重取。
 */
export function setupTeams(state: RoomState, count: number, resetNames = false): void {
  const newGroups: TeamState[] = [];
  for (let i = 0; i < count; i++) {
    const existing = state.groups[i];
    const fallback = DEFAULT_TEAM_NAMES[i] ?? `第${i + 1}組`;
    newGroups.push({
      idx: i,
      name: resetNames ? fallback : (existing?.name ?? fallback),
      score: existing?.score ?? 0,
      members: [],
      leader: null,
    });
  }
  state.groups = newGroups;
}

/**
 * Decide which team a joining participant belongs to.
 * - Reconnect: name already lives in some team's members[] (we never
 *   strip on disconnect) → reuse that team so reload doesn't re-shuffle.
 * - New player: smallest team wins; random tiebreak when sizes tie.
 * Returns null only if state.groups is empty (caller must initialize first).
 */
export function pickTeamForParticipant(
  state: RoomState,
  name: string
): string | null {
  if (state.groups.length === 0) return null;
  const existing = state.groups.find((g) => g.members.includes(name));
  if (existing) return existing.name;
  const minSize = Math.min(...state.groups.map((g) => g.members.length));
  const candidates = state.groups.filter((g) => g.members.length === minSize);
  return candidates[Math.floor(Math.random() * candidates.length)].name;
}

// ──────────────────────────────────────────────────────────────────────
// Prefix-based grouping (依名稱前綴)
// ──────────────────────────────────────────────────────────────────────

/**
 * 從名字抽出分組 key:取第一個 dash 之前的文字(去頭尾空白)。
 * 支援半形 - 與全形 －、連字號 –—。無 dash 或前綴為空 → null(歸「其他」)。
 * 例:「中信1-王」→「中信1」;「中信1」→ null;「業務部－張」→「業務部」。
 */
/**
 * 全形 → 半形:全形 ASCII(０-９Ａ-Ｚａ-ｚ、全形 dash － 等,U+FF01–FF5E)
 * 一律轉半形,全形空白 → 半形空白。讓「中信１」與「中信1」視為同一組名。
 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

export function extractPrefixKey(name: string): string | null {
  if (typeof name !== 'string') return null;
  // 先正規化全形/半形,再取 dash 之前 → 組名統一用半形,
  // 「中信１-王」「中信1-李」會落在同一組「中信1」。
  const normalized = toHalfWidth(name);
  const m = normalized.match(/^([^\-–—]+)[-–—]/);
  if (!m) return null;
  const key = m[1].trim();
  return key.length > 0 ? key : null;
}

/**
 * 決定一個 join 進來的人在 prefix 模式下歸哪組:
 * - 重連:名字已在某組 → 沿用原組。
 * - dash 前綴 → 找/建同名組;無 dash → 「其他」組。
 * 需要時即時建立新組(prefix 模式組數是長出來的)。回傳組名。
 */
export function pickTeamByPrefix(state: RoomState, name: string): string {
  const existing = state.groups.find((g) => g.members.includes(name));
  if (existing) return existing.name;
  const groupName = extractPrefixKey(name) ?? PREFIX_FALLBACK_GROUP;
  let group = state.groups.find((g) => g.name === groupName);
  if (!group) {
    group = {
      idx: state.groups.length,
      name: groupName,
      score: 0,
      members: [],
      leader: null,
    };
    state.groups.push(group);
  }
  return groupName;
}

/**
 * 依名字前綴把所有現連 participant 重新整組(切換到 prefix 模式時用)。
 * 清空 groups 後逐人 find-or-create,並把 participant.team 同步更新。
 * 「其他」組永遠排在最後(視覺上比較自然)。
 */
export function regroupByPrefix(state: RoomState): void {
  state.groups = [];
  for (const p of state.participants.values()) {
    const team = pickTeamByPrefix(state, p.name);
    p.team = team;
    const g = state.groups.find((x) => x.name === team)!;
    if (!g.members.includes(p.name)) g.members.push(p.name);
  }
  // 「其他」組挪到最後,重編 idx
  state.groups.sort((a, b) => {
    const af = a.name === PREFIX_FALLBACK_GROUP ? 1 : 0;
    const bf = b.name === PREFIX_FALLBACK_GROUP ? 1 : 0;
    return af - bf;
  });
  state.groups.forEach((g, i) => (g.idx = i));
}

/**
 * 補齊各組組長。**只填缺的,不動既有的** —— 這是 30 人實戰後的關鍵改版:
 * 舊版 assignLeaders 每次 game_start 都重抽,導致
 *   (a) 第一場開賽前的玩家池根本沒有組長可顯示(要按下開始才抽);
 *   (b) 第二場玩家池顯示的是第一場的組長,一按開始又被重抽成別人,
 *       台上台下對不起來。
 * 現在改成:一有組員就抽、抽定就固定,只有「組長不在名單裡了」
 * (離開/換組/被重新分組)才換人。24 小時穩定性由 server 存檔的
 * 保存期(STATE_MAX_AGE_MS)自然涵蓋。
 *
 * 挑人優先序:目前在線的組員 > 任何組員(暫時斷線的人仍可續任,
 * 他多半只是手機鎖屏)。回傳有變動的組名,呼叫端據此決定要不要廣播。
 */
export function ensureLeaders(state: RoomState): string[] {
  const online = new Set([...state.participants.values()].map((p) => p.name));
  const changed: string[] = [];
  for (const g of state.groups) {
    if (g.members.length === 0) {
      if (g.leader !== null) { g.leader = null; changed.push(g.name); }
      continue;
    }
    // 現任組長還在名單裡 → 留任(穩定優先)
    if (g.leader && g.members.includes(g.leader)) continue;
    const pool = g.members.filter((m) => online.has(m));
    const from = pool.length > 0 ? pool : g.members;
    g.leader = from[Math.floor(Math.random() * from.length)]!;
    changed.push(g.name);
  }
  return changed;
}

/**
 * 指定某一組強制重抽組長(助理端「重抽組長」按鈕)。會避開現任組長,
 * 除非該組只剩一個人。回傳新組長名;找不到組或空組回 null。
 */
export function redrawLeader(state: RoomState, teamName: string): string | null {
  const g = state.groups.find((x) => x.name === teamName);
  if (!g || g.members.length === 0) return null;
  const online = new Set([...state.participants.values()].map((p) => p.name));
  const others = g.members.filter((m) => m !== g.leader);
  const base = others.length > 0 ? others : g.members;
  const pool = base.filter((m) => online.has(m));
  const from = pool.length > 0 ? pool : base;
  g.leader = from[Math.floor(Math.random() * from.length)]!;
  return g.leader;
}

// ──────────────────────────────────────────────────────────────────────
// 搶答 MVP 累計
// ──────────────────────────────────────────────────────────────────────

/** 某輪 rush_winner:該組 personName 替全組搶下這輪 → +1。 */
export function tallyMvpWin(state: RoomState, teamIdx: number, name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.startsWith('(')) return;
  let perPerson = state.mvpTally.get(teamIdx);
  if (!perPerson) {
    perPerson = new Map();
    state.mvpTally.set(teamIdx, perPerson);
  }
  perPerson.set(name, (perPerson.get(name) ?? 0) + 1);
}

/** 算出某組的搶答 MVP(贏下最多輪者)。平手取先到該票數者。無資料 → null。 */
export function computeMvp(
  state: RoomState,
  teamIdx: number
): { name: string; wins: number } | null {
  const perPerson = state.mvpTally.get(teamIdx);
  if (!perPerson || perPerson.size === 0) return null;
  let best: { name: string; wins: number } | null = null;
  for (const [name, wins] of perPerson.entries()) {
    if (!best || wins > best.wins) best = { name, wins };
  }
  return best;
}

/**
 * Random redistribute every currently-connected participant across the
 * existing state.groups. Used after the assistant changes team count
 * (lobby only). Members are cleared first; participant.team is updated
 * in lockstep so subsequent state queries see the new assignment.
 */
export function reshuffleParticipants(state: RoomState): void {
  if (state.groups.length === 0) return;
  // 強制重新分組 = 全員隨機重洗:人被打散,賽前記分助理加減的評估分數已失去意義,
  // 一併歸零(Vincent 規格:自由分組按「重新分組」後,已加減的分數直接歸零)。
  // 前綴分組不走這裡(新前綴組是長出來的、既有組不動),故其分數不受影響。
  state.groups.forEach((g) => { g.members = []; g.score = 0; });
  const players = [...state.participants.values()];
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  players.forEach((p, i) => {
    const team = state.groups[i % state.groups.length];
    team.members.push(p.name);
    p.team = team.name;
  });
  // 重洗是「明示重分組」:整張裝置鎖表重建 —— 在線者鎖到新組;
  // 離線者舊鎖作廢(回來時依「最少人組」規則重新分配)。
  state.deviceTeams.clear();
  for (const p of players) {
    if (p.deviceId) {
      state.deviceTeams.set(p.deviceId, { name: p.name, team: p.team, at: Date.now() });
    }
  }
}

export function removeParticipantByConn(
  state: RoomState,
  connId: string
): ParticipantRef | null {
  const ref = state.participants.get(connId);
  if (!ref) return null;
  state.participants.delete(connId);
  // Don't strip from team.members; the player might reconnect with same
  // name/team. Roster cleanup happens at game_restart only.
  return ref;
}

/** prefix 模式:移除空組並重排(其他組永遠最後),重編 idx。random 模式不動。 */
function prunePrefixGroups(state: RoomState): void {
  if (state.groupingMode !== 'prefix') return;
  state.groups = state.groups.filter((g) => g.members.length > 0);
  state.groups.sort((a, b) => {
    const af = a.name === PREFIX_FALLBACK_GROUP ? 1 : 0;
    const bf = b.name === PREFIX_FALLBACK_GROUP ? 1 : 0;
    return af - bf;
  });
  state.groups.forEach((g, i) => (g.idx = i));
}

/**
 * 參賽者改自己的名字。prefix 模式依新名字重新歸組(可能換組、清空組);
 * random 模式留在原組只換顯示名。回傳異動明細供廣播。
 */
export function renameParticipant(
  state: RoomState,
  connId: string,
  rawNewName: string
): { ok: boolean; oldName?: string; newName?: string; oldTeam?: string; newTeam?: string; reason?: string } {
  const ref = state.participants.get(connId);
  if (!ref) return { ok: false, reason: 'not_found' };
  const newName = (rawNewName || '').trim();
  if (!newName) return { ok: false, reason: 'empty' };
  if (newName.length > 20) return { ok: false, reason: 'too_long' };
  if (newName === ref.name) return { ok: false, reason: 'unchanged' };
  // 重名檢查(2026-07-23 加):名字是分組、計分、MVP 的鍵值,同名兩個人
  // 會讓名單、組長標記、統計全部混在一起,現場也分不出誰是誰。
  // 實測可以把自己改成別組某個人的名字,還會被顯示成那一組的組長。
  const taken =
    [...state.participants.values()].some((p) => p.connId !== connId && p.name === newName) ||
    state.groups.some((g) => g.members.includes(newName));
  if (taken) return { ok: false, reason: 'duplicate' };

  const oldName = ref.name;
  const oldTeam = ref.team;
  // 從舊組摘掉舊名
  const oldGroup = state.groups.find((g) => g.name === oldTeam);
  if (oldGroup) oldGroup.members = oldGroup.members.filter((m) => m !== oldName);

  // 決定新組
  let newTeam: string;
  if (state.groupingMode === 'prefix') {
    newTeam = pickTeamByPrefix(state, newName);   // find-or-create
  } else {
    newTeam = oldTeam;   // random 模式不換組
  }
  const newGroup = state.groups.find((g) => g.name === newTeam);
  if (newGroup && !newGroup.members.includes(newName)) newGroup.members.push(newName);

  ref.name = newName;
  ref.team = newTeam;
  // 裝置鎖同步新名字/新組(prefix 模式改名可能換組)
  if (ref.deviceId) {
    state.deviceTeams.set(ref.deviceId, { name: newName, team: newTeam, at: Date.now() });
  }

  prunePrefixGroups(state);
  return { ok: true, oldName, newName, oldTeam, newTeam };
}

/**
 * 硬移除參賽者(改名逾時自踢用):從 participants 與組員名單一併摘掉,
 * prefix 模式空組順手清掉。回傳被移除者的 name/team。
 */
export function hardRemoveParticipant(
  state: RoomState,
  connId: string
): { ok: boolean; name?: string; team?: string } {
  const ref = state.participants.get(connId);
  if (!ref) return { ok: false };
  state.participants.delete(connId);
  const g = state.groups.find((x) => x.name === ref.team);
  if (g) g.members = g.members.filter((m) => m !== ref.name);
  prunePrefixGroups(state);
  return { ok: true, name: ref.name, team: ref.team };
}

export function renameTeam(
  state: RoomState,
  oldName: string,
  newName: string
): { ok: boolean; reason?: string } {
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > 8) return { ok: false, reason: 'too_long' };

  // state.groups is only populated after game_start. Pre-game-start
  // (lobby phase, participant just logged in) the team registry doesn't
  // exist yet — but the participants Map already has each player's
  // claimed team name, so we can still rename by updating those.
  const team = state.groups.find((g) => g.name === oldName);
  const affectedParticipants = [...state.participants.values()].filter(
    (p) => p.team === oldName
  );

  if (!team && affectedParticipants.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  if (team) team.name = trimmed;
  for (const p of affectedParticipants) {
    p.team = trimmed;
  }
  // 裝置鎖表的組名一併改掉,否則鎖著舊組名的裝置重連時查不到組會被亂分
  for (const lock of state.deviceTeams.values()) {
    if (lock.team === oldName) lock.team = trimmed;
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────
// Snapshot for __room_state__ welcome push
// ──────────────────────────────────────────────────────────────────────

export function snapshot(
  state: RoomState,
  onlineAssistantIds: Set<string> = new Set()
): RoomStateSnapshot {
  // members[] 是「黏著名單」(含暫時斷線的人),用來讓他回來時分到原組 ——
  // 這個設計要保留。但過去 snapshot 直接把整份黏著名單送給新連線,而
  // 一直在線的端是靠 player_leave 事件把人刪掉的 → 兩邊名單永遠對不起來
  // (實測:在線的手機顯示 4 人、中途重連的手機顯示 5 人,多出一個早就離開的)。
  // 這裡額外附上「目前真的連著的人」,三端一律用 onlineMembers 顯示名單與人數。
  const online = new Set([...state.participants.values()].map((p) => p.name));
  return {
    phase: state.phase,
    game: state.game,
    groups: state.groups.map((g) => ({
      idx: g.idx,
      name: g.name,
      score: g.score,
      leader: g.leader,
      mvp: computeMvp(state, g.idx),
      members: [...g.members],
      onlineMembers: g.members.filter((m) => online.has(m)),
    })),
    currQ: state.currQ,
    totalQ: state.game?.totalQ ?? 0,
    rushMode: state.rushMode,
    rushModeActual: state.rushModeActual,
    currentQuestion: state.currentQuestion,
    currentCat: state.currentCat,
    catLocked: state.catLocked,
    purgArmed: state.purgArmed,
    participants: [...state.participants.values()].map((p) => ({
      name: p.name,
      team: p.team,
    })),
    askedIds: [...state.usedIds],
    presenterClaimed: state.presenterClaimed,
    groupingMode: state.groupingMode,
    onboardingEnabled: state.onboardingEnabled,
    timerRemainingSec: state.timerDeadline
      ? Math.max(0, Math.ceil((state.timerDeadline - Date.now()) / 1000))
      : 0,
    // Topic-domain frameworks: read once at module load from bank metadata,
    // shipped on every snapshot so clients don't need their own copy.
    frameworks: { A: [...FRAMEWORKS_A], B: [...FRAMEWORKS_B] },
    branding: { titlePrefix: BRANDING.titlePrefix, titleSuffix: BRANDING.titleSuffix },
    assistants: assistantList(state, onlineAssistantIds),
    chiefId: state.chiefId,
    groupWatch: groupWatchPayload(state),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Persistence — DO 重啟(deploy / eviction / dev hot-reload)後還原遊戲
// ──────────────────────────────────────────────────────────────────────
// 中場 deploy 或 DO 被回收會讓 in-memory state 歸零,所有指令撞
// 「不能在 lobby 階段送」(user-reported)。核心遊戲狀態存 room storage,
// onStart 還原。不存的:rushSession(有活 timer,重啟後由助理重新開始
// 搶答)、participants(連線層資料,重連後由 player_join / onConnect 重建)。

export interface PersistedState {
  v: 1;
  savedAt: number;
  roomId: string;
  controlCode: string;
  assistantCode: string;
  createdAt: number;
  phase: Phase;
  game: GameConfig | null;
  groupingMode: GroupingMode;
  /** 舊存檔沒有這欄 → hydrate 時視為 false(預設關閉)。 */
  onboardingEnabled?: boolean;
  groups: TeamState[];
  currQ: number;
  currentQuestion: RoomState['currentQuestion'];
  currentCat: string | null;
  catLocked: boolean;
  purgArmed: boolean;
  usedIds: string[];
  askedQuestions: RoomState['askedQuestions'];
  wordGameAsked: number;
  mvpTally: [number, [string, number][]][];
  timerDeadline: number | null;
  rebuzzPending: boolean;
  excludedTeams: number[];
  lastBuzzWinnerTeam: number | null;
  rushMode: RushMode;
  rushModeActual: ActualRushMode | null;
  presenterClaimed: boolean;
  /** 裝置鎖組表(此欄位加入前的舊存檔沒有 → hydrate 時給空表)。 */
  deviceTeams?: [string, DeviceTeamLock][];
  /** 助理名冊(此欄位加入前的舊存檔沒有 → hydrate 時給空表)。 */
  assistants?: AssistantRec[];
  /** 總助理 assistantId(舊存檔沒有 → null)。 */
  chiefId?: string | null;
}

export function dehydrateState(state: RoomState): PersistedState {
  return {
    v: 1,
    savedAt: Date.now(),
    roomId: state.roomId,
    controlCode: state.controlCode,
    assistantCode: state.assistantCode,
    createdAt: state.createdAt,
    phase: state.phase,
    game: state.game,
    groupingMode: state.groupingMode,
    onboardingEnabled: state.onboardingEnabled,
    groups: state.groups.map((g) => ({ ...g, members: [...g.members] })),
    currQ: state.currQ,
    currentQuestion: state.currentQuestion,
    currentCat: state.currentCat,
    catLocked: state.catLocked,
    purgArmed: state.purgArmed,
    usedIds: [...state.usedIds],
    askedQuestions: [...state.askedQuestions],
    wordGameAsked: state.wordGameAsked,
    mvpTally: [...state.mvpTally.entries()].map(([idx, m]) => [idx, [...m.entries()]]),
    timerDeadline: state.timerDeadline,
    rebuzzPending: state.rebuzzPending,
    excludedTeams: [...state.excludedTeams],
    lastBuzzWinnerTeam: state.lastBuzzWinnerTeam,
    rushMode: state.rushMode,
    rushModeActual: state.rushModeActual,
    presenterClaimed: state.presenterClaimed,
    deviceTeams: [...pruneDeviceTeams(state.deviceTeams).entries()],
    assistants: [...pruneAssistants(state.assistants).values()].map((a) => ({ ...a })),
    chiefId: state.chiefId,
  };
}

/** 還原存檔到 in-memory state。transient 欄位重置:rushSession=null、
 *  participants 清空(重連後重建)。phase 若停在 rushing(搶答仲裁中),
 *  timer 已隨舊 DO 消失 → 退回 idle,助理重按「開始搶答」即可。 */
export function hydrateState(state: RoomState, saved: PersistedState): void {
  state.roomId = saved.roomId;
  state.controlCode = saved.controlCode;
  // 舊存檔(此欄位加入前)沒有 assistantCode → 保留 createInitialState 剛產的那組
  if (saved.assistantCode) state.assistantCode = saved.assistantCode;
  state.createdAt = saved.createdAt;
  state.phase = saved.phase === 'rushing' ? 'idle' : saved.phase;
  state.game = saved.game;
  state.groupingMode = saved.groupingMode;
  state.onboardingEnabled = saved.onboardingEnabled === true;   // 舊存檔 → 預設關閉
  state.groups = saved.groups.map((g) => ({ ...g, members: [...g.members] }));
  state.currQ = saved.currQ;
  state.currentQuestion = saved.currentQuestion;
  state.currentCat = saved.currentCat;
  state.catLocked = saved.catLocked;
  state.purgArmed = saved.purgArmed;
  state.usedIds = new Set(saved.usedIds);
  state.askedQuestions = [...saved.askedQuestions];
  state.wordGameAsked = saved.wordGameAsked;
  state.mvpTally = new Map(saved.mvpTally.map(([idx, m]) => [idx, new Map(m)]));
  // 倒數截止已過(重啟耗掉的時間)→ 清掉,避免還原後立刻誤響鬧鐘
  state.timerDeadline =
    saved.timerDeadline && saved.timerDeadline > Date.now() ? saved.timerDeadline : null;
  state.rebuzzPending = saved.rebuzzPending;
  state.excludedTeams = [...saved.excludedTeams];
  state.lastBuzzWinnerTeam = saved.lastBuzzWinnerTeam;
  state.rushMode = saved.rushMode;
  state.rushModeActual = saved.rushModeActual;
  state.presenterClaimed = saved.presenterClaimed;
  state.rushSession = null;
  state.participants = new Map();
  // 舊存檔沒有 deviceTeams → 空表;有 → 還原並清掉過期鎖
  state.deviceTeams = pruneDeviceTeams(new Map(saved.deviceTeams ?? []));
  // 助理名冊:還原並清掉過期(>24h)紀錄;修掉指向已 prune 者的 chiefId。
  state.assistants = pruneAssistants(
    new Map((saved.assistants ?? []).map((a) => [a.id, { ...a }]))
  );
  state.chiefId =
    saved.chiefId && state.assistants.has(saved.chiefId) ? saved.chiefId : null;
}
