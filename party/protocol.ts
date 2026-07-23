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
/**
 * 分組方式:
 * - 'random'  隨機平均(現有預設):最少人組優先 + 隨機平手,人數均衡。
 * - 'prefix'  依名稱前綴:名字 dash「-」之前的文字相同者同組;無 dash 者
 *             一律進「其他」組。組數由名字自動長出來,不吃「分幾組」設定。
 */
export type GroupingMode = 'random' | 'prefix';
/** 無 dash 落單者的統一收容組名 */
export const PREFIX_FALLBACK_GROUP = '其他';
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
  /** 分組方式(預設 'random')。'prefix' 時 groups 由名字前綴決定。 */
  groupingMode?: GroupingMode;
  /**
   * 答題倒數各題型預設秒數(進場前設、遊戲中鎖)。0 = 該題型不計時。
   * 純前端使用(助理依此決定每題的 set_timer 秒數);放進 config 是為了
   * 讓多助理/重連端共用同一份預設,避免不同助理各送不同秒數打架。
   * server 不解析內容,整份 config 透傳/快照;欄位皆 optional,相容
   * 改版前只帶 {calculation, essay, other} 的舊存檔。
   */
  timerDefaults?: {
    word_game?: number;
    multiple_choice?: number;
    short_answer?: number;
    calculation?: number;
    essay?: number;
  };
  /**
   * 一字千金 (word_game) per-game cap for non-custom modes.
   * null / undefined = unlimited (legacy behavior); 0 = never pick;
   * N>0 = once N word_game questions have been picked this game, the
   * picker excludes the type. Custom mode ignores this (it has its own
   * customTypes whitelist).
   */
  wordGameCap?: number | null;
}

