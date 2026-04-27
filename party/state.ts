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
  Phase,
  RushMode,
  RoomStateSnapshot,
} from './protocol';
import { FRAMEWORKS_A, FRAMEWORKS_B } from './bank';

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
    groups: [],
    currQ: 0,
    currentQuestion: null,
    currentCat: null,
    catLocked: false,
    purgArmed: false,
    usedIds: new Set(),
    askedQuestions: [],
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
  state.groups = config.groups.map((g, i) => ({
    idx: i,
    name: g.name,
    score: 0,
    members: [],
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
  const fresh = createInitialState(state.roomId, state.controlCode);
  Object.assign(state, fresh, {
    participants: state.participants,
    presenterClaimed: state.presenterClaimed,
  });
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
    groups: state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
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
    // Topic-domain frameworks: read once at module load from bank metadata,
    // shipped on every snapshot so clients don't need their own copy.
    frameworks: { A: [...FRAMEWORKS_A], B: [...FRAMEWORKS_B] },
  };
}
