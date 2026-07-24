/**
 * server.ts — Durable Object entry point (partyserver on Cloudflare Workers).
 *
 * 2026-07 平台搬遷:原本跑在 PartyKit 託管平台(policy-gogogo.aoc7328
 * .partykit.dev),但該平台已無人維護(partykit.dev 網域撞 Cloudflare 一萬
 * Workers 上限、CLI 不支援 2026-07-09 起強制的 new_sqlite_classes DO
 * migration → 無法再部署)。改用 Cloudflare 官方接手的 partyserver
 * (API 幾乎同構),以 wrangler 部署到自己的 Cloudflare 帳號。
 * URL 形狀 /parties/main/<room> 不變(binding "Main" kebab 後 = "main"),
 * partysocket 前端零改動,只需改 PGG_PARTY_HOST。
 *
 * Owns the RoomState (single-threaded per DO instance), routes
 * ClientCommand messages from connections to per-command handlers,
 * and broadcasts ServerEvent results.
 *
 * Authentication model (Phase 2 — see EVENTS.md "Host-code" section):
 *   - controlCode is generated at room construction and freely shared
 *     with any connection declaring role=assistant via __welcome__.
 *   - Privileged commands must include matching controlCode in the
 *     message envelope.
 *   - Phase 5 hardening could add "first-claim" semantics (only the
 *     first assistant gets the code; later assistants must present it).
 */

