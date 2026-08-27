/**
 * client/partybus.ts — browser-side PartyBus adapter.
 *
 * Public API (kept BYTE-FOR-BYTE identical to the inline PartyBus block
 * that previously lived in each HTML, so no business-logic call site has
 * to change):
 *
 *   PartyBus.emit(type, payload)           — send command to server
 *   PartyBus.on(type, cb)                  — subscribe to server events
 *
 * New (additive) API for Phase 3:
 *
 *   PartyBus.init({...})                   — open the WebSocket
 *   PartyBus.onStatus(cb)                  — connection-status updates
 *   PartyBus.getStatus()                   — current connection status
 *   PartyBus.getControlCode()              — assistant-side accessor
 *
 * Bundled to /public/lib/partybus.js as an IIFE; assigns `window.PartyBus`
 * synchronously so legacy inline scripts can call PartyBus.emit/on without
 * waiting for a module load.
 */

import PartySocket from 'partysocket';

type Role = 'assistant' | 'presenter' | 'participant';
type Status = 'connecting' | 'connected' | 'disconnected';
type Listener = (payload: unknown) => void;
type StatusListener = (status: Status) => void;

interface InitOptions {
  role: Role;
  roomId: string;
  name?: string;            // participant only
  team?: string;            // participant only
  /**
   * Per-device identity, persisted in localStorage by the caller. Multiple
   * tabs from the same browser share this; server uses it to dedup so one
   * device = one participant (新開分頁踢掉舊分頁,合併進同一組)。
   */
  deviceId?: string;
  /** Override server host. Default: window.location.host (same-origin). */
  host?: string;
  /** PartyKit "party" name. Default: 'main'. */
  party?: string;
}

const SESSION_STORAGE_CC_KEY = 'pgg_assistant_controlcode_v1';

class PartyBusImpl {
  private listeners = new Map<string, Listener[]>();
  private statusListeners: StatusListener[] = [];
  private socket: PartySocket | null = null;
  private role: Role | null = null;
  private controlCode: string | null = null;
  // Default 'connecting' (not 'disconnected') so a freshly-loaded page shows
  // a neutral "warming up" indicator instead of a scary red disconnected
  // flash before init() runs. Stays 'connecting' until the WebSocket opens
  // (or fails). Phase 0 reg #3 — "斷線提示是異常狀態,初始載入不該觸發".
  private status: Status = 'connecting';