export interface TeamScore {
  idx: number;
  name: string;
  score: number;
  /** 組長(開賽時隨機抽,代表上臺領獎)。null = 該組尚無組長/無成員。 */
  leader?: string | null;
  /** 全組搶答 MVP(替全組贏下最多輪者)+ 輪數。null = 尚無搶答貢獻。 */
  mvp?: { name: string; wins: number } | null;
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
 *
 * reshuffle 語意(30 人實戰後加上):
 * - reshuffle:true  = 助理明確按了「重新分組」→ 即使組數沒變也全員重洗。
 * - 省略/false      = 同步性質(如 bootstrap 初始化)→ 組數與現況相同時
 *                     server 直接忽略,不得重洗名單。過去助理端每次重連都
 *                     自動送這個指令,造成全場玩家被反覆隨機重分組。
 */
export type TeamCountChangedCommand = {
  type: 'team_count_changed';
  payload: { count: number; reshuffle?: boolean };
  controlCode?: string;
};

/**
 * Assistant switches grouping method (lobby only).
 * - 'random': re-create `count` teams and reshuffle everyone evenly.
 * - 'prefix': regroup all current participants by name prefix.
 * Server broadcasts roster_reshuffled with the resulting groups.
 */
export type GroupingModeChangedCommand = {
  type: 'grouping_mode_changed';
  payload: { mode: GroupingMode; count?: number };
} & PrivilegedHeader;

/** 整組通知種類:'rename' 改名通知(30秒倒數+逾時踢出);'confirm' 軟性確認(不踢人)。 */
export type GroupNoticeKind = 'rename' | 'confirm';

/**
 * 助理對某一整組發通知(lobby 或進行中皆可)。server 廣播 group_notice,
 * 該組所有參賽者畫面跳出提示。
 */
export type NotifyGroupCommand = {
  type: 'notify_group';
  payload: { team: string; kind: GroupNoticeKind };
} & PrivilegedHeader;

/**
 * 參賽者改自己的「名字」(不是組名)。prefix 模式下 server 會依新名字
 * 重新歸組;random 模式則留在原組只換顯示名。
 */
export type RenameSelfCommand = {
  type: 'rename_self';
  payload: { newName: string };
};

/**
 * 參賽者主動離開(改名通知逾時自踢)。server 硬移除(從 participants 與
 * 組員名單一併摘掉、prefix 模式空組順手清掉),然後關閉連線。
 */
export type LeaveRoomCommand = {
  type: 'leave_room';
  payload: { reason?: string };
};

/**
 * 助理設定答題倒數計時。durationSec > 0 = (重新)開始倒數;0 = 停止。
 * server 記下 deadline 並廣播 timer_update;投影/參賽者端顯示倒數,
 * 歸零時投影端響鬧鐘。
 */
export type SetTimerCommand = {
  type: 'set_timer';
  payload: { durationSec: number };
} & PrivilegedHeader;

/**
 * 同一題重新搶答:保留當前題目,重新開放搶答(答題者答不出來時用)。
 * server 保留 currentQuestion/currentCat,設 rebuzzPending,跑一輪 rush。
 */
export type RebuzzSameCommand = {
  type: 'rebuzz_same';
} & PrivilegedHeader;

/**
 * 重新搶答後回到同一題作答(助理在 winner 卡片後送)。server 把 phase
 * 拉回 answering(rush 模組會把它設成 won),並廣播 resume_question。
 */
export type ResumeQuestionCommand = {
  type: 'resume_question';
} & PrivilegedHeader;

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

/**
 * 統一的工作人員登入(參賽者端「投影或助理登入」)。輸入的 code 決定路由:
 *   code === controlCode   → 投影端(presenter.html)
 *   code === assistantCode → 助理端(assistant.html)
 * 伺服器以私訊 __staff_route__ 回覆目的地(見 StaffRouteEvent)。
 * 非特權指令:code 本身就是憑證(同 claim_presenter 的設計)。
 */
export type StaffLoginCommand = {
  type: 'staff_login';
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
  | GroupingModeChangedCommand
  | NotifyGroupCommand
  | RenameSelfCommand
  | LeaveRoomCommand
  | SetTimerCommand
  | RebuzzSameCommand
  | ResumeQuestionCommand
  | ClaimPresenterCommand
  | StaffLoginCommand;

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
    controlCode?: string;       // present only when sent to assistant (投影端控制碼)
    assistantCode?: string;     // present only when sent to assistant (助理端控制碼,房間分頁顯示)
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
  /** 當前分組方式(lobby 設定;late-join 端據此還原 UI)。 */
  groupingMode: GroupingMode;
  /** 答題倒數剩餘秒數(0 = 無倒數);late-join 端據此續跑。 */
  timerRemainingSec: number;
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

/**
 * Private reply to a `ping` command (sent only to the pinging connection).
 * Powers the client-side keepalive in PartyBus: clients ping when the
 * socket has been idle, and treat prolonged total silence (no pong, no
 * broadcasts) as a half-dead TCP connection → force reconnect so the
 * `__room_state__` snapshot restores the screen immediately, instead of
 * waiting ~30s+ for the browser to notice the dead socket on its own.
 */
export type PongEvent = {
  type: '__pong__';
  payload: { t: number };
};

/**
 * 私訊回覆 staff_login:告訴發送端該導向哪個介面。
 * dest='presenter' 時附 controlCode(presenter.html 特權指令簽章用)。
 */
export type StaffRouteEvent = {
  type: '__staff_route__';
  payload: { dest: 'presenter' | 'assistant'; controlCode?: string };
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
    groups: { name: string; score: number; members: string[]; leader?: string | null; mvp?: { name: string; wins: number } | null }[];
    sortedGroups: { name: string; score: number; leader?: string | null; mvp?: { name: string; wins: number } | null }[];
    askedQuestions: { id: string; difficulty: Difficulty; framework: string }[];
    exportTime: string;
  };
};

/**
 * Broadcast right after game_start: the randomly-chosen leader for each group.
 * Participants mark the leader in the roster (and tell the leader themselves);
 * the presenter end screen shows each group's leader for the prize ceremony.
 */
export type GroupLeadersEvent = {
  type: 'group_leaders';
  payload: { leaders: { name: string; leader: string | null }[] };  // name = group name
};

/** 整組通知 → 廣播給該組所有參賽者。deadlineMs:rename 種類的倒數(0=不倒數)。 */
export type GroupNoticeEvent = {
  type: 'group_notice';
  payload: { team: string; kind: GroupNoticeKind; deadlineMs: number };
};

/** 某參賽者改名(可能伴隨換組)→ 三端更新名單 + 助理進退場紀錄。 */
export type PlayerRenamedEvent = {
  type: 'player_renamed';
  payload: { oldName: string; newName: string; oldTeam: string; newTeam: string };
};

/** 答題倒數狀態。remainingSec > 0 = 開始/續跑倒數;0 = 停止/隱藏。 */
export type TimerUpdateEvent = {
  type: 'timer_update';
  payload: { remainingSec: number };
};

/** 同一題重新搶答後,回到該題作答畫面(投影/參賽者重新顯示原題)。 */
export type ResumeQuestionEvent = {
  type: 'resume_question';
  payload: Record<string, never>;
};

/**
 * 本輪搶答的「失格組」名單(組名)。重新搶答時,答不出來的組會被列入,
 * 該組參賽者的搶答鈕不解鎖、server 也擋掉他們的 buzz。每次 rush 開始時
 * 廣播當前名單(一般搶答為空陣列)。
 */
export type BuzzLockoutEvent = {
  type: 'buzz_lockout';
  payload: { teams: string[] };
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
  | PongEvent
  | StaffRouteEvent
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
  | RosterReshuffledEvent
  | GroupLeadersEvent
  | GroupNoticeEvent
  | PlayerRenamedEvent
  | TimerUpdateEvent
  | ResumeQuestionEvent
  | BuzzLockoutEvent;

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
  'grouping_mode_changed',
  'notify_group',
  'set_timer',
  'rebuzz_same',
  'resume_question',
]);

export function isPrivilegedCommand(
  cmd: ClientCommand
): cmd is ClientCommand & PrivilegedHeader {
  return PRIVILEGED_COMMAND_TYPES.has(cmd.type);
}
