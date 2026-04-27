/**
 * protocol.ts — wire-format types for the PartyBus event contract.
 *
 * Mirrors EVENTS.md verbatim. Two surfaces:
 *   - ClientCommand: messages the client sends to the server
 *   - ServerEvent:   messages the server broadcasts (or privately sends) to clients
 *
 * Privileged ClientCommand variants carry a `controlCode` string. The server
 * verifies it against the room's stored controlCode (see auth.ts) before
 * mutating state.
 */

// ──────────────────────────────────────────────────────────────────────
// Domain primitives
// ──────────────────────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard' | 'hell' | 'purgatory';
export type GameMode = 'ordinary' | 'hell' | 'paradise' | 'custom';
export type RushMode = 'speed' | 'count' | 'lightning' | 'allhands' | 'random';
export type ActualRushMode = Exclude<RushMode, 'random'>;
export type ConnectionRole = 'assistant' | 'presenter' | 'participant';

export type Phase =
  | 'lobby'      // before game_start
  | 'idle'      // game running, waiting for next rush
  | 'rushing'   // rush session armed/active
  | 'won'       // winner card displayed (3.5s)
  | 'picking'   // category grid open
  | 'answering' // question on screen, waiting for reveal
  | 'revealed'  // answer + explanation shown
  | 'ended';    // game over

export interface GameConfig {
  mode: GameMode;
  customTiers: Difficulty[];
  customTypes: string[];
  totalQ: number;
  spq: number;                        // score per question
  groups: { name: string }[];
  rushMode: RushMode;
}

export interface TeamScore {
  idx: number;
  name: string;
  score: number;
}

// ──────────────────────────────────────────────────────────────────────
// ClientCommand variants (client → server)
// ──────────────────────────────────────────────────────────────────────

export interface PrivilegedHeader {
  controlCode: string;
}

// Diagnostic
export type PingCommand = {
  type: 'ping';
  payload: { from: ConnectionRole; msg?: string };
};

// Assistant — privileged ones
export type GameStartCommand = {
  type: 'game_start';
  payload: GameConfig;
} & PrivilegedHeader;

export type ScoreAdjustCommand = {
  type: 'score_adjust';
  payload: { teamIdx: number; delta: number };
} & PrivilegedHeader;

export type StartRushCommand = {
  type: 'start_rush';
  payload?: { rerush?: boolean };
} & PrivilegedHeader;

export type EnterCategoryCommand = {
  type: 'enter_category';
} & PrivilegedHeader;

export type CategoryPreviewCommand = {
  type: 'category_preview';
  payload: { fid: string };
} & PrivilegedHeader;

export type CategoryConfirmCommand = {
  type: 'category_confirm';
  payload: { fid: string };
} & PrivilegedHeader;

export type CategoryResetCommand = {
  type: 'category_reset';
} & PrivilegedHeader;

export type RevealAnswerCommand = {
  type: 'reveal_answer';
} & PrivilegedHeader;

export type NextQuestionCommand = {
  type: 'next_question';
} & PrivilegedHeader;

export type SkipQuestionCommand = {
  type: 'skip_question';
} & PrivilegedHeader;

export type GameRestartCommand = {
  type: 'game_restart';
} & PrivilegedHeader;

// Phase 0 Q4: assistant arms purgatory; consumed at next category_confirm.
export type ArmPurgatoryCommand = {
  type: 'arm_purgatory';
  payload: { armed: boolean };
} & PrivilegedHeader;

// Phase 4: redraw the current question. Removes its id from usedIds and
// re-picks from the same framework. Counter (state.currQ) NOT incremented
// for the redraw (still the same round, just different question).
export type RedrawQuestionCommand = {
  type: 'redraw_question';
} & PrivilegedHeader;

export type ModePreviewCommand = {
  type: 'mode_preview';
  payload: {
    mode: GameMode;
    customTiers?: Difficulty[];
    customTypes?: string[];
  };
} & PrivilegedHeader;

export type CustomTiersChangedCommand = {
  type: 'custom_tiers_changed';
  payload: { customTiers: Difficulty[]; customTypes: string[] };
} & PrivilegedHeader;

export type RushModeChangedCommand = {
  type: 'rush_mode_changed';
  payload: { mode: RushMode; label: string };
} & PrivilegedHeader;

