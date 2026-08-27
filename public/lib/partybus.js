"use strict";
(() => {
  // ../../../node_modules/partysocket/dist/ws.js
  if (!globalThis.EventTarget || !globalThis.Event)
    console.error(`
  PartySocket requires a global 'EventTarget' class to be available!
  You can polyfill this global by adding this to your code before any partysocket imports: 
  
  \`\`\`
  import 'partysocket/event-target-polyfill';
  \`\`\`
  Please file an issue at https://github.com/partykit/partykit if you're still having trouble.
`);
  var ErrorEvent = class extends Event {
    message;
    error;
    constructor(error, target) {
      super("error", target);
      this.message = error.message;
      this.error = error;
    }
  };
  var CloseEvent = class extends Event {
    code;
    reason;
    wasClean = true;
    constructor(code = 1e3, reason = "", target) {
      super("close", target);
      this.code = code;
      this.reason = reason;
    }
  };
  var Events = {
    Event,
    ErrorEvent,
    CloseEvent
  };
  function assert(condition, msg) {
    if (!condition) throw new Error(msg);
  }
  function cloneEventBrowser(e) {
    return new e.constructor(e.type, e);
  }
  function cloneEventNode(e) {
    if ("data" in e) return new MessageEvent(e.type, e);
    if ("code" in e || "reason" in e)
      return new CloseEvent(e.code || 1999, e.reason || "unknown reason", e);
    if ("error" in e) return new ErrorEvent(e.error, e);
    return new Event(e.type, e);
  }
  var isNode = typeof process !== "undefined" && typeof process.versions?.node !== "undefined";
  var isReactNative = typeof navigator !== "undefined" && navigator.product === "ReactNative";
  var cloneEvent = isNode || isReactNative ? cloneEventNode : cloneEventBrowser;
  var DEFAULT = {
    maxReconnectionDelay: 1e4,
    minReconnectionDelay: 1e3 + Math.random() * 4e3,
    minUptime: 5e3,
    reconnectionDelayGrowFactor: 1.3,
    connectionTimeout: 4e3,
    maxRetries: Number.POSITIVE_INFINITY,
    maxEnqueuedMessages: Number.POSITIVE_INFINITY,
    startClosed: false,
    debug: false
  };
  var didWarnAboutMissingWebSocket = false;
  var ReconnectingWebSocket = class ReconnectingWebSocket2 extends EventTarget {
    _ws;
    _retryCount = -1;
    _uptimeTimeout;
    _connectTimeout;
    _shouldReconnect = true;
    _connectLock = false;
    _binaryType = "blob";
    _closeCalled = false;
    _messageQueue = [];
    _debugLogger = console.log.bind(console);
    _url;
    _protocols;
    _options;
    constructor(url, protocols, options = {}) {
      super();
      this._url = url;
      this._protocols = protocols;
      this._options = options;
      if (this._options.startClosed) this._shouldReconnect = false;
      if (this._options.debugLogger)
        this._debugLogger = this._options.debugLogger;
      this._connect();
    }
    static get CONNECTING() {
      return 0;
    }
    static get OPEN() {
      return 1;
    }
    static get CLOSING() {
      return 2;
    }
    static get CLOSED() {
      return 3;
    }
    get CONNECTING() {
      return ReconnectingWebSocket2.CONNECTING;
    }
    get OPEN() {
      return ReconnectingWebSocket2.OPEN;
    }
    get CLOSING() {
      return ReconnectingWebSocket2.CLOSING;
    }
    get CLOSED() {
      return ReconnectingWebSocket2.CLOSED;
    }
    get binaryType() {
      return this._ws ? this._ws.binaryType : this._binaryType;
    }
    set binaryType(value) {
      this._binaryType = value;
      if (this._ws) this._ws.binaryType = value;
    }
    /**
     * Returns the number or connection retries
     */
    get retryCount() {
      return Math.max(this._retryCount, 0);
    }
    /**
     * The number of bytes of data that have been queued using calls to send() but not yet
     * transmitted to the network. This value resets to zero once all queued data has been sent.
     * This value does not reset to zero when the connection is closed; if you keep calling send(),
     * this will continue to climb. Read only
     */
    get bufferedAmount() {
      return this._messageQueue.reduce((acc, message) => {
        if (typeof message === "string") acc += message.length;
        else if (message instanceof Blob) acc += message.size;
        else acc += message.byteLength;
        return acc;
      }, 0) + (this._ws ? this._ws.bufferedAmount : 0);
    }
    /**
     * The extensions selected by the server. This is currently only the empty string or a list of
     * extensions as negotiated by the connection
     */
    get extensions() {
      return this._ws ? this._ws.extensions : "";
    }
    /**
     * A string indicating the name of the sub-protocol the server selected;
     * this will be one of the strings specified in the protocols parameter when creating the
     * WebSocket object
     */
    get protocol() {
      return this._ws ? this._ws.protocol : "";
    }
    /**
     * The current state of the connection; this is one of the Ready state constants
     */
    get readyState() {
      if (this._ws) return this._ws.readyState;
      return this._options.startClosed ? ReconnectingWebSocket2.CLOSED : ReconnectingWebSocket2.CONNECTING;
    }
    /**
     * The URL as resolved by the constructor
     */
    get url() {
      return this._ws ? this._ws.url : "";
    }
    /**
     * Whether the websocket object is now in reconnectable state
     */
    get shouldReconnect() {
      return this._shouldReconnect;
    }
    /**
     * An event listener to be called when the WebSocket connection's readyState changes to CLOSED
     */
    onclose = null;
    /**
     * An event listener to be called when an error occurs
     */
    onerror = null;
    /**
     * An event listener to be called when a message is received from the server
     */
    onmessage = null;
    /**
     * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
     * this indicates that the connection is ready to send and receive data
     */
    onopen = null;
    /**
     * Closes the WebSocket connection or connection attempt, if any. If the connection is already
     * CLOSED, this method does nothing
     */
    close(code = 1e3, reason) {
      this._closeCalled = true;
      this._shouldReconnect = false;
      this._clearTimeouts();
      if (!this._ws) {
        this._debug("close enqueued: no ws instance");
        return;
      }
      if (this._ws.readyState === this.CLOSED) {
        this._debug("close: already closed");
        return;
      }
      this._ws.close(code, reason);
    }
    /**
     * Closes the WebSocket connection or connection attempt and connects again.
     * Resets retry counter;
     */
    reconnect(code, reason) {
      this._shouldReconnect = true;
      this._closeCalled = false;
      this._retryCount = -1;
      if (!this._ws || this._ws.readyState === this.CLOSED) this._connect();
      else {
        this._disconnect(code, reason);
        this._connect();
      }
    }
    /**
     * Enqueue specified data to be transmitted to the server over the WebSocket connection
     */
    send(data) {
      if (this._ws && this._ws.readyState === this.OPEN) {
        this._debug("send", data);
        this._ws.send(data);
      } else {
        const { maxEnqueuedMessages = DEFAULT.maxEnqueuedMessages } = this._options;
        if (this._messageQueue.length < maxEnqueuedMessages) {
          this._debug("enqueue", data);
          this._messageQueue.push(data);
        }
      }
    }
    _debug(...args) {
      if (this._options.debug) this._debugLogger("RWS>", ...args);
    }
    _getNextDelay() {
      const {
        reconnectionDelayGrowFactor = DEFAULT.reconnectionDelayGrowFactor,
        minReconnectionDelay = DEFAULT.minReconnectionDelay,
        maxReconnectionDelay = DEFAULT.maxReconnectionDelay
      } = this._options;
      let delay = 0;
      if (this._retryCount > 0) {
        delay = minReconnectionDelay * reconnectionDelayGrowFactor ** (this._retryCount - 1);
        if (delay > maxReconnectionDelay) delay = maxReconnectionDelay;
      }
      this._debug("next delay", delay);
      return delay;
    }
    _wait() {
      return new Promise((resolve) => {
        setTimeout(resolve, this._getNextDelay());
      });
    }
    _getNextProtocols(protocolsProvider) {
      if (!protocolsProvider) return Promise.resolve(null);
      if (typeof protocolsProvider === "string" || Array.isArray(protocolsProvider))
        return Promise.resolve(protocolsProvider);
      if (typeof protocolsProvider === "function") {
        const protocols = protocolsProvider();
        if (!protocols) return Promise.resolve(null);
        if (typeof protocols === "string" || Array.isArray(protocols))
          return Promise.resolve(protocols);
        if (protocols.then) return protocols;
      }
      throw Error("Invalid protocols");
    }
    _getNextUrl(urlProvider) {
      if (typeof urlProvider === "string") return Promise.resolve(urlProvider);
      if (typeof urlProvider === "function") {
        const url = urlProvider();
        if (typeof url === "string") return Promise.resolve(url);
        if (url.then) return url;
      }
      throw Error("Invalid URL");
    }
    _connect() {
      if (this._connectLock || !this._shouldReconnect) return;
      this._connectLock = true;
      const {
        maxRetries = DEFAULT.maxRetries,
        connectionTimeout = DEFAULT.connectionTimeout
      } = this._options;
      if (this._retryCount >= maxRetries) {
        this._debug("max retries reached", this._retryCount, ">=", maxRetries);
        this._connectLock = false;
        return;
      }
      this._retryCount++;
      this._debug("connect", this._retryCount);
      this._removeListeners();
      this._wait().then(
        () => Promise.all([
          this._getNextUrl(this._url),
          this._getNextProtocols(this._protocols || null)
        ])
      ).then(([url, protocols]) => {
        if (this._closeCalled) {
          this._connectLock = false;
          return;
        }
        if (!this._options.WebSocket && typeof WebSocket === "undefined" && !didWarnAboutMissingWebSocket) {
          console.error(`\u203C\uFE0F No WebSocket implementation available. You should define options.WebSocket. 

For example, if you're using node.js, run \`npm install ws\`, and then in your code:

import PartySocket from 'partysocket';
import WS from 'ws';

const partysocket = new PartySocket({
  host: "127.0.0.1:1999",
  room: "test-room",
  WebSocket: WS
});

`);
          didWarnAboutMissingWebSocket = true;
        }
        const WS = this._options.WebSocket || WebSocket;
        this._debug("connect", {
          url,
          protocols
        });
        this._ws = protocols ? new WS(url, protocols) : new WS(url);
        this._ws.binaryType = this._binaryType;
        this._connectLock = false;
        this._addListeners();
        this._connectTimeout = setTimeout(
          () => this._handleTimeout(),
          connectionTimeout
        );
      }).catch((err) => {
        this._connectLock = false;
        this._handleError(new Events.ErrorEvent(Error(err.message), this));
      });
    }
    _handleTimeout() {
      this._debug("timeout event");
      this._handleError(new Events.ErrorEvent(Error("TIMEOUT"), this));
    }
    _disconnect(code = 1e3, reason) {
      this._clearTimeouts();
      if (!this._ws) return;
      this._removeListeners();
      try {
        if (this._ws.readyState === this.OPEN || this._ws.readyState === this.CONNECTING)
          this._ws.close(code, reason);
        this._handleClose(new Events.CloseEvent(code, reason, this));
      } catch (_error) {
      }
    }
    _acceptOpen() {
      this._debug("accept open");
      this._retryCount = 0;
    }
    _handleOpen = (event) => {
      this._debug("open event");
      const { minUptime = DEFAULT.minUptime } = this._options;
      clearTimeout(this._connectTimeout);
      this._uptimeTimeout = setTimeout(() => this._acceptOpen(), minUptime);
      assert(this._ws, "WebSocket is not defined");
      this._ws.binaryType = this._binaryType;
      this._messageQueue.forEach((message) => {
        this._ws?.send(message);
      });
      this._messageQueue = [];
      if (this.onopen) this.onopen(event);
      this.dispatchEvent(cloneEvent(event));
    };
    _handleMessage = (event) => {
      this._debug("message event");
      if (this.onmessage) this.onmessage(event);
      this.dispatchEvent(cloneEvent(event));
    };
    _handleError = (event) => {
      this._debug("error event", event.message);
      this._disconnect(void 0, event.message === "TIMEOUT" ? "timeout" : void 0);
      if (this.onerror) this.onerror(event);
      this._debug("exec error listeners");
      this.dispatchEvent(cloneEvent(event));
      this._connect();
    };
    _handleClose = (event) => {
      this._debug("close event");
      this._clearTimeouts();
      if (this._shouldReconnect) this._connect();
      if (this.onclose) this.onclose(event);
      this.dispatchEvent(cloneEvent(event));
    };
    _removeListeners() {
      if (!this._ws) return;
      this._debug("removeListeners");
      this._ws.removeEventListener("open", this._handleOpen);
      this._ws.removeEventListener("close", this._handleClose);
      this._ws.removeEventListener("message", this._handleMessage);
      this._ws.removeEventListener("error", this._handleError);
    }
    _addListeners() {
      if (!this._ws) return;
      this._debug("addListeners");
      this._ws.addEventListener("open", this._handleOpen);
      this._ws.addEventListener("close", this._handleClose);
      this._ws.addEventListener("message", this._handleMessage);
      this._ws.addEventListener("error", this._handleError);
    }
    _clearTimeouts() {
      clearTimeout(this._connectTimeout);
      clearTimeout(this._uptimeTimeout);
    }
  };

  // ../../../node_modules/partysocket/dist/index.js
  var valueIsNotNil = (keyValuePair) => keyValuePair[1] !== null && keyValuePair[1] !== void 0;
  function generateUUID() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    let d = Date.now();
    let d2 = performance?.now && performance.now() * 1e3 || 0;
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
      let r = Math.random() * 16;
      if (d > 0) {
        r = (d + r) % 16 | 0;
        d = Math.floor(d / 16);
      } else {
        r = (d2 + r) % 16 | 0;
        d2 = Math.floor(d2 / 16);
      }
      return (c === "x" ? r : r & 3 | 8).toString(16);
    });
  }
  function getPartyInfo(partySocketOptions, defaultProtocol, defaultParams = {}) {
    const {
      host: rawHost,
      path: rawPath,
      protocol: rawProtocol,
      room,
      party,
      basePath,
      prefix,
      query
    } = partySocketOptions;
    let host = rawHost.replace(/^(http|https|ws|wss):\/\//, "");
    if (host.endsWith("/")) host = host.slice(0, -1);
    if (rawPath?.startsWith("/"))
      throw new Error("path must not start with a slash");
    const name = party ?? "main";
    const path = rawPath ? `/${rawPath}` : "";
    const protocol = rawProtocol || (host.startsWith("localhost:") || host.startsWith("127.0.0.1:") || host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.") && host.split(".")[1] >= "16" && host.split(".")[1] <= "31" || host.startsWith("[::ffff:7f00:1]:") ? defaultProtocol : `${defaultProtocol}s`);
    const baseUrl = `${protocol}://${host}/${basePath || `${prefix || "parties"}/${name}/${room}`}${path}`;
    const makeUrl = (query2 = {}) => `${baseUrl}?${new URLSearchParams([...Object.entries(defaultParams), ...Object.entries(query2).filter(valueIsNotNil)])}`;
    const urlProvider = typeof query === "function" ? async () => makeUrl(await query()) : makeUrl(query);
    return {
      host,
      path,
      room,
      name,
      protocol,
      partyUrl: baseUrl,
      urlProvider
    };
  }
  var PartySocket = class extends ReconnectingWebSocket {
    _pk;
    _pkurl;
    name;
    room;
    host;
    path;
    basePath;
    constructor(partySocketOptions) {
      const wsOptions = getWSOptions(partySocketOptions);
      super(wsOptions.urlProvider, wsOptions.protocols, wsOptions.socketOptions);
      this.partySocketOptions = partySocketOptions;
      this.setWSProperties(wsOptions);
      if (!partySocketOptions.startClosed && !this.room && !this.basePath) {
        this.close();
        throw new Error(
          "Either room or basePath must be provided to connect. Use startClosed: true to create a socket and set them via updateProperties before calling reconnect()."
        );
      }
      if (!partySocketOptions.disableNameValidation) {
        if (partySocketOptions.party?.includes("/"))
          console.warn(
            `PartySocket: party name "${partySocketOptions.party}" contains forward slash which may cause routing issues. Consider using a name without forward slashes or set disableNameValidation: true to bypass this warning.`
          );
        if (partySocketOptions.room?.includes("/"))
          console.warn(
            `PartySocket: room name "${partySocketOptions.room}" contains forward slash which may cause routing issues. Consider using a name without forward slashes or set disableNameValidation: true to bypass this warning.`
          );
      }
    }
    updateProperties(partySocketOptions) {
      const wsOptions = getWSOptions({
        ...this.partySocketOptions,
        ...partySocketOptions,
        host: partySocketOptions.host ?? this.host,
        room: partySocketOptions.room ?? this.room,
        path: partySocketOptions.path ?? this.path,
        basePath: partySocketOptions.basePath ?? this.basePath
      });
      this._url = wsOptions.urlProvider;
      this._protocols = wsOptions.protocols;
      this._options = wsOptions.socketOptions;
      this.setWSProperties(wsOptions);
    }
    setWSProperties(wsOptions) {
      const { _pk, _pkurl, name, room, host, path, basePath } = wsOptions;
      this._pk = _pk;
      this._pkurl = _pkurl;
      this.name = name;
      this.room = room;
      this.host = host;
      this.path = path;
      this.basePath = basePath;
    }
    reconnect(code, reason) {
      if (!this.host)
        throw new Error(
          "The host must be set before connecting, use `updateProperties` method to set it or pass it to the constructor."
        );
      if (!this.room && !this.basePath)
        throw new Error(
          "The room (or basePath) must be set before connecting, use `updateProperties` method to set it or pass it to the constructor."
        );
      super.reconnect(code, reason);
    }
    get id() {
      return this._pk;
    }
    /**
     * Exposes the static PartyKit room URL without applying query parameters.
     * To access the currently connected WebSocket url, use PartySocket#url.
     */
    get roomUrl() {
      return this._pkurl;
    }
    static async fetch(options, init) {
      const party = getPartyInfo(options, "http");
      const url = typeof party.urlProvider === "string" ? party.urlProvider : await party.urlProvider();
      return (options.fetch ?? fetch)(url, init);
    }
  };
  function getWSOptions(partySocketOptions) {
    const {
      id,
      host: _host,
      path: _path,
      party: _party,
      room: _room,
      protocol: _protocol,
      query: _query,
      protocols,
      ...socketOptions
    } = partySocketOptions;
    const _pk = id || generateUUID();
    const party = getPartyInfo(partySocketOptions, "ws", { _pk });
    return {
      _pk,
      _pkurl: party.partyUrl,
      name: party.name,
      room: party.room,
      host: party.host,
      path: party.path,
      basePath: partySocketOptions.basePath,
      protocols,
      socketOptions,
      urlProvider: party.urlProvider
    };
  }

  // client/partybus.ts
  var SESSION_STORAGE_CC_KEY = "pgg_assistant_controlcode_v1";
  var PartyBusImpl = class _PartyBusImpl {
    listeners = /* @__PURE__ */ new Map();
    statusListeners = [];
    socket = null;
    role = null;
    controlCode = null;
    // Default 'connecting' (not 'disconnected') so a freshly-loaded page shows
    // a neutral "warming up" indicator instead of a scary red disconnected
    // flash before init() runs. Stays 'connecting' until the WebSocket opens
    // (or fails). Phase 0 reg #3 — "斷線提示是異常狀態,初始載入不該觸發".
    status = "connecting";
    init(opts) {
      if (this._kicked) {
        console.warn("PartyBus.init ignored \u2014 this tab was kicked by another tab");
        return;
      }
      if (this.socket) {
        console.warn("PartyBus.init called more than once; ignoring");
        return;
      }
      this.role = opts.role;
      if (opts.role === "assistant") {
        try {
          const stored = sessionStorage.getItem(SESSION_STORAGE_CC_KEY);
          if (stored) this.controlCode = stored;
        } catch {
        }
      }
      const query = { role: opts.role };
      if (opts.name) query.name = opts.name;
      if (opts.team) query.team = opts.team;
      if (opts.deviceId) query.deviceId = opts.deviceId;
      if (opts.role === "assistant" && this.controlCode) {
        query.controlCode = this.controlCode;
      }
      this.socket = new PartySocket({
        host: opts.host ?? window.location.host,
        party: opts.party ?? "main",
        room: opts.roomId,
        query
      });
      this.setStatus("connecting");
      this.socket.addEventListener("open", () => this.setStatus("connected"));
      this.socket.addEventListener("close", () => this.setStatus("disconnected"));
      this.socket.addEventListener("error", () => this.setStatus("disconnected"));
      this.socket.addEventListener("message", (e) => {
        let env;
        try {
          env = JSON.parse(typeof e.data === "string" ? e.data : "");
        } catch {
          return;
        }
        if (!env || typeof env.type !== "string") return;
        this._lastMsgAt = Date.now();
        if (env.type === "__pong__") {
          this._pongCapable = true;
          return;
        }
        if (env.type === "__welcome__") {
          const wp = env.payload;
          if (wp?.controlCode && this.role === "assistant") {
            this.controlCode = wp.controlCode;
            try {
              sessionStorage.setItem(SESSION_STORAGE_CC_KEY, wp.controlCode);
            } catch {
            }
          }
        } else if (env.type === "__error__") {
          console.warn("PartyBus server error:", env.payload);
        } else if (env.type === "__kicked__") {
          this._kicked = true;
          try {
            this.socket?.close();
          } catch {
          }
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
    _lastMsgAt = 0;
    _pongCapable = false;
    _keepaliveTimer = null;
    static IDLE_PING_MS = 8e3;
    static STALE_RECONNECT_MS = 25e3;
    _startKeepalive() {
      this._lastMsgAt = Date.now();
      if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = setInterval(() => this._keepaliveTick(), 5e3);
      window.addEventListener("online", () => this._keepaliveTick());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this._keepaliveTick();
      });
    }
    _stopKeepalive() {
      if (this._keepaliveTimer) {
        clearInterval(this._keepaliveTimer);
        this._keepaliveTimer = null;
      }
    }
    _keepaliveTick() {
      if (this._kicked || !this.socket) return;
      const idle = Date.now() - this._lastMsgAt;
      if (this._pongCapable && idle > _PartyBusImpl.STALE_RECONNECT_MS) {
        console.warn(
          `PartyBus keepalive: ${Math.round(idle / 1e3)}s \u6C92\u6536\u5230\u4EFB\u4F55 server \u8A0A\u606F \u2014 \u5224\u5B9A\u9023\u7DDA\u534A\u6B7B,\u5F37\u5236\u91CD\u9023`
        );
        this._lastMsgAt = Date.now();
        this.setStatus("connecting");
        try {
          this.socket.reconnect();
        } catch {
        }
      } else if (idle > _PartyBusImpl.IDLE_PING_MS) {
        try {
          this.emit("ping", { from: this.role, keepalive: true });
        } catch {
        }
      }
    }
    /** True after server sent __kicked__; emit/init become no-ops. */
    _kicked = false;
    /**
     * 主動永久離線:關閉連線並停止自動重連(改名逾時被請出房間時用)。
     * 不這樣做的話 partysocket 會自動重連 —— 人雖然已被移出名單,socket
     * 仍掛著,助理端點名會多算一個。之後 emit/init 都變成 no-op。
     */
    disconnect() {
      this._kicked = true;
      try {
        this.socket?.close();
      } catch {
      }
      this.socket = null;
      this._stopKeepalive();
      this.setStatus("disconnected");
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
    static MUST_DELIVER = /* @__PURE__ */ new Set([
      "game_start",
      "game_restart",
      "score_adjust",
      "start_rush",
      "rebuzz_same",
      "fresh_rush",
      "enter_category",
      "category_preview",
      "category_confirm",
      "category_reset",
      "reveal_answer",
      "next_question",
      "skip_question",
      "redraw_question",
      "arm_purgatory",
      "mode_preview",
      "custom_tiers_changed",
      "rush_mode_changed",
      "presenter_show_qr",
      "export_result",
      "team_count_changed",
      "grouping_mode_changed",
      "notify_group",
      "set_timer",
      "resume_question",
      "reassign_leader",
      "team_rename",
      "player_join",
      "rename_self",
      "assign_assistant_role",
      "rename_assistant",
      "set_own_name",
      "remove_assistant",
      "toggle_group_pin"
    ]);
    /** 指令送不出去時通知外層(助理端用來跳警告)。 */
    undeliveredListeners = [];
    onUndelivered(cb) {
      this.undeliveredListeners.push(cb);
    }
    reportUndelivered(type) {
      for (const cb of this.undeliveredListeners) {
        try {
          cb(type);
        } catch (err) {
          console.error("PartyBus undelivered listener error:", err);
        }
      }
    }
    /**
     * 送指令。回傳 true = 已交給 socket 送出;false = 沒送出去。
     * 呼叫端**不應該**在拿到 false 之後還把本機 UI 當成操作成功。
     */
    emit(type, payload) {
      const socket = this.socket;
      const usable = !!socket && socket.readyState === 1;
      if (!usable) {
        if (_PartyBusImpl.MUST_DELIVER.has(type)) {
          console.warn(`PartyBus.emit('${type}') \u6C92\u6709\u9001\u51FA \u2014 \u9023\u7DDA\u4E0D\u53EF\u7528(readyState=${socket ? socket.readyState : "no socket"})`);
          this.reportUndelivered(type);
        }
        return false;
      }
      const env = { type, payload };
      if (this.role === "assistant" && this.controlCode) {
        env.controlCode = this.controlCode;
      }
      try {
        socket.send(JSON.stringify(env));
        return true;
      } catch (err) {
        console.warn(`PartyBus.emit('${type}') send \u5931\u6557:`, err);
        if (_PartyBusImpl.MUST_DELIVER.has(type)) this.reportUndelivered(type);
        return false;
      }
    }
    on(type, cb) {
      let arr = this.listeners.get(type);
      if (!arr) {
        arr = [];
        this.listeners.set(type, arr);
      }
      arr.push(cb);
    }
    onStatus(cb) {
      this.statusListeners.push(cb);
      try {
        cb(this.status);
      } catch (err) {
        console.error("PartyBus status listener error:", err);
      }
    }
    getStatus() {
      return this.status;
    }
    getControlCode() {
      return this.controlCode;
    }
    /** Test/debug helper — drop the saved controlCode so the next init()
     * acts as a fresh assistant connection. Not used by app code. */
    forgetControlCode() {
      this.controlCode = null;
      try {
        sessionStorage.removeItem(SESSION_STORAGE_CC_KEY);
      } catch {
      }
    }
    // ─────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────
    _dispatch(type, payload) {
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
    setStatus(s) {
      if (this.status === s) return;
      this.status = s;
      for (const cb of this.statusListeners) {
        try {
          cb(s);
        } catch (err) {
          console.error("PartyBus status listener error:", err);
        }
      }
    }
  };
  var PartyBus = new PartyBusImpl();
  window.PartyBus = PartyBus;

  // client/bankloader.ts
  var ALL_DIFFICULTIES = ["easy", "medium", "hard", "hell", "purgatory"];
  var ID_PREFIX_TO_DIFF = {
    E: "easy",
    M: "medium",
    H: "hard",
    X: "hell",
    P: "purgatory"
  };
  var SYSTEM_A_TYPES = ["short_answer", "multiple_choice", "essay", "calculation", "word_game"];
  function normalize(diff, parsed, filename) {
    if (diff === "purgatory") {
      const root2 = parsed;
      const arr = Array.isArray(root2.questions) ? root2.questions : [];
      const byType2 = {};
      for (const q of arr) {
        const t = q.type ?? "unknown";
        byType2[t] = (byType2[t] ?? 0) + 1;
      }
      return {
        questions: arr,
        count: arr.length,
        byType: byType2,
        uploadedAt: (/* @__PURE__ */ new Date()).toISOString(),
        filename
      };
    }
    const root = parsed;
    let bank = null;
    const byDiff = root.questions?.[diff];
    if (byDiff && typeof byDiff === "object") bank = byDiff;
    else if (root[diff] && typeof root[diff] === "object") bank = root[diff];
    else if (root.questions && typeof root.questions === "object" && !Array.isArray(root.questions)) {
      bank = root.questions;
    }
    if (!bank) {
      throw new Error(`expected nested questions.${diff}.<type> structure`);
    }
    const flat = [];
    const byType = {};
    for (const t of SYSTEM_A_TYPES) {
      const arr = bank[t];
      if (!Array.isArray(arr)) continue;
      for (const raw of arr) {
        flat.push({ ...raw, type: t });
      }
      byType[t] = arr.length;
    }
    if (flat.length === 0) {
      throw new Error(`no questions found in nested structure for ${diff}`);
    }
    return {
      questions: flat,
      count: flat.length,
      byType,
      uploadedAt: (/* @__PURE__ */ new Date()).toISOString(),
      filename
    };
  }
  async function loadOne(diff, baseUrl) {
    const filename = `insurance-quiz-bank-${diff}.json`;
    const url = `${baseUrl}${filename}`;
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    let parsed;
    try {
      parsed = await res.json();
    } catch (e) {
      throw new Error(`JSON parse failed for ${filename}: ${e.message}`);
    }
    return normalize(diff, parsed, filename);
  }
  async function autoLoad(opts = {}) {
    const baseUrl = opts.baseUrl ?? "data/";
    const banks = {};
    const errors = [];
    let loaded = 0;
    await Promise.all(
      ALL_DIFFICULTIES.map(async (diff) => {
        try {
          const bank = await loadOne(diff, baseUrl);
          banks[diff] = bank;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push({ difficulty: diff, message: msg });
          opts.onError?.(diff, msg);
        } finally {
          loaded += 1;
          opts.onProgress?.(loaded, ALL_DIFFICULTIES.length, diff);
        }
      })
    );
    return {
      ok: errors.length === 0,
      banks,
      errors
    };
  }
  function difficultyForId(id) {
    const prefix = id?.[0]?.toUpperCase?.();
    return prefix ? ID_PREFIX_TO_DIFF[prefix] ?? null : null;
  }
  var PGGBankLoader = {
    autoLoad,
    difficultyForId
  };
  window.PGGBankLoader = PGGBankLoader;
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3BhcnR5c29ja2V0L3NyYy93cy50cyIsICIuLi8uLi8uLi8uLi8uLi9ub2RlX21vZHVsZXMvcGFydHlzb2NrZXQvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2NsaWVudC9wYXJ0eWJ1cy50cyIsICIuLi8uLi9jbGllbnQvYmFua2xvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gVE9ETzogbG9zZSB0aGlzIGVzbGludC1kaXNhYmxlXG5cbi8qIVxuICogUmVjb25uZWN0aW5nIFdlYlNvY2tldFxuICogYnkgUGVkcm8gTGFkYXJpYSA8cGVkcm8ubGFkYXJpYUBnbWFpbC5jb20+XG4gKiBodHRwczovL2dpdGh1Yi5jb20vcGxhZGFyaWEvcmVjb25uZWN0aW5nLXdlYnNvY2tldFxuICogTGljZW5zZSBNSVRcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFR5cGVkRXZlbnRUYXJnZXQgfSBmcm9tIFwiLi90eXBlLWhlbHBlclwiO1xuXG5pZiAoIWdsb2JhbFRoaXMuRXZlbnRUYXJnZXQgfHwgIWdsb2JhbFRoaXMuRXZlbnQpIHtcbiAgY29uc29sZS5lcnJvcihgXG4gIFBhcnR5U29ja2V0IHJlcXVpcmVzIGEgZ2xvYmFsICdFdmVudFRhcmdldCcgY2xhc3MgdG8gYmUgYXZhaWxhYmxlIVxuICBZb3UgY2FuIHBvbHlmaWxsIHRoaXMgZ2xvYmFsIGJ5IGFkZGluZyB0aGlzIHRvIHlvdXIgY29kZSBiZWZvcmUgYW55IHBhcnR5c29ja2V0IGltcG9ydHM6IFxuICBcbiAgXFxgXFxgXFxgXG4gIGltcG9ydCAncGFydHlzb2NrZXQvZXZlbnQtdGFyZ2V0LXBvbHlmaWxsJztcbiAgXFxgXFxgXFxgXG4gIFBsZWFzZSBmaWxlIGFuIGlzc3VlIGF0IGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJ0eWtpdC9wYXJ0eWtpdCBpZiB5b3UncmUgc3RpbGwgaGF2aW5nIHRyb3VibGUuXG5gKTtcbn1cblxuZXhwb3J0IGNsYXNzIEVycm9yRXZlbnQgZXh0ZW5kcyBFdmVudCB7XG4gIHB1YmxpYyBtZXNzYWdlOiBzdHJpbmc7XG4gIHB1YmxpYyBlcnJvcjogRXJyb3I7XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgY29uc3RydWN0b3IoZXJyb3I6IEVycm9yLCB0YXJnZXQ6IGFueSkge1xuICAgIHN1cGVyKFwiZXJyb3JcIiwgdGFyZ2V0KTtcbiAgICB0aGlzLm1lc3NhZ2UgPSBlcnJvci5tZXNzYWdlO1xuICAgIHRoaXMuZXJyb3IgPSBlcnJvcjtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgQ2xvc2VFdmVudCBleHRlbmRzIEV2ZW50IHtcbiAgcHVibGljIGNvZGU6IG51bWJlcjtcbiAgcHVibGljIHJlYXNvbjogc3RyaW5nO1xuICBwdWJsaWMgd2FzQ2xlYW4gPSB0cnVlO1xuICAvLyBveGxpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tZXhwbGljaXQtYW55XG4gIGNvbnN0cnVjdG9yKGNvZGUgPSAxMDAwLCByZWFzb24gPSBcIlwiLCB0YXJnZXQ6IGFueSkge1xuICAgIHN1cGVyKFwiY2xvc2VcIiwgdGFyZ2V0KTtcbiAgICB0aGlzLmNvZGUgPSBjb2RlO1xuICAgIHRoaXMucmVhc29uID0gcmVhc29uO1xuICB9XG59XG5leHBvcnQgaW50ZXJmYWNlIFdlYlNvY2tldEV2ZW50TWFwIHtcbiAgY2xvc2U6IENsb3NlRXZlbnQ7XG4gIGVycm9yOiBFcnJvckV2ZW50O1xuICBtZXNzYWdlOiBNZXNzYWdlRXZlbnQ7XG4gIG9wZW46IEV2ZW50O1xufVxuXG5jb25zdCBFdmVudHMgPSB7XG4gIEV2ZW50LFxuICBFcnJvckV2ZW50LFxuICBDbG9zZUV2ZW50XG59O1xuXG5mdW5jdGlvbiBhc3NlcnQoY29uZGl0aW9uOiB1bmtub3duLCBtc2c/OiBzdHJpbmcpOiBhc3NlcnRzIGNvbmRpdGlvbiB7XG4gIGlmICghY29uZGl0aW9uKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xvbmVFdmVudEJyb3dzZXIoZTogRXZlbnQpIHtcbiAgLy8gb3hsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWV4cGxpY2l0LWFueVxuICByZXR1cm4gbmV3IChlIGFzIGFueSkuY29uc3RydWN0b3IoZS50eXBlLCBlKSBhcyBFdmVudDtcbn1cblxuZnVuY3Rpb24gY2xvbmVFdmVudE5vZGUoZTogRXZlbnQpIHtcbiAgaWYgKFwiZGF0YVwiIGluIGUpIHtcbiAgICBjb25zdCBldnQgPSBuZXcgTWVzc2FnZUV2ZW50KGUudHlwZSwgZSk7XG4gICAgcmV0dXJuIGV2dDtcbiAgfVxuXG4gIGlmIChcImNvZGVcIiBpbiBlIHx8IFwicmVhc29uXCIgaW4gZSkge1xuICAgIGNvbnN0IGV2dCA9IG5ldyBDbG9zZUV2ZW50KFxuICAgICAgLy8gQHRzLWV4cGVjdC1lcnJvciB3ZSBuZWVkIHRvIGZpeCBldmVudC9saXN0ZW5lciB0eXBlc1xuICAgICAgKGUuY29kZSB8fCAxOTk5KSBhcyBudW1iZXIsXG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIHdlIG5lZWQgdG8gZml4IGV2ZW50L2xpc3RlbmVyIHR5cGVzXG4gICAgICAoZS5yZWFzb24gfHwgXCJ1bmtub3duIHJlYXNvblwiKSBhcyBzdHJpbmcsXG4gICAgICBlXG4gICAgKTtcbiAgICByZXR1cm4gZXZ0O1xuICB9XG5cbiAgaWYgKFwiZXJyb3JcIiBpbiBlKSB7XG4gICAgY29uc3QgZXZ0ID0gbmV3IEVycm9yRXZlbnQoZS5lcnJvciBhcyBFcnJvciwgZSk7XG4gICAgcmV0dXJuIGV2dDtcbiAgfVxuXG4gIGNvbnN0IGV2dCA9IG5ldyBFdmVudChlLnR5cGUsIGUpO1xuICByZXR1cm4gZXZ0O1xufVxuXG5jb25zdCBpc05vZGUgPVxuICB0eXBlb2YgcHJvY2VzcyAhPT0gXCJ1bmRlZmluZWRcIiAmJlxuICB0eXBlb2YgcHJvY2Vzcy52ZXJzaW9ucz8ubm9kZSAhPT0gXCJ1bmRlZmluZWRcIjtcblxuLy8gUmVhY3QgTmF0aXZlIGhhcyBwcm9jZXNzIGFuZCBkb2N1bWVudCBwb2x5ZmlsbGVkIGJ1dCBub3QgcHJvY2Vzcy52ZXJzaW9ucy5ub2RlXG4vLyBJdCBuZWVkcyBOb2RlLXN0eWxlIGV2ZW50IGNsb25pbmcgYmVjYXVzZSBicm93c2VyLXN0eWxlIGNsb25pbmcgcHJvZHVjZXNcbi8vIGV2ZW50cyB0aGF0IGZhaWwgaW5zdGFuY2VvZiBFdmVudCBjaGVja3MgaW4gZXZlbnQtdGFyZ2V0LXBvbHlmaWxsXG4vLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9jbG91ZGZsYXJlL3BhcnR5a2l0L2lzc3Vlcy8yNTdcbmNvbnN0IGlzUmVhY3ROYXRpdmUgPVxuICB0eXBlb2YgbmF2aWdhdG9yICE9PSBcInVuZGVmaW5lZFwiICYmIG5hdmlnYXRvci5wcm9kdWN0ID09PSBcIlJlYWN0TmF0aXZlXCI7XG5cbmNvbnN0IGNsb25lRXZlbnQgPSBpc05vZGUgfHwgaXNSZWFjdE5hdGl2ZSA/IGNsb25lRXZlbnROb2RlIDogY2xvbmVFdmVudEJyb3dzZXI7XG5cbmV4cG9ydCB0eXBlIE9wdGlvbnMgPSB7XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgV2ViU29ja2V0PzogYW55O1xuICBtYXhSZWNvbm5lY3Rpb25EZWxheT86IG51bWJlcjtcbiAgbWluUmVjb25uZWN0aW9uRGVsYXk/OiBudW1iZXI7XG4gIHJlY29ubmVjdGlvbkRlbGF5R3Jvd0ZhY3Rvcj86IG51bWJlcjtcbiAgbWluVXB0aW1lPzogbnVtYmVyO1xuICBjb25uZWN0aW9uVGltZW91dD86IG51bWJlcjtcbiAgbWF4UmV0cmllcz86IG51bWJlcjtcbiAgbWF4RW5xdWV1ZWRNZXNzYWdlcz86IG51bWJlcjtcbiAgc3RhcnRDbG9zZWQ/OiBib29sZWFuO1xuICBkZWJ1Zz86IGJvb2xlYW47XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgZGVidWdMb2dnZXI/OiAoLi4uYXJnczogYW55W10pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUID0ge1xuICBtYXhSZWNvbm5lY3Rpb25EZWxheTogMTAwMDAsXG4gIG1pblJlY29ubmVjdGlvbkRlbGF5OiAxMDAwICsgTWF0aC5yYW5kb20oKSAqIDQwMDAsXG4gIG1pblVwdGltZTogNTAwMCxcbiAgcmVjb25uZWN0aW9uRGVsYXlHcm93RmFjdG9yOiAxLjMsXG4gIGNvbm5lY3Rpb25UaW1lb3V0OiA0MDAwLFxuICBtYXhSZXRyaWVzOiBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksXG4gIG1heEVucXVldWVkTWVzc2FnZXM6IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSxcbiAgc3RhcnRDbG9zZWQ6IGZhbHNlLFxuICBkZWJ1ZzogZmFsc2Vcbn07XG5cbmxldCBkaWRXYXJuQWJvdXRNaXNzaW5nV2ViU29ja2V0ID0gZmFsc2U7XG5cbmV4cG9ydCB0eXBlIFVybFByb3ZpZGVyID0gc3RyaW5nIHwgKCgpID0+IHN0cmluZykgfCAoKCkgPT4gUHJvbWlzZTxzdHJpbmc+KTtcbmV4cG9ydCB0eXBlIFByb3RvY29sc1Byb3ZpZGVyID1cbiAgfCBudWxsXG4gIHwgc3RyaW5nXG4gIHwgc3RyaW5nW11cbiAgfCAoKCkgPT4gc3RyaW5nIHwgc3RyaW5nW10gfCBudWxsKVxuICB8ICgoKSA9PiBQcm9taXNlPHN0cmluZyB8IHN0cmluZ1tdIHwgbnVsbD4pO1xuXG5leHBvcnQgdHlwZSBNZXNzYWdlID1cbiAgfCBzdHJpbmdcbiAgfCBBcnJheUJ1ZmZlclxuICB8IEJsb2JcbiAgfCBBcnJheUJ1ZmZlclZpZXc8QXJyYXlCdWZmZXI+O1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBSZWNvbm5lY3RpbmdXZWJTb2NrZXQgZXh0ZW5kcyAoRXZlbnRUYXJnZXQgYXMgVHlwZWRFdmVudFRhcmdldDxXZWJTb2NrZXRFdmVudE1hcD4pIHtcbiAgcHJpdmF0ZSBfd3M6IFdlYlNvY2tldCB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfcmV0cnlDb3VudCA9IC0xO1xuICBwcml2YXRlIF91cHRpbWVUaW1lb3V0OiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfY29ubmVjdFRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIF9zaG91bGRSZWNvbm5lY3QgPSB0cnVlO1xuICBwcml2YXRlIF9jb25uZWN0TG9jayA9IGZhbHNlO1xuICBwcml2YXRlIF9iaW5hcnlUeXBlOiBCaW5hcnlUeXBlID0gXCJibG9iXCI7XG4gIHByaXZhdGUgX2Nsb3NlQ2FsbGVkID0gZmFsc2U7XG4gIHByaXZhdGUgX21lc3NhZ2VRdWV1ZTogTWVzc2FnZVtdID0gW107XG5cbiAgcHJpdmF0ZSBfZGVidWdMb2dnZXIgPSBjb25zb2xlLmxvZy5iaW5kKGNvbnNvbGUpO1xuXG4gIHByb3RlY3RlZCBfdXJsOiBVcmxQcm92aWRlcjtcbiAgcHJvdGVjdGVkIF9wcm90b2NvbHM/OiBQcm90b2NvbHNQcm92aWRlcjtcbiAgcHJvdGVjdGVkIF9vcHRpb25zOiBPcHRpb25zO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHVybDogVXJsUHJvdmlkZXIsXG4gICAgcHJvdG9jb2xzPzogUHJvdG9jb2xzUHJvdmlkZXIsXG4gICAgb3B0aW9uczogT3B0aW9ucyA9IHt9XG4gICkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5fdXJsID0gdXJsO1xuICAgIHRoaXMuX3Byb3RvY29scyA9IHByb3RvY29scztcbiAgICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgICBpZiAodGhpcy5fb3B0aW9ucy5zdGFydENsb3NlZCkge1xuICAgICAgdGhpcy5fc2hvdWxkUmVjb25uZWN0ID0gZmFsc2U7XG4gICAgfVxuICAgIGlmICh0aGlzLl9vcHRpb25zLmRlYnVnTG9nZ2VyKSB7XG4gICAgICB0aGlzLl9kZWJ1Z0xvZ2dlciA9IHRoaXMuX29wdGlvbnMuZGVidWdMb2dnZXI7XG4gICAgfVxuICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgfVxuXG4gIHN0YXRpYyBnZXQgQ09OTkVDVElORygpIHtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBzdGF0aWMgZ2V0IE9QRU4oKSB7XG4gICAgcmV0dXJuIDE7XG4gIH1cbiAgc3RhdGljIGdldCBDTE9TSU5HKCkge1xuICAgIHJldHVybiAyO1xuICB9XG4gIHN0YXRpYyBnZXQgQ0xPU0VEKCkge1xuICAgIHJldHVybiAzO1xuICB9XG5cbiAgZ2V0IENPTk5FQ1RJTkcoKSB7XG4gICAgcmV0dXJuIFJlY29ubmVjdGluZ1dlYlNvY2tldC5DT05ORUNUSU5HO1xuICB9XG4gIGdldCBPUEVOKCkge1xuICAgIHJldHVybiBSZWNvbm5lY3RpbmdXZWJTb2NrZXQuT1BFTjtcbiAgfVxuICBnZXQgQ0xPU0lORygpIHtcbiAgICByZXR1cm4gUmVjb25uZWN0aW5nV2ViU29ja2V0LkNMT1NJTkc7XG4gIH1cbiAgZ2V0IENMT1NFRCgpIHtcbiAgICByZXR1cm4gUmVjb25uZWN0aW5nV2ViU29ja2V0LkNMT1NFRDtcbiAgfVxuXG4gIGdldCBiaW5hcnlUeXBlKCkge1xuICAgIHJldHVybiB0aGlzLl93cyA/IHRoaXMuX3dzLmJpbmFyeVR5cGUgOiB0aGlzLl9iaW5hcnlUeXBlO1xuICB9XG5cbiAgc2V0IGJpbmFyeVR5cGUodmFsdWU6IEJpbmFyeVR5cGUpIHtcbiAgICB0aGlzLl9iaW5hcnlUeXBlID0gdmFsdWU7XG4gICAgaWYgKHRoaXMuX3dzKSB7XG4gICAgICB0aGlzLl93cy5iaW5hcnlUeXBlID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIG51bWJlciBvciBjb25uZWN0aW9uIHJldHJpZXNcbiAgICovXG4gIGdldCByZXRyeUNvdW50KCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KHRoaXMuX3JldHJ5Q291bnQsIDApO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBudW1iZXIgb2YgYnl0ZXMgb2YgZGF0YSB0aGF0IGhhdmUgYmVlbiBxdWV1ZWQgdXNpbmcgY2FsbHMgdG8gc2VuZCgpIGJ1dCBub3QgeWV0XG4gICAqIHRyYW5zbWl0dGVkIHRvIHRoZSBuZXR3b3JrLiBUaGlzIHZhbHVlIHJlc2V0cyB0byB6ZXJvIG9uY2UgYWxsIHF1ZXVlZCBkYXRhIGhhcyBiZWVuIHNlbnQuXG4gICAqIFRoaXMgdmFsdWUgZG9lcyBub3QgcmVzZXQgdG8gemVybyB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGNsb3NlZDsgaWYgeW91IGtlZXAgY2FsbGluZyBzZW5kKCksXG4gICAqIHRoaXMgd2lsbCBjb250aW51ZSB0byBjbGltYi4gUmVhZCBvbmx5XG4gICAqL1xuICBnZXQgYnVmZmVyZWRBbW91bnQoKTogbnVtYmVyIHtcbiAgICBjb25zdCBieXRlcyA9IHRoaXMuX21lc3NhZ2VRdWV1ZS5yZWR1Y2UoKGFjYywgbWVzc2FnZSkgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGFjYyArPSBtZXNzYWdlLmxlbmd0aDsgLy8gbm90IGJ5dGUgc2l6ZVxuICAgICAgfSBlbHNlIGlmIChtZXNzYWdlIGluc3RhbmNlb2YgQmxvYikge1xuICAgICAgICBhY2MgKz0gbWVzc2FnZS5zaXplO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYWNjICs9IG1lc3NhZ2UuYnl0ZUxlbmd0aDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBhY2M7XG4gICAgfSwgMCk7XG4gICAgcmV0dXJuIGJ5dGVzICsgKHRoaXMuX3dzID8gdGhpcy5fd3MuYnVmZmVyZWRBbW91bnQgOiAwKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZXh0ZW5zaW9ucyBzZWxlY3RlZCBieSB0aGUgc2VydmVyLiBUaGlzIGlzIGN1cnJlbnRseSBvbmx5IHRoZSBlbXB0eSBzdHJpbmcgb3IgYSBsaXN0IG9mXG4gICAqIGV4dGVuc2lvbnMgYXMgbmVnb3RpYXRlZCBieSB0aGUgY29ubmVjdGlvblxuICAgKi9cbiAgZ2V0IGV4dGVuc2lvbnMoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5fd3MgPyB0aGlzLl93cy5leHRlbnNpb25zIDogXCJcIjtcbiAgfVxuXG4gIC8qKlxuICAgKiBBIHN0cmluZyBpbmRpY2F0aW5nIHRoZSBuYW1lIG9mIHRoZSBzdWItcHJvdG9jb2wgdGhlIHNlcnZlciBzZWxlY3RlZDtcbiAgICogdGhpcyB3aWxsIGJlIG9uZSBvZiB0aGUgc3RyaW5ncyBzcGVjaWZpZWQgaW4gdGhlIHByb3RvY29scyBwYXJhbWV0ZXIgd2hlbiBjcmVhdGluZyB0aGVcbiAgICogV2ViU29ja2V0IG9iamVjdFxuICAgKi9cbiAgZ2V0IHByb3RvY29sKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuX3dzID8gdGhpcy5fd3MucHJvdG9jb2wgOiBcIlwiO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBjdXJyZW50IHN0YXRlIG9mIHRoZSBjb25uZWN0aW9uOyB0aGlzIGlzIG9uZSBvZiB0aGUgUmVhZHkgc3RhdGUgY29uc3RhbnRzXG4gICAqL1xuICBnZXQgcmVhZHlTdGF0ZSgpOiBudW1iZXIge1xuICAgIGlmICh0aGlzLl93cykge1xuICAgICAgcmV0dXJuIHRoaXMuX3dzLnJlYWR5U3RhdGU7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9vcHRpb25zLnN0YXJ0Q2xvc2VkXG4gICAgICA/IFJlY29ubmVjdGluZ1dlYlNvY2tldC5DTE9TRURcbiAgICAgIDogUmVjb25uZWN0aW5nV2ViU29ja2V0LkNPTk5FQ1RJTkc7XG4gIH1cblxuICAvKipcbiAgICogVGhlIFVSTCBhcyByZXNvbHZlZCBieSB0aGUgY29uc3RydWN0b3JcbiAgICovXG4gIGdldCB1cmwoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5fd3MgPyB0aGlzLl93cy51cmwgOiBcIlwiO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHdlYnNvY2tldCBvYmplY3QgaXMgbm93IGluIHJlY29ubmVjdGFibGUgc3RhdGVcbiAgICovXG4gIGdldCBzaG91bGRSZWNvbm5lY3QoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3Nob3VsZFJlY29ubmVjdDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBbiBldmVudCBsaXN0ZW5lciB0byBiZSBjYWxsZWQgd2hlbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb24ncyByZWFkeVN0YXRlIGNoYW5nZXMgdG8gQ0xPU0VEXG4gICAqL1xuICBwdWJsaWMgb25jbG9zZTogKChldmVudDogQ2xvc2VFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICAvKipcbiAgICogQW4gZXZlbnQgbGlzdGVuZXIgdG8gYmUgY2FsbGVkIHdoZW4gYW4gZXJyb3Igb2NjdXJzXG4gICAqL1xuICBwdWJsaWMgb25lcnJvcjogKChldmVudDogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICAvKipcbiAgICogQW4gZXZlbnQgbGlzdGVuZXIgdG8gYmUgY2FsbGVkIHdoZW4gYSBtZXNzYWdlIGlzIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgcHVibGljIG9ubWVzc2FnZTogKChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBBbiBldmVudCBsaXN0ZW5lciB0byBiZSBjYWxsZWQgd2hlbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb24ncyByZWFkeVN0YXRlIGNoYW5nZXMgdG8gT1BFTjtcbiAgICogdGhpcyBpbmRpY2F0ZXMgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyByZWFkeSB0byBzZW5kIGFuZCByZWNlaXZlIGRhdGFcbiAgICovXG4gIHB1YmxpYyBvbm9wZW46ICgoZXZlbnQ6IEV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBDbG9zZXMgdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uIG9yIGNvbm5lY3Rpb24gYXR0ZW1wdCwgaWYgYW55LiBJZiB0aGUgY29ubmVjdGlvbiBpcyBhbHJlYWR5XG4gICAqIENMT1NFRCwgdGhpcyBtZXRob2QgZG9lcyBub3RoaW5nXG4gICAqL1xuICBwdWJsaWMgY2xvc2UoY29kZSA9IDEwMDAsIHJlYXNvbj86IHN0cmluZykge1xuICAgIHRoaXMuX2Nsb3NlQ2FsbGVkID0gdHJ1ZTtcbiAgICB0aGlzLl9zaG91bGRSZWNvbm5lY3QgPSBmYWxzZTtcbiAgICB0aGlzLl9jbGVhclRpbWVvdXRzKCk7XG4gICAgaWYgKCF0aGlzLl93cykge1xuICAgICAgdGhpcy5fZGVidWcoXCJjbG9zZSBlbnF1ZXVlZDogbm8gd3MgaW5zdGFuY2VcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLl93cy5yZWFkeVN0YXRlID09PSB0aGlzLkNMT1NFRCkge1xuICAgICAgdGhpcy5fZGVidWcoXCJjbG9zZTogYWxyZWFkeSBjbG9zZWRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3dzLmNsb3NlKGNvZGUsIHJlYXNvbik7XG4gIH1cblxuICAvKipcbiAgICogQ2xvc2VzIHRoZSBXZWJTb2NrZXQgY29ubmVjdGlvbiBvciBjb25uZWN0aW9uIGF0dGVtcHQgYW5kIGNvbm5lY3RzIGFnYWluLlxuICAgKiBSZXNldHMgcmV0cnkgY291bnRlcjtcbiAgICovXG4gIHB1YmxpYyByZWNvbm5lY3QoY29kZT86IG51bWJlciwgcmVhc29uPzogc3RyaW5nKSB7XG4gICAgdGhpcy5fc2hvdWxkUmVjb25uZWN0ID0gdHJ1ZTtcbiAgICB0aGlzLl9jbG9zZUNhbGxlZCA9IGZhbHNlO1xuICAgIHRoaXMuX3JldHJ5Q291bnQgPSAtMTtcbiAgICBpZiAoIXRoaXMuX3dzIHx8IHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuQ0xPU0VEKSB7XG4gICAgICB0aGlzLl9jb25uZWN0KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rpc2Nvbm5lY3QoY29kZSwgcmVhc29uKTtcbiAgICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRW5xdWV1ZSBzcGVjaWZpZWQgZGF0YSB0byBiZSB0cmFuc21pdHRlZCB0byB0aGUgc2VydmVyIG92ZXIgdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uXG4gICAqL1xuICBwdWJsaWMgc2VuZChkYXRhOiBNZXNzYWdlKSB7XG4gICAgaWYgKHRoaXMuX3dzICYmIHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuT1BFTikge1xuICAgICAgdGhpcy5fZGVidWcoXCJzZW5kXCIsIGRhdGEpO1xuICAgICAgdGhpcy5fd3Muc2VuZChkYXRhKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgeyBtYXhFbnF1ZXVlZE1lc3NhZ2VzID0gREVGQVVMVC5tYXhFbnF1ZXVlZE1lc3NhZ2VzIH0gPVxuICAgICAgICB0aGlzLl9vcHRpb25zO1xuICAgICAgaWYgKHRoaXMuX21lc3NhZ2VRdWV1ZS5sZW5ndGggPCBtYXhFbnF1ZXVlZE1lc3NhZ2VzKSB7XG4gICAgICAgIHRoaXMuX2RlYnVnKFwiZW5xdWV1ZVwiLCBkYXRhKTtcbiAgICAgICAgdGhpcy5fbWVzc2FnZVF1ZXVlLnB1c2goZGF0YSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfZGVidWcoLi4uYXJnczogdW5rbm93bltdKSB7XG4gICAgaWYgKHRoaXMuX29wdGlvbnMuZGVidWcpIHtcbiAgICAgIHRoaXMuX2RlYnVnTG9nZ2VyKFwiUldTPlwiLCAuLi5hcmdzKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9nZXROZXh0RGVsYXkoKSB7XG4gICAgY29uc3Qge1xuICAgICAgcmVjb25uZWN0aW9uRGVsYXlHcm93RmFjdG9yID0gREVGQVVMVC5yZWNvbm5lY3Rpb25EZWxheUdyb3dGYWN0b3IsXG4gICAgICBtaW5SZWNvbm5lY3Rpb25EZWxheSA9IERFRkFVTFQubWluUmVjb25uZWN0aW9uRGVsYXksXG4gICAgICBtYXhSZWNvbm5lY3Rpb25EZWxheSA9IERFRkFVTFQubWF4UmVjb25uZWN0aW9uRGVsYXlcbiAgICB9ID0gdGhpcy5fb3B0aW9ucztcbiAgICBsZXQgZGVsYXkgPSAwO1xuICAgIGlmICh0aGlzLl9yZXRyeUNvdW50ID4gMCkge1xuICAgICAgZGVsYXkgPVxuICAgICAgICBtaW5SZWNvbm5lY3Rpb25EZWxheSAqXG4gICAgICAgIHJlY29ubmVjdGlvbkRlbGF5R3Jvd0ZhY3RvciAqKiAodGhpcy5fcmV0cnlDb3VudCAtIDEpO1xuICAgICAgaWYgKGRlbGF5ID4gbWF4UmVjb25uZWN0aW9uRGVsYXkpIHtcbiAgICAgICAgZGVsYXkgPSBtYXhSZWNvbm5lY3Rpb25EZWxheTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5fZGVidWcoXCJuZXh0IGRlbGF5XCIsIGRlbGF5KTtcbiAgICByZXR1cm4gZGVsYXk7XG4gIH1cblxuICBwcml2YXRlIF93YWl0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgc2V0VGltZW91dChyZXNvbHZlLCB0aGlzLl9nZXROZXh0RGVsYXkoKSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIF9nZXROZXh0UHJvdG9jb2xzKFxuICAgIHByb3RvY29sc1Byb3ZpZGVyOiBQcm90b2NvbHNQcm92aWRlciB8IG51bGxcbiAgKTogUHJvbWlzZTxzdHJpbmcgfCBzdHJpbmdbXSB8IG51bGw+IHtcbiAgICBpZiAoIXByb3RvY29sc1Byb3ZpZGVyKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xuXG4gICAgaWYgKFxuICAgICAgdHlwZW9mIHByb3RvY29sc1Byb3ZpZGVyID09PSBcInN0cmluZ1wiIHx8XG4gICAgICBBcnJheS5pc0FycmF5KHByb3RvY29sc1Byb3ZpZGVyKVxuICAgICkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShwcm90b2NvbHNQcm92aWRlcik7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBwcm90b2NvbHNQcm92aWRlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBjb25zdCBwcm90b2NvbHMgPSBwcm90b2NvbHNQcm92aWRlcigpO1xuICAgICAgaWYgKCFwcm90b2NvbHMpIHJldHVybiBQcm9taXNlLnJlc29sdmUobnVsbCk7XG5cbiAgICAgIGlmICh0eXBlb2YgcHJvdG9jb2xzID09PSBcInN0cmluZ1wiIHx8IEFycmF5LmlzQXJyYXkocHJvdG9jb2xzKSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHByb3RvY29scyk7XG4gICAgICB9XG5cbiAgICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgcmVkdW5kYW50IGNoZWNrXG4gICAgICBpZiAocHJvdG9jb2xzLnRoZW4pIHtcbiAgICAgICAgcmV0dXJuIHByb3RvY29scztcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aHJvdyBFcnJvcihcIkludmFsaWQgcHJvdG9jb2xzXCIpO1xuICB9XG5cbiAgcHJpdmF0ZSBfZ2V0TmV4dFVybCh1cmxQcm92aWRlcjogVXJsUHJvdmlkZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGlmICh0eXBlb2YgdXJsUHJvdmlkZXIgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodXJsUHJvdmlkZXIpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHVybFByb3ZpZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGNvbnN0IHVybCA9IHVybFByb3ZpZGVyKCk7XG4gICAgICBpZiAodHlwZW9mIHVybCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHVybCk7XG4gICAgICB9XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yXG4gICAgICBpZiAodXJsLnRoZW4pIHtcbiAgICAgICAgcmV0dXJuIHVybDtcbiAgICAgIH1cblxuICAgICAgLy8gcmV0dXJuIHVybDtcbiAgICB9XG4gICAgdGhyb3cgRXJyb3IoXCJJbnZhbGlkIFVSTFwiKTtcbiAgfVxuXG4gIHByaXZhdGUgX2Nvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuX2Nvbm5lY3RMb2NrIHx8ICF0aGlzLl9zaG91bGRSZWNvbm5lY3QpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fY29ubmVjdExvY2sgPSB0cnVlO1xuXG4gICAgY29uc3Qge1xuICAgICAgbWF4UmV0cmllcyA9IERFRkFVTFQubWF4UmV0cmllcyxcbiAgICAgIGNvbm5lY3Rpb25UaW1lb3V0ID0gREVGQVVMVC5jb25uZWN0aW9uVGltZW91dFxuICAgIH0gPSB0aGlzLl9vcHRpb25zO1xuXG4gICAgaWYgKHRoaXMuX3JldHJ5Q291bnQgPj0gbWF4UmV0cmllcykge1xuICAgICAgdGhpcy5fZGVidWcoXCJtYXggcmV0cmllcyByZWFjaGVkXCIsIHRoaXMuX3JldHJ5Q291bnQsIFwiPj1cIiwgbWF4UmV0cmllcyk7XG4gICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuX3JldHJ5Q291bnQrKztcblxuICAgIHRoaXMuX2RlYnVnKFwiY29ubmVjdFwiLCB0aGlzLl9yZXRyeUNvdW50KTtcbiAgICB0aGlzLl9yZW1vdmVMaXN0ZW5lcnMoKTtcblxuICAgIHRoaXMuX3dhaXQoKVxuICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgIHRoaXMuX2dldE5leHRVcmwodGhpcy5fdXJsKSxcbiAgICAgICAgICB0aGlzLl9nZXROZXh0UHJvdG9jb2xzKHRoaXMuX3Byb3RvY29scyB8fCBudWxsKVxuICAgICAgICBdKVxuICAgICAgKVxuICAgICAgLnRoZW4oKFt1cmwsIHByb3RvY29sc10pID0+IHtcbiAgICAgICAgLy8gY2xvc2UgY291bGQgYmUgY2FsbGVkIGJlZm9yZSBjcmVhdGluZyB0aGUgd3NcbiAgICAgICAgaWYgKHRoaXMuX2Nsb3NlQ2FsbGVkKSB7XG4gICAgICAgICAgdGhpcy5fY29ubmVjdExvY2sgPSBmYWxzZTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgICF0aGlzLl9vcHRpb25zLldlYlNvY2tldCAmJlxuICAgICAgICAgIHR5cGVvZiBXZWJTb2NrZXQgPT09IFwidW5kZWZpbmVkXCIgJiZcbiAgICAgICAgICAhZGlkV2FybkFib3V0TWlzc2luZ1dlYlNvY2tldFxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKGDigLzvuI8gTm8gV2ViU29ja2V0IGltcGxlbWVudGF0aW9uIGF2YWlsYWJsZS4gWW91IHNob3VsZCBkZWZpbmUgb3B0aW9ucy5XZWJTb2NrZXQuIFxuXG5Gb3IgZXhhbXBsZSwgaWYgeW91J3JlIHVzaW5nIG5vZGUuanMsIHJ1biBcXGBucG0gaW5zdGFsbCB3c1xcYCwgYW5kIHRoZW4gaW4geW91ciBjb2RlOlxuXG5pbXBvcnQgUGFydHlTb2NrZXQgZnJvbSAncGFydHlzb2NrZXQnO1xuaW1wb3J0IFdTIGZyb20gJ3dzJztcblxuY29uc3QgcGFydHlzb2NrZXQgPSBuZXcgUGFydHlTb2NrZXQoe1xuICBob3N0OiBcIjEyNy4wLjAuMToxOTk5XCIsXG4gIHJvb206IFwidGVzdC1yb29tXCIsXG4gIFdlYlNvY2tldDogV1Ncbn0pO1xuXG5gKTtcbiAgICAgICAgICBkaWRXYXJuQWJvdXRNaXNzaW5nV2ViU29ja2V0ID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBXUzogdHlwZW9mIFdlYlNvY2tldCA9IHRoaXMuX29wdGlvbnMuV2ViU29ja2V0IHx8IFdlYlNvY2tldDtcbiAgICAgICAgdGhpcy5fZGVidWcoXCJjb25uZWN0XCIsIHsgdXJsLCBwcm90b2NvbHMgfSk7XG4gICAgICAgIHRoaXMuX3dzID0gcHJvdG9jb2xzID8gbmV3IFdTKHVybCwgcHJvdG9jb2xzKSA6IG5ldyBXUyh1cmwpO1xuXG4gICAgICAgIHRoaXMuX3dzLmJpbmFyeVR5cGUgPSB0aGlzLl9iaW5hcnlUeXBlO1xuICAgICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgICB0aGlzLl9hZGRMaXN0ZW5lcnMoKTtcblxuICAgICAgICB0aGlzLl9jb25uZWN0VGltZW91dCA9IHNldFRpbWVvdXQoXG4gICAgICAgICAgKCkgPT4gdGhpcy5faGFuZGxlVGltZW91dCgpLFxuICAgICAgICAgIGNvbm5lY3Rpb25UaW1lb3V0XG4gICAgICAgICk7XG4gICAgICB9KVxuICAgICAgLy8gdmlhIGh0dHBzOi8vZ2l0aHViLmNvbS9wbGFkYXJpYS9yZWNvbm5lY3Rpbmctd2Vic29ja2V0L3B1bGwvMTY2XG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgICB0aGlzLl9oYW5kbGVFcnJvcihuZXcgRXZlbnRzLkVycm9yRXZlbnQoRXJyb3IoZXJyLm1lc3NhZ2UpLCB0aGlzKSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX2hhbmRsZVRpbWVvdXQoKSB7XG4gICAgdGhpcy5fZGVidWcoXCJ0aW1lb3V0IGV2ZW50XCIpO1xuICAgIHRoaXMuX2hhbmRsZUVycm9yKG5ldyBFdmVudHMuRXJyb3JFdmVudChFcnJvcihcIlRJTUVPVVRcIiksIHRoaXMpKTtcbiAgfVxuXG4gIHByaXZhdGUgX2Rpc2Nvbm5lY3QoY29kZSA9IDEwMDAsIHJlYXNvbj86IHN0cmluZykge1xuICAgIHRoaXMuX2NsZWFyVGltZW91dHMoKTtcbiAgICBpZiAoIXRoaXMuX3dzKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3JlbW92ZUxpc3RlbmVycygpO1xuICAgIHRyeSB7XG4gICAgICBpZiAoXG4gICAgICAgIHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuT1BFTiB8fFxuICAgICAgICB0aGlzLl93cy5yZWFkeVN0YXRlID09PSB0aGlzLkNPTk5FQ1RJTkdcbiAgICAgICkge1xuICAgICAgICB0aGlzLl93cy5jbG9zZShjb2RlLCByZWFzb24pO1xuICAgICAgfVxuICAgICAgdGhpcy5faGFuZGxlQ2xvc2UobmV3IEV2ZW50cy5DbG9zZUV2ZW50KGNvZGUsIHJlYXNvbiwgdGhpcykpO1xuICAgIH0gY2F0Y2ggKF9lcnJvcikge1xuICAgICAgLy8gaWdub3JlXG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfYWNjZXB0T3BlbigpIHtcbiAgICB0aGlzLl9kZWJ1ZyhcImFjY2VwdCBvcGVuXCIpO1xuICAgIHRoaXMuX3JldHJ5Q291bnQgPSAwO1xuICB9XG5cbiAgcHJpdmF0ZSBfaGFuZGxlT3BlbiA9IChldmVudDogRXZlbnQpID0+IHtcbiAgICB0aGlzLl9kZWJ1ZyhcIm9wZW4gZXZlbnRcIik7XG4gICAgY29uc3QgeyBtaW5VcHRpbWUgPSBERUZBVUxULm1pblVwdGltZSB9ID0gdGhpcy5fb3B0aW9ucztcblxuICAgIGNsZWFyVGltZW91dCh0aGlzLl9jb25uZWN0VGltZW91dCk7XG4gICAgdGhpcy5fdXB0aW1lVGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5fYWNjZXB0T3BlbigpLCBtaW5VcHRpbWUpO1xuXG4gICAgYXNzZXJ0KHRoaXMuX3dzLCBcIldlYlNvY2tldCBpcyBub3QgZGVmaW5lZFwiKTtcblxuICAgIHRoaXMuX3dzLmJpbmFyeVR5cGUgPSB0aGlzLl9iaW5hcnlUeXBlO1xuXG4gICAgLy8gc2VuZCBlbnF1ZXVlZCBtZXNzYWdlcyAobWVzc2FnZXMgc2VudCBiZWZvcmUgd2Vic29ja2V0IG9wZW4gZXZlbnQpXG4gICAgdGhpcy5fbWVzc2FnZVF1ZXVlLmZvckVhY2goKG1lc3NhZ2UpID0+IHtcbiAgICAgIHRoaXMuX3dzPy5zZW5kKG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHRoaXMuX21lc3NhZ2VRdWV1ZSA9IFtdO1xuXG4gICAgaWYgKHRoaXMub25vcGVuKSB7XG4gICAgICB0aGlzLm9ub3BlbihldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfaGFuZGxlTWVzc2FnZSA9IChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB7XG4gICAgdGhpcy5fZGVidWcoXCJtZXNzYWdlIGV2ZW50XCIpO1xuXG4gICAgaWYgKHRoaXMub25tZXNzYWdlKSB7XG4gICAgICB0aGlzLm9ubWVzc2FnZShldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfaGFuZGxlRXJyb3IgPSAoZXZlbnQ6IEVycm9yRXZlbnQpID0+IHtcbiAgICB0aGlzLl9kZWJ1ZyhcImVycm9yIGV2ZW50XCIsIGV2ZW50Lm1lc3NhZ2UpO1xuICAgIHRoaXMuX2Rpc2Nvbm5lY3QoXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBldmVudC5tZXNzYWdlID09PSBcIlRJTUVPVVRcIiA/IFwidGltZW91dFwiIDogdW5kZWZpbmVkXG4gICAgKTtcblxuICAgIGlmICh0aGlzLm9uZXJyb3IpIHtcbiAgICAgIHRoaXMub25lcnJvcihldmVudCk7XG4gICAgfVxuICAgIHRoaXMuX2RlYnVnKFwiZXhlYyBlcnJvciBsaXN0ZW5lcnNcIik7XG4gICAgdGhpcy5kaXNwYXRjaEV2ZW50KGNsb25lRXZlbnQoZXZlbnQpKTtcblxuICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgfTtcblxuICBwcml2YXRlIF9oYW5kbGVDbG9zZSA9IChldmVudDogQ2xvc2VFdmVudCkgPT4ge1xuICAgIHRoaXMuX2RlYnVnKFwiY2xvc2UgZXZlbnRcIik7XG4gICAgdGhpcy5fY2xlYXJUaW1lb3V0cygpO1xuXG4gICAgaWYgKHRoaXMuX3Nob3VsZFJlY29ubmVjdCkge1xuICAgICAgdGhpcy5fY29ubmVjdCgpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9uY2xvc2UpIHtcbiAgICAgIHRoaXMub25jbG9zZShldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfcmVtb3ZlTGlzdGVuZXJzKCkge1xuICAgIGlmICghdGhpcy5fd3MpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fZGVidWcoXCJyZW1vdmVMaXN0ZW5lcnNcIik7XG4gICAgdGhpcy5fd3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm9wZW5cIiwgdGhpcy5faGFuZGxlT3Blbik7XG4gICAgdGhpcy5fd3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsb3NlXCIsIHRoaXMuX2hhbmRsZUNsb3NlKTtcbiAgICB0aGlzLl93cy5yZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCB0aGlzLl9oYW5kbGVNZXNzYWdlKTtcbiAgICAvLyBAdHMtZXhwZWN0LWVycm9yIHdlIG5lZWQgdG8gZml4IGV2ZW50L2xpc3Rlcm5lciB0eXBlc1xuICAgIHRoaXMuX3dzLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCB0aGlzLl9oYW5kbGVFcnJvcik7XG4gIH1cblxuICBwcml2YXRlIF9hZGRMaXN0ZW5lcnMoKSB7XG4gICAgaWYgKCF0aGlzLl93cykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9kZWJ1ZyhcImFkZExpc3RlbmVyc1wiKTtcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwib3BlblwiLCB0aGlzLl9oYW5kbGVPcGVuKTtcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwiY2xvc2VcIiwgdGhpcy5faGFuZGxlQ2xvc2UpO1xuICAgIHRoaXMuX3dzLmFkZEV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIHRoaXMuX2hhbmRsZU1lc3NhZ2UpO1xuICAgIC8vIEB0cy1leHBlY3QtZXJyb3Igd2UgbmVlZCB0byBmaXggZXZlbnQvbGlzdGVuZXIgdHlwZXNcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgdGhpcy5faGFuZGxlRXJyb3IpO1xuICB9XG5cbiAgcHJpdmF0ZSBfY2xlYXJUaW1lb3V0cygpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy5fY29ubmVjdFRpbWVvdXQpO1xuICAgIGNsZWFyVGltZW91dCh0aGlzLl91cHRpbWVUaW1lb3V0KTtcbiAgfVxufVxuIiwgImltcG9ydCBSZWNvbm5lY3RpbmdXZWJTb2NrZXQgZnJvbSBcIi4vd3NcIjtcblxuaW1wb3J0IHR5cGUgKiBhcyBSV1MgZnJvbSBcIi4vd3NcIjtcbmltcG9ydCB0eXBlIHsgUHJvdG9jb2xzUHJvdmlkZXIgfSBmcm9tIFwiLi93c1wiO1xuXG50eXBlIE1heWJlPFQ+ID0gVCB8IG51bGwgfCB1bmRlZmluZWQ7XG50eXBlIFBhcmFtcyA9IFJlY29yZDxzdHJpbmcsIE1heWJlPHN0cmluZz4+O1xuY29uc3QgdmFsdWVJc05vdE5pbCA9IDxUPihcbiAga2V5VmFsdWVQYWlyOiBbc3RyaW5nLCBNYXliZTxUPl1cbik6IGtleVZhbHVlUGFpciBpcyBbc3RyaW5nLCBUXSA9PlxuICBrZXlWYWx1ZVBhaXJbMV0gIT09IG51bGwgJiYga2V5VmFsdWVQYWlyWzFdICE9PSB1bmRlZmluZWQ7XG5cbmV4cG9ydCB0eXBlIFBhcnR5U29ja2V0T3B0aW9ucyA9IE9taXQ8UldTLk9wdGlvbnMsIFwiY29uc3RydWN0b3JcIj4gJiB7XG4gIGlkPzogc3RyaW5nOyAvLyB0aGUgaWQgb2YgdGhlIGNsaWVudFxuICBob3N0OiBzdHJpbmc7IC8vIGJhc2UgdXJsIGZvciB0aGUgcGFydHlcbiAgcm9vbT86IHN0cmluZzsgLy8gdGhlIHJvb20gdG8gY29ubmVjdCB0b1xuICBwYXJ0eT86IHN0cmluZzsgLy8gdGhlIHBhcnR5IHRvIGNvbm5lY3QgdG8gKGRlZmF1bHRzIHRvIG1haW4pXG4gIGJhc2VQYXRoPzogc3RyaW5nOyAvLyB0aGUgYmFzZSBwYXRoIHRvIHVzZSBmb3IgdGhlIHBhcnR5XG4gIHByZWZpeD86IHN0cmluZzsgLy8gdGhlIHByZWZpeCB0byB1c2UgZm9yIHRoZSBwYXJ0eVxuICBwcm90b2NvbD86IFwid3NcIiB8IFwid3NzXCI7XG4gIHByb3RvY29scz86IFByb3RvY29sc1Byb3ZpZGVyO1xuICBwYXRoPzogc3RyaW5nOyAvLyB0aGUgcGF0aCB0byBjb25uZWN0IHRvXG4gIHF1ZXJ5PzogUGFyYW1zIHwgKCgpID0+IFBhcmFtcyB8IFByb21pc2U8UGFyYW1zPik7XG4gIGRpc2FibGVOYW1lVmFsaWRhdGlvbj86IGJvb2xlYW47IC8vIGRpc2FibGUgdmFsaWRhdGlvbiBvZiBwYXJ0eS9yb29tIG5hbWVzXG4gIC8vIGhlYWRlcnNcbn07XG5cbmV4cG9ydCB0eXBlIFBhcnR5RmV0Y2hPcHRpb25zID0ge1xuICBob3N0OiBzdHJpbmc7IC8vIGJhc2UgdXJsIGZvciB0aGUgcGFydHlcbiAgcm9vbTogc3RyaW5nOyAvLyB0aGUgcm9vbSB0byBjb25uZWN0IHRvXG4gIHBhcnR5Pzogc3RyaW5nOyAvLyB0aGUgcGFydHkgdG8gZmV0Y2ggZnJvbSAoZGVmYXVsdHMgdG8gbWFpbilcbiAgYmFzZVBhdGg/OiBzdHJpbmc7IC8vIHRoZSBiYXNlIHBhdGggdG8gdXNlIGZvciB0aGUgcGFydHlcbiAgcHJlZml4Pzogc3RyaW5nOyAvLyB0aGUgcHJlZml4IHRvIHVzZSBmb3IgdGhlIHBhcnR5XG4gIHBhdGg/OiBzdHJpbmc7IC8vIHRoZSBwYXRoIHRvIGZldGNoIGZyb21cbiAgcHJvdG9jb2w/OiBcImh0dHBcIiB8IFwiaHR0cHNcIjtcbiAgcXVlcnk/OiBQYXJhbXMgfCAoKCkgPT4gUGFyYW1zIHwgUHJvbWlzZTxQYXJhbXM+KTtcbiAgZmV0Y2g/OiB0eXBlb2YgZmV0Y2g7XG59O1xuXG5mdW5jdGlvbiBnZW5lcmF0ZVVVSUQoKTogc3RyaW5nIHtcbiAgLy8gUHVibGljIERvbWFpbi9NSVRcbiAgaWYgKGNyeXB0bz8ucmFuZG9tVVVJRCkge1xuICAgIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICB9XG4gIGxldCBkID0gRGF0ZS5ub3coKTsgLy9UaW1lc3RhbXBcbiAgbGV0IGQyID0gKHBlcmZvcm1hbmNlPy5ub3cgJiYgcGVyZm9ybWFuY2Uubm93KCkgKiAxMDAwKSB8fCAwOyAvL1RpbWUgaW4gbWljcm9zZWNvbmRzIHNpbmNlIHBhZ2UtbG9hZCBvciAwIGlmIHVuc3VwcG9ydGVkXG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBmdW5jLXN0eWxlXG4gIHJldHVybiBcInh4eHh4eHh4LXh4eHgtNHh4eC15eHh4LXh4eHh4eHh4eHh4eFwiLnJlcGxhY2UoL1t4eV0vZywgZnVuY3Rpb24gKGMpIHtcbiAgICBsZXQgciA9IE1hdGgucmFuZG9tKCkgKiAxNjsgLy9yYW5kb20gbnVtYmVyIGJldHdlZW4gMCBhbmQgMTZcbiAgICBpZiAoZCA+IDApIHtcbiAgICAgIC8vVXNlIHRpbWVzdGFtcCB1bnRpbCBkZXBsZXRlZFxuICAgICAgciA9ICgoZCArIHIpICUgMTYpIHwgMDtcbiAgICAgIGQgPSBNYXRoLmZsb29yKGQgLyAxNik7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vVXNlIG1pY3Jvc2Vjb25kcyBzaW5jZSBwYWdlLWxvYWQgaWYgc3VwcG9ydGVkXG4gICAgICByID0gKChkMiArIHIpICUgMTYpIHwgMDtcbiAgICAgIGQyID0gTWF0aC5mbG9vcihkMiAvIDE2KTtcbiAgICB9XG4gICAgcmV0dXJuIChjID09PSBcInhcIiA/IHIgOiAociAmIDB4MykgfCAweDgpLnRvU3RyaW5nKDE2KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldFBhcnR5SW5mbyhcbiAgcGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0eVNvY2tldE9wdGlvbnMgfCBQYXJ0eUZldGNoT3B0aW9ucyxcbiAgZGVmYXVsdFByb3RvY29sOiBcImh0dHBcIiB8IFwid3NcIixcbiAgZGVmYXVsdFBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9XG4pIHtcbiAgY29uc3Qge1xuICAgIGhvc3Q6IHJhd0hvc3QsXG4gICAgcGF0aDogcmF3UGF0aCxcbiAgICBwcm90b2NvbDogcmF3UHJvdG9jb2wsXG4gICAgcm9vbSxcbiAgICBwYXJ0eSxcbiAgICBiYXNlUGF0aCxcbiAgICBwcmVmaXgsXG4gICAgcXVlcnlcbiAgfSA9IHBhcnR5U29ja2V0T3B0aW9ucztcblxuICAvLyBzdHJpcCB0aGUgcHJvdG9jb2wgZnJvbSB0aGUgYmVnaW5uaW5nIG9mIGBob3N0YCBpZiBhbnlcbiAgbGV0IGhvc3QgPSByYXdIb3N0LnJlcGxhY2UoL14oaHR0cHxodHRwc3x3c3x3c3MpOlxcL1xcLy8sIFwiXCIpO1xuICAvLyBpZiB1c2VyIHByb3ZpZGVkIGEgdHJhaWxpbmcgc2xhc2gsIHJlbW92ZSBpdFxuICBpZiAoaG9zdC5lbmRzV2l0aChcIi9cIikpIHtcbiAgICBob3N0ID0gaG9zdC5zbGljZSgwLCAtMSk7XG4gIH1cblxuICBpZiAocmF3UGF0aD8uc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJwYXRoIG11c3Qgbm90IHN0YXJ0IHdpdGggYSBzbGFzaFwiKTtcbiAgfVxuXG4gIGNvbnN0IG5hbWUgPSBwYXJ0eSA/PyBcIm1haW5cIjtcbiAgY29uc3QgcGF0aCA9IHJhd1BhdGggPyBgLyR7cmF3UGF0aH1gIDogXCJcIjtcbiAgY29uc3QgcHJvdG9jb2wgPVxuICAgIHJhd1Byb3RvY29sIHx8XG4gICAgKGhvc3Quc3RhcnRzV2l0aChcImxvY2FsaG9zdDpcIikgfHxcbiAgICBob3N0LnN0YXJ0c1dpdGgoXCIxMjcuMC4wLjE6XCIpIHx8XG4gICAgaG9zdC5zdGFydHNXaXRoKFwiMTkyLjE2OC5cIikgfHxcbiAgICBob3N0LnN0YXJ0c1dpdGgoXCIxMC5cIikgfHxcbiAgICAoaG9zdC5zdGFydHNXaXRoKFwiMTcyLlwiKSAmJlxuICAgICAgaG9zdC5zcGxpdChcIi5cIilbMV0gPj0gXCIxNlwiICYmXG4gICAgICBob3N0LnNwbGl0KFwiLlwiKVsxXSA8PSBcIjMxXCIpIHx8XG4gICAgaG9zdC5zdGFydHNXaXRoKFwiWzo6ZmZmZjo3ZjAwOjFdOlwiKVxuICAgICAgPyAvLyBodHRwIC8gd3NcbiAgICAgICAgZGVmYXVsdFByb3RvY29sXG4gICAgICA6IC8vIGh0dHBzIC8gd3NzXG4gICAgICAgIGAke2RlZmF1bHRQcm90b2NvbH1zYCk7XG5cbiAgY29uc3QgYmFzZVVybCA9IGAke3Byb3RvY29sfTovLyR7aG9zdH0vJHtiYXNlUGF0aCB8fCBgJHtwcmVmaXggfHwgXCJwYXJ0aWVzXCJ9LyR7bmFtZX0vJHtyb29tfWB9JHtwYXRofWA7XG5cbiAgY29uc3QgbWFrZVVybCA9IChxdWVyeTogUGFyYW1zID0ge30pID0+XG4gICAgYCR7YmFzZVVybH0/JHtuZXcgVVJMU2VhcmNoUGFyYW1zKFtcbiAgICAgIC4uLk9iamVjdC5lbnRyaWVzKGRlZmF1bHRQYXJhbXMpLFxuICAgICAgLi4uT2JqZWN0LmVudHJpZXMocXVlcnkpLmZpbHRlcih2YWx1ZUlzTm90TmlsKVxuICAgIF0pfWA7XG5cbiAgLy8gYWxsb3cgdXJscyB0byBiZSBkZWZpbmVkIGFzIGZ1bmN0aW9uc1xuICBjb25zdCB1cmxQcm92aWRlciA9XG4gICAgdHlwZW9mIHF1ZXJ5ID09PSBcImZ1bmN0aW9uXCJcbiAgICAgID8gYXN5bmMgKCkgPT4gbWFrZVVybChhd2FpdCBxdWVyeSgpKVxuICAgICAgOiBtYWtlVXJsKHF1ZXJ5KTtcblxuICByZXR1cm4ge1xuICAgIGhvc3QsXG4gICAgcGF0aCxcbiAgICByb29tLFxuICAgIG5hbWUsXG4gICAgcHJvdG9jb2wsXG4gICAgcGFydHlVcmw6IGJhc2VVcmwsXG4gICAgdXJsUHJvdmlkZXJcbiAgfTtcbn1cblxuLy8gdGhpbmdzIHRoYXQgbmF0aGFuYm9rdGFlL3JvYnVzdC13ZWJzb2NrZXQgY2xhaW1zIGFyZSBiZXR0ZXI6XG4vLyBkb2Vzbid0IGRvIGFueXRoaW5nIGluIG9mZmxpbmUgbW9kZSAoPylcbi8vIFwibmF0aXZlbHkgYXdhcmUgb2YgZXJyb3IgY29kZXNcIlxuLy8gY2FuIGRvIGN1c3RvbSByZWNvbm5lY3Qgc3RyYXRlZ2llc1xuXG4vLyBUT0RPOiBpbmNvcnBvcmF0ZSB0aGUgYWJvdmUgbm90ZXNcbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBhcnR5U29ja2V0IGV4dGVuZHMgUmVjb25uZWN0aW5nV2ViU29ja2V0IHtcbiAgX3BrITogc3RyaW5nO1xuICBfcGt1cmwhOiBzdHJpbmc7XG4gIG5hbWUhOiBzdHJpbmc7XG4gIHJvb20/OiBzdHJpbmc7XG4gIGhvc3QhOiBzdHJpbmc7XG4gIHBhdGghOiBzdHJpbmc7XG4gIGJhc2VQYXRoPzogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHJlYWRvbmx5IHBhcnR5U29ja2V0T3B0aW9uczogUGFydHlTb2NrZXRPcHRpb25zKSB7XG4gICAgY29uc3Qgd3NPcHRpb25zID0gZ2V0V1NPcHRpb25zKHBhcnR5U29ja2V0T3B0aW9ucyk7XG5cbiAgICBzdXBlcih3c09wdGlvbnMudXJsUHJvdmlkZXIsIHdzT3B0aW9ucy5wcm90b2NvbHMsIHdzT3B0aW9ucy5zb2NrZXRPcHRpb25zKTtcblxuICAgIHRoaXMuc2V0V1NQcm9wZXJ0aWVzKHdzT3B0aW9ucyk7XG5cbiAgICBpZiAoIXBhcnR5U29ja2V0T3B0aW9ucy5zdGFydENsb3NlZCAmJiAhdGhpcy5yb29tICYmICF0aGlzLmJhc2VQYXRoKSB7XG4gICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiRWl0aGVyIHJvb20gb3IgYmFzZVBhdGggbXVzdCBiZSBwcm92aWRlZCB0byBjb25uZWN0LiBVc2Ugc3RhcnRDbG9zZWQ6IHRydWUgdG8gY3JlYXRlIGEgc29ja2V0IGFuZCBzZXQgdGhlbSB2aWEgdXBkYXRlUHJvcGVydGllcyBiZWZvcmUgY2FsbGluZyByZWNvbm5lY3QoKS5cIlxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIXBhcnR5U29ja2V0T3B0aW9ucy5kaXNhYmxlTmFtZVZhbGlkYXRpb24pIHtcbiAgICAgIGlmIChwYXJ0eVNvY2tldE9wdGlvbnMucGFydHk/LmluY2x1ZGVzKFwiL1wiKSkge1xuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFBhcnR5U29ja2V0OiBwYXJ0eSBuYW1lIFwiJHtwYXJ0eVNvY2tldE9wdGlvbnMucGFydHl9XCIgY29udGFpbnMgZm9yd2FyZCBzbGFzaCB3aGljaCBtYXkgY2F1c2Ugcm91dGluZyBpc3N1ZXMuIENvbnNpZGVyIHVzaW5nIGEgbmFtZSB3aXRob3V0IGZvcndhcmQgc2xhc2hlcyBvciBzZXQgZGlzYWJsZU5hbWVWYWxpZGF0aW9uOiB0cnVlIHRvIGJ5cGFzcyB0aGlzIHdhcm5pbmcuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnR5U29ja2V0T3B0aW9ucy5yb29tPy5pbmNsdWRlcyhcIi9cIikpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBQYXJ0eVNvY2tldDogcm9vbSBuYW1lIFwiJHtwYXJ0eVNvY2tldE9wdGlvbnMucm9vbX1cIiBjb250YWlucyBmb3J3YXJkIHNsYXNoIHdoaWNoIG1heSBjYXVzZSByb3V0aW5nIGlzc3Vlcy4gQ29uc2lkZXIgdXNpbmcgYSBuYW1lIHdpdGhvdXQgZm9yd2FyZCBzbGFzaGVzIG9yIHNldCBkaXNhYmxlTmFtZVZhbGlkYXRpb246IHRydWUgdG8gYnlwYXNzIHRoaXMgd2FybmluZy5gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHVibGljIHVwZGF0ZVByb3BlcnRpZXMocGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0aWFsPFBhcnR5U29ja2V0T3B0aW9ucz4pIHtcbiAgICBjb25zdCB3c09wdGlvbnMgPSBnZXRXU09wdGlvbnMoe1xuICAgICAgLi4udGhpcy5wYXJ0eVNvY2tldE9wdGlvbnMsXG4gICAgICAuLi5wYXJ0eVNvY2tldE9wdGlvbnMsXG4gICAgICBob3N0OiBwYXJ0eVNvY2tldE9wdGlvbnMuaG9zdCA/PyB0aGlzLmhvc3QsXG4gICAgICByb29tOiBwYXJ0eVNvY2tldE9wdGlvbnMucm9vbSA/PyB0aGlzLnJvb20sXG4gICAgICBwYXRoOiBwYXJ0eVNvY2tldE9wdGlvbnMucGF0aCA/PyB0aGlzLnBhdGgsXG4gICAgICBiYXNlUGF0aDogcGFydHlTb2NrZXRPcHRpb25zLmJhc2VQYXRoID8/IHRoaXMuYmFzZVBhdGhcbiAgICB9KTtcblxuICAgIHRoaXMuX3VybCA9IHdzT3B0aW9ucy51cmxQcm92aWRlcjtcbiAgICB0aGlzLl9wcm90b2NvbHMgPSB3c09wdGlvbnMucHJvdG9jb2xzO1xuICAgIHRoaXMuX29wdGlvbnMgPSB3c09wdGlvbnMuc29ja2V0T3B0aW9ucztcblxuICAgIHRoaXMuc2V0V1NQcm9wZXJ0aWVzKHdzT3B0aW9ucyk7XG4gIH1cblxuICBwcml2YXRlIHNldFdTUHJvcGVydGllcyh3c09wdGlvbnM6IFJldHVyblR5cGU8dHlwZW9mIGdldFdTT3B0aW9ucz4pIHtcbiAgICBjb25zdCB7IF9waywgX3BrdXJsLCBuYW1lLCByb29tLCBob3N0LCBwYXRoLCBiYXNlUGF0aCB9ID0gd3NPcHRpb25zO1xuXG4gICAgdGhpcy5fcGsgPSBfcGs7XG4gICAgdGhpcy5fcGt1cmwgPSBfcGt1cmw7XG4gICAgdGhpcy5uYW1lID0gbmFtZTtcbiAgICB0aGlzLnJvb20gPSByb29tO1xuICAgIHRoaXMuaG9zdCA9IGhvc3Q7XG4gICAgdGhpcy5wYXRoID0gcGF0aDtcbiAgICB0aGlzLmJhc2VQYXRoID0gYmFzZVBhdGg7XG4gIH1cblxuICBwdWJsaWMgcmVjb25uZWN0KFxuICAgIGNvZGU/OiBudW1iZXIgfCB1bmRlZmluZWQsXG4gICAgcmVhc29uPzogc3RyaW5nIHwgdW5kZWZpbmVkXG4gICk6IHZvaWQge1xuICAgIGlmICghdGhpcy5ob3N0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiVGhlIGhvc3QgbXVzdCBiZSBzZXQgYmVmb3JlIGNvbm5lY3RpbmcsIHVzZSBgdXBkYXRlUHJvcGVydGllc2AgbWV0aG9kIHRvIHNldCBpdCBvciBwYXNzIGl0IHRvIHRoZSBjb25zdHJ1Y3Rvci5cIlxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLnJvb20gJiYgIXRoaXMuYmFzZVBhdGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJUaGUgcm9vbSAob3IgYmFzZVBhdGgpIG11c3QgYmUgc2V0IGJlZm9yZSBjb25uZWN0aW5nLCB1c2UgYHVwZGF0ZVByb3BlcnRpZXNgIG1ldGhvZCB0byBzZXQgaXQgb3IgcGFzcyBpdCB0byB0aGUgY29uc3RydWN0b3IuXCJcbiAgICAgICk7XG4gICAgfVxuICAgIHN1cGVyLnJlY29ubmVjdChjb2RlLCByZWFzb24pO1xuICB9XG5cbiAgZ2V0IGlkKCkge1xuICAgIHJldHVybiB0aGlzLl9waztcbiAgfVxuXG4gIC8qKlxuICAgKiBFeHBvc2VzIHRoZSBzdGF0aWMgUGFydHlLaXQgcm9vbSBVUkwgd2l0aG91dCBhcHBseWluZyBxdWVyeSBwYXJhbWV0ZXJzLlxuICAgKiBUbyBhY2Nlc3MgdGhlIGN1cnJlbnRseSBjb25uZWN0ZWQgV2ViU29ja2V0IHVybCwgdXNlIFBhcnR5U29ja2V0I3VybC5cbiAgICovXG4gIGdldCByb29tVXJsKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuX3BrdXJsO1xuICB9XG5cbiAgLy8gYSBgZmV0Y2hgIG1ldGhvZCB0aGF0IHVzZXMgKGFsbW9zdCkgdGhlIHNhbWUgb3B0aW9ucyBhcyBgUGFydHlTb2NrZXRgXG4gIHN0YXRpYyBhc3luYyBmZXRjaChcbiAgICBvcHRpb25zOiBQYXJ0eUZldGNoT3B0aW9ucyxcbiAgICBpbml0PzogUmVxdWVzdEluaXRcbiAgKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICAgIGNvbnN0IHBhcnR5ID0gZ2V0UGFydHlJbmZvKG9wdGlvbnMsIFwiaHR0cFwiKTtcbiAgICBjb25zdCB1cmwgPVxuICAgICAgdHlwZW9mIHBhcnR5LnVybFByb3ZpZGVyID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gcGFydHkudXJsUHJvdmlkZXJcbiAgICAgICAgOiBhd2FpdCBwYXJ0eS51cmxQcm92aWRlcigpO1xuICAgIGNvbnN0IGRvRmV0Y2ggPSBvcHRpb25zLmZldGNoID8/IGZldGNoO1xuICAgIHJldHVybiBkb0ZldGNoKHVybCwgaW5pdCk7XG4gIH1cbn1cblxuZXhwb3J0IHsgUGFydHlTb2NrZXQgfTtcblxuZXhwb3J0IHsgUmVjb25uZWN0aW5nV2ViU29ja2V0IGFzIFdlYlNvY2tldCB9O1xuXG5mdW5jdGlvbiBnZXRXU09wdGlvbnMocGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0eVNvY2tldE9wdGlvbnMpIHtcbiAgY29uc3Qge1xuICAgIGlkLFxuICAgIGhvc3Q6IF9ob3N0LFxuICAgIHBhdGg6IF9wYXRoLFxuICAgIHBhcnR5OiBfcGFydHksXG4gICAgcm9vbTogX3Jvb20sXG4gICAgcHJvdG9jb2w6IF9wcm90b2NvbCxcbiAgICBxdWVyeTogX3F1ZXJ5LFxuICAgIHByb3RvY29scyxcbiAgICAuLi5zb2NrZXRPcHRpb25zXG4gIH0gPSBwYXJ0eVNvY2tldE9wdGlvbnM7XG5cbiAgY29uc3QgX3BrID0gaWQgfHwgZ2VuZXJhdGVVVUlEKCk7XG4gIGNvbnN0IHBhcnR5ID0gZ2V0UGFydHlJbmZvKHBhcnR5U29ja2V0T3B0aW9ucywgXCJ3c1wiLCB7IF9wayB9KTtcblxuICByZXR1cm4ge1xuICAgIF9wazogX3BrLFxuICAgIF9wa3VybDogcGFydHkucGFydHlVcmwsXG4gICAgbmFtZTogcGFydHkubmFtZSxcbiAgICByb29tOiBwYXJ0eS5yb29tLFxuICAgIGhvc3Q6IHBhcnR5Lmhvc3QsXG4gICAgcGF0aDogcGFydHkucGF0aCxcbiAgICBiYXNlUGF0aDogcGFydHlTb2NrZXRPcHRpb25zLmJhc2VQYXRoLFxuICAgIHByb3RvY29sczogcHJvdG9jb2xzLFxuICAgIHNvY2tldE9wdGlvbnM6IHNvY2tldE9wdGlvbnMsXG4gICAgdXJsUHJvdmlkZXI6IHBhcnR5LnVybFByb3ZpZGVyXG4gIH07XG59XG4iLCAiLyoqXHJcbiAqIGNsaWVudC9wYXJ0eWJ1cy50cyBcdTIwMTQgYnJvd3Nlci1zaWRlIFBhcnR5QnVzIGFkYXB0ZXIuXHJcbiAqXHJcbiAqIFB1YmxpYyBBUEkgKGtlcHQgQllURS1GT1ItQllURSBpZGVudGljYWwgdG8gdGhlIGlubGluZSBQYXJ0eUJ1cyBibG9ja1xyXG4gKiB0aGF0IHByZXZpb3VzbHkgbGl2ZWQgaW4gZWFjaCBIVE1MLCBzbyBubyBidXNpbmVzcy1sb2dpYyBjYWxsIHNpdGUgaGFzXHJcbiAqIHRvIGNoYW5nZSk6XHJcbiAqXHJcbiAqICAgUGFydHlCdXMuZW1pdCh0eXBlLCBwYXlsb2FkKSAgICAgICAgICAgXHUyMDE0IHNlbmQgY29tbWFuZCB0byBzZXJ2ZXJcclxuICogICBQYXJ0eUJ1cy5vbih0eXBlLCBjYikgICAgICAgICAgICAgICAgICBcdTIwMTQgc3Vic2NyaWJlIHRvIHNlcnZlciBldmVudHNcclxuICpcclxuICogTmV3IChhZGRpdGl2ZSkgQVBJIGZvciBQaGFzZSAzOlxyXG4gKlxyXG4gKiAgIFBhcnR5QnVzLmluaXQoey4uLn0pICAgICAgICAgICAgICAgICAgIFx1MjAxNCBvcGVuIHRoZSBXZWJTb2NrZXRcclxuICogICBQYXJ0eUJ1cy5vblN0YXR1cyhjYikgICAgICAgICAgICAgICAgICBcdTIwMTQgY29ubmVjdGlvbi1zdGF0dXMgdXBkYXRlc1xyXG4gKiAgIFBhcnR5QnVzLmdldFN0YXR1cygpICAgICAgICAgICAgICAgICAgIFx1MjAxNCBjdXJyZW50IGNvbm5lY3Rpb24gc3RhdHVzXHJcbiAqICAgUGFydHlCdXMuZ2V0Q29udHJvbENvZGUoKSAgICAgICAgICAgICAgXHUyMDE0IGFzc2lzdGFudC1zaWRlIGFjY2Vzc29yXHJcbiAqXHJcbiAqIEJ1bmRsZWQgdG8gL3B1YmxpYy9saWIvcGFydHlidXMuanMgYXMgYW4gSUlGRTsgYXNzaWducyBgd2luZG93LlBhcnR5QnVzYFxyXG4gKiBzeW5jaHJvbm91c2x5IHNvIGxlZ2FjeSBpbmxpbmUgc2NyaXB0cyBjYW4gY2FsbCBQYXJ0eUJ1cy5lbWl0L29uIHdpdGhvdXRcclxuICogd2FpdGluZyBmb3IgYSBtb2R1bGUgbG9hZC5cclxuICovXHJcblxyXG5pbXBvcnQgUGFydHlTb2NrZXQgZnJvbSAncGFydHlzb2NrZXQnO1xyXG5cclxudHlwZSBSb2xlID0gJ2Fzc2lzdGFudCcgfCAncHJlc2VudGVyJyB8ICdwYXJ0aWNpcGFudCc7XHJcbnR5cGUgU3RhdHVzID0gJ2Nvbm5lY3RpbmcnIHwgJ2Nvbm5lY3RlZCcgfCAnZGlzY29ubmVjdGVkJztcclxudHlwZSBMaXN0ZW5lciA9IChwYXlsb2FkOiB1bmtub3duKSA9PiB2b2lkO1xyXG50eXBlIFN0YXR1c0xpc3RlbmVyID0gKHN0YXR1czogU3RhdHVzKSA9PiB2b2lkO1xyXG5cclxuaW50ZXJmYWNlIEluaXRPcHRpb25zIHtcclxuICByb2xlOiBSb2xlO1xyXG4gIHJvb21JZDogc3RyaW5nO1xyXG4gIG5hbWU/OiBzdHJpbmc7ICAgICAgICAgICAgLy8gcGFydGljaXBhbnQgb25seVxyXG4gIHRlYW0/OiBzdHJpbmc7ICAgICAgICAgICAgLy8gcGFydGljaXBhbnQgb25seVxyXG4gIC8qKlxyXG4gICAqIFBlci1kZXZpY2UgaWRlbnRpdHksIHBlcnNpc3RlZCBpbiBsb2NhbFN0b3JhZ2UgYnkgdGhlIGNhbGxlci4gTXVsdGlwbGVcclxuICAgKiB0YWJzIGZyb20gdGhlIHNhbWUgYnJvd3NlciBzaGFyZSB0aGlzOyBzZXJ2ZXIgdXNlcyBpdCB0byBkZWR1cCBzbyBvbmVcclxuICAgKiBkZXZpY2UgPSBvbmUgcGFydGljaXBhbnQgKFx1NjVCMFx1OTU4Qlx1NTIwNlx1OTgwMVx1OEUyMlx1NjM4OVx1ODIwQVx1NTIwNlx1OTgwMSxcdTU0MDhcdTRGNzVcdTkwMzJcdTU0MENcdTRFMDBcdTdENDQpXHUzMDAyXHJcbiAgICovXHJcbiAgZGV2aWNlSWQ/OiBzdHJpbmc7XHJcbiAgLyoqIE92ZXJyaWRlIHNlcnZlciBob3N0LiBEZWZhdWx0OiB3aW5kb3cubG9jYXRpb24uaG9zdCAoc2FtZS1vcmlnaW4pLiAqL1xyXG4gIGhvc3Q/OiBzdHJpbmc7XHJcbiAgLyoqIFBhcnR5S2l0IFwicGFydHlcIiBuYW1lLiBEZWZhdWx0OiAnbWFpbicuICovXHJcbiAgcGFydHk/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmNvbnN0IFNFU1NJT05fU1RPUkFHRV9DQ19LRVkgPSAncGdnX2Fzc2lzdGFudF9jb250cm9sY29kZV92MSc7XHJcblxyXG5jbGFzcyBQYXJ0eUJ1c0ltcGwge1xyXG4gIHByaXZhdGUgbGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsIExpc3RlbmVyW10+KCk7XHJcbiAgcHJpdmF0ZSBzdGF0dXNMaXN0ZW5lcnM6IFN0YXR1c0xpc3RlbmVyW10gPSBbXTtcclxuICBwcml2YXRlIHNvY2tldDogUGFydHlTb2NrZXQgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIHJvbGU6IFJvbGUgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIGNvbnRyb2xDb2RlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICAvLyBEZWZhdWx0ICdjb25uZWN0aW5nJyAobm90ICdkaXNjb25uZWN0ZWQnKSBzbyBhIGZyZXNobHktbG9hZGVkIHBhZ2Ugc2hvd3NcclxuICAvLyBhIG5ldXRyYWwgXCJ3YXJtaW5nIHVwXCIgaW5kaWNhdG9yIGluc3RlYWQgb2YgYSBzY2FyeSByZWQgZGlzY29ubmVjdGVkXHJcbiAgLy8gZmxhc2ggYmVmb3JlIGluaXQoKSBydW5zLiBTdGF5cyAnY29ubmVjdGluZycgdW50aWwgdGhlIFdlYlNvY2tldCBvcGVuc1xyXG4gIC8vIChvciBmYWlscykuIFBoYXNlIDAgcmVnICMzIFx1MjAxNCBcIlx1NjVCN1x1N0REQVx1NjNEMFx1NzkzQVx1NjYyRlx1NzU3MFx1NUUzOFx1NzJDMFx1NjE0QixcdTUyMURcdTU5Q0JcdThGMDlcdTUxNjVcdTRFMERcdThBNzJcdTg5RjhcdTc2N0NcIi5cclxuICBwcml2YXRlIHN0YXR1czogU3RhdHVzID0gJ2Nvbm5lY3RpbmcnO1xyXG5cclxuICBpbml0KG9wdHM6IEluaXRPcHRpb25zKTogdm9pZCB7XHJcbiAgICBpZiAodGhpcy5fa2lja2VkKSB7XHJcbiAgICAgIGNvbnNvbGUud2FybignUGFydHlCdXMuaW5pdCBpZ25vcmVkIFx1MjAxNCB0aGlzIHRhYiB3YXMga2lja2VkIGJ5IGFub3RoZXIgdGFiJyk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICh0aGlzLnNvY2tldCkge1xyXG4gICAgICBjb25zb2xlLndhcm4oJ1BhcnR5QnVzLmluaXQgY2FsbGVkIG1vcmUgdGhhbiBvbmNlOyBpZ25vcmluZycpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICB0aGlzLnJvbGUgPSBvcHRzLnJvbGU7XHJcblxyXG4gICAgLy8gUmVzdG9yZSBwcmV2aW91c2x5LWlzc3VlZCBjb250cm9sQ29kZSBmcm9tIHNlc3Npb25TdG9yYWdlIChhc3Npc3RhbnRcclxuICAgIC8vIHJlZnJlc2hpbmcgdGhlIHBhZ2Ugc2hvdWxkIG5vdCBsb3NlIGhvc3QgcHJpdmlsZWdlcykuXHJcbiAgICBpZiAob3B0cy5yb2xlID09PSAnYXNzaXN0YW50Jykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IHNlc3Npb25TdG9yYWdlLmdldEl0ZW0oU0VTU0lPTl9TVE9SQUdFX0NDX0tFWSk7XHJcbiAgICAgICAgaWYgKHN0b3JlZCkgdGhpcy5jb250cm9sQ29kZSA9IHN0b3JlZDtcclxuICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgLyogc2Vzc2lvblN0b3JhZ2UgbWF5IGJlIGRpc2FibGVkIGluIHNvbWUgZW1iZWRkZWQgY29udGV4dHMgKi9cclxuICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHF1ZXJ5OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyByb2xlOiBvcHRzLnJvbGUgfTtcclxuICAgIGlmIChvcHRzLm5hbWUpIHF1ZXJ5Lm5hbWUgPSBvcHRzLm5hbWU7XHJcbiAgICBpZiAob3B0cy50ZWFtKSBxdWVyeS50ZWFtID0gb3B0cy50ZWFtO1xyXG4gICAgaWYgKG9wdHMuZGV2aWNlSWQpIHF1ZXJ5LmRldmljZUlkID0gb3B0cy5kZXZpY2VJZDtcclxuICAgIGlmIChvcHRzLnJvbGUgPT09ICdhc3Npc3RhbnQnICYmIHRoaXMuY29udHJvbENvZGUpIHtcclxuICAgICAgcXVlcnkuY29udHJvbENvZGUgPSB0aGlzLmNvbnRyb2xDb2RlO1xyXG4gICAgfVxyXG5cclxuICAgIHRoaXMuc29ja2V0ID0gbmV3IFBhcnR5U29ja2V0KHtcclxuICAgICAgaG9zdDogb3B0cy5ob3N0ID8/IHdpbmRvdy5sb2NhdGlvbi5ob3N0LFxyXG4gICAgICBwYXJ0eTogb3B0cy5wYXJ0eSA/PyAnbWFpbicsXHJcbiAgICAgIHJvb206IG9wdHMucm9vbUlkLFxyXG4gICAgICBxdWVyeSxcclxuICAgIH0pO1xyXG5cclxuICAgIHRoaXMuc2V0U3RhdHVzKCdjb25uZWN0aW5nJyk7XHJcblxyXG4gICAgdGhpcy5zb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignb3BlbicsICgpID0+IHRoaXMuc2V0U3RhdHVzKCdjb25uZWN0ZWQnKSk7XHJcbiAgICB0aGlzLnNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsICgpID0+IHRoaXMuc2V0U3RhdHVzKCdkaXNjb25uZWN0ZWQnKSk7XHJcbiAgICB0aGlzLnNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsICgpID0+IHRoaXMuc2V0U3RhdHVzKCdkaXNjb25uZWN0ZWQnKSk7XHJcblxyXG4gICAgdGhpcy5zb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIChlOiBNZXNzYWdlRXZlbnQpID0+IHtcclxuICAgICAgbGV0IGVudjogeyB0eXBlPzogc3RyaW5nOyBwYXlsb2FkPzogdW5rbm93biB9O1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGVudiA9IEpTT04ucGFyc2UodHlwZW9mIGUuZGF0YSA9PT0gJ3N0cmluZycgPyBlLmRhdGEgOiAnJyk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICBpZiAoIWVudiB8fCB0eXBlb2YgZW52LnR5cGUgIT09ICdzdHJpbmcnKSByZXR1cm47XHJcblxyXG4gICAgICAvLyBLZWVwYWxpdmU6XHU0RUZCXHU0RjU1IHNlcnZlciBcdThBMEFcdTYwNkZcdTkwRkRcdThCNDlcdTY2MEVcdTkwMjNcdTdEREFcdTZEM0JcdTg0NTdcdTMwMDJcclxuICAgICAgdGhpcy5fbGFzdE1zZ0F0ID0gRGF0ZS5ub3coKTtcclxuICAgICAgaWYgKGVudi50eXBlID09PSAnX19wb25nX18nKSB7XHJcbiAgICAgICAgLy8gc2VydmVyIFx1NjUyRlx1NjNGNCBwb25nIFx1MjE5MiBcdTU1NUZcdTc1MjhcdTMwMENcdTU5MkFcdTRFNDVcdTZDOTJcdThBMEFcdTYwNkZcdTVDMzFcdTVGMzdcdTUyMzZcdTkxQ0RcdTkwMjNcdTMwMERcdTUyMjRcdTVCOUFcdTMwMDJcclxuICAgICAgICB0aGlzLl9wb25nQ2FwYWJsZSA9IHRydWU7XHJcbiAgICAgICAgcmV0dXJuOyAvLyBcdTdEMTQga2VlcGFsaXZlIFx1OEEwQVx1Njg0NixcdTRFMERcdTc1MjggZGlzcGF0Y2hcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gSW50ZXJjZXB0IHNlcnZlci1wcml2YXRlIGZyYW1lcyBiZWZvcmUgZGlzcGF0Y2hpbmcuXHJcbiAgICAgIGlmIChlbnYudHlwZSA9PT0gJ19fd2VsY29tZV9fJykge1xyXG4gICAgICAgIGNvbnN0IHdwID0gZW52LnBheWxvYWQgYXMgeyBjb250cm9sQ29kZT86IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmICh3cD8uY29udHJvbENvZGUgJiYgdGhpcy5yb2xlID09PSAnYXNzaXN0YW50Jykge1xyXG4gICAgICAgICAgdGhpcy5jb250cm9sQ29kZSA9IHdwLmNvbnRyb2xDb2RlO1xyXG4gICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgc2Vzc2lvblN0b3JhZ2Uuc2V0SXRlbShTRVNTSU9OX1NUT1JBR0VfQ0NfS0VZLCB3cC5jb250cm9sQ29kZSk7XHJcbiAgICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgLyogaWdub3JlICovXHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGVsc2UgaWYgKGVudi50eXBlID09PSAnX19lcnJvcl9fJykge1xyXG4gICAgICAgIC8vIFN1cmZhY2Ugc2VydmVyIGVycm9ycyB0byBjb25zb2xlIHNvIGRlYnVnZ2luZyBpcyBlYXNpZXI7IHN0aWxsXHJcbiAgICAgICAgLy8gZGlzcGF0Y2ggdG8gbGlzdGVuZXJzIGluIGNhc2UgdGhlIEhUTUwgd2FudHMgdG8gcmVuZGVyIGFuIGFsZXJ0LlxyXG4gICAgICAgIGNvbnNvbGUud2FybignUGFydHlCdXMgc2VydmVyIGVycm9yOicsIGVudi5wYXlsb2FkKTtcclxuICAgICAgfSBlbHNlIGlmIChlbnYudHlwZSA9PT0gJ19fa2lja2VkX18nKSB7XHJcbiAgICAgICAgLy8gXHU1NDBDIGRldmljZUlkIFx1NjVCMFx1NTIwNlx1OTgwMVx1OTAzMlx1NEY4NixzZXJ2ZXIgXHU2MjhBXHU2NzJDXHU5MDIzXHU3RERBXHU4RTIyXHU2Mzg5XHUzMDAyXHU2QTE5XHU4QTE4XHU3MEJBIGtpY2tlZCxcclxuICAgICAgICAvLyBcdTRFM0JcdTUyRDUgY2xvc2UgXHU0RTI2XHU1MDVDXHU2QjYyXHU5MUNEXHU5MDIzKFx1NTQyNlx1NTI0NyBwYXJ0eXNvY2tldCBcdTY3MDNcdTgxRUFcdTUyRDVcdTkxQ0RcdTkwMjMgXHUyMTkyIHNlcnZlciBcdTUzQzhcclxuICAgICAgICAvLyBcdThFMjJcdTY1QjBcdTUyMDZcdTk4MDEgXHUyMTkyIFx1NTE2OVx1OTA4QVx1NEU5Mlx1NzZGOFx1OEUyMlx1NzY4NFx1OEZGNFx1NTcwOClcdTMwMDJIVE1MIFx1OTBBM1x1OTA4QSBsaXN0ZW4gX19raWNrZWRfX1xyXG4gICAgICAgIC8vIFx1OTg2Rlx1NzkzQVx1NjNEMFx1NzkzQVx1MzAwMlxyXG4gICAgICAgIHRoaXMuX2tpY2tlZCA9IHRydWU7XHJcbiAgICAgICAgdHJ5IHsgdGhpcy5zb2NrZXQ/LmNsb3NlKCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxyXG4gICAgICAgIHRoaXMuc29ja2V0ID0gbnVsbDtcclxuICAgICAgICB0aGlzLl9zdG9wS2VlcGFsaXZlKCk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIHRoaXMuX2Rpc3BhdGNoKGVudi50eXBlLCBlbnYucGF5bG9hZCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICB0aGlzLl9zdGFydEtlZXBhbGl2ZSgpO1xyXG4gIH1cclxuXHJcbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcbiAgLy8gS2VlcGFsaXZlIFx1MjAxNCBcdTUzNEFcdTZCN0JcdTkwMjNcdTdEREFcdTUwNzVcdTZFMkNcclxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcclxuICAvLyBUQ1AgXHU5MDIzXHU3RERBXHU1M0VGXHU4MEZEXHUzMDBDXHU1REYyXHU2QjdCXHU0RjQ2XHU3MDBGXHU4OUJEXHU1NjY4XHU2QzkyXHU2NTM2XHU1MjMwIGNsb3NlXHUzMDBEKE5BVCB0aW1lb3V0XHUzMDAxXHU3REIyXHU1MzYxXHU0RjExXHU3NzIwXHUzMDAxXHJcbiAgLy8gQVAgXHU2Mzg5XHU1MzA1XHU3QjQ5KTpcdThBMEFcdTYwNkZcdTVGOUVcdTZCNjRcdTY1MzZcdTRFMERcdTUyMzAscGFydHlzb2NrZXQgXHU0RTVGXHU0RTBEXHU2NzAzXHU5MUNEXHU5MDIzKFx1NUI4M1x1NTNFQVx1ODA3RFxyXG4gIC8vIGNsb3NlL2Vycm9yKVx1MzAwMlx1NzNGRVx1NTgzNFx1NzVDN1x1NzJDMDpcdTYyOTVcdTVGNzFcdTdBRUZcdTUzNjFcdTU3MjhcdTgyMEFcdTc1NkJcdTk3NjIgfjMwIFx1NzlEMixcdTc2RjRcdTUyMzBcdTcwMEZcdTg5QkRcdTU2NjhcdTgxRUFcdTVERjFcclxuICAvLyBcdTc2N0NcdTczRkVcdTkwMjNcdTdEREFcdTZCN0JcdTRFODYgXHUyMTkyIHBhcnR5c29ja2V0IFx1OTFDRFx1OTAyMyBcdTIxOTIgX19yb29tX3N0YXRlX18gXHU1RkVCXHU3MTY3XHU2MjhBXHU3NTZCXHU5NzYyXHU2NTUxXHU1NkRFXHUzMDAyXHJcbiAgLy9cclxuICAvLyBcdTVDMERcdTdCNTY6XHU5NTkyXHU3RjZFXHU4RDg1XHU5MDRFIElETEVfUElOR19NUyBcdTVDMzFcdTkwMDEgcGluZyhzZXJ2ZXIgXHU1NkRFIF9fcG9uZ19fO1x1NEVGQlx1NEY1NVxyXG4gIC8vIHNlcnZlciBcdThBMEFcdTYwNkZcdTkwRkRcdTY3MDNcdTUyMzdcdTY1QjAgX2xhc3RNc2dBdCk7XHU1QjhDXHU1MTY4XHU2Qzg5XHU5RUQ4XHU4RDg1XHU5MDRFIFNUQUxFX1JFQ09OTkVDVF9NU1xyXG4gIC8vIFx1MjE5MiBcdTRFM0JcdTUyRDUgcmVjb25uZWN0KCksXHU4QjkzXHU1RkVCXHU3MTY3XHU3QUNCXHU1MjNCXHU5MDg0XHU1MzlGXHU3NTZCXHU5NzYyLFx1NEUwRFx1N0I0OVx1NzAwRlx1ODlCRFx1NTY2OFx1NjE2Mlx1NjE2Mlx1NzY3Q1x1NzNGRVx1MzAwMlxyXG4gIC8vXHJcbiAgLy8gXHU3NkY4XHU1QkI5XHU2MDI3Olx1NjUzNlx1NTIzMFx1N0IyQ1x1NEUwMFx1NTAwQiBfX3BvbmdfXyBcdTUyNERcdTRFMERcdTU1NUZcdTUyRDVcdTVGMzdcdTUyMzZcdTkxQ0RcdTkwMjMoX3BvbmdDYXBhYmxlIGdhdGUpLFxyXG4gIC8vIFx1OTA3Rlx1NTE0RFx1MzAwQ1x1NTI0RFx1N0FFRlx1NURGMlx1NjZGNFx1NjVCMFx1MzAwMVBhcnR5S2l0IHNlcnZlciBcdTkwODRcdTZDOTIgZGVwbG95XHUzMDBEXHU3Njg0XHU3QTdBXHU3QTk3XHU2NzFGXHU1NzI4XHU1Qjg5XHU5NzVDXHU2MjNGXHU5NTkzXHJcbiAgLy8gXHU2QkNGIDI1IFx1NzlEMlx1NzY3RFx1NzY3RFx1OTFDRFx1OTAyM1x1NEUwMFx1NkIyMVx1MzAwMlxyXG4gIHByaXZhdGUgX2xhc3RNc2dBdCA9IDA7XHJcbiAgcHJpdmF0ZSBfcG9uZ0NhcGFibGUgPSBmYWxzZTtcclxuICBwcml2YXRlIF9rZWVwYWxpdmVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gIHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IElETEVfUElOR19NUyA9IDhfMDAwO1xyXG4gIHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IFNUQUxFX1JFQ09OTkVDVF9NUyA9IDI1XzAwMDtcclxuXHJcbiAgcHJpdmF0ZSBfc3RhcnRLZWVwYWxpdmUoKTogdm9pZCB7XHJcbiAgICB0aGlzLl9sYXN0TXNnQXQgPSBEYXRlLm5vdygpO1xyXG4gICAgaWYgKHRoaXMuX2tlZXBhbGl2ZVRpbWVyKSBjbGVhckludGVydmFsKHRoaXMuX2tlZXBhbGl2ZVRpbWVyKTtcclxuICAgIHRoaXMuX2tlZXBhbGl2ZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gdGhpcy5fa2VlcGFsaXZlVGljaygpLCA1XzAwMCk7XHJcbiAgICAvLyBcdTYyNEJcdTZBNUZcdTg5RTNcdTkzOTYgLyBcdTUyMDdcdTU2REVcdTUyMDZcdTk4MDEgLyBcdTdEQjJcdThERUZcdTYwNjJcdTVGQTk6XHU3QUNCXHU1MjNCXHU2QUEyXHU2N0U1LFx1NEUwRFx1N0I0OVx1NEUwQlx1NEUwMFx1NTAwQiB0aWNrXHUzMDAyXHJcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignb25saW5lJywgKCkgPT4gdGhpcy5fa2VlcGFsaXZlVGljaygpKTtcclxuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChkb2N1bWVudC52aXNpYmlsaXR5U3RhdGUgPT09ICd2aXNpYmxlJykgdGhpcy5fa2VlcGFsaXZlVGljaygpO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIF9zdG9wS2VlcGFsaXZlKCk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMuX2tlZXBhbGl2ZVRpbWVyKSB7XHJcbiAgICAgIGNsZWFySW50ZXJ2YWwodGhpcy5fa2VlcGFsaXZlVGltZXIpO1xyXG4gICAgICB0aGlzLl9rZWVwYWxpdmVUaW1lciA9IG51bGw7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIF9rZWVwYWxpdmVUaWNrKCk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMuX2tpY2tlZCB8fCAhdGhpcy5zb2NrZXQpIHJldHVybjtcclxuICAgIGNvbnN0IGlkbGUgPSBEYXRlLm5vdygpIC0gdGhpcy5fbGFzdE1zZ0F0O1xyXG4gICAgaWYgKHRoaXMuX3BvbmdDYXBhYmxlICYmIGlkbGUgPiBQYXJ0eUJ1c0ltcGwuU1RBTEVfUkVDT05ORUNUX01TKSB7XHJcbiAgICAgIGNvbnNvbGUud2FybihcclxuICAgICAgICBgUGFydHlCdXMga2VlcGFsaXZlOiAke01hdGgucm91bmQoaWRsZSAvIDEwMDApfXMgXHU2QzkyXHU2NTM2XHU1MjMwXHU0RUZCXHU0RjU1IHNlcnZlciBcdThBMEFcdTYwNkYgXHUyMDE0IFx1NTIyNFx1NUI5QVx1OTAyM1x1N0REQVx1NTM0QVx1NkI3QixcdTVGMzdcdTUyMzZcdTkxQ0RcdTkwMjNgXHJcbiAgICAgICk7XHJcbiAgICAgIHRoaXMuX2xhc3RNc2dBdCA9IERhdGUubm93KCk7IC8vIFx1OTFDRFx1OTAyM1x1NjcxRlx1OTU5M1x1NEUwRFx1OTFDRFx1ODkwN1x1ODlGOFx1NzY3Q1xyXG4gICAgICB0aGlzLnNldFN0YXR1cygnY29ubmVjdGluZycpO1xyXG4gICAgICB0cnkgeyB0aGlzLnNvY2tldC5yZWNvbm5lY3QoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XHJcbiAgICB9IGVsc2UgaWYgKGlkbGUgPiBQYXJ0eUJ1c0ltcGwuSURMRV9QSU5HX01TKSB7XHJcbiAgICAgIC8vIFx1OTU5Mlx1N0Y2RVx1NjI0RCBwaW5nO1x1NjcwOVx1NkI2M1x1NUUzOFx1NUVFM1x1NjRBRFx1NkQ0MVx1OTFDRlx1NjY0Mlx1NEUwRFx1NTkxQVx1NTYzNFx1MzAwMlxyXG4gICAgICB0cnkgeyB0aGlzLmVtaXQoJ3BpbmcnLCB7IGZyb206IHRoaXMucm9sZSwga2VlcGFsaXZlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBUcnVlIGFmdGVyIHNlcnZlciBzZW50IF9fa2lja2VkX187IGVtaXQvaW5pdCBiZWNvbWUgbm8tb3BzLiAqL1xyXG4gIHByaXZhdGUgX2tpY2tlZCA9IGZhbHNlO1xyXG5cclxuICAvKipcclxuICAgKiBcdTRFM0JcdTUyRDVcdTZDMzhcdTRFNDVcdTk2RTJcdTdEREE6XHU5NURDXHU5NTg5XHU5MDIzXHU3RERBXHU0RTI2XHU1MDVDXHU2QjYyXHU4MUVBXHU1MkQ1XHU5MUNEXHU5MDIzKFx1NjUzOVx1NTQwRFx1OTAzRVx1NjY0Mlx1ODhBQlx1OEFDQlx1NTFGQVx1NjIzRlx1OTU5M1x1NjY0Mlx1NzUyOClcdTMwMDJcclxuICAgKiBcdTRFMERcdTkwMTlcdTZBMjNcdTUwNUFcdTc2ODRcdThBNzEgcGFydHlzb2NrZXQgXHU2NzAzXHU4MUVBXHU1MkQ1XHU5MUNEXHU5MDIzIFx1MjAxNFx1MjAxNCBcdTRFQkFcdTk2RDZcdTcxMzZcdTVERjJcdTg4QUJcdTc5RkJcdTUxRkFcdTU0MERcdTU1QUUsc29ja2V0XHJcbiAgICogXHU0RUNEXHU2MzlCXHU4NDU3LFx1NTJBOVx1NzQwNlx1N0FFRlx1OUVERVx1NTQwRFx1NjcwM1x1NTkxQVx1N0I5N1x1NEUwMFx1NTAwQlx1MzAwMlx1NEU0Qlx1NUY4QyBlbWl0L2luaXQgXHU5MEZEXHU4QjhBXHU2MjEwIG5vLW9wXHUzMDAyXHJcbiAgICovXHJcbiAgZGlzY29ubmVjdCgpOiB2b2lkIHtcclxuICAgIHRoaXMuX2tpY2tlZCA9IHRydWU7XHJcbiAgICB0cnkgeyB0aGlzLnNvY2tldD8uY2xvc2UoKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgY2xvc2luZyAqLyB9XHJcbiAgICB0aGlzLnNvY2tldCA9IG51bGw7XHJcbiAgICB0aGlzLl9zdG9wS2VlcGFsaXZlKCk7XHJcbiAgICB0aGlzLnNldFN0YXR1cygnZGlzY29ubmVjdGVkJyk7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBcdTkwMjNcdTdEREFcdTY1QjdcdTYzODlcdTY2NDJcdTMwMENcdTRFMERcdTUzRUZcdTRFRTVcdTlFRDhcdTlFRDhcdTRFMUZcdTYzODlcdTMwMERcdTc2ODRcdTYzMDdcdTRFRTRcdTMwMDJcdTkwMTlcdTRFOUJcdTY2MkZcdTUyQTlcdTc0MDZcdTYzMDlcdTRFMEJcdTUzQkJcdTY3MDNcdTY1MzlcdThCOEFcdTUxNjhcdTU4MzRcdTcyQzBcdTYxNEJcdTc2ODRcclxuICAgKiBcdTY0Q0RcdTRGNUMsXHU0RTFGXHU2Mzg5XHU0RTg2XHU1MkE5XHU3NDA2XHU0RTBEXHU2NzAzXHU3N0U1XHU5MDUzLFx1NzU2Qlx1OTc2Mlx1NTM3Qlx1NURGMlx1N0Q5M1x1ODFFQVx1NURGMVx1NUY4MFx1NTI0RFx1OEQ3MFx1MzAwMlxyXG4gICAqXHJcbiAgICogMjAyNi0wNy0yMyBcdTVCRTZcdTZFMkNcdTRFOEJcdTY1NDU6XHU1MkE5XHU3NDA2XHU3QUVGIHNvY2tldCBcdTY2MkYgZGlzY29ubmVjdGVkIFx1NzJDMFx1NjE0Qlx1NjY0Mlx1NjMwOVx1NEU4Nlx1MzAwQ1x1OTFDRFx1NjVCMFx1OTU4Qlx1NTlDQlx1MzAwRCxcclxuICAgKiBcdTUyQTlcdTc0MDZcdTdBRUZcdTc1NkJcdTk3NjJcdTcxNjdcdTVFMzhcdTU2REVcdTUyMzBcdThBMkRcdTVCOUFcdTk4MDFcdTMwMDFcdTcyQzBcdTYxNEJcdTUyMTdcdTkwODRcdTVCRUJcdTMwMENcdTkwNEFcdTYyMzJcdTVERjJcdTkxQ0RcdTdGNkVcdTMwMEQsXHU0RjQ2IHNlcnZlciBcdTVCOENcdTUxNjhcdTZDOTJcdTY1MzZcdTUyMzBcclxuICAgKiAocGhhc2UgXHU0RUNEXHU2NjJGIGVuZGVkXHUzMDAxXHU1MjA2XHU2NTc4XHU5MDg0XHU1NzI4KVx1MzAwMlx1NTJBOVx1NzQwNlx1NkJFQlx1NEUwRFx1NzdFNVx1NjBDNSxcdTYzQTVcdTg0NTdcdTU3MjhcdTkzMkZcdThBQTRcdTcyQzBcdTYxNEJcdTRFMEFcdTc1OEFcdTY0Q0RcdTRGNUNcdTMwMDJcclxuICAgKlxyXG4gICAqIFx1OTAxOVx1ODhFMVx1NEUwRFx1NTA1QVx1MzAwQ1x1ODFFQVx1NTJENVx1ODhEQ1x1OTAwMVx1MzAwRFx1MjAxNFx1MjAxNCBcdTg4RENcdTkwMDFcdTRFMDBcdTUwMEJcdTVFN0VcdTUyMDZcdTk0MThcdTUyNERcdTYzMDlcdTc2ODRcdTMwMENcdTRFMEJcdTRFMDBcdTk4NENcdTMwMERcdTZCRDRcdTRFMUZcdTYzODlcdTY2RjRcdTUzNzFcdTk2QUFcdTMwMDJcclxuICAgKiBcdTY1MzlcdTYyMTA6XHU5MDAxXHU0RTBEXHU1MUZBXHU1M0JCXHU1QzMxXHU2NjBFXHU3OEJBXHU4QjkzXHU1NDdDXHU1M0VCXHU3QUVGXHU4MjA3XHU0RjdGXHU3NTI4XHU4MDA1XHU3N0U1XHU5MDUzLFx1NzUzMVx1NEVCQVx1NkM3QVx1NUI5QVx1ODk4MVx1NEUwRFx1ODk4MVx1OTFDRFx1NjMwOVx1MzAwMlxyXG4gICAqL1xyXG4gIHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IE1VU1RfREVMSVZFUiA9IG5ldyBTZXQ8c3RyaW5nPihbXHJcbiAgICAnZ2FtZV9zdGFydCcsICdnYW1lX3Jlc3RhcnQnLCAnc2NvcmVfYWRqdXN0JywgJ3N0YXJ0X3J1c2gnLCAncmVidXp6X3NhbWUnLCAnZnJlc2hfcnVzaCcsXHJcbiAgICAnZW50ZXJfY2F0ZWdvcnknLCAnY2F0ZWdvcnlfcHJldmlldycsICdjYXRlZ29yeV9jb25maXJtJywgJ2NhdGVnb3J5X3Jlc2V0JyxcclxuICAgICdyZXZlYWxfYW5zd2VyJywgJ25leHRfcXVlc3Rpb24nLCAnc2tpcF9xdWVzdGlvbicsICdyZWRyYXdfcXVlc3Rpb24nLFxyXG4gICAgJ2FybV9wdXJnYXRvcnknLCAnbW9kZV9wcmV2aWV3JywgJ2N1c3RvbV90aWVyc19jaGFuZ2VkJywgJ3J1c2hfbW9kZV9jaGFuZ2VkJyxcclxuICAgICdwcmVzZW50ZXJfc2hvd19xcicsICdleHBvcnRfcmVzdWx0JywgJ3RlYW1fY291bnRfY2hhbmdlZCcsXHJcbiAgICAnZ3JvdXBpbmdfbW9kZV9jaGFuZ2VkJywgJ25vdGlmeV9ncm91cCcsICdzZXRfdGltZXInLCAncmVzdW1lX3F1ZXN0aW9uJyxcclxuICAgICdyZWFzc2lnbl9sZWFkZXInLCAndGVhbV9yZW5hbWUnLCAncGxheWVyX2pvaW4nLCAncmVuYW1lX3NlbGYnLFxyXG4gICAgJ2Fzc2lnbl9hc3Npc3RhbnRfcm9sZScsICdyZW5hbWVfYXNzaXN0YW50JywgJ3NldF9vd25fbmFtZScsICdyZW1vdmVfYXNzaXN0YW50JyxcclxuICAgICd0b2dnbGVfZ3JvdXBfcGluJyxcclxuICBdKTtcclxuXHJcbiAgLyoqIFx1NjMwN1x1NEVFNFx1OTAwMVx1NEUwRFx1NTFGQVx1NTNCQlx1NjY0Mlx1OTAxQVx1NzdFNVx1NTkxNlx1NUM2NChcdTUyQTlcdTc0MDZcdTdBRUZcdTc1MjhcdTRGODZcdThERjNcdThCNjZcdTU0NEEpXHUzMDAyICovXHJcbiAgcHJpdmF0ZSB1bmRlbGl2ZXJlZExpc3RlbmVyczogKCh0eXBlOiBzdHJpbmcpID0+IHZvaWQpW10gPSBbXTtcclxuXHJcbiAgb25VbmRlbGl2ZXJlZChjYjogKHR5cGU6IHN0cmluZykgPT4gdm9pZCk6IHZvaWQge1xyXG4gICAgdGhpcy51bmRlbGl2ZXJlZExpc3RlbmVycy5wdXNoKGNiKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgcmVwb3J0VW5kZWxpdmVyZWQodHlwZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IGNiIG9mIHRoaXMudW5kZWxpdmVyZWRMaXN0ZW5lcnMpIHtcclxuICAgICAgdHJ5IHsgY2IodHlwZSk7IH0gY2F0Y2ggKGVycikgeyBjb25zb2xlLmVycm9yKCdQYXJ0eUJ1cyB1bmRlbGl2ZXJlZCBsaXN0ZW5lciBlcnJvcjonLCBlcnIpOyB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBcdTkwMDFcdTYzMDdcdTRFRTRcdTMwMDJcdTU2REVcdTUwQjMgdHJ1ZSA9IFx1NURGMlx1NEVBNFx1N0Q2NiBzb2NrZXQgXHU5MDAxXHU1MUZBO2ZhbHNlID0gXHU2QzkyXHU5MDAxXHU1MUZBXHU1M0JCXHUzMDAyXHJcbiAgICogXHU1NDdDXHU1M0VCXHU3QUVGKipcdTRFMERcdTYxQzlcdThBNzIqKlx1NTcyOFx1NjJGRlx1NTIzMCBmYWxzZSBcdTRFNEJcdTVGOENcdTkwODRcdTYyOEFcdTY3MkNcdTZBNUYgVUkgXHU3NTc2XHU2MjEwXHU2NENEXHU0RjVDXHU2MjEwXHU1MjlGXHUzMDAyXHJcbiAgICovXHJcbiAgZW1pdCh0eXBlOiBzdHJpbmcsIHBheWxvYWQ/OiB1bmtub3duKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBzb2NrZXQgPSB0aGlzLnNvY2tldDtcclxuICAgIC8vIHJlYWR5U3RhdGUgMSA9IE9QRU5cdTMwMDJcdTkxQ0RcdTkwMjNcdTRFMkQoQ09OTkVDVElORylcdTkwMDFcdTUxRkFcdTUzQkJcdTY3MDNcdTc2RjRcdTYzQTVcdTRFMUZcdTRGOEJcdTU5MTZcdTYyMTZcdTg4QUJcdTU0MUVcdTYzODksXHJcbiAgICAvLyBcdTUxNjlcdTdBMkVcdTkwRkRcdTY2MkZcdTk3NUNcdTlFRDhcdTU5MzFcdTY1NTcgXHUyMDE0XHUyMDE0IFx1NEUwMFx1NUY4Qlx1NzU3Nlx1NjIxMFx1NkM5Mlx1OTAwMVx1NTFGQVx1MzAwMlxyXG4gICAgY29uc3QgdXNhYmxlID0gISFzb2NrZXQgJiYgc29ja2V0LnJlYWR5U3RhdGUgPT09IDE7XHJcbiAgICBpZiAoIXVzYWJsZSkge1xyXG4gICAgICBpZiAoUGFydHlCdXNJbXBsLk1VU1RfREVMSVZFUi5oYXModHlwZSkpIHtcclxuICAgICAgICBjb25zb2xlLndhcm4oYFBhcnR5QnVzLmVtaXQoJyR7dHlwZX0nKSBcdTZDOTJcdTY3MDlcdTkwMDFcdTUxRkEgXHUyMDE0IFx1OTAyM1x1N0REQVx1NEUwRFx1NTNFRlx1NzUyOChyZWFkeVN0YXRlPSR7c29ja2V0ID8gc29ja2V0LnJlYWR5U3RhdGUgOiAnbm8gc29ja2V0J30pYCk7XHJcbiAgICAgICAgdGhpcy5yZXBvcnRVbmRlbGl2ZXJlZCh0eXBlKTtcclxuICAgICAgfVxyXG4gICAgICAvLyBwaW5nIC8gYnV6el9wcmVzcyBcdTkwMTlcdTk4NUVcdTlBRDhcdTk4M0JcdTcxMjFcdTcyQzBcdTYxNEJcdTYzMDdcdTRFRTQ6XHU0RTFGXHU2Mzg5XHU1QzMxXHU0RTFGXHU2Mzg5LFx1NEUwRFx1NTQzNVx1NEY3Rlx1NzUyOFx1ODAwNVx1MzAwMlxyXG4gICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBlbnY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlLCBwYXlsb2FkIH07XHJcbiAgICAvLyBBdXRvLWF0dGFjaCBjb250cm9sQ29kZSBmb3IgYXNzaXN0YW50LWlzc3VlZCBjb21tYW5kcy4gU2VydmVyIG9ubHlcclxuICAgIC8vIHJlcXVpcmVzIGl0IGZvciBwcml2aWxlZ2VkIG9uZXMsIGJ1dCBhdHRhY2hpbmcgdG8gYWxsIGlzIGhhcm1sZXNzXHJcbiAgICAvLyBhbmQgYXZvaWRzIG5lZWRpbmcgYSBkdXBsaWNhdGUgXCJpcyB0aGlzIHByaXZpbGVnZWQ/XCIgdGFibGUgb24gdGhlXHJcbiAgICAvLyBjbGllbnQuXHJcbiAgICBpZiAodGhpcy5yb2xlID09PSAnYXNzaXN0YW50JyAmJiB0aGlzLmNvbnRyb2xDb2RlKSB7XHJcbiAgICAgIGVudi5jb250cm9sQ29kZSA9IHRoaXMuY29udHJvbENvZGU7XHJcbiAgICB9XHJcbiAgICB0cnkge1xyXG4gICAgICBzb2NrZXQuc2VuZChKU09OLnN0cmluZ2lmeShlbnYpKTtcclxuICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgY29uc29sZS53YXJuKGBQYXJ0eUJ1cy5lbWl0KCcke3R5cGV9Jykgc2VuZCBcdTU5MzFcdTY1NTc6YCwgZXJyKTtcclxuICAgICAgaWYgKFBhcnR5QnVzSW1wbC5NVVNUX0RFTElWRVIuaGFzKHR5cGUpKSB0aGlzLnJlcG9ydFVuZGVsaXZlcmVkKHR5cGUpO1xyXG4gICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBvbih0eXBlOiBzdHJpbmcsIGNiOiBMaXN0ZW5lcik6IHZvaWQge1xyXG4gICAgbGV0IGFyciA9IHRoaXMubGlzdGVuZXJzLmdldCh0eXBlKTtcclxuICAgIGlmICghYXJyKSB7XHJcbiAgICAgIGFyciA9IFtdO1xyXG4gICAgICB0aGlzLmxpc3RlbmVycy5zZXQodHlwZSwgYXJyKTtcclxuICAgIH1cclxuICAgIGFyci5wdXNoKGNiKTtcclxuICB9XHJcblxyXG4gIG9uU3RhdHVzKGNiOiBTdGF0dXNMaXN0ZW5lcik6IHZvaWQge1xyXG4gICAgdGhpcy5zdGF0dXNMaXN0ZW5lcnMucHVzaChjYik7XHJcbiAgICAvLyBSZXBsYXkgY3VycmVudCBzdGF0dXMgaW1tZWRpYXRlbHkgc28gc3Vic2NyaWJlcnMgY2FuIHJlbmRlciBjb3JyZWN0bHlcclxuICAgIC8vIGV2ZW4gaWYgdGhleSByZWdpc3RlcmVkIGFmdGVyIGEgY29ubmVjdGlvbiBldmVudC5cclxuICAgIHRyeSB7XHJcbiAgICAgIGNiKHRoaXMuc3RhdHVzKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zb2xlLmVycm9yKCdQYXJ0eUJ1cyBzdGF0dXMgbGlzdGVuZXIgZXJyb3I6JywgZXJyKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGdldFN0YXR1cygpOiBTdGF0dXMge1xyXG4gICAgcmV0dXJuIHRoaXMuc3RhdHVzO1xyXG4gIH1cclxuXHJcbiAgZ2V0Q29udHJvbENvZGUoKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICByZXR1cm4gdGhpcy5jb250cm9sQ29kZTtcclxuICB9XHJcblxyXG4gIC8qKiBUZXN0L2RlYnVnIGhlbHBlciBcdTIwMTQgZHJvcCB0aGUgc2F2ZWQgY29udHJvbENvZGUgc28gdGhlIG5leHQgaW5pdCgpXHJcbiAgICogYWN0cyBhcyBhIGZyZXNoIGFzc2lzdGFudCBjb25uZWN0aW9uLiBOb3QgdXNlZCBieSBhcHAgY29kZS4gKi9cclxuICBmb3JnZXRDb250cm9sQ29kZSgpOiB2b2lkIHtcclxuICAgIHRoaXMuY29udHJvbENvZGUgPSBudWxsO1xyXG4gICAgdHJ5IHtcclxuICAgICAgc2Vzc2lvblN0b3JhZ2UucmVtb3ZlSXRlbShTRVNTSU9OX1NUT1JBR0VfQ0NfS0VZKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAvKiBpZ25vcmUgKi9cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxyXG4gIC8vIEludGVybmFsc1xyXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxyXG5cclxuICBwcml2YXRlIF9kaXNwYXRjaCh0eXBlOiBzdHJpbmcsIHBheWxvYWQ6IHVua25vd24pOiB2b2lkIHtcclxuICAgIGNvbnN0IGFyciA9IHRoaXMubGlzdGVuZXJzLmdldCh0eXBlKTtcclxuICAgIGlmICghYXJyKSByZXR1cm47XHJcbiAgICBmb3IgKGNvbnN0IGNiIG9mIGFycikge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNiKHBheWxvYWQpO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICBjb25zb2xlLmVycm9yKGBQYXJ0eUJ1cyBsaXN0ZW5lclske3R5cGV9XSBlcnJvcjpgLCBlcnIpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHNldFN0YXR1cyhzOiBTdGF0dXMpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0YXR1cyA9PT0gcykgcmV0dXJuO1xyXG4gICAgdGhpcy5zdGF0dXMgPSBzO1xyXG4gICAgZm9yIChjb25zdCBjYiBvZiB0aGlzLnN0YXR1c0xpc3RlbmVycykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNiKHMpO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICBjb25zb2xlLmVycm9yKCdQYXJ0eUJ1cyBzdGF0dXMgbGlzdGVuZXIgZXJyb3I6JywgZXJyKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxufVxyXG5cclxuY29uc3QgUGFydHlCdXMgPSBuZXcgUGFydHlCdXNJbXBsKCk7XHJcbih3aW5kb3cgYXMgdW5rbm93biBhcyB7IFBhcnR5QnVzOiBQYXJ0eUJ1c0ltcGwgfSkuUGFydHlCdXMgPSBQYXJ0eUJ1cztcclxuZXhwb3J0IGRlZmF1bHQgUGFydHlCdXM7XHJcbiIsICIvKipcclxuICogY2xpZW50L2Jhbmtsb2FkZXIudHMgXHUyMDE0IGZldGNoIHRoZSA1IEJBTksgSlNPTnMgZnJvbSAvZGF0YS8gYW5kIG5vcm1hbGl6ZVxyXG4gKiB0aGVtIGludG8gdGhlIGZsYXQgc2hhcGUgdGhhdCB0aGUgdGhyZWUgSFRNTHMgZXhwZWN0LlxyXG4gKlxyXG4gKiBQaGFzZSAwIFExMSBkZXBsb3ltZW50IHBsYW46IEJBTksgbGl2ZXMgYXQgL3B1YmxpYy9kYXRhLyBhcyBzdGF0aWNcclxuICogSlNPTiwgc2VydmVkIGJ5IENsb3VkZmxhcmUgUGFnZXMuIEFsbCB0aHJlZSBjbGllbnRzIGZldGNoIG9uIGxvYWQuXHJcbiAqIFNlcnZlciBpcyBzdGlsbCBhdXRob3JpdGF0aXZlIGZvciBxdWVzdGlvbiBzZWxlY3Rpb24gKGdldHMgYnVuZGxlZFxyXG4gKiBjb3BpZXMgYXQgYnVpbGQgdGltZSk7IGNsaWVudHMgb25seSBuZWVkIHRoZSBiYW5rIGZvciBjb250ZW50IGxvb2t1cFxyXG4gKiAoc3RlbSAvIG9wdGlvbnMgLyBhbnN3ZXIgdGV4dCBnaXZlbiBhIHF1ZXN0aW9uIGlkKS5cclxuICpcclxuICogQnVuZGxlZCBpbnRvIHRoZSBzYW1lIElJRkUgYXMgUGFydHlCdXMgYW5kIGV4cG9zZWQgYXRcclxuICogYHdpbmRvdy5QR0dCYW5rTG9hZGVyYCBzbyB0aGUgZXhpc3RpbmcgaW5saW5lIHNjcmlwdHMgY2FuIGNhbGwgaXRcclxuICogd2l0aG91dCBFU00gZ3ltbmFzdGljcy5cclxuICovXHJcblxyXG50eXBlIERpZmZpY3VsdHkgPSAnZWFzeScgfCAnbWVkaXVtJyB8ICdoYXJkJyB8ICdoZWxsJyB8ICdwdXJnYXRvcnknO1xyXG5cclxuY29uc3QgQUxMX0RJRkZJQ1VMVElFUzogRGlmZmljdWx0eVtdID0gWydlYXN5JywgJ21lZGl1bScsICdoYXJkJywgJ2hlbGwnLCAncHVyZ2F0b3J5J107XHJcblxyXG5jb25zdCBJRF9QUkVGSVhfVE9fRElGRjogUmVjb3JkPHN0cmluZywgRGlmZmljdWx0eT4gPSB7XHJcbiAgRTogJ2Vhc3knLFxyXG4gIE06ICdtZWRpdW0nLFxyXG4gIEg6ICdoYXJkJyxcclxuICBYOiAnaGVsbCcsXHJcbiAgUDogJ3B1cmdhdG9yeScsXHJcbn07XHJcblxyXG5jb25zdCBTWVNURU1fQV9UWVBFUyA9IFsnc2hvcnRfYW5zd2VyJywgJ211bHRpcGxlX2Nob2ljZScsICdlc3NheScsICdjYWxjdWxhdGlvbicsICd3b3JkX2dhbWUnXTtcclxuXHJcbmludGVyZmFjZSBSYXdRdWVzdGlvbiB7XHJcbiAgaWQ6IHN0cmluZztcclxuICB0b3BpYzogc3RyaW5nO1xyXG4gIHR5cGU/OiBzdHJpbmc7XHJcbiAgW2s6IHN0cmluZ106IHVua25vd247XHJcbn1cclxuXHJcbmludGVyZmFjZSBOb3JtYWxpemVkQmFuayB7XHJcbiAgcXVlc3Rpb25zOiBSYXdRdWVzdGlvbltdOyAgICAgICAgICAgLy8gYWx3YXlzIGZsYXQgd2l0aCBgdHlwZWAgZmllbGRcclxuICBjb3VudDogbnVtYmVyO1xyXG4gIGJ5VHlwZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcclxuICB1cGxvYWRlZEF0OiBzdHJpbmc7XHJcbiAgZmlsZW5hbWU6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBBdXRvTG9hZE9wdGlvbnMge1xyXG4gIC8qKiBQYXRoIHByZWZpeCBmb3IgZmV0Y2guIERlZmF1bHQ6ICdkYXRhLycgKHJlbGF0aXZlIFx1MjAxNCB3b3JrcyBmaWxlOi8vICsgaHR0cCkuICovXHJcbiAgYmFzZVVybD86IHN0cmluZztcclxuICAvKiogRmlyZWQgYWZ0ZXIgZWFjaCBmaWxlIGlzIGxvYWRlZCAob3IgZmFpbHMpLiAqL1xyXG4gIG9uUHJvZ3Jlc3M/OiAobG9hZGVkOiBudW1iZXIsIHRvdGFsOiBudW1iZXIsIGRpZmZpY3VsdHk6IERpZmZpY3VsdHkpID0+IHZvaWQ7XHJcbiAgLyoqIEZpcmVkIHdpdGggZWFjaCBwZXItZmlsZSBlcnJvci4gKi9cclxuICBvbkVycm9yPzogKGRpZmZpY3VsdHk6IERpZmZpY3VsdHksIG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBBdXRvTG9hZFJlc3VsdCB7XHJcbiAgb2s6IGJvb2xlYW47XHJcbiAgYmFua3M6IFBhcnRpYWw8UmVjb3JkPERpZmZpY3VsdHksIE5vcm1hbGl6ZWRCYW5rPj47XHJcbiAgZXJyb3JzOiB7IGRpZmZpY3VsdHk6IERpZmZpY3VsdHk7IG1lc3NhZ2U6IHN0cmluZyB9W107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZShkaWZmOiBEaWZmaWN1bHR5LCBwYXJzZWQ6IHVua25vd24sIGZpbGVuYW1lOiBzdHJpbmcpOiBOb3JtYWxpemVkQmFuayB7XHJcbiAgaWYgKGRpZmYgPT09ICdwdXJnYXRvcnknKSB7XHJcbiAgICAvLyBTeXN0ZW0gQjogZmxhdCBhcnJheTsgZWFjaCBpdGVtIGhhcyBpdHMgb3duIGB0eXBlYCBmaWVsZC5cclxuICAgIGNvbnN0IHJvb3QgPSBwYXJzZWQgYXMgeyBxdWVzdGlvbnM/OiBSYXdRdWVzdGlvbltdIH07XHJcbiAgICBjb25zdCBhcnIgPSBBcnJheS5pc0FycmF5KHJvb3QucXVlc3Rpb25zKSA/IHJvb3QucXVlc3Rpb25zIDogW107XHJcbiAgICBjb25zdCBieVR5cGU6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgcSBvZiBhcnIpIHtcclxuICAgICAgY29uc3QgdCA9IHEudHlwZSA/PyAndW5rbm93bic7XHJcbiAgICAgIGJ5VHlwZVt0XSA9IChieVR5cGVbdF0gPz8gMCkgKyAxO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgcXVlc3Rpb25zOiBhcnIsXHJcbiAgICAgIGNvdW50OiBhcnIubGVuZ3RoLFxyXG4gICAgICBieVR5cGUsXHJcbiAgICAgIHVwbG9hZGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuICAgICAgZmlsZW5hbWUsXHJcbiAgICB9O1xyXG4gIH1cclxuICAvLyBTeXN0ZW0gQTogbmVzdGVkIHF1ZXN0aW9ucy48ZGlmZmljdWx0eT4uPHR5cGU+W107IGZsYXR0ZW4gYW5kIHN0YW1wIGB0eXBlYC5cclxuICBjb25zdCByb290ID0gcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gIGxldCBiYW5rOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IGJ5RGlmZiA9IChyb290LnF1ZXN0aW9ucyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCk/LltkaWZmXTtcclxuICBpZiAoYnlEaWZmICYmIHR5cGVvZiBieURpZmYgPT09ICdvYmplY3QnKSBiYW5rID0gYnlEaWZmIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gIGVsc2UgaWYgKHJvb3RbZGlmZl0gJiYgdHlwZW9mIHJvb3RbZGlmZl0gPT09ICdvYmplY3QnKSBiYW5rID0gcm9vdFtkaWZmXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICBlbHNlIGlmIChyb290LnF1ZXN0aW9ucyAmJiB0eXBlb2Ygcm9vdC5xdWVzdGlvbnMgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHJvb3QucXVlc3Rpb25zKSkge1xyXG4gICAgYmFuayA9IHJvb3QucXVlc3Rpb25zIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gIH1cclxuICBpZiAoIWJhbmspIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihgZXhwZWN0ZWQgbmVzdGVkIHF1ZXN0aW9ucy4ke2RpZmZ9Ljx0eXBlPiBzdHJ1Y3R1cmVgKTtcclxuICB9XHJcbiAgY29uc3QgZmxhdDogUmF3UXVlc3Rpb25bXSA9IFtdO1xyXG4gIGNvbnN0IGJ5VHlwZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xyXG4gIGZvciAoY29uc3QgdCBvZiBTWVNURU1fQV9UWVBFUykge1xyXG4gICAgY29uc3QgYXJyID0gYmFua1t0XTtcclxuICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSBjb250aW51ZTtcclxuICAgIGZvciAoY29uc3QgcmF3IG9mIGFyciBhcyBSYXdRdWVzdGlvbltdKSB7XHJcbiAgICAgIGZsYXQucHVzaCh7IC4uLnJhdywgdHlwZTogdCB9KTtcclxuICAgIH1cclxuICAgIGJ5VHlwZVt0XSA9IGFyci5sZW5ndGg7XHJcbiAgfVxyXG4gIGlmIChmbGF0Lmxlbmd0aCA9PT0gMCkge1xyXG4gICAgdGhyb3cgbmV3IEVycm9yKGBubyBxdWVzdGlvbnMgZm91bmQgaW4gbmVzdGVkIHN0cnVjdHVyZSBmb3IgJHtkaWZmfWApO1xyXG4gIH1cclxuICByZXR1cm4ge1xyXG4gICAgcXVlc3Rpb25zOiBmbGF0LFxyXG4gICAgY291bnQ6IGZsYXQubGVuZ3RoLFxyXG4gICAgYnlUeXBlLFxyXG4gICAgdXBsb2FkZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgZmlsZW5hbWUsXHJcbiAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gbG9hZE9uZShkaWZmOiBEaWZmaWN1bHR5LCBiYXNlVXJsOiBzdHJpbmcpOiBQcm9taXNlPE5vcm1hbGl6ZWRCYW5rPiB7XHJcbiAgY29uc3QgZmlsZW5hbWUgPSBgaW5zdXJhbmNlLXF1aXotYmFuay0ke2RpZmZ9Lmpzb25gO1xyXG4gIGNvbnN0IHVybCA9IGAke2Jhc2VVcmx9JHtmaWxlbmFtZX1gO1xyXG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBjYWNoZTogJ25vLWNhY2hlJyB9KTtcclxuICBpZiAoIXJlcy5vaykge1xyXG4gICAgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzLnN0YXR1c30gZmV0Y2hpbmcgJHt1cmx9YCk7XHJcbiAgfVxyXG4gIGxldCBwYXJzZWQ6IHVua25vd247XHJcbiAgdHJ5IHtcclxuICAgIHBhcnNlZCA9IGF3YWl0IHJlcy5qc29uKCk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgdGhyb3cgbmV3IEVycm9yKGBKU09OIHBhcnNlIGZhaWxlZCBmb3IgJHtmaWxlbmFtZX06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgfVxyXG4gIHJldHVybiBub3JtYWxpemUoZGlmZiwgcGFyc2VkLCBmaWxlbmFtZSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGF1dG9Mb2FkKG9wdHM6IEF1dG9Mb2FkT3B0aW9ucyA9IHt9KTogUHJvbWlzZTxBdXRvTG9hZFJlc3VsdD4ge1xyXG4gIGNvbnN0IGJhc2VVcmwgPSBvcHRzLmJhc2VVcmwgPz8gJ2RhdGEvJztcclxuICBjb25zdCBiYW5rczogUGFydGlhbDxSZWNvcmQ8RGlmZmljdWx0eSwgTm9ybWFsaXplZEJhbms+PiA9IHt9O1xyXG4gIGNvbnN0IGVycm9yczogQXV0b0xvYWRSZXN1bHRbJ2Vycm9ycyddID0gW107XHJcbiAgbGV0IGxvYWRlZCA9IDA7XHJcbiAgLy8gTG9hZCBpbiBwYXJhbGxlbCBcdTIwMTQgNSBzbWFsbCBmaWxlcywgbm8gbmVlZCB0byBzZXJpYWxpemUuXHJcbiAgYXdhaXQgUHJvbWlzZS5hbGwoXHJcbiAgICBBTExfRElGRklDVUxUSUVTLm1hcChhc3luYyAoZGlmZikgPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGJhbmsgPSBhd2FpdCBsb2FkT25lKGRpZmYsIGJhc2VVcmwpO1xyXG4gICAgICAgIGJhbmtzW2RpZmZdID0gYmFuaztcclxuICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcclxuICAgICAgICBlcnJvcnMucHVzaCh7IGRpZmZpY3VsdHk6IGRpZmYsIG1lc3NhZ2U6IG1zZyB9KTtcclxuICAgICAgICBvcHRzLm9uRXJyb3I/LihkaWZmLCBtc2cpO1xyXG4gICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGxvYWRlZCArPSAxO1xyXG4gICAgICAgIG9wdHMub25Qcm9ncmVzcz8uKGxvYWRlZCwgQUxMX0RJRkZJQ1VMVElFUy5sZW5ndGgsIGRpZmYpO1xyXG4gICAgICB9XHJcbiAgICB9KVxyXG4gICk7XHJcbiAgcmV0dXJuIHtcclxuICAgIG9rOiBlcnJvcnMubGVuZ3RoID09PSAwLFxyXG4gICAgYmFua3MsXHJcbiAgICBlcnJvcnMsXHJcbiAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEhlbHBlciBmb3IgY2xpZW50cyB3aXRoIGEgYEJBTktfU0NIRU1BYCB0YWJsZSB3aGVyZSBlYWNoIGRpZmZpY3VsdHkgaGFzXHJcbiAqIGEgYHByZWZpeGAgKEUvTS9IL1gvUCkuIFVzZWZ1bCBmb3IgYGdldFF1ZXN0aW9uQnlJZChpZClgIGxvb2t1cHMuXHJcbiAqL1xyXG5mdW5jdGlvbiBkaWZmaWN1bHR5Rm9ySWQoaWQ6IHN0cmluZyk6IERpZmZpY3VsdHkgfCBudWxsIHtcclxuICBjb25zdCBwcmVmaXggPSBpZD8uWzBdPy50b1VwcGVyQ2FzZT8uKCk7XHJcbiAgcmV0dXJuIHByZWZpeCA/IChJRF9QUkVGSVhfVE9fRElGRltwcmVmaXhdID8/IG51bGwpIDogbnVsbDtcclxufVxyXG5cclxuY29uc3QgUEdHQmFua0xvYWRlciA9IHtcclxuICBhdXRvTG9hZCxcclxuICBkaWZmaWN1bHR5Rm9ySWQsXHJcbn07XHJcblxyXG4od2luZG93IGFzIHVua25vd24gYXMgeyBQR0dCYW5rTG9hZGVyOiB0eXBlb2YgUEdHQmFua0xvYWRlciB9KS5QR0dCYW5rTG9hZGVyID0gUEdHQmFua0xvYWRlcjtcclxuXHJcbmV4cG9ydCBkZWZhdWx0IFBHR0JhbmtMb2FkZXI7XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQVdBLE1BQUksQ0FBQyxXQUFXLGVBQWUsQ0FBQyxXQUFXOzs7Ozs7Ozs7Q0FZM0M7TUFDRSxhQUFBLGNBQUEsTUFBQTtJQUNBO0lBRUE7SUFDRSxZQUFNLE9BQVMsUUFBTztBQUN0QixZQUFLLFNBQVUsTUFBTTtBQUNyQixXQUFLLFVBQVEsTUFBQTs7O0VBSWpCO01BQ0UsYUFBQSxjQUFBLE1BQUE7SUFDQTtJQUNBO0lBRUEsV0FBWTtJQUNWLFlBQU0sT0FBUyxLQUFPLFNBQUEsSUFBQSxRQUFBO0FBQ3RCLFlBQUssU0FBTyxNQUFBO0FBQ1osV0FBSyxPQUFTOzs7RUFVbEI7TUFDRSxTQUFBO0lBQ0E7SUFDQTtJQUNEO0VBRUQ7QUFDRSxXQUFLLE9BQ0gsV0FBVSxLQUFBOztFQUlkO0FBRUUsV0FBTyxrQkFBMkIsR0FBRTs7RUFHdEM7QUFDRSxXQUFJLGVBRUYsR0FEWTtBQUlkLFFBQUksVUFBVSxFQUFBLFFBQUssSUFBQSxhQUNMLEVBQUEsTUFBSSxDQUFBO0FBVWxCLFFBQUksVUFBVyxLQUViLFlBRGdCO0FBS2xCLGFBRFksSUFBSSxXQUFjLEVBQUUsUUFBQSxNQUFBLEVBQUEsVUFBQSxrQkFBQSxDQUFBOztBQUlsQyxXQUFNLElBQUEsTUFDSixFQUFBLE1BQU8sQ0FBQTtFQU9UO0FBR0EsTUFBTSxTQWtCTixPQUFNLFlBQVUsZUFDZCxPQUFBLFFBQUEsVUFBc0IsU0FBQTtNQUN0QixnQkFDQSxPQUFBLGNBQVcsZUFBQSxVQUFBLFlBQUE7TUFDWCxhQUFBLFVBQUEsZ0JBQTZCLGlCQUFBO01BQzdCLFVBQUE7SUFDQSxzQkFBbUI7SUFDbkIsc0JBQXFCLE1BQU8sS0FBQSxPQUFBLElBQUE7SUFDNUIsV0FBQTtJQUNBLDZCQUFPO0lBQ1IsbUJBQUE7SUFFRCxZQUFJLE9BQUE7SUFnQkoscUJBQXFCLE9BQXJCO0lBQ0UsYUFBQTtJQUNBLE9BQUE7O01BRUEsK0JBQUE7TUFDQSx3QkFBMkIsTUFBQUEsK0JBQUEsWUFBQTtJQUMzQjtJQUNBLGNBQWtDO0lBQ2xDO0lBQ0E7SUFFQSxtQkFBdUI7SUFFdkIsZUFBQTtJQUNBLGNBQUE7SUFDQSxlQUFBO0lBRUEsZ0JBRUUsQ0FBQTtJQUdBLGVBQU8sUUFBQSxJQUFBLEtBQUEsT0FBQTtJQUNQO0lBQ0E7SUFDQTtJQUNBLFlBQVMsS0FBQSxXQUFTLFVBQ1gsQ0FBQSxHQUFBO0FBRVAsWUFBSTtBQUdKLFdBQUssT0FBQTs7QUFHUCxXQUFBLFdBQVc7QUFDVCxVQUFBLEtBQU8sU0FBQSxZQUFBLE1BQUEsbUJBQUE7O0FBRVQsYUFBQSxlQUFrQixLQUFBLFNBQUE7QUFDaEIsV0FBTyxTQUFBOztJQUVULFdBQVcsYUFBVTtBQUNuQixhQUFPOztJQUVULFdBQVcsT0FBQTtBQUNULGFBQU87O0lBR1QsV0FBSSxVQUFhO0FBQ2YsYUFBTzs7SUFFVCxXQUFXLFNBQUE7QUFDVCxhQUFPOztJQUVULElBQUksYUFBVTtBQUNaLGFBQU9BLHVCQUFzQjs7SUFFL0IsSUFBSSxPQUFBO0FBQ0YsYUFBT0EsdUJBQXNCOztJQUcvQixJQUFJLFVBQUE7QUFDRixhQUFPQSx1QkFBb0I7O0lBRzdCLElBQUksU0FBQTtBQUNGLGFBQUtBLHVCQUFjO0lBQ25COzs7OztBQVFGLFdBQUksY0FBcUI7QUFDdkIsVUFBQSxLQUFPLElBQVMsTUFBSyxJQUFBLGFBQWU7Ozs7Ozs7Ozs7Ozs7O1FBbUJqQyxpQkFDd0I7Ozs7O0FBT3pCLGVBQUE7TUFDRixHQUFPLENBQUEsS0FBSyxLQUFNLE1BQUssS0FBSSxJQUFBLGlCQUFhOzs7Ozs7SUFRMUMsSUFBSSxhQUFtQjtBQUNyQixhQUFPLEtBQUssTUFBTSxLQUFLLElBQUksYUFBVzs7Ozs7OztJQVV0QyxJQUFBLFdBQVk7Ozs7OztJQVNaLElBQUEsYUFBWTs7O0lBTWQ7Ozs7OztJQU9BOzs7O0lBS0EsSUFBQSxrQkFBdUQ7Ozs7Ozs7Ozs7Ozs7O0lBaUJ2RCxZQUFvQjs7Ozs7SUFLaEIsU0FBSzs7Ozs7SUFLTCxNQUFBLE9BQUEsS0FBQSxRQUFBOztBQUVGLFdBQUssbUJBQWdCOzs7Ozs7QUFPdkIsVUFBQSxLQUFpQixJQUFlLGVBQWlCLEtBQUEsUUFBQTtBQUMvQyxhQUFLLE9BQUEsdUJBQW1CO0FBQ3hCO01BQ0E7QUFDQSxXQUFLLElBQUssTUFBTyxNQUFLLE1BQUk7Ozs7Ozs7OztBQVc1QixXQUFZLGNBQWU7QUFDekIsVUFBSSxDQUFBLEtBQUssT0FBTyxLQUFLLElBQUksZUFBZSxLQUFLLE9BQU0sTUFBQSxTQUFBO1dBQzVDO0FBQ0wsYUFBSyxZQUFjLE1BQUEsTUFBQTthQUNkLFNBQUE7TUFDTDtJQUVBOzs7Ozs7QUFPSixhQUFrQixPQUFpQixRQUFBLElBQUE7QUFDN0IsYUFBSyxJQUFBLEtBQVMsSUFBQTs7QUFLcEIsY0FBQSxFQUFBLHNCQUF3QixRQUFBLG9CQUFBLElBQ2hCLEtBQ0o7QUFJRSxZQUFBLEtBQVEsY0FBQSxTQUFBLHFCQUFBO0FBQ1IsZUFBSyxPQUFBLFdBQWlCLElBQUE7QUFDeEIsZUFDRSxjQUFBLEtBQUEsSUFDQTtRQUNGOztJQUlGO0lBQ0EsVUFBTyxNQUFBOztJQUdUO0lBQ0UsZ0JBQVc7QUFDVCxZQUFBO1FBQ0EsOEJBQUEsUUFBQTs7UUFHSix1QkFDRSxRQUFBO01BRUEsSUFBSyxLQUFBO0FBRUwsVUFDRSxRQUFPO0FBTVQsVUFBSSxLQUFPLGNBQUEsR0FBQTtBQUNULGdCQUNLLHVCQUVELGdDQUFpQyxLQUFBLGNBQWM7QUFLbkQsWUFBSSxRQUFVLHFCQUNMLFNBQUE7O0FBSVgsV0FBTSxPQUFNLGNBQUEsS0FBb0I7O0lBR2xDO0lBQ0UsUUFBSTtBQUdKLGFBQUksSUFBTyxRQUFBLENBQUEsWUFBZ0I7QUFDekIsbUJBQVksU0FBQSxLQUFhLGNBQUEsQ0FBQTtNQUN6QixDQUFBO0lBS0E7O0FBTUYsVUFBTSxDQUFBLGtCQUFvQixRQUFBLFFBQUEsUUFBQSxJQUFBO1VBRzVCLE9BQW1CLHNCQUFBLFlBQ2IsTUFBSyxRQUFBLGlCQUFzQjtBQUsvQixlQUNFLFFBQUEsUUFBYSxpQkFDYjtBQUdGLFVBQUksT0FBSyxzQkFBZSxZQUFZO0FBQ2xDLGNBQUssWUFBTyxrQkFBdUI7QUFDbkMsWUFBSyxDQUFBLFVBQUEsUUFBZSxRQUFBLFFBQUEsSUFBQTtBQUNwQixZQUFBLE9BQUEsY0FBQSxZQUFBLE1BQUEsUUFBQSxTQUFBOztBQUdGLFlBQUssVUFBQSxLQUFBLFFBQUE7TUFFTDtBQUNBLFlBQUssTUFBQSxtQkFBa0I7SUFFdkI7SUFTSSxZQUFTLGFBQWM7QUFDckIsVUFBQSxPQUFLLGdCQUFlLFNBQUEsUUFBQSxRQUFBLFFBQUEsV0FBQTtBQUNwQixVQUFBLE9BQUEsZ0JBQUEsWUFBQTs7QUFFRixZQUNHLE9BQUssUUFBUyxTQUNmLFFBQU8sUUFBQSxRQUFjLEdBQUE7QUFHckIsWUFBQSxJQUFRLEtBQU0sUUFBQTs7Ozs7Ozs7Ozs7OztBQWF0QixhQUFBLGVBQUE7QUFDUTs7QUFFRixXQUFNO0FBQ04sV0FBSyxPQUFPLFdBQVcsS0FBQSxXQUFBO0FBQUUsV0FBQSxpQkFBQTtBQUFLLFdBQUEsTUFBQSxFQUFZO1FBQUEsTUFDckMsUUFBTSxJQUFBO1VBRU4sS0FBSSxZQUFhLEtBQUssSUFBQTtVQUN0QixLQUFBLGtCQUFlLEtBQUEsY0FBQSxJQUFBO1FBQ2YsQ0FBQTtNQUVMLEVBTUQsS0FBTyxDQUFBLENBQUEsS0FBQSxTQUFRLE1BQUE7QUFDVCxZQUFBLEtBQUEsY0FBZTtBQUNmLGVBQUEsZUFBaUI7QUFDdEI7O0FBR04sWUFDTyxDQUFBLEtBQU8sU0FBQSxhQUNQLE9BQUEsY0FBd0IsOENBRy9CO0FBQ08sa0JBQUEsTUFBZ0I7Ozs7Ozs7Ozs7Ozs7Q0F3QnJCO0FBQ1EseUNBQW9CO1FBRTVCO0FBQ0ssY0FBQSxLQUFBLEtBQWlCLFNBQUEsYUFBc0I7QUFFNUMsYUFBTyxPQUFVLFdBQUE7VUFFWjtVQUdBO1FBQ0UsQ0FBQTtBQUNMLGFBQUEsTUFBQSxZQUFBLElBQUEsR0FBQSxLQUFBLFNBQUEsSUFBQSxJQUFBLEdBQUEsR0FBQTtBQUNHLGFBQUEsSUFBQSxhQUFrQixLQUFBO0FBRW5CLGFBQUssZUFDRjtBQUVGLGFBQUEsY0FBYzs7VUFHckIsTUFBQSxLQUEwQixlQUF3QjtVQUMzQztRQUVEO01BR0osQ0FBSztBQUdQLGFBQUEsZUFBOEM7QUFDdkMsYUFBQSxhQUFPLElBQWUsT0FBTSxXQUFRLE1BQUEsSUFBQSxPQUFBLEdBQUEsSUFBQSxDQUFBO01BQ3pDLENBQUs7SUFLTDtJQUdBLGlCQUFZO0FBQ1osV0FBSyxPQUFBLGVBQWM7QUFFbkIsV0FBSyxhQUFVLElBQUEsT0FBQSxXQUFBLE1BQUEsU0FBQSxHQUFBLElBQUEsQ0FBQTs7SUFHakIsWUFBQSxPQUF3QixLQUFBLFFBQXNCO0FBQzVDLFdBQUssZUFBTztBQUNaLFVBQUssQ0FBQSxLQUFBLElBQUE7QUFFTCxXQUFJLGlCQUFLO0FBSVQsVUFBSTtBQUdKLGlEQUdGLEtBQUEsSUFBQSxlQUEyQixLQUFBO0FBSXBCLGVBQUEsSUFBTyxNQUFBLE1BQUEsTUFBa0I7QUFDOUIsYUFBUyxhQUFBLElBQUEsT0FBb0IsV0FBYSxNQUFBLFFBQVksSUFBQSxDQUFBO01BQ3RELFNBQVMsUUFBQTtNQUFBO0lBQ1Q7SUFFQSxjQUFTOztBQUdYLFdBQUEsY0FBd0I7SUFDdEI7SUFHQSxjQUFZLENBQUEsVUFBQTtBQUNaLFdBQUssT0FBSSxZQUFpQjtBQUMxQixZQUFLLEVBQUksWUFBQSxRQUFpQixVQUFjLElBQUEsS0FBQTtBQUN4QyxtQkFBUyxLQUFBLGVBQWlCO0FBRTFCLFdBQUssaUJBQUksV0FBMEIsTUFBSyxLQUFBLFlBQWEsR0FBQSxTQUFBOztBQUd2RCxXQUFBLElBQUEsYUFBeUIsS0FBQTtBQUN2QixXQUFBLGNBQWtCLFFBQUEsQ0FBQSxZQUFnQjtBQUNsQyxhQUFBLEtBQWEsS0FBSyxPQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FDem5CdEIsTUFBTSxnQkFBQSxDQUNKLGlCQStCRixhQUFTLENBQUEsTUFBQSxRQUF1QixhQUFBLENBQUEsTUFBQTtBQUU5QixXQUFJLGVBQ0Y7QUFFRixRQUFJLFFBQVMsV0FBSyxRQUFBLE9BQUEsV0FBQTtBQUNsQixRQUFJLElBQU0sS0FBQSxJQUFBO0FBRVYsUUFBQSxLQUFPLGFBQUEsT0FBQSxZQUFBLElBQXVDLElBQUEsT0FBUTtBQUNwRCxXQUFJLHVDQUFvQixRQUFBLFNBQUEsU0FBQSxHQUFBO0FBQ3hCLFVBQUksSUFBSSxLQUFHLE9BQUEsSUFBQTtBQUVULFVBQU0sSUFBSSxHQUFBO0FBQ1YsYUFBUyxJQUFBLEtBQU0sS0FBTztZQUNqQixLQUFBLE1BQUEsSUFBQSxFQUFBO01BRUwsT0FBTTtBQUNOLGFBQUssS0FBSyxLQUFNLEtBQVE7O01BRTFCO0FBQ0EsY0FBQSxNQUFBLE1BQUEsSUFBQSxJQUFBLElBQUEsR0FBQSxTQUFBLEVBQUE7O0VBR0o7V0FNSSxhQUFNLG9CQUVOLGlCQUFVLGdCQUdWLENBQUEsR0FBQTtBQU1GLFVBQUk7TUFFSixNQUFTO01BSVQsTUFBSTtNQUlKLFVBQWE7TUFDYjtNQUNBO01BZUE7TUFFQTtNQU9BO0lBS0EsSUFBQTtBQUNFLFFBQUEsT0FBQSxRQUFBLFFBQUEsNkJBQUEsRUFBQTtBQUNBLFFBQUEsS0FBQSxTQUFBLEdBQUEsRUFBQSxRQUFBLEtBQUEsTUFBQSxHQUFBLEVBQUE7QUFDQSxRQUFBLFNBQUEsV0FBQSxHQUFBO0FBQ0EsWUFBQSxJQUFBLE1BQUEsa0NBQUE7QUFDQSxVQUFBLE9BQUEsU0FBQTtBQUNBLFVBQUEsT0FBVSxVQUFBLElBQUEsT0FBQSxLQUFBO0FBQ1YsVUFBQSxXQUNELGlEQVNrQixLQUFBLFdBQXJCLFlBQXlDLEtBQ3ZDLEtBQUEsV0FBQSxVQUFBLEtBQ0EsS0FBQSxXQUFBLEtBQUEsS0FDQSxLQUFBLFdBQUEsTUFBQSxLQUNBLEtBQUEsTUFBQSxHQUFBLEVBQUEsQ0FBQSxLQUFBLFFBQ0EsS0FBQSxNQUFBLEdBQUEsRUFBQSxDQUFBLEtBQUEsUUFDQSxLQUFBLFdBQUEsa0JBQUEsSUFDQSxrQkFFQSxHQUFBLGVBQVk7QUFDVixVQUFNLFVBQUEsR0FBWSxRQUFBLE1BQWEsSUFBQSxJQUFBLFlBQW1CLEdBQUEsVUFBQSxTQUFBLElBQUEsSUFBQSxJQUFBLElBQUEsRUFBQSxHQUFBLElBQUE7QUFFbEQsVUFBTSxVQUFVLENBQUFDLFNBQUEsQ0FBQSxNQUhHLEdBQUEsT0FBQSxJQUFBLElBQUEsZ0JBQUEsQ0FBQSxHQUFBLE9BQUEsUUFBQSxhQUFBLEdBQUEsR0FBQSxPQUFBLFFBQUFBLE1BQUEsRUFBQSxPQUFBLGFBQUEsQ0FBQSxDQUFBLENBQUE7QUFLbkIsVUFBSyxjQUVMLE9BQUssVUFBQSxhQUNFLFlBQU8sUUFBQSxNQUFBLE1BQUEsQ0FBQSxJQUNaLFFBQVUsS0FDUjs7TUFJSjtNQUNFO01BS0E7OztNQVFKLFVBQUE7TUFDRTs7O01BR0UsY0FBTSxjQUFtQixzQkFBYTs7Ozs7SUFNeEM7SUFDQTtJQUNBO0lBRUEsWUFBSyxvQkFBMEI7O0FBR2pDLFlBQUEsVUFBd0IsYUFBNEMsVUFBQSxXQUFBLFVBQUEsYUFBQTtBQUNsRSxXQUFNLHFCQUFxQjtBQUUzQixXQUFLLGdCQUFNLFNBQUE7QUFDWCxVQUFLLENBQUEsbUJBQVMsZUFBQSxDQUFBLEtBQUEsUUFBQSxDQUFBLEtBQUEsVUFBQTtBQUNkLGFBQUssTUFBTztBQUNaLGNBQUssSUFBTztVQUNQO1FBQ0w7TUFDQTs7QUFHRixZQUFBLG1CQUdRLE9BQUEsU0FBQSxHQUFBO0FBQ0Qsa0JBQUs7WUFLTCw0QkFDSCxtQkFDRSxLQUFBO1VBR0U7O0FBR0osa0JBQUs7WUFDQSwyQkFBSyxtQkFBQSxJQUFBOzs7Ozs7UUFPVixHQUFBLEtBQUE7UUFDRixHQUFPOztRQUlULE1BQUEsbUJBRUUsUUFDbUIsS0FBQTtRQUNuQixNQUFNLG1CQUFxQixRQUFTLEtBQUE7UUFDcEMsVUFDRSxtQkFBYSxZQUFnQixLQUFBO01BSS9CLENBQUE7OztBQVFKLFdBQVMsV0FBQSxVQUFhO0FBQ3BCLFdBQ0UsZ0JBQ00sU0FDQTtJQVNSO0lBQ0EsZ0JBQWMsV0FBYTtBQUUzQixZQUFPLEVBQUEsS0FBQSxRQUFBLE1BQUEsTUFBQSxNQUFBLE1BQUEsU0FBQSxJQUFBO0FBQ0EsV0FBQSxNQUFBO0FBQ0wsV0FBQSxTQUFjO0FBQ2QsV0FBTSxPQUFNO0FBQ1osV0FBTSxPQUFNO0FBQ1osV0FBTSxPQUFNO0FBQ1osV0FBTSxPQUFNO0FBQ1osV0FBQSxXQUFVO0lBQ0M7SUFDSSxVQUFBLE1BQUEsUUFBQTtBQUNmLFVBQUEsQ0FBQSxLQUFBO0FBQ0QsY0FBQSxJQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUN4T0gsTUFBTSx5QkFBeUI7QUFFL0IsTUFBTSxlQUFOLE1BQU0sY0FBYTtBQUFBLElBQ1QsWUFBWSxvQkFBSSxJQUF3QjtBQUFBLElBQ3hDLGtCQUFvQyxDQUFDO0FBQUEsSUFDckMsU0FBNkI7QUFBQSxJQUM3QixPQUFvQjtBQUFBLElBQ3BCLGNBQTZCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUs3QixTQUFpQjtBQUFBLElBRXpCLEtBQUssTUFBeUI7QUFDNUIsVUFBSSxLQUFLLFNBQVM7QUFDaEIsZ0JBQVEsS0FBSyxpRUFBNEQ7QUFDekU7QUFBQSxNQUNGO0FBQ0EsVUFBSSxLQUFLLFFBQVE7QUFDZixnQkFBUSxLQUFLLCtDQUErQztBQUM1RDtBQUFBLE1BQ0Y7QUFDQSxXQUFLLE9BQU8sS0FBSztBQUlqQixVQUFJLEtBQUssU0FBUyxhQUFhO0FBQzdCLFlBQUk7QUFDRixnQkFBTSxTQUFTLGVBQWUsUUFBUSxzQkFBc0I7QUFDNUQsY0FBSSxPQUFRLE1BQUssY0FBYztBQUFBLFFBQ2pDLFFBQVE7QUFBQSxRQUVSO0FBQUEsTUFDRjtBQUVBLFlBQU0sUUFBZ0MsRUFBRSxNQUFNLEtBQUssS0FBSztBQUN4RCxVQUFJLEtBQUssS0FBTSxPQUFNLE9BQU8sS0FBSztBQUNqQyxVQUFJLEtBQUssS0FBTSxPQUFNLE9BQU8sS0FBSztBQUNqQyxVQUFJLEtBQUssU0FBVSxPQUFNLFdBQVcsS0FBSztBQUN6QyxVQUFJLEtBQUssU0FBUyxlQUFlLEtBQUssYUFBYTtBQUNqRCxjQUFNLGNBQWMsS0FBSztBQUFBLE1BQzNCO0FBRUEsV0FBSyxTQUFTLElBQUksWUFBWTtBQUFBLFFBQzVCLE1BQU0sS0FBSyxRQUFRLE9BQU8sU0FBUztBQUFBLFFBQ25DLE9BQU8sS0FBSyxTQUFTO0FBQUEsUUFDckIsTUFBTSxLQUFLO0FBQUEsUUFDWDtBQUFBLE1BQ0YsQ0FBQztBQUVELFdBQUssVUFBVSxZQUFZO0FBRTNCLFdBQUssT0FBTyxpQkFBaUIsUUFBUSxNQUFNLEtBQUssVUFBVSxXQUFXLENBQUM7QUFDdEUsV0FBSyxPQUFPLGlCQUFpQixTQUFTLE1BQU0sS0FBSyxVQUFVLGNBQWMsQ0FBQztBQUMxRSxXQUFLLE9BQU8saUJBQWlCLFNBQVMsTUFBTSxLQUFLLFVBQVUsY0FBYyxDQUFDO0FBRTFFLFdBQUssT0FBTyxpQkFBaUIsV0FBVyxDQUFDLE1BQW9CO0FBQzNELFlBQUk7QUFDSixZQUFJO0FBQ0YsZ0JBQU0sS0FBSyxNQUFNLE9BQU8sRUFBRSxTQUFTLFdBQVcsRUFBRSxPQUFPLEVBQUU7QUFBQSxRQUMzRCxRQUFRO0FBQ047QUFBQSxRQUNGO0FBQ0EsWUFBSSxDQUFDLE9BQU8sT0FBTyxJQUFJLFNBQVMsU0FBVTtBQUcxQyxhQUFLLGFBQWEsS0FBSyxJQUFJO0FBQzNCLFlBQUksSUFBSSxTQUFTLFlBQVk7QUFFM0IsZUFBSyxlQUFlO0FBQ3BCO0FBQUEsUUFDRjtBQUdBLFlBQUksSUFBSSxTQUFTLGVBQWU7QUFDOUIsZ0JBQU0sS0FBSyxJQUFJO0FBQ2YsY0FBSSxJQUFJLGVBQWUsS0FBSyxTQUFTLGFBQWE7QUFDaEQsaUJBQUssY0FBYyxHQUFHO0FBQ3RCLGdCQUFJO0FBQ0YsNkJBQWUsUUFBUSx3QkFBd0IsR0FBRyxXQUFXO0FBQUEsWUFDL0QsUUFBUTtBQUFBLFlBRVI7QUFBQSxVQUNGO0FBQUEsUUFDRixXQUFXLElBQUksU0FBUyxhQUFhO0FBR25DLGtCQUFRLEtBQUssMEJBQTBCLElBQUksT0FBTztBQUFBLFFBQ3BELFdBQVcsSUFBSSxTQUFTLGNBQWM7QUFLcEMsZUFBSyxVQUFVO0FBQ2YsY0FBSTtBQUFFLGlCQUFLLFFBQVEsTUFBTTtBQUFBLFVBQUcsUUFBUTtBQUFBLFVBQWU7QUFDbkQsZUFBSyxTQUFTO0FBQ2QsZUFBSyxlQUFlO0FBQUEsUUFDdEI7QUFFQSxhQUFLLFVBQVUsSUFBSSxNQUFNLElBQUksT0FBTztBQUFBLE1BQ3RDLENBQUM7QUFFRCxXQUFLLGdCQUFnQjtBQUFBLElBQ3ZCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFpQlEsYUFBYTtBQUFBLElBQ2IsZUFBZTtBQUFBLElBQ2Ysa0JBQXlEO0FBQUEsSUFFakUsT0FBd0IsZUFBZTtBQUFBLElBQ3ZDLE9BQXdCLHFCQUFxQjtBQUFBLElBRXJDLGtCQUF3QjtBQUM5QixXQUFLLGFBQWEsS0FBSyxJQUFJO0FBQzNCLFVBQUksS0FBSyxnQkFBaUIsZUFBYyxLQUFLLGVBQWU7QUFDNUQsV0FBSyxrQkFBa0IsWUFBWSxNQUFNLEtBQUssZUFBZSxHQUFHLEdBQUs7QUFFckUsYUFBTyxpQkFBaUIsVUFBVSxNQUFNLEtBQUssZUFBZSxDQUFDO0FBQzdELGVBQVMsaUJBQWlCLG9CQUFvQixNQUFNO0FBQ2xELFlBQUksU0FBUyxvQkFBb0IsVUFBVyxNQUFLLGVBQWU7QUFBQSxNQUNsRSxDQUFDO0FBQUEsSUFDSDtBQUFBLElBRVEsaUJBQXVCO0FBQzdCLFVBQUksS0FBSyxpQkFBaUI7QUFDeEIsc0JBQWMsS0FBSyxlQUFlO0FBQ2xDLGFBQUssa0JBQWtCO0FBQUEsTUFDekI7QUFBQSxJQUNGO0FBQUEsSUFFUSxpQkFBdUI7QUFDN0IsVUFBSSxLQUFLLFdBQVcsQ0FBQyxLQUFLLE9BQVE7QUFDbEMsWUFBTSxPQUFPLEtBQUssSUFBSSxJQUFJLEtBQUs7QUFDL0IsVUFBSSxLQUFLLGdCQUFnQixPQUFPLGNBQWEsb0JBQW9CO0FBQy9ELGdCQUFRO0FBQUEsVUFDTix1QkFBdUIsS0FBSyxNQUFNLE9BQU8sR0FBSSxDQUFDO0FBQUEsUUFDaEQ7QUFDQSxhQUFLLGFBQWEsS0FBSyxJQUFJO0FBQzNCLGFBQUssVUFBVSxZQUFZO0FBQzNCLFlBQUk7QUFBRSxlQUFLLE9BQU8sVUFBVTtBQUFBLFFBQUcsUUFBUTtBQUFBLFFBQWU7QUFBQSxNQUN4RCxXQUFXLE9BQU8sY0FBYSxjQUFjO0FBRTNDLFlBQUk7QUFBRSxlQUFLLEtBQUssUUFBUSxFQUFFLE1BQU0sS0FBSyxNQUFNLFdBQVcsS0FBSyxDQUFDO0FBQUEsUUFBRyxRQUFRO0FBQUEsUUFBZTtBQUFBLE1BQ3hGO0FBQUEsSUFDRjtBQUFBO0FBQUEsSUFHUSxVQUFVO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBT2xCLGFBQW1CO0FBQ2pCLFdBQUssVUFBVTtBQUNmLFVBQUk7QUFBRSxhQUFLLFFBQVEsTUFBTTtBQUFBLE1BQUcsUUFBUTtBQUFBLE1BQXdCO0FBQzVELFdBQUssU0FBUztBQUNkLFdBQUssZUFBZTtBQUNwQixXQUFLLFVBQVUsY0FBYztBQUFBLElBQy9CO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBYUEsT0FBd0IsZUFBZSxvQkFBSSxJQUFZO0FBQUEsTUFDckQ7QUFBQSxNQUFjO0FBQUEsTUFBZ0I7QUFBQSxNQUFnQjtBQUFBLE1BQWM7QUFBQSxNQUFlO0FBQUEsTUFDM0U7QUFBQSxNQUFrQjtBQUFBLE1BQW9CO0FBQUEsTUFBb0I7QUFBQSxNQUMxRDtBQUFBLE1BQWlCO0FBQUEsTUFBaUI7QUFBQSxNQUFpQjtBQUFBLE1BQ25EO0FBQUEsTUFBaUI7QUFBQSxNQUFnQjtBQUFBLE1BQXdCO0FBQUEsTUFDekQ7QUFBQSxNQUFxQjtBQUFBLE1BQWlCO0FBQUEsTUFDdEM7QUFBQSxNQUF5QjtBQUFBLE1BQWdCO0FBQUEsTUFBYTtBQUFBLE1BQ3REO0FBQUEsTUFBbUI7QUFBQSxNQUFlO0FBQUEsTUFBZTtBQUFBLE1BQ2pEO0FBQUEsTUFBeUI7QUFBQSxNQUFvQjtBQUFBLE1BQWdCO0FBQUEsTUFDN0Q7QUFBQSxJQUNGLENBQUM7QUFBQTtBQUFBLElBR08sdUJBQW1ELENBQUM7QUFBQSxJQUU1RCxjQUFjLElBQWtDO0FBQzlDLFdBQUsscUJBQXFCLEtBQUssRUFBRTtBQUFBLElBQ25DO0FBQUEsSUFFUSxrQkFBa0IsTUFBb0I7QUFDNUMsaUJBQVcsTUFBTSxLQUFLLHNCQUFzQjtBQUMxQyxZQUFJO0FBQUUsYUFBRyxJQUFJO0FBQUEsUUFBRyxTQUFTLEtBQUs7QUFBRSxrQkFBUSxNQUFNLHdDQUF3QyxHQUFHO0FBQUEsUUFBRztBQUFBLE1BQzlGO0FBQUEsSUFDRjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFNQSxLQUFLLE1BQWMsU0FBNEI7QUFDN0MsWUFBTSxTQUFTLEtBQUs7QUFHcEIsWUFBTSxTQUFTLENBQUMsQ0FBQyxVQUFVLE9BQU8sZUFBZTtBQUNqRCxVQUFJLENBQUMsUUFBUTtBQUNYLFlBQUksY0FBYSxhQUFhLElBQUksSUFBSSxHQUFHO0FBQ3ZDLGtCQUFRLEtBQUssa0JBQWtCLElBQUksZ0ZBQThCLFNBQVMsT0FBTyxhQUFhLFdBQVcsR0FBRztBQUM1RyxlQUFLLGtCQUFrQixJQUFJO0FBQUEsUUFDN0I7QUFFQSxlQUFPO0FBQUEsTUFDVDtBQUNBLFlBQU0sTUFBK0IsRUFBRSxNQUFNLFFBQVE7QUFLckQsVUFBSSxLQUFLLFNBQVMsZUFBZSxLQUFLLGFBQWE7QUFDakQsWUFBSSxjQUFjLEtBQUs7QUFBQSxNQUN6QjtBQUNBLFVBQUk7QUFDRixlQUFPLEtBQUssS0FBSyxVQUFVLEdBQUcsQ0FBQztBQUMvQixlQUFPO0FBQUEsTUFDVCxTQUFTLEtBQUs7QUFDWixnQkFBUSxLQUFLLGtCQUFrQixJQUFJLHlCQUFlLEdBQUc7QUFDckQsWUFBSSxjQUFhLGFBQWEsSUFBSSxJQUFJLEVBQUcsTUFBSyxrQkFBa0IsSUFBSTtBQUNwRSxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxJQUVBLEdBQUcsTUFBYyxJQUFvQjtBQUNuQyxVQUFJLE1BQU0sS0FBSyxVQUFVLElBQUksSUFBSTtBQUNqQyxVQUFJLENBQUMsS0FBSztBQUNSLGNBQU0sQ0FBQztBQUNQLGFBQUssVUFBVSxJQUFJLE1BQU0sR0FBRztBQUFBLE1BQzlCO0FBQ0EsVUFBSSxLQUFLLEVBQUU7QUFBQSxJQUNiO0FBQUEsSUFFQSxTQUFTLElBQTBCO0FBQ2pDLFdBQUssZ0JBQWdCLEtBQUssRUFBRTtBQUc1QixVQUFJO0FBQ0YsV0FBRyxLQUFLLE1BQU07QUFBQSxNQUNoQixTQUFTLEtBQUs7QUFDWixnQkFBUSxNQUFNLG1DQUFtQyxHQUFHO0FBQUEsTUFDdEQ7QUFBQSxJQUNGO0FBQUEsSUFFQSxZQUFvQjtBQUNsQixhQUFPLEtBQUs7QUFBQSxJQUNkO0FBQUEsSUFFQSxpQkFBZ0M7QUFDOUIsYUFBTyxLQUFLO0FBQUEsSUFDZDtBQUFBO0FBQUE7QUFBQSxJQUlBLG9CQUEwQjtBQUN4QixXQUFLLGNBQWM7QUFDbkIsVUFBSTtBQUNGLHVCQUFlLFdBQVcsc0JBQXNCO0FBQUEsTUFDbEQsUUFBUTtBQUFBLE1BRVI7QUFBQSxJQUNGO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFNUSxVQUFVLE1BQWMsU0FBd0I7QUFDdEQsWUFBTSxNQUFNLEtBQUssVUFBVSxJQUFJLElBQUk7QUFDbkMsVUFBSSxDQUFDLElBQUs7QUFDVixpQkFBVyxNQUFNLEtBQUs7QUFDcEIsWUFBSTtBQUNGLGFBQUcsT0FBTztBQUFBLFFBQ1osU0FBUyxLQUFLO0FBQ1osa0JBQVEsTUFBTSxxQkFBcUIsSUFBSSxZQUFZLEdBQUc7QUFBQSxRQUN4RDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsSUFFUSxVQUFVLEdBQWlCO0FBQ2pDLFVBQUksS0FBSyxXQUFXLEVBQUc7QUFDdkIsV0FBSyxTQUFTO0FBQ2QsaUJBQVcsTUFBTSxLQUFLLGlCQUFpQjtBQUNyQyxZQUFJO0FBQ0YsYUFBRyxDQUFDO0FBQUEsUUFDTixTQUFTLEtBQUs7QUFDWixrQkFBUSxNQUFNLG1DQUFtQyxHQUFHO0FBQUEsUUFDdEQ7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxNQUFNLFdBQVcsSUFBSSxhQUFhO0FBQ2xDLEVBQUMsT0FBaUQsV0FBVzs7O0FDM1Y3RCxNQUFNLG1CQUFpQyxDQUFDLFFBQVEsVUFBVSxRQUFRLFFBQVEsV0FBVztBQUVyRixNQUFNLG9CQUFnRDtBQUFBLElBQ3BELEdBQUc7QUFBQSxJQUNILEdBQUc7QUFBQSxJQUNILEdBQUc7QUFBQSxJQUNILEdBQUc7QUFBQSxJQUNILEdBQUc7QUFBQSxFQUNMO0FBRUEsTUFBTSxpQkFBaUIsQ0FBQyxnQkFBZ0IsbUJBQW1CLFNBQVMsZUFBZSxXQUFXO0FBZ0M5RixXQUFTLFVBQVUsTUFBa0IsUUFBaUIsVUFBa0M7QUFDdEYsUUFBSSxTQUFTLGFBQWE7QUFFeEIsWUFBTUMsUUFBTztBQUNiLFlBQU0sTUFBTSxNQUFNLFFBQVFBLE1BQUssU0FBUyxJQUFJQSxNQUFLLFlBQVksQ0FBQztBQUM5RCxZQUFNQyxVQUFpQyxDQUFDO0FBQ3hDLGlCQUFXLEtBQUssS0FBSztBQUNuQixjQUFNLElBQUksRUFBRSxRQUFRO0FBQ3BCLFFBQUFBLFFBQU8sQ0FBQyxLQUFLQSxRQUFPLENBQUMsS0FBSyxLQUFLO0FBQUEsTUFDakM7QUFDQSxhQUFPO0FBQUEsUUFDTCxXQUFXO0FBQUEsUUFDWCxPQUFPLElBQUk7QUFBQSxRQUNYLFFBQUFBO0FBQUEsUUFDQSxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsUUFDbkM7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUVBLFVBQU0sT0FBTztBQUNiLFFBQUksT0FBdUM7QUFDM0MsVUFBTSxTQUFVLEtBQUssWUFBb0QsSUFBSTtBQUM3RSxRQUFJLFVBQVUsT0FBTyxXQUFXLFNBQVUsUUFBTztBQUFBLGFBQ3hDLEtBQUssSUFBSSxLQUFLLE9BQU8sS0FBSyxJQUFJLE1BQU0sU0FBVSxRQUFPLEtBQUssSUFBSTtBQUFBLGFBQzlELEtBQUssYUFBYSxPQUFPLEtBQUssY0FBYyxZQUFZLENBQUMsTUFBTSxRQUFRLEtBQUssU0FBUyxHQUFHO0FBQy9GLGFBQU8sS0FBSztBQUFBLElBQ2Q7QUFDQSxRQUFJLENBQUMsTUFBTTtBQUNULFlBQU0sSUFBSSxNQUFNLDZCQUE2QixJQUFJLG1CQUFtQjtBQUFBLElBQ3RFO0FBQ0EsVUFBTSxPQUFzQixDQUFDO0FBQzdCLFVBQU0sU0FBaUMsQ0FBQztBQUN4QyxlQUFXLEtBQUssZ0JBQWdCO0FBQzlCLFlBQU0sTUFBTSxLQUFLLENBQUM7QUFDbEIsVUFBSSxDQUFDLE1BQU0sUUFBUSxHQUFHLEVBQUc7QUFDekIsaUJBQVcsT0FBTyxLQUFzQjtBQUN0QyxhQUFLLEtBQUssRUFBRSxHQUFHLEtBQUssTUFBTSxFQUFFLENBQUM7QUFBQSxNQUMvQjtBQUNBLGFBQU8sQ0FBQyxJQUFJLElBQUk7QUFBQSxJQUNsQjtBQUNBLFFBQUksS0FBSyxXQUFXLEdBQUc7QUFDckIsWUFBTSxJQUFJLE1BQU0sOENBQThDLElBQUksRUFBRTtBQUFBLElBQ3RFO0FBQ0EsV0FBTztBQUFBLE1BQ0wsV0FBVztBQUFBLE1BQ1gsT0FBTyxLQUFLO0FBQUEsTUFDWjtBQUFBLE1BQ0EsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ25DO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxpQkFBZSxRQUFRLE1BQWtCLFNBQTBDO0FBQ2pGLFVBQU0sV0FBVyx1QkFBdUIsSUFBSTtBQUM1QyxVQUFNLE1BQU0sR0FBRyxPQUFPLEdBQUcsUUFBUTtBQUNqQyxVQUFNLE1BQU0sTUFBTSxNQUFNLEtBQUssRUFBRSxPQUFPLFdBQVcsQ0FBQztBQUNsRCxRQUFJLENBQUMsSUFBSSxJQUFJO0FBQ1gsWUFBTSxJQUFJLE1BQU0sUUFBUSxJQUFJLE1BQU0sYUFBYSxHQUFHLEVBQUU7QUFBQSxJQUN0RDtBQUNBLFFBQUk7QUFDSixRQUFJO0FBQ0YsZUFBUyxNQUFNLElBQUksS0FBSztBQUFBLElBQzFCLFNBQVMsR0FBRztBQUNWLFlBQU0sSUFBSSxNQUFNLHlCQUF5QixRQUFRLEtBQU0sRUFBWSxPQUFPLEVBQUU7QUFBQSxJQUM5RTtBQUNBLFdBQU8sVUFBVSxNQUFNLFFBQVEsUUFBUTtBQUFBLEVBQ3pDO0FBRUEsaUJBQWUsU0FBUyxPQUF3QixDQUFDLEdBQTRCO0FBQzNFLFVBQU0sVUFBVSxLQUFLLFdBQVc7QUFDaEMsVUFBTSxRQUFxRCxDQUFDO0FBQzVELFVBQU0sU0FBbUMsQ0FBQztBQUMxQyxRQUFJLFNBQVM7QUFFYixVQUFNLFFBQVE7QUFBQSxNQUNaLGlCQUFpQixJQUFJLE9BQU8sU0FBUztBQUNuQyxZQUFJO0FBQ0YsZ0JBQU0sT0FBTyxNQUFNLFFBQVEsTUFBTSxPQUFPO0FBQ3hDLGdCQUFNLElBQUksSUFBSTtBQUFBLFFBQ2hCLFNBQVMsR0FBRztBQUNWLGdCQUFNLE1BQU0sYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFDckQsaUJBQU8sS0FBSyxFQUFFLFlBQVksTUFBTSxTQUFTLElBQUksQ0FBQztBQUM5QyxlQUFLLFVBQVUsTUFBTSxHQUFHO0FBQUEsUUFDMUIsVUFBRTtBQUNBLG9CQUFVO0FBQ1YsZUFBSyxhQUFhLFFBQVEsaUJBQWlCLFFBQVEsSUFBSTtBQUFBLFFBQ3pEO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUNBLFdBQU87QUFBQSxNQUNMLElBQUksT0FBTyxXQUFXO0FBQUEsTUFDdEI7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFNQSxXQUFTLGdCQUFnQixJQUErQjtBQUN0RCxVQUFNLFNBQVMsS0FBSyxDQUFDLEdBQUcsY0FBYztBQUN0QyxXQUFPLFNBQVUsa0JBQWtCLE1BQU0sS0FBSyxPQUFRO0FBQUEsRUFDeEQ7QUFFQSxNQUFNLGdCQUFnQjtBQUFBLElBQ3BCO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFFQSxFQUFDLE9BQThELGdCQUFnQjsiLAogICJuYW1lcyI6IFsiUmVjb25uZWN0aW5nV2ViU29ja2V0IiwgInF1ZXJ5IiwgInJvb3QiLCAiYnlUeXBlIl0KfQo=
