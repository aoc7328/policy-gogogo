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
}

// ──────────────────────────────────────────────────────────────────────
// Room state — the single source of truth per Durable Object
// ──────────────────────────────────────────────────────────────────────

export interface RoomState {
  roomId: string;
  controlCode: string;
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

  // Rush mode selection (UI choice) + resolved mode for current/last rush
  rushMode: RushMode;
  rushModeActual: ActualRushMode | null;

  // Active rush; null when no rush running.
  rushSession: RushSession | null;

  // Live participants (by connection). Used for player_leave broadcasts.
  participants: Map<string, ParticipantRef>;

  // True after someone has successfully claimed the presenter role for this
  // room. Persists across game_restart (presenter is per-room infra, not
  // per-game) — only resets when the DurableObject itself is destroyed.
  presenterClaimed: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────

export function createInitialState(roomId: string, controlCode: string): RoomState {
  return {
    roomId,
    controlCode,
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
    rushMode: 'speed',
    rushModeActual: null,
    rushSession: null,
    participants: new Map(),
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
  state.groups = config.groups.map((g, i) => ({
    idx: i,
    name: g.name,
    score: 0,
    members: [],
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
  const fresh = createInitialState(state.roomId, state.controlCode);
  Object.assign(state, fresh, {
    participants: state.participants,
    presenterClaimed: state.presenterClaimed,
    groupingMode: prevGroupingMode,
  });
  // prefix 模式:重新開始後把仍在線的 participant 依名字前綴重新整組
  // (random 模式維持舊行為:groups 留空,game_start/改組數時再重建)。
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
  team: string
): void {
  state.participants.set(connId, { connId, name, team, joinedAt: Date.now() });
  // If a game is in progress, add to team roster too.
  const teamRow = state.groups.find((g) => g.name === team);
  if (teamRow && !teamRow.members.includes(name)) {
    teamRow.members.push(name);
  }
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
export function extractPrefixKey(name: string): string | null {
  if (typeof name !== 'string') return null;
  const m = name.match(/^([^\-–—－]+)[-–—－]/);
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
    // Topic-domain frameworks: read once at module load from bank metadata,
    // shipped on every snapshot so clients don't need their own copy.
    frameworks: { A: [...FRAMEWORKS_A], B: [...FRAMEWORKS_B] },
    branding: { titlePrefix: BRANDING.titlePrefix, titleSuffix: BRANDING.titleSuffix },
  };
}