export type PresenterShowQrCommand = {
  type: 'presenter_show_qr';
  payload: { durationMs: number };
} & PrivilegedHeader;

export type ExportResultCommand = {
  type: 'export_result';
} & PrivilegedHeader;

// Participant — unprivileged
export type PlayerJoinCommand = {
  type: 'player_join';
  // team is server-decided (auto-assigned by smallest-team logic).
  // Client may still send it for backwards compat; server ignores it.
  payload: { name: string; team?: string };
};

export type BuzzPressCommand = {
  type: 'buzz_press';
  payload: { name: string; team: string; ts: number };
};

export type TeamRenameCommand = {
  type: 'team_rename';
  payload: { oldName: string; newName: string; by: string };
  controlCode?: string;
};

/**
 * Assistant changes team count (lobby only). Server replaces state.groups
 * with N teams, randomly redistributes all currently-connected participants,
 * and broadcasts roster_reshuffled. Phase mismatch → __error__ to sender.
 */
export type TeamCountChangedCommand = {
  type: 'team_count_changed';
  payload: { count: number };
  controlCode?: string;
};

/**
 * Claim the presenter role for this room. Anyone can attempt; server checks
 * the embedded code matches state.controlCode AND that nobody has claimed yet.
 * On success, server broadcasts `presenter_claimed` (mutex flag for all
 * other participants' login button). On failure, server replies with __error__.
 *
 * NOT in the privileged-command set: the controlCode here is the user's
 * one-shot proof, not a session-level credential like the assistant's
 * controlCode. (Putting it in the privileged set would auto-attach the
 * assistant's controlCode to all assistant-side emits, which is wrong —
 * we want the user-typed code from the modal.)
 */
export type ClaimPresenterCommand = {
  type: 'claim_presenter';
  payload: { code: string };
};

export type ClientCommand =
  | PingCommand
  | GameStartCommand
  | ScoreAdjustCommand
  | StartRushCommand
  | EnterCategoryCommand
  | CategoryPreviewCommand
  | CategoryConfirmCommand
  | CategoryResetCommand
  | RevealAnswerCommand
  | NextQuestionCommand
  | SkipQuestionCommand
  | GameRestartCommand
  | ArmPurgatoryCommand
  | RedrawQuestionCommand
  | ModePreviewCommand
  | CustomTiersChangedCommand
  | RushModeChangedCommand
  | PresenterShowQrCommand
  | ExportResultCommand
  | PlayerJoinCommand
  | BuzzPressCommand
  | TeamRenameCommand
  | TeamCountChangedCommand
  | ClaimPresenterCommand;

// ──────────────────────────────────────────────────────────────────────
// ServerEvent variants (server → client)
// ──────────────────────────────────────────────────────────────────────

// Three "private" frames sent to a single connection (not broadcast).
// Their `type` strings start with `__` to mark them as transport-layer,
// not part of the original PartyBus contract.

export type WelcomeEvent = {
  type: '__welcome__';
  payload: {
    role: ConnectionRole;
    roomId: string;
    controlCode?: string;       // present only when sent to assistant
    serverTime: number;
  };
};

export interface RoomStateSnapshot {
  phase: Phase;
  game: GameConfig | null;
  groups: TeamScore[];
  currQ: number;                 // current question number (1-based; 0 before any pick)
  totalQ: number;
  rushMode: RushMode;
  rushModeActual: ActualRushMode | null;
  currentQuestion: {
    id: string;
    difficulty: Difficulty;
    framework: string;
  } | null;
  currentCat: string | null;
  catLocked: boolean;
  purgArmed: boolean;
  participants: { name: string; team: string }[];
  askedIds: string[];
  presenterClaimed: boolean;
  /**
   * Topic-domain frameworks read from quiz-bank-metadata.json's
   * topic_frameworks section.
   * - frameworksA: 1..9 labels for the 3x3 grid in normal modes.
   *   Fewer than 9 → trailing cells render empty/disabled in client UI.
   * - frameworksB: 1..4 labels for purgatory mode.
   * Server is authoritative — these are baked into the bundled bank at
   * `npm run deploy` time, NOT from client localStorage.
   */
  frameworks: { A: string[]; B: string[] };
  /**
   * Game title parts read from quiz-bank-metadata.json's branding section.
   * Three-end UI shows `{titlePrefix}{titleSuffix}` (e.g. "保險知識星攻略").
   * - titlePrefix: 1~4 chars, swap when changing topic
   * - titleSuffix: fixed 3 chars in the original design
   */
  branding: { titlePrefix: string; titleSuffix: string };
}