import {
  Server,
  routePartykitRequest,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from 'partyserver';

import {
  isPrivilegedCommand,
  type ClientCommand,
  type ServerEvent,
  type ConnectionRole,
  type GameConfig,
} from './protocol';

import {
  createInitialState,
  startGame as stateStartGame,
  restartGame as stateRestartGame,
  adjustScore,
  upsertParticipant,
  removeParticipantByConn,
  renameParticipant,
  hardRemoveParticipant,
  renameTeam,
  setupTeams,
  pickTeamForParticipant,
  pickTeamByPrefix,
  lockedTeamForDevice,
  regroupByPrefix,
  ensureLeaders,
  redrawLeader,
  tallyMvpWin,
  computeMvp,
  reshuffleParticipants,
  snapshot,
  dehydrateState,
  hydrateState,
  type PersistedState,
  type RoomState,
  type BuzzRecord,
} from './state';

import { generateControlCode, verifyControlCode } from './auth';

import {
  pickQuestion,
  tiersForMode,
  FRAMEWORK_BY_SHORT_ID,
} from './bank';

import {
  startRush as rushStart,
  handleBuzz as rushHandleBuzz,
  abort as rushAbort,
} from './rush';

interface ConnState {
  role: ConnectionRole;
  name: string | null;       // participant only
  team: string | null;       // participant only
  deviceId: string | null;   // participant only — per-browser identity for multi-tab dedup
  verified: boolean;         // controlCode validated for assistants
}

const STATE_STORAGE_KEY = 'pgg_room_state_v1';
// 存檔超過 24 小時視為上一場活動的殘留,不還原(活動不會跨日進行)
const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class PolicyGogogoServer extends Server {
  // rush 的倒數用 in-memory setTimeout,DO 不可休眠(與 PartyKit 行為一致)
  static options = { hibernate: false };

  // 兩組獨立控制碼:controlCode = 投影端(+特權簽章);assistantCode = 助理端登入路由。
  // roomId 在建構時還拿不到(this.name 由 routePartykitRequest 解析),onStart 補填。
  state: RoomState = createInitialState('', generateControlCode(), generateControlCode());

  // buzz_press 節流:connId → { 視窗起點, 這個視窗內已計入的次數 }。
  // 2026-07-23 實測:狂點奪魁模式下,一支腳本 5 秒內送進 7,440 次點擊、
  // 人均 1860 次,對面整組真人猛點只有 48 次 —— 勝負完全被輾壓。
  // 人類極限大約每秒 10~12 下,這裡放寬到 20 下/秒:真人絕對打不到上限,
  // 連點器與腳本則被壓回人類量級。純記憶體、不進存檔。
  private buzzRate = new Map<string, { windowStart: number; count: number }>();

  // ────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────

  /** DO 重啟(deploy / eviction / dev hot-reload)後從 storage 還原遊戲,
   *  中場 deploy 不再把整場打回 lobby(user-reported start_rush lobby 錯誤)。 */
  async onStart(): Promise<void> {
    // 補填房號(partyserver 在 onStart 前已解析好 this.name)
    this.state.roomId = this.name;
    try {
      const saved = await this.ctx.storage.get<PersistedState>(STATE_STORAGE_KEY);
      if (!saved || saved.v !== 1) return;
      if (Date.now() - saved.savedAt > STATE_MAX_AGE_MS) {
        await this.ctx.storage.delete(STATE_STORAGE_KEY);
        return;
      }
      hydrateState(this.state, saved);
      console.log(
        `[room ${this.name}] state restored (phase=${this.state.phase}, currQ=${this.state.currQ})`
      );
    } catch (err) {
      console.error(`[room ${this.name}] state restore failed:`, err);
    }
  }

  /** 每個指令處理完後排程存檔;1 秒 coalesce(狂點奪魁一秒幾十個 buzz,
   *  不需要每個都寫一次 storage)。 */
  private _persistTimer: ReturnType<typeof setTimeout> | null = null;
  private schedulePersist(): void {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.ctx.storage
        .put(STATE_STORAGE_KEY, dehydrateState(this.state))
        .catch((err) => console.error(`[room ${this.name}] state persist failed:`, err));
    }, 1000);
  }

  onConnect(conn: Connection<ConnState>, ctx: ConnectionContext): void {
    const url = new URL(ctx.request.url);
    const rawRole = url.searchParams.get('role');
    const role = this.normalizeRole(rawRole);
    const name = url.searchParams.get('name');
    const team = url.searchParams.get('team');
    const deviceId = url.searchParams.get('deviceId');
    const presentedCode = url.searchParams.get('controlCode');

    // Multi-tab dedup (participant only):
    // 同一 deviceId 從另一分頁進來,把舊分頁踢掉。先 send __kicked__ 給舊
    // 連線(讓它能顯示提示 + 停止重連),然後從 participants Map 摘掉舊
    // entry(避免它的 onClose 廣播 player_leave 干擾助理進退場紀錄),
    // 最後 close()。新連線繼續走下面的 register flow 接管同一個 (name, team)。
    let replacedExistingTab = false;
    if (role === 'participant' && deviceId) {
      for (const c of this.getConnections<ConnState>()) {
        if (c.id === conn.id) continue;
        if (c.state?.role !== 'participant') continue;
        if (c.state?.deviceId !== deviceId) continue;
        try {
          this.send(c, {
            type: '__kicked__',
            payload: { reason: 'replaced_by_new_tab' },
          });
        } catch { /* old conn may already be closing */ }
        removeParticipantByConn(this.state, c.id);
        try { c.close(); } catch { /* ignore */ }
        replacedExistingTab = true;
      }
    }

    // Loose-auth model (Phase 4):
    // - Connection-level: any client may claim any role; we always accept
    //   and rely on per-command controlCode verification (see onMessage)
    //   to gate privileged actions.
    // - presentedCode in URL may be stale (sessionStorage from a previous
    //   server lifetime). Server is authoritative — we ignore the stale
    //   value and send the current controlCode in __welcome__ below; the
    //   client adapter overwrites sessionStorage on receipt.
    // - Phase 5 first-claim hardening will tighten this so only the first
    //   assistant can claim the role without presenting matching code.
    void presentedCode;

    conn.setState({
      role,
      name: role === 'participant' ? name : null,
      team: role === 'participant' ? team : null,
      deviceId: role === 'participant' ? deviceId : null,
      verified: role === 'assistant',
    });

    // Welcome: send role + (assistant only) controlCode + server time.
    this.send(conn, {
      type: '__welcome__',
      payload: {
        role,
        roomId: this.state.roomId,
        controlCode: role === 'assistant' ? this.state.controlCode : undefined,
        assistantCode: role === 'assistant' ? this.state.assistantCode : undefined,
        serverTime: Date.now(),
      },
    });

    // If a participant connected with valid name+team, register immediately
    // and broadcast player_join (so the assistant updates the roster)。
    // 同 deviceId 接管(replacedExistingTab):仍然 upsert(新 conn.id),但
    // 不廣播 player_join — 觀眾視角這個人本來就在房裡,助理進退場紀錄
    // 不該再多跳一條「加入」。
    if (role === 'participant' && name && team) {
      upsertParticipant(this.state, conn.id, name, team, deviceId);
      if (!replacedExistingTab) {
        this.broadcastEvent({ type: 'player_join', payload: { name, team } });
      }
    }

    // Push current room snapshot so the connection can render correct UI.
    this.send(conn, { type: '__room_state__', payload: snapshot(this.state) });
  }

  onClose(conn: Connection<ConnState>): void {
    const cs = conn.state;
    if (cs?.role === 'participant') {
      const ref = removeParticipantByConn(this.state, conn.id);
      if (ref) {
        this.broadcastEvent({
          type: 'player_leave',
          payload: { name: ref.name, team: ref.team },
        });
      }
    }
  }

  onError(conn: Connection, err: Error): void {
    console.error(`conn ${conn.id} error:`, err);
  }

  // ────────────────────────────────────────────────────────────
  // Message routing
  // ────────────────────────────────────────────────────────────

  // 注意:partyserver 的參數順序是 (connection, message),與 PartyKit 相反
  onMessage(sender: Connection<ConnState>, message: WSMessage): void {
    if (typeof message !== 'string') {
      this.sendError(sender, 'bad_payload', 'binary frame not supported');
      return;
    }
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(message) as ClientCommand;
    } catch {
      this.sendError(sender, 'bad_payload', 'JSON parse failed');
      return;
    }
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      this.sendError(sender, 'bad_payload', 'missing type');
      return;
    }

    // Privileged commands must carry a valid controlCode.
    if (isPrivilegedCommand(cmd)) {
      if (!verifyControlCode(cmd.controlCode, this.state.controlCode)) {
        this.sendError(sender, 'unauth', `controlCode required for ${cmd.type}`);
        return;
      }
    }

    try {
      this.dispatch(cmd, sender);
      // 指令可能改了遊戲狀態 → 排程存檔(coalesced),DO 重啟後可還原
      this.schedulePersist();
    } catch (err) {
      console.error('dispatch error:', err);
      this.sendError(
        sender,
        'internal',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private dispatch(cmd: ClientCommand, sender: Connection<ConnState>): void {
    switch (cmd.type) {
      case 'ping':
        // keepalive:回私訊 __pong__ 給發送端,讓 client 端知道連線還活著
        // (半死 TCP 偵測用,見 client/partybus.ts keepalive)。
        return this.send(sender, { type: '__pong__', payload: { t: Date.now() } });
      case 'game_start':
        return this.onGameStart(cmd.payload, sender);
      case 'score_adjust':
        return this.onScoreAdjust(cmd.payload);
      case 'start_rush':
        return this.onStartRush(cmd.payload?.rerush ?? false, sender);
      case 'enter_category':
        return this.onEnterCategory(sender);
      case 'category_preview':
        return this.onCategoryPreview(cmd.payload);
      case 'category_confirm':
        return this.onCategoryConfirm(cmd.payload, sender);
      case 'category_reset':
        return this.onCategoryReset();
      case 'reveal_answer':
        return this.onRevealAnswer(sender);
      case 'next_question':
        return this.onNextQuestion(sender);
      case 'skip_question':
        return this.onSkipQuestion(sender);
      case 'game_restart':
        return this.onGameRestart();
      case 'arm_purgatory':
        return this.onArmPurgatory(cmd.payload);
      case 'redraw_question':
        return this.onRedrawQuestion(sender);
      case 'claim_presenter':
        return this.onClaimPresenter(cmd.payload, sender);
      case 'staff_login':
        return this.onStaffLogin(cmd.payload, sender);
      case 'mode_preview':
        return this.broadcastEvent({ type: 'mode_preview', payload: cmd.payload });
      case 'custom_tiers_changed':
        return this.broadcastEvent({ type: 'custom_tiers_changed', payload: cmd.payload });
      case 'rush_mode_changed':
        return this.onRushModeChanged(cmd.payload);
      case 'presenter_show_qr':
        return this.broadcastEvent({ type: 'presenter_show_qr', payload: cmd.payload });
      case 'export_result':
        return this.onExportResult();
      case 'player_join':
        return this.onPlayerJoin(cmd.payload, sender);
      case 'buzz_press':
        return this.onBuzzPress(cmd.payload, sender);
      case 'team_rename':
        return this.onTeamRename(cmd.payload);
      case 'team_count_changed':
        return this.onTeamCountChanged(cmd.payload, sender);
      case 'grouping_mode_changed':
        return this.onGroupingModeChanged(cmd.payload, sender);
      case 'notify_group':
        return this.onNotifyGroup(cmd.payload, sender);
      case 'rename_self':
        return this.onRenameSelf(cmd.payload, sender);
      case 'leave_room':
        return this.onLeaveRoom(sender);
      case 'set_timer':
        return this.onSetTimer(cmd.payload);
      case 'rebuzz_same':
        return this.onRebuzzSame(sender);
      case 'fresh_rush':
        return this.onFreshRush(sender);
      case 'resume_question':
        return this.onResumeQuestion(sender);
      case 'reassign_leader':
        return this.onReassignLeader(cmd.payload, sender);
      case 'resync_all':
        return this.onResyncAll(sender);
      case 'add_question':
        return this.onAddQuestion(cmd.payload, sender);
      case 'set_onboarding':
        return this.onSetOnboarding(cmd.payload);
      default: {
        const _exhaustive: never = cmd;
        void _exhaustive;
        return;
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Privileged handlers
  // ────────────────────────────────────────────────────────────

  private onGameStart(config: GameConfig, sender: Connection<ConnState>): void {
    // 只在 lobby 接受(稽核發現):賽後 phase=ended 時助理端設定分頁是開的、
    // 「確定、開始遊戲」也會亮 —— 誤按會 stateStartGame 把剛打完那場的
    // 分數全部歸零。要開新的一場請先按「重新開始」(server 會回到 lobby)。
    if (this.state.phase !== 'lobby') {
      this.sendError(
        sender,
        'phase_mismatch',
        `本場已在進行中或已結束(${this.state.phase}),不能再按「開始遊戲」。要開新的一場請先按「重新開始」。`,
      );
      return;
    }
    stateStartGame(this.state, config);
    // 補齊組長(不重抽既有的 —— 玩家池顯示的人選必須延續到開賽後)
    ensureLeaders(this.state);
    this.broadcastEvent({ type: 'game_start', payload: config });
    // Push fresh score baseline (all zeros) so clients render bars.
    this.broadcastEvent({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: -1,
        delta: 0,
      },
    });
    // 廣播組長:參賽者標記名單 + 告知本人;投影結算頁領獎用
    this.broadcastLeaders();
  }

  private onScoreAdjust(payload: { teamIdx: number; delta: number; completeRound?: boolean }): void {
    const result = adjustScore(this.state, payload.teamIdx, payload.delta);
    if (!result.ok) return;
    // 題數代表「已完成且有得分判定的回合」，不是抽題或答錯的次數。
    // 只有揭曉後的 25% / 50% / 100% 計分會帶 completeRound=true。
    if (payload.completeRound === true && this.state.phase === 'revealed') {
      this.state.currQ = (this.state.currQ ?? 0) + 1;
    }
    this.broadcastEvent({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: payload.teamIdx,
        delta: payload.delta,
      },
    });
  }

  private onStartRush(rerush: boolean, sender: Connection<ConnState>): void {
    // Accepted phases: idle / rushing / won / picking. Anything past picking
    // (answering / revealed / ended / lobby) we now SEND ERROR instead of
    // silent return — Phase 4 lesson: silent server rejections + assistant's
    // expectations create deadlocks no one can debug.
    const ok = ['idle', 'rushing', 'won', 'picking'].includes(this.state.phase);
    if (!ok) {
      this.sendError(sender, 'wrong_phase',
        `start_rush 不能在 ${this.state.phase} 階段送(只接受 idle/rushing/won/picking)。` +
        `若 server 在 lobby,代表 server 失去本場狀態(可能是 partykit dev hot-reload 重建 DO),` +
        `請按「重新開始」整場重置。`);
      return;
    }
    // 一般「開始搶答 / 重新搶答(重抽)」= 新一輪,清掉本題失格名單
    if (!rerush) {
      this.state.excludedTeams = [];
      this.state.lastBuzzWinnerTeam = null;
    }
    this.broadcastBuzzLockout();
    rushStart(this.state, this.rushBroadcast, { rerush });
  }

  /**
   * 所有 rush 事件的廣播出口:順手攔 rush_winner 累計搶答 MVP
   * (speed/lightning/count;allhands 無個人 personName 不算)。
   * 兩個 rush 觸發點(start_rush 與 buzz_press)都走這裡,缺一不可
   * (buzz 觸發的勝利是經由 onBuzzPress 的 handleBuzz 發出的)。
   */
  private rushBroadcast = (e: ServerEvent): void => {
    if (e.type === 'rush_winner') {
      const p = e.payload as { rushMode: string; groupIdx: number; personName?: string };
      if (p.rushMode !== 'allhands' && typeof p.personName === 'string') {
        tallyMvpWin(this.state, p.groupIdx, p.personName);
      }
      // 記住「當前答題者」= 最近搶到的組,供「同一題重新搶答」排除用
      this.state.lastBuzzWinnerTeam = p.groupIdx;
    }
    this.broadcastEvent(e);
  };

  /** 廣播本輪搶答失格組(組名);一般搶答為空陣列。 */
  private broadcastBuzzLockout(): void {
    const teams = this.state.excludedTeams
      .map((idx) => this.state.groups[idx]?.name)
      .filter((n): n is string => typeof n === 'string');
    this.broadcastEvent({ type: 'buzz_lockout', payload: { teams } });
  }

  private onEnterCategory(sender: Connection<ConnState>): void {
    // A sole remaining eligible team bypasses the next rush after a pass.
    // Commit the just-failed team and make that remaining team the current
    // answerer so a subsequent pass is attributed to the correct team.
    if (this.state.phase === 'revealed') {
      const failed = this.state.lastBuzzWinnerTeam;
      const excluded = new Set(this.state.excludedTeams);
      if (failed !== null) excluded.add(failed);
      const eligible = this.state.groups.filter((g) => !excluded.has(g.idx));
      if (eligible.length !== 1) {
        this.sendError(sender, 'wrong_phase', 'Direct category selection requires exactly one eligible team');
        return;
      }
      const remaining = eligible[0]!;
      this.state.excludedTeams = [...excluded];
      this.state.currentQuestion = null;
      this.state.currentCat = null;
      this.state.catLocked = false;
      this.state.lastBuzzWinnerTeam = remaining.idx;
      this.state.phase = 'picking';
      this.broadcastBuzzLockout();
      this.broadcastEvent({ type: 'enter_category', payload: {} });
      return;
    }
    // 冪等:多助理協作時,每位助理 onRushWinner 都排了 3.5s 計時器送
    // enter_category。第一個把 won→picking 後,其餘的若還沒被自己的
    // 廣播鏡射取消,會再送一次 — 此時 server 已在 picking,視為成功 no-op
    // (不報錯、不重複廣播),避免其他助理畫面跳 wrong_phase 紅字。
    if (this.state.phase === 'picking') return;
    if (this.state.phase !== 'won') {
      this.sendError(sender, 'wrong_phase',
        `enter_category 只能在 won 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    this.state.phase = 'picking';
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.broadcastEvent({ type: 'enter_category', payload: {} });
  }

  private onCategoryPreview(payload: { fid: string }): void {
    if (this.state.phase !== 'picking') return;
    this.state.currentCat = payload.fid;
    this.broadcastEvent({ type: 'category_preview', payload });
  }

  /**
   * 一字千金 cap → picker excludeTypes。
   * - custom mode 不套用(有自己的 customTypes 勾選)
   * - cap 是 null/undefined → 不限(legacy 行為)
   * - 已抽出的 word_game 數 >= cap → 之後排除 word_game
   */
  private wordGameExcludeTypes(): string[] | null {
    const game = this.state.game;
    if (!game || game.mode === 'custom') return null;
    const cap = game.wordGameCap;
    if (cap === null || cap === undefined) return null;
    return this.state.wordGameAsked >= cap ? ['word_game'] : null;
  }

  private onCategoryConfirm(
    payload: { fid: string },
    sender: Connection<ConnState>
  ): void {
    // Reject visibly so the assistant client can unstuck its optimistic
    // cat-picker UI on its __error__ listener, instead of hanging at
    // "等待抽題…" forever (user-reported Phase 4 bug).
    if (this.state.phase !== 'picking') {
      this.sendError(
        sender,
        'wrong_phase',
        `category_confirm 只能在 picking 階段送(目前 server phase=${this.state.phase})。` +
          `按「重新搶答」回 picking,或「重新開始」整場重置。`
      );
      return;
    }
    if (!this.state.game) {
      this.sendError(sender, 'no_game', 'server 沒有進行中的 game,請先按「開始遊戲」');
      return;
    }

    // Try the pick FIRST — no state change, no broadcast yet. If it fails,
    // we send a private error to the sender (assistant) so they can retry
    // without other clients seeing a flicker.
    const tierPool = tiersForMode(this.state.game.mode, this.state.game.customTiers);
    const framework = FRAMEWORK_BY_SHORT_ID[payload.fid] ?? null;
    const result = pickQuestion({
      tierPool,
      framework,
      typeWhitelist:
        this.state.game.mode === 'custom' && this.state.game.customTypes.length > 0
          ? this.state.game.customTypes
          : null,
      excludeTypes: this.wordGameExcludeTypes(),
      usedIds: this.state.usedIds,
      purgArmed: this.state.purgArmed,
    });

    if (!result.ok) {
      let friendly: string;
      if (result.reason === 'no_purgatory_left') {
        friendly = '煉獄題庫已抽完(此分類無剩餘煉獄題)';
      } else if (result.reason === 'framework_not_in_bank') {
        // Most common dev-time cause: assistant uploaded real bank to its own
        // localStorage but server still has the fixture in /public/data/.
        const fid = result.diag?.framework ?? '(?)';
        friendly =
          `此分類在 server 端 BANK 沒題目(framework=${fid}, pool=${result.diag?.bankSizeInPool} 題)。` +
          `如果你已經上傳真題庫到助理介面,記得也要把 5 個 JSON 放進 /public/data/ 並重啟 partykit dev — ` +
          `server BANK 是 build 時 bundled 的,不會自動跟 client localStorage 同步。`;
      } else {
        friendly = '此分類已無可抽題目(難度池或框架已被用盡)';
      }
      this.sendError(sender, 'no_question', friendly);
      return;
    }

    // Pick succeeded — commit state changes and broadcast in one batch.
    const wasArmed = this.state.purgArmed;
    if (wasArmed) this.state.purgArmed = false;

    this.state.currentCat = payload.fid;
    this.state.catLocked = true;
    this.state.usedIds.add(result.question.id);
    if (result.question.type === 'word_game') this.state.wordGameAsked++;
    this.state.askedQuestions.push({
      id: result.question.id,
      difficulty: result.question.difficulty,
      framework: result.question.framework,
    });
    this.state.currentQuestion = {
      id: result.question.id,
      difficulty: result.question.difficulty,
      framework: result.question.framework,
    };
    this.state.phase = 'answering';

    this.broadcastEvent({ type: 'category_confirm', payload });
    if (result.triggersPurgatory) {
      this.broadcastEvent({ type: 'purgatory_summon', payload: {} });
    }
    this.broadcastEvent({
      type: 'question_pick',
      payload: {
        id: result.question.id,
        difficulty: result.question.difficulty,
        framework: result.question.framework,
        // currQ 是已完成的得分回合數；目前抽到的是下一回合。
        roundQ: (this.state.currQ ?? 0) + 1,
      },
    });
  }

  private onCategoryReset(): void {
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.broadcastEvent({ type: 'category_reset', payload: {} });
  }

  private onRevealAnswer(sender: Connection<ConnState>): void {
    if (this.state.phase !== 'answering') {
      this.sendError(sender, 'wrong_phase',
        `reveal_answer 只能在 answering 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    this.state.phase = 'revealed';
    this.broadcastEvent({ type: 'reveal_answer', payload: {} });
  }

  private onNextQuestion(sender: Connection<ConnState>): void {
    if (this.state.phase !== 'revealed' && this.state.phase !== 'answering') {
      this.sendError(sender, 'wrong_phase',
        `next_question 只能在 answering/revealed 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    // Was the question a purgatory one? If so, end the FX before transitioning.
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcastEvent({ type: 'purgatory_end', payload: {} });
    }
    this.state.currentQuestion = null;
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.state.excludedTeams = [];           // 新題 → 清掉失格名單
    this.state.lastBuzzWinnerTeam = null;
    this.state.phase = 'idle';
    this.broadcastEvent({ type: 'next_question', payload: {} });
    // End game if we've reached totalQ.
    if (this.state.game && this.state.currQ >= this.state.game.totalQ) {
      this.state.phase = 'ended';
    }
  }

  private onSkipQuestion(sender: Connection<ConnState>): void {
    if (this.state.phase !== 'answering' && this.state.phase !== 'revealed') {
      this.sendError(sender, 'wrong_phase',
        `skip_question 只能在 answering/revealed 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcastEvent({ type: 'purgatory_end', payload: {} });
    }
    // Phase 4 fix:不再 decrement currQ。currQ 語意統一成「已抽過的題數」,
    // skip 也算抽過(問題已亮出來給觀眾看了),不能讓 counter 退回去。
    // 之前 decrement 是 demo 階段「skip 不算數」的舊語意,跟 user expectation
    // 不符(user 期待 counter 跟著 question 往前)。
    this.state.currentQuestion = null;
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.state.excludedTeams = [];           // 新題 → 清掉失格名單
    this.state.lastBuzzWinnerTeam = null;
    this.state.phase = 'idle';
    this.broadcastEvent({ type: 'skip_question', payload: {} });
  }

  private onGameRestart(): void {
    // 若當前題目是煉獄,先廣播 purgatory_end 讓三端清掉煉獄特效。
    // 沒這行的話,user 在煉獄題顯示中按重新開始 → 三端 UI 雖然回到 idle,
    // 但 .purg-on / stage[data-mode="purgatory"] / 火星粒子全部殘留,
    // 看起來像 bug(user-reported Phase 4)。
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcastEvent({ type: 'purgatory_end', payload: {} });
    }
    rushAbort(this.state);
    stateRestartGame(this.state);
    this.broadcastEvent({ type: 'game_restart', payload: {} });
    // Also push a fresh snapshot to all so they reset their UI.
    for (const c of this.getConnections<ConnState>()) {
      this.send(c, { type: '__room_state__', payload: snapshot(this.state) });
    }
    // prefix 模式:restartGame 已依名字前綴重新整組 → 廣播 roster,
    // 讓助理/參賽者重建 prefix 分組(他們從 roster_reshuffled 重建,
    // 不從 __room_state__ 取 groups)。
    if (this.state.groupingMode === 'prefix') {
      this.broadcastRoster();
    }
  }

  private onArmPurgatory(payload: { armed: boolean }): void {
    // Hidden 秘技: server stores flag silently, no broadcast.
    this.state.purgArmed = !!payload.armed;
  }

  /**
   * 主持人介面 claim flow:
   * - 驗證 payload.code 與 state.controlCode 相符
   * - 多投影機支援:控制碼正確就放行,不再限一台(大場地一房可能
   *   有 2~5 台投影電腦都要開主持人畫面;presenter 是純顯示端、
   *   無搶訊號問題)。presenterClaimed 旗標保留(首次 claim 設起,
   *   讓 participant 端知道「已有主持機」可顯示提示),重複 claim
   *   為冪等成功。
   * - 廣播 presenter_claimed → 呼叫端從 broadcast 知道自己 claim
   *   成功(因為自己也會收到)
   */
  private onClaimPresenter(
    payload: { code: string },
    sender: Connection<ConnState>
  ): void {
    const code = (payload?.code || '').trim().toUpperCase();
    if (!code) {
      this.sendError(sender, 'bad_payload', '請輸入主持人控制碼');
      return;
    }
    if (code !== this.state.controlCode) {
      this.sendError(sender, 'bad_code', '控制碼錯誤,請向助理確認');
      return;
    }
    this.state.presenterClaimed = true;
    this.broadcastEvent({
      type: 'presenter_claimed',
      payload: { at: Date.now() },
    });
  }

  /**
   * 統一工作人員登入:依輸入的碼路由到投影端或助理端。
   * - 投影碼(controlCode)→ 私訊 dest=presenter + controlCode(presenter.html 特權簽章用),
   *   並沿用 presenter_claimed 廣播(讓其他端知道已有主持機)。
   * - 助理碼(assistantCode)→ 私訊 dest=assistant(助理介面連上後自己會拿 controlCode)。
   * - 都不符 → bad_code。
   */
  private onStaffLogin(
    payload: { code: string },
    sender: Connection<ConnState>
  ): void {
    const code = (payload?.code || '').trim().toUpperCase();
    if (!code) {
      this.sendError(sender, 'bad_payload', '請輸入控制碼');
      return;
    }
    if (code === this.state.controlCode) {
      this.state.presenterClaimed = true;
      this.broadcastEvent({ type: 'presenter_claimed', payload: { at: Date.now() } });
      this.send(sender, {
        type: '__staff_route__',
        payload: { dest: 'presenter', controlCode: this.state.controlCode },
      });
      return;
    }
    if (code === this.state.assistantCode) {
      this.send(sender, { type: '__staff_route__', payload: { dest: 'assistant' } });
      return;
    }
    this.sendError(sender, 'bad_code', '控制碼錯誤,請向助理確認');
  }

  private onRedrawQuestion(sender: Connection<ConnState>): void {
    // 重抽:當前題還沒公佈答案時可以換一題(同 framework / tier pool / type 限制),
    // 計數器不增加(還是同一輪)。
    if (this.state.phase !== 'answering') {
      this.sendError(
        sender,
        'wrong_phase',
        `redraw_question 只能在 answering 階段送(目前 server phase=${this.state.phase})`
      );
      return;
    }
    if (!this.state.game) return;
    if (!this.state.currentQuestion) {
      this.sendError(sender, 'no_current', '目前無題目可重抽');
      return;
    }
    const oldFw = this.state.currentQuestion.framework;
    // 重抽行為:被丟掉的題目算「已用」,留在 usedIds 裡,池子真的會縮。
    // 5 題框架 → 第 1 題 + 4 次重抽後 usedIds={5 題},第 5 次重抽抽無題,
    // 跳警告。usedIds 已經包含當前題(picking 時已 add),picker 自然
    // 不會把它再選給我們。
    const tierPool = tiersForMode(this.state.game.mode, this.state.game.customTiers);
    const result = pickQuestion({
      tierPool,
      framework: oldFw,
      typeWhitelist:
        this.state.game.mode === 'custom' && this.state.game.customTypes.length > 0
          ? this.state.game.customTypes
          : null,
      excludeTypes: this.wordGameExcludeTypes(),
      usedIds: this.state.usedIds,
      purgArmed: false, // 重抽不消耗 purgArmed flag
    });

    if (!result.ok) {
      this.sendError(
        sender,
        'no_question',
        '此分類已無其他題目可重抽(只剩當前這題)'
      );
      return;
    }

    // 替換 currentQuestion,但 askedQuestions 改「push 新一筆」(不再覆蓋最後一筆):
    // 重抽也算實際玩過的一題,回顧才能反映真實題數 —— user 場景:設定 5 題,
    // 但第一題重抽了 3 次 → 實際共玩 8 題,回顧數量要顯示 8。被換掉的舊題
    // 仍留在 askedQuestions(照抽題順序列出「第一題第一次/第二次/第三次」)。
    // currQ 不變(還是同一輪),所以 actualQ(askedQuestions.length)會 > currQ。
    this.state.usedIds.add(result.question.id);
    if (result.question.type === 'word_game') this.state.wordGameAsked++;
    // 把「被換掉的那一筆」標成 replaced,回顧頁才分得出哪些是重抽掉的舊題。
    const superseded = this.state.askedQuestions[this.state.askedQuestions.length - 1];
    if (superseded) superseded.replaced = true;
    this.state.askedQuestions.push({
      id: result.question.id,
      difficulty: result.question.difficulty,
      framework: result.question.framework,
    });
    this.state.currentQuestion = {
      id: result.question.id,
      difficulty: result.question.difficulty,
      framework: result.question.framework,
    };
    // currQ 不變(同一輪)
    if (result.triggersPurgatory) {
      this.broadcastEvent({ type: 'purgatory_summon', payload: {} });
    } else if (this.state.currentQuestion.difficulty !== 'purgatory') {
      // 重抽從煉獄變一般題,要清掉煉獄特效
      this.broadcastEvent({ type: 'purgatory_end', payload: {} });
    }
    this.broadcastEvent({
      type: 'question_pick',
      payload: {
        id: result.question.id,
        difficulty: result.question.difficulty,
        framework: result.question.framework,
        roundQ: (this.state.currQ ?? 0) + 1, // 重抽不增 currQ,送同一輪數
        redraw: true,
      },
    });
  }

  private onRushModeChanged(payload: { mode: import('./protocol').RushMode; label: string }): void {
    this.state.rushMode = payload.mode;
    this.broadcastEvent({ type: 'rush_mode_changed', payload });
  }

  private onExportResult(): void {
    if (!this.state.game) return;
    // 結束本場(極限情境修正):若在「搶答進行中」按下結束,搶答的 fallback
    // 計時器仍排程著 — 它會在最多 8 秒後照樣 broadcast rush_winner、把
    // phase 設成 won,於是已經跳到結束畫面的三端又突然冒出某組搶答成功、
    // 接著進選題九宮格。這裡先取消搶答排程(rushAbort 清掉 timers + 歸零
    // rushSession,pending callback 讀到 null 就 bail),再把 server phase
    // 設成 ended,與三端結束畫面一致。
    rushAbort(this.state);
    this.state.timerDeadline = null;
    this.broadcastEvent({ type: 'timer_update', payload: { remainingSec: 0 } });
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcastEvent({ type: 'purgatory_end', payload: {} });
    }
    this.state.phase = 'ended';
    const sortedGroups = [...this.state.groups]
      .sort((a, b) => b.score - a.score)
      .map((g) => ({ name: g.name, score: g.score, leader: g.leader, mvp: computeMvp(this.state, g.idx) }));
    // Chinese mode labels for participant UI. Server is authoritative for
    // the export payload (它不轉發 client 的 emit,自己組裝),所以這個 map
    // 就在這裡定。
    const MODE_LABEL_ZH: Record<typeof this.state.game.mode, string> = {
      ordinary: '普通',
      hell: '地獄',
      paradise: '極樂',
      custom: '自由',
    };
    const isCustom = this.state.game.mode === 'custom';
    const payload = {
      mode: this.state.game.mode,
      modeLabel: MODE_LABEL_ZH[this.state.game.mode] || '—',
      customTiers: isCustom ? [...this.state.game.customTiers] : [],
      customTypes: isCustom ? [...this.state.game.customTypes] : [],
      totalQ: this.state.game.totalQ,
      spq: this.state.game.spq,
      actualQ: this.state.askedQuestions.length,
      groups: this.state.groups.map((g) => ({
        name: g.name,
        score: g.score,
        members: [...g.members],
        leader: g.leader,
        mvp: computeMvp(this.state, g.idx),
      })),
      sortedGroups,
      askedQuestions: [...this.state.askedQuestions],
      exportTime: new Date().toISOString(),
    };
    this.broadcastEvent({ type: 'export_result', payload });
  }

  // ────────────────────────────────────────────────────────────
  // Unprivileged participant handlers
  // ────────────────────────────────────────────────────────────

  private onPlayerJoin(
    payload: { name: string; team?: string },
    sender: Connection<ConnState>
  ): void {
    if (!payload.name) return;
    // Server is authoritative for team assignment — ignore client's payload.team.
    // Defensive lazy-init: if no teams set up yet (race on testbed where all
    // three windows open together, or assistant connected later), bootstrap
    // with the default 2 teams. Assistant's subsequent team_count_changed
    // (with their actual i-n value) will reshuffle.
    const deviceId = sender.state?.deviceId ?? null;
    let team: string | null;
    if (this.state.groupingMode === 'prefix') {
      // prefix 模式:依名字前綴 find-or-create 組(組數動態長出來)
      team = pickTeamByPrefix(this.state, payload.name);
    } else {
      if (this.state.groups.length === 0) {
        setupTeams(this.state, 2);
      }
      // 入組優先序(30 人實戰後定案):
      //   1. 裝置鎖(同一支手機 24h 內固定同組,連名字打錯/改名都拉得回來)
      //   2. 名字已在某組名單 → 回原組(斷線名單不清,重連不跳組)
      //   3. 都沒有 → 最少人組(平手隨機)= 遲到者平均分配
      team =
        (deviceId ? lockedTeamForDevice(this.state, deviceId) : null) ??
        pickTeamForParticipant(this.state, payload.name);
    }
    if (!team) return;
    upsertParticipant(this.state, sender.id, payload.name, team, deviceId);
    sender.setState({
      role: 'participant',
      name: payload.name,
      team,
      deviceId: sender.state?.deviceId ?? null,
      verified: false,
    });
    this.broadcastEvent({ type: 'player_join', payload: { name: payload.name, team } });
    // prefix 模式可能剛建了新組 → 廣播完整 roster,讓三端同步新組結構
    if (this.state.groupingMode === 'prefix') {
      this.broadcastRoster();
    }
    // 一有組員就抽組長 → 玩家池(lobby)當下就看得到,不必等開賽
    this.syncLeaders();
  }

  /**
   * 補齊組長,若有變動就廣播 group_leaders。
   * 任何會動到組員名單的地方(入房、離開、改名、重新分組、開賽)都該呼叫,
   * 這樣「一有組員就有組長」且組長離開時立刻有人接任。
   */
  private syncLeaders(force = false): void {
    const changed = ensureLeaders(this.state);
    if (changed.length === 0 && !force) return;
    this.broadcastLeaders();
  }

  private broadcastLeaders(): void {
    this.broadcastEvent({
      type: 'group_leaders',
      payload: {
        leaders: this.state.groups.map((g) => ({ name: g.name, leader: g.leader })),
      },
    });
  }

  /** 廣播當前完整分組(roster_reshuffled);多處共用。 */
  private broadcastRoster(): void {
    this.broadcastEvent({
      type: 'roster_reshuffled',
      payload: {
        groups: this.state.groups.map((g) => ({
          idx: g.idx,
          name: g.name,
          members: [...g.members],
        })),
      },
    });
  }

  private onGroupingModeChanged(
    payload: { mode: import('./protocol').GroupingMode; count?: number },
    sender: Connection<ConnState>
  ): void {
    if (this.state.phase !== 'lobby') {
      this.sendError(sender, 'phase_mismatch', '遊戲已開始,無法切換分組方式');
      return;
    }
    if (payload.mode === 'prefix') {
      this.state.groupingMode = 'prefix';
      regroupByPrefix(this.state);
    } else {
      this.state.groupingMode = 'random';
      const n = Math.max(2, Math.min(10, Math.floor(payload.count ?? this.state.groups.length ?? 2)));
      setupTeams(this.state, n);
      reshuffleParticipants(this.state);
    }
    this.broadcastRoster();
    this.syncLeaders(true);
  }

  /** 前綴分組時，助理對整組發通知 → 廣播 group_notice(該組參賽者畫面跳提示)。 */
  private onNotifyGroup(
    payload: { team: string; kind: import('./protocol').GroupNoticeKind },
    sender: Connection<ConnState>
  ): void {
    if (this.state.groupingMode !== 'prefix') {
      this.sendError(sender, 'wrong_grouping_mode', '通知改名／確認前綴只適用於前綴分組');
      return;
    }
    const kind = payload.kind === 'rename' ? 'rename' : 'confirm';
    this.broadcastEvent({
      type: 'group_notice',
      payload: { team: payload.team, kind, deadlineMs: kind === 'rename' ? 30000 : 0 },
    });
  }

  /** 參賽者改自己的名字(prefix 模式會重新歸組)。 */
  private onRenameSelf(
    payload: { newName: string },
    sender: Connection<ConnState>
  ): void {
    const r = renameParticipant(this.state, sender.id, payload?.newName ?? '');
    if (!r.ok) {
      const msg =
        r.reason === 'too_long'
          ? '名字太長(上限 20 字)'
          : r.reason === 'duplicate'
            ? '這個名字已經有人用了,請換一個(例如加上姓氏或後兩碼)'
            : '改名失敗';
      this.sendError(sender, 'rename_failed', msg);
      return;
    }
    sender.setState({
      role: 'participant',
      name: r.newName ?? null,
      team: r.newTeam ?? null,
      deviceId: sender.state?.deviceId ?? null,
      verified: false,
    });
    this.broadcastEvent({
      type: 'player_renamed',
      payload: { oldName: r.oldName!, newName: r.newName!, oldTeam: r.oldTeam!, newTeam: r.newTeam! },
    });
    // 換組/清空組可能改變分組結構 → 全量 roster + 分數基準重發
    this.broadcastRoster();
    // 改名的人若是組長,名字變了要跟著更新(ensureLeaders 會發現舊名不在
    // 名單裡而改抽);同組其他人也可能因此接任。
    if (r.oldName && this.state.groups.some((g) => g.leader === r.oldName)) {
      for (const g of this.state.groups) {
        if (g.leader === r.oldName) g.leader = r.newTeam === g.name ? r.newName! : null;
      }
    }
    this.syncLeaders(true);
    this.broadcastEvent({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: -1,
        delta: 0,
      },
    });
  }

  /** 同一題重新搶答:保留題目,重新開放搶答。 */
  private onRebuzzSame(sender: Connection<ConnState>): void {
    // revealed 也放行:公佈答案後發現答題組答錯 → 不計分 → 讓其他組
    // 再挑戰同一題(答案已公開,但申論/計算題仍可比誰講得完整,由助理
    // 用部分給分裁量)。user-reported:原本揭曉後只剩「下一題」,流程卡死。
    if (this.state.phase !== 'answering' && this.state.phase !== 'revealed') {
      this.sendError(sender, 'wrong_phase', '只有在答題或已公佈答案階段才能「同一題重新搶答」');
      return;
    }
    if (!this.state.currentQuestion) {
      this.sendError(sender, 'no_current', '目前沒有題目');
      return;
    }
    // 答不出來的那組(當前答題者)失去本題搶答資格,累積排除。
    const failed = this.state.lastBuzzWinnerTeam;
    if (failed !== null && !this.state.excludedTeams.includes(failed)) {
      const totalTeams = this.state.groups.length;
      // 若再排除就全員失格 → 先清空(等於開放所有組重來,避免無人可搶)
      if (this.state.excludedTeams.length + 1 >= totalTeams) {
        this.state.excludedTeams = [];
      } else {
        this.state.excludedTeams.push(failed);
      }
    }
    this.broadcastBuzzLockout();
    // 保留 currentQuestion/currentCat,標記「這輪 rush 完要回同一題」。停掉倒數。
    this.state.rebuzzPending = true;
    this.state.timerDeadline = null;
    this.broadcastEvent({ type: 'timer_update', payload: { remainingSec: 0 } });
    // 跑一輪 rush(phase → rushing,走 rushBroadcast 才會累計 MVP)。
    rushStart(this.state, this.rushBroadcast, { rerush: true });
  }

  /** All teams passed: end the revealed question and start a new all-team rush. */
  private onFreshRush(sender: Connection<ConnState>): void {
    if (this.state.phase !== 'revealed') {
      this.sendError(sender, 'wrong_phase', '全員重新搶答只能在公布答案後啟動');
      return;
    }
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcastEvent({ type: 'purgatory_end', payload: {} });
    }
    this.state.currentQuestion = null;
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.state.rebuzzPending = false;
    this.state.excludedTeams = [];
    this.state.lastBuzzWinnerTeam = null;
    this.state.timerDeadline = null;
    this.broadcastEvent({ type: 'timer_update', payload: { remainingSec: 0 } });
    this.broadcastBuzzLockout();
    this.broadcastEvent({ type: 'next_question', payload: {} });
    rushStart(this.state, this.rushBroadcast, { rerush: false });
  }

  /** 重新搶答後回到同一題作答(phase: won → answering)。 */
  private onResumeQuestion(sender: Connection<ConnState>): void {
    if (!this.state.rebuzzPending) {
      this.sendError(sender, 'wrong_phase', '目前不是「同一題重新搶答」流程');
      return;
    }
    this.state.rebuzzPending = false;
    this.state.phase = 'answering';
    this.broadcastEvent({ type: 'resume_question', payload: {} });
  }

  /**
   * 助理「重新同步」:把權威狀態重推給每一個還連著的端。
   *
   * 為什麼需要:上一場結束後停在結算頁的學員,若剛好漏接
   * game_restart / game_start 廣播,畫面會停在舊的一場。收到快照後
   * participant.html 的階段對帳會自動把他帶到正確畫面。
   *
   * 能力邊界(誠實說):只推得到 WebSocket 還活著的連線。手機連線真的
   * 斷掉的人收不到 —— 那種情況要等他自己的 keepalive 重連(最多 25 秒),
   * 重連時本來就會拿到快照,一樣會自動歸位。所以這顆按鈕是「加速」,
   * 不是「唯一解法」。
   *
   * 順便回報各角色實際連線數,現場可當點名用。
   */
  private onResyncAll(sender: Connection<ConnState>): void {
    const snap = snapshot(this.state);
    const count = { presenter: 0, assistant: 0, participant: 0 };
    for (const c of this.getConnections<ConnState>()) {
      const role = c.state?.role;
      if (role === 'presenter' || role === 'assistant') count[role] += 1;
      try {
        this.send(c, { type: '__room_state__', payload: snap });
      } catch {
        /* 連線正在關閉 → 略過,它重連時自然會拿到快照 */
      }
    }
    // 參賽者數用「已註冊的玩家」而非 raw 連線數 —— 被請出房間的人 socket
    // 可能還連著(瀏覽器自動重連),但他已不在名單裡。助理拿這個數字點名,
    // 必須等於「現在真的在場上的人」。
    count.participant = this.state.participants.size;
    // 分組/分數/組長是各端分開維護的畫面,一併重推,避免只有階段對了、
    // 名單還是舊的。
    this.broadcastRoster();
    this.broadcastLeaders();
    this.broadcastEvent({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: -1,
        delta: 0,
      },
    });
    // 已結束的場次:光推快照救不了「卡在題目畫面」的人 —— 結算頁需要成績
    // 資料才畫得出來。補送一次 export_result,讓他們也能看到結果頁。
    if (this.state.phase === 'ended') {
      this.onExportResult();
    }
    this.send(sender, {
      type: '__resync_report__',
      payload: { ...count, phase: this.state.phase },
    });
  }

  /**
   * 助理開關參賽者新手導覽(預設關閉)。改完把快照推給所有端,
   * 已在線的參賽者也會立刻套用(不必重整)。
   */
  private onSetOnboarding(payload: { enabled: boolean }): void {
    this.state.onboardingEnabled = payload?.enabled === true;
    const snap = snapshot(this.state);
    for (const c of this.getConnections<ConnState>()) {
      try {
        this.send(c, { type: '__room_state__', payload: snap });
      } catch { /* 連線關閉中 */ }
    }
  }

  /**
   * 助理「再加一題」:題數用完後臨場追加(現場控時用)。
   * 可無限追加 —— 總分上限會跟著變動,這是刻意的取捨。
   */
  private onAddQuestion(
    payload: { n?: number } | undefined,
    sender: Connection<ConnState>
  ): void {
    if (!this.state.game) {
      this.sendError(sender, 'no_game', '尚未開始遊戲,無法加題');
      return;
    }
    const n = Math.max(1, Math.min(20, Math.floor(payload?.n ?? 1)));
    this.state.game.totalQ += n;
    this.broadcastEvent({
      type: 'total_q_changed',
      payload: { totalQ: this.state.game.totalQ },
    });
  }

  /** 助理重抽某組組長(組長中離不回來、或現場要換人代表領獎)。 */
  private onReassignLeader(
    payload: { team: string },
    sender: Connection<ConnState>
  ): void {
    const team = (payload?.team || '').trim();
    const next = redrawLeader(this.state, team);
    if (!next) {
      this.sendError(sender, 'no_members', `「${team}」找不到或組內沒有人,無法抽組長`);
      return;
    }
    this.broadcastLeaders();
  }

  /** 助理設定答題倒數。durationSec>0 開始/重啟;0 停止。 */
  private onSetTimer(payload: { durationSec: number }): void {
    const dur = Math.max(0, Math.min(600, Math.floor(payload?.durationSec ?? 0)));
    this.state.timerDeadline = dur > 0 ? Date.now() + dur * 1000 : null;
    this.broadcastEvent({ type: 'timer_update', payload: { remainingSec: dur } });
  }

  /** 參賽者改名逾時自踢 → 硬移除 + 廣播 + 關閉連線。 */
  private onLeaveRoom(sender: Connection<ConnState>): void {
    const r = hardRemoveParticipant(this.state, sender.id);
    if (r.ok) {
      this.broadcastEvent({ type: 'player_leave', payload: { name: r.name!, team: r.team! } });
      this.broadcastRoster();
      // 走的人若是組長 → 同組立刻有人接任(不留幽靈組長)
      this.syncLeaders();
    }
    try { sender.close(); } catch { /* already closing */ }
  }

  private onTeamCountChanged(
    payload: { count: number; reshuffle?: boolean },
    sender: Connection<ConnState>
  ): void {
    // Lobby-only — once game starts, team count is locked.
    if (this.state.phase !== 'lobby') {
      this.sendError(
        sender,
        'phase_mismatch',
        '遊戲已開始,無法調整組數',
      );
      return;
    }
    const n = Math.max(2, Math.min(10, Math.floor(payload.count)));
    // 防誤重洗(30 人實戰教訓):助理端過去每次 WS 重連都自動送這個指令,
    // 全場玩家就被隨機重分組一次。現在「組數沒變 + 非明示 reshuffle」
    // 一律視為同步訊息,直接忽略;只有按「重新分組」按鈕(reshuffle:true)
    // 或組數真的改變才重洗名單。
    if (
      !payload.reshuffle &&
      this.state.groupingMode === 'random' &&
      this.state.groups.length === n
    ) {
      return;
    }
    // 改組數隱含「隨機平均」模式(prefix 模式不吃組數)
    this.state.groupingMode = 'random';
    // 走到這裡就一定是「真的要全員重洗」(上面的 guard 已經把同步訊息擋掉)。
    // 組名一併歸零成「第一組/第二組…」:組名綁在組別位置、不跟著人走,
    // 重洗後留著舊名字只會讓大家對不上自己的組(Vincent 2026-07-23 決定)。
    setupTeams(this.state, n, true);
    reshuffleParticipants(this.state);
    this.broadcastRoster();
    // 組名可能剛被重設 → 補一發 score_update,讓以組名為鍵渲染的畫面跟上
    this.broadcastEvent({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: -1,
        delta: 0,
      },
    });
    // 重洗後組長多半已不在原組 → 重抽並廣播
    this.syncLeaders(true);
  }

  /** 每個連線每秒最多計入幾次 buzz_press(超過的靜默丟棄)。 */
  private static readonly BUZZ_MAX_PER_SEC = 20;

  private buzzRateAllows(connId: string): boolean {
    const now = Date.now();
    const slot = this.buzzRate.get(connId);
    if (!slot || now - slot.windowStart >= 1000) {
      this.buzzRate.set(connId, { windowStart: now, count: 1 });
      return true;
    }
    if (slot.count >= PolicyGogogoServer.BUZZ_MAX_PER_SEC) return false;
    slot.count++;
    return true;
  }

  private onBuzzPress(
    payload: { name: string; team: string; ts: number },
    sender: Connection<ConnState>
  ): void {
    // 節流(見 buzzRate 欄位說明)。放在最前面,連解析都不用做。
    if (!this.buzzRateAllows(sender.id)) return;
    // 身分一律以 server 這邊的名冊為準,不看封包內容。
    // 2026-07-23 實測:payload.name / payload.team 過去是直接採信的,
    // 結果 A 組的人可以送出 team:"B組"、name:"隨便打的字" 幫別組搶答,
    // 投影幕還照著顯示、甚至讓他變成 B 組的搶答 MVP。
    const me = this.state.participants.get(sender.id);
    const name = me?.name ?? payload.name;
    const teamName = me?.team ?? payload.team;
    // 沒登記過(還沒 player_join,或根本是投影端連線)→ 不得搶答。
    if (!me && sender.state?.role !== 'participant') return;
    // Resolve the presser's team idx authoritatively.
    const team = this.state.groups.find((g) => g.name === teamName);
    if (!team) return;
    // 本題已失格的組(答不出來被重新搶答)→ 丟棄其 buzz,不得參與。
    if (this.state.excludedTeams.includes(team.idx)) return;
    const record: BuzzRecord = {
      name,
      team: teamName,
      teamIdx: team.idx,
      ts: Date.now(), // Phase 0 Q3: server-receive time, ignore client ts
    };
    rushHandleBuzz(this.state, this.rushBroadcast, record);
  }

  private onTeamRename(payload: { oldName: string; newName: string; by: string }): void {
    // 開賽即鎖組名(稽核發現:過去這條規則只靠 participant 端的
    // G.canRenameTeam 把按鈕藏起來,server 完全沒擋 —— 漏接 game_start
    // 廣播的分頁仍可在遊戲中改組名,而分數多處以組名為鍵)。
    if (this.state.phase !== 'lobby') return;
    const result = renameTeam(this.state, payload.oldName, payload.newName);
    if (!result.ok) return;
    this.broadcastEvent({
      type: 'team_rename',
      payload: { oldName: payload.oldName, newName: payload.newName.trim(), by: payload.by },
    });
    // Also emit a score_update so any UI that re-renders by name gets the new label.
    this.broadcastEvent({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: -1,
        delta: 0,
      },
    });
  }

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────

  private normalizeRole(raw: string | null): ConnectionRole {
    if (raw === 'assistant' || raw === 'presenter' || raw === 'participant') return raw;
    return 'presenter'; // safest default — read-only
  }

  private send(conn: Connection, event: ServerEvent): void {
    conn.send(JSON.stringify(event));
  }

  private broadcastEvent(event: ServerEvent, except?: string[]): void {
    // this.broadcast = partyserver 基底類別的廣播(字串進、全連線出)
    this.broadcast(JSON.stringify(event), except);
  }

  private sendError(
    conn: Connection,
    code: string,
    message: string
  ): void {
    this.send(conn, { type: '__error__', payload: { code, message } });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Worker entry — 路由 /parties/main/<room> 到 Main binding(= 上面的 DO)。
// URL 形狀與 PartyKit 完全一致,partysocket 前端不用改。
// ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const res = await routePartykitRequest(request, env as never);
    return res ?? new Response('Not found', { status: 404 });
  },
};