  init(opts: InitOptions): void {
    if (this._kicked) {
      console.warn('PartyBus.init ignored — this tab was kicked by another tab');
      return;
    }
    if (this.socket) {
      console.warn('PartyBus.init called more than once; ignoring');
      return;
    }
    this.role = opts.role;

    // Restore previously-issued controlCode from sessionStorage (assistant
    // refreshing the page should not lose host privileges).
    if (opts.role === 'assistant') {
      try {
        const stored = sessionStorage.getItem(SESSION_STORAGE_CC_KEY);
        if (stored) this.controlCode = stored;
      } catch {
        /* sessionStorage may be disabled in some embedded contexts */
      }
    }

    const query: Record<string, string> = { role: opts.role };
    if (opts.name) query.name = opts.name;
    if (opts.team) query.team = opts.team;
    if (opts.deviceId) query.deviceId = opts.deviceId;
    if (opts.role === 'assistant' && this.controlCode) {
      query.controlCode = this.controlCode;
    }

    this.socket = new PartySocket({
      host: opts.host ?? window.location.host,
      party: opts.party ?? 'main',
      room: opts.roomId,
      query,
    });

    this.setStatus('connecting');

    this.socket.addEventListener('open', () => this.setStatus('connected'));
    this.socket.addEventListener('close', () => this.setStatus('disconnected'));
    this.socket.addEventListener('error', () => this.setStatus('disconnected'));

    this.socket.addEventListener('message', (e: MessageEvent) => {
      let env: { type?: string; payload?: unknown };
      try {
        env = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (!env || typeof env.type !== 'string') return;

      // Keepalive:任何 server 訊息都證明連線活著。
      this._lastMsgAt = Date.now();
      if (env.type === '__pong__') {
        // server 支援 pong → 啟用「太久沒訊息就強制重連」判定。
        this._pongCapable = true;
        return; // 純 keepalive 訊框,不用 dispatch
      }

      // Intercept server-private frames before dispatching.
      if (env.type === '__welcome__') {
        const wp = env.payload as { controlCode?: string } | undefined;
        if (wp?.controlCode && this.role === 'assistant') {
          this.controlCode = wp.controlCode;
          try {
            sessionStorage.setItem(SESSION_STORAGE_CC_KEY, wp.controlCode);
          } catch {
            /* ignore */
          }
        }
      } else if (env.type === '__error__') {
        // Surface server errors to console so debugging is easier; still
        // dispatch to listeners in case the HTML wants to render an alert.
        console.warn('PartyBus server error:', env.payload);
      } else if (env.type === '__kicked__') {
        // 同 deviceId 新分頁進來,server 把本連線踢掉。標記為 kicked,
        // 主動 close 並停止重連(否則 partysocket 會自動重連 → server 又
        // 踢新分頁 → 兩邊互相踢的迴圈)。HTML 那邊 listen __kicked__
        // 顯示提示。
        this._kicked = true;
        try { this.socket?.close(); } catch { /* ignore */ }
        this.socket = null;
        this._stopKeepalive();
      }

      this._dispatch(env.type, env.payload);
    });

    this._startKeepalive();
  }

  // ─────────────────────────────────────────────────────────────────
  // Keepalive — 半死連線偵測
  // ─────────────────────────────────────────────────────────────────
  // TCP 連線可能「已死但瀏覽器沒收到 close」(NAT timeout、網卡休眠、
  // AP 掉包等):訊息從此收不到,partysocket 也不會重連(它只聽
  // close/error)。現場症狀:投影端卡在舊畫面 ~30 秒,直到瀏覽器自己
  // 發現連線死了 → partysocket 重連 → __room_state__ 快照把畫面救回。
  //
  // 對策:閒置超過 IDLE_PING_MS 就送 ping(server 回 __pong__;任何
  // server 訊息都會刷新 _lastMsgAt);完全沉默超過 STALE_RECONNECT_MS
  // → 主動 reconnect(),讓快照立刻還原畫面,不等瀏覽器慢慢發現。
  //
  // 相容性:收到第一個 __pong__ 前不啟動強制重連(_pongCapable gate),
  // 避免「前端已更新、PartyKit server 還沒 deploy」的空窗期在安靜房間
  // 每 25 秒白白重連一次。
  private _lastMsgAt = 0;
  private _pongCapable = false;
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly IDLE_PING_MS = 8_000;
  private static readonly STALE_RECONNECT_MS = 25_000;

  private _startKeepalive(): void {
    this._lastMsgAt = Date.now();
    if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
    this._keepaliveTimer = setInterval(() => this._keepaliveTick(), 5_000);
    // 手機解鎖 / 切回分頁 / 網路恢復:立刻檢查,不等下一個 tick。
    window.addEventListener('online', () => this._keepaliveTick());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._keepaliveTick();
    });
  }

  private _stopKeepalive(): void {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  private _keepaliveTick(): void {
    if (this._kicked || !this.socket) return;
    const idle = Date.now() - this._lastMsgAt;
    if (this._pongCapable && idle > PartyBusImpl.STALE_RECONNECT_MS) {
      console.warn(
        `PartyBus keepalive: ${Math.round(idle / 1000)}s 沒收到任何 server 訊息 — 判定連線半死,強制重連`
      );
      this._lastMsgAt = Date.now(); // 重連期間不重複觸發
      this.setStatus('connecting');
      try { this.socket.reconnect(); } catch { /* ignore */ }
    } else if (idle > PartyBusImpl.IDLE_PING_MS) {
      // 閒置才 ping;有正常廣播流量時不多嘴。
      try { this.emit('ping', { from: this.role, keepalive: true }); } catch { /* ignore */ }
    }
  }

  /** True after server sent __kicked__; emit/init become no-ops. */
  private _kicked = false;

  /**
   * 主動永久離線:關閉連線並停止自動重連(改名逾時被請出房間時用)。
   * 不這樣做的話 partysocket 會自動重連 —— 人雖然已被移出名單,socket
   * 仍掛著,助理端點名會多算一個。之後 emit/init 都變成 no-op。
   */
  disconnect(): void {
    this._kicked = true;
    try { this.socket?.close(); } catch { /* already closing */ }
    this.socket = null;
    this._stopKeepalive();
    this.setStatus('disconnected');
  }

  /**
   * 連線斷掉時「不可以默默丟掉」的指令。這些是助理按下去會改變全場狀態的
   * 操作,丟掉了助理不會知道,畫面卻已經自己往前走。
   *
   * 2026-07-23 實測事故:助理端 socket 是 disconnected 狀態時按了「重新開始」,
   * 助理端畫面照常回到設定頁、狀態列還寫「遊戲已重置」,但 server 完全沒收到
   * (phase 仍是 ended、分數還在)。助理毫不知情,接著在錯誤狀態上疊操作。
   *
   * 這裡不做「自動補送」—— 補送一個幾分鐘前按的「下一題」比丟掉更危險。
   * 改成:送不出去就明確讓呼叫端與使用者知道,由人決定要不要重按。
   */
  private static readonly MUST_DELIVER = new Set<string>([
    'game_start', 'game_restart', 'score_adjust', 'start_rush', 'rebuzz_same', 'fresh_rush',
    'enter_category', 'category_preview', 'category_confirm', 'category_reset',
    'reveal_answer', 'next_question', 'skip_question', 'redraw_question',
    'arm_purgatory', 'mode_preview', 'custom_tiers_changed', 'rush_mode_changed',
    'presenter_show_qr', 'export_result', 'team_count_changed',
    'grouping_mode_changed', 'notify_group', 'set_timer', 'round_reset',
    'clear_prior_asked', 'reassign_leader', 'team_rename', 'player_join', 'rename_self',
  ]);

  /** 指令送不出去時通知外層(助理端用來跳警告)。 */
  private undeliveredListeners: ((type: string) => void)[] = [];

  onUndelivered(cb: (type: string) => void): void {
    this.undeliveredListeners.push(cb);
  }

  private reportUndelivered(type: string): void {
    for (const cb of this.undeliveredListeners) {
      try { cb(type); } catch (err) { console.error('PartyBus undelivered listener error:', err); }
    }
  }

  /**
   * 送指令。回傳 true = 已交給 socket 送出;false = 沒送出去。
   * 呼叫端**不應該**在拿到 false 之後還把本機 UI 當成操作成功。
   */
  emit(type: string, payload?: unknown): boolean {
    const socket = this.socket;
    // readyState 1 = OPEN。重連中(CONNECTING)送出去會直接丟例外或被吞掉,
    // 兩種都是靜默失敗 —— 一律當成沒送出。
    const usable = !!socket && socket.readyState === 1;
    if (!usable) {
      if (PartyBusImpl.MUST_DELIVER.has(type)) {
        console.warn(`PartyBus.emit('${type}') 沒有送出 — 連線不可用(readyState=${socket ? socket.readyState : 'no socket'})`);
        this.reportUndelivered(type);
      }
      // ping / buzz_press 這類高頻無狀態指令:丟掉就丟掉,不吵使用者。
      return false;
    }
    const env: Record<string, unknown> = { type, payload };
    // Auto-attach controlCode for assistant-issued commands. Server only
    // requires it for privileged ones, but attaching to all is harmless
    // and avoids needing a duplicate "is this privileged?" table on the
    // client.
    if (this.role === 'assistant' && this.controlCode) {
      env.controlCode = this.controlCode;
    }
    try {
      socket.send(JSON.stringify(env));
      return true;
    } catch (err) {
      console.warn(`PartyBus.emit('${type}') send 失敗:`, err);
      if (PartyBusImpl.MUST_DELIVER.has(type)) this.reportUndelivered(type);
      return false;
    }
  }

  on(type: string, cb: Listener): void {
    let arr = this.listeners.get(type);
    if (!arr) {
      arr = [];
      this.listeners.set(type, arr);
    }
    arr.push(cb);
  }

  onStatus(cb: StatusListener): void {
    this.statusListeners.push(cb);
    // Replay current status immediately so subscribers can render correctly
    // even if they registered after a connection event.
    try {
      cb(this.status);
    } catch (err) {
      console.error('PartyBus status listener error:', err);
    }
  }

  getStatus(): Status {
    return this.status;
  }

  getControlCode(): string | null {
    return this.controlCode;
  }

  /** Test/debug helper — drop the saved controlCode so the next init()
   * acts as a fresh assistant connection. Not used by app code. */
  forgetControlCode(): void {
    this.controlCode = null;
    try {
      sessionStorage.removeItem(SESSION_STORAGE_CC_KEY);
    } catch {
      /* ignore */
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────

  private _dispatch(type: string, payload: unknown): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    for (const cb of arr) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`PartyBus listener[${type}] error:`, err);
      }
    }
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of this.statusListeners) {
      try {
        cb(s);
      } catch (err) {
        console.error('PartyBus status listener error:', err);
      }
    }
  }
}

const PartyBus = new PartyBusImpl();
(window as unknown as { PartyBus: PartyBusImpl }).PartyBus = PartyBus;
export default PartyBus;
