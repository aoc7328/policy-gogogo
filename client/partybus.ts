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
      }

      this._dispatch(env.type, env.payload);
    });
  }

  emit(type: string, payload?: unknown): void {
    if (!this.socket) {
      console.warn(`PartyBus.emit('${type}') called before init() — dropped`);
      return;
    }
    const env: Record<string, unknown> = { type, payload };
    // Auto-attach controlCode for assistant-issued commands. Server only
    // requires it for privileged ones, but attaching to all is harmless
    // and avoids needing a duplicate "is this privileged?" table on the
    // client.
    if (this.role === 'assistant' && this.controlCode) {
      env.controlCode = this.controlCode;
    }
    this.socket.send(JSON.stringify(env));
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
