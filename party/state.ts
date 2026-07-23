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
  Difficulty,
  GameConfig,
  GroupingMode,
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
  askedQuestions: { id: string; difficulty: Difficulty; framework: string }[];
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
  };
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
  const prevMembers = new Map<string, string[]>(
    state.groups.map((g) => [g.name, [...g.members]])
  );
  state.groups = config.groups.map((g, i) => ({
    idx: i,
    name: g.name,
    score: 0,
    members: prevMembers.get(g.name) ?? [],
    leader: null,
  }));
  // Re-attach existing participants to their teams (preserve roster across
  // game_start so participants who joined before pressing start aren't lost).
  for (const p of state.participants.values()) {
    const team = state.groups.find((g) => g.name === p.team);
    if (team && !team.members.includes(p.name)) team.members.push(p.name);
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
    groupingMode: prevGroupingMode,
    // 組別結構+成員跨「重新開始」保留、只歸零分數與組長(30 人實戰教訓:
    // 兩場之間組員必須不變,否則獎勵沒辦法發)。舊行為是清空 groups 等
    // 助理重新設定,結果第二場全員被隨機重洗。要打散重分 → 助理按
    // 「重新分組」按鈕(明示 reshuffle)。
    groups: state.groups.map((g) => ({
      ...g,
      score: 0,
      leader: null,
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
 */
export function setupTeams(state: RoomState, count: number): void {
  const newGroups: TeamState[] = [];
  for (let i = 0; i < count; i++) {
    const existing = state.groups[i];
    newGroups.push({
      idx: i,
      name: existing?.name ?? DEFAULT_TEAM_NAMES[i] ?? `第${i + 1}組`,
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
 * 開賽凍結名單時,為每組隨機抽一位成員當組長。
 * 空組 → leader = null。已抽過(重新呼叫)會重抽。
 */
export function assignLeaders(state: RoomState): void {
  for (const g of state.groups) {
    if (g.members.length === 0) {
      g.leader = null;
      continue;
    }
    g.leader = g.members[Math.floor(Math.random() * g.members.length)];
  }
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
  state.groups.forEach((g) => (g.members = []));
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

export function snapshot(state: RoomState): RoomStateSnapshot {
  return {
    phase: state.phase,
    game: state.game,
    groups: state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score, leader: g.leader, mvp: computeMvp(state, g.idx) })),
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
    timerRemainingSec: state.timerDeadline
      ? Math.max(0, Math.ceil((state.timerDeadline - Date.now()) / 1000))
      : 0,
    // Topic-domain frameworks: read once at module load from bank metadata,
    // shipped on every snapshot so clients don't need their own copy.
    frameworks: { A: [...FRAMEWORKS_A], B: [...FRAMEWORKS_B] },
    branding: { titlePrefix: BRANDING.titlePrefix, titleSuffix: BRANDING.titleSuffix },
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
}
