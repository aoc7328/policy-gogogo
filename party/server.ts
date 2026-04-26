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
    const presentedCode = url.searchParams.get('controlCode');

    let verified = false;
    if (role === 'assistant') {
      verified =
        presentedCode === null ||
        verifyControlCode(presentedCode, this.state.controlCode);
      if (!verified) {
        this.send(conn, {
          type: '__error__',
          payload: { code: 'unauth', message: 'Bad controlCode' },
        });
        conn.close();
        return;
      }
    }

    conn.setState({
      role,
      name: role === 'participant' ? name : null,
      team: role === 'participant' ? team : null,
      verified,
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
    // and broadcast player_join (so the assistant updates the roster).
    if (role === 'participant' && name && team) {
      upsertParticipant(this.state, conn.id, name, team);
      this.broadcast({ type: 'player_join', payload: { name, team } });
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
        return this.onStartRush(cmd.payload?.rerush ?? false);
      case 'enter_category':
        return this.onEnterCategory();
      case 'category_preview':
        return this.onCategoryPreview(cmd.payload);
      case 'category_confirm':
        return this.onCategoryConfirm(cmd.payload);
      case 'category_reset':
        return this.onCategoryReset();
      case 'reveal_answer':
        return this.onRevealAnswer();
      case 'next_question':
        return this.onNextQuestion();
      case 'skip_question':
        return this.onSkipQuestion();
      case 'game_restart':
        return this.onGameRestart();
      case 'arm_purgatory':
        return this.onArmPurgatory(cmd.payload);
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

  private onStartRush(rerush: boolean): void {
    if (this.state.phase !== 'idle' && this.state.phase !== 'won') {
      // Allow re-rush from "won" too (the assistant can rebuzz a tied round).
      // From any other phase it's a no-op.
      return;
    }
    rushStart(this.state, (e) => this.broadcast(e), { rerush });
  }

  private onEnterCategory(): void {
    if (this.state.phase !== 'won') return;
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

  private onCategoryConfirm(payload: { fid: string }): void {
    if (this.state.phase !== 'picking') return;
    this.state.currentCat = payload.fid;
    this.state.catLocked = true;
    this.broadcast({ type: 'category_confirm', payload });

    // Pick a question.
    if (!this.state.game) return;
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
      this.broadcast({
        type: '__error__',
        payload: {
          code: 'no_question',
          message: result.reason,
        },
      });
      return;
    }

    // Consume purgArmed flag if used.
    const wasArmed = this.state.purgArmed;
    if (wasArmed) this.state.purgArmed = false;

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

    if (result.triggersPurgatory) {
      this.broadcast({ type: 'purgatory_summon', payload: {} });
    }

    this.broadcast({
      type: 'question_pick',
      payload: {
        id: result.question.id,
        difficulty: result.question.difficulty,
        framework: result.question.framework,
      },
    });
  }

  private onCategoryReset(): void {
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.broadcast({ type: 'category_reset', payload: {} });
  }

  private onRevealAnswer(): void {
    if (this.state.phase !== 'answering') return;
    this.state.phase = 'revealed';
    this.broadcast({ type: 'reveal_answer', payload: {} });
  }

  private onNextQuestion(): void {
    if (this.state.phase !== 'revealed' && this.state.phase !== 'answering') return;
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

  private onSkipQuestion(): void {
    if (this.state.phase !== 'answering' && this.state.phase !== 'revealed') return;
    if (this.state.currentQuestion?.difficulty === 'purgatory') {
      this.broadcast({ type: 'purgatory_end', payload: {} });
    }
    // Skip doesn't increment currQ.
    this.state.currQ = Math.max(0, (this.state.currQ ?? 0) - 1);
    this.state.currentQuestion = null;
    this.state.currentCat = null;
    this.state.catLocked = false;
    this.state.phase = 'idle';
    this.broadcast({ type: 'skip_question', payload: {} });
  }

  private onGameRestart(): void {
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

  private onRushModeChanged(payload: { mode: import('./protocol').RushMode; label: string }): void {
    this.state.rushMode = payload.mode;
    this.broadcast({ type: 'rush_mode_changed', payload });
  }

  private onExportResult(): void {
    if (!this.state.game) return;
    const sortedGroups = [...this.state.groups]
      .sort((a, b) => b.score - a.score)
      .map((g) => ({ name: g.name, score: g.score }));
    const payload = {
      mode: this.state.game.mode,
      modeLabel: this.state.game.mode,
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