export type RoomStateEvent = {
  type: '__room_state__';
  payload: RoomStateSnapshot;
};

export type ErrorEvent = {
  type: '__error__';
  payload: { code: string; message: string; cause?: string };
};

/**
 * Sent privately to a participant connection that's being replaced by a
 * newer connection from the same browser (same deviceId). The receiving
 * tab should stop reconnecting and surface a "use the other tab" UI.
 */
export type KickedEvent = {
  type: '__kicked__';
  payload: { reason: 'replaced_by_new_tab' };
};

// Public broadcasts (match EVENTS.md verb-for-verb).

export type GameStartEvent = {
  type: 'game_start';
  payload: GameConfig;
};

export type ModePreviewEvent = {
  type: 'mode_preview';
  payload: ModePreviewCommand['payload'];
};

export type CustomTiersChangedEvent = {
  type: 'custom_tiers_changed';
  payload: CustomTiersChangedCommand['payload'];
};

export type RushModeChangedEvent = {
  type: 'rush_mode_changed';
  payload: RushModeChangedCommand['payload'];
};

export type ScoreUpdateEvent = {
  type: 'score_update';
  payload: { scores: TeamScore[]; changedIdx: number; delta: number };
};

export type StartRushEvent = {
  type: 'start_rush';
  payload: { rushMode: ActualRushMode; rerush?: boolean };
};

export type RushRevealEvent = {
  type: 'rush_reveal';
  payload: { rushMode: ActualRushMode; revealMs: number; rerush?: boolean };
};

export type RushTickEvent = {
  type: 'rush_tick';
  payload: {
    mode: 'count';
    teamCounts: { idx: number; name: string; count: number }[];
    remainingMs: number;
  };
};

export type RushWinnerSpeed = {
  groupIdx: number;
  groupName: string;
  rushMode: 'speed';
  personName: string;
  elapsedMs: number;
};

export type RushWinnerLightning = {
  groupIdx: number;
  groupName: string;
  rushMode: 'lightning';
  personName: string;
  pressedAtSec: number;
};

export type RushWinnerCount = {
  groupIdx: number;
  groupName: string;
  rushMode: 'count';
  personName: string;
  teamTotalClicks: number;
  mvpClicks: number;
  runnerUp?: { name: string; count: number };
};

export type RushWinnerAllhands = {
  groupIdx: number;
  groupName: string;
  rushMode: 'allhands';
  clusterCount: number;
  totalCount: number;
  endAtSec: number;
};

export type RushWinnerEvent = {
  type: 'rush_winner';
  payload:
    | RushWinnerSpeed
    | RushWinnerLightning
    | RushWinnerCount
    | RushWinnerAllhands;
};

export type LightningDisqualifyEvent = {
  type: 'lightning_disqualify';
  payload: { name: string; team: string; teamIdx: number; elapsedMs: number };
};

export type AllhandsProgressEvent = {
  type: 'allhands_progress';
  payload: {
    teamProgress: {
      idx: number;
      name: string;
      currentCluster: number;
      bestCluster: number;
      total: number;
    }[];
    remainingMs: number;
  };
};

export type EnterCategoryEvent = {
  type: 'enter_category';
  payload: Record<string, never>;
};

export type CategoryPreviewEvent = {
  type: 'category_preview';
  payload: { fid: string };
};

export type CategoryConfirmEvent = {
  type: 'category_confirm';
  payload: { fid: string };
};

export type CategoryResetEvent = {
  type: 'category_reset';
  payload: Record<string, never>;
};

export type QuestionPickEvent = {
  type: 'question_pick';
  payload: {
    id: string;
    difficulty: Difficulty;
    framework: string;
    roundQ: number;          // server 權威 currQ;client 直接 set 不 increment
    redraw?: boolean;        // true 表示這是 redraw_question 的回應(同一輪換題)
  };
};

export type PurgatorySummonEvent = {
  type: 'purgatory_summon';
  payload: Record<string, never>;
};

