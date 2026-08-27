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
  /**
   * 抽題防重複(2026-08-27,兩場活動重複抽題的實戰回饋):
   * - excludeIds:助理端從賽後報告勾選場次後彙整的題號清單,開賽時直接
   *   種進 usedIds(上限 2000 筆,格式不符者靜默丟棄)。
   * - excludePrior:true = 一併排除「本房 24 小時內實際抽過的題」
   *   (server 端 roomAskedIds,跨「重新開始」累積 —— 報告掛了也不漏)。
   * 兩者取聯集。server 存 game 時會把 excludeIds 清掉(已種進 usedIds,
   * 不需要留在每份快照裡);廣播的 game_start 事件帶最終排除結果。
   */
  excludeIds?: string[];
  excludePrior?: boolean;
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
  /** completeRound 僅由 25% / 50% / 100% 判定送出；人工 +/- 不會消耗題數。 */
  payload: { teamIdx: number; delta: number; completeRound?: boolean };
} & PrivilegedHeader;

/**
 * 開始/重新搶答。
 * - rerush:false(開始搶答)= 新一輪:清空本輪失格名單。僅 idle/rushing/
 *   won/picking 階段接受。
 * - rerush:true(重新搶答/重新這一次)= 同一輪重跑這一次搶答:保留失格
 *   名單。額外接受 answering/revealed 階段 —— 此時先棄置當前題目(標記
 *   replaced、清 currentQuestion/currentCat、停倒數)再重開搶答,
 *   供「抽了題但這一次要作廢重來」的現場恢復用。
 */
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
 * 不計分後的「重新搶答(換新題)」:當前答題組答錯 → 列入本輪失格名單,
 * 原題與分類就此結束(答案已公佈,不能再拿同一題比),重新開放其餘隊伍
 * 搶答。勝隊由助理重新選九宮格抽新題;題號(currQ)不前進 —— 仍是同一個
 * 未完成回合。2026-08-27 前的舊行為(保留原題、勝者回同一題作答)已廢除:
 * 現場實測答案公佈後根本沒辦法繼續玩。
 */
export type RebuzzSameCommand = {
  type: 'rebuzz_same';
} & PrivilegedHeader;

/** Ends an exhausted, revealed question and starts a fresh all-team rush. */
export type FreshRushCommand = {
  type: 'fresh_rush';
} & PrivilegedHeader;

/**
 * 重新這一輪:把「當前這個未完成回合」整個作廢,回到本輪起點。
 * 清除本輪失格名單、當前題目/分類/搶答與答題倒數,phase 回 idle;
 * 分數與題號(currQ)不變、已計分的判定不撤銷。僅 rushing/won/picking/
 * answering/revealed 接受(idle 沒有東西可重置)。server 廣播 round_reset
 * 事件,三端回到待命畫面。
 */
export type RoundResetCommand = {
  type: 'round_reset';
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
 * 助理端開關「參賽者新手導覽」。預設關閉(30 人實戰:年長學員多半不看,
 * 反而擋住畫面)。關閉時參賽者端不自動跳導覽,但頂部「?」仍可自行叫出。
 */
export type SetOnboardingCommand = {
  type: 'set_onboarding';
  payload: { enabled: boolean };
} & PrivilegedHeader;

/**
 * 助理端「再加一題」:題數用完後臨場追加題目(控時用)。server 把
 * game.totalQ 加 n 並廣播 total_q_changed。可無限追加 —— 總分上限會跟著
 * 變動,這是刻意的(現場控時優先於分數美觀)。
 */
export type AddQuestionCommand = {
  type: 'add_question';
  payload?: { n?: number };
} & PrivilegedHeader;

/**
 * 清空「本房已抽過的題」累積名單(roomAskedIds)。同一房要對新一批學員
 * 重用舊題時按;正常情況房間 24 小時過期自動歸零,不必手動清。
 * server 清完把快照重推給所有端(設定頁的累計數字即時歸零)。
 */
export type ClearPriorAskedCommand = {
  type: 'clear_prior_asked';
} & PrivilegedHeader;

/**
 * 助理端「重新同步」:把 server 的權威狀態重推給所有還連著的端。
 * 用於「上一場結束後有人卡在結算頁」這類畫面錯位 —— 免去請學員手動重整。
 * 注意:只推得到「WebSocket 還活著」的端;連線真的死掉的手機收不到,
 * 得等它自己的 keepalive 重連(最多 25 秒)才會被快照救回。
 * server 以私訊 __resync_report__ 回報實際推送到幾個端(兼作點名工具)。
 */
export type ResyncAllCommand = {
  type: 'resync_all';
} & PrivilegedHeader;

/**
 * 助理端「重抽組長」:指定某一組重新隨機抽組長(會避開現任,除非只剩一人)。
 * 用於組長中離不回來、或現場臨時要換人代表領獎。server 回廣播 group_leaders。
 */
export type ReassignLeaderCommand = {
  type: 'reassign_leader';
  payload: { team: string };
} & PrivilegedHeader;

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
  | FreshRushCommand
  | RoundResetCommand
  | ReassignLeaderCommand
  | ResyncAllCommand
  | AddQuestionCommand
  | ClearPriorAskedCommand
  | SetOnboardingCommand
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
  /**
   * groups 帶 members(名字為準的權威組員名單,「暫時斷線的人也還是
   * 組員」)。30 人實戰的「幽靈組員」修正:過去 client 只能拿 participants
   * (在線連線名單)重建組員畫面,斷線中的人就從所有人的名單上消失。
   *
   * onlineMembers = members 之中「此刻真的連著」的子集(2026-07-23 加)。
   * members 是黏著的、只增不減(要靠它把回來的人分回原組),所以拿它畫名單
   * 會出現「一直在線的手機顯示 4 人、中途重連的手機顯示 5 人」的矛盾。
   * **三端顯示名單與人數一律用 onlineMembers**;members 只給分組邏輯用。
   * 舊版 client 沒讀這欄也不會壞。
   */
  groups: (TeamScore & { members: string[]; onlineMembers?: string[] })[];
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
  /** 參賽者新手導覽是否自動顯示(預設 false;助理端可開)。 */
  onboardingEnabled: boolean;
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
  /** 本房 24h 內實際抽過的題數(跨場累積);設定頁「排除已抽過的題」顯示用。 */
  roomAskedCount?: number;
  /** server 權威的本場開賽時間戳;null = 尚未開賽/已重新開始。
   *  助理端重整後憑它接回本場賽後紀錄(REC)。 */
  gameStartedAt?: number | null;
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
 * 私訊回覆 resync_all:實際推送到幾個端(依角色)。助理端據此顯示
 * 「已同步 投影1 · 助理2 · 參賽者23」,兼作「現在還有幾支手機連著」的點名。
 */
export type ResyncReportEvent = {
  type: '__resync_report__';
  payload: {
    presenter: number;
    assistant: number;
    participant: number;
    phase: Phase;
  };
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
  /**
   * config 本體 + server 補的兩個欄位:
   * - startedAt:server 權威的開賽時間戳。助理端賽後紀錄(REC)以
   *   `${room}-${startedAt}` 當 game_key,重整後才能憑快照的
   *   gameStartedAt 精準接回同一場(2026-08-27 第二場報告全空的修正)。
   * - excludedIds:本場開賽時實際排除的題號(excludeIds ∪ 房間累積),
   *   三端據此種自己的 usedIds 鏡射,九宮格剩餘題數才會正確。
   */
  payload: GameConfig & { startedAt?: number; excludedIds?: string[] };
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
    /**
     * size = 該組人數,avg = count / size。勝負以 avg 判定(見 rush/count.ts),
     * 所以即時長條圖也必須照 avg 排 —— 否則比賽中觀眾看到「B 組總數領先」,
     * 最後卻是 A 組獲勝,台上解釋不清。size/avg 為 optional,舊 client
     * 收到照樣能用 count 顯示。
     */
    teamCounts: { idx: number; name: string; count: number; size?: number; avg?: number }[];
    remainingMs: number;
  };
};

