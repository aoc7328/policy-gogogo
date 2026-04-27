/**
 * server.ts — PartyKit Durable Object entry point.
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

import type * as Party from 'partykit/server';

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
  renameTeam,
  snapshot,
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

export default class PolicyGogogoServer implements Party.Server {
  state: RoomState;

  constructor(readonly room: Party.Room) {
    this.state = createInitialState(room.id, generateControlCode());
  }

  // ────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────

  onConnect(conn: Party.Connection<ConnState>, ctx: Party.ConnectionContext): void {
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
      for (const c of this.room.getConnections<ConnState>()) {
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
        serverTime: Date.now(),
      },
    });

    // If a participant connected with valid name+team, register immediately
    // and broadcast player_join (so the assistant updates the roster)。
    // 同 deviceId 接管(replacedExistingTab):仍然 upsert(新 conn.id),但
    // 不廣播 player_join — 觀眾視角這個人本來就在房裡,助理進退場紀錄
    // 不該再多跳一條「加入」。
    if (role === 'participant' && name && team) {
      upsertParticipant(this.state, conn.id, name, team);
      if (!replacedExistingTab) {
        this.broadcast({ type: 'player_join', payload: { name, team } });
      }
    }

    // Push current room snapshot so the connection can render correct UI.
    this.send(conn, { type: '__room_state__', payload: snapshot(this.state) });
  }

  onClose(conn: Party.Connection<ConnState>): void {
    const cs = conn.state;
    if (cs?.role === 'participant') {
      const ref = removeParticipantByConn(this.state, conn.id);
      if (ref) {
        this.broadcast({
          type: 'player_leave',
          payload: { name: ref.name, team: ref.team },
        });
      }
    }
  }

  onError(conn: Party.Connection, err: Error): void {
    console.error(`conn ${conn.id} error:`, err);
  }

  // ────────────────────────────────────────────────────────────
  // Message routing
  // ────────────────────────────────────────────────────────────

  onMessage(message: string, sender: Party.Connection<ConnState>): void {
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
    } catch (err) {
      console.error('dispatch error:', err);
      this.sendError(
        sender,
        'internal',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private dispatch(cmd: ClientCommand, sender: Party.Connection<ConnState>): void {
    switch (cmd.type) {
      case 'ping':
        return; // diagnostic; no echo needed
      case 'game_start':
        return this.onGameStart(cmd.payload);
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
      case 'mode_preview':
        return this.broadcast({ type: 'mode_preview', payload: cmd.payload });
      case 'custom_tiers_changed':
        return this.broadcast({ type: 'custom_tiers_changed', payload: cmd.payload });
      case 'rush_mode_changed':
        return this.onRushModeChanged(cmd.payload);
      case 'presenter_show_qr':
        return this.broadcast({ type: 'presenter_show_qr', payload: cmd.payload });
      case 'export_result':
        return this.onExportResult();
      case 'player_join':
        return this.onPlayerJoin(cmd.payload, sender);
      case 'buzz_press':
        return this.onBuzzPress(cmd.payload, sender);
      case 'team_rename':
        return this.onTeamRename(cmd.payload);
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

  private onGameStart(config: GameConfig): void {
    stateStartGame(this.state, config);
    this.broadcast({ type: 'game_start', payload: config });
    // Push fresh score baseline (all zeros) so clients render bars.
    this.broadcast({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: -1,
        delta: 0,
      },
    });
  }

  private onScoreAdjust(payload: { teamIdx: number; delta: number }): void {
    const result = adjustScore(this.state, payload.teamIdx, payload.delta);
    if (!result.ok) return;
    this.broadcast({
      type: 'score_update',
      payload: {
        scores: this.state.groups.map((g) => ({ idx: g.idx, name: g.name, score: g.score })),
        changedIdx: payload.teamIdx,
        delta: payload.delta,
      },
    });
  }

  private onStartRush(rerush: boolean, sender: Party.Connection<ConnState>): void {
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
    rushStart(this.state, (e) => this.broadcast(e), { rerush });
  }

  private onEnterCategory(sender: Party.Connection<ConnState>): void {
    if (this.state.phase !== 'won') {
      this.sendError(sender, 'wrong_phase',
        `enter_category 只能在 won 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    this.state.phase = 'picking';
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.broadcast({ type: 'enter_category', payload: {} });
  }

  private onCategoryPreview(payload: { fid: string }): void {
    if (this.state.phase !== 'picking') return;
    this.state.currentCat = payload.fid;
    this.broadcast({ type: 'category_preview', payload });
  }

  private onCategoryConfirm(
    payload: { fid: string },
    sender: Party.Connection<ConnState>
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
    this.state.currQ = (this.state.currQ ?? 0) + 1;
    this.state.phase = 'answering';

    this.broadcast({ type: 'category_confirm', payload });
    if (result.triggersPurgatory) {
      this.broadcast({ type: 'purgatory_summon', payload: {} });
    }
    this.broadcast({
      type: 'question_pick',
      payload: {
        id: result.question.id,
        difficulty: result.question.difficulty,
        framework: result.question.framework,
        roundQ: this.state.currQ,
      },
    });
  }

  private onCategoryReset(): void {
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.broadcast({ type: 'category_reset', payload: {} });
  }

  private onRevealAnswer(sender: Party.Connection<ConnState>): void {
    if (this.state.phase !== 'answering') {
      this.sendError(sender, 'wrong_phase',
        `reveal_answer 只能在 answering 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    this.state.phase = 'revealed';
    this.broadcast({ type: 'reveal_answer', payload: {} });
  }

  private onNextQuestion(sender: Party.Connection<ConnState>): void {
    if (this.state.phase !== 'revealed' && this.state.phase !== 'answering') {
      this.sendError(sender, 'wrong_phase',
        `next_question 只能在 answering/revealed 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    // Was the question a purgatory one? If so, end the FX before transitioning.
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcast({ type: 'purgatory_end', payload: {} });
    }
    this.state.currentQuestion = null;
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.state.phase = 'idle';
    this.broadcast({ type: 'next_question', payload: {} });
    // End game if we've reached totalQ.
    if (this.state.game && this.state.currQ >= this.state.game.totalQ) {
      this.state.phase = 'ended';
    }
  }

  private onSkipQuestion(sender: Party.Connection<ConnState>): void {
    if (this.state.phase !== 'answering' && this.state.phase !== 'revealed') {
      this.sendError(sender, 'wrong_phase',
        `skip_question 只能在 answering/revealed 階段送(目前 server phase=${this.state.phase})。` +
        `若 server 在 lobby,請按「重新開始」整場重置。`);
      return;
    }
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcast({ type: 'purgatory_end', payload: {} });
    }
    // Phase 4 fix:不再 decrement currQ。currQ 語意統一成「已抽過的題數」,
    // skip 也算抽過(問題已亮出來給觀眾看了),不能讓 counter 退回去。
    // 之前 decrement 是 demo 階段「skip 不算數」的舊語意,跟 user expectation
    // 不符(user 期待 counter 跟著 question 往前)。
    this.state.currentQuestion = null;
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.state.phase = 'idle';
    this.broadcast({ type: 'skip_question', payload: {} });
  }

  private onGameRestart(): void {
    // 若當前題目是煉獄,先廣播 purgatory_end 讓三端清掉煉獄特效。
    // 沒這行的話,user 在煉獄題顯示中按重新開始 → 三端 UI 雖然回到 idle,
    // 但 .purg-on / stage[data-mode="purgatory"] / 火星粒子全部殘留,
    // 看起來像 bug(user-reported Phase 4)。
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcast({ type: 'purgatory_end', payload: {} });
    }
    rushAbort(this.state);
    stateRestartGame(this.state);
    this.broadcast({ type: 'game_restart', payload: {} });
    // Also push a fresh snapshot to all so they reset their UI.
    for (const c of this.room.getConnections<ConnState>()) {
      this.send(c, { type: '__room_state__', payload: snapshot(this.state) });
    }
  }

  private onArmPurgatory(payload: { armed: boolean }): void {
    // Hidden 秘技: server stores flag silently, no broadcast.
    this.state.purgArmed = !!payload.armed;
  }

  /**
   * 主持人介面 claim flow:
   * - 驗證 payload.code 與 state.controlCode 相符
   * - 已被 claim → 回 __error__('already_claimed')
   * - 否則設 flag + 廣播 presenter_claimed → 所有 participant 鎖按鈕,
   *   呼叫端從 broadcast 知道自己 claim 成功(因為自己也會收到)
   */
  private onClaimPresenter(
    payload: { code: string },
    sender: Party.Connection<ConnState>
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
    if (this.state.presenterClaimed) {
      this.sendError(sender, 'already_claimed', '主持人介面已被其他裝置開啟');
      return;
    }
    this.state.presenterClaimed = true;
    this.broadcast({
      type: 'presenter_claimed',
      payload: { at: Date.now() },
    });
  }

  private onRedrawQuestion(sender: Party.Connection<ConnState>): void {
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

    // 替換 currentQuestion + askedQuestions 最後一筆
    this.state.usedIds.add(result.question.id);
    if (this.state.askedQuestions.length > 0) {
      this.state.askedQuestions[this.state.askedQuestions.length - 1] = {
        id: result.question.id,
        difficulty: result.question.difficulty,
        framework: result.question.framework,
      };
    }
    this.state.currentQuestion = {
      id: result.question.id,
      difficulty: result.question.difficulty,
      framework: result.question.framework,
    };
    // currQ 不變(同一輪)
    if (result.triggersPurgatory) {
      this.broadcast({ type: 'purgatory_summon', payload: {} });
    } else if (this.state.currentQuestion.difficulty !== 'purgatory') {
      // 重抽從煉獄變一般題,要清掉煉獄特效
      this.broadcast({ type: 'purgatory_end', payload: {} });
    }
    this.broadcast({
      type: 'question_pick',
      payload: {
        id: result.question.id,
        difficulty: result.question.difficulty,
        framework: result.question.framework,
        roundQ: this.state.currQ,   // 重抽不增 currQ,送同一輪數
        redraw: true,
      },
    });
  }

  private onRushModeChanged(payload: { mode: import('./protocol').RushMode; label: string }): void {
    this.state.rushMode = payload.mode;
    this.broadcast({ type: 'rush_mode_changed', payload });
  }

  private onExportResult(): void {
    if (!this.state.game) return;
    const sortedGroups = [...this.state.groups]
      .sort((a, b) => b.score - a.score)
      .map((g) => ({ name: g.name, score: g.score }));
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
      })),
      sortedGroups,
      askedQuestions: [...this.state.askedQuestions],
      exportTime: new Date().toISOString(),
    };
    this.broadcast({ type: 'export_result', payload });
  }

  // ────────────────────────────────────────────────────────────
  // Unprivileged participant handlers
  // ────────────────────────────────────────────────────────────

  private onPlayerJoin(
    payload: { name: string; team: string },
    sender: Party.Connection<ConnState>
  ): void {
    if (!payload.name || !payload.team) return;
    upsertParticipant(this.state, sender.id, payload.name, payload.team);
    sender.setState({
      role: 'participant',
      name: payload.name,
      team: payload.team,
      deviceId: sender.state?.deviceId ?? null,
      verified: false,
    });
    this.broadcast({ type: 'player_join', payload });
  }

  private onBuzzPress(
    payload: { name: string; team: string; ts: number },
    sender: Party.Connection<ConnState>
  ): void {
    // Resolve the presser's team idx authoritatively.
    const team = this.state.groups.find((g) => g.name === payload.team);
    if (!team) return;
    const record: BuzzRecord = {
      name: payload.name,
      team: payload.team,
      teamIdx: team.idx,
      ts: Date.now(), // Phase 0 Q3: server-receive time, ignore client ts
    };
    void sender;
    rushHandleBuzz(this.state, (e) => this.broadcast(e), record);
  }

  private onTeamRename(payload: { oldName: string; newName: string; by: string }): void {
    const result = renameTeam(this.state, payload.oldName, payload.newName);
    if (!result.ok) return;
    this.broadcast({
      type: 'team_rename',
      payload: { oldName: payload.oldName, newName: payload.newName.trim(), by: payload.by },
    });
    // Also emit a score_update so any UI that re-renders by name gets the new label.
    this.broadcast({
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

  private send(conn: Party.Connection, event: ServerEvent): void {
    conn.send(JSON.stringify(event));
  }

  private broadcast(event: ServerEvent, except?: string[]): void {
    this.room.broadcast(JSON.stringify(event), except);
  }

  private sendError(
    conn: Party.Connection,
    code: string,
    message: string
  ): void {
    this.send(conn, { type: '__error__', payload: { code, message } });
  }
}