export type PurgatoryEndEvent = {
  type: 'purgatory_end';
  payload: Record<string, never>;
};

export type RevealAnswerEvent = {
  type: 'reveal_answer';
  payload: Record<string, never>;
};

export type NextQuestionEvent = {
  type: 'next_question';
  payload: Record<string, never>;
};

export type SkipQuestionEvent = {
  type: 'skip_question';
  payload: Record<string, never>;
};

export type GameRestartEvent = {
  type: 'game_restart';
  payload: Record<string, never>;
};

export type ExportResultEvent = {
  type: 'export_result';
  payload: {
    mode: GameMode;
    modeLabel: string;          // Chinese label: 普通 / 地獄 / 極樂 / 自由
    customTiers: Difficulty[];  // only meaningful when mode==='custom', else []
    customTypes: string[];      // only meaningful when mode==='custom', else []
    totalQ: number;
    spq: number;
    actualQ: number;
    groups: { name: string; score: number; members: string[] }[];
    sortedGroups: { name: string; score: number }[];
    askedQuestions: { id: string; difficulty: Difficulty; framework: string }[];
    exportTime: string;
  };
};

export type TeamRenameEvent = {
  type: 'team_rename';
  payload: { oldName: string; newName: string; by?: string };
};

export type PresenterShowQrEvent = {
  type: 'presenter_show_qr';
  payload: { durationMs: number };
};

export type PlayerJoinEvent = {
  type: 'player_join';
  payload: { name: string; team: string };
};

/**
 * Broadcast when someone successfully claims the presenter role.
 * All participants disable their "主持人登入" button on receipt.
 * Server also fires this immediately after init for late-joiners — they
 * also pick it up via __room_state__'s presenterClaimed field, but this
 * standalone event covers the case where they connected before claim.
 */
export type PresenterClaimedEvent = {
  type: 'presenter_claimed';
  payload: { at: number };
};

export type PlayerLeaveEvent = {
  type: 'player_leave';
  payload: { name: string; team: string };
};

/**
 * Broadcast after server reshuffles all participants across the team set
 * (e.g. assistant changed team count in lobby). Each participant scans
 * groups[].members[] for their own name to update G.team; assistant uses
 * the full snapshot to re-render the roster grid.
 */
export type RosterReshuffledEvent = {
  type: 'roster_reshuffled';
  payload: {
    groups: { idx: number; name: string; members: string[] }[];
  };
};

export type ServerEvent =
  | WelcomeEvent
  | RoomStateEvent
  | ErrorEvent
  | KickedEvent
  | GameStartEvent
  | ModePreviewEvent
  | CustomTiersChangedEvent
  | RushModeChangedEvent
  | ScoreUpdateEvent
  | StartRushEvent
  | RushRevealEvent
  | RushTickEvent
  | RushWinnerEvent
  | LightningDisqualifyEvent
  | AllhandsProgressEvent
  | EnterCategoryEvent
  | CategoryPreviewEvent
  | CategoryConfirmEvent
  | CategoryResetEvent
  | QuestionPickEvent
  | PurgatorySummonEvent
  | PurgatoryEndEvent
  | RevealAnswerEvent
  | NextQuestionEvent
  | SkipQuestionEvent
  | GameRestartEvent
  | ExportResultEvent
  | TeamRenameEvent
  | PresenterShowQrEvent
  | PlayerJoinEvent
  | PlayerLeaveEvent
  | PresenterClaimedEvent
  | RosterReshuffledEvent;

// ──────────────────────────────────────────────────────────────────────
// Privileged command type guard
// ──────────────────────────────────────────────────────────────────────

export const PRIVILEGED_COMMAND_TYPES = new Set<string>([
  'game_start',
  'score_adjust',
  'start_rush',
  'enter_category',
  'category_preview',
  'category_confirm',
  'category_reset',
  'reveal_answer',
  'next_question',
  'skip_question',
  'game_restart',
  'arm_purgatory',
  'redraw_question',
  'mode_preview',
  'custom_tiers_changed',
  'rush_mode_changed',
  'presenter_show_qr',
  'export_result',
  'team_count_changed',
]);

export function isPrivilegedCommand(
  cmd: ClientCommand
): cmd is ClientCommand & PrivilegedHeader {
  return PRIVILEGED_COMMAND_TYPES.has(cmd.type);
}
