"use strict";
(() => {
  // node_modules/partysocket/dist/ws.js
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

  // node_modules/partysocket/dist/index.js
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
    emit(type, payload) {
      if (!this.socket) {
        console.warn(`PartyBus.emit('${type}') called before init() \u2014 dropped`);
        return;
      }
      const env = { type, payload };
      if (this.role === "assistant" && this.controlCode) {
        env.controlCode = this.controlCode;
      }
      this.socket.send(JSON.stringify(env));
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vbm9kZV9tb2R1bGVzL3BhcnR5c29ja2V0L3NyYy93cy50cyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcGFydHlzb2NrZXQvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2NsaWVudC9wYXJ0eWJ1cy50cyIsICIuLi8uLi9jbGllbnQvYmFua2xvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gVE9ETzogbG9zZSB0aGlzIGVzbGludC1kaXNhYmxlXG5cbi8qIVxuICogUmVjb25uZWN0aW5nIFdlYlNvY2tldFxuICogYnkgUGVkcm8gTGFkYXJpYSA8cGVkcm8ubGFkYXJpYUBnbWFpbC5jb20+XG4gKiBodHRwczovL2dpdGh1Yi5jb20vcGxhZGFyaWEvcmVjb25uZWN0aW5nLXdlYnNvY2tldFxuICogTGljZW5zZSBNSVRcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFR5cGVkRXZlbnRUYXJnZXQgfSBmcm9tIFwiLi90eXBlLWhlbHBlclwiO1xuXG5pZiAoIWdsb2JhbFRoaXMuRXZlbnRUYXJnZXQgfHwgIWdsb2JhbFRoaXMuRXZlbnQpIHtcbiAgY29uc29sZS5lcnJvcihgXG4gIFBhcnR5U29ja2V0IHJlcXVpcmVzIGEgZ2xvYmFsICdFdmVudFRhcmdldCcgY2xhc3MgdG8gYmUgYXZhaWxhYmxlIVxuICBZb3UgY2FuIHBvbHlmaWxsIHRoaXMgZ2xvYmFsIGJ5IGFkZGluZyB0aGlzIHRvIHlvdXIgY29kZSBiZWZvcmUgYW55IHBhcnR5c29ja2V0IGltcG9ydHM6IFxuICBcbiAgXFxgXFxgXFxgXG4gIGltcG9ydCAncGFydHlzb2NrZXQvZXZlbnQtdGFyZ2V0LXBvbHlmaWxsJztcbiAgXFxgXFxgXFxgXG4gIFBsZWFzZSBmaWxlIGFuIGlzc3VlIGF0IGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJ0eWtpdC9wYXJ0eWtpdCBpZiB5b3UncmUgc3RpbGwgaGF2aW5nIHRyb3VibGUuXG5gKTtcbn1cblxuZXhwb3J0IGNsYXNzIEVycm9yRXZlbnQgZXh0ZW5kcyBFdmVudCB7XG4gIHB1YmxpYyBtZXNzYWdlOiBzdHJpbmc7XG4gIHB1YmxpYyBlcnJvcjogRXJyb3I7XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgY29uc3RydWN0b3IoZXJyb3I6IEVycm9yLCB0YXJnZXQ6IGFueSkge1xuICAgIHN1cGVyKFwiZXJyb3JcIiwgdGFyZ2V0KTtcbiAgICB0aGlzLm1lc3NhZ2UgPSBlcnJvci5tZXNzYWdlO1xuICAgIHRoaXMuZXJyb3IgPSBlcnJvcjtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgQ2xvc2VFdmVudCBleHRlbmRzIEV2ZW50IHtcbiAgcHVibGljIGNvZGU6IG51bWJlcjtcbiAgcHVibGljIHJlYXNvbjogc3RyaW5nO1xuICBwdWJsaWMgd2FzQ2xlYW4gPSB0cnVlO1xuICAvLyBveGxpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tZXhwbGljaXQtYW55XG4gIGNvbnN0cnVjdG9yKGNvZGUgPSAxMDAwLCByZWFzb24gPSBcIlwiLCB0YXJnZXQ6IGFueSkge1xuICAgIHN1cGVyKFwiY2xvc2VcIiwgdGFyZ2V0KTtcbiAgICB0aGlzLmNvZGUgPSBjb2RlO1xuICAgIHRoaXMucmVhc29uID0gcmVhc29uO1xuICB9XG59XG5leHBvcnQgaW50ZXJmYWNlIFdlYlNvY2tldEV2ZW50TWFwIHtcbiAgY2xvc2U6IENsb3NlRXZlbnQ7XG4gIGVycm9yOiBFcnJvckV2ZW50O1xuICBtZXNzYWdlOiBNZXNzYWdlRXZlbnQ7XG4gIG9wZW46IEV2ZW50O1xufVxuXG5jb25zdCBFdmVudHMgPSB7XG4gIEV2ZW50LFxuICBFcnJvckV2ZW50LFxuICBDbG9zZUV2ZW50XG59O1xuXG5mdW5jdGlvbiBhc3NlcnQoY29uZGl0aW9uOiB1bmtub3duLCBtc2c/OiBzdHJpbmcpOiBhc3NlcnRzIGNvbmRpdGlvbiB7XG4gIGlmICghY29uZGl0aW9uKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xvbmVFdmVudEJyb3dzZXIoZTogRXZlbnQpIHtcbiAgLy8gb3hsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWV4cGxpY2l0LWFueVxuICByZXR1cm4gbmV3IChlIGFzIGFueSkuY29uc3RydWN0b3IoZS50eXBlLCBlKSBhcyBFdmVudDtcbn1cblxuZnVuY3Rpb24gY2xvbmVFdmVudE5vZGUoZTogRXZlbnQpIHtcbiAgaWYgKFwiZGF0YVwiIGluIGUpIHtcbiAgICBjb25zdCBldnQgPSBuZXcgTWVzc2FnZUV2ZW50KGUudHlwZSwgZSk7XG4gICAgcmV0dXJuIGV2dDtcbiAgfVxuXG4gIGlmIChcImNvZGVcIiBpbiBlIHx8IFwicmVhc29uXCIgaW4gZSkge1xuICAgIGNvbnN0IGV2dCA9IG5ldyBDbG9zZUV2ZW50KFxuICAgICAgLy8gQHRzLWV4cGVjdC1lcnJvciB3ZSBuZWVkIHRvIGZpeCBldmVudC9saXN0ZW5lciB0eXBlc1xuICAgICAgKGUuY29kZSB8fCAxOTk5KSBhcyBudW1iZXIsXG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIHdlIG5lZWQgdG8gZml4IGV2ZW50L2xpc3RlbmVyIHR5cGVzXG4gICAgICAoZS5yZWFzb24gfHwgXCJ1bmtub3duIHJlYXNvblwiKSBhcyBzdHJpbmcsXG4gICAgICBlXG4gICAgKTtcbiAgICByZXR1cm4gZXZ0O1xuICB9XG5cbiAgaWYgKFwiZXJyb3JcIiBpbiBlKSB7XG4gICAgY29uc3QgZXZ0ID0gbmV3IEVycm9yRXZlbnQoZS5lcnJvciBhcyBFcnJvciwgZSk7XG4gICAgcmV0dXJuIGV2dDtcbiAgfVxuXG4gIGNvbnN0IGV2dCA9IG5ldyBFdmVudChlLnR5cGUsIGUpO1xuICByZXR1cm4gZXZ0O1xufVxuXG5jb25zdCBpc05vZGUgPVxuICB0eXBlb2YgcHJvY2VzcyAhPT0gXCJ1bmRlZmluZWRcIiAmJlxuICB0eXBlb2YgcHJvY2Vzcy52ZXJzaW9ucz8ubm9kZSAhPT0gXCJ1bmRlZmluZWRcIjtcblxuLy8gUmVhY3QgTmF0aXZlIGhhcyBwcm9jZXNzIGFuZCBkb2N1bWVudCBwb2x5ZmlsbGVkIGJ1dCBub3QgcHJvY2Vzcy52ZXJzaW9ucy5ub2RlXG4vLyBJdCBuZWVkcyBOb2RlLXN0eWxlIGV2ZW50IGNsb25pbmcgYmVjYXVzZSBicm93c2VyLXN0eWxlIGNsb25pbmcgcHJvZHVjZXNcbi8vIGV2ZW50cyB0aGF0IGZhaWwgaW5zdGFuY2VvZiBFdmVudCBjaGVja3MgaW4gZXZlbnQtdGFyZ2V0LXBvbHlmaWxsXG4vLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9jbG91ZGZsYXJlL3BhcnR5a2l0L2lzc3Vlcy8yNTdcbmNvbnN0IGlzUmVhY3ROYXRpdmUgPVxuICB0eXBlb2YgbmF2aWdhdG9yICE9PSBcInVuZGVmaW5lZFwiICYmIG5hdmlnYXRvci5wcm9kdWN0ID09PSBcIlJlYWN0TmF0aXZlXCI7XG5cbmNvbnN0IGNsb25lRXZlbnQgPSBpc05vZGUgfHwgaXNSZWFjdE5hdGl2ZSA/IGNsb25lRXZlbnROb2RlIDogY2xvbmVFdmVudEJyb3dzZXI7XG5cbmV4cG9ydCB0eXBlIE9wdGlvbnMgPSB7XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgV2ViU29ja2V0PzogYW55O1xuICBtYXhSZWNvbm5lY3Rpb25EZWxheT86IG51bWJlcjtcbiAgbWluUmVjb25uZWN0aW9uRGVsYXk/OiBudW1iZXI7XG4gIHJlY29ubmVjdGlvbkRlbGF5R3Jvd0ZhY3Rvcj86IG51bWJlcjtcbiAgbWluVXB0aW1lPzogbnVtYmVyO1xuICBjb25uZWN0aW9uVGltZW91dD86IG51bWJlcjtcbiAgbWF4UmV0cmllcz86IG51bWJlcjtcbiAgbWF4RW5xdWV1ZWRNZXNzYWdlcz86IG51bWJlcjtcbiAgc3RhcnRDbG9zZWQ/OiBib29sZWFuO1xuICBkZWJ1Zz86IGJvb2xlYW47XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgZGVidWdMb2dnZXI/OiAoLi4uYXJnczogYW55W10pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUID0ge1xuICBtYXhSZWNvbm5lY3Rpb25EZWxheTogMTAwMDAsXG4gIG1pblJlY29ubmVjdGlvbkRlbGF5OiAxMDAwICsgTWF0aC5yYW5kb20oKSAqIDQwMDAsXG4gIG1pblVwdGltZTogNTAwMCxcbiAgcmVjb25uZWN0aW9uRGVsYXlHcm93RmFjdG9yOiAxLjMsXG4gIGNvbm5lY3Rpb25UaW1lb3V0OiA0MDAwLFxuICBtYXhSZXRyaWVzOiBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksXG4gIG1heEVucXVldWVkTWVzc2FnZXM6IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSxcbiAgc3RhcnRDbG9zZWQ6IGZhbHNlLFxuICBkZWJ1ZzogZmFsc2Vcbn07XG5cbmxldCBkaWRXYXJuQWJvdXRNaXNzaW5nV2ViU29ja2V0ID0gZmFsc2U7XG5cbmV4cG9ydCB0eXBlIFVybFByb3ZpZGVyID0gc3RyaW5nIHwgKCgpID0+IHN0cmluZykgfCAoKCkgPT4gUHJvbWlzZTxzdHJpbmc+KTtcbmV4cG9ydCB0eXBlIFByb3RvY29sc1Byb3ZpZGVyID1cbiAgfCBudWxsXG4gIHwgc3RyaW5nXG4gIHwgc3RyaW5nW11cbiAgfCAoKCkgPT4gc3RyaW5nIHwgc3RyaW5nW10gfCBudWxsKVxuICB8ICgoKSA9PiBQcm9taXNlPHN0cmluZyB8IHN0cmluZ1tdIHwgbnVsbD4pO1xuXG5leHBvcnQgdHlwZSBNZXNzYWdlID1cbiAgfCBzdHJpbmdcbiAgfCBBcnJheUJ1ZmZlclxuICB8IEJsb2JcbiAgfCBBcnJheUJ1ZmZlclZpZXc8QXJyYXlCdWZmZXI+O1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBSZWNvbm5lY3RpbmdXZWJTb2NrZXQgZXh0ZW5kcyAoRXZlbnRUYXJnZXQgYXMgVHlwZWRFdmVudFRhcmdldDxXZWJTb2NrZXRFdmVudE1hcD4pIHtcbiAgcHJpdmF0ZSBfd3M6IFdlYlNvY2tldCB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfcmV0cnlDb3VudCA9IC0xO1xuICBwcml2YXRlIF91cHRpbWVUaW1lb3V0OiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfY29ubmVjdFRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIF9zaG91bGRSZWNvbm5lY3QgPSB0cnVlO1xuICBwcml2YXRlIF9jb25uZWN0TG9jayA9IGZhbHNlO1xuICBwcml2YXRlIF9iaW5hcnlUeXBlOiBCaW5hcnlUeXBlID0gXCJibG9iXCI7XG4gIHByaXZhdGUgX2Nsb3NlQ2FsbGVkID0gZmFsc2U7XG4gIHByaXZhdGUgX21lc3NhZ2VRdWV1ZTogTWVzc2FnZVtdID0gW107XG5cbiAgcHJpdmF0ZSBfZGVidWdMb2dnZXIgPSBjb25zb2xlLmxvZy5iaW5kKGNvbnNvbGUpO1xuXG4gIHByb3RlY3RlZCBfdXJsOiBVcmxQcm92aWRlcjtcbiAgcHJvdGVjdGVkIF9wcm90b2NvbHM/OiBQcm90b2NvbHNQcm92aWRlcjtcbiAgcHJvdGVjdGVkIF9vcHRpb25zOiBPcHRpb25zO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHVybDogVXJsUHJvdmlkZXIsXG4gICAgcHJvdG9jb2xzPzogUHJvdG9jb2xzUHJvdmlkZXIsXG4gICAgb3B0aW9uczogT3B0aW9ucyA9IHt9XG4gICkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5fdXJsID0gdXJsO1xuICAgIHRoaXMuX3Byb3RvY29scyA9IHByb3RvY29scztcbiAgICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgICBpZiAodGhpcy5fb3B0aW9ucy5zdGFydENsb3NlZCkge1xuICAgICAgdGhpcy5fc2hvdWxkUmVjb25uZWN0ID0gZmFsc2U7XG4gICAgfVxuICAgIGlmICh0aGlzLl9vcHRpb25zLmRlYnVnTG9nZ2VyKSB7XG4gICAgICB0aGlzLl9kZWJ1Z0xvZ2dlciA9IHRoaXMuX29wdGlvbnMuZGVidWdMb2dnZXI7XG4gICAgfVxuICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgfVxuXG4gIHN0YXRpYyBnZXQgQ09OTkVDVElORygpIHtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBzdGF0aWMgZ2V0IE9QRU4oKSB7XG4gICAgcmV0dXJuIDE7XG4gIH1cbiAgc3RhdGljIGdldCBDTE9TSU5HKCkge1xuICAgIHJldHVybiAyO1xuICB9XG4gIHN0YXRpYyBnZXQgQ0xPU0VEKCkge1xuICAgIHJldHVybiAzO1xuICB9XG5cbiAgZ2V0IENPTk5FQ1RJTkcoKSB7XG4gICAgcmV0dXJuIFJlY29ubmVjdGluZ1dlYlNvY2tldC5DT05ORUNUSU5HO1xuICB9XG4gIGdldCBPUEVOKCkge1xuICAgIHJldHVybiBSZWNvbm5lY3RpbmdXZWJTb2NrZXQuT1BFTjtcbiAgfVxuICBnZXQgQ0xPU0lORygpIHtcbiAgICByZXR1cm4gUmVjb25uZWN0aW5nV2ViU29ja2V0LkNMT1NJTkc7XG4gIH1cbiAgZ2V0IENMT1NFRCgpIHtcbiAgICByZXR1cm4gUmVjb25uZWN0aW5nV2ViU29ja2V0LkNMT1NFRDtcbiAgfVxuXG4gIGdldCBiaW5hcnlUeXBlKCkge1xuICAgIHJldHVybiB0aGlzLl93cyA/IHRoaXMuX3dzLmJpbmFyeVR5cGUgOiB0aGlzLl9iaW5hcnlUeXBlO1xuICB9XG5cbiAgc2V0IGJpbmFyeVR5cGUodmFsdWU6IEJpbmFyeVR5cGUpIHtcbiAgICB0aGlzLl9iaW5hcnlUeXBlID0gdmFsdWU7XG4gICAgaWYgKHRoaXMuX3dzKSB7XG4gICAgICB0aGlzLl93cy5iaW5hcnlUeXBlID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIG51bWJlciBvciBjb25uZWN0aW9uIHJldHJpZXNcbiAgICovXG4gIGdldCByZXRyeUNvdW50KCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KHRoaXMuX3JldHJ5Q291bnQsIDApO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBudW1iZXIgb2YgYnl0ZXMgb2YgZGF0YSB0aGF0IGhhdmUgYmVlbiBxdWV1ZWQgdXNpbmcgY2FsbHMgdG8gc2VuZCgpIGJ1dCBub3QgeWV0XG4gICAqIHRyYW5zbWl0dGVkIHRvIHRoZSBuZXR3b3JrLiBUaGlzIHZhbHVlIHJlc2V0cyB0byB6ZXJvIG9uY2UgYWxsIHF1ZXVlZCBkYXRhIGhhcyBiZWVuIHNlbnQuXG4gICAqIFRoaXMgdmFsdWUgZG9lcyBub3QgcmVzZXQgdG8gemVybyB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGNsb3NlZDsgaWYgeW91IGtlZXAgY2FsbGluZyBzZW5kKCksXG4gICAqIHRoaXMgd2lsbCBjb250aW51ZSB0byBjbGltYi4gUmVhZCBvbmx5XG4gICAqL1xuICBnZXQgYnVmZmVyZWRBbW91bnQoKTogbnVtYmVyIHtcbiAgICBjb25zdCBieXRlcyA9IHRoaXMuX21lc3NhZ2VRdWV1ZS5yZWR1Y2UoKGFjYywgbWVzc2FnZSkgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGFjYyArPSBtZXNzYWdlLmxlbmd0aDsgLy8gbm90IGJ5dGUgc2l6ZVxuICAgICAgfSBlbHNlIGlmIChtZXNzYWdlIGluc3RhbmNlb2YgQmxvYikge1xuICAgICAgICBhY2MgKz0gbWVzc2FnZS5zaXplO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYWNjICs9IG1lc3NhZ2UuYnl0ZUxlbmd0aDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBhY2M7XG4gICAgfSwgMCk7XG4gICAgcmV0dXJuIGJ5dGVzICsgKHRoaXMuX3dzID8gdGhpcy5fd3MuYnVmZmVyZWRBbW91bnQgOiAwKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZXh0ZW5zaW9ucyBzZWxlY3RlZCBieSB0aGUgc2VydmVyLiBUaGlzIGlzIGN1cnJlbnRseSBvbmx5IHRoZSBlbXB0eSBzdHJpbmcgb3IgYSBsaXN0IG9mXG4gICAqIGV4dGVuc2lvbnMgYXMgbmVnb3RpYXRlZCBieSB0aGUgY29ubmVjdGlvblxuICAgKi9cbiAgZ2V0IGV4dGVuc2lvbnMoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5fd3MgPyB0aGlzLl93cy5leHRlbnNpb25zIDogXCJcIjtcbiAgfVxuXG4gIC8qKlxuICAgKiBBIHN0cmluZyBpbmRpY2F0aW5nIHRoZSBuYW1lIG9mIHRoZSBzdWItcHJvdG9jb2wgdGhlIHNlcnZlciBzZWxlY3RlZDtcbiAgICogdGhpcyB3aWxsIGJlIG9uZSBvZiB0aGUgc3RyaW5ncyBzcGVjaWZpZWQgaW4gdGhlIHByb3RvY29scyBwYXJhbWV0ZXIgd2hlbiBjcmVhdGluZyB0aGVcbiAgICogV2ViU29ja2V0IG9iamVjdFxuICAgKi9cbiAgZ2V0IHByb3RvY29sKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuX3dzID8gdGhpcy5fd3MucHJvdG9jb2wgOiBcIlwiO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBjdXJyZW50IHN0YXRlIG9mIHRoZSBjb25uZWN0aW9uOyB0aGlzIGlzIG9uZSBvZiB0aGUgUmVhZHkgc3RhdGUgY29uc3RhbnRzXG4gICAqL1xuICBnZXQgcmVhZHlTdGF0ZSgpOiBudW1iZXIge1xuICAgIGlmICh0aGlzLl93cykge1xuICAgICAgcmV0dXJuIHRoaXMuX3dzLnJlYWR5U3RhdGU7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9vcHRpb25zLnN0YXJ0Q2xvc2VkXG4gICAgICA/IFJlY29ubmVjdGluZ1dlYlNvY2tldC5DTE9TRURcbiAgICAgIDogUmVjb25uZWN0aW5nV2ViU29ja2V0LkNPTk5FQ1RJTkc7XG4gIH1cblxuICAvKipcbiAgICogVGhlIFVSTCBhcyByZXNvbHZlZCBieSB0aGUgY29uc3RydWN0b3JcbiAgICovXG4gIGdldCB1cmwoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5fd3MgPyB0aGlzLl93cy51cmwgOiBcIlwiO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHdlYnNvY2tldCBvYmplY3QgaXMgbm93IGluIHJlY29ubmVjdGFibGUgc3RhdGVcbiAgICovXG4gIGdldCBzaG91bGRSZWNvbm5lY3QoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3Nob3VsZFJlY29ubmVjdDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBbiBldmVudCBsaXN0ZW5lciB0byBiZSBjYWxsZWQgd2hlbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb24ncyByZWFkeVN0YXRlIGNoYW5nZXMgdG8gQ0xPU0VEXG4gICAqL1xuICBwdWJsaWMgb25jbG9zZTogKChldmVudDogQ2xvc2VFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICAvKipcbiAgICogQW4gZXZlbnQgbGlzdGVuZXIgdG8gYmUgY2FsbGVkIHdoZW4gYW4gZXJyb3Igb2NjdXJzXG4gICAqL1xuICBwdWJsaWMgb25lcnJvcjogKChldmVudDogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICAvKipcbiAgICogQW4gZXZlbnQgbGlzdGVuZXIgdG8gYmUgY2FsbGVkIHdoZW4gYSBtZXNzYWdlIGlzIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgcHVibGljIG9ubWVzc2FnZTogKChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBBbiBldmVudCBsaXN0ZW5lciB0byBiZSBjYWxsZWQgd2hlbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb24ncyByZWFkeVN0YXRlIGNoYW5nZXMgdG8gT1BFTjtcbiAgICogdGhpcyBpbmRpY2F0ZXMgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyByZWFkeSB0byBzZW5kIGFuZCByZWNlaXZlIGRhdGFcbiAgICovXG4gIHB1YmxpYyBvbm9wZW46ICgoZXZlbnQ6IEV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBDbG9zZXMgdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uIG9yIGNvbm5lY3Rpb24gYXR0ZW1wdCwgaWYgYW55LiBJZiB0aGUgY29ubmVjdGlvbiBpcyBhbHJlYWR5XG4gICAqIENMT1NFRCwgdGhpcyBtZXRob2QgZG9lcyBub3RoaW5nXG4gICAqL1xuICBwdWJsaWMgY2xvc2UoY29kZSA9IDEwMDAsIHJlYXNvbj86IHN0cmluZykge1xuICAgIHRoaXMuX2Nsb3NlQ2FsbGVkID0gdHJ1ZTtcbiAgICB0aGlzLl9zaG91bGRSZWNvbm5lY3QgPSBmYWxzZTtcbiAgICB0aGlzLl9jbGVhclRpbWVvdXRzKCk7XG4gICAgaWYgKCF0aGlzLl93cykge1xuICAgICAgdGhpcy5fZGVidWcoXCJjbG9zZSBlbnF1ZXVlZDogbm8gd3MgaW5zdGFuY2VcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLl93cy5yZWFkeVN0YXRlID09PSB0aGlzLkNMT1NFRCkge1xuICAgICAgdGhpcy5fZGVidWcoXCJjbG9zZTogYWxyZWFkeSBjbG9zZWRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3dzLmNsb3NlKGNvZGUsIHJlYXNvbik7XG4gIH1cblxuICAvKipcbiAgICogQ2xvc2VzIHRoZSBXZWJTb2NrZXQgY29ubmVjdGlvbiBvciBjb25uZWN0aW9uIGF0dGVtcHQgYW5kIGNvbm5lY3RzIGFnYWluLlxuICAgKiBSZXNldHMgcmV0cnkgY291bnRlcjtcbiAgICovXG4gIHB1YmxpYyByZWNvbm5lY3QoY29kZT86IG51bWJlciwgcmVhc29uPzogc3RyaW5nKSB7XG4gICAgdGhpcy5fc2hvdWxkUmVjb25uZWN0ID0gdHJ1ZTtcbiAgICB0aGlzLl9jbG9zZUNhbGxlZCA9IGZhbHNlO1xuICAgIHRoaXMuX3JldHJ5Q291bnQgPSAtMTtcbiAgICBpZiAoIXRoaXMuX3dzIHx8IHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuQ0xPU0VEKSB7XG4gICAgICB0aGlzLl9jb25uZWN0KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rpc2Nvbm5lY3QoY29kZSwgcmVhc29uKTtcbiAgICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRW5xdWV1ZSBzcGVjaWZpZWQgZGF0YSB0byBiZSB0cmFuc21pdHRlZCB0byB0aGUgc2VydmVyIG92ZXIgdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uXG4gICAqL1xuICBwdWJsaWMgc2VuZChkYXRhOiBNZXNzYWdlKSB7XG4gICAgaWYgKHRoaXMuX3dzICYmIHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuT1BFTikge1xuICAgICAgdGhpcy5fZGVidWcoXCJzZW5kXCIsIGRhdGEpO1xuICAgICAgdGhpcy5fd3Muc2VuZChkYXRhKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgeyBtYXhFbnF1ZXVlZE1lc3NhZ2VzID0gREVGQVVMVC5tYXhFbnF1ZXVlZE1lc3NhZ2VzIH0gPVxuICAgICAgICB0aGlzLl9vcHRpb25zO1xuICAgICAgaWYgKHRoaXMuX21lc3NhZ2VRdWV1ZS5sZW5ndGggPCBtYXhFbnF1ZXVlZE1lc3NhZ2VzKSB7XG4gICAgICAgIHRoaXMuX2RlYnVnKFwiZW5xdWV1ZVwiLCBkYXRhKTtcbiAgICAgICAgdGhpcy5fbWVzc2FnZVF1ZXVlLnB1c2goZGF0YSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfZGVidWcoLi4uYXJnczogdW5rbm93bltdKSB7XG4gICAgaWYgKHRoaXMuX29wdGlvbnMuZGVidWcpIHtcbiAgICAgIHRoaXMuX2RlYnVnTG9nZ2VyKFwiUldTPlwiLCAuLi5hcmdzKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9nZXROZXh0RGVsYXkoKSB7XG4gICAgY29uc3Qge1xuICAgICAgcmVjb25uZWN0aW9uRGVsYXlHcm93RmFjdG9yID0gREVGQVVMVC5yZWNvbm5lY3Rpb25EZWxheUdyb3dGYWN0b3IsXG4gICAgICBtaW5SZWNvbm5lY3Rpb25EZWxheSA9IERFRkFVTFQubWluUmVjb25uZWN0aW9uRGVsYXksXG4gICAgICBtYXhSZWNvbm5lY3Rpb25EZWxheSA9IERFRkFVTFQubWF4UmVjb25uZWN0aW9uRGVsYXlcbiAgICB9ID0gdGhpcy5fb3B0aW9ucztcbiAgICBsZXQgZGVsYXkgPSAwO1xuICAgIGlmICh0aGlzLl9yZXRyeUNvdW50ID4gMCkge1xuICAgICAgZGVsYXkgPVxuICAgICAgICBtaW5SZWNvbm5lY3Rpb25EZWxheSAqXG4gICAgICAgIHJlY29ubmVjdGlvbkRlbGF5R3Jvd0ZhY3RvciAqKiAodGhpcy5fcmV0cnlDb3VudCAtIDEpO1xuICAgICAgaWYgKGRlbGF5ID4gbWF4UmVjb25uZWN0aW9uRGVsYXkpIHtcbiAgICAgICAgZGVsYXkgPSBtYXhSZWNvbm5lY3Rpb25EZWxheTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5fZGVidWcoXCJuZXh0IGRlbGF5XCIsIGRlbGF5KTtcbiAgICByZXR1cm4gZGVsYXk7XG4gIH1cblxuICBwcml2YXRlIF93YWl0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgc2V0VGltZW91dChyZXNvbHZlLCB0aGlzLl9nZXROZXh0RGVsYXkoKSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIF9nZXROZXh0UHJvdG9jb2xzKFxuICAgIHByb3RvY29sc1Byb3ZpZGVyOiBQcm90b2NvbHNQcm92aWRlciB8IG51bGxcbiAgKTogUHJvbWlzZTxzdHJpbmcgfCBzdHJpbmdbXSB8IG51bGw+IHtcbiAgICBpZiAoIXByb3RvY29sc1Byb3ZpZGVyKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xuXG4gICAgaWYgKFxuICAgICAgdHlwZW9mIHByb3RvY29sc1Byb3ZpZGVyID09PSBcInN0cmluZ1wiIHx8XG4gICAgICBBcnJheS5pc0FycmF5KHByb3RvY29sc1Byb3ZpZGVyKVxuICAgICkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShwcm90b2NvbHNQcm92aWRlcik7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBwcm90b2NvbHNQcm92aWRlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBjb25zdCBwcm90b2NvbHMgPSBwcm90b2NvbHNQcm92aWRlcigpO1xuICAgICAgaWYgKCFwcm90b2NvbHMpIHJldHVybiBQcm9taXNlLnJlc29sdmUobnVsbCk7XG5cbiAgICAgIGlmICh0eXBlb2YgcHJvdG9jb2xzID09PSBcInN0cmluZ1wiIHx8IEFycmF5LmlzQXJyYXkocHJvdG9jb2xzKSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHByb3RvY29scyk7XG4gICAgICB9XG5cbiAgICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgcmVkdW5kYW50IGNoZWNrXG4gICAgICBpZiAocHJvdG9jb2xzLnRoZW4pIHtcbiAgICAgICAgcmV0dXJuIHByb3RvY29scztcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aHJvdyBFcnJvcihcIkludmFsaWQgcHJvdG9jb2xzXCIpO1xuICB9XG5cbiAgcHJpdmF0ZSBfZ2V0TmV4dFVybCh1cmxQcm92aWRlcjogVXJsUHJvdmlkZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGlmICh0eXBlb2YgdXJsUHJvdmlkZXIgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodXJsUHJvdmlkZXIpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHVybFByb3ZpZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGNvbnN0IHVybCA9IHVybFByb3ZpZGVyKCk7XG4gICAgICBpZiAodHlwZW9mIHVybCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHVybCk7XG4gICAgICB9XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yXG4gICAgICBpZiAodXJsLnRoZW4pIHtcbiAgICAgICAgcmV0dXJuIHVybDtcbiAgICAgIH1cblxuICAgICAgLy8gcmV0dXJuIHVybDtcbiAgICB9XG4gICAgdGhyb3cgRXJyb3IoXCJJbnZhbGlkIFVSTFwiKTtcbiAgfVxuXG4gIHByaXZhdGUgX2Nvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuX2Nvbm5lY3RMb2NrIHx8ICF0aGlzLl9zaG91bGRSZWNvbm5lY3QpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fY29ubmVjdExvY2sgPSB0cnVlO1xuXG4gICAgY29uc3Qge1xuICAgICAgbWF4UmV0cmllcyA9IERFRkFVTFQubWF4UmV0cmllcyxcbiAgICAgIGNvbm5lY3Rpb25UaW1lb3V0ID0gREVGQVVMVC5jb25uZWN0aW9uVGltZW91dFxuICAgIH0gPSB0aGlzLl9vcHRpb25zO1xuXG4gICAgaWYgKHRoaXMuX3JldHJ5Q291bnQgPj0gbWF4UmV0cmllcykge1xuICAgICAgdGhpcy5fZGVidWcoXCJtYXggcmV0cmllcyByZWFjaGVkXCIsIHRoaXMuX3JldHJ5Q291bnQsIFwiPj1cIiwgbWF4UmV0cmllcyk7XG4gICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuX3JldHJ5Q291bnQrKztcblxuICAgIHRoaXMuX2RlYnVnKFwiY29ubmVjdFwiLCB0aGlzLl9yZXRyeUNvdW50KTtcbiAgICB0aGlzLl9yZW1vdmVMaXN0ZW5lcnMoKTtcblxuICAgIHRoaXMuX3dhaXQoKVxuICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgIHRoaXMuX2dldE5leHRVcmwodGhpcy5fdXJsKSxcbiAgICAgICAgICB0aGlzLl9nZXROZXh0UHJvdG9jb2xzKHRoaXMuX3Byb3RvY29scyB8fCBudWxsKVxuICAgICAgICBdKVxuICAgICAgKVxuICAgICAgLnRoZW4oKFt1cmwsIHByb3RvY29sc10pID0+IHtcbiAgICAgICAgLy8gY2xvc2UgY291bGQgYmUgY2FsbGVkIGJlZm9yZSBjcmVhdGluZyB0aGUgd3NcbiAgICAgICAgaWYgKHRoaXMuX2Nsb3NlQ2FsbGVkKSB7XG4gICAgICAgICAgdGhpcy5fY29ubmVjdExvY2sgPSBmYWxzZTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgICF0aGlzLl9vcHRpb25zLldlYlNvY2tldCAmJlxuICAgICAgICAgIHR5cGVvZiBXZWJTb2NrZXQgPT09IFwidW5kZWZpbmVkXCIgJiZcbiAgICAgICAgICAhZGlkV2FybkFib3V0TWlzc2luZ1dlYlNvY2tldFxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKGDigLzvuI8gTm8gV2ViU29ja2V0IGltcGxlbWVudGF0aW9uIGF2YWlsYWJsZS4gWW91IHNob3VsZCBkZWZpbmUgb3B0aW9ucy5XZWJTb2NrZXQuIFxuXG5Gb3IgZXhhbXBsZSwgaWYgeW91J3JlIHVzaW5nIG5vZGUuanMsIHJ1biBcXGBucG0gaW5zdGFsbCB3c1xcYCwgYW5kIHRoZW4gaW4geW91ciBjb2RlOlxuXG5pbXBvcnQgUGFydHlTb2NrZXQgZnJvbSAncGFydHlzb2NrZXQnO1xuaW1wb3J0IFdTIGZyb20gJ3dzJztcblxuY29uc3QgcGFydHlzb2NrZXQgPSBuZXcgUGFydHlTb2NrZXQoe1xuICBob3N0OiBcIjEyNy4wLjAuMToxOTk5XCIsXG4gIHJvb206IFwidGVzdC1yb29tXCIsXG4gIFdlYlNvY2tldDogV1Ncbn0pO1xuXG5gKTtcbiAgICAgICAgICBkaWRXYXJuQWJvdXRNaXNzaW5nV2ViU29ja2V0ID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBXUzogdHlwZW9mIFdlYlNvY2tldCA9IHRoaXMuX29wdGlvbnMuV2ViU29ja2V0IHx8IFdlYlNvY2tldDtcbiAgICAgICAgdGhpcy5fZGVidWcoXCJjb25uZWN0XCIsIHsgdXJsLCBwcm90b2NvbHMgfSk7XG4gICAgICAgIHRoaXMuX3dzID0gcHJvdG9jb2xzID8gbmV3IFdTKHVybCwgcHJvdG9jb2xzKSA6IG5ldyBXUyh1cmwpO1xuXG4gICAgICAgIHRoaXMuX3dzLmJpbmFyeVR5cGUgPSB0aGlzLl9iaW5hcnlUeXBlO1xuICAgICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgICB0aGlzLl9hZGRMaXN0ZW5lcnMoKTtcblxuICAgICAgICB0aGlzLl9jb25uZWN0VGltZW91dCA9IHNldFRpbWVvdXQoXG4gICAgICAgICAgKCkgPT4gdGhpcy5faGFuZGxlVGltZW91dCgpLFxuICAgICAgICAgIGNvbm5lY3Rpb25UaW1lb3V0XG4gICAgICAgICk7XG4gICAgICB9KVxuICAgICAgLy8gdmlhIGh0dHBzOi8vZ2l0aHViLmNvbS9wbGFkYXJpYS9yZWNvbm5lY3Rpbmctd2Vic29ja2V0L3B1bGwvMTY2XG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgICB0aGlzLl9oYW5kbGVFcnJvcihuZXcgRXZlbnRzLkVycm9yRXZlbnQoRXJyb3IoZXJyLm1lc3NhZ2UpLCB0aGlzKSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX2hhbmRsZVRpbWVvdXQoKSB7XG4gICAgdGhpcy5fZGVidWcoXCJ0aW1lb3V0IGV2ZW50XCIpO1xuICAgIHRoaXMuX2hhbmRsZUVycm9yKG5ldyBFdmVudHMuRXJyb3JFdmVudChFcnJvcihcIlRJTUVPVVRcIiksIHRoaXMpKTtcbiAgfVxuXG4gIHByaXZhdGUgX2Rpc2Nvbm5lY3QoY29kZSA9IDEwMDAsIHJlYXNvbj86IHN0cmluZykge1xuICAgIHRoaXMuX2NsZWFyVGltZW91dHMoKTtcbiAgICBpZiAoIXRoaXMuX3dzKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3JlbW92ZUxpc3RlbmVycygpO1xuICAgIHRyeSB7XG4gICAgICBpZiAoXG4gICAgICAgIHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuT1BFTiB8fFxuICAgICAgICB0aGlzLl93cy5yZWFkeVN0YXRlID09PSB0aGlzLkNPTk5FQ1RJTkdcbiAgICAgICkge1xuICAgICAgICB0aGlzLl93cy5jbG9zZShjb2RlLCByZWFzb24pO1xuICAgICAgfVxuICAgICAgdGhpcy5faGFuZGxlQ2xvc2UobmV3IEV2ZW50cy5DbG9zZUV2ZW50KGNvZGUsIHJlYXNvbiwgdGhpcykpO1xuICAgIH0gY2F0Y2ggKF9lcnJvcikge1xuICAgICAgLy8gaWdub3JlXG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfYWNjZXB0T3BlbigpIHtcbiAgICB0aGlzLl9kZWJ1ZyhcImFjY2VwdCBvcGVuXCIpO1xuICAgIHRoaXMuX3JldHJ5Q291bnQgPSAwO1xuICB9XG5cbiAgcHJpdmF0ZSBfaGFuZGxlT3BlbiA9IChldmVudDogRXZlbnQpID0+IHtcbiAgICB0aGlzLl9kZWJ1ZyhcIm9wZW4gZXZlbnRcIik7XG4gICAgY29uc3QgeyBtaW5VcHRpbWUgPSBERUZBVUxULm1pblVwdGltZSB9ID0gdGhpcy5fb3B0aW9ucztcblxuICAgIGNsZWFyVGltZW91dCh0aGlzLl9jb25uZWN0VGltZW91dCk7XG4gICAgdGhpcy5fdXB0aW1lVGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5fYWNjZXB0T3BlbigpLCBtaW5VcHRpbWUpO1xuXG4gICAgYXNzZXJ0KHRoaXMuX3dzLCBcIldlYlNvY2tldCBpcyBub3QgZGVmaW5lZFwiKTtcblxuICAgIHRoaXMuX3dzLmJpbmFyeVR5cGUgPSB0aGlzLl9iaW5hcnlUeXBlO1xuXG4gICAgLy8gc2VuZCBlbnF1ZXVlZCBtZXNzYWdlcyAobWVzc2FnZXMgc2VudCBiZWZvcmUgd2Vic29ja2V0IG9wZW4gZXZlbnQpXG4gICAgdGhpcy5fbWVzc2FnZVF1ZXVlLmZvckVhY2goKG1lc3NhZ2UpID0+IHtcbiAgICAgIHRoaXMuX3dzPy5zZW5kKG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHRoaXMuX21lc3NhZ2VRdWV1ZSA9IFtdO1xuXG4gICAgaWYgKHRoaXMub25vcGVuKSB7XG4gICAgICB0aGlzLm9ub3BlbihldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfaGFuZGxlTWVzc2FnZSA9IChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB7XG4gICAgdGhpcy5fZGVidWcoXCJtZXNzYWdlIGV2ZW50XCIpO1xuXG4gICAgaWYgKHRoaXMub25tZXNzYWdlKSB7XG4gICAgICB0aGlzLm9ubWVzc2FnZShldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfaGFuZGxlRXJyb3IgPSAoZXZlbnQ6IEVycm9yRXZlbnQpID0+IHtcbiAgICB0aGlzLl9kZWJ1ZyhcImVycm9yIGV2ZW50XCIsIGV2ZW50Lm1lc3NhZ2UpO1xuICAgIHRoaXMuX2Rpc2Nvbm5lY3QoXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBldmVudC5tZXNzYWdlID09PSBcIlRJTUVPVVRcIiA/IFwidGltZW91dFwiIDogdW5kZWZpbmVkXG4gICAgKTtcblxuICAgIGlmICh0aGlzLm9uZXJyb3IpIHtcbiAgICAgIHRoaXMub25lcnJvcihldmVudCk7XG4gICAgfVxuICAgIHRoaXMuX2RlYnVnKFwiZXhlYyBlcnJvciBsaXN0ZW5lcnNcIik7XG4gICAgdGhpcy5kaXNwYXRjaEV2ZW50KGNsb25lRXZlbnQoZXZlbnQpKTtcblxuICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgfTtcblxuICBwcml2YXRlIF9oYW5kbGVDbG9zZSA9IChldmVudDogQ2xvc2VFdmVudCkgPT4ge1xuICAgIHRoaXMuX2RlYnVnKFwiY2xvc2UgZXZlbnRcIik7XG4gICAgdGhpcy5fY2xlYXJUaW1lb3V0cygpO1xuXG4gICAgaWYgKHRoaXMuX3Nob3VsZFJlY29ubmVjdCkge1xuICAgICAgdGhpcy5fY29ubmVjdCgpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9uY2xvc2UpIHtcbiAgICAgIHRoaXMub25jbG9zZShldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfcmVtb3ZlTGlzdGVuZXJzKCkge1xuICAgIGlmICghdGhpcy5fd3MpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fZGVidWcoXCJyZW1vdmVMaXN0ZW5lcnNcIik7XG4gICAgdGhpcy5fd3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm9wZW5cIiwgdGhpcy5faGFuZGxlT3Blbik7XG4gICAgdGhpcy5fd3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsb3NlXCIsIHRoaXMuX2hhbmRsZUNsb3NlKTtcbiAgICB0aGlzLl93cy5yZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCB0aGlzLl9oYW5kbGVNZXNzYWdlKTtcbiAgICAvLyBAdHMtZXhwZWN0LWVycm9yIHdlIG5lZWQgdG8gZml4IGV2ZW50L2xpc3Rlcm5lciB0eXBlc1xuICAgIHRoaXMuX3dzLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCB0aGlzLl9oYW5kbGVFcnJvcik7XG4gIH1cblxuICBwcml2YXRlIF9hZGRMaXN0ZW5lcnMoKSB7XG4gICAgaWYgKCF0aGlzLl93cykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9kZWJ1ZyhcImFkZExpc3RlbmVyc1wiKTtcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwib3BlblwiLCB0aGlzLl9oYW5kbGVPcGVuKTtcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwiY2xvc2VcIiwgdGhpcy5faGFuZGxlQ2xvc2UpO1xuICAgIHRoaXMuX3dzLmFkZEV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIHRoaXMuX2hhbmRsZU1lc3NhZ2UpO1xuICAgIC8vIEB0cy1leHBlY3QtZXJyb3Igd2UgbmVlZCB0byBmaXggZXZlbnQvbGlzdGVuZXIgdHlwZXNcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgdGhpcy5faGFuZGxlRXJyb3IpO1xuICB9XG5cbiAgcHJpdmF0ZSBfY2xlYXJUaW1lb3V0cygpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy5fY29ubmVjdFRpbWVvdXQpO1xuICAgIGNsZWFyVGltZW91dCh0aGlzLl91cHRpbWVUaW1lb3V0KTtcbiAgfVxufVxuIiwgImltcG9ydCBSZWNvbm5lY3RpbmdXZWJTb2NrZXQgZnJvbSBcIi4vd3NcIjtcblxuaW1wb3J0IHR5cGUgKiBhcyBSV1MgZnJvbSBcIi4vd3NcIjtcbmltcG9ydCB0eXBlIHsgUHJvdG9jb2xzUHJvdmlkZXIgfSBmcm9tIFwiLi93c1wiO1xuXG50eXBlIE1heWJlPFQ+ID0gVCB8IG51bGwgfCB1bmRlZmluZWQ7XG50eXBlIFBhcmFtcyA9IFJlY29yZDxzdHJpbmcsIE1heWJlPHN0cmluZz4+O1xuY29uc3QgdmFsdWVJc05vdE5pbCA9IDxUPihcbiAga2V5VmFsdWVQYWlyOiBbc3RyaW5nLCBNYXliZTxUPl1cbik6IGtleVZhbHVlUGFpciBpcyBbc3RyaW5nLCBUXSA9PlxuICBrZXlWYWx1ZVBhaXJbMV0gIT09IG51bGwgJiYga2V5VmFsdWVQYWlyWzFdICE9PSB1bmRlZmluZWQ7XG5cbmV4cG9ydCB0eXBlIFBhcnR5U29ja2V0T3B0aW9ucyA9IE9taXQ8UldTLk9wdGlvbnMsIFwiY29uc3RydWN0b3JcIj4gJiB7XG4gIGlkPzogc3RyaW5nOyAvLyB0aGUgaWQgb2YgdGhlIGNsaWVudFxuICBob3N0OiBzdHJpbmc7IC8vIGJhc2UgdXJsIGZvciB0aGUgcGFydHlcbiAgcm9vbT86IHN0cmluZzsgLy8gdGhlIHJvb20gdG8gY29ubmVjdCB0b1xuICBwYXJ0eT86IHN0cmluZzsgLy8gdGhlIHBhcnR5IHRvIGNvbm5lY3QgdG8gKGRlZmF1bHRzIHRvIG1haW4pXG4gIGJhc2VQYXRoPzogc3RyaW5nOyAvLyB0aGUgYmFzZSBwYXRoIHRvIHVzZSBmb3IgdGhlIHBhcnR5XG4gIHByZWZpeD86IHN0cmluZzsgLy8gdGhlIHByZWZpeCB0byB1c2UgZm9yIHRoZSBwYXJ0eVxuICBwcm90b2NvbD86IFwid3NcIiB8IFwid3NzXCI7XG4gIHByb3RvY29scz86IFByb3RvY29sc1Byb3ZpZGVyO1xuICBwYXRoPzogc3RyaW5nOyAvLyB0aGUgcGF0aCB0byBjb25uZWN0IHRvXG4gIHF1ZXJ5PzogUGFyYW1zIHwgKCgpID0+IFBhcmFtcyB8IFByb21pc2U8UGFyYW1zPik7XG4gIGRpc2FibGVOYW1lVmFsaWRhdGlvbj86IGJvb2xlYW47IC8vIGRpc2FibGUgdmFsaWRhdGlvbiBvZiBwYXJ0eS9yb29tIG5hbWVzXG4gIC8vIGhlYWRlcnNcbn07XG5cbmV4cG9ydCB0eXBlIFBhcnR5RmV0Y2hPcHRpb25zID0ge1xuICBob3N0OiBzdHJpbmc7IC8vIGJhc2UgdXJsIGZvciB0aGUgcGFydHlcbiAgcm9vbTogc3RyaW5nOyAvLyB0aGUgcm9vbSB0byBjb25uZWN0IHRvXG4gIHBhcnR5Pzogc3RyaW5nOyAvLyB0aGUgcGFydHkgdG8gZmV0Y2ggZnJvbSAoZGVmYXVsdHMgdG8gbWFpbilcbiAgYmFzZVBhdGg/OiBzdHJpbmc7IC8vIHRoZSBiYXNlIHBhdGggdG8gdXNlIGZvciB0aGUgcGFydHlcbiAgcHJlZml4Pzogc3RyaW5nOyAvLyB0aGUgcHJlZml4IHRvIHVzZSBmb3IgdGhlIHBhcnR5XG4gIHBhdGg/OiBzdHJpbmc7IC8vIHRoZSBwYXRoIHRvIGZldGNoIGZyb21cbiAgcHJvdG9jb2w/OiBcImh0dHBcIiB8IFwiaHR0cHNcIjtcbiAgcXVlcnk/OiBQYXJhbXMgfCAoKCkgPT4gUGFyYW1zIHwgUHJvbWlzZTxQYXJhbXM+KTtcbiAgZmV0Y2g/OiB0eXBlb2YgZmV0Y2g7XG59O1xuXG5mdW5jdGlvbiBnZW5lcmF0ZVVVSUQoKTogc3RyaW5nIHtcbiAgLy8gUHVibGljIERvbWFpbi9NSVRcbiAgaWYgKGNyeXB0bz8ucmFuZG9tVVVJRCkge1xuICAgIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICB9XG4gIGxldCBkID0gRGF0ZS5ub3coKTsgLy9UaW1lc3RhbXBcbiAgbGV0IGQyID0gKHBlcmZvcm1hbmNlPy5ub3cgJiYgcGVyZm9ybWFuY2Uubm93KCkgKiAxMDAwKSB8fCAwOyAvL1RpbWUgaW4gbWljcm9zZWNvbmRzIHNpbmNlIHBhZ2UtbG9hZCBvciAwIGlmIHVuc3VwcG9ydGVkXG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBmdW5jLXN0eWxlXG4gIHJldHVybiBcInh4eHh4eHh4LXh4eHgtNHh4eC15eHh4LXh4eHh4eHh4eHh4eFwiLnJlcGxhY2UoL1t4eV0vZywgZnVuY3Rpb24gKGMpIHtcbiAgICBsZXQgciA9IE1hdGgucmFuZG9tKCkgKiAxNjsgLy9yYW5kb20gbnVtYmVyIGJldHdlZW4gMCBhbmQgMTZcbiAgICBpZiAoZCA+IDApIHtcbiAgICAgIC8vVXNlIHRpbWVzdGFtcCB1bnRpbCBkZXBsZXRlZFxuICAgICAgciA9ICgoZCArIHIpICUgMTYpIHwgMDtcbiAgICAgIGQgPSBNYXRoLmZsb29yKGQgLyAxNik7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vVXNlIG1pY3Jvc2Vjb25kcyBzaW5jZSBwYWdlLWxvYWQgaWYgc3VwcG9ydGVkXG4gICAgICByID0gKChkMiArIHIpICUgMTYpIHwgMDtcbiAgICAgIGQyID0gTWF0aC5mbG9vcihkMiAvIDE2KTtcbiAgICB9XG4gICAgcmV0dXJuIChjID09PSBcInhcIiA/IHIgOiAociAmIDB4MykgfCAweDgpLnRvU3RyaW5nKDE2KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldFBhcnR5SW5mbyhcbiAgcGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0eVNvY2tldE9wdGlvbnMgfCBQYXJ0eUZldGNoT3B0aW9ucyxcbiAgZGVmYXVsdFByb3RvY29sOiBcImh0dHBcIiB8IFwid3NcIixcbiAgZGVmYXVsdFBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9XG4pIHtcbiAgY29uc3Qge1xuICAgIGhvc3Q6IHJhd0hvc3QsXG4gICAgcGF0aDogcmF3UGF0aCxcbiAgICBwcm90b2NvbDogcmF3UHJvdG9jb2wsXG4gICAgcm9vbSxcbiAgICBwYXJ0eSxcbiAgICBiYXNlUGF0aCxcbiAgICBwcmVmaXgsXG4gICAgcXVlcnlcbiAgfSA9IHBhcnR5U29ja2V0T3B0aW9ucztcblxuICAvLyBzdHJpcCB0aGUgcHJvdG9jb2wgZnJvbSB0aGUgYmVnaW5uaW5nIG9mIGBob3N0YCBpZiBhbnlcbiAgbGV0IGhvc3QgPSByYXdIb3N0LnJlcGxhY2UoL14oaHR0cHxodHRwc3x3c3x3c3MpOlxcL1xcLy8sIFwiXCIpO1xuICAvLyBpZiB1c2VyIHByb3ZpZGVkIGEgdHJhaWxpbmcgc2xhc2gsIHJlbW92ZSBpdFxuICBpZiAoaG9zdC5lbmRzV2l0aChcIi9cIikpIHtcbiAgICBob3N0ID0gaG9zdC5zbGljZSgwLCAtMSk7XG4gIH1cblxuICBpZiAocmF3UGF0aD8uc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJwYXRoIG11c3Qgbm90IHN0YXJ0IHdpdGggYSBzbGFzaFwiKTtcbiAgfVxuXG4gIGNvbnN0IG5hbWUgPSBwYXJ0eSA/PyBcIm1haW5cIjtcbiAgY29uc3QgcGF0aCA9IHJhd1BhdGggPyBgLyR7cmF3UGF0aH1gIDogXCJcIjtcbiAgY29uc3QgcHJvdG9jb2wgPVxuICAgIHJhd1Byb3RvY29sIHx8XG4gICAgKGhvc3Quc3RhcnRzV2l0aChcImxvY2FsaG9zdDpcIikgfHxcbiAgICBob3N0LnN0YXJ0c1dpdGgoXCIxMjcuMC4wLjE6XCIpIHx8XG4gICAgaG9zdC5zdGFydHNXaXRoKFwiMTkyLjE2OC5cIikgfHxcbiAgICBob3N0LnN0YXJ0c1dpdGgoXCIxMC5cIikgfHxcbiAgICAoaG9zdC5zdGFydHNXaXRoKFwiMTcyLlwiKSAmJlxuICAgICAgaG9zdC5zcGxpdChcIi5cIilbMV0gPj0gXCIxNlwiICYmXG4gICAgICBob3N0LnNwbGl0KFwiLlwiKVsxXSA8PSBcIjMxXCIpIHx8XG4gICAgaG9zdC5zdGFydHNXaXRoKFwiWzo6ZmZmZjo3ZjAwOjFdOlwiKVxuICAgICAgPyAvLyBodHRwIC8gd3NcbiAgICAgICAgZGVmYXVsdFByb3RvY29sXG4gICAgICA6IC8vIGh0dHBzIC8gd3NzXG4gICAgICAgIGAke2RlZmF1bHRQcm90b2NvbH1zYCk7XG5cbiAgY29uc3QgYmFzZVVybCA9IGAke3Byb3RvY29sfTovLyR7aG9zdH0vJHtiYXNlUGF0aCB8fCBgJHtwcmVmaXggfHwgXCJwYXJ0aWVzXCJ9LyR7bmFtZX0vJHtyb29tfWB9JHtwYXRofWA7XG5cbiAgY29uc3QgbWFrZVVybCA9IChxdWVyeTogUGFyYW1zID0ge30pID0+XG4gICAgYCR7YmFzZVVybH0/JHtuZXcgVVJMU2VhcmNoUGFyYW1zKFtcbiAgICAgIC4uLk9iamVjdC5lbnRyaWVzKGRlZmF1bHRQYXJhbXMpLFxuICAgICAgLi4uT2JqZWN0LmVudHJpZXMocXVlcnkpLmZpbHRlcih2YWx1ZUlzTm90TmlsKVxuICAgIF0pfWA7XG5cbiAgLy8gYWxsb3cgdXJscyB0byBiZSBkZWZpbmVkIGFzIGZ1bmN0aW9uc1xuICBjb25zdCB1cmxQcm92aWRlciA9XG4gICAgdHlwZW9mIHF1ZXJ5ID09PSBcImZ1bmN0aW9uXCJcbiAgICAgID8gYXN5bmMgKCkgPT4gbWFrZVVybChhd2FpdCBxdWVyeSgpKVxuICAgICAgOiBtYWtlVXJsKHF1ZXJ5KTtcblxuICByZXR1cm4ge1xuICAgIGhvc3QsXG4gICAgcGF0aCxcbiAgICByb29tLFxuICAgIG5hbWUsXG4gICAgcHJvdG9jb2wsXG4gICAgcGFydHlVcmw6IGJhc2VVcmwsXG4gICAgdXJsUHJvdmlkZXJcbiAgfTtcbn1cblxuLy8gdGhpbmdzIHRoYXQgbmF0aGFuYm9rdGFlL3JvYnVzdC13ZWJzb2NrZXQgY2xhaW1zIGFyZSBiZXR0ZXI6XG4vLyBkb2Vzbid0IGRvIGFueXRoaW5nIGluIG9mZmxpbmUgbW9kZSAoPylcbi8vIFwibmF0aXZlbHkgYXdhcmUgb2YgZXJyb3IgY29kZXNcIlxuLy8gY2FuIGRvIGN1c3RvbSByZWNvbm5lY3Qgc3RyYXRlZ2llc1xuXG4vLyBUT0RPOiBpbmNvcnBvcmF0ZSB0aGUgYWJvdmUgbm90ZXNcbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBhcnR5U29ja2V0IGV4dGVuZHMgUmVjb25uZWN0aW5nV2ViU29ja2V0IHtcbiAgX3BrITogc3RyaW5nO1xuICBfcGt1cmwhOiBzdHJpbmc7XG4gIG5hbWUhOiBzdHJpbmc7XG4gIHJvb20/OiBzdHJpbmc7XG4gIGhvc3QhOiBzdHJpbmc7XG4gIHBhdGghOiBzdHJpbmc7XG4gIGJhc2VQYXRoPzogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHJlYWRvbmx5IHBhcnR5U29ja2V0T3B0aW9uczogUGFydHlTb2NrZXRPcHRpb25zKSB7XG4gICAgY29uc3Qgd3NPcHRpb25zID0gZ2V0V1NPcHRpb25zKHBhcnR5U29ja2V0T3B0aW9ucyk7XG5cbiAgICBzdXBlcih3c09wdGlvbnMudXJsUHJvdmlkZXIsIHdzT3B0aW9ucy5wcm90b2NvbHMsIHdzT3B0aW9ucy5zb2NrZXRPcHRpb25zKTtcblxuICAgIHRoaXMuc2V0V1NQcm9wZXJ0aWVzKHdzT3B0aW9ucyk7XG5cbiAgICBpZiAoIXBhcnR5U29ja2V0T3B0aW9ucy5zdGFydENsb3NlZCAmJiAhdGhpcy5yb29tICYmICF0aGlzLmJhc2VQYXRoKSB7XG4gICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiRWl0aGVyIHJvb20gb3IgYmFzZVBhdGggbXVzdCBiZSBwcm92aWRlZCB0byBjb25uZWN0LiBVc2Ugc3RhcnRDbG9zZWQ6IHRydWUgdG8gY3JlYXRlIGEgc29ja2V0IGFuZCBzZXQgdGhlbSB2aWEgdXBkYXRlUHJvcGVydGllcyBiZWZvcmUgY2FsbGluZyByZWNvbm5lY3QoKS5cIlxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIXBhcnR5U29ja2V0T3B0aW9ucy5kaXNhYmxlTmFtZVZhbGlkYXRpb24pIHtcbiAgICAgIGlmIChwYXJ0eVNvY2tldE9wdGlvbnMucGFydHk/LmluY2x1ZGVzKFwiL1wiKSkge1xuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFBhcnR5U29ja2V0OiBwYXJ0eSBuYW1lIFwiJHtwYXJ0eVNvY2tldE9wdGlvbnMucGFydHl9XCIgY29udGFpbnMgZm9yd2FyZCBzbGFzaCB3aGljaCBtYXkgY2F1c2Ugcm91dGluZyBpc3N1ZXMuIENvbnNpZGVyIHVzaW5nIGEgbmFtZSB3aXRob3V0IGZvcndhcmQgc2xhc2hlcyBvciBzZXQgZGlzYWJsZU5hbWVWYWxpZGF0aW9uOiB0cnVlIHRvIGJ5cGFzcyB0aGlzIHdhcm5pbmcuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnR5U29ja2V0T3B0aW9ucy5yb29tPy5pbmNsdWRlcyhcIi9cIikpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBQYXJ0eVNvY2tldDogcm9vbSBuYW1lIFwiJHtwYXJ0eVNvY2tldE9wdGlvbnMucm9vbX1cIiBjb250YWlucyBmb3J3YXJkIHNsYXNoIHdoaWNoIG1heSBjYXVzZSByb3V0aW5nIGlzc3Vlcy4gQ29uc2lkZXIgdXNpbmcgYSBuYW1lIHdpdGhvdXQgZm9yd2FyZCBzbGFzaGVzIG9yIHNldCBkaXNhYmxlTmFtZVZhbGlkYXRpb246IHRydWUgdG8gYnlwYXNzIHRoaXMgd2FybmluZy5gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHVibGljIHVwZGF0ZVByb3BlcnRpZXMocGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0aWFsPFBhcnR5U29ja2V0T3B0aW9ucz4pIHtcbiAgICBjb25zdCB3c09wdGlvbnMgPSBnZXRXU09wdGlvbnMoe1xuICAgICAgLi4udGhpcy5wYXJ0eVNvY2tldE9wdGlvbnMsXG4gICAgICAuLi5wYXJ0eVNvY2tldE9wdGlvbnMsXG4gICAgICBob3N0OiBwYXJ0eVNvY2tldE9wdGlvbnMuaG9zdCA/PyB0aGlzLmhvc3QsXG4gICAgICByb29tOiBwYXJ0eVNvY2tldE9wdGlvbnMucm9vbSA/PyB0aGlzLnJvb20sXG4gICAgICBwYXRoOiBwYXJ0eVNvY2tldE9wdGlvbnMucGF0aCA/PyB0aGlzLnBhdGgsXG4gICAgICBiYXNlUGF0aDogcGFydHlTb2NrZXRPcHRpb25zLmJhc2VQYXRoID8/IHRoaXMuYmFzZVBhdGhcbiAgICB9KTtcblxuICAgIHRoaXMuX3VybCA9IHdzT3B0aW9ucy51cmxQcm92aWRlcjtcbiAgICB0aGlzLl9wcm90b2NvbHMgPSB3c09wdGlvbnMucHJvdG9jb2xzO1xuICAgIHRoaXMuX29wdGlvbnMgPSB3c09wdGlvbnMuc29ja2V0T3B0aW9ucztcblxuICAgIHRoaXMuc2V0V1NQcm9wZXJ0aWVzKHdzT3B0aW9ucyk7XG4gIH1cblxuICBwcml2YXRlIHNldFdTUHJvcGVydGllcyh3c09wdGlvbnM6IFJldHVyblR5cGU8dHlwZW9mIGdldFdTT3B0aW9ucz4pIHtcbiAgICBjb25zdCB7IF9waywgX3BrdXJsLCBuYW1lLCByb29tLCBob3N0LCBwYXRoLCBiYXNlUGF0aCB9ID0gd3NPcHRpb25zO1xuXG4gICAgdGhpcy5fcGsgPSBfcGs7XG4gICAgdGhpcy5fcGt1cmwgPSBfcGt1cmw7XG4gICAgdGhpcy5uYW1lID0gbmFtZTtcbiAgICB0aGlzLnJvb20gPSByb29tO1xuICAgIHRoaXMuaG9zdCA9IGhvc3Q7XG4gICAgdGhpcy5wYXRoID0gcGF0aDtcbiAgICB0aGlzLmJhc2VQYXRoID0gYmFzZVBhdGg7XG4gIH1cblxuICBwdWJsaWMgcmVjb25uZWN0KFxuICAgIGNvZGU/OiBudW1iZXIgfCB1bmRlZmluZWQsXG4gICAgcmVhc29uPzogc3RyaW5nIHwgdW5kZWZpbmVkXG4gICk6IHZvaWQge1xuICAgIGlmICghdGhpcy5ob3N0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiVGhlIGhvc3QgbXVzdCBiZSBzZXQgYmVmb3JlIGNvbm5lY3RpbmcsIHVzZSBgdXBkYXRlUHJvcGVydGllc2AgbWV0aG9kIHRvIHNldCBpdCBvciBwYXNzIGl0IHRvIHRoZSBjb25zdHJ1Y3Rvci5cIlxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLnJvb20gJiYgIXRoaXMuYmFzZVBhdGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJUaGUgcm9vbSAob3IgYmFzZVBhdGgpIG11c3QgYmUgc2V0IGJlZm9yZSBjb25uZWN0aW5nLCB1c2UgYHVwZGF0ZVByb3BlcnRpZXNgIG1ldGhvZCB0byBzZXQgaXQgb3IgcGFzcyBpdCB0byB0aGUgY29uc3RydWN0b3IuXCJcbiAgICAgICk7XG4gICAgfVxuICAgIHN1cGVyLnJlY29ubmVjdChjb2RlLCByZWFzb24pO1xuICB9XG5cbiAgZ2V0IGlkKCkge1xuICAgIHJldHVybiB0aGlzLl9waztcbiAgfVxuXG4gIC8qKlxuICAgKiBFeHBvc2VzIHRoZSBzdGF0aWMgUGFydHlLaXQgcm9vbSBVUkwgd2l0aG91dCBhcHBseWluZyBxdWVyeSBwYXJhbWV0ZXJzLlxuICAgKiBUbyBhY2Nlc3MgdGhlIGN1cnJlbnRseSBjb25uZWN0ZWQgV2ViU29ja2V0IHVybCwgdXNlIFBhcnR5U29ja2V0I3VybC5cbiAgICovXG4gIGdldCByb29tVXJsKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuX3BrdXJsO1xuICB9XG5cbiAgLy8gYSBgZmV0Y2hgIG1ldGhvZCB0aGF0IHVzZXMgKGFsbW9zdCkgdGhlIHNhbWUgb3B0aW9ucyBhcyBgUGFydHlTb2NrZXRgXG4gIHN0YXRpYyBhc3luYyBmZXRjaChcbiAgICBvcHRpb25zOiBQYXJ0eUZldGNoT3B0aW9ucyxcbiAgICBpbml0PzogUmVxdWVzdEluaXRcbiAgKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICAgIGNvbnN0IHBhcnR5ID0gZ2V0UGFydHlJbmZvKG9wdGlvbnMsIFwiaHR0cFwiKTtcbiAgICBjb25zdCB1cmwgPVxuICAgICAgdHlwZW9mIHBhcnR5LnVybFByb3ZpZGVyID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gcGFydHkudXJsUHJvdmlkZXJcbiAgICAgICAgOiBhd2FpdCBwYXJ0eS51cmxQcm92aWRlcigpO1xuICAgIGNvbnN0IGRvRmV0Y2ggPSBvcHRpb25zLmZldGNoID8/IGZldGNoO1xuICAgIHJldHVybiBkb0ZldGNoKHVybCwgaW5pdCk7XG4gIH1cbn1cblxuZXhwb3J0IHsgUGFydHlTb2NrZXQgfTtcblxuZXhwb3J0IHsgUmVjb25uZWN0aW5nV2ViU29ja2V0IGFzIFdlYlNvY2tldCB9O1xuXG5mdW5jdGlvbiBnZXRXU09wdGlvbnMocGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0eVNvY2tldE9wdGlvbnMpIHtcbiAgY29uc3Qge1xuICAgIGlkLFxuICAgIGhvc3Q6IF9ob3N0LFxuICAgIHBhdGg6IF9wYXRoLFxuICAgIHBhcnR5OiBfcGFydHksXG4gICAgcm9vbTogX3Jvb20sXG4gICAgcHJvdG9jb2w6IF9wcm90b2NvbCxcbiAgICBxdWVyeTogX3F1ZXJ5LFxuICAgIHByb3RvY29scyxcbiAgICAuLi5zb2NrZXRPcHRpb25zXG4gIH0gPSBwYXJ0eVNvY2tldE9wdGlvbnM7XG5cbiAgY29uc3QgX3BrID0gaWQgfHwgZ2VuZXJhdGVVVUlEKCk7XG4gIGNvbnN0IHBhcnR5ID0gZ2V0UGFydHlJbmZvKHBhcnR5U29ja2V0T3B0aW9ucywgXCJ3c1wiLCB7IF9wayB9KTtcblxuICByZXR1cm4ge1xuICAgIF9wazogX3BrLFxuICAgIF9wa3VybDogcGFydHkucGFydHlVcmwsXG4gICAgbmFtZTogcGFydHkubmFtZSxcbiAgICByb29tOiBwYXJ0eS5yb29tLFxuICAgIGhvc3Q6IHBhcnR5Lmhvc3QsXG4gICAgcGF0aDogcGFydHkucGF0aCxcbiAgICBiYXNlUGF0aDogcGFydHlTb2NrZXRPcHRpb25zLmJhc2VQYXRoLFxuICAgIHByb3RvY29sczogcHJvdG9jb2xzLFxuICAgIHNvY2tldE9wdGlvbnM6IHNvY2tldE9wdGlvbnMsXG4gICAgdXJsUHJvdmlkZXI6IHBhcnR5LnVybFByb3ZpZGVyXG4gIH07XG59XG4iLCAiLyoqXG4gKiBjbGllbnQvcGFydHlidXMudHMgXHUyMDE0IGJyb3dzZXItc2lkZSBQYXJ0eUJ1cyBhZGFwdGVyLlxuICpcbiAqIFB1YmxpYyBBUEkgKGtlcHQgQllURS1GT1ItQllURSBpZGVudGljYWwgdG8gdGhlIGlubGluZSBQYXJ0eUJ1cyBibG9ja1xuICogdGhhdCBwcmV2aW91c2x5IGxpdmVkIGluIGVhY2ggSFRNTCwgc28gbm8gYnVzaW5lc3MtbG9naWMgY2FsbCBzaXRlIGhhc1xuICogdG8gY2hhbmdlKTpcbiAqXG4gKiAgIFBhcnR5QnVzLmVtaXQodHlwZSwgcGF5bG9hZCkgICAgICAgICAgIFx1MjAxNCBzZW5kIGNvbW1hbmQgdG8gc2VydmVyXG4gKiAgIFBhcnR5QnVzLm9uKHR5cGUsIGNiKSAgICAgICAgICAgICAgICAgIFx1MjAxNCBzdWJzY3JpYmUgdG8gc2VydmVyIGV2ZW50c1xuICpcbiAqIE5ldyAoYWRkaXRpdmUpIEFQSSBmb3IgUGhhc2UgMzpcbiAqXG4gKiAgIFBhcnR5QnVzLmluaXQoey4uLn0pICAgICAgICAgICAgICAgICAgIFx1MjAxNCBvcGVuIHRoZSBXZWJTb2NrZXRcbiAqICAgUGFydHlCdXMub25TdGF0dXMoY2IpICAgICAgICAgICAgICAgICAgXHUyMDE0IGNvbm5lY3Rpb24tc3RhdHVzIHVwZGF0ZXNcbiAqICAgUGFydHlCdXMuZ2V0U3RhdHVzKCkgICAgICAgICAgICAgICAgICAgXHUyMDE0IGN1cnJlbnQgY29ubmVjdGlvbiBzdGF0dXNcbiAqICAgUGFydHlCdXMuZ2V0Q29udHJvbENvZGUoKSAgICAgICAgICAgICAgXHUyMDE0IGFzc2lzdGFudC1zaWRlIGFjY2Vzc29yXG4gKlxuICogQnVuZGxlZCB0byAvcHVibGljL2xpYi9wYXJ0eWJ1cy5qcyBhcyBhbiBJSUZFOyBhc3NpZ25zIGB3aW5kb3cuUGFydHlCdXNgXG4gKiBzeW5jaHJvbm91c2x5IHNvIGxlZ2FjeSBpbmxpbmUgc2NyaXB0cyBjYW4gY2FsbCBQYXJ0eUJ1cy5lbWl0L29uIHdpdGhvdXRcbiAqIHdhaXRpbmcgZm9yIGEgbW9kdWxlIGxvYWQuXG4gKi9cblxuaW1wb3J0IFBhcnR5U29ja2V0IGZyb20gJ3BhcnR5c29ja2V0JztcblxudHlwZSBSb2xlID0gJ2Fzc2lzdGFudCcgfCAncHJlc2VudGVyJyB8ICdwYXJ0aWNpcGFudCc7XG50eXBlIFN0YXR1cyA9ICdjb25uZWN0aW5nJyB8ICdjb25uZWN0ZWQnIHwgJ2Rpc2Nvbm5lY3RlZCc7XG50eXBlIExpc3RlbmVyID0gKHBheWxvYWQ6IHVua25vd24pID0+IHZvaWQ7XG50eXBlIFN0YXR1c0xpc3RlbmVyID0gKHN0YXR1czogU3RhdHVzKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgSW5pdE9wdGlvbnMge1xuICByb2xlOiBSb2xlO1xuICByb29tSWQ6IHN0cmluZztcbiAgbmFtZT86IHN0cmluZzsgICAgICAgICAgICAvLyBwYXJ0aWNpcGFudCBvbmx5XG4gIHRlYW0/OiBzdHJpbmc7ICAgICAgICAgICAgLy8gcGFydGljaXBhbnQgb25seVxuICAvKipcbiAgICogUGVyLWRldmljZSBpZGVudGl0eSwgcGVyc2lzdGVkIGluIGxvY2FsU3RvcmFnZSBieSB0aGUgY2FsbGVyLiBNdWx0aXBsZVxuICAgKiB0YWJzIGZyb20gdGhlIHNhbWUgYnJvd3NlciBzaGFyZSB0aGlzOyBzZXJ2ZXIgdXNlcyBpdCB0byBkZWR1cCBzbyBvbmVcbiAgICogZGV2aWNlID0gb25lIHBhcnRpY2lwYW50IChcdTY1QjBcdTk1OEJcdTUyMDZcdTk4MDFcdThFMjJcdTYzODlcdTgyMEFcdTUyMDZcdTk4MDEsXHU1NDA4XHU0Rjc1XHU5MDMyXHU1NDBDXHU0RTAwXHU3RDQ0KVx1MzAwMlxuICAgKi9cbiAgZGV2aWNlSWQ/OiBzdHJpbmc7XG4gIC8qKiBPdmVycmlkZSBzZXJ2ZXIgaG9zdC4gRGVmYXVsdDogd2luZG93LmxvY2F0aW9uLmhvc3QgKHNhbWUtb3JpZ2luKS4gKi9cbiAgaG9zdD86IHN0cmluZztcbiAgLyoqIFBhcnR5S2l0IFwicGFydHlcIiBuYW1lLiBEZWZhdWx0OiAnbWFpbicuICovXG4gIHBhcnR5Pzogc3RyaW5nO1xufVxuXG5jb25zdCBTRVNTSU9OX1NUT1JBR0VfQ0NfS0VZID0gJ3BnZ19hc3Npc3RhbnRfY29udHJvbGNvZGVfdjEnO1xuXG5jbGFzcyBQYXJ0eUJ1c0ltcGwge1xuICBwcml2YXRlIGxpc3RlbmVycyA9IG5ldyBNYXA8c3RyaW5nLCBMaXN0ZW5lcltdPigpO1xuICBwcml2YXRlIHN0YXR1c0xpc3RlbmVyczogU3RhdHVzTGlzdGVuZXJbXSA9IFtdO1xuICBwcml2YXRlIHNvY2tldDogUGFydHlTb2NrZXQgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByb2xlOiBSb2xlIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY29udHJvbENvZGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAvLyBEZWZhdWx0ICdjb25uZWN0aW5nJyAobm90ICdkaXNjb25uZWN0ZWQnKSBzbyBhIGZyZXNobHktbG9hZGVkIHBhZ2Ugc2hvd3NcbiAgLy8gYSBuZXV0cmFsIFwid2FybWluZyB1cFwiIGluZGljYXRvciBpbnN0ZWFkIG9mIGEgc2NhcnkgcmVkIGRpc2Nvbm5lY3RlZFxuICAvLyBmbGFzaCBiZWZvcmUgaW5pdCgpIHJ1bnMuIFN0YXlzICdjb25uZWN0aW5nJyB1bnRpbCB0aGUgV2ViU29ja2V0IG9wZW5zXG4gIC8vIChvciBmYWlscykuIFBoYXNlIDAgcmVnICMzIFx1MjAxNCBcIlx1NjVCN1x1N0REQVx1NjNEMFx1NzkzQVx1NjYyRlx1NzU3MFx1NUUzOFx1NzJDMFx1NjE0QixcdTUyMURcdTU5Q0JcdThGMDlcdTUxNjVcdTRFMERcdThBNzJcdTg5RjhcdTc2N0NcIi5cbiAgcHJpdmF0ZSBzdGF0dXM6IFN0YXR1cyA9ICdjb25uZWN0aW5nJztcblxuICBpbml0KG9wdHM6IEluaXRPcHRpb25zKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuX2tpY2tlZCkge1xuICAgICAgY29uc29sZS53YXJuKCdQYXJ0eUJ1cy5pbml0IGlnbm9yZWQgXHUyMDE0IHRoaXMgdGFiIHdhcyBraWNrZWQgYnkgYW5vdGhlciB0YWInKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHRoaXMuc29ja2V0KSB7XG4gICAgICBjb25zb2xlLndhcm4oJ1BhcnR5QnVzLmluaXQgY2FsbGVkIG1vcmUgdGhhbiBvbmNlOyBpZ25vcmluZycpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLnJvbGUgPSBvcHRzLnJvbGU7XG5cbiAgICAvLyBSZXN0b3JlIHByZXZpb3VzbHktaXNzdWVkIGNvbnRyb2xDb2RlIGZyb20gc2Vzc2lvblN0b3JhZ2UgKGFzc2lzdGFudFxuICAgIC8vIHJlZnJlc2hpbmcgdGhlIHBhZ2Ugc2hvdWxkIG5vdCBsb3NlIGhvc3QgcHJpdmlsZWdlcykuXG4gICAgaWYgKG9wdHMucm9sZSA9PT0gJ2Fzc2lzdGFudCcpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IHNlc3Npb25TdG9yYWdlLmdldEl0ZW0oU0VTU0lPTl9TVE9SQUdFX0NDX0tFWSk7XG4gICAgICAgIGlmIChzdG9yZWQpIHRoaXMuY29udHJvbENvZGUgPSBzdG9yZWQ7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogc2Vzc2lvblN0b3JhZ2UgbWF5IGJlIGRpc2FibGVkIGluIHNvbWUgZW1iZWRkZWQgY29udGV4dHMgKi9cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBxdWVyeTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgcm9sZTogb3B0cy5yb2xlIH07XG4gICAgaWYgKG9wdHMubmFtZSkgcXVlcnkubmFtZSA9IG9wdHMubmFtZTtcbiAgICBpZiAob3B0cy50ZWFtKSBxdWVyeS50ZWFtID0gb3B0cy50ZWFtO1xuICAgIGlmIChvcHRzLmRldmljZUlkKSBxdWVyeS5kZXZpY2VJZCA9IG9wdHMuZGV2aWNlSWQ7XG4gICAgaWYgKG9wdHMucm9sZSA9PT0gJ2Fzc2lzdGFudCcgJiYgdGhpcy5jb250cm9sQ29kZSkge1xuICAgICAgcXVlcnkuY29udHJvbENvZGUgPSB0aGlzLmNvbnRyb2xDb2RlO1xuICAgIH1cblxuICAgIHRoaXMuc29ja2V0ID0gbmV3IFBhcnR5U29ja2V0KHtcbiAgICAgIGhvc3Q6IG9wdHMuaG9zdCA/PyB3aW5kb3cubG9jYXRpb24uaG9zdCxcbiAgICAgIHBhcnR5OiBvcHRzLnBhcnR5ID8/ICdtYWluJyxcbiAgICAgIHJvb206IG9wdHMucm9vbUlkLFxuICAgICAgcXVlcnksXG4gICAgfSk7XG5cbiAgICB0aGlzLnNldFN0YXR1cygnY29ubmVjdGluZycpO1xuXG4gICAgdGhpcy5zb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignb3BlbicsICgpID0+IHRoaXMuc2V0U3RhdHVzKCdjb25uZWN0ZWQnKSk7XG4gICAgdGhpcy5zb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignY2xvc2UnLCAoKSA9PiB0aGlzLnNldFN0YXR1cygnZGlzY29ubmVjdGVkJykpO1xuICAgIHRoaXMuc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgKCkgPT4gdGhpcy5zZXRTdGF0dXMoJ2Rpc2Nvbm5lY3RlZCcpKTtcblxuICAgIHRoaXMuc29ja2V0LmFkZEV2ZW50TGlzdGVuZXIoJ21lc3NhZ2UnLCAoZTogTWVzc2FnZUV2ZW50KSA9PiB7XG4gICAgICBsZXQgZW52OiB7IHR5cGU/OiBzdHJpbmc7IHBheWxvYWQ/OiB1bmtub3duIH07XG4gICAgICB0cnkge1xuICAgICAgICBlbnYgPSBKU09OLnBhcnNlKHR5cGVvZiBlLmRhdGEgPT09ICdzdHJpbmcnID8gZS5kYXRhIDogJycpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmICghZW52IHx8IHR5cGVvZiBlbnYudHlwZSAhPT0gJ3N0cmluZycpIHJldHVybjtcblxuICAgICAgLy8gS2VlcGFsaXZlOlx1NEVGQlx1NEY1NSBzZXJ2ZXIgXHU4QTBBXHU2MDZGXHU5MEZEXHU4QjQ5XHU2NjBFXHU5MDIzXHU3RERBXHU2RDNCXHU4NDU3XHUzMDAyXG4gICAgICB0aGlzLl9sYXN0TXNnQXQgPSBEYXRlLm5vdygpO1xuICAgICAgaWYgKGVudi50eXBlID09PSAnX19wb25nX18nKSB7XG4gICAgICAgIC8vIHNlcnZlciBcdTY1MkZcdTYzRjQgcG9uZyBcdTIxOTIgXHU1NTVGXHU3NTI4XHUzMDBDXHU1OTJBXHU0RTQ1XHU2QzkyXHU4QTBBXHU2MDZGXHU1QzMxXHU1RjM3XHU1MjM2XHU5MUNEXHU5MDIzXHUzMDBEXHU1MjI0XHU1QjlBXHUzMDAyXG4gICAgICAgIHRoaXMuX3BvbmdDYXBhYmxlID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuOyAvLyBcdTdEMTQga2VlcGFsaXZlIFx1OEEwQVx1Njg0NixcdTRFMERcdTc1MjggZGlzcGF0Y2hcbiAgICAgIH1cblxuICAgICAgLy8gSW50ZXJjZXB0IHNlcnZlci1wcml2YXRlIGZyYW1lcyBiZWZvcmUgZGlzcGF0Y2hpbmcuXG4gICAgICBpZiAoZW52LnR5cGUgPT09ICdfX3dlbGNvbWVfXycpIHtcbiAgICAgICAgY29uc3Qgd3AgPSBlbnYucGF5bG9hZCBhcyB7IGNvbnRyb2xDb2RlPzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh3cD8uY29udHJvbENvZGUgJiYgdGhpcy5yb2xlID09PSAnYXNzaXN0YW50Jykge1xuICAgICAgICAgIHRoaXMuY29udHJvbENvZGUgPSB3cC5jb250cm9sQ29kZTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgc2Vzc2lvblN0b3JhZ2Uuc2V0SXRlbShTRVNTSU9OX1NUT1JBR0VfQ0NfS0VZLCB3cC5jb250cm9sQ29kZSk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvKiBpZ25vcmUgKi9cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoZW52LnR5cGUgPT09ICdfX2Vycm9yX18nKSB7XG4gICAgICAgIC8vIFN1cmZhY2Ugc2VydmVyIGVycm9ycyB0byBjb25zb2xlIHNvIGRlYnVnZ2luZyBpcyBlYXNpZXI7IHN0aWxsXG4gICAgICAgIC8vIGRpc3BhdGNoIHRvIGxpc3RlbmVycyBpbiBjYXNlIHRoZSBIVE1MIHdhbnRzIHRvIHJlbmRlciBhbiBhbGVydC5cbiAgICAgICAgY29uc29sZS53YXJuKCdQYXJ0eUJ1cyBzZXJ2ZXIgZXJyb3I6JywgZW52LnBheWxvYWQpO1xuICAgICAgfSBlbHNlIGlmIChlbnYudHlwZSA9PT0gJ19fa2lja2VkX18nKSB7XG4gICAgICAgIC8vIFx1NTQwQyBkZXZpY2VJZCBcdTY1QjBcdTUyMDZcdTk4MDFcdTkwMzJcdTRGODYsc2VydmVyIFx1NjI4QVx1NjcyQ1x1OTAyM1x1N0REQVx1OEUyMlx1NjM4OVx1MzAwMlx1NkExOVx1OEExOFx1NzBCQSBraWNrZWQsXG4gICAgICAgIC8vIFx1NEUzQlx1NTJENSBjbG9zZSBcdTRFMjZcdTUwNUNcdTZCNjJcdTkxQ0RcdTkwMjMoXHU1NDI2XHU1MjQ3IHBhcnR5c29ja2V0IFx1NjcwM1x1ODFFQVx1NTJENVx1OTFDRFx1OTAyMyBcdTIxOTIgc2VydmVyIFx1NTNDOFxuICAgICAgICAvLyBcdThFMjJcdTY1QjBcdTUyMDZcdTk4MDEgXHUyMTkyIFx1NTE2OVx1OTA4QVx1NEU5Mlx1NzZGOFx1OEUyMlx1NzY4NFx1OEZGNFx1NTcwOClcdTMwMDJIVE1MIFx1OTBBM1x1OTA4QSBsaXN0ZW4gX19raWNrZWRfX1xuICAgICAgICAvLyBcdTk4NkZcdTc5M0FcdTYzRDBcdTc5M0FcdTMwMDJcbiAgICAgICAgdGhpcy5fa2lja2VkID0gdHJ1ZTtcbiAgICAgICAgdHJ5IHsgdGhpcy5zb2NrZXQ/LmNsb3NlKCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgICAgICB0aGlzLnNvY2tldCA9IG51bGw7XG4gICAgICAgIHRoaXMuX3N0b3BLZWVwYWxpdmUoKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5fZGlzcGF0Y2goZW52LnR5cGUsIGVudi5wYXlsb2FkKTtcbiAgICB9KTtcblxuICAgIHRoaXMuX3N0YXJ0S2VlcGFsaXZlKCk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gS2VlcGFsaXZlIFx1MjAxNCBcdTUzNEFcdTZCN0JcdTkwMjNcdTdEREFcdTUwNzVcdTZFMkNcbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIFRDUCBcdTkwMjNcdTdEREFcdTUzRUZcdTgwRkRcdTMwMENcdTVERjJcdTZCN0JcdTRGNDZcdTcwMEZcdTg5QkRcdTU2NjhcdTZDOTJcdTY1MzZcdTUyMzAgY2xvc2VcdTMwMEQoTkFUIHRpbWVvdXRcdTMwMDFcdTdEQjJcdTUzNjFcdTRGMTFcdTc3MjBcdTMwMDFcbiAgLy8gQVAgXHU2Mzg5XHU1MzA1XHU3QjQ5KTpcdThBMEFcdTYwNkZcdTVGOUVcdTZCNjRcdTY1MzZcdTRFMERcdTUyMzAscGFydHlzb2NrZXQgXHU0RTVGXHU0RTBEXHU2NzAzXHU5MUNEXHU5MDIzKFx1NUI4M1x1NTNFQVx1ODA3RFxuICAvLyBjbG9zZS9lcnJvcilcdTMwMDJcdTczRkVcdTU4MzRcdTc1QzdcdTcyQzA6XHU2Mjk1XHU1RjcxXHU3QUVGXHU1MzYxXHU1NzI4XHU4MjBBXHU3NTZCXHU5NzYyIH4zMCBcdTc5RDIsXHU3NkY0XHU1MjMwXHU3MDBGXHU4OUJEXHU1NjY4XHU4MUVBXHU1REYxXG4gIC8vIFx1NzY3Q1x1NzNGRVx1OTAyM1x1N0REQVx1NkI3Qlx1NEU4NiBcdTIxOTIgcGFydHlzb2NrZXQgXHU5MUNEXHU5MDIzIFx1MjE5MiBfX3Jvb21fc3RhdGVfXyBcdTVGRUJcdTcxNjdcdTYyOEFcdTc1NkJcdTk3NjJcdTY1NTFcdTU2REVcdTMwMDJcbiAgLy9cbiAgLy8gXHU1QzBEXHU3QjU2Olx1OTU5Mlx1N0Y2RVx1OEQ4NVx1OTA0RSBJRExFX1BJTkdfTVMgXHU1QzMxXHU5MDAxIHBpbmcoc2VydmVyIFx1NTZERSBfX3BvbmdfXztcdTRFRkJcdTRGNTVcbiAgLy8gc2VydmVyIFx1OEEwQVx1NjA2Rlx1OTBGRFx1NjcwM1x1NTIzN1x1NjVCMCBfbGFzdE1zZ0F0KTtcdTVCOENcdTUxNjhcdTZDODlcdTlFRDhcdThEODVcdTkwNEUgU1RBTEVfUkVDT05ORUNUX01TXG4gIC8vIFx1MjE5MiBcdTRFM0JcdTUyRDUgcmVjb25uZWN0KCksXHU4QjkzXHU1RkVCXHU3MTY3XHU3QUNCXHU1MjNCXHU5MDg0XHU1MzlGXHU3NTZCXHU5NzYyLFx1NEUwRFx1N0I0OVx1NzAwRlx1ODlCRFx1NTY2OFx1NjE2Mlx1NjE2Mlx1NzY3Q1x1NzNGRVx1MzAwMlxuICAvL1xuICAvLyBcdTc2RjhcdTVCQjlcdTYwMjc6XHU2NTM2XHU1MjMwXHU3QjJDXHU0RTAwXHU1MDBCIF9fcG9uZ19fIFx1NTI0RFx1NEUwRFx1NTU1Rlx1NTJENVx1NUYzN1x1NTIzNlx1OTFDRFx1OTAyMyhfcG9uZ0NhcGFibGUgZ2F0ZSksXG4gIC8vIFx1OTA3Rlx1NTE0RFx1MzAwQ1x1NTI0RFx1N0FFRlx1NURGMlx1NjZGNFx1NjVCMFx1MzAwMVBhcnR5S2l0IHNlcnZlciBcdTkwODRcdTZDOTIgZGVwbG95XHUzMDBEXHU3Njg0XHU3QTdBXHU3QTk3XHU2NzFGXHU1NzI4XHU1Qjg5XHU5NzVDXHU2MjNGXHU5NTkzXG4gIC8vIFx1NkJDRiAyNSBcdTc5RDJcdTc2N0RcdTc2N0RcdTkxQ0RcdTkwMjNcdTRFMDBcdTZCMjFcdTMwMDJcbiAgcHJpdmF0ZSBfbGFzdE1zZ0F0ID0gMDtcbiAgcHJpdmF0ZSBfcG9uZ0NhcGFibGUgPSBmYWxzZTtcbiAgcHJpdmF0ZSBfa2VlcGFsaXZlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuXG4gIHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IElETEVfUElOR19NUyA9IDhfMDAwO1xuICBwcml2YXRlIHN0YXRpYyByZWFkb25seSBTVEFMRV9SRUNPTk5FQ1RfTVMgPSAyNV8wMDA7XG5cbiAgcHJpdmF0ZSBfc3RhcnRLZWVwYWxpdmUoKTogdm9pZCB7XG4gICAgdGhpcy5fbGFzdE1zZ0F0ID0gRGF0ZS5ub3coKTtcbiAgICBpZiAodGhpcy5fa2VlcGFsaXZlVGltZXIpIGNsZWFySW50ZXJ2YWwodGhpcy5fa2VlcGFsaXZlVGltZXIpO1xuICAgIHRoaXMuX2tlZXBhbGl2ZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gdGhpcy5fa2VlcGFsaXZlVGljaygpLCA1XzAwMCk7XG4gICAgLy8gXHU2MjRCXHU2QTVGXHU4OUUzXHU5Mzk2IC8gXHU1MjA3XHU1NkRFXHU1MjA2XHU5ODAxIC8gXHU3REIyXHU4REVGXHU2MDYyXHU1RkE5Olx1N0FDQlx1NTIzQlx1NkFBMlx1NjdFNSxcdTRFMERcdTdCNDlcdTRFMEJcdTRFMDBcdTUwMEIgdGlja1x1MzAwMlxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdvbmxpbmUnLCAoKSA9PiB0aGlzLl9rZWVwYWxpdmVUaWNrKCkpO1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3Zpc2liaWxpdHljaGFuZ2UnLCAoKSA9PiB7XG4gICAgICBpZiAoZG9jdW1lbnQudmlzaWJpbGl0eVN0YXRlID09PSAndmlzaWJsZScpIHRoaXMuX2tlZXBhbGl2ZVRpY2soKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX3N0b3BLZWVwYWxpdmUoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuX2tlZXBhbGl2ZVRpbWVyKSB7XG4gICAgICBjbGVhckludGVydmFsKHRoaXMuX2tlZXBhbGl2ZVRpbWVyKTtcbiAgICAgIHRoaXMuX2tlZXBhbGl2ZVRpbWVyID0gbnVsbDtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9rZWVwYWxpdmVUaWNrKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLl9raWNrZWQgfHwgIXRoaXMuc29ja2V0KSByZXR1cm47XG4gICAgY29uc3QgaWRsZSA9IERhdGUubm93KCkgLSB0aGlzLl9sYXN0TXNnQXQ7XG4gICAgaWYgKHRoaXMuX3BvbmdDYXBhYmxlICYmIGlkbGUgPiBQYXJ0eUJ1c0ltcGwuU1RBTEVfUkVDT05ORUNUX01TKSB7XG4gICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgIGBQYXJ0eUJ1cyBrZWVwYWxpdmU6ICR7TWF0aC5yb3VuZChpZGxlIC8gMTAwMCl9cyBcdTZDOTJcdTY1MzZcdTUyMzBcdTRFRkJcdTRGNTUgc2VydmVyIFx1OEEwQVx1NjA2RiBcdTIwMTQgXHU1MjI0XHU1QjlBXHU5MDIzXHU3RERBXHU1MzRBXHU2QjdCLFx1NUYzN1x1NTIzNlx1OTFDRFx1OTAyM2BcbiAgICAgICk7XG4gICAgICB0aGlzLl9sYXN0TXNnQXQgPSBEYXRlLm5vdygpOyAvLyBcdTkxQ0RcdTkwMjNcdTY3MUZcdTk1OTNcdTRFMERcdTkxQ0RcdTg5MDdcdTg5RjhcdTc2N0NcbiAgICAgIHRoaXMuc2V0U3RhdHVzKCdjb25uZWN0aW5nJyk7XG4gICAgICB0cnkgeyB0aGlzLnNvY2tldC5yZWNvbm5lY3QoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgfSBlbHNlIGlmIChpZGxlID4gUGFydHlCdXNJbXBsLklETEVfUElOR19NUykge1xuICAgICAgLy8gXHU5NTkyXHU3RjZFXHU2MjREIHBpbmc7XHU2NzA5XHU2QjYzXHU1RTM4XHU1RUUzXHU2NEFEXHU2RDQxXHU5MUNGXHU2NjQyXHU0RTBEXHU1OTFBXHU1NjM0XHUzMDAyXG4gICAgICB0cnkgeyB0aGlzLmVtaXQoJ3BpbmcnLCB7IGZyb206IHRoaXMucm9sZSwga2VlcGFsaXZlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICB9XG4gIH1cblxuICAvKiogVHJ1ZSBhZnRlciBzZXJ2ZXIgc2VudCBfX2tpY2tlZF9fOyBlbWl0L2luaXQgYmVjb21lIG5vLW9wcy4gKi9cbiAgcHJpdmF0ZSBfa2lja2VkID0gZmFsc2U7XG5cbiAgLyoqXG4gICAqIFx1NEUzQlx1NTJENVx1NkMzOFx1NEU0NVx1OTZFMlx1N0REQTpcdTk1RENcdTk1ODlcdTkwMjNcdTdEREFcdTRFMjZcdTUwNUNcdTZCNjJcdTgxRUFcdTUyRDVcdTkxQ0RcdTkwMjMoXHU2NTM5XHU1NDBEXHU5MDNFXHU2NjQyXHU4OEFCXHU4QUNCXHU1MUZBXHU2MjNGXHU5NTkzXHU2NjQyXHU3NTI4KVx1MzAwMlxuICAgKiBcdTRFMERcdTkwMTlcdTZBMjNcdTUwNUFcdTc2ODRcdThBNzEgcGFydHlzb2NrZXQgXHU2NzAzXHU4MUVBXHU1MkQ1XHU5MUNEXHU5MDIzIFx1MjAxNFx1MjAxNCBcdTRFQkFcdTk2RDZcdTcxMzZcdTVERjJcdTg4QUJcdTc5RkJcdTUxRkFcdTU0MERcdTU1QUUsc29ja2V0XG4gICAqIFx1NEVDRFx1NjM5Qlx1ODQ1NyxcdTUyQTlcdTc0MDZcdTdBRUZcdTlFREVcdTU0MERcdTY3MDNcdTU5MUFcdTdCOTdcdTRFMDBcdTUwMEJcdTMwMDJcdTRFNEJcdTVGOEMgZW1pdC9pbml0IFx1OTBGRFx1OEI4QVx1NjIxMCBuby1vcFx1MzAwMlxuICAgKi9cbiAgZGlzY29ubmVjdCgpOiB2b2lkIHtcbiAgICB0aGlzLl9raWNrZWQgPSB0cnVlO1xuICAgIHRyeSB7IHRoaXMuc29ja2V0Py5jbG9zZSgpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBjbG9zaW5nICovIH1cbiAgICB0aGlzLnNvY2tldCA9IG51bGw7XG4gICAgdGhpcy5fc3RvcEtlZXBhbGl2ZSgpO1xuICAgIHRoaXMuc2V0U3RhdHVzKCdkaXNjb25uZWN0ZWQnKTtcbiAgfVxuXG4gIGVtaXQodHlwZTogc3RyaW5nLCBwYXlsb2FkPzogdW5rbm93bik6IHZvaWQge1xuICAgIGlmICghdGhpcy5zb2NrZXQpIHtcbiAgICAgIGNvbnNvbGUud2FybihgUGFydHlCdXMuZW1pdCgnJHt0eXBlfScpIGNhbGxlZCBiZWZvcmUgaW5pdCgpIFx1MjAxNCBkcm9wcGVkYCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGVudjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGUsIHBheWxvYWQgfTtcbiAgICAvLyBBdXRvLWF0dGFjaCBjb250cm9sQ29kZSBmb3IgYXNzaXN0YW50LWlzc3VlZCBjb21tYW5kcy4gU2VydmVyIG9ubHlcbiAgICAvLyByZXF1aXJlcyBpdCBmb3IgcHJpdmlsZWdlZCBvbmVzLCBidXQgYXR0YWNoaW5nIHRvIGFsbCBpcyBoYXJtbGVzc1xuICAgIC8vIGFuZCBhdm9pZHMgbmVlZGluZyBhIGR1cGxpY2F0ZSBcImlzIHRoaXMgcHJpdmlsZWdlZD9cIiB0YWJsZSBvbiB0aGVcbiAgICAvLyBjbGllbnQuXG4gICAgaWYgKHRoaXMucm9sZSA9PT0gJ2Fzc2lzdGFudCcgJiYgdGhpcy5jb250cm9sQ29kZSkge1xuICAgICAgZW52LmNvbnRyb2xDb2RlID0gdGhpcy5jb250cm9sQ29kZTtcbiAgICB9XG4gICAgdGhpcy5zb2NrZXQuc2VuZChKU09OLnN0cmluZ2lmeShlbnYpKTtcbiAgfVxuXG4gIG9uKHR5cGU6IHN0cmluZywgY2I6IExpc3RlbmVyKTogdm9pZCB7XG4gICAgbGV0IGFyciA9IHRoaXMubGlzdGVuZXJzLmdldCh0eXBlKTtcbiAgICBpZiAoIWFycikge1xuICAgICAgYXJyID0gW107XG4gICAgICB0aGlzLmxpc3RlbmVycy5zZXQodHlwZSwgYXJyKTtcbiAgICB9XG4gICAgYXJyLnB1c2goY2IpO1xuICB9XG5cbiAgb25TdGF0dXMoY2I6IFN0YXR1c0xpc3RlbmVyKTogdm9pZCB7XG4gICAgdGhpcy5zdGF0dXNMaXN0ZW5lcnMucHVzaChjYik7XG4gICAgLy8gUmVwbGF5IGN1cnJlbnQgc3RhdHVzIGltbWVkaWF0ZWx5IHNvIHN1YnNjcmliZXJzIGNhbiByZW5kZXIgY29ycmVjdGx5XG4gICAgLy8gZXZlbiBpZiB0aGV5IHJlZ2lzdGVyZWQgYWZ0ZXIgYSBjb25uZWN0aW9uIGV2ZW50LlxuICAgIHRyeSB7XG4gICAgICBjYih0aGlzLnN0YXR1cyk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdQYXJ0eUJ1cyBzdGF0dXMgbGlzdGVuZXIgZXJyb3I6JywgZXJyKTtcbiAgICB9XG4gIH1cblxuICBnZXRTdGF0dXMoKTogU3RhdHVzIHtcbiAgICByZXR1cm4gdGhpcy5zdGF0dXM7XG4gIH1cblxuICBnZXRDb250cm9sQ29kZSgpOiBzdHJpbmcgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jb250cm9sQ29kZTtcbiAgfVxuXG4gIC8qKiBUZXN0L2RlYnVnIGhlbHBlciBcdTIwMTQgZHJvcCB0aGUgc2F2ZWQgY29udHJvbENvZGUgc28gdGhlIG5leHQgaW5pdCgpXG4gICAqIGFjdHMgYXMgYSBmcmVzaCBhc3Npc3RhbnQgY29ubmVjdGlvbi4gTm90IHVzZWQgYnkgYXBwIGNvZGUuICovXG4gIGZvcmdldENvbnRyb2xDb2RlKCk6IHZvaWQge1xuICAgIHRoaXMuY29udHJvbENvZGUgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzZXNzaW9uU3RvcmFnZS5yZW1vdmVJdGVtKFNFU1NJT05fU1RPUkFHRV9DQ19LRVkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogaWdub3JlICovXG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIEludGVybmFsc1xuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBwcml2YXRlIF9kaXNwYXRjaCh0eXBlOiBzdHJpbmcsIHBheWxvYWQ6IHVua25vd24pOiB2b2lkIHtcbiAgICBjb25zdCBhcnIgPSB0aGlzLmxpc3RlbmVycy5nZXQodHlwZSk7XG4gICAgaWYgKCFhcnIpIHJldHVybjtcbiAgICBmb3IgKGNvbnN0IGNiIG9mIGFycikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2IocGF5bG9hZCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihgUGFydHlCdXMgbGlzdGVuZXJbJHt0eXBlfV0gZXJyb3I6YCwgZXJyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNldFN0YXR1cyhzOiBTdGF0dXMpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdGF0dXMgPT09IHMpIHJldHVybjtcbiAgICB0aGlzLnN0YXR1cyA9IHM7XG4gICAgZm9yIChjb25zdCBjYiBvZiB0aGlzLnN0YXR1c0xpc3RlbmVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2Iocyk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignUGFydHlCdXMgc3RhdHVzIGxpc3RlbmVyIGVycm9yOicsIGVycik7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmNvbnN0IFBhcnR5QnVzID0gbmV3IFBhcnR5QnVzSW1wbCgpO1xuKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgUGFydHlCdXM6IFBhcnR5QnVzSW1wbCB9KS5QYXJ0eUJ1cyA9IFBhcnR5QnVzO1xuZXhwb3J0IGRlZmF1bHQgUGFydHlCdXM7XG4iLCAiLyoqXG4gKiBjbGllbnQvYmFua2xvYWRlci50cyBcdTIwMTQgZmV0Y2ggdGhlIDUgQkFOSyBKU09OcyBmcm9tIC9kYXRhLyBhbmQgbm9ybWFsaXplXG4gKiB0aGVtIGludG8gdGhlIGZsYXQgc2hhcGUgdGhhdCB0aGUgdGhyZWUgSFRNTHMgZXhwZWN0LlxuICpcbiAqIFBoYXNlIDAgUTExIGRlcGxveW1lbnQgcGxhbjogQkFOSyBsaXZlcyBhdCAvcHVibGljL2RhdGEvIGFzIHN0YXRpY1xuICogSlNPTiwgc2VydmVkIGJ5IENsb3VkZmxhcmUgUGFnZXMuIEFsbCB0aHJlZSBjbGllbnRzIGZldGNoIG9uIGxvYWQuXG4gKiBTZXJ2ZXIgaXMgc3RpbGwgYXV0aG9yaXRhdGl2ZSBmb3IgcXVlc3Rpb24gc2VsZWN0aW9uIChnZXRzIGJ1bmRsZWRcbiAqIGNvcGllcyBhdCBidWlsZCB0aW1lKTsgY2xpZW50cyBvbmx5IG5lZWQgdGhlIGJhbmsgZm9yIGNvbnRlbnQgbG9va3VwXG4gKiAoc3RlbSAvIG9wdGlvbnMgLyBhbnN3ZXIgdGV4dCBnaXZlbiBhIHF1ZXN0aW9uIGlkKS5cbiAqXG4gKiBCdW5kbGVkIGludG8gdGhlIHNhbWUgSUlGRSBhcyBQYXJ0eUJ1cyBhbmQgZXhwb3NlZCBhdFxuICogYHdpbmRvdy5QR0dCYW5rTG9hZGVyYCBzbyB0aGUgZXhpc3RpbmcgaW5saW5lIHNjcmlwdHMgY2FuIGNhbGwgaXRcbiAqIHdpdGhvdXQgRVNNIGd5bW5hc3RpY3MuXG4gKi9cblxudHlwZSBEaWZmaWN1bHR5ID0gJ2Vhc3knIHwgJ21lZGl1bScgfCAnaGFyZCcgfCAnaGVsbCcgfCAncHVyZ2F0b3J5JztcblxuY29uc3QgQUxMX0RJRkZJQ1VMVElFUzogRGlmZmljdWx0eVtdID0gWydlYXN5JywgJ21lZGl1bScsICdoYXJkJywgJ2hlbGwnLCAncHVyZ2F0b3J5J107XG5cbmNvbnN0IElEX1BSRUZJWF9UT19ESUZGOiBSZWNvcmQ8c3RyaW5nLCBEaWZmaWN1bHR5PiA9IHtcbiAgRTogJ2Vhc3knLFxuICBNOiAnbWVkaXVtJyxcbiAgSDogJ2hhcmQnLFxuICBYOiAnaGVsbCcsXG4gIFA6ICdwdXJnYXRvcnknLFxufTtcblxuY29uc3QgU1lTVEVNX0FfVFlQRVMgPSBbJ3Nob3J0X2Fuc3dlcicsICdtdWx0aXBsZV9jaG9pY2UnLCAnZXNzYXknLCAnY2FsY3VsYXRpb24nLCAnd29yZF9nYW1lJ107XG5cbmludGVyZmFjZSBSYXdRdWVzdGlvbiB7XG4gIGlkOiBzdHJpbmc7XG4gIHRvcGljOiBzdHJpbmc7XG4gIHR5cGU/OiBzdHJpbmc7XG4gIFtrOiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgTm9ybWFsaXplZEJhbmsge1xuICBxdWVzdGlvbnM6IFJhd1F1ZXN0aW9uW107ICAgICAgICAgICAvLyBhbHdheXMgZmxhdCB3aXRoIGB0eXBlYCBmaWVsZFxuICBjb3VudDogbnVtYmVyO1xuICBieVR5cGU6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG4gIHVwbG9hZGVkQXQ6IHN0cmluZztcbiAgZmlsZW5hbWU6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBdXRvTG9hZE9wdGlvbnMge1xuICAvKiogUGF0aCBwcmVmaXggZm9yIGZldGNoLiBEZWZhdWx0OiAnZGF0YS8nIChyZWxhdGl2ZSBcdTIwMTQgd29ya3MgZmlsZTovLyArIGh0dHApLiAqL1xuICBiYXNlVXJsPzogc3RyaW5nO1xuICAvKiogRmlyZWQgYWZ0ZXIgZWFjaCBmaWxlIGlzIGxvYWRlZCAob3IgZmFpbHMpLiAqL1xuICBvblByb2dyZXNzPzogKGxvYWRlZDogbnVtYmVyLCB0b3RhbDogbnVtYmVyLCBkaWZmaWN1bHR5OiBEaWZmaWN1bHR5KSA9PiB2b2lkO1xuICAvKiogRmlyZWQgd2l0aCBlYWNoIHBlci1maWxlIGVycm9yLiAqL1xuICBvbkVycm9yPzogKGRpZmZpY3VsdHk6IERpZmZpY3VsdHksIG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBdXRvTG9hZFJlc3VsdCB7XG4gIG9rOiBib29sZWFuO1xuICBiYW5rczogUGFydGlhbDxSZWNvcmQ8RGlmZmljdWx0eSwgTm9ybWFsaXplZEJhbms+PjtcbiAgZXJyb3JzOiB7IGRpZmZpY3VsdHk6IERpZmZpY3VsdHk7IG1lc3NhZ2U6IHN0cmluZyB9W107XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZShkaWZmOiBEaWZmaWN1bHR5LCBwYXJzZWQ6IHVua25vd24sIGZpbGVuYW1lOiBzdHJpbmcpOiBOb3JtYWxpemVkQmFuayB7XG4gIGlmIChkaWZmID09PSAncHVyZ2F0b3J5Jykge1xuICAgIC8vIFN5c3RlbSBCOiBmbGF0IGFycmF5OyBlYWNoIGl0ZW0gaGFzIGl0cyBvd24gYHR5cGVgIGZpZWxkLlxuICAgIGNvbnN0IHJvb3QgPSBwYXJzZWQgYXMgeyBxdWVzdGlvbnM/OiBSYXdRdWVzdGlvbltdIH07XG4gICAgY29uc3QgYXJyID0gQXJyYXkuaXNBcnJheShyb290LnF1ZXN0aW9ucykgPyByb290LnF1ZXN0aW9ucyA6IFtdO1xuICAgIGNvbnN0IGJ5VHlwZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICAgIGZvciAoY29uc3QgcSBvZiBhcnIpIHtcbiAgICAgIGNvbnN0IHQgPSBxLnR5cGUgPz8gJ3Vua25vd24nO1xuICAgICAgYnlUeXBlW3RdID0gKGJ5VHlwZVt0XSA/PyAwKSArIDE7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBxdWVzdGlvbnM6IGFycixcbiAgICAgIGNvdW50OiBhcnIubGVuZ3RoLFxuICAgICAgYnlUeXBlLFxuICAgICAgdXBsb2FkZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgZmlsZW5hbWUsXG4gICAgfTtcbiAgfVxuICAvLyBTeXN0ZW0gQTogbmVzdGVkIHF1ZXN0aW9ucy48ZGlmZmljdWx0eT4uPHR5cGU+W107IGZsYXR0ZW4gYW5kIHN0YW1wIGB0eXBlYC5cbiAgY29uc3Qgcm9vdCA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgbGV0IGJhbms6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IGJ5RGlmZiA9IChyb290LnF1ZXN0aW9ucyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCk/LltkaWZmXTtcbiAgaWYgKGJ5RGlmZiAmJiB0eXBlb2YgYnlEaWZmID09PSAnb2JqZWN0JykgYmFuayA9IGJ5RGlmZiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgZWxzZSBpZiAocm9vdFtkaWZmXSAmJiB0eXBlb2Ygcm9vdFtkaWZmXSA9PT0gJ29iamVjdCcpIGJhbmsgPSByb290W2RpZmZdIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBlbHNlIGlmIChyb290LnF1ZXN0aW9ucyAmJiB0eXBlb2Ygcm9vdC5xdWVzdGlvbnMgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHJvb3QucXVlc3Rpb25zKSkge1xuICAgIGJhbmsgPSByb290LnF1ZXN0aW9ucyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfVxuICBpZiAoIWJhbmspIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGV4cGVjdGVkIG5lc3RlZCBxdWVzdGlvbnMuJHtkaWZmfS48dHlwZT4gc3RydWN0dXJlYCk7XG4gIH1cbiAgY29uc3QgZmxhdDogUmF3UXVlc3Rpb25bXSA9IFtdO1xuICBjb25zdCBieVR5cGU6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcbiAgZm9yIChjb25zdCB0IG9mIFNZU1RFTV9BX1RZUEVTKSB7XG4gICAgY29uc3QgYXJyID0gYmFua1t0XTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoYXJyKSkgY29udGludWU7XG4gICAgZm9yIChjb25zdCByYXcgb2YgYXJyIGFzIFJhd1F1ZXN0aW9uW10pIHtcbiAgICAgIGZsYXQucHVzaCh7IC4uLnJhdywgdHlwZTogdCB9KTtcbiAgICB9XG4gICAgYnlUeXBlW3RdID0gYXJyLmxlbmd0aDtcbiAgfVxuICBpZiAoZmxhdC5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYG5vIHF1ZXN0aW9ucyBmb3VuZCBpbiBuZXN0ZWQgc3RydWN0dXJlIGZvciAke2RpZmZ9YCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBxdWVzdGlvbnM6IGZsYXQsXG4gICAgY291bnQ6IGZsYXQubGVuZ3RoLFxuICAgIGJ5VHlwZSxcbiAgICB1cGxvYWRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgZmlsZW5hbWUsXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRPbmUoZGlmZjogRGlmZmljdWx0eSwgYmFzZVVybDogc3RyaW5nKTogUHJvbWlzZTxOb3JtYWxpemVkQmFuaz4ge1xuICBjb25zdCBmaWxlbmFtZSA9IGBpbnN1cmFuY2UtcXVpei1iYW5rLSR7ZGlmZn0uanNvbmA7XG4gIGNvbnN0IHVybCA9IGAke2Jhc2VVcmx9JHtmaWxlbmFtZX1gO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgY2FjaGU6ICduby1jYWNoZScgfSk7XG4gIGlmICghcmVzLm9rKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzLnN0YXR1c30gZmV0Y2hpbmcgJHt1cmx9YCk7XG4gIH1cbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBKU09OIHBhcnNlIGZhaWxlZCBmb3IgJHtmaWxlbmFtZX06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZShkaWZmLCBwYXJzZWQsIGZpbGVuYW1lKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXV0b0xvYWQob3B0czogQXV0b0xvYWRPcHRpb25zID0ge30pOiBQcm9taXNlPEF1dG9Mb2FkUmVzdWx0PiB7XG4gIGNvbnN0IGJhc2VVcmwgPSBvcHRzLmJhc2VVcmwgPz8gJ2RhdGEvJztcbiAgY29uc3QgYmFua3M6IFBhcnRpYWw8UmVjb3JkPERpZmZpY3VsdHksIE5vcm1hbGl6ZWRCYW5rPj4gPSB7fTtcbiAgY29uc3QgZXJyb3JzOiBBdXRvTG9hZFJlc3VsdFsnZXJyb3JzJ10gPSBbXTtcbiAgbGV0IGxvYWRlZCA9IDA7XG4gIC8vIExvYWQgaW4gcGFyYWxsZWwgXHUyMDE0IDUgc21hbGwgZmlsZXMsIG5vIG5lZWQgdG8gc2VyaWFsaXplLlxuICBhd2FpdCBQcm9taXNlLmFsbChcbiAgICBBTExfRElGRklDVUxUSUVTLm1hcChhc3luYyAoZGlmZikgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYmFuayA9IGF3YWl0IGxvYWRPbmUoZGlmZiwgYmFzZVVybCk7XG4gICAgICAgIGJhbmtzW2RpZmZdID0gYmFuaztcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgICAgICBlcnJvcnMucHVzaCh7IGRpZmZpY3VsdHk6IGRpZmYsIG1lc3NhZ2U6IG1zZyB9KTtcbiAgICAgICAgb3B0cy5vbkVycm9yPy4oZGlmZiwgbXNnKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGxvYWRlZCArPSAxO1xuICAgICAgICBvcHRzLm9uUHJvZ3Jlc3M/Lihsb2FkZWQsIEFMTF9ESUZGSUNVTFRJRVMubGVuZ3RoLCBkaWZmKTtcbiAgICAgIH1cbiAgICB9KVxuICApO1xuICByZXR1cm4ge1xuICAgIG9rOiBlcnJvcnMubGVuZ3RoID09PSAwLFxuICAgIGJhbmtzLFxuICAgIGVycm9ycyxcbiAgfTtcbn1cblxuLyoqXG4gKiBIZWxwZXIgZm9yIGNsaWVudHMgd2l0aCBhIGBCQU5LX1NDSEVNQWAgdGFibGUgd2hlcmUgZWFjaCBkaWZmaWN1bHR5IGhhc1xuICogYSBgcHJlZml4YCAoRS9NL0gvWC9QKS4gVXNlZnVsIGZvciBgZ2V0UXVlc3Rpb25CeUlkKGlkKWAgbG9va3Vwcy5cbiAqL1xuZnVuY3Rpb24gZGlmZmljdWx0eUZvcklkKGlkOiBzdHJpbmcpOiBEaWZmaWN1bHR5IHwgbnVsbCB7XG4gIGNvbnN0IHByZWZpeCA9IGlkPy5bMF0/LnRvVXBwZXJDYXNlPy4oKTtcbiAgcmV0dXJuIHByZWZpeCA/IChJRF9QUkVGSVhfVE9fRElGRltwcmVmaXhdID8/IG51bGwpIDogbnVsbDtcbn1cblxuY29uc3QgUEdHQmFua0xvYWRlciA9IHtcbiAgYXV0b0xvYWQsXG4gIGRpZmZpY3VsdHlGb3JJZCxcbn07XG5cbih3aW5kb3cgYXMgdW5rbm93biBhcyB7IFBHR0JhbmtMb2FkZXI6IHR5cGVvZiBQR0dCYW5rTG9hZGVyIH0pLlBHR0JhbmtMb2FkZXIgPSBQR0dCYW5rTG9hZGVyO1xuXG5leHBvcnQgZGVmYXVsdCBQR0dCYW5rTG9hZGVyO1xuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBV0EsTUFBSSxDQUFDLFdBQVcsZUFBZSxDQUFDLFdBQVc7Ozs7Ozs7OztDQVkzQztNQUNFLGFBQUEsY0FBQSxNQUFBO0lBQ0E7SUFFQTtJQUNFLFlBQU0sT0FBUyxRQUFPO0FBQ3RCLFlBQUssU0FBVSxNQUFNO0FBQ3JCLFdBQUssVUFBUSxNQUFBOzs7RUFJakI7TUFDRSxhQUFBLGNBQUEsTUFBQTtJQUNBO0lBQ0E7SUFFQSxXQUFZO0lBQ1YsWUFBTSxPQUFTLEtBQU8sU0FBQSxJQUFBLFFBQUE7QUFDdEIsWUFBSyxTQUFPLE1BQUE7QUFDWixXQUFLLE9BQVM7OztFQVVsQjtNQUNFLFNBQUE7SUFDQTtJQUNBO0lBQ0Q7RUFFRDtBQUNFLFdBQUssT0FDSCxXQUFVLEtBQUE7O0VBSWQ7QUFFRSxXQUFPLGtCQUEyQixHQUFFOztFQUd0QztBQUNFLFdBQUksZUFFRixHQURZO0FBSWQsUUFBSSxVQUFVLEVBQUEsUUFBSyxJQUFBLGFBQ0wsRUFBQSxNQUFJLENBQUE7QUFVbEIsUUFBSSxVQUFXLEtBRWIsWUFEZ0I7QUFLbEIsYUFEWSxJQUFJLFdBQWMsRUFBRSxRQUFBLE1BQUEsRUFBQSxVQUFBLGtCQUFBLENBQUE7O0FBSWxDLFdBQU0sSUFBQSxNQUNKLEVBQUEsTUFBTyxDQUFBO0VBT1Q7QUFHQSxNQUFNLFNBa0JOLE9BQU0sWUFBVSxlQUNkLE9BQUEsUUFBQSxVQUFzQixTQUFBO01BQ3RCLGdCQUNBLE9BQUEsY0FBVyxlQUFBLFVBQUEsWUFBQTtNQUNY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
