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
  var PartyBusImpl = class {
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
        }
        this._dispatch(env.type, env.payload);
      });
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vbm9kZV9tb2R1bGVzL3BhcnR5c29ja2V0L3NyYy93cy50cyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcGFydHlzb2NrZXQvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2NsaWVudC9wYXJ0eWJ1cy50cyIsICIuLi8uLi9jbGllbnQvYmFua2xvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gVE9ETzogbG9zZSB0aGlzIGVzbGludC1kaXNhYmxlXG5cbi8qIVxuICogUmVjb25uZWN0aW5nIFdlYlNvY2tldFxuICogYnkgUGVkcm8gTGFkYXJpYSA8cGVkcm8ubGFkYXJpYUBnbWFpbC5jb20+XG4gKiBodHRwczovL2dpdGh1Yi5jb20vcGxhZGFyaWEvcmVjb25uZWN0aW5nLXdlYnNvY2tldFxuICogTGljZW5zZSBNSVRcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFR5cGVkRXZlbnRUYXJnZXQgfSBmcm9tIFwiLi90eXBlLWhlbHBlclwiO1xuXG5pZiAoIWdsb2JhbFRoaXMuRXZlbnRUYXJnZXQgfHwgIWdsb2JhbFRoaXMuRXZlbnQpIHtcbiAgY29uc29sZS5lcnJvcihgXG4gIFBhcnR5U29ja2V0IHJlcXVpcmVzIGEgZ2xvYmFsICdFdmVudFRhcmdldCcgY2xhc3MgdG8gYmUgYXZhaWxhYmxlIVxuICBZb3UgY2FuIHBvbHlmaWxsIHRoaXMgZ2xvYmFsIGJ5IGFkZGluZyB0aGlzIHRvIHlvdXIgY29kZSBiZWZvcmUgYW55IHBhcnR5c29ja2V0IGltcG9ydHM6IFxuICBcbiAgXFxgXFxgXFxgXG4gIGltcG9ydCAncGFydHlzb2NrZXQvZXZlbnQtdGFyZ2V0LXBvbHlmaWxsJztcbiAgXFxgXFxgXFxgXG4gIFBsZWFzZSBmaWxlIGFuIGlzc3VlIGF0IGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJ0eWtpdC9wYXJ0eWtpdCBpZiB5b3UncmUgc3RpbGwgaGF2aW5nIHRyb3VibGUuXG5gKTtcbn1cblxuZXhwb3J0IGNsYXNzIEVycm9yRXZlbnQgZXh0ZW5kcyBFdmVudCB7XG4gIHB1YmxpYyBtZXNzYWdlOiBzdHJpbmc7XG4gIHB1YmxpYyBlcnJvcjogRXJyb3I7XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgY29uc3RydWN0b3IoZXJyb3I6IEVycm9yLCB0YXJnZXQ6IGFueSkge1xuICAgIHN1cGVyKFwiZXJyb3JcIiwgdGFyZ2V0KTtcbiAgICB0aGlzLm1lc3NhZ2UgPSBlcnJvci5tZXNzYWdlO1xuICAgIHRoaXMuZXJyb3IgPSBlcnJvcjtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgQ2xvc2VFdmVudCBleHRlbmRzIEV2ZW50IHtcbiAgcHVibGljIGNvZGU6IG51bWJlcjtcbiAgcHVibGljIHJlYXNvbjogc3RyaW5nO1xuICBwdWJsaWMgd2FzQ2xlYW4gPSB0cnVlO1xuICAvLyBveGxpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tZXhwbGljaXQtYW55XG4gIGNvbnN0cnVjdG9yKGNvZGUgPSAxMDAwLCByZWFzb24gPSBcIlwiLCB0YXJnZXQ6IGFueSkge1xuICAgIHN1cGVyKFwiY2xvc2VcIiwgdGFyZ2V0KTtcbiAgICB0aGlzLmNvZGUgPSBjb2RlO1xuICAgIHRoaXMucmVhc29uID0gcmVhc29uO1xuICB9XG59XG5leHBvcnQgaW50ZXJmYWNlIFdlYlNvY2tldEV2ZW50TWFwIHtcbiAgY2xvc2U6IENsb3NlRXZlbnQ7XG4gIGVycm9yOiBFcnJvckV2ZW50O1xuICBtZXNzYWdlOiBNZXNzYWdlRXZlbnQ7XG4gIG9wZW46IEV2ZW50O1xufVxuXG5jb25zdCBFdmVudHMgPSB7XG4gIEV2ZW50LFxuICBFcnJvckV2ZW50LFxuICBDbG9zZUV2ZW50XG59O1xuXG5mdW5jdGlvbiBhc3NlcnQoY29uZGl0aW9uOiB1bmtub3duLCBtc2c/OiBzdHJpbmcpOiBhc3NlcnRzIGNvbmRpdGlvbiB7XG4gIGlmICghY29uZGl0aW9uKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xvbmVFdmVudEJyb3dzZXIoZTogRXZlbnQpIHtcbiAgLy8gb3hsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWV4cGxpY2l0LWFueVxuICByZXR1cm4gbmV3IChlIGFzIGFueSkuY29uc3RydWN0b3IoZS50eXBlLCBlKSBhcyBFdmVudDtcbn1cblxuZnVuY3Rpb24gY2xvbmVFdmVudE5vZGUoZTogRXZlbnQpIHtcbiAgaWYgKFwiZGF0YVwiIGluIGUpIHtcbiAgICBjb25zdCBldnQgPSBuZXcgTWVzc2FnZUV2ZW50KGUudHlwZSwgZSk7XG4gICAgcmV0dXJuIGV2dDtcbiAgfVxuXG4gIGlmIChcImNvZGVcIiBpbiBlIHx8IFwicmVhc29uXCIgaW4gZSkge1xuICAgIGNvbnN0IGV2dCA9IG5ldyBDbG9zZUV2ZW50KFxuICAgICAgLy8gQHRzLWV4cGVjdC1lcnJvciB3ZSBuZWVkIHRvIGZpeCBldmVudC9saXN0ZW5lciB0eXBlc1xuICAgICAgKGUuY29kZSB8fCAxOTk5KSBhcyBudW1iZXIsXG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIHdlIG5lZWQgdG8gZml4IGV2ZW50L2xpc3RlbmVyIHR5cGVzXG4gICAgICAoZS5yZWFzb24gfHwgXCJ1bmtub3duIHJlYXNvblwiKSBhcyBzdHJpbmcsXG4gICAgICBlXG4gICAgKTtcbiAgICByZXR1cm4gZXZ0O1xuICB9XG5cbiAgaWYgKFwiZXJyb3JcIiBpbiBlKSB7XG4gICAgY29uc3QgZXZ0ID0gbmV3IEVycm9yRXZlbnQoZS5lcnJvciBhcyBFcnJvciwgZSk7XG4gICAgcmV0dXJuIGV2dDtcbiAgfVxuXG4gIGNvbnN0IGV2dCA9IG5ldyBFdmVudChlLnR5cGUsIGUpO1xuICByZXR1cm4gZXZ0O1xufVxuXG5jb25zdCBpc05vZGUgPVxuICB0eXBlb2YgcHJvY2VzcyAhPT0gXCJ1bmRlZmluZWRcIiAmJlxuICB0eXBlb2YgcHJvY2Vzcy52ZXJzaW9ucz8ubm9kZSAhPT0gXCJ1bmRlZmluZWRcIjtcblxuLy8gUmVhY3QgTmF0aXZlIGhhcyBwcm9jZXNzIGFuZCBkb2N1bWVudCBwb2x5ZmlsbGVkIGJ1dCBub3QgcHJvY2Vzcy52ZXJzaW9ucy5ub2RlXG4vLyBJdCBuZWVkcyBOb2RlLXN0eWxlIGV2ZW50IGNsb25pbmcgYmVjYXVzZSBicm93c2VyLXN0eWxlIGNsb25pbmcgcHJvZHVjZXNcbi8vIGV2ZW50cyB0aGF0IGZhaWwgaW5zdGFuY2VvZiBFdmVudCBjaGVja3MgaW4gZXZlbnQtdGFyZ2V0LXBvbHlmaWxsXG4vLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9jbG91ZGZsYXJlL3BhcnR5a2l0L2lzc3Vlcy8yNTdcbmNvbnN0IGlzUmVhY3ROYXRpdmUgPVxuICB0eXBlb2YgbmF2aWdhdG9yICE9PSBcInVuZGVmaW5lZFwiICYmIG5hdmlnYXRvci5wcm9kdWN0ID09PSBcIlJlYWN0TmF0aXZlXCI7XG5cbmNvbnN0IGNsb25lRXZlbnQgPSBpc05vZGUgfHwgaXNSZWFjdE5hdGl2ZSA/IGNsb25lRXZlbnROb2RlIDogY2xvbmVFdmVudEJyb3dzZXI7XG5cbmV4cG9ydCB0eXBlIE9wdGlvbnMgPSB7XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgV2ViU29ja2V0PzogYW55O1xuICBtYXhSZWNvbm5lY3Rpb25EZWxheT86IG51bWJlcjtcbiAgbWluUmVjb25uZWN0aW9uRGVsYXk/OiBudW1iZXI7XG4gIHJlY29ubmVjdGlvbkRlbGF5R3Jvd0ZhY3Rvcj86IG51bWJlcjtcbiAgbWluVXB0aW1lPzogbnVtYmVyO1xuICBjb25uZWN0aW9uVGltZW91dD86IG51bWJlcjtcbiAgbWF4UmV0cmllcz86IG51bWJlcjtcbiAgbWF4RW5xdWV1ZWRNZXNzYWdlcz86IG51bWJlcjtcbiAgc3RhcnRDbG9zZWQ/OiBib29sZWFuO1xuICBkZWJ1Zz86IGJvb2xlYW47XG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBuby1leHBsaWNpdC1hbnlcbiAgZGVidWdMb2dnZXI/OiAoLi4uYXJnczogYW55W10pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUID0ge1xuICBtYXhSZWNvbm5lY3Rpb25EZWxheTogMTAwMDAsXG4gIG1pblJlY29ubmVjdGlvbkRlbGF5OiAxMDAwICsgTWF0aC5yYW5kb20oKSAqIDQwMDAsXG4gIG1pblVwdGltZTogNTAwMCxcbiAgcmVjb25uZWN0aW9uRGVsYXlHcm93RmFjdG9yOiAxLjMsXG4gIGNvbm5lY3Rpb25UaW1lb3V0OiA0MDAwLFxuICBtYXhSZXRyaWVzOiBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFksXG4gIG1heEVucXVldWVkTWVzc2FnZXM6IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSxcbiAgc3RhcnRDbG9zZWQ6IGZhbHNlLFxuICBkZWJ1ZzogZmFsc2Vcbn07XG5cbmxldCBkaWRXYXJuQWJvdXRNaXNzaW5nV2ViU29ja2V0ID0gZmFsc2U7XG5cbmV4cG9ydCB0eXBlIFVybFByb3ZpZGVyID0gc3RyaW5nIHwgKCgpID0+IHN0cmluZykgfCAoKCkgPT4gUHJvbWlzZTxzdHJpbmc+KTtcbmV4cG9ydCB0eXBlIFByb3RvY29sc1Byb3ZpZGVyID1cbiAgfCBudWxsXG4gIHwgc3RyaW5nXG4gIHwgc3RyaW5nW11cbiAgfCAoKCkgPT4gc3RyaW5nIHwgc3RyaW5nW10gfCBudWxsKVxuICB8ICgoKSA9PiBQcm9taXNlPHN0cmluZyB8IHN0cmluZ1tdIHwgbnVsbD4pO1xuXG5leHBvcnQgdHlwZSBNZXNzYWdlID1cbiAgfCBzdHJpbmdcbiAgfCBBcnJheUJ1ZmZlclxuICB8IEJsb2JcbiAgfCBBcnJheUJ1ZmZlclZpZXc8QXJyYXlCdWZmZXI+O1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBSZWNvbm5lY3RpbmdXZWJTb2NrZXQgZXh0ZW5kcyAoRXZlbnRUYXJnZXQgYXMgVHlwZWRFdmVudFRhcmdldDxXZWJTb2NrZXRFdmVudE1hcD4pIHtcbiAgcHJpdmF0ZSBfd3M6IFdlYlNvY2tldCB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfcmV0cnlDb3VudCA9IC0xO1xuICBwcml2YXRlIF91cHRpbWVUaW1lb3V0OiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBfY29ubmVjdFRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIF9zaG91bGRSZWNvbm5lY3QgPSB0cnVlO1xuICBwcml2YXRlIF9jb25uZWN0TG9jayA9IGZhbHNlO1xuICBwcml2YXRlIF9iaW5hcnlUeXBlOiBCaW5hcnlUeXBlID0gXCJibG9iXCI7XG4gIHByaXZhdGUgX2Nsb3NlQ2FsbGVkID0gZmFsc2U7XG4gIHByaXZhdGUgX21lc3NhZ2VRdWV1ZTogTWVzc2FnZVtdID0gW107XG5cbiAgcHJpdmF0ZSBfZGVidWdMb2dnZXIgPSBjb25zb2xlLmxvZy5iaW5kKGNvbnNvbGUpO1xuXG4gIHByb3RlY3RlZCBfdXJsOiBVcmxQcm92aWRlcjtcbiAgcHJvdGVjdGVkIF9wcm90b2NvbHM/OiBQcm90b2NvbHNQcm92aWRlcjtcbiAgcHJvdGVjdGVkIF9vcHRpb25zOiBPcHRpb25zO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHVybDogVXJsUHJvdmlkZXIsXG4gICAgcHJvdG9jb2xzPzogUHJvdG9jb2xzUHJvdmlkZXIsXG4gICAgb3B0aW9uczogT3B0aW9ucyA9IHt9XG4gICkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5fdXJsID0gdXJsO1xuICAgIHRoaXMuX3Byb3RvY29scyA9IHByb3RvY29scztcbiAgICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgICBpZiAodGhpcy5fb3B0aW9ucy5zdGFydENsb3NlZCkge1xuICAgICAgdGhpcy5fc2hvdWxkUmVjb25uZWN0ID0gZmFsc2U7XG4gICAgfVxuICAgIGlmICh0aGlzLl9vcHRpb25zLmRlYnVnTG9nZ2VyKSB7XG4gICAgICB0aGlzLl9kZWJ1Z0xvZ2dlciA9IHRoaXMuX29wdGlvbnMuZGVidWdMb2dnZXI7XG4gICAgfVxuICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgfVxuXG4gIHN0YXRpYyBnZXQgQ09OTkVDVElORygpIHtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBzdGF0aWMgZ2V0IE9QRU4oKSB7XG4gICAgcmV0dXJuIDE7XG4gIH1cbiAgc3RhdGljIGdldCBDTE9TSU5HKCkge1xuICAgIHJldHVybiAyO1xuICB9XG4gIHN0YXRpYyBnZXQgQ0xPU0VEKCkge1xuICAgIHJldHVybiAzO1xuICB9XG5cbiAgZ2V0IENPTk5FQ1RJTkcoKSB7XG4gICAgcmV0dXJuIFJlY29ubmVjdGluZ1dlYlNvY2tldC5DT05ORUNUSU5HO1xuICB9XG4gIGdldCBPUEVOKCkge1xuICAgIHJldHVybiBSZWNvbm5lY3RpbmdXZWJTb2NrZXQuT1BFTjtcbiAgfVxuICBnZXQgQ0xPU0lORygpIHtcbiAgICByZXR1cm4gUmVjb25uZWN0aW5nV2ViU29ja2V0LkNMT1NJTkc7XG4gIH1cbiAgZ2V0IENMT1NFRCgpIHtcbiAgICByZXR1cm4gUmVjb25uZWN0aW5nV2ViU29ja2V0LkNMT1NFRDtcbiAgfVxuXG4gIGdldCBiaW5hcnlUeXBlKCkge1xuICAgIHJldHVybiB0aGlzLl93cyA/IHRoaXMuX3dzLmJpbmFyeVR5cGUgOiB0aGlzLl9iaW5hcnlUeXBlO1xuICB9XG5cbiAgc2V0IGJpbmFyeVR5cGUodmFsdWU6IEJpbmFyeVR5cGUpIHtcbiAgICB0aGlzLl9iaW5hcnlUeXBlID0gdmFsdWU7XG4gICAgaWYgKHRoaXMuX3dzKSB7XG4gICAgICB0aGlzLl93cy5iaW5hcnlUeXBlID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIG51bWJlciBvciBjb25uZWN0aW9uIHJldHJpZXNcbiAgICovXG4gIGdldCByZXRyeUNvdW50KCk6IG51bWJlciB7XG4gICAgcmV0dXJuIE1hdGgubWF4KHRoaXMuX3JldHJ5Q291bnQsIDApO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBudW1iZXIgb2YgYnl0ZXMgb2YgZGF0YSB0aGF0IGhhdmUgYmVlbiBxdWV1ZWQgdXNpbmcgY2FsbHMgdG8gc2VuZCgpIGJ1dCBub3QgeWV0XG4gICAqIHRyYW5zbWl0dGVkIHRvIHRoZSBuZXR3b3JrLiBUaGlzIHZhbHVlIHJlc2V0cyB0byB6ZXJvIG9uY2UgYWxsIHF1ZXVlZCBkYXRhIGhhcyBiZWVuIHNlbnQuXG4gICAqIFRoaXMgdmFsdWUgZG9lcyBub3QgcmVzZXQgdG8gemVybyB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGNsb3NlZDsgaWYgeW91IGtlZXAgY2FsbGluZyBzZW5kKCksXG4gICAqIHRoaXMgd2lsbCBjb250aW51ZSB0byBjbGltYi4gUmVhZCBvbmx5XG4gICAqL1xuICBnZXQgYnVmZmVyZWRBbW91bnQoKTogbnVtYmVyIHtcbiAgICBjb25zdCBieXRlcyA9IHRoaXMuX21lc3NhZ2VRdWV1ZS5yZWR1Y2UoKGFjYywgbWVzc2FnZSkgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGFjYyArPSBtZXNzYWdlLmxlbmd0aDsgLy8gbm90IGJ5dGUgc2l6ZVxuICAgICAgfSBlbHNlIGlmIChtZXNzYWdlIGluc3RhbmNlb2YgQmxvYikge1xuICAgICAgICBhY2MgKz0gbWVzc2FnZS5zaXplO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYWNjICs9IG1lc3NhZ2UuYnl0ZUxlbmd0aDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBhY2M7XG4gICAgfSwgMCk7XG4gICAgcmV0dXJuIGJ5dGVzICsgKHRoaXMuX3dzID8gdGhpcy5fd3MuYnVmZmVyZWRBbW91bnQgOiAwKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZXh0ZW5zaW9ucyBzZWxlY3RlZCBieSB0aGUgc2VydmVyLiBUaGlzIGlzIGN1cnJlbnRseSBvbmx5IHRoZSBlbXB0eSBzdHJpbmcgb3IgYSBsaXN0IG9mXG4gICAqIGV4dGVuc2lvbnMgYXMgbmVnb3RpYXRlZCBieSB0aGUgY29ubmVjdGlvblxuICAgKi9cbiAgZ2V0IGV4dGVuc2lvbnMoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5fd3MgPyB0aGlzLl93cy5leHRlbnNpb25zIDogXCJcIjtcbiAgfVxuXG4gIC8qKlxuICAgKiBBIHN0cmluZyBpbmRpY2F0aW5nIHRoZSBuYW1lIG9mIHRoZSBzdWItcHJvdG9jb2wgdGhlIHNlcnZlciBzZWxlY3RlZDtcbiAgICogdGhpcyB3aWxsIGJlIG9uZSBvZiB0aGUgc3RyaW5ncyBzcGVjaWZpZWQgaW4gdGhlIHByb3RvY29scyBwYXJhbWV0ZXIgd2hlbiBjcmVhdGluZyB0aGVcbiAgICogV2ViU29ja2V0IG9iamVjdFxuICAgKi9cbiAgZ2V0IHByb3RvY29sKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuX3dzID8gdGhpcy5fd3MucHJvdG9jb2wgOiBcIlwiO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBjdXJyZW50IHN0YXRlIG9mIHRoZSBjb25uZWN0aW9uOyB0aGlzIGlzIG9uZSBvZiB0aGUgUmVhZHkgc3RhdGUgY29uc3RhbnRzXG4gICAqL1xuICBnZXQgcmVhZHlTdGF0ZSgpOiBudW1iZXIge1xuICAgIGlmICh0aGlzLl93cykge1xuICAgICAgcmV0dXJuIHRoaXMuX3dzLnJlYWR5U3RhdGU7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9vcHRpb25zLnN0YXJ0Q2xvc2VkXG4gICAgICA/IFJlY29ubmVjdGluZ1dlYlNvY2tldC5DTE9TRURcbiAgICAgIDogUmVjb25uZWN0aW5nV2ViU29ja2V0LkNPTk5FQ1RJTkc7XG4gIH1cblxuICAvKipcbiAgICogVGhlIFVSTCBhcyByZXNvbHZlZCBieSB0aGUgY29uc3RydWN0b3JcbiAgICovXG4gIGdldCB1cmwoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5fd3MgPyB0aGlzLl93cy51cmwgOiBcIlwiO1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIHdlYnNvY2tldCBvYmplY3QgaXMgbm93IGluIHJlY29ubmVjdGFibGUgc3RhdGVcbiAgICovXG4gIGdldCBzaG91bGRSZWNvbm5lY3QoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3Nob3VsZFJlY29ubmVjdDtcbiAgfVxuXG4gIC8qKlxuICAgKiBBbiBldmVudCBsaXN0ZW5lciB0byBiZSBjYWxsZWQgd2hlbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb24ncyByZWFkeVN0YXRlIGNoYW5nZXMgdG8gQ0xPU0VEXG4gICAqL1xuICBwdWJsaWMgb25jbG9zZTogKChldmVudDogQ2xvc2VFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICAvKipcbiAgICogQW4gZXZlbnQgbGlzdGVuZXIgdG8gYmUgY2FsbGVkIHdoZW4gYW4gZXJyb3Igb2NjdXJzXG4gICAqL1xuICBwdWJsaWMgb25lcnJvcjogKChldmVudDogRXJyb3JFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICAvKipcbiAgICogQW4gZXZlbnQgbGlzdGVuZXIgdG8gYmUgY2FsbGVkIHdoZW4gYSBtZXNzYWdlIGlzIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgcHVibGljIG9ubWVzc2FnZTogKChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBBbiBldmVudCBsaXN0ZW5lciB0byBiZSBjYWxsZWQgd2hlbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb24ncyByZWFkeVN0YXRlIGNoYW5nZXMgdG8gT1BFTjtcbiAgICogdGhpcyBpbmRpY2F0ZXMgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyByZWFkeSB0byBzZW5kIGFuZCByZWNlaXZlIGRhdGFcbiAgICovXG4gIHB1YmxpYyBvbm9wZW46ICgoZXZlbnQ6IEV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gIC8qKlxuICAgKiBDbG9zZXMgdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uIG9yIGNvbm5lY3Rpb24gYXR0ZW1wdCwgaWYgYW55LiBJZiB0aGUgY29ubmVjdGlvbiBpcyBhbHJlYWR5XG4gICAqIENMT1NFRCwgdGhpcyBtZXRob2QgZG9lcyBub3RoaW5nXG4gICAqL1xuICBwdWJsaWMgY2xvc2UoY29kZSA9IDEwMDAsIHJlYXNvbj86IHN0cmluZykge1xuICAgIHRoaXMuX2Nsb3NlQ2FsbGVkID0gdHJ1ZTtcbiAgICB0aGlzLl9zaG91bGRSZWNvbm5lY3QgPSBmYWxzZTtcbiAgICB0aGlzLl9jbGVhclRpbWVvdXRzKCk7XG4gICAgaWYgKCF0aGlzLl93cykge1xuICAgICAgdGhpcy5fZGVidWcoXCJjbG9zZSBlbnF1ZXVlZDogbm8gd3MgaW5zdGFuY2VcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLl93cy5yZWFkeVN0YXRlID09PSB0aGlzLkNMT1NFRCkge1xuICAgICAgdGhpcy5fZGVidWcoXCJjbG9zZTogYWxyZWFkeSBjbG9zZWRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3dzLmNsb3NlKGNvZGUsIHJlYXNvbik7XG4gIH1cblxuICAvKipcbiAgICogQ2xvc2VzIHRoZSBXZWJTb2NrZXQgY29ubmVjdGlvbiBvciBjb25uZWN0aW9uIGF0dGVtcHQgYW5kIGNvbm5lY3RzIGFnYWluLlxuICAgKiBSZXNldHMgcmV0cnkgY291bnRlcjtcbiAgICovXG4gIHB1YmxpYyByZWNvbm5lY3QoY29kZT86IG51bWJlciwgcmVhc29uPzogc3RyaW5nKSB7XG4gICAgdGhpcy5fc2hvdWxkUmVjb25uZWN0ID0gdHJ1ZTtcbiAgICB0aGlzLl9jbG9zZUNhbGxlZCA9IGZhbHNlO1xuICAgIHRoaXMuX3JldHJ5Q291bnQgPSAtMTtcbiAgICBpZiAoIXRoaXMuX3dzIHx8IHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuQ0xPU0VEKSB7XG4gICAgICB0aGlzLl9jb25uZWN0KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rpc2Nvbm5lY3QoY29kZSwgcmVhc29uKTtcbiAgICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRW5xdWV1ZSBzcGVjaWZpZWQgZGF0YSB0byBiZSB0cmFuc21pdHRlZCB0byB0aGUgc2VydmVyIG92ZXIgdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uXG4gICAqL1xuICBwdWJsaWMgc2VuZChkYXRhOiBNZXNzYWdlKSB7XG4gICAgaWYgKHRoaXMuX3dzICYmIHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuT1BFTikge1xuICAgICAgdGhpcy5fZGVidWcoXCJzZW5kXCIsIGRhdGEpO1xuICAgICAgdGhpcy5fd3Muc2VuZChkYXRhKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgeyBtYXhFbnF1ZXVlZE1lc3NhZ2VzID0gREVGQVVMVC5tYXhFbnF1ZXVlZE1lc3NhZ2VzIH0gPVxuICAgICAgICB0aGlzLl9vcHRpb25zO1xuICAgICAgaWYgKHRoaXMuX21lc3NhZ2VRdWV1ZS5sZW5ndGggPCBtYXhFbnF1ZXVlZE1lc3NhZ2VzKSB7XG4gICAgICAgIHRoaXMuX2RlYnVnKFwiZW5xdWV1ZVwiLCBkYXRhKTtcbiAgICAgICAgdGhpcy5fbWVzc2FnZVF1ZXVlLnB1c2goZGF0YSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfZGVidWcoLi4uYXJnczogdW5rbm93bltdKSB7XG4gICAgaWYgKHRoaXMuX29wdGlvbnMuZGVidWcpIHtcbiAgICAgIHRoaXMuX2RlYnVnTG9nZ2VyKFwiUldTPlwiLCAuLi5hcmdzKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9nZXROZXh0RGVsYXkoKSB7XG4gICAgY29uc3Qge1xuICAgICAgcmVjb25uZWN0aW9uRGVsYXlHcm93RmFjdG9yID0gREVGQVVMVC5yZWNvbm5lY3Rpb25EZWxheUdyb3dGYWN0b3IsXG4gICAgICBtaW5SZWNvbm5lY3Rpb25EZWxheSA9IERFRkFVTFQubWluUmVjb25uZWN0aW9uRGVsYXksXG4gICAgICBtYXhSZWNvbm5lY3Rpb25EZWxheSA9IERFRkFVTFQubWF4UmVjb25uZWN0aW9uRGVsYXlcbiAgICB9ID0gdGhpcy5fb3B0aW9ucztcbiAgICBsZXQgZGVsYXkgPSAwO1xuICAgIGlmICh0aGlzLl9yZXRyeUNvdW50ID4gMCkge1xuICAgICAgZGVsYXkgPVxuICAgICAgICBtaW5SZWNvbm5lY3Rpb25EZWxheSAqXG4gICAgICAgIHJlY29ubmVjdGlvbkRlbGF5R3Jvd0ZhY3RvciAqKiAodGhpcy5fcmV0cnlDb3VudCAtIDEpO1xuICAgICAgaWYgKGRlbGF5ID4gbWF4UmVjb25uZWN0aW9uRGVsYXkpIHtcbiAgICAgICAgZGVsYXkgPSBtYXhSZWNvbm5lY3Rpb25EZWxheTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5fZGVidWcoXCJuZXh0IGRlbGF5XCIsIGRlbGF5KTtcbiAgICByZXR1cm4gZGVsYXk7XG4gIH1cblxuICBwcml2YXRlIF93YWl0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgc2V0VGltZW91dChyZXNvbHZlLCB0aGlzLl9nZXROZXh0RGVsYXkoKSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIF9nZXROZXh0UHJvdG9jb2xzKFxuICAgIHByb3RvY29sc1Byb3ZpZGVyOiBQcm90b2NvbHNQcm92aWRlciB8IG51bGxcbiAgKTogUHJvbWlzZTxzdHJpbmcgfCBzdHJpbmdbXSB8IG51bGw+IHtcbiAgICBpZiAoIXByb3RvY29sc1Byb3ZpZGVyKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xuXG4gICAgaWYgKFxuICAgICAgdHlwZW9mIHByb3RvY29sc1Byb3ZpZGVyID09PSBcInN0cmluZ1wiIHx8XG4gICAgICBBcnJheS5pc0FycmF5KHByb3RvY29sc1Byb3ZpZGVyKVxuICAgICkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShwcm90b2NvbHNQcm92aWRlcik7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBwcm90b2NvbHNQcm92aWRlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBjb25zdCBwcm90b2NvbHMgPSBwcm90b2NvbHNQcm92aWRlcigpO1xuICAgICAgaWYgKCFwcm90b2NvbHMpIHJldHVybiBQcm9taXNlLnJlc29sdmUobnVsbCk7XG5cbiAgICAgIGlmICh0eXBlb2YgcHJvdG9jb2xzID09PSBcInN0cmluZ1wiIHx8IEFycmF5LmlzQXJyYXkocHJvdG9jb2xzKSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHByb3RvY29scyk7XG4gICAgICB9XG5cbiAgICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgcmVkdW5kYW50IGNoZWNrXG4gICAgICBpZiAocHJvdG9jb2xzLnRoZW4pIHtcbiAgICAgICAgcmV0dXJuIHByb3RvY29scztcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aHJvdyBFcnJvcihcIkludmFsaWQgcHJvdG9jb2xzXCIpO1xuICB9XG5cbiAgcHJpdmF0ZSBfZ2V0TmV4dFVybCh1cmxQcm92aWRlcjogVXJsUHJvdmlkZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGlmICh0eXBlb2YgdXJsUHJvdmlkZXIgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodXJsUHJvdmlkZXIpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHVybFByb3ZpZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGNvbnN0IHVybCA9IHVybFByb3ZpZGVyKCk7XG4gICAgICBpZiAodHlwZW9mIHVybCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHVybCk7XG4gICAgICB9XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yXG4gICAgICBpZiAodXJsLnRoZW4pIHtcbiAgICAgICAgcmV0dXJuIHVybDtcbiAgICAgIH1cblxuICAgICAgLy8gcmV0dXJuIHVybDtcbiAgICB9XG4gICAgdGhyb3cgRXJyb3IoXCJJbnZhbGlkIFVSTFwiKTtcbiAgfVxuXG4gIHByaXZhdGUgX2Nvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuX2Nvbm5lY3RMb2NrIHx8ICF0aGlzLl9zaG91bGRSZWNvbm5lY3QpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fY29ubmVjdExvY2sgPSB0cnVlO1xuXG4gICAgY29uc3Qge1xuICAgICAgbWF4UmV0cmllcyA9IERFRkFVTFQubWF4UmV0cmllcyxcbiAgICAgIGNvbm5lY3Rpb25UaW1lb3V0ID0gREVGQVVMVC5jb25uZWN0aW9uVGltZW91dFxuICAgIH0gPSB0aGlzLl9vcHRpb25zO1xuXG4gICAgaWYgKHRoaXMuX3JldHJ5Q291bnQgPj0gbWF4UmV0cmllcykge1xuICAgICAgdGhpcy5fZGVidWcoXCJtYXggcmV0cmllcyByZWFjaGVkXCIsIHRoaXMuX3JldHJ5Q291bnQsIFwiPj1cIiwgbWF4UmV0cmllcyk7XG4gICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuX3JldHJ5Q291bnQrKztcblxuICAgIHRoaXMuX2RlYnVnKFwiY29ubmVjdFwiLCB0aGlzLl9yZXRyeUNvdW50KTtcbiAgICB0aGlzLl9yZW1vdmVMaXN0ZW5lcnMoKTtcblxuICAgIHRoaXMuX3dhaXQoKVxuICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgIHRoaXMuX2dldE5leHRVcmwodGhpcy5fdXJsKSxcbiAgICAgICAgICB0aGlzLl9nZXROZXh0UHJvdG9jb2xzKHRoaXMuX3Byb3RvY29scyB8fCBudWxsKVxuICAgICAgICBdKVxuICAgICAgKVxuICAgICAgLnRoZW4oKFt1cmwsIHByb3RvY29sc10pID0+IHtcbiAgICAgICAgLy8gY2xvc2UgY291bGQgYmUgY2FsbGVkIGJlZm9yZSBjcmVhdGluZyB0aGUgd3NcbiAgICAgICAgaWYgKHRoaXMuX2Nsb3NlQ2FsbGVkKSB7XG4gICAgICAgICAgdGhpcy5fY29ubmVjdExvY2sgPSBmYWxzZTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgICF0aGlzLl9vcHRpb25zLldlYlNvY2tldCAmJlxuICAgICAgICAgIHR5cGVvZiBXZWJTb2NrZXQgPT09IFwidW5kZWZpbmVkXCIgJiZcbiAgICAgICAgICAhZGlkV2FybkFib3V0TWlzc2luZ1dlYlNvY2tldFxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKGDigLzvuI8gTm8gV2ViU29ja2V0IGltcGxlbWVudGF0aW9uIGF2YWlsYWJsZS4gWW91IHNob3VsZCBkZWZpbmUgb3B0aW9ucy5XZWJTb2NrZXQuIFxuXG5Gb3IgZXhhbXBsZSwgaWYgeW91J3JlIHVzaW5nIG5vZGUuanMsIHJ1biBcXGBucG0gaW5zdGFsbCB3c1xcYCwgYW5kIHRoZW4gaW4geW91ciBjb2RlOlxuXG5pbXBvcnQgUGFydHlTb2NrZXQgZnJvbSAncGFydHlzb2NrZXQnO1xuaW1wb3J0IFdTIGZyb20gJ3dzJztcblxuY29uc3QgcGFydHlzb2NrZXQgPSBuZXcgUGFydHlTb2NrZXQoe1xuICBob3N0OiBcIjEyNy4wLjAuMToxOTk5XCIsXG4gIHJvb206IFwidGVzdC1yb29tXCIsXG4gIFdlYlNvY2tldDogV1Ncbn0pO1xuXG5gKTtcbiAgICAgICAgICBkaWRXYXJuQWJvdXRNaXNzaW5nV2ViU29ja2V0ID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBXUzogdHlwZW9mIFdlYlNvY2tldCA9IHRoaXMuX29wdGlvbnMuV2ViU29ja2V0IHx8IFdlYlNvY2tldDtcbiAgICAgICAgdGhpcy5fZGVidWcoXCJjb25uZWN0XCIsIHsgdXJsLCBwcm90b2NvbHMgfSk7XG4gICAgICAgIHRoaXMuX3dzID0gcHJvdG9jb2xzID8gbmV3IFdTKHVybCwgcHJvdG9jb2xzKSA6IG5ldyBXUyh1cmwpO1xuXG4gICAgICAgIHRoaXMuX3dzLmJpbmFyeVR5cGUgPSB0aGlzLl9iaW5hcnlUeXBlO1xuICAgICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgICB0aGlzLl9hZGRMaXN0ZW5lcnMoKTtcblxuICAgICAgICB0aGlzLl9jb25uZWN0VGltZW91dCA9IHNldFRpbWVvdXQoXG4gICAgICAgICAgKCkgPT4gdGhpcy5faGFuZGxlVGltZW91dCgpLFxuICAgICAgICAgIGNvbm5lY3Rpb25UaW1lb3V0XG4gICAgICAgICk7XG4gICAgICB9KVxuICAgICAgLy8gdmlhIGh0dHBzOi8vZ2l0aHViLmNvbS9wbGFkYXJpYS9yZWNvbm5lY3Rpbmctd2Vic29ja2V0L3B1bGwvMTY2XG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICB0aGlzLl9jb25uZWN0TG9jayA9IGZhbHNlO1xuICAgICAgICB0aGlzLl9oYW5kbGVFcnJvcihuZXcgRXZlbnRzLkVycm9yRXZlbnQoRXJyb3IoZXJyLm1lc3NhZ2UpLCB0aGlzKSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX2hhbmRsZVRpbWVvdXQoKSB7XG4gICAgdGhpcy5fZGVidWcoXCJ0aW1lb3V0IGV2ZW50XCIpO1xuICAgIHRoaXMuX2hhbmRsZUVycm9yKG5ldyBFdmVudHMuRXJyb3JFdmVudChFcnJvcihcIlRJTUVPVVRcIiksIHRoaXMpKTtcbiAgfVxuXG4gIHByaXZhdGUgX2Rpc2Nvbm5lY3QoY29kZSA9IDEwMDAsIHJlYXNvbj86IHN0cmluZykge1xuICAgIHRoaXMuX2NsZWFyVGltZW91dHMoKTtcbiAgICBpZiAoIXRoaXMuX3dzKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX3JlbW92ZUxpc3RlbmVycygpO1xuICAgIHRyeSB7XG4gICAgICBpZiAoXG4gICAgICAgIHRoaXMuX3dzLnJlYWR5U3RhdGUgPT09IHRoaXMuT1BFTiB8fFxuICAgICAgICB0aGlzLl93cy5yZWFkeVN0YXRlID09PSB0aGlzLkNPTk5FQ1RJTkdcbiAgICAgICkge1xuICAgICAgICB0aGlzLl93cy5jbG9zZShjb2RlLCByZWFzb24pO1xuICAgICAgfVxuICAgICAgdGhpcy5faGFuZGxlQ2xvc2UobmV3IEV2ZW50cy5DbG9zZUV2ZW50KGNvZGUsIHJlYXNvbiwgdGhpcykpO1xuICAgIH0gY2F0Y2ggKF9lcnJvcikge1xuICAgICAgLy8gaWdub3JlXG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfYWNjZXB0T3BlbigpIHtcbiAgICB0aGlzLl9kZWJ1ZyhcImFjY2VwdCBvcGVuXCIpO1xuICAgIHRoaXMuX3JldHJ5Q291bnQgPSAwO1xuICB9XG5cbiAgcHJpdmF0ZSBfaGFuZGxlT3BlbiA9IChldmVudDogRXZlbnQpID0+IHtcbiAgICB0aGlzLl9kZWJ1ZyhcIm9wZW4gZXZlbnRcIik7XG4gICAgY29uc3QgeyBtaW5VcHRpbWUgPSBERUZBVUxULm1pblVwdGltZSB9ID0gdGhpcy5fb3B0aW9ucztcblxuICAgIGNsZWFyVGltZW91dCh0aGlzLl9jb25uZWN0VGltZW91dCk7XG4gICAgdGhpcy5fdXB0aW1lVGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gdGhpcy5fYWNjZXB0T3BlbigpLCBtaW5VcHRpbWUpO1xuXG4gICAgYXNzZXJ0KHRoaXMuX3dzLCBcIldlYlNvY2tldCBpcyBub3QgZGVmaW5lZFwiKTtcblxuICAgIHRoaXMuX3dzLmJpbmFyeVR5cGUgPSB0aGlzLl9iaW5hcnlUeXBlO1xuXG4gICAgLy8gc2VuZCBlbnF1ZXVlZCBtZXNzYWdlcyAobWVzc2FnZXMgc2VudCBiZWZvcmUgd2Vic29ja2V0IG9wZW4gZXZlbnQpXG4gICAgdGhpcy5fbWVzc2FnZVF1ZXVlLmZvckVhY2goKG1lc3NhZ2UpID0+IHtcbiAgICAgIHRoaXMuX3dzPy5zZW5kKG1lc3NhZ2UpO1xuICAgIH0pO1xuICAgIHRoaXMuX21lc3NhZ2VRdWV1ZSA9IFtdO1xuXG4gICAgaWYgKHRoaXMub25vcGVuKSB7XG4gICAgICB0aGlzLm9ub3BlbihldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfaGFuZGxlTWVzc2FnZSA9IChldmVudDogTWVzc2FnZUV2ZW50KSA9PiB7XG4gICAgdGhpcy5fZGVidWcoXCJtZXNzYWdlIGV2ZW50XCIpO1xuXG4gICAgaWYgKHRoaXMub25tZXNzYWdlKSB7XG4gICAgICB0aGlzLm9ubWVzc2FnZShldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfaGFuZGxlRXJyb3IgPSAoZXZlbnQ6IEVycm9yRXZlbnQpID0+IHtcbiAgICB0aGlzLl9kZWJ1ZyhcImVycm9yIGV2ZW50XCIsIGV2ZW50Lm1lc3NhZ2UpO1xuICAgIHRoaXMuX2Rpc2Nvbm5lY3QoXG4gICAgICB1bmRlZmluZWQsXG4gICAgICBldmVudC5tZXNzYWdlID09PSBcIlRJTUVPVVRcIiA/IFwidGltZW91dFwiIDogdW5kZWZpbmVkXG4gICAgKTtcblxuICAgIGlmICh0aGlzLm9uZXJyb3IpIHtcbiAgICAgIHRoaXMub25lcnJvcihldmVudCk7XG4gICAgfVxuICAgIHRoaXMuX2RlYnVnKFwiZXhlYyBlcnJvciBsaXN0ZW5lcnNcIik7XG4gICAgdGhpcy5kaXNwYXRjaEV2ZW50KGNsb25lRXZlbnQoZXZlbnQpKTtcblxuICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgfTtcblxuICBwcml2YXRlIF9oYW5kbGVDbG9zZSA9IChldmVudDogQ2xvc2VFdmVudCkgPT4ge1xuICAgIHRoaXMuX2RlYnVnKFwiY2xvc2UgZXZlbnRcIik7XG4gICAgdGhpcy5fY2xlYXJUaW1lb3V0cygpO1xuXG4gICAgaWYgKHRoaXMuX3Nob3VsZFJlY29ubmVjdCkge1xuICAgICAgdGhpcy5fY29ubmVjdCgpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9uY2xvc2UpIHtcbiAgICAgIHRoaXMub25jbG9zZShldmVudCk7XG4gICAgfVxuICAgIHRoaXMuZGlzcGF0Y2hFdmVudChjbG9uZUV2ZW50KGV2ZW50KSk7XG4gIH07XG5cbiAgcHJpdmF0ZSBfcmVtb3ZlTGlzdGVuZXJzKCkge1xuICAgIGlmICghdGhpcy5fd3MpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fZGVidWcoXCJyZW1vdmVMaXN0ZW5lcnNcIik7XG4gICAgdGhpcy5fd3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm9wZW5cIiwgdGhpcy5faGFuZGxlT3Blbik7XG4gICAgdGhpcy5fd3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsb3NlXCIsIHRoaXMuX2hhbmRsZUNsb3NlKTtcbiAgICB0aGlzLl93cy5yZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCB0aGlzLl9oYW5kbGVNZXNzYWdlKTtcbiAgICAvLyBAdHMtZXhwZWN0LWVycm9yIHdlIG5lZWQgdG8gZml4IGV2ZW50L2xpc3Rlcm5lciB0eXBlc1xuICAgIHRoaXMuX3dzLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCB0aGlzLl9oYW5kbGVFcnJvcik7XG4gIH1cblxuICBwcml2YXRlIF9hZGRMaXN0ZW5lcnMoKSB7XG4gICAgaWYgKCF0aGlzLl93cykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLl9kZWJ1ZyhcImFkZExpc3RlbmVyc1wiKTtcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwib3BlblwiLCB0aGlzLl9oYW5kbGVPcGVuKTtcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwiY2xvc2VcIiwgdGhpcy5faGFuZGxlQ2xvc2UpO1xuICAgIHRoaXMuX3dzLmFkZEV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIHRoaXMuX2hhbmRsZU1lc3NhZ2UpO1xuICAgIC8vIEB0cy1leHBlY3QtZXJyb3Igd2UgbmVlZCB0byBmaXggZXZlbnQvbGlzdGVuZXIgdHlwZXNcbiAgICB0aGlzLl93cy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgdGhpcy5faGFuZGxlRXJyb3IpO1xuICB9XG5cbiAgcHJpdmF0ZSBfY2xlYXJUaW1lb3V0cygpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy5fY29ubmVjdFRpbWVvdXQpO1xuICAgIGNsZWFyVGltZW91dCh0aGlzLl91cHRpbWVUaW1lb3V0KTtcbiAgfVxufVxuIiwgImltcG9ydCBSZWNvbm5lY3RpbmdXZWJTb2NrZXQgZnJvbSBcIi4vd3NcIjtcblxuaW1wb3J0IHR5cGUgKiBhcyBSV1MgZnJvbSBcIi4vd3NcIjtcbmltcG9ydCB0eXBlIHsgUHJvdG9jb2xzUHJvdmlkZXIgfSBmcm9tIFwiLi93c1wiO1xuXG50eXBlIE1heWJlPFQ+ID0gVCB8IG51bGwgfCB1bmRlZmluZWQ7XG50eXBlIFBhcmFtcyA9IFJlY29yZDxzdHJpbmcsIE1heWJlPHN0cmluZz4+O1xuY29uc3QgdmFsdWVJc05vdE5pbCA9IDxUPihcbiAga2V5VmFsdWVQYWlyOiBbc3RyaW5nLCBNYXliZTxUPl1cbik6IGtleVZhbHVlUGFpciBpcyBbc3RyaW5nLCBUXSA9PlxuICBrZXlWYWx1ZVBhaXJbMV0gIT09IG51bGwgJiYga2V5VmFsdWVQYWlyWzFdICE9PSB1bmRlZmluZWQ7XG5cbmV4cG9ydCB0eXBlIFBhcnR5U29ja2V0T3B0aW9ucyA9IE9taXQ8UldTLk9wdGlvbnMsIFwiY29uc3RydWN0b3JcIj4gJiB7XG4gIGlkPzogc3RyaW5nOyAvLyB0aGUgaWQgb2YgdGhlIGNsaWVudFxuICBob3N0OiBzdHJpbmc7IC8vIGJhc2UgdXJsIGZvciB0aGUgcGFydHlcbiAgcm9vbT86IHN0cmluZzsgLy8gdGhlIHJvb20gdG8gY29ubmVjdCB0b1xuICBwYXJ0eT86IHN0cmluZzsgLy8gdGhlIHBhcnR5IHRvIGNvbm5lY3QgdG8gKGRlZmF1bHRzIHRvIG1haW4pXG4gIGJhc2VQYXRoPzogc3RyaW5nOyAvLyB0aGUgYmFzZSBwYXRoIHRvIHVzZSBmb3IgdGhlIHBhcnR5XG4gIHByZWZpeD86IHN0cmluZzsgLy8gdGhlIHByZWZpeCB0byB1c2UgZm9yIHRoZSBwYXJ0eVxuICBwcm90b2NvbD86IFwid3NcIiB8IFwid3NzXCI7XG4gIHByb3RvY29scz86IFByb3RvY29sc1Byb3ZpZGVyO1xuICBwYXRoPzogc3RyaW5nOyAvLyB0aGUgcGF0aCB0byBjb25uZWN0IHRvXG4gIHF1ZXJ5PzogUGFyYW1zIHwgKCgpID0+IFBhcmFtcyB8IFByb21pc2U8UGFyYW1zPik7XG4gIGRpc2FibGVOYW1lVmFsaWRhdGlvbj86IGJvb2xlYW47IC8vIGRpc2FibGUgdmFsaWRhdGlvbiBvZiBwYXJ0eS9yb29tIG5hbWVzXG4gIC8vIGhlYWRlcnNcbn07XG5cbmV4cG9ydCB0eXBlIFBhcnR5RmV0Y2hPcHRpb25zID0ge1xuICBob3N0OiBzdHJpbmc7IC8vIGJhc2UgdXJsIGZvciB0aGUgcGFydHlcbiAgcm9vbTogc3RyaW5nOyAvLyB0aGUgcm9vbSB0byBjb25uZWN0IHRvXG4gIHBhcnR5Pzogc3RyaW5nOyAvLyB0aGUgcGFydHkgdG8gZmV0Y2ggZnJvbSAoZGVmYXVsdHMgdG8gbWFpbilcbiAgYmFzZVBhdGg/OiBzdHJpbmc7IC8vIHRoZSBiYXNlIHBhdGggdG8gdXNlIGZvciB0aGUgcGFydHlcbiAgcHJlZml4Pzogc3RyaW5nOyAvLyB0aGUgcHJlZml4IHRvIHVzZSBmb3IgdGhlIHBhcnR5XG4gIHBhdGg/OiBzdHJpbmc7IC8vIHRoZSBwYXRoIHRvIGZldGNoIGZyb21cbiAgcHJvdG9jb2w/OiBcImh0dHBcIiB8IFwiaHR0cHNcIjtcbiAgcXVlcnk/OiBQYXJhbXMgfCAoKCkgPT4gUGFyYW1zIHwgUHJvbWlzZTxQYXJhbXM+KTtcbiAgZmV0Y2g/OiB0eXBlb2YgZmV0Y2g7XG59O1xuXG5mdW5jdGlvbiBnZW5lcmF0ZVVVSUQoKTogc3RyaW5nIHtcbiAgLy8gUHVibGljIERvbWFpbi9NSVRcbiAgaWYgKGNyeXB0bz8ucmFuZG9tVVVJRCkge1xuICAgIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICB9XG4gIGxldCBkID0gRGF0ZS5ub3coKTsgLy9UaW1lc3RhbXBcbiAgbGV0IGQyID0gKHBlcmZvcm1hbmNlPy5ub3cgJiYgcGVyZm9ybWFuY2Uubm93KCkgKiAxMDAwKSB8fCAwOyAvL1RpbWUgaW4gbWljcm9zZWNvbmRzIHNpbmNlIHBhZ2UtbG9hZCBvciAwIGlmIHVuc3VwcG9ydGVkXG4gIC8vIG94bGludC1kaXNhYmxlLW5leHQtbGluZSBmdW5jLXN0eWxlXG4gIHJldHVybiBcInh4eHh4eHh4LXh4eHgtNHh4eC15eHh4LXh4eHh4eHh4eHh4eFwiLnJlcGxhY2UoL1t4eV0vZywgZnVuY3Rpb24gKGMpIHtcbiAgICBsZXQgciA9IE1hdGgucmFuZG9tKCkgKiAxNjsgLy9yYW5kb20gbnVtYmVyIGJldHdlZW4gMCBhbmQgMTZcbiAgICBpZiAoZCA+IDApIHtcbiAgICAgIC8vVXNlIHRpbWVzdGFtcCB1bnRpbCBkZXBsZXRlZFxuICAgICAgciA9ICgoZCArIHIpICUgMTYpIHwgMDtcbiAgICAgIGQgPSBNYXRoLmZsb29yKGQgLyAxNik7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vVXNlIG1pY3Jvc2Vjb25kcyBzaW5jZSBwYWdlLWxvYWQgaWYgc3VwcG9ydGVkXG4gICAgICByID0gKChkMiArIHIpICUgMTYpIHwgMDtcbiAgICAgIGQyID0gTWF0aC5mbG9vcihkMiAvIDE2KTtcbiAgICB9XG4gICAgcmV0dXJuIChjID09PSBcInhcIiA/IHIgOiAociAmIDB4MykgfCAweDgpLnRvU3RyaW5nKDE2KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldFBhcnR5SW5mbyhcbiAgcGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0eVNvY2tldE9wdGlvbnMgfCBQYXJ0eUZldGNoT3B0aW9ucyxcbiAgZGVmYXVsdFByb3RvY29sOiBcImh0dHBcIiB8IFwid3NcIixcbiAgZGVmYXVsdFBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9XG4pIHtcbiAgY29uc3Qge1xuICAgIGhvc3Q6IHJhd0hvc3QsXG4gICAgcGF0aDogcmF3UGF0aCxcbiAgICBwcm90b2NvbDogcmF3UHJvdG9jb2wsXG4gICAgcm9vbSxcbiAgICBwYXJ0eSxcbiAgICBiYXNlUGF0aCxcbiAgICBwcmVmaXgsXG4gICAgcXVlcnlcbiAgfSA9IHBhcnR5U29ja2V0T3B0aW9ucztcblxuICAvLyBzdHJpcCB0aGUgcHJvdG9jb2wgZnJvbSB0aGUgYmVnaW5uaW5nIG9mIGBob3N0YCBpZiBhbnlcbiAgbGV0IGhvc3QgPSByYXdIb3N0LnJlcGxhY2UoL14oaHR0cHxodHRwc3x3c3x3c3MpOlxcL1xcLy8sIFwiXCIpO1xuICAvLyBpZiB1c2VyIHByb3ZpZGVkIGEgdHJhaWxpbmcgc2xhc2gsIHJlbW92ZSBpdFxuICBpZiAoaG9zdC5lbmRzV2l0aChcIi9cIikpIHtcbiAgICBob3N0ID0gaG9zdC5zbGljZSgwLCAtMSk7XG4gIH1cblxuICBpZiAocmF3UGF0aD8uc3RhcnRzV2l0aChcIi9cIikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJwYXRoIG11c3Qgbm90IHN0YXJ0IHdpdGggYSBzbGFzaFwiKTtcbiAgfVxuXG4gIGNvbnN0IG5hbWUgPSBwYXJ0eSA/PyBcIm1haW5cIjtcbiAgY29uc3QgcGF0aCA9IHJhd1BhdGggPyBgLyR7cmF3UGF0aH1gIDogXCJcIjtcbiAgY29uc3QgcHJvdG9jb2wgPVxuICAgIHJhd1Byb3RvY29sIHx8XG4gICAgKGhvc3Quc3RhcnRzV2l0aChcImxvY2FsaG9zdDpcIikgfHxcbiAgICBob3N0LnN0YXJ0c1dpdGgoXCIxMjcuMC4wLjE6XCIpIHx8XG4gICAgaG9zdC5zdGFydHNXaXRoKFwiMTkyLjE2OC5cIikgfHxcbiAgICBob3N0LnN0YXJ0c1dpdGgoXCIxMC5cIikgfHxcbiAgICAoaG9zdC5zdGFydHNXaXRoKFwiMTcyLlwiKSAmJlxuICAgICAgaG9zdC5zcGxpdChcIi5cIilbMV0gPj0gXCIxNlwiICYmXG4gICAgICBob3N0LnNwbGl0KFwiLlwiKVsxXSA8PSBcIjMxXCIpIHx8XG4gICAgaG9zdC5zdGFydHNXaXRoKFwiWzo6ZmZmZjo3ZjAwOjFdOlwiKVxuICAgICAgPyAvLyBodHRwIC8gd3NcbiAgICAgICAgZGVmYXVsdFByb3RvY29sXG4gICAgICA6IC8vIGh0dHBzIC8gd3NzXG4gICAgICAgIGAke2RlZmF1bHRQcm90b2NvbH1zYCk7XG5cbiAgY29uc3QgYmFzZVVybCA9IGAke3Byb3RvY29sfTovLyR7aG9zdH0vJHtiYXNlUGF0aCB8fCBgJHtwcmVmaXggfHwgXCJwYXJ0aWVzXCJ9LyR7bmFtZX0vJHtyb29tfWB9JHtwYXRofWA7XG5cbiAgY29uc3QgbWFrZVVybCA9IChxdWVyeTogUGFyYW1zID0ge30pID0+XG4gICAgYCR7YmFzZVVybH0/JHtuZXcgVVJMU2VhcmNoUGFyYW1zKFtcbiAgICAgIC4uLk9iamVjdC5lbnRyaWVzKGRlZmF1bHRQYXJhbXMpLFxuICAgICAgLi4uT2JqZWN0LmVudHJpZXMocXVlcnkpLmZpbHRlcih2YWx1ZUlzTm90TmlsKVxuICAgIF0pfWA7XG5cbiAgLy8gYWxsb3cgdXJscyB0byBiZSBkZWZpbmVkIGFzIGZ1bmN0aW9uc1xuICBjb25zdCB1cmxQcm92aWRlciA9XG4gICAgdHlwZW9mIHF1ZXJ5ID09PSBcImZ1bmN0aW9uXCJcbiAgICAgID8gYXN5bmMgKCkgPT4gbWFrZVVybChhd2FpdCBxdWVyeSgpKVxuICAgICAgOiBtYWtlVXJsKHF1ZXJ5KTtcblxuICByZXR1cm4ge1xuICAgIGhvc3QsXG4gICAgcGF0aCxcbiAgICByb29tLFxuICAgIG5hbWUsXG4gICAgcHJvdG9jb2wsXG4gICAgcGFydHlVcmw6IGJhc2VVcmwsXG4gICAgdXJsUHJvdmlkZXJcbiAgfTtcbn1cblxuLy8gdGhpbmdzIHRoYXQgbmF0aGFuYm9rdGFlL3JvYnVzdC13ZWJzb2NrZXQgY2xhaW1zIGFyZSBiZXR0ZXI6XG4vLyBkb2Vzbid0IGRvIGFueXRoaW5nIGluIG9mZmxpbmUgbW9kZSAoPylcbi8vIFwibmF0aXZlbHkgYXdhcmUgb2YgZXJyb3IgY29kZXNcIlxuLy8gY2FuIGRvIGN1c3RvbSByZWNvbm5lY3Qgc3RyYXRlZ2llc1xuXG4vLyBUT0RPOiBpbmNvcnBvcmF0ZSB0aGUgYWJvdmUgbm90ZXNcbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFBhcnR5U29ja2V0IGV4dGVuZHMgUmVjb25uZWN0aW5nV2ViU29ja2V0IHtcbiAgX3BrITogc3RyaW5nO1xuICBfcGt1cmwhOiBzdHJpbmc7XG4gIG5hbWUhOiBzdHJpbmc7XG4gIHJvb20/OiBzdHJpbmc7XG4gIGhvc3QhOiBzdHJpbmc7XG4gIHBhdGghOiBzdHJpbmc7XG4gIGJhc2VQYXRoPzogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHJlYWRvbmx5IHBhcnR5U29ja2V0T3B0aW9uczogUGFydHlTb2NrZXRPcHRpb25zKSB7XG4gICAgY29uc3Qgd3NPcHRpb25zID0gZ2V0V1NPcHRpb25zKHBhcnR5U29ja2V0T3B0aW9ucyk7XG5cbiAgICBzdXBlcih3c09wdGlvbnMudXJsUHJvdmlkZXIsIHdzT3B0aW9ucy5wcm90b2NvbHMsIHdzT3B0aW9ucy5zb2NrZXRPcHRpb25zKTtcblxuICAgIHRoaXMuc2V0V1NQcm9wZXJ0aWVzKHdzT3B0aW9ucyk7XG5cbiAgICBpZiAoIXBhcnR5U29ja2V0T3B0aW9ucy5zdGFydENsb3NlZCAmJiAhdGhpcy5yb29tICYmICF0aGlzLmJhc2VQYXRoKSB7XG4gICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiRWl0aGVyIHJvb20gb3IgYmFzZVBhdGggbXVzdCBiZSBwcm92aWRlZCB0byBjb25uZWN0LiBVc2Ugc3RhcnRDbG9zZWQ6IHRydWUgdG8gY3JlYXRlIGEgc29ja2V0IGFuZCBzZXQgdGhlbSB2aWEgdXBkYXRlUHJvcGVydGllcyBiZWZvcmUgY2FsbGluZyByZWNvbm5lY3QoKS5cIlxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIXBhcnR5U29ja2V0T3B0aW9ucy5kaXNhYmxlTmFtZVZhbGlkYXRpb24pIHtcbiAgICAgIGlmIChwYXJ0eVNvY2tldE9wdGlvbnMucGFydHk/LmluY2x1ZGVzKFwiL1wiKSkge1xuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFBhcnR5U29ja2V0OiBwYXJ0eSBuYW1lIFwiJHtwYXJ0eVNvY2tldE9wdGlvbnMucGFydHl9XCIgY29udGFpbnMgZm9yd2FyZCBzbGFzaCB3aGljaCBtYXkgY2F1c2Ugcm91dGluZyBpc3N1ZXMuIENvbnNpZGVyIHVzaW5nIGEgbmFtZSB3aXRob3V0IGZvcndhcmQgc2xhc2hlcyBvciBzZXQgZGlzYWJsZU5hbWVWYWxpZGF0aW9uOiB0cnVlIHRvIGJ5cGFzcyB0aGlzIHdhcm5pbmcuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnR5U29ja2V0T3B0aW9ucy5yb29tPy5pbmNsdWRlcyhcIi9cIikpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBQYXJ0eVNvY2tldDogcm9vbSBuYW1lIFwiJHtwYXJ0eVNvY2tldE9wdGlvbnMucm9vbX1cIiBjb250YWlucyBmb3J3YXJkIHNsYXNoIHdoaWNoIG1heSBjYXVzZSByb3V0aW5nIGlzc3Vlcy4gQ29uc2lkZXIgdXNpbmcgYSBuYW1lIHdpdGhvdXQgZm9yd2FyZCBzbGFzaGVzIG9yIHNldCBkaXNhYmxlTmFtZVZhbGlkYXRpb246IHRydWUgdG8gYnlwYXNzIHRoaXMgd2FybmluZy5gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHVibGljIHVwZGF0ZVByb3BlcnRpZXMocGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0aWFsPFBhcnR5U29ja2V0T3B0aW9ucz4pIHtcbiAgICBjb25zdCB3c09wdGlvbnMgPSBnZXRXU09wdGlvbnMoe1xuICAgICAgLi4udGhpcy5wYXJ0eVNvY2tldE9wdGlvbnMsXG4gICAgICAuLi5wYXJ0eVNvY2tldE9wdGlvbnMsXG4gICAgICBob3N0OiBwYXJ0eVNvY2tldE9wdGlvbnMuaG9zdCA/PyB0aGlzLmhvc3QsXG4gICAgICByb29tOiBwYXJ0eVNvY2tldE9wdGlvbnMucm9vbSA/PyB0aGlzLnJvb20sXG4gICAgICBwYXRoOiBwYXJ0eVNvY2tldE9wdGlvbnMucGF0aCA/PyB0aGlzLnBhdGgsXG4gICAgICBiYXNlUGF0aDogcGFydHlTb2NrZXRPcHRpb25zLmJhc2VQYXRoID8/IHRoaXMuYmFzZVBhdGhcbiAgICB9KTtcblxuICAgIHRoaXMuX3VybCA9IHdzT3B0aW9ucy51cmxQcm92aWRlcjtcbiAgICB0aGlzLl9wcm90b2NvbHMgPSB3c09wdGlvbnMucHJvdG9jb2xzO1xuICAgIHRoaXMuX29wdGlvbnMgPSB3c09wdGlvbnMuc29ja2V0T3B0aW9ucztcblxuICAgIHRoaXMuc2V0V1NQcm9wZXJ0aWVzKHdzT3B0aW9ucyk7XG4gIH1cblxuICBwcml2YXRlIHNldFdTUHJvcGVydGllcyh3c09wdGlvbnM6IFJldHVyblR5cGU8dHlwZW9mIGdldFdTT3B0aW9ucz4pIHtcbiAgICBjb25zdCB7IF9waywgX3BrdXJsLCBuYW1lLCByb29tLCBob3N0LCBwYXRoLCBiYXNlUGF0aCB9ID0gd3NPcHRpb25zO1xuXG4gICAgdGhpcy5fcGsgPSBfcGs7XG4gICAgdGhpcy5fcGt1cmwgPSBfcGt1cmw7XG4gICAgdGhpcy5uYW1lID0gbmFtZTtcbiAgICB0aGlzLnJvb20gPSByb29tO1xuICAgIHRoaXMuaG9zdCA9IGhvc3Q7XG4gICAgdGhpcy5wYXRoID0gcGF0aDtcbiAgICB0aGlzLmJhc2VQYXRoID0gYmFzZVBhdGg7XG4gIH1cblxuICBwdWJsaWMgcmVjb25uZWN0KFxuICAgIGNvZGU/OiBudW1iZXIgfCB1bmRlZmluZWQsXG4gICAgcmVhc29uPzogc3RyaW5nIHwgdW5kZWZpbmVkXG4gICk6IHZvaWQge1xuICAgIGlmICghdGhpcy5ob3N0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiVGhlIGhvc3QgbXVzdCBiZSBzZXQgYmVmb3JlIGNvbm5lY3RpbmcsIHVzZSBgdXBkYXRlUHJvcGVydGllc2AgbWV0aG9kIHRvIHNldCBpdCBvciBwYXNzIGl0IHRvIHRoZSBjb25zdHJ1Y3Rvci5cIlxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLnJvb20gJiYgIXRoaXMuYmFzZVBhdGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJUaGUgcm9vbSAob3IgYmFzZVBhdGgpIG11c3QgYmUgc2V0IGJlZm9yZSBjb25uZWN0aW5nLCB1c2UgYHVwZGF0ZVByb3BlcnRpZXNgIG1ldGhvZCB0byBzZXQgaXQgb3IgcGFzcyBpdCB0byB0aGUgY29uc3RydWN0b3IuXCJcbiAgICAgICk7XG4gICAgfVxuICAgIHN1cGVyLnJlY29ubmVjdChjb2RlLCByZWFzb24pO1xuICB9XG5cbiAgZ2V0IGlkKCkge1xuICAgIHJldHVybiB0aGlzLl9waztcbiAgfVxuXG4gIC8qKlxuICAgKiBFeHBvc2VzIHRoZSBzdGF0aWMgUGFydHlLaXQgcm9vbSBVUkwgd2l0aG91dCBhcHBseWluZyBxdWVyeSBwYXJhbWV0ZXJzLlxuICAgKiBUbyBhY2Nlc3MgdGhlIGN1cnJlbnRseSBjb25uZWN0ZWQgV2ViU29ja2V0IHVybCwgdXNlIFBhcnR5U29ja2V0I3VybC5cbiAgICovXG4gIGdldCByb29tVXJsKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuX3BrdXJsO1xuICB9XG5cbiAgLy8gYSBgZmV0Y2hgIG1ldGhvZCB0aGF0IHVzZXMgKGFsbW9zdCkgdGhlIHNhbWUgb3B0aW9ucyBhcyBgUGFydHlTb2NrZXRgXG4gIHN0YXRpYyBhc3luYyBmZXRjaChcbiAgICBvcHRpb25zOiBQYXJ0eUZldGNoT3B0aW9ucyxcbiAgICBpbml0PzogUmVxdWVzdEluaXRcbiAgKTogUHJvbWlzZTxSZXNwb25zZT4ge1xuICAgIGNvbnN0IHBhcnR5ID0gZ2V0UGFydHlJbmZvKG9wdGlvbnMsIFwiaHR0cFwiKTtcbiAgICBjb25zdCB1cmwgPVxuICAgICAgdHlwZW9mIHBhcnR5LnVybFByb3ZpZGVyID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gcGFydHkudXJsUHJvdmlkZXJcbiAgICAgICAgOiBhd2FpdCBwYXJ0eS51cmxQcm92aWRlcigpO1xuICAgIGNvbnN0IGRvRmV0Y2ggPSBvcHRpb25zLmZldGNoID8/IGZldGNoO1xuICAgIHJldHVybiBkb0ZldGNoKHVybCwgaW5pdCk7XG4gIH1cbn1cblxuZXhwb3J0IHsgUGFydHlTb2NrZXQgfTtcblxuZXhwb3J0IHsgUmVjb25uZWN0aW5nV2ViU29ja2V0IGFzIFdlYlNvY2tldCB9O1xuXG5mdW5jdGlvbiBnZXRXU09wdGlvbnMocGFydHlTb2NrZXRPcHRpb25zOiBQYXJ0eVNvY2tldE9wdGlvbnMpIHtcbiAgY29uc3Qge1xuICAgIGlkLFxuICAgIGhvc3Q6IF9ob3N0LFxuICAgIHBhdGg6IF9wYXRoLFxuICAgIHBhcnR5OiBfcGFydHksXG4gICAgcm9vbTogX3Jvb20sXG4gICAgcHJvdG9jb2w6IF9wcm90b2NvbCxcbiAgICBxdWVyeTogX3F1ZXJ5LFxuICAgIHByb3RvY29scyxcbiAgICAuLi5zb2NrZXRPcHRpb25zXG4gIH0gPSBwYXJ0eVNvY2tldE9wdGlvbnM7XG5cbiAgY29uc3QgX3BrID0gaWQgfHwgZ2VuZXJhdGVVVUlEKCk7XG4gIGNvbnN0IHBhcnR5ID0gZ2V0UGFydHlJbmZvKHBhcnR5U29ja2V0T3B0aW9ucywgXCJ3c1wiLCB7IF9wayB9KTtcblxuICByZXR1cm4ge1xuICAgIF9wazogX3BrLFxuICAgIF9wa3VybDogcGFydHkucGFydHlVcmwsXG4gICAgbmFtZTogcGFydHkubmFtZSxcbiAgICByb29tOiBwYXJ0eS5yb29tLFxuICAgIGhvc3Q6IHBhcnR5Lmhvc3QsXG4gICAgcGF0aDogcGFydHkucGF0aCxcbiAgICBiYXNlUGF0aDogcGFydHlTb2NrZXRPcHRpb25zLmJhc2VQYXRoLFxuICAgIHByb3RvY29sczogcHJvdG9jb2xzLFxuICAgIHNvY2tldE9wdGlvbnM6IHNvY2tldE9wdGlvbnMsXG4gICAgdXJsUHJvdmlkZXI6IHBhcnR5LnVybFByb3ZpZGVyXG4gIH07XG59XG4iLCAiLyoqXG4gKiBjbGllbnQvcGFydHlidXMudHMgXHUyMDE0IGJyb3dzZXItc2lkZSBQYXJ0eUJ1cyBhZGFwdGVyLlxuICpcbiAqIFB1YmxpYyBBUEkgKGtlcHQgQllURS1GT1ItQllURSBpZGVudGljYWwgdG8gdGhlIGlubGluZSBQYXJ0eUJ1cyBibG9ja1xuICogdGhhdCBwcmV2aW91c2x5IGxpdmVkIGluIGVhY2ggSFRNTCwgc28gbm8gYnVzaW5lc3MtbG9naWMgY2FsbCBzaXRlIGhhc1xuICogdG8gY2hhbmdlKTpcbiAqXG4gKiAgIFBhcnR5QnVzLmVtaXQodHlwZSwgcGF5bG9hZCkgICAgICAgICAgIFx1MjAxNCBzZW5kIGNvbW1hbmQgdG8gc2VydmVyXG4gKiAgIFBhcnR5QnVzLm9uKHR5cGUsIGNiKSAgICAgICAgICAgICAgICAgIFx1MjAxNCBzdWJzY3JpYmUgdG8gc2VydmVyIGV2ZW50c1xuICpcbiAqIE5ldyAoYWRkaXRpdmUpIEFQSSBmb3IgUGhhc2UgMzpcbiAqXG4gKiAgIFBhcnR5QnVzLmluaXQoey4uLn0pICAgICAgICAgICAgICAgICAgIFx1MjAxNCBvcGVuIHRoZSBXZWJTb2NrZXRcbiAqICAgUGFydHlCdXMub25TdGF0dXMoY2IpICAgICAgICAgICAgICAgICAgXHUyMDE0IGNvbm5lY3Rpb24tc3RhdHVzIHVwZGF0ZXNcbiAqICAgUGFydHlCdXMuZ2V0U3RhdHVzKCkgICAgICAgICAgICAgICAgICAgXHUyMDE0IGN1cnJlbnQgY29ubmVjdGlvbiBzdGF0dXNcbiAqICAgUGFydHlCdXMuZ2V0Q29udHJvbENvZGUoKSAgICAgICAgICAgICAgXHUyMDE0IGFzc2lzdGFudC1zaWRlIGFjY2Vzc29yXG4gKlxuICogQnVuZGxlZCB0byAvcHVibGljL2xpYi9wYXJ0eWJ1cy5qcyBhcyBhbiBJSUZFOyBhc3NpZ25zIGB3aW5kb3cuUGFydHlCdXNgXG4gKiBzeW5jaHJvbm91c2x5IHNvIGxlZ2FjeSBpbmxpbmUgc2NyaXB0cyBjYW4gY2FsbCBQYXJ0eUJ1cy5lbWl0L29uIHdpdGhvdXRcbiAqIHdhaXRpbmcgZm9yIGEgbW9kdWxlIGxvYWQuXG4gKi9cblxuaW1wb3J0IFBhcnR5U29ja2V0IGZyb20gJ3BhcnR5c29ja2V0JztcblxudHlwZSBSb2xlID0gJ2Fzc2lzdGFudCcgfCAncHJlc2VudGVyJyB8ICdwYXJ0aWNpcGFudCc7XG50eXBlIFN0YXR1cyA9ICdjb25uZWN0aW5nJyB8ICdjb25uZWN0ZWQnIHwgJ2Rpc2Nvbm5lY3RlZCc7XG50eXBlIExpc3RlbmVyID0gKHBheWxvYWQ6IHVua25vd24pID0+IHZvaWQ7XG50eXBlIFN0YXR1c0xpc3RlbmVyID0gKHN0YXR1czogU3RhdHVzKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgSW5pdE9wdGlvbnMge1xuICByb2xlOiBSb2xlO1xuICByb29tSWQ6IHN0cmluZztcbiAgbmFtZT86IHN0cmluZzsgICAgICAgICAgICAvLyBwYXJ0aWNpcGFudCBvbmx5XG4gIHRlYW0/OiBzdHJpbmc7ICAgICAgICAgICAgLy8gcGFydGljaXBhbnQgb25seVxuICAvKiogT3ZlcnJpZGUgc2VydmVyIGhvc3QuIERlZmF1bHQ6IHdpbmRvdy5sb2NhdGlvbi5ob3N0IChzYW1lLW9yaWdpbikuICovXG4gIGhvc3Q/OiBzdHJpbmc7XG4gIC8qKiBQYXJ0eUtpdCBcInBhcnR5XCIgbmFtZS4gRGVmYXVsdDogJ21haW4nLiAqL1xuICBwYXJ0eT86IHN0cmluZztcbn1cblxuY29uc3QgU0VTU0lPTl9TVE9SQUdFX0NDX0tFWSA9ICdwZ2dfYXNzaXN0YW50X2NvbnRyb2xjb2RlX3YxJztcblxuY2xhc3MgUGFydHlCdXNJbXBsIHtcbiAgcHJpdmF0ZSBsaXN0ZW5lcnMgPSBuZXcgTWFwPHN0cmluZywgTGlzdGVuZXJbXT4oKTtcbiAgcHJpdmF0ZSBzdGF0dXNMaXN0ZW5lcnM6IFN0YXR1c0xpc3RlbmVyW10gPSBbXTtcbiAgcHJpdmF0ZSBzb2NrZXQ6IFBhcnR5U29ja2V0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcm9sZTogUm9sZSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGNvbnRyb2xDb2RlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgLy8gRGVmYXVsdCAnY29ubmVjdGluZycgKG5vdCAnZGlzY29ubmVjdGVkJykgc28gYSBmcmVzaGx5LWxvYWRlZCBwYWdlIHNob3dzXG4gIC8vIGEgbmV1dHJhbCBcIndhcm1pbmcgdXBcIiBpbmRpY2F0b3IgaW5zdGVhZCBvZiBhIHNjYXJ5IHJlZCBkaXNjb25uZWN0ZWRcbiAgLy8gZmxhc2ggYmVmb3JlIGluaXQoKSBydW5zLiBTdGF5cyAnY29ubmVjdGluZycgdW50aWwgdGhlIFdlYlNvY2tldCBvcGVuc1xuICAvLyAob3IgZmFpbHMpLiBQaGFzZSAwIHJlZyAjMyBcdTIwMTQgXCJcdTY1QjdcdTdEREFcdTYzRDBcdTc5M0FcdTY2MkZcdTc1NzBcdTVFMzhcdTcyQzBcdTYxNEIsXHU1MjFEXHU1OUNCXHU4RjA5XHU1MTY1XHU0RTBEXHU4QTcyXHU4OUY4XHU3NjdDXCIuXG4gIHByaXZhdGUgc3RhdHVzOiBTdGF0dXMgPSAnY29ubmVjdGluZyc7XG5cbiAgaW5pdChvcHRzOiBJbml0T3B0aW9ucyk6IHZvaWQge1xuICAgIGlmICh0aGlzLnNvY2tldCkge1xuICAgICAgY29uc29sZS53YXJuKCdQYXJ0eUJ1cy5pbml0IGNhbGxlZCBtb3JlIHRoYW4gb25jZTsgaWdub3JpbmcnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5yb2xlID0gb3B0cy5yb2xlO1xuXG4gICAgLy8gUmVzdG9yZSBwcmV2aW91c2x5LWlzc3VlZCBjb250cm9sQ29kZSBmcm9tIHNlc3Npb25TdG9yYWdlIChhc3Npc3RhbnRcbiAgICAvLyByZWZyZXNoaW5nIHRoZSBwYWdlIHNob3VsZCBub3QgbG9zZSBob3N0IHByaXZpbGVnZXMpLlxuICAgIGlmIChvcHRzLnJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdG9yZWQgPSBzZXNzaW9uU3RvcmFnZS5nZXRJdGVtKFNFU1NJT05fU1RPUkFHRV9DQ19LRVkpO1xuICAgICAgICBpZiAoc3RvcmVkKSB0aGlzLmNvbnRyb2xDb2RlID0gc3RvcmVkO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIHNlc3Npb25TdG9yYWdlIG1heSBiZSBkaXNhYmxlZCBpbiBzb21lIGVtYmVkZGVkIGNvbnRleHRzICovXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcXVlcnk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IHJvbGU6IG9wdHMucm9sZSB9O1xuICAgIGlmIChvcHRzLm5hbWUpIHF1ZXJ5Lm5hbWUgPSBvcHRzLm5hbWU7XG4gICAgaWYgKG9wdHMudGVhbSkgcXVlcnkudGVhbSA9IG9wdHMudGVhbTtcbiAgICBpZiAob3B0cy5yb2xlID09PSAnYXNzaXN0YW50JyAmJiB0aGlzLmNvbnRyb2xDb2RlKSB7XG4gICAgICBxdWVyeS5jb250cm9sQ29kZSA9IHRoaXMuY29udHJvbENvZGU7XG4gICAgfVxuXG4gICAgdGhpcy5zb2NrZXQgPSBuZXcgUGFydHlTb2NrZXQoe1xuICAgICAgaG9zdDogb3B0cy5ob3N0ID8/IHdpbmRvdy5sb2NhdGlvbi5ob3N0LFxuICAgICAgcGFydHk6IG9wdHMucGFydHkgPz8gJ21haW4nLFxuICAgICAgcm9vbTogb3B0cy5yb29tSWQsXG4gICAgICBxdWVyeSxcbiAgICB9KTtcblxuICAgIHRoaXMuc2V0U3RhdHVzKCdjb25uZWN0aW5nJyk7XG5cbiAgICB0aGlzLnNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdvcGVuJywgKCkgPT4gdGhpcy5zZXRTdGF0dXMoJ2Nvbm5lY3RlZCcpKTtcbiAgICB0aGlzLnNvY2tldC5hZGRFdmVudExpc3RlbmVyKCdjbG9zZScsICgpID0+IHRoaXMuc2V0U3RhdHVzKCdkaXNjb25uZWN0ZWQnKSk7XG4gICAgdGhpcy5zb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignZXJyb3InLCAoKSA9PiB0aGlzLnNldFN0YXR1cygnZGlzY29ubmVjdGVkJykpO1xuXG4gICAgdGhpcy5zb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIChlOiBNZXNzYWdlRXZlbnQpID0+IHtcbiAgICAgIGxldCBlbnY6IHsgdHlwZT86IHN0cmluZzsgcGF5bG9hZD86IHVua25vd24gfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGVudiA9IEpTT04ucGFyc2UodHlwZW9mIGUuZGF0YSA9PT0gJ3N0cmluZycgPyBlLmRhdGEgOiAnJyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKCFlbnYgfHwgdHlwZW9mIGVudi50eXBlICE9PSAnc3RyaW5nJykgcmV0dXJuO1xuXG4gICAgICAvLyBJbnRlcmNlcHQgc2VydmVyLXByaXZhdGUgZnJhbWVzIGJlZm9yZSBkaXNwYXRjaGluZy5cbiAgICAgIGlmIChlbnYudHlwZSA9PT0gJ19fd2VsY29tZV9fJykge1xuICAgICAgICBjb25zdCB3cCA9IGVudi5wYXlsb2FkIGFzIHsgY29udHJvbENvZGU/OiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHdwPy5jb250cm9sQ29kZSAmJiB0aGlzLnJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICAgICAgdGhpcy5jb250cm9sQ29kZSA9IHdwLmNvbnRyb2xDb2RlO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzZXNzaW9uU3RvcmFnZS5zZXRJdGVtKFNFU1NJT05fU1RPUkFHRV9DQ19LRVksIHdwLmNvbnRyb2xDb2RlKTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIGlnbm9yZSAqL1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChlbnYudHlwZSA9PT0gJ19fZXJyb3JfXycpIHtcbiAgICAgICAgLy8gU3VyZmFjZSBzZXJ2ZXIgZXJyb3JzIHRvIGNvbnNvbGUgc28gZGVidWdnaW5nIGlzIGVhc2llcjsgc3RpbGxcbiAgICAgICAgLy8gZGlzcGF0Y2ggdG8gbGlzdGVuZXJzIGluIGNhc2UgdGhlIEhUTUwgd2FudHMgdG8gcmVuZGVyIGFuIGFsZXJ0LlxuICAgICAgICBjb25zb2xlLndhcm4oJ1BhcnR5QnVzIHNlcnZlciBlcnJvcjonLCBlbnYucGF5bG9hZCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2Rpc3BhdGNoKGVudi50eXBlLCBlbnYucGF5bG9hZCk7XG4gICAgfSk7XG4gIH1cblxuICBlbWl0KHR5cGU6IHN0cmluZywgcGF5bG9hZD86IHVua25vd24pOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuc29ja2V0KSB7XG4gICAgICBjb25zb2xlLndhcm4oYFBhcnR5QnVzLmVtaXQoJyR7dHlwZX0nKSBjYWxsZWQgYmVmb3JlIGluaXQoKSBcdTIwMTQgZHJvcHBlZGApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBlbnY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlLCBwYXlsb2FkIH07XG4gICAgLy8gQXV0by1hdHRhY2ggY29udHJvbENvZGUgZm9yIGFzc2lzdGFudC1pc3N1ZWQgY29tbWFuZHMuIFNlcnZlciBvbmx5XG4gICAgLy8gcmVxdWlyZXMgaXQgZm9yIHByaXZpbGVnZWQgb25lcywgYnV0IGF0dGFjaGluZyB0byBhbGwgaXMgaGFybWxlc3NcbiAgICAvLyBhbmQgYXZvaWRzIG5lZWRpbmcgYSBkdXBsaWNhdGUgXCJpcyB0aGlzIHByaXZpbGVnZWQ/XCIgdGFibGUgb24gdGhlXG4gICAgLy8gY2xpZW50LlxuICAgIGlmICh0aGlzLnJvbGUgPT09ICdhc3Npc3RhbnQnICYmIHRoaXMuY29udHJvbENvZGUpIHtcbiAgICAgIGVudi5jb250cm9sQ29kZSA9IHRoaXMuY29udHJvbENvZGU7XG4gICAgfVxuICAgIHRoaXMuc29ja2V0LnNlbmQoSlNPTi5zdHJpbmdpZnkoZW52KSk7XG4gIH1cblxuICBvbih0eXBlOiBzdHJpbmcsIGNiOiBMaXN0ZW5lcik6IHZvaWQge1xuICAgIGxldCBhcnIgPSB0aGlzLmxpc3RlbmVycy5nZXQodHlwZSk7XG4gICAgaWYgKCFhcnIpIHtcbiAgICAgIGFyciA9IFtdO1xuICAgICAgdGhpcy5saXN0ZW5lcnMuc2V0KHR5cGUsIGFycik7XG4gICAgfVxuICAgIGFyci5wdXNoKGNiKTtcbiAgfVxuXG4gIG9uU3RhdHVzKGNiOiBTdGF0dXNMaXN0ZW5lcik6IHZvaWQge1xuICAgIHRoaXMuc3RhdHVzTGlzdGVuZXJzLnB1c2goY2IpO1xuICAgIC8vIFJlcGxheSBjdXJyZW50IHN0YXR1cyBpbW1lZGlhdGVseSBzbyBzdWJzY3JpYmVycyBjYW4gcmVuZGVyIGNvcnJlY3RseVxuICAgIC8vIGV2ZW4gaWYgdGhleSByZWdpc3RlcmVkIGFmdGVyIGEgY29ubmVjdGlvbiBldmVudC5cbiAgICB0cnkge1xuICAgICAgY2IodGhpcy5zdGF0dXMpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc29sZS5lcnJvcignUGFydHlCdXMgc3RhdHVzIGxpc3RlbmVyIGVycm9yOicsIGVycik7XG4gICAgfVxuICB9XG5cbiAgZ2V0U3RhdHVzKCk6IFN0YXR1cyB7XG4gICAgcmV0dXJuIHRoaXMuc3RhdHVzO1xuICB9XG5cbiAgZ2V0Q29udHJvbENvZGUoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMuY29udHJvbENvZGU7XG4gIH1cblxuICAvKiogVGVzdC9kZWJ1ZyBoZWxwZXIgXHUyMDE0IGRyb3AgdGhlIHNhdmVkIGNvbnRyb2xDb2RlIHNvIHRoZSBuZXh0IGluaXQoKVxuICAgKiBhY3RzIGFzIGEgZnJlc2ggYXNzaXN0YW50IGNvbm5lY3Rpb24uIE5vdCB1c2VkIGJ5IGFwcCBjb2RlLiAqL1xuICBmb3JnZXRDb250cm9sQ29kZSgpOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRyb2xDb2RlID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgc2Vzc2lvblN0b3JhZ2UucmVtb3ZlSXRlbShTRVNTSU9OX1NUT1JBR0VfQ0NfS0VZKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGlnbm9yZSAqL1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBJbnRlcm5hbHNcbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgcHJpdmF0ZSBfZGlzcGF0Y2godHlwZTogc3RyaW5nLCBwYXlsb2FkOiB1bmtub3duKTogdm9pZCB7XG4gICAgY29uc3QgYXJyID0gdGhpcy5saXN0ZW5lcnMuZ2V0KHR5cGUpO1xuICAgIGlmICghYXJyKSByZXR1cm47XG4gICAgZm9yIChjb25zdCBjYiBvZiBhcnIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNiKHBheWxvYWQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYFBhcnR5QnVzIGxpc3RlbmVyWyR7dHlwZX1dIGVycm9yOmAsIGVycik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXRTdGF0dXMoczogU3RhdHVzKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RhdHVzID09PSBzKSByZXR1cm47XG4gICAgdGhpcy5zdGF0dXMgPSBzO1xuICAgIGZvciAoY29uc3QgY2Igb2YgdGhpcy5zdGF0dXNMaXN0ZW5lcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNiKHMpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ1BhcnR5QnVzIHN0YXR1cyBsaXN0ZW5lciBlcnJvcjonLCBlcnIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5jb25zdCBQYXJ0eUJ1cyA9IG5ldyBQYXJ0eUJ1c0ltcGwoKTtcbih3aW5kb3cgYXMgdW5rbm93biBhcyB7IFBhcnR5QnVzOiBQYXJ0eUJ1c0ltcGwgfSkuUGFydHlCdXMgPSBQYXJ0eUJ1cztcbmV4cG9ydCBkZWZhdWx0IFBhcnR5QnVzO1xuIiwgIi8qKlxuICogY2xpZW50L2Jhbmtsb2FkZXIudHMgXHUyMDE0IGZldGNoIHRoZSA1IEJBTksgSlNPTnMgZnJvbSAvZGF0YS8gYW5kIG5vcm1hbGl6ZVxuICogdGhlbSBpbnRvIHRoZSBmbGF0IHNoYXBlIHRoYXQgdGhlIHRocmVlIEhUTUxzIGV4cGVjdC5cbiAqXG4gKiBQaGFzZSAwIFExMSBkZXBsb3ltZW50IHBsYW46IEJBTksgbGl2ZXMgYXQgL3B1YmxpYy9kYXRhLyBhcyBzdGF0aWNcbiAqIEpTT04sIHNlcnZlZCBieSBDbG91ZGZsYXJlIFBhZ2VzLiBBbGwgdGhyZWUgY2xpZW50cyBmZXRjaCBvbiBsb2FkLlxuICogU2VydmVyIGlzIHN0aWxsIGF1dGhvcml0YXRpdmUgZm9yIHF1ZXN0aW9uIHNlbGVjdGlvbiAoZ2V0cyBidW5kbGVkXG4gKiBjb3BpZXMgYXQgYnVpbGQgdGltZSk7IGNsaWVudHMgb25seSBuZWVkIHRoZSBiYW5rIGZvciBjb250ZW50IGxvb2t1cFxuICogKHN0ZW0gLyBvcHRpb25zIC8gYW5zd2VyIHRleHQgZ2l2ZW4gYSBxdWVzdGlvbiBpZCkuXG4gKlxuICogQnVuZGxlZCBpbnRvIHRoZSBzYW1lIElJRkUgYXMgUGFydHlCdXMgYW5kIGV4cG9zZWQgYXRcbiAqIGB3aW5kb3cuUEdHQmFua0xvYWRlcmAgc28gdGhlIGV4aXN0aW5nIGlubGluZSBzY3JpcHRzIGNhbiBjYWxsIGl0XG4gKiB3aXRob3V0IEVTTSBneW1uYXN0aWNzLlxuICovXG5cbnR5cGUgRGlmZmljdWx0eSA9ICdlYXN5JyB8ICdtZWRpdW0nIHwgJ2hhcmQnIHwgJ2hlbGwnIHwgJ3B1cmdhdG9yeSc7XG5cbmNvbnN0IEFMTF9ESUZGSUNVTFRJRVM6IERpZmZpY3VsdHlbXSA9IFsnZWFzeScsICdtZWRpdW0nLCAnaGFyZCcsICdoZWxsJywgJ3B1cmdhdG9yeSddO1xuXG5jb25zdCBJRF9QUkVGSVhfVE9fRElGRjogUmVjb3JkPHN0cmluZywgRGlmZmljdWx0eT4gPSB7XG4gIEU6ICdlYXN5JyxcbiAgTTogJ21lZGl1bScsXG4gIEg6ICdoYXJkJyxcbiAgWDogJ2hlbGwnLFxuICBQOiAncHVyZ2F0b3J5Jyxcbn07XG5cbmNvbnN0IFNZU1RFTV9BX1RZUEVTID0gWydzaG9ydF9hbnN3ZXInLCAnbXVsdGlwbGVfY2hvaWNlJywgJ2Vzc2F5JywgJ2NhbGN1bGF0aW9uJywgJ3dvcmRfZ2FtZSddO1xuXG5pbnRlcmZhY2UgUmF3UXVlc3Rpb24ge1xuICBpZDogc3RyaW5nO1xuICB0b3BpYzogc3RyaW5nO1xuICB0eXBlPzogc3RyaW5nO1xuICBbazogc3RyaW5nXTogdW5rbm93bjtcbn1cblxuaW50ZXJmYWNlIE5vcm1hbGl6ZWRCYW5rIHtcbiAgcXVlc3Rpb25zOiBSYXdRdWVzdGlvbltdOyAgICAgICAgICAgLy8gYWx3YXlzIGZsYXQgd2l0aCBgdHlwZWAgZmllbGRcbiAgY291bnQ6IG51bWJlcjtcbiAgYnlUeXBlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICB1cGxvYWRlZEF0OiBzdHJpbmc7XG4gIGZpbGVuYW1lOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b0xvYWRPcHRpb25zIHtcbiAgLyoqIFBhdGggcHJlZml4IGZvciBmZXRjaC4gRGVmYXVsdDogJ2RhdGEvJyAocmVsYXRpdmUgXHUyMDE0IHdvcmtzIGZpbGU6Ly8gKyBodHRwKS4gKi9cbiAgYmFzZVVybD86IHN0cmluZztcbiAgLyoqIEZpcmVkIGFmdGVyIGVhY2ggZmlsZSBpcyBsb2FkZWQgKG9yIGZhaWxzKS4gKi9cbiAgb25Qcm9ncmVzcz86IChsb2FkZWQ6IG51bWJlciwgdG90YWw6IG51bWJlciwgZGlmZmljdWx0eTogRGlmZmljdWx0eSkgPT4gdm9pZDtcbiAgLyoqIEZpcmVkIHdpdGggZWFjaCBwZXItZmlsZSBlcnJvci4gKi9cbiAgb25FcnJvcj86IChkaWZmaWN1bHR5OiBEaWZmaWN1bHR5LCBtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0b0xvYWRSZXN1bHQge1xuICBvazogYm9vbGVhbjtcbiAgYmFua3M6IFBhcnRpYWw8UmVjb3JkPERpZmZpY3VsdHksIE5vcm1hbGl6ZWRCYW5rPj47XG4gIGVycm9yczogeyBkaWZmaWN1bHR5OiBEaWZmaWN1bHR5OyBtZXNzYWdlOiBzdHJpbmcgfVtdO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemUoZGlmZjogRGlmZmljdWx0eSwgcGFyc2VkOiB1bmtub3duLCBmaWxlbmFtZTogc3RyaW5nKTogTm9ybWFsaXplZEJhbmsge1xuICBpZiAoZGlmZiA9PT0gJ3B1cmdhdG9yeScpIHtcbiAgICAvLyBTeXN0ZW0gQjogZmxhdCBhcnJheTsgZWFjaCBpdGVtIGhhcyBpdHMgb3duIGB0eXBlYCBmaWVsZC5cbiAgICBjb25zdCByb290ID0gcGFyc2VkIGFzIHsgcXVlc3Rpb25zPzogUmF3UXVlc3Rpb25bXSB9O1xuICAgIGNvbnN0IGFyciA9IEFycmF5LmlzQXJyYXkocm9vdC5xdWVzdGlvbnMpID8gcm9vdC5xdWVzdGlvbnMgOiBbXTtcbiAgICBjb25zdCBieVR5cGU6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IHEgb2YgYXJyKSB7XG4gICAgICBjb25zdCB0ID0gcS50eXBlID8/ICd1bmtub3duJztcbiAgICAgIGJ5VHlwZVt0XSA9IChieVR5cGVbdF0gPz8gMCkgKyAxO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgcXVlc3Rpb25zOiBhcnIsXG4gICAgICBjb3VudDogYXJyLmxlbmd0aCxcbiAgICAgIGJ5VHlwZSxcbiAgICAgIHVwbG9hZGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGZpbGVuYW1lLFxuICAgIH07XG4gIH1cbiAgLy8gU3lzdGVtIEE6IG5lc3RlZCBxdWVzdGlvbnMuPGRpZmZpY3VsdHk+Ljx0eXBlPltdOyBmbGF0dGVuIGFuZCBzdGFtcCBgdHlwZWAuXG4gIGNvbnN0IHJvb3QgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGxldCBiYW5rOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgPSBudWxsO1xuICBjb25zdCBieURpZmYgPSAocm9vdC5xdWVzdGlvbnMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQpPy5bZGlmZl07XG4gIGlmIChieURpZmYgJiYgdHlwZW9mIGJ5RGlmZiA9PT0gJ29iamVjdCcpIGJhbmsgPSBieURpZmYgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGVsc2UgaWYgKHJvb3RbZGlmZl0gJiYgdHlwZW9mIHJvb3RbZGlmZl0gPT09ICdvYmplY3QnKSBiYW5rID0gcm9vdFtkaWZmXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgZWxzZSBpZiAocm9vdC5xdWVzdGlvbnMgJiYgdHlwZW9mIHJvb3QucXVlc3Rpb25zID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShyb290LnF1ZXN0aW9ucykpIHtcbiAgICBiYW5rID0gcm9vdC5xdWVzdGlvbnMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIH1cbiAgaWYgKCFiYW5rKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBleHBlY3RlZCBuZXN0ZWQgcXVlc3Rpb25zLiR7ZGlmZn0uPHR5cGU+IHN0cnVjdHVyZWApO1xuICB9XG4gIGNvbnN0IGZsYXQ6IFJhd1F1ZXN0aW9uW10gPSBbXTtcbiAgY29uc3QgYnlUeXBlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG4gIGZvciAoY29uc3QgdCBvZiBTWVNURU1fQV9UWVBFUykge1xuICAgIGNvbnN0IGFyciA9IGJhbmtbdF07XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGFycikpIGNvbnRpbnVlO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIGFyciBhcyBSYXdRdWVzdGlvbltdKSB7XG4gICAgICBmbGF0LnB1c2goeyAuLi5yYXcsIHR5cGU6IHQgfSk7XG4gICAgfVxuICAgIGJ5VHlwZVt0XSA9IGFyci5sZW5ndGg7XG4gIH1cbiAgaWYgKGZsYXQubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBubyBxdWVzdGlvbnMgZm91bmQgaW4gbmVzdGVkIHN0cnVjdHVyZSBmb3IgJHtkaWZmfWApO1xuICB9XG4gIHJldHVybiB7XG4gICAgcXVlc3Rpb25zOiBmbGF0LFxuICAgIGNvdW50OiBmbGF0Lmxlbmd0aCxcbiAgICBieVR5cGUsXG4gICAgdXBsb2FkZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGZpbGVuYW1lLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkT25lKGRpZmY6IERpZmZpY3VsdHksIGJhc2VVcmw6IHN0cmluZyk6IFByb21pc2U8Tm9ybWFsaXplZEJhbms+IHtcbiAgY29uc3QgZmlsZW5hbWUgPSBgaW5zdXJhbmNlLXF1aXotYmFuay0ke2RpZmZ9Lmpzb25gO1xuICBjb25zdCB1cmwgPSBgJHtiYXNlVXJsfSR7ZmlsZW5hbWV9YDtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IGNhY2hlOiAnbm8tY2FjaGUnIH0pO1xuICBpZiAoIXJlcy5vaykge1xuICAgIHRocm93IG5ldyBFcnJvcihgSFRUUCAke3Jlcy5zdGF0dXN9IGZldGNoaW5nICR7dXJsfWApO1xuICB9XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgSlNPTiBwYXJzZSBmYWlsZWQgZm9yICR7ZmlsZW5hbWV9OiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemUoZGlmZiwgcGFyc2VkLCBmaWxlbmFtZSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGF1dG9Mb2FkKG9wdHM6IEF1dG9Mb2FkT3B0aW9ucyA9IHt9KTogUHJvbWlzZTxBdXRvTG9hZFJlc3VsdD4ge1xuICBjb25zdCBiYXNlVXJsID0gb3B0cy5iYXNlVXJsID8/ICdkYXRhLyc7XG4gIGNvbnN0IGJhbmtzOiBQYXJ0aWFsPFJlY29yZDxEaWZmaWN1bHR5LCBOb3JtYWxpemVkQmFuaz4+ID0ge307XG4gIGNvbnN0IGVycm9yczogQXV0b0xvYWRSZXN1bHRbJ2Vycm9ycyddID0gW107XG4gIGxldCBsb2FkZWQgPSAwO1xuICAvLyBMb2FkIGluIHBhcmFsbGVsIFx1MjAxNCA1IHNtYWxsIGZpbGVzLCBubyBuZWVkIHRvIHNlcmlhbGl6ZS5cbiAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgQUxMX0RJRkZJQ1VMVElFUy5tYXAoYXN5bmMgKGRpZmYpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGJhbmsgPSBhd2FpdCBsb2FkT25lKGRpZmYsIGJhc2VVcmwpO1xuICAgICAgICBiYW5rc1tkaWZmXSA9IGJhbms7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAgICAgZXJyb3JzLnB1c2goeyBkaWZmaWN1bHR5OiBkaWZmLCBtZXNzYWdlOiBtc2cgfSk7XG4gICAgICAgIG9wdHMub25FcnJvcj8uKGRpZmYsIG1zZyk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBsb2FkZWQgKz0gMTtcbiAgICAgICAgb3B0cy5vblByb2dyZXNzPy4obG9hZGVkLCBBTExfRElGRklDVUxUSUVTLmxlbmd0aCwgZGlmZik7XG4gICAgICB9XG4gICAgfSlcbiAgKTtcbiAgcmV0dXJuIHtcbiAgICBvazogZXJyb3JzLmxlbmd0aCA9PT0gMCxcbiAgICBiYW5rcyxcbiAgICBlcnJvcnMsXG4gIH07XG59XG5cbi8qKlxuICogSGVscGVyIGZvciBjbGllbnRzIHdpdGggYSBgQkFOS19TQ0hFTUFgIHRhYmxlIHdoZXJlIGVhY2ggZGlmZmljdWx0eSBoYXNcbiAqIGEgYHByZWZpeGAgKEUvTS9IL1gvUCkuIFVzZWZ1bCBmb3IgYGdldFF1ZXN0aW9uQnlJZChpZClgIGxvb2t1cHMuXG4gKi9cbmZ1bmN0aW9uIGRpZmZpY3VsdHlGb3JJZChpZDogc3RyaW5nKTogRGlmZmljdWx0eSB8IG51bGwge1xuICBjb25zdCBwcmVmaXggPSBpZD8uWzBdPy50b1VwcGVyQ2FzZT8uKCk7XG4gIHJldHVybiBwcmVmaXggPyAoSURfUFJFRklYX1RPX0RJRkZbcHJlZml4XSA/PyBudWxsKSA6IG51bGw7XG59XG5cbmNvbnN0IFBHR0JhbmtMb2FkZXIgPSB7XG4gIGF1dG9Mb2FkLFxuICBkaWZmaWN1bHR5Rm9ySWQsXG59O1xuXG4od2luZG93IGFzIHVua25vd24gYXMgeyBQR0dCYW5rTG9hZGVyOiB0eXBlb2YgUEdHQmFua0xvYWRlciB9KS5QR0dCYW5rTG9hZGVyID0gUEdHQmFua0xvYWRlcjtcblxuZXhwb3J0IGRlZmF1bHQg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