/**
 * fallback=true 代表「時間到、全場都沒有人按」,得主是系統隨機指定的。
 * 2026-07-23 實測回饋:過去這種情況投影幕照樣顯示「○○○ 搶答耗時 8.000 秒」,
 * 助理完全看不出來其實沒人按 —— 三端收到這個旗標要改口說「無人搶答」。
 * 舊版 client 沒讀這欄也不會壞。
 */
export type RushWinnerSpeed = {
  groupIdx: number;
  groupName: string;
  rushMode: 'speed';
  personName: string;
  elapsedMs: number;
  fallback?: boolean;
};

export type RushWinnerLightning = {
  groupIdx: number;
  groupName: string;
  rushMode: 'lightning';
  personName: string;
  pressedAtSec: number;
  fallback?: boolean;
};

export type RushWinnerCount = {
  groupIdx: number;
  groupName: string;
  rushMode: 'count';
  personName: string;
  teamTotalClicks: number;
  /** 該組人數(人均判定的分母);舊版 client 沒這欄也不會壞。 */
  teamSize?: number;
  /** 人均點擊 = teamTotalClicks / teamSize —— 勝負以此判定,不看總數。 */
  avgClicks?: number;
  mvpClicks: number;
  runnerUp?: { name: string; count: number };
  fallback?: boolean;
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

/** A rush ended without an effective winner; the assistant may retry it. */
export type RushNoWinnerEvent = {
  type: 'rush_no_winner';
  payload: { rushMode: ActualRushMode; reason: 'timeout' | 'tie' | 'all_disqualified' };
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

/** 題數被追加(助理按「再加一題」)→ 三端更新總題數顯示與結束判定。 */
export type TotalQChangedEvent = {
  type: 'total_q_changed';
  payload: { totalQ: number };
};

/** 答題倒數狀態。remainingSec > 0 = 開始/續跑倒數;0 = 停止/隱藏。 */
export type TimerUpdateEvent = {
  type: 'timer_update';
  payload: { remainingSec: number };
};

/**
 * 助理按「重新這一輪」:本輪作廢、回到待命。三端行為同 next_question 的
 * 畫面重置,但**回合數不前進**(投影端的 ROUND 顯示不可 +1)、失格名單已
 * 清空(伴隨的 buzz_lockout 會是空陣列)。
 */
export type RoundResetEvent = {
  type: 'round_reset';
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
  | ResyncReportEvent
  | GameStartEvent
  | ModePreviewEvent
  | CustomTiersChangedEvent
  | RushModeChangedEvent
  | ScoreUpdateEvent
  | StartRushEvent
  | RushRevealEvent
  | RushTickEvent
  | RushWinnerEvent
  | RushNoWinnerEvent
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
  | RoundResetEvent
  | TotalQChangedEvent
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
  'fresh_rush',
  'round_reset',
  'reassign_leader',
  'resync_all',
  'add_question',
  'clear_prior_asked',
  'set_onboarding',
]);

export function isPrivilegedCommand(
  cmd: ClientCommand
): cmd is ClientCommand & PrivilegedHeader {
  return PRIVILEGED_COMMAND_TYPES.has(cmd.type);
}
