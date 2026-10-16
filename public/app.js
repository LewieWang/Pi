/**
 * Pi WebUI 前端
 * 浏览器 ↔ server.js (WebSocket) ↔ pi --mode rpc (JSONL)
 *
 * 浏览器发送: { type: "rpc", command: {...} }   — 命令原样透传给 Pi
 * 浏览器接收: { type: "pi_record", record: {...} } — Pi 的响应与事件原样透传
 * 浏览器↔服务器: { type: "refresh_sessions" } / { type: "sessions_changed", ... }
 * 事件协议见 pi 文档: docs/json.md (事件), docs/rpc-commands.md (命令)
 */
const ws = new WebSocket(`ws://${location.host}`);

// ---------- 状态 ----------
let models = [];            // get_available_models 结果
let currentModel = null;    // {provider, id}
let isStreaming = false;
let streamingEl = null;     // 正在流式输出的 assistant 消息 DOM
let streamingBlocks = [];   // [{kind:'text'|'thinking', el, text}]
let pendingPromptId = null; // 当前 prompt 的请求 id
// 会话累计 usage（供每轮结束的 Token 消耗明细面板使用）。
// 语义与 TUI footer-override 面板一致：input/output/cacheRead/cacheWrite/reasoning
// 均为 assistant 消息 usage 的累加。
let sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
let sessionStartedAt = Date.now(); // 会话开始时间，用于面板里的耗时
let lastUsage = null;              // 流式过程中最近一次 usage（message_update）
let lastContextTokens = 0;         // 最近一条 assistant 消息的总输入 tokens ≈ 当前上下文占用
let modelContextWindow = null;     // 当前模型的上下文窗口（来自 get_available_models）
let roundHadAssistant = false;     // 本轮是否产生过 assistant 消息
let messageCount = 0;

// 会话侧栏状态
let allSessions = [];       // 全量 { path, id, modified, name, firstMessage, ... }
let currentSessionPath = null;  // 当前活跃会话的 jsonl 路径
let historyLoadedOnce = false;  // 本次页面打开后是否已加载过一次历史消息
let currentSessionInfo = null;  // 当前会话的元信息（来自 allSessions 或服务端）
let ephemeralMode = false;
let sessionListFilter = "";

// v0.3: 附件 / Skill 状态
let attachments = []; // [{id, kind:'file'|'image', name, size, mimeType, path?, dataUrl?}]
let maxUploadBytes = 25 * 1024 * 1024; // 默认 25 MB，被 /api/config 覆盖
let availableSkills = []; // 从 get_commands 过滤出来的 skill 条目
let skillFilter = "";
let skillPopoverOpen = false;

// v0.4: / 命令实时补全 + 图片灯箱
let allCommands = []; // get_commands 返回的全量，含 skill/extension/prompt
let cmdPopoverOpen = false;
let cmdFilter = "";
let cmdSelectedIdx = -1; // 当前高亮的命令索引（扁平化后）
let cmdFlattened = []; // 当前渲染的命令扁平列表
let lightboxImages = []; // [{src, name}]
let lightboxIdx = -1;

const $ = (id) => document.getElementById(id);
const MESSAGES_ROOT = $("messages");
// v0.9 多会话视图：每个会话一个 DOM 容器 + 一份渲染状态；
// messagesEl 始终指向「当前活跃会话」的容器（切换 = 换容器 + 换状态）。
let messagesEl = MESSAGES_ROOT;
let activeSessionKey = "default";         // 当前活跃会话：会话文件路径 / new:<ts> / "default"
// v0.9.1: 初始装载 adopt —— 页面刷新后前端 key 还是 "default"，而 get_state 响应
// 携带真实会话 key。需要把前台切到真实会话，否则历史渲染进后台视图、
// 前台永远停在空视图（刷新丢历史 bug）。用模块级标志跨出后台分发的 finally。
let pendingAdoptKey = null;
const sessionViews = new Map();           // key -> {el, st, unread}
const viewAlias = new Map();              // 旧 key -> 新 key（default/new:<ts> rekey 后）
const poolBusy = new Map();               // 会话 tag -> busy（来自 pool_state）
let poolSupported = false;                // server 是否支持会话进程池（hello 里带 sessions）

// 视图需要保存/恢复的全局状态（切会话时切换）
function defaultViewState() {
  return {
    streamingEl: null,
    streamingBlocks: [],
    sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    lastUsage: null,
    lastContextTokens: 0,
    sessionStartedAt: Date.now(),
    roundHadAssistant: false,
    historyLoadedOnce: false,
    currentSessionPath: null,
    currentSessionInfo: null,
    isStreaming: false,
  };
}

function ensureView(key) {
  key = resolveViewKey(key);
  let v = sessionViews.get(key);
  if (!v) {
    const el = document.createElement("div");
    el.className = "session-view";
    v = { el, st: null, unread: 0, scrollTop: 0 };
    sessionViews.set(key, v);
  }
  return v;
}

/** 旧 key（default / new:<ts>）经 rekey 后指向新 key */
function resolveViewKey(key) {
  const seen = new Set();
  let k = key;
  while (viewAlias.has(k) && !seen.has(k)) { seen.add(k); k = viewAlias.get(k); }
  return k;
}

/** 把当前全局状态存回活跃会话的视图 */
function saveViewState() {
  const v = sessionViews.get(activeSessionKey);
  if (!v) return;
  v.st = {
    streamingEl, streamingBlocks, sessionUsage, lastUsage, lastContextTokens,
    sessionStartedAt, roundHadAssistant, historyLoadedOnce, currentSessionPath,
    currentSessionInfo, isStreaming,
  };
  v.scrollTop = MESSAGES_ROOT.scrollTop;
}

/** 把目标会话的视图装载为当前活跃视图（DOM 容器 swap + 全局状态 swap） */
function loadViewState(key) {
  const v = ensureView(key);
  if (v.el.parentNode !== MESSAGES_ROOT) {
    // 先摘掉其它容器（避免多个会话同时上屏），再挂上目标容器
    MESSAGES_ROOT.querySelectorAll(":scope > .session-view").forEach((el) => el.remove());
    MESSAGES_ROOT.appendChild(v.el);
  }
  const st = v.st || defaultViewState();
  streamingEl = st.streamingEl;
  streamingBlocks = st.streamingBlocks;
  sessionUsage = st.sessionUsage;
  lastUsage = st.lastUsage;
  lastContextTokens = st.lastContextTokens;
  sessionStartedAt = st.sessionStartedAt;
  roundHadAssistant = st.roundHadAssistant;
  historyLoadedOnce = st.historyLoadedOnce;
  currentSessionPath = st.currentSessionPath;
  currentSessionInfo = st.currentSessionInfo;
  isStreaming = st.isStreaming;
  messagesEl = v.el;
  MESSAGES_ROOT.scrollTop = v.scrollTop || 0;
}

/** 切换活跃会话（保存当前 → 装载目标） */
function switchActiveSession(key) {
  key = resolveViewKey(key);
  if (key === activeSessionKey) return;
  saveViewState();
  activeSessionKey = key;
  loadViewState(key);
  const v = sessionViews.get(key);
  if (v) v.unread = 0;
  setSendState();
  updateStatusBar();
  renderSessionList();
}

/**
 * 按会话分发记录：非活跃会话 → 临时切到它的视图渲染（后台累积），
 * 再切回活跃会话并重置共享 UI（发送按钮/状态栏）。
 */
function handleRecordForSession(key, record) {
  key = resolveViewKey(key || activeSessionKey);
  if (key === activeSessionKey) { handleRecord(record); return; }
  const prevKey = activeSessionKey;
  // v0.9.1: 初始装载 adopt —— 页面刚刷新时前景还是 "default" 空视图，而首批记录
  // 属于真实会话 key：get_state 响应分发完成后停在该会话（不回切），
  // 后续 get_messages 历史才会渲染进用户看得见的前台容器。
  if (!historyLoadedOnce && !pendingNewSession && key !== prevKey
      && record && record.type === "response" && record.command === "get_state") {
    pendingAdoptKey = key;
  }
  saveViewState();
  activeSessionKey = key; // 关键：临时切到该会话，否则视图内的 rekey/会话态逻辑会误判
  loadViewState(key);
  try {
    handleRecord(record);
  } finally {
    saveViewState();
    // v0.9.1: 三种收尾——① 初始装载 adopt（停在目标会话，不回切）；
    // ② handleRecord 内部主动重映射（new:<ts> 轮换 rekey）→ 跟随新 key；
    // ③ 普通后台分发 → 回到原活跃会话。
    const adoptNow = pendingAdoptKey && resolveViewKey(pendingAdoptKey) === key;
    pendingAdoptKey = null;
    if (adoptNow) {
      // 收养后，旧前台空视图（"default"）成为孤儿：清掉并留 alias（迟到帧仍可路由）
      const orphan = sessionViews.get(prevKey);
      if (orphan && prevKey !== key && !orphan.el.querySelector(".msg, .tool-result")) {
        sessionViews.delete(prevKey);
        viewAlias.set(prevKey, key);
        orphan.el.remove();
      }
      activeSessionKey = key;
      loadViewState(key);
    } else if (activeSessionKey === key) {
      activeSessionKey = prevKey;
      loadViewState(prevKey);
    } else {
      loadViewState(activeSessionKey);
    }
    setSendState();
    updateStatusBar();
  }
}

/** 临时会话拿到真实文件后重映射视图 key（避免同一会话两个 key） */
function rekeySessionView(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  if (!sessionViews.has(oldKey)) return;
  const src = sessionViews.get(oldKey);
  if (sessionViews.has(newKey)) {
    // 目标已存在（先后收到两个 key 的记录）：保留目标视图，丢弃源视图，
    // 只留 alias——两者本就是同一会话，避免内容被覆盖
    sessionViews.delete(oldKey);
    viewAlias.set(oldKey, newKey);
    return;
  }
  sessionViews.delete(oldKey);
  sessionViews.set(newKey, src);
  viewAlias.set(oldKey, newKey);
  if (activeSessionKey === oldKey) activeSessionKey = newKey;
}

// ---------- 日期分组辅助 ----------
const DAY_MS = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function dayBucket(mtime) {
  const today = startOfDay(Date.now()).getTime();
  const d = startOfDay(mtime).getTime();
  const diff = Math.round((today - d) / DAY_MS);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "本周";
  if (diff < 30) return "本月";
  return "更早";
}
function fmtRelative(mtime) {
  const diff = Date.now() - mtime;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff/60000)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff/3600000)} 小时前`;
  if (diff < 7*DAY_MS) return `${Math.floor(diff/DAY_MS)} 天前`;
  const d = new Date(mtime);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

/** 智能摘要：去掉 URL / markdown 标记 / 连续空白，再截前 n 字符。 */
function smartSnippet(text, n) {
  if (!text) return null;
  let t = String(text)
    .replace(/https?:\/\/\S+/g, "")                    // 去 URL
    .replace(/[`*_>#~\-]/g, "")                        // 去常见 markdown 符号
    .replace(/\[(.+?)\]\([^)]+\)/g, "$1")             // [text](url) -> text
    .replace(/<[^>]+>/g, "")                           // 去 HTML
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // 去 emoji
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (t.length > n) t = t.slice(0, n - 1) + "…";
  return t;
}

/** 短时间戳（10-15 10:47），用于无 name 无 firstMessage 的兑底。 */
function fmtLocalTimeShort(localTime) {
  if (!localTime) return null;
  // localTime 形如 "2026-10-15 10:47:06+08:00" → 截成 "10-15 10:47"
  const m = String(localTime).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null;
}

// 格式化 session 起始时间（本地时区）。优先用服务端拼接好的 localTime
//（带时区后缀如 +08:00），否则从 timestamp 现场拼接。
function fmtSessionStart(s) {
  if (s.localTime) return s.localTime;
  if (s.timestamp) {
    const d = new Date(s.timestamp);
    if (!isNaN(d.getTime())) return fmtLocalClock(d);
  }
  return null;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtLocalClock(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const offStr = off === 0 ? "Z" : `${sign}${pad2(Math.floor(abs/60))}:${pad2(abs%60)}`;
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${offStr}`;
}

// ---------- WebSocket ----------
ws.onopen = () => {
  setStatus("online");
  const banner = document.getElementById("conn-banner");
  if (banner) banner.remove();
  // pi 冷启动（加载全部扩展）可能需要数秒~数十秒，先给出可见的等待状态
  if (!historyLoadedOnce) showStartingHint();
  rpc({ type: "get_state" });
  rpc({ type: "get_available_models" });
  rpc({ type: "get_commands" }); // v0.3: 拉 Skill 列表
  loadSessionList();
  loadConfig();
};

// pi 冷启动期间的等待提示（get_state 返回或消息渲染出来后自动清除）
function showStartingHint() {
  if (document.getElementById("starting-hint")) return;
  const div = document.createElement("div");
  div.id = "starting-hint";
  div.className = "msg assistant history-note";
  div.textContent = "⏳ Pi 正在启动（首次加载扩展约需十几秒）…";
  messagesEl.appendChild(div);
}

ws.onclose = () => {
  setStatus("offline");
  showConnBanner();
};
ws.onerror = () => showConnBanner();

function showConnBanner() {
  if (document.getElementById("conn-banner")) return;
  const banner = document.createElement("div");
  banner.id = "conn-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;padding:10px 16px;font-size:13px;z-index:999;text-align:center;";
  banner.textContent = "⚠ 与后端服务断开连接。请确认通过 http://localhost:3210 访问（而不是静态文件预览），并确认 server.js 正在运行。";
  document.body.appendChild(banner);
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.maxUploadBytes === "number" && data.maxUploadBytes > 0) {
      maxUploadBytes = data.maxUploadBytes;
    }
    const hint = $("upload-hint");
    if (hint) {
      const mb = Math.round(maxUploadBytes / 1024 / 1024);
      hint.textContent = `单文件 ≤ ${mb} MB`;
    }
  } catch (e) {
    // 忽略，保留默认 25 MB
  }
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  (window.__inRecords = window.__inRecords || []).push(msg); // 探针/调试：入站记录流水
  if (msg.type === "hello") {
    $("cwd").textContent = msg.cwd;
    ephemeralMode = !!msg.ephemeral;
    updateSessionListNotice();
    applyPoolState(msg);
  } else if (msg.type === "pi_record") {
    // v0.9: 按会话分发 —— 非活跃会话的记录渲染到它自己的容器（后台累积），
    // 切回时直接看到后台继续跑出来的内容，不丢。
    const target = msg.session || activeSessionKey;
    handleRecordForSession(target, msg.record);
    // 后台完成一条 assistant 消息 → 未读角标 +1（一轮一条，不重复计数）
    if (target !== activeSessionKey && msg.record && msg.record.type === "message_end"
        && msg.record.message && msg.record.message.role === "assistant") {
      const v = ensureView(target);
      v.unread = (v.unread || 0) + 1;
      renderSessionList();
    }
  } else if (msg.type === "pi_exited") {
    // v0.9: 只提示「非当前会话」的进程退出（当前会话已有重启文案）
    if (!msg.session || msg.session === activeSessionKey) {
      addSystemNote(`Pi 进程已退出 (code ${msg.code})，下次发消息会自动重启`);
    }
  } else if (msg.type === "pool_state") {
    applyPoolState(msg);
  } else if (msg.type === "session_closed") {
    // 本端请求关闭会话的确认（后端已杀进程）
    handleSessionClosed(msg.session, msg.killed);
  } else if (msg.type === "ui_dialog_resolved") {
    // v0.6.1: 多端仲裁 —— 某端已应答该对话框，本端自动关框（不重复回响应）
    extDialogResolvedRemotely(msg.id);
  } else if (msg.type === "sessions_changed") {
    // 服务端主动广播的列表更新
    applySessionList(msg.sessions || []);
  }
};

function rpc(command) {
  if (ws.readyState !== 1) return;
  // v0.9: 带会话 key —— server 端路由到该会话的 pi 子进程
  ws.send(JSON.stringify({ type: "rpc", command, session: activeSessionKey }));
}

/** 进程池状态 → 侧栏「运行中」动效 */
function applyPoolState(msg) {
  if (!msg || !Array.isArray(msg.sessions)) return;
  poolSupported = true;
  poolBusy.clear();
  for (const s of msg.sessions) poolBusy.set(s.session, !!s.busy);
  renderSessionList();
}

/** 会话是否在跑（有 busy 标记） */
function isSessionBusy(key) {
  if (!key) return false;
  if (poolBusy.has(key)) return poolBusy.get(key);
  for (const [k, v] of poolBusy) {
    if (v && (k === key || k.split(/[\\/]/).pop() === key.split(/[\\/]/).pop())) return true;
  }
  return false;
}

/** 关闭会话（杀后台进程） */
function closeSessionProcess(key) {
  if (!key) return;
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "close_session", session: key }));
}

function handleSessionClosed(key, killed) {
  if (!key) return;
  const v = sessionViews.get(key);
  if (v) v.unread = 0;
  if (key === activeSessionKey) {
    addSystemNote(killed ? "已关闭当前会话的 Pi 进程（下次发消息会自动拉起）" : "该会话无运行中的进程");
    poolBusy.delete(key);
  } else {
    addSystemNote(`已关闭后台会话进程 (${key.split(/[\\/]/).pop()})`);
  }
  renderSessionList();
}

function refreshSessionsFromServer() {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "refresh_sessions" }));
}

// ---------- 处理 Pi 记录 ----------
function handleRecord(rec) {
  switch (rec.type) {
    case "response":
      handleResponse(rec);
      break;
    case "extension_ui_request":
      // v0.6: 扩展 UI 交互（rpc-extension-ui.md 子协议）
      handleExtensionUiRequest(rec);
      break;
    case "agent_start":
      roundHadAssistant = false;
      // v0.6.2: 队列自动投递的新回合也要回到流式态（否则按钮误显示“发送”）
      isStreaming = true;
      setSendState();
      break;
    case "queue_update":
      // v0.6.2: 纯前端 FIFO 模式下 pi 侧队列恒空（我们不用 follow_up），
      // 事件来自其他来源时忽略之，避免覆盖本地队列镜像。
      break;
    case "message_start":
      if (rec.message?.role === "assistant") {
        streamingEl = addMessageEl("assistant", "");
        streamingBlocks = [];
      }
      break;
    case "message_update":
      handleStreamUpdate(rec.assistantMessageEvent);
      updateUsage(rec.usage);
      break;
    case "message_end":
      finalizeMessage(rec.message);
      // v0.9: 新会话首轮发消息后，jsonl 随时落盘——不等到 agent_settled 才刷侧栏，
      // 流式期间就让用户在侧栏里看到这个新会话。防抖：同一轮里多条 message_end 只刷一次。
      if (currentSessionPath && !allSessions.some((s) => s.path === currentSessionPath)
          && !window.__pendingSessionRefresh) {
        window.__pendingSessionRefresh = true;
        setTimeout(() => { window.__pendingSessionRefresh = false; refreshSessionsFromServer(); }, 0);
      }
      break;
    case "tool_execution_start":
      addToolCard(rec.toolCallId, rec.toolName, rec.args);
      setActivity(`⚙ 执行 ${rec.toolName}…`);
      break;
    case "tool_execution_end": {
      updateToolCard(rec.toolCallId, rec.result, rec.isError);
      setActivity("");
      break;
    }
    case "agent_end":
      break;
    case "agent_settled":
      isStreaming = false;
      setSendState();
      setActivity("");
      // 每轮对话结束：追加 Token 消耗明细面板（本轮若有 assistant 输出）
      if (roundHadAssistant) {
        appendTokenPanel();
        roundHadAssistant = false;
      }
      applyCollapse();
      updateStatusBar();
      // v0.6.3: settle 后 forkable 列表重新对齐（含本轮新 user 消息）
      refreshForkable();
      // v0.9: message_end 阶段已补刷，这里防重重触发；仅作兑底（你预测极边、message_end 未触达的场景）
      if (currentSessionPath && !allSessions.some(s => s.path === currentSessionPath)) {
        refreshSessionsFromServer();
      }
      // v0.6.2: 队列非空 → FIFO 投递下一条（开启新回合）
      pumpFollowUpQueue();
      break;
  }
}

function finishPendingNewSession() {
  // v0.6.2: 新会话不继承旧队列
  if (followUpQueue.length) { followUpQueue = []; renderQueueChips(); addSystemNote("已清空 steer 队列（新会话）"); }
  messagesEl.innerHTML = "";
  streamingEl = null;
  streamingBlocks = [];
  sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  lastUsage = null;
  lastContextTokens = 0;
  sessionStartedAt = Date.now();
  pendingNewSession = false;
  // v0.7: 懒创建 flush——会话已建好，自动发出暂存的首条消息
  const fp = pendingFirstPrompt;
  pendingFirstPrompt = null;
  rpc({ type: "get_state" });
  rpc({ type: "get_commands" });
  refreshSessionsFromServer();
  if (fp) {
    // 上面的清空把发送时渲染的用户气泡删了——重建（消息属于新会话）
    addUserMessageWithAttachments(fp.message, fp.atts || []);
    const pcmd = { type: "prompt", message: fp.message };
    if (fp.images && fp.images.length) pcmd.images = fp.images;
    rpc(pcmd);
    addSystemNote("新会话已创建，首条消息已自动发送");
  }
}

function handleResponse(rec) {
  if (!rec.success) {
    addSystemNote(`错误: ${rec.error}`);
    if (rec.command === "prompt") { isStreaming = false; setSendState(); }
    if (rec.command === "fork") lastEditTarget = null; // 悬空目标清理
    return;
  }
  const d = rec.data || {};
  switch (rec.command) {
    case "get_state": {
      const sh = document.getElementById("starting-hint");
      if (sh) sh.remove();
      if (d.model) {
        currentModel = { provider: d.model.provider, id: d.model.id };
        refreshModelSelect();
        modelContextWindow = findModelWindow(currentModel.provider, currentModel.id);
      }
      updateStats(d.messageCount);
      updateStatusBar();
      // v0.9: 视图始终跟随真实会话文件。注意 pi 会在收到首条 prompt 时替换
      // new_session 建的文件（空会话会被轮换），所以不能只处理 default/new:<ts>。
      const sf = d.sessionFile || null;
      if (sf && sf !== activeSessionKey) rekeySessionView(activeSessionKey, sf);
      currentSessionPath = sf;
      if (pendingNewSession) {
        // v0.7: 懒创建态——get_state 返回的还是旧会话信息，不覆盖 pending 状态
        currentSessionPath = null;
        currentSessionInfo = { pending: true, name: "新会话" };
      } else if (currentSessionPath) {
        currentSessionInfo = {
          path: currentSessionPath,
          id: d.sessionId,
          name: d.sessionName || null,
        };
      } else {
        currentSessionInfo = null;
      }
      updateChatHeader();
      highlightActiveSession();
      // v0.9 pool 模式：新会话的 flush 由 get_state 触发（server 已建好全新会话）
      if (pendingNewSession && pendingFirstPrompt && poolSupported && currentSessionPath) {
        finishPendingNewSession();
        break;
      }
      // 刷新页面后：自动把当前会话的历史加载出来，
      // 这样即使不点击会话（或点的就是当前会话）也能看到内容。
      // v0.9.1: 去掉 empty-hint 条件（后台分发时临时视图没有 hint，会误判）；
      // 再加 messageCount 兑底——ephemeral 模式没有 sessionFile，只能靠计数判断。
      if (!historyLoadedOnce && !pendingNewSession
          && (currentSessionPath || (d.messageCount || 0) > 0)) {
        historyLoadedOnce = true;
        rpc({ type: "get_messages" });
      }
      break;
    }
    case "get_available_models":
      models = d.models || [];
      refreshModelSelect();
      if (currentModel) modelContextWindow = findModelWindow(currentModel.provider, currentModel.id);
      updateStatusBar();
      break;
    case "get_commands":
      allCommands = d.commands || [];
      availableSkills = allCommands.filter(c => c.source === "skill");
      if (skillPopoverOpen) renderSkillList();
      if (cmdPopoverOpen) renderCmdList();
      break;
    case "set_model":
      if (d && d.id) {
        currentModel = { provider: d.provider, id: d.id };
        refreshModelSelect();
        modelContextWindow = findModelWindow(d.provider, d.id);
        updateStatusBar();
        addSystemNote(`已切换模型: ${d.provider}/${d.id}`);
      }
      break;
    case "set_session_name":
      // 改名后刷新当前会话 + 列表
      rpc({ type: "get_state" });
      refreshSessionsFromServer();
      addSystemNote("会话已重命名");
      break;
    case "switch_session": {
      const sw = document.getElementById("switching-note");
      if (sw) sw.remove();
      if (d.cancelled) {
        addSystemNote("会话切换被取消（扩展拦截）");
      } else {
        // v0.6.2: 队列归属旧会话，切换即清空（不进持久化，任务卡约定）
        if (followUpQueue.length) { followUpQueue = []; renderQueueChips(); addSystemNote("已清空 steer 队列（会话已切换）"); }
        messagesEl.innerHTML = "";
        streamingEl = null;
        streamingBlocks = [];
        sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
        lastUsage = null;
        lastContextTokens = 0;
        sessionStartedAt = Date.now();
        historyLoadedOnce = true;
        rpc({ type: "get_messages" });
        rpc({ type: "get_state" });
        rpc({ type: "get_commands" }); // v0.3: 不同会话下 Skill 可能不一样
        refreshSessionsFromServer();
      }
      break;
    }
    case "new_session":
      if (d.cancelled) {
        addSystemNote("新建会话被取消（扩展拦截）");
        pendingFirstPrompt = null; // 懒创建被拦：首条消息随取消丢弃，恢复可重发
      } else {
        finishPendingNewSession();
      }
      break;
    case "get_messages":
      historyLoadedOnce = true;
      renderMessages(d.messages || []);
      // v0.6.3: forkable 列表与历史同步刷新（切会话/重拉历史后）
      refreshForkable();
      break;
    case "compact":
      addSystemNote(`已压缩上下文 (节省约 ${d.tokensBefore || "?"} tokens)`);
      rpc({ type: "get_state" });
      break;
    case "export_html":
      addSystemNote(`会话已导出: ${d.path}`);
      break;
    case "get_fork_messages":
      // v0.6.3: 编辑重发候选列表（active branch 上的 user 消息，按序）
      forkableList = Array.isArray(d.messages) ? d.messages : [];
      break;
    case "fork": {
      // v0.6.3: fork 成功 → pi 已在 branched session 中回退到该消息之前
      if (d.cancelled) {
        lastEditTarget = null;
        addSystemNote("编辑重发被扩展拦截（session_before_fork）");
        break;
      }
      const t = lastEditTarget;
      lastEditTarget = null;
      if (t && t.el && t.el.isConnected) {
        // 截断 UI：从该气泡（含）移除到消息区末尾
        let n = t.el;
        while (n) { const next = n.nextSibling; n.remove(); n = next; }
      }
      // 旧分支的排队消息不再有效
      if (followUpQueue.length) {
        followUpQueue = [];
        renderQueueChips();
        addSystemNote("已清空 steer 队列（会话已分支）");
      }
      // 原文回填输入框，改完直接发送
      if (typeof d.text === "string") {
        const inp = $("input");
        inp.value = d.text;
        inp.style.height = "auto";
        inp.style.height = Math.min(inp.scrollHeight, 160) + "px";
        inp.focus();
      }
      addSystemNote("已回退到该消息之前，修改内容后发送即可（旧会话仍保留在侧栏，可自行删除）");
      rpc({ type: "get_state" });   // fork 后 sessionFile 已变更
      refreshForkable();            // 新 branch 的候选列表
      refreshSessionsFromServer();  // 新分支文件进入会话列表
      break;
    }
  }
}

function renderMessages(messages) {
  // 清空但保留流式状态变量（应已被 handleResponse 清空）
  messagesEl.innerHTML = "";
  // 重置会话累计，并从历史消息回填（若有 usage/timestamp）
  sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  sessionStartedAt = Date.now();
  let firstTs = null;
  let lastAssistantUsage = null;
  let renderedCount = 0;
  if (!messages.length) {
    addEmptyHint();
    return;
  }
  for (const m of messages) {
    // v0.6: 完全空且无消耗的 assistant 消息（中断残留）跳过渲染，不占计数
    const skip = isBlankAssistant(m) && isZeroUsage(m.usage);
    if (!skip) {
      renderHistoryMessage(m);
      renderedCount++;
    }
    if (m.timestamp) {
      const ts = new Date(m.timestamp).getTime();
      if (!Number.isNaN(ts) && (firstTs === null || ts < firstTs)) firstTs = ts;
    }
    if (m.role === "assistant" && m.usage) {
      sessionUsage.input += m.usage.input ?? 0;
      sessionUsage.output += m.usage.output ?? 0;
      sessionUsage.cacheRead += m.usage.cacheRead ?? 0;
      sessionUsage.cacheWrite += m.usage.cacheWrite ?? 0;
      sessionUsage.reasoning += m.usage.reasoning ?? 0;
      lastAssistantUsage = m.usage;
    }
  }
  if (firstTs !== null) sessionStartedAt = firstTs;
  // 上下文占用代理：最后一条 assistant 消息的总输入（prompt 大小）
  if (lastAssistantUsage) {
    lastContextTokens = (lastAssistantUsage.input ?? 0) + (lastAssistantUsage.cacheRead ?? 0) + (lastAssistantUsage.cacheWrite ?? 0);
  }
  // 刷新聊天头部消息计数（以实际渲染出的为准，避免依赖 get_state 顺序）
  messageCount = renderedCount;
  updateChatHeader();
  updateStatusBar();
  applyCollapse();
  scrollBottom();
}

// 历史消息渲染：完整呈现 assistant 的 text + thinking + toolCall 块，
// 以及 toolResult 的输出。之前的实现丢失了 251 个 toolCall + 15 个 thinking
// 块，让历史会话看起来「跛脚」。
function renderHistoryMessage(m) {
  if (!m || !m.role) return;
  switch (m.role) {
    case "user":
      renderHistoryUser(m);
      return;
    case "assistant":
      renderHistoryAssistant(m);
      return;
    case "toolResult":
      renderHistoryToolResult(m);
      return;
    case "system":
      // content 是空字符串，真正的提示词在 sections 里；不作为对话展示
      renderHistorySystemNote(m);
      return;
    case "compactionSummary":
      renderHistorySummaryNote(m, "📦 上下文已压缩");
      return;
    case "branchSummary":
      renderHistorySummaryNote(m, "🌿 分支摘要");
      return;
    case "bashExecution":
      renderHistoryBash(m);
      return;
    case "custom":
      // display:false 的自定义消息不展示
      if (m.display === false) return;
      addHistoryNote(`(${m.customType || "custom"}) ${historyExtractText(m)}`);
      return;
    default:
      // 未知 role：dim 系统注记，绝不再兜底成用户气泡
      addHistoryNote(`(${m.role}) ${historyExtractText(m)}`);
      return;
  }
}

// 用户消息：文本 + 图片块都渲染（图片块形如 {type:"image", data:<base64>, mimeType}）
function renderHistoryUser(m) {
  const div = addMessageEl("user", "");
  const content = Array.isArray(m.content) ? m.content : [];
  let hasAny = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) {
      const txt = document.createElement("div");
      txt.className = "md-body";
      txt.innerHTML = PiMD.render(block.text, { streaming: false });
      div.appendChild(txt);
      hasAny = true;
    } else if (block.type === "image") {
      const url = imageBlockToDataUrl(block);
      if (url) {
        const img = document.createElement("img");
        img.className = "msg-image";
        img.src = url;
        img.alt = "用户发送的图片";
        div.appendChild(img);
        hasAny = true;
      }
    }
  }
  if (!hasAny) {
    const span = document.createElement("span");
    span.textContent = "(空消息)";
    div.appendChild(span);
  }
  attachEditBtn(div); // v0.6.3: 编辑重发入口
}

function imageBlockToDataUrl(block) {
  if (!block) return null;
  // 标准形态：{type:"image", data:<base64>, mimeType}
  if (block.data && block.mimeType) return `data:${block.mimeType};base64,${block.data}`;
  // 防御：anthropic 风格 source 包装
  if (block.source && block.source.type === "base64" && block.source.data) {
    return `data:${block.source.media_type || "image/png"};base64,${block.source.data}`;
  }
  return null;
}

// system 消息：只是一条 dim 注记（提示词在 sections 中，不展开）
function renderHistorySystemNote(m) {
  const n = Array.isArray(m.sections) ? m.sections.length : 0;
  addHistoryNote(n ? `🧠 系统提示已加载（${n} 节）` : "🧠 系统提示已加载");
}

// compactionSummary / branchSummary：dim 注记 + 可展开的摘要全文
function renderHistorySummaryNote(m, label) {
  const summary = typeof m.summary === "string" ? m.summary : "";
  const note = document.createElement("div");
  note.className = "msg assistant history-note";
  const head = document.createElement("div");
  head.className = "history-note-head";
  const extra = typeof m.tokensBefore === "number" ? ` · 压缩前 ${m.tokensBefore.toLocaleString()} tokens` : "";
  head.textContent = `${label}${extra}`;
  note.appendChild(head);
  if (summary) {
    const details = document.createElement("details");
    details.className = "history-note-details";
    const sum = document.createElement("summary");
    sum.textContent = "查看摘要";
    details.appendChild(sum);
    const pre = document.createElement("pre");
    pre.className = "history-note-body";
    pre.textContent = summary;
    details.appendChild(pre);
    note.appendChild(details);
  }
  const empty = messagesEl.querySelector(".empty-hint");
  if (empty) empty.remove();
  messagesEl.appendChild(note);
  scrollBottom();
}

// bashExecution（! 命令）：渲染成工具卡样式
function renderHistoryBash(m) {
  const card = document.createElement("div");
  card.className = "tool-result";
  const head = document.createElement("div");
  head.className = "tool-result-head";
  const status = m.exitCode === 0 ? "✓" : `✗ exit ${m.exitCode ?? "?"}`;
  head.innerHTML =
    `<span class="tr-name">$ ${escapeHtml(m.command || "")}</span>` +
    `<span class="tr-status ${m.exitCode === 0 ? "ok" : "err"}">${status}</span>`;
  card.appendChild(head);
  if (m.output) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-body";
    pre.textContent = m.output;
    card.appendChild(pre);
  }
  const empty = messagesEl.querySelector(".empty-hint");
  if (empty) empty.remove();
  messagesEl.appendChild(card);
}

// 通用 dim 历史注记（不占气泡、不占用户侧）
function addHistoryNote(text) {
  if (!text) return;
  const note = document.createElement("div");
  note.className = "msg assistant history-note";
  note.textContent = text;
  const empty = messagesEl.querySelector(".empty-hint");
  if (empty) empty.remove();
  messagesEl.appendChild(note);
  scrollBottom();
}

// v0.6: 空 assistant 消息检测（中断/模型空返回产生的无内容消息）。
// 这类消息渲染成 "(空响应) 0 in / 0 out tokens" 空泡，污染历史视图——直接跳过。
function isBlankAssistant(m) {
  if (!m || m.role !== "assistant") return false;
  const content = Array.isArray(m.content) ? m.content : [];
  return !content.some(b => b && (
    (b.type === "text" && b.text) ||
    (b.type === "thinking" && b.thinking) ||
    b.type === "toolCall"
  ));
}

// v0.6: usage 是否全 0（中断场景常伴随全 0 usage）
function isZeroUsage(u) {
  if (!u) return true;
  return ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) +
          (u.cacheWrite ?? 0) + (u.reasoning ?? 0)) <= 0;
}

function renderHistoryAssistant(m) {
  // v0.6: 完全空的消息不渲染空泡。usage 非全 0 的给一个极简占位，
  // 避免"有 token 消耗却看不到记录"的困惑。
  if (isBlankAssistant(m)) {
    if (!isZeroUsage(m.usage)) {
      const div = addMessageEl("assistant", "");
      const span = document.createElement("span");
      span.className = "blank-response-note";
      span.textContent = "（无文本输出）";
      div.appendChild(span);
      addMeta(div, m.usage);
    }
    return;
  }
  const div = addMessageEl("assistant", "");
  const content = Array.isArray(m.content) ? m.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) {
      const span = document.createElement("div");
      span.className = "md-body";
      span.innerHTML = PiMD.render(block.text, { streaming: false });
      div.appendChild(span);
    } else if (block.type === "thinking" && block.thinking) {
      const t = document.createElement("div");
      t.className = "thinking";
      t.textContent = block.thinking;
      div.appendChild(t);
    } else if (block.type === "toolCall") {
      div.appendChild(buildToolCard(block));
    }
  }
  if (m.usage) addMeta(div, m.usage);
}

function renderHistoryToolResult(m) {
  const card = document.createElement("div");
  card.className = "tool-result";
  const text = historyExtractText(m) || "(无输出)";
  const dur = typeof m.durationMs === "number" ? ` · ${fmtDuration(m.durationMs)}` : "";
  const head = document.createElement("div");
  head.className = "tool-result-head";
  const status = m.isError ? "✗ 失败" : "✓ 完成";
  head.innerHTML =
    `<span class="tr-name">↳ ${escapeHtml(m.toolName || "tool")}</span>` +
    `<span class="tr-status ${m.isError ? "err" : "ok"}">${status}${dur}</span>`;
  card.appendChild(head);
  const pre = document.createElement("pre");
  pre.className = "tool-result-body";
  // 输出可能很长，默认折合显示；点开展开
  pre.textContent = text;
  card.appendChild(pre);
  // read 等工具的图片结果也渲染出来
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (block && block.type === "image") {
        const url = imageBlockToDataUrl(block);
        if (url) {
          const img = document.createElement("img");
          img.className = "msg-image tool-result-image";
          img.src = url;
          img.alt = "工具返回的图片";
          card.appendChild(img);
        }
      }
    }
  }
  messagesEl.appendChild(card);
}

function buildToolCard(block) {
  const card = document.createElement("div");
  card.className = "tool-card history";
  const head = document.createElement("div");
  head.className = "tool-head";
  const toolName = block.name || "tool";
  head.innerHTML = `<span class="tool-name">⚙ ${escapeHtml(toolName)}</span><span class="tool-status ok">完成</span>`;
  card.appendChild(head);
  const args = block.arguments ?? block.args ?? block.input;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = typeof args === "object" && args ? summarizeArgs(args) : "";
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(args, null, 2);
  details.appendChild(pre);
  card.appendChild(details);
  return card;
}

function historyExtractText(m) {
  if (!m || !m.content) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(b => b && (b.type === "text" || b.type === "image"))
      .map(b => (b.type === "image" ? "[图片]" : b.text || ""))
      .join("\n");
  }
  return "";
}

function extractMessageText(m) {
  if (!m || !m.content) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(b => b && b.type === "text").map(b => b.text || "").join("\n");
  }
  return "";
}

// 流式增量
function handleStreamUpdate(evt) {
  if (!evt || !streamingEl) return;
  const idx = evt.contentIndex ?? 0;
  if (evt.type === "text_start" || evt.type === "thinking_start") {
    streamingBlocks[idx] = {
      kind: evt.type === "thinking_start" ? "thinking" : "text",
      el: null, text: "",
    };
  } else if (evt.type === "text_delta" || evt.type === "thinking_delta") {
    const block = streamingBlocks[idx] || (streamingBlocks[idx] = { kind: evt.type === "thinking_delta" ? "thinking" : "text", el: null, text: "" });
    block.text += evt.delta;
    renderBlock(block);
    scrollBottom();
  } else if (evt.type === "text_end" || evt.type === "thinking_end") {
    const block = streamingBlocks[idx];
    if (block) { block.text = evt.content; renderBlock(block, true); }
  }
}

// 流式文本块：Markdown 渐进渲染（60ms 节流，避免长输出每个 delta 全量重排；
// text_end 与 finalize 走 force 立即 painting）
function paintBlock(block) {
  block.el.innerHTML = PiMD.render(block.text, { streaming: true });
}
function renderBlock(block, force) {
  if (!block.el) {
    if (block.kind === "thinking") {
      const div = document.createElement("div");
      div.className = "thinking";
      streamingEl.appendChild(div);
      block.el = div;
    } else {
      const div = document.createElement("div");
      div.className = "md-body";
      streamingEl.appendChild(div);
      block.el = div;
    }
  }
  if (block.kind === "thinking") {
    block.el.textContent = block.text;
    return;
  }
  const now = Date.now();
  if (force || now - (block.lastRender || 0) >= 60) {
    block.lastRender = now;
    paintBlock(block);
  } else if (!block.pending) {
    block.pending = true;
    setTimeout(() => {
      block.pending = false;
      block.lastRender = Date.now();
      paintBlock(block);
      scrollBottom();
    }, 60);
  }
}

function finalizeMessage(message) {
  if (!message || message.role !== "assistant") return;
  roundHadAssistant = true;
  // 累加本条 assistant 消息的 usage 到会话总计。
  // 优先用 message_end 自带的 usage；否则用流式过程中最后一次 updateUsage。
  const u = message.usage || lastUsage;
  if (u) {
    sessionUsage.input += u.input ?? 0;
    sessionUsage.output += u.output ?? 0;
    sessionUsage.cacheRead += u.cacheRead ?? 0;
    sessionUsage.cacheWrite += u.cacheWrite ?? 0;
    sessionUsage.reasoning += u.reasoning ?? 0;
    lastContextTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    updateStatusBar();
  }
  if (streamingEl) {
    // v0.6: 流式结束但整条无内容（中断/空返回）——直接移除空泡，
    // 不在历史里留 "(空响应) 0 in / 0 out tokens" 垃圾。
    // streamingEl.children.length > 0 说明流式中已渲染了 tool 卡片等，不能丢。
    const content = message.content || [];
    const hasContent = content.some(c => c && ((c.type === "text" && c.text) || (c.type === "thinking" && c.thinking)));
    if (!hasContent && streamingEl.children.length === 0 && isZeroUsage(message.usage || lastUsage)) {
      streamingEl.remove();
      streamingEl = null;
      streamingBlocks = [];
      return;
    }
    streamingEl.innerHTML = "";
    for (const c of message.content || []) {
      if (c.type === "text" && c.text) {
        const div = document.createElement("div");
        div.className = "md-body";
        div.innerHTML = PiMD.render(c.text, { streaming: false });
        streamingEl.appendChild(div);
      } else if (c.type === "thinking" && c.thinking) {
        const div = document.createElement("div");
        div.className = "thinking";
        div.textContent = c.thinking;
        streamingEl.appendChild(div);
      }
    }
    addMeta(streamingEl, message.usage);
    streamingEl = null;
    streamingBlocks = [];
    scrollBottom();
  }
}

// ---------- DOM 辅助 ----------
function addMessageEl(role, text) {
  const empty = messagesEl.querySelector(".empty-hint");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

function addMeta(el, usage) {
  if (!usage) return;
  // v0.6: 全 0 usage 不渲染 "0 in / 0 out tokens"（中断产生的空轮次噪音）
  if (isZeroUsage(usage)) return;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${usage.input ?? 0} in / ${usage.output ?? 0} out tokens`;
  el.appendChild(meta);
}

// ---------- Token 消耗明细面板（每轮对话结束追加） ----------
// 设计对齐 TUI footer-override 的「Token 消耗明细」面板：
// 输入（命中/未命中/写入）+ 输出（思考/回复）+ 缓存命中率 + Tokens/耗时。
// 不含「积分」（用户明确不需要）。
function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (sec < 3600) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(sec / 3600);
  const mm = sec % 3600 / 60 | 0;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

function appendTokenPanel() {
  const u = sessionUsage;
  // pi 的 usage 语义（OpenAI 兼容 provider，parseChunkUsage）：
  //   input     = prompt_tokens − cached_tokens − cache_write_tokens（未走缓存的输入）
  //   cacheRead = cached_tokens（缓存命中，供应商实报）
  //   cacheWrite= cache_write_tokens（多数 provider 不上报 → 0 = 未报告）
  // 因此「未命中」就是 input 本身；真实总输入 = input + cacheRead + cacheWrite。
  const cacheMiss = u.input;
  const totalIn = u.input + u.cacheRead + u.cacheWrite;
  const total = totalIn + u.output;
  const reply = Math.max(0, u.output - u.reasoning);
  const hit = totalIn > 0 ? ((u.cacheRead / totalIn) * 100).toFixed(1) + "%" : "0.0%";
  const dur = fmtDuration(Date.now() - sessionStartedAt);

  // 以正常聊天消息的形式追加（与 addSystemNote 同风格，不再用卡片面板）
  const div = document.createElement("div");
  div.className = "msg assistant token-note";
  const lines = [
    `📊 会话累计 Tokens: ${fmtInt(total)} · 耗时 ${dur}`,
    `输入 ${fmtInt(totalIn)} = 未命中 ${fmtInt(cacheMiss)} + 缓存命中 ${fmtInt(u.cacheRead)} + 缓存写入 ${fmtInt(u.cacheWrite)}${u.cacheWrite === 0 ? "（未上报）" : ""}`,
    `输出 ${fmtInt(u.output)} = 思考 ${fmtInt(u.reasoning)} + 回复 ${fmtInt(reply)}`,
    `缓存命中率 ${hit}（来自模型 API usage 实报）`,
  ];
  for (const text of lines) {
    const l = document.createElement("div");
    l.textContent = text;
    div.appendChild(l);
  }
  messagesEl.appendChild(div);
  scrollBottom();
}

function addSystemNote(text) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.style.color = "var(--text-dim)";
  div.style.fontSize = "13px";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollBottom();
}

const toolCards = new Map(); // toolCallId -> {card, pre}
function addToolCard(callId, toolName, args) {
  const empty = messagesEl.querySelector(".empty-hint");
  if (empty) empty.remove();
  const card = document.createElement("div");
  card.className = "tool-card";
  const head = document.createElement("div");
  head.className = "tool-head";
  head.innerHTML = `<span class="tool-name">⚙ ${escapeHtml(toolName)}</span><span class="tool-status">运行中…</span>`;
  card.appendChild(head);
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = typeof args === "object" ? summarizeArgs(args) : "";
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(args, null, 2);
  details.appendChild(pre);
  card.appendChild(details);
  messagesEl.appendChild(card);
  toolCards.set(callId, { card, pre, summary });
  scrollBottom();
}

function updateToolCard(callId, result, isError) {
  const t = toolCards.get(callId);
  if (!t) return;
  const statusEl = t.card.querySelector(".tool-status");
  statusEl.textContent = isError ? "✗ 失败" : "✓ 完成";
  statusEl.className = `tool-status ${isError ? "err" : "ok"}`;
  if (result) {
    const texts = (result.content || []).filter((c) => c.type === "text").map((c) => c.text);
    t.pre.textContent = texts.join("\n") || JSON.stringify(result, null, 2);
    t.summary.textContent = (texts.join(" ") || "查看输出").slice(0, 80);
  }
  scrollBottom();
}

function summarizeArgs(args) {
  if (args.command) return `$ ${args.command}`.slice(0, 100);
  if (args.path || args.file_path) return `📄 ${args.path || args.file_path}`;
  return JSON.stringify(args).slice(0, 100);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- 历史会话侧栏 ----------
async function loadSessionList() {
  if (ephemeralMode) {
    updateSessionListNotice();
    return;
  }
  try {
    const res = await fetch("/api/sessions/list");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applySessionList(data.sessions || []);
    if (currentSessionPath) highlightActiveSession();
  } catch (e) {
    console.error("加载会话列表失败:", e);
    const listEl = $("session-list");
    listEl.innerHTML = `<div class="session-empty">加载失败: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function applySessionList(sessions) {
  // v0.7: 双保险——server 端 listSessionFiles 已过滤空会话；若响应里仍混入
  // （旧 server 未重启 / 广播缓存），前端静默跳过。无 UI、无提示，与 server
  // 的源头过滤行为一致（用户明确不要"已隐藏"式遮丑）。
  allSessions = (sessions || []).filter(s => s.hasMessages !== false);
  renderSessionList();
}

// v0.7: 会话列表渲染——server 端 listSessionFiles 已过滤空会话（只返回有消息的），
// 前端不再需要 v0.6 的降噪行/查看/清理 UI（用户反馈：遮丑不如源头治理）。
function renderSessionList() {
  const listEl = $("session-list");
  const filter = sessionListFilter.trim().toLowerCase();
  const filtered = filter
    ? allSessions.filter(s => {
        const t1 = (s.name || "").toLowerCase();
        const t2 = (s.firstMessage || "").toLowerCase();
        return t1.includes(filter) || t2.includes(filter);
      })
    : allSessions;

  if (ephemeralMode) {
    updateSessionListNotice();
    return;
  }
  // v0.7: 空会话已在 server 端过滤，这里只渲染有内容的会话（搜索逻辑不变）
  if (!filtered.length) {
    listEl.innerHTML = `<div class="session-empty">${allSessions.length ? "无匹配会话" : "暂无历史会话"}</div>`;
    return;
  }

  // 按日期分组
  const groups = new Map();
  for (const s of filtered) {
    const key = dayBucket(s.modified);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const html = [];
  for (const [title, items] of groups) {
    html.push(`<div class="session-group-title">${escapeHtml(title)}</div>`);
    for (const s of items) {
      // v0.9 修：title 优先用用户起的名；没有则智能摘要（去 URL / markdown 符号），
      // 避免侧栏出现 “https://mp.weixin.…” 或“请严格用以下 Markdown…”当标题。
      const cleaned = s.firstMessage ? smartSnippet(s.firstMessage, 40) : null;
      const titleText = s.name || cleaned || fmtLocalTimeShort(s.localTime) || "(空白会话)";
      const started = fmtLocalTimeShort(s.localTime) || fmtSessionStart(s);
      const sizeText = s.size >= 1024 ? (s.size/1024).toFixed(1) + "KB" : s.size + "B";
      // v0.6: 有轮数信息时显示（DSH archive 风格的状态信息），旧 server 无此字段时不显示；
      // v0.7: countsPartial（≥8MB 只扫 80 行）时显示 "N+ 轮" 表示是下界
      const turnText = s.userMessageCount > 0
        ? ` · ${s.userMessageCount}${s.countsPartial ? "+" : ""} 轮`
        : "";
      const metaText = started
        ? `${started} · ${fmtRelative(s.modified)}${turnText} · ${sizeText}`
        : `${fmtRelative(s.modified)}${turnText} · ${sizeText}`;
      const active = s.path === activeSessionKey ? "active" : "";
      // v0.9: 运行中动效 + 后台未读角标
      const running = isSessionBusy(s.path) ? " running" : "";
      const v = sessionViews.get(resolveViewKey(s.path));
      // v0.9 修：当前活跃会话已上屏，不显示未读角标（用户正在看，未读 = 0 语义）
      const unread = (v && v.unread && !active) ? `<span class="s-unread">${v.unread > 99 ? "99+" : v.unread}</span>` : "";
      const safePath = escapeHtml(s.path);
      const safeId = escapeHtml(s.id);
      html.push(`
        <div class="session-item ${active}${running}" data-path="${safePath}" data-id="${safeId}" title="${escapeHtml(s.firstMessage || s.name || s.fileName)}">
          <div class="s-title">${unread}${escapeHtml(titleText)}</div>
          <div class="s-meta">${escapeHtml(metaText)}</div>
          <div class="s-actions">
            <button class="kill" title="关闭该会话的运行进程"${isSessionBusy(s.path) ? "" : " style=\"opacity:.4\""}>⏹</button>
            <button class="del" title="删除">×</button>
          </div>
        </div>
      `);
    }
  }
  listEl.innerHTML = html.join("");

  // 绑定点击 / 删除事件
  listEl.querySelectorAll(".session-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".del") || e.target.closest(".kill")) return;
      const p = el.dataset.path;
      if (p) switchToSession(p);
    });
  });
  // v0.9: ⏹ 关闭该会话的运行进程（不删文件、不影响其它会话）
  listEl.querySelectorAll(".session-item .kill").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = btn.closest(".session-item");
      const p = item.dataset.path;
      if (p) closeSessionProcess(p);
    });
  });
  listEl.querySelectorAll(".session-item .del").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = btn.closest(".session-item");
      deleteSession(item.dataset.path, item.dataset.id);
    });
  });
}

function highlightActiveSession() {
  if (!activeSessionKey) return;
  document.querySelectorAll(".session-item").forEach(el => {
    el.classList.toggle("active", el.dataset.path === activeSessionKey);
  });
}

function updateSessionListNotice() {
  const listEl = $("session-list");
  if (!listEl) return;
  if (ephemeralMode) {
    listEl.innerHTML = `<div class="session-ephemeral-note">当前为临时模式（--ephemeral），会话不会保存。</div>`;
  }
}

function switchToSession(filePath) {
  if (!filePath) return;
  // v0.7: 切去别的会话 = 放弃懒创建的新会话（零文件产生，无垃圾可清）
  pendingNewSession = false;
  pendingFirstPrompt = null;
  if (filePath === activeSessionKey) {
    // 点当前会话：不重发，直接重新拉取历史消息
    rpc({ type: "get_messages" });
    return;
  }
  // v0.9: 每个会话一个独立 pi 进程 —— 切换 = 前端换视图容器 + server 换路由，
  // 不用 pi 的 switch_session（无需等待，旧容器内容保留，后台会话继续累积）
  switchActiveSession(filePath);
  // v0.9: 队列项带会话归属——切换后丢弃旧会话的队列项，否则它们会永久堵在队首
  // （pumpFollowUpQueue 不会投给别的会话）
  const owner = currentSessionPath || null;
  if (followUpQueue.length) {
    const keep = followUpQueue.filter((x) => (x.sessionId || null) === owner);
    if (keep.length !== followUpQueue.length) {
      const dropped = followUpQueue.length - keep.length;
      followUpQueue = keep;
      renderQueueChips();
      addSystemNote(`已丢弃 ${dropped} 条其它会话的 steer 队列项`);
    }
  }
  if (ws.readyState === 1) {
    // 订阅：保证后台/切换过程中的记录继续到达
    ws.send(JSON.stringify({ type: "subscribe_session", session: filePath }));
  }
  rpc({ type: "get_state" });
  rpc({ type: "get_messages" });
  rpc({ type: "get_commands" });
  renderSessionList();
}

async function deleteSession(filePath, id) {
  if (!filePath) return;
  if (!confirm(`确认删除会话？\n${filePath.split(/[\\/]/).pop()}\n（文件会被移到回收不可恢复）`)) return;
  try {
    const res = await fetch("/api/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await res.json();
    if (!data.ok && !res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadSessionList();
    // 如果删除的是当前会话，提示新建
    if (filePath === currentSessionPath) {
      if (confirm("已删除当前会话。要新建一个空会话吗？")) {
        startPendingNewSession(); // v0.7: 懒创建，不再立即 rpc new_session
      }
    }
  } catch (e) {
    alert(`删除失败: ${e.message || e}`);
  }
}

// ---------- v0.3: 附件 chips ----------
function addAttachment(att) {
  attachments.push(att);
  renderChips();
}
function removeAttachment(id) {
  attachments = attachments.filter(a => a.id !== id);
  renderChips();
}
function renderChips() {
  const cont = $("composer-chips");
  if (!cont) return;
  if (!attachments.length) {
    cont.hidden = true;
    cont.innerHTML = "";
    return;
  }
  cont.hidden = false;
  cont.innerHTML = attachments.map(a => {
    if (a.kind === "image") {
      return `<div class="chip image" data-id="${a.id}">
        <img class="chip-thumb" src="${escapeHtml(a.dataUrl)}" alt="">
        <span class="chip-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <button class="chip-remove" title="移除" type="button">×</button>
      </div>`;
    }
    return `<div class="chip file" data-id="${a.id}">
      <span>📎</span>
      <span class="chip-name" title="${escapeHtml(a.path || a.name)}">${escapeHtml(a.name)}</span>
      <button class="chip-remove" title="移除" type="button">×</button>
    </div>`;
  }).join("");
  cont.querySelectorAll(".chip-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.closest(".chip").dataset.id;
      removeAttachment(id);
    });
  });
}

// ---------- v0.3: 文件 / 图片处理 ----------
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function dataUrlToBase64(dataUrl) {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}
async function uploadFileToServer(file) {
  if (file.size > maxUploadBytes) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    throw new Error(`文件过大 (${mb(file.size)} MB > ${mb(maxUploadBytes)} MB)`);
  }
  const dataUrl = await fileToDataUrl(file);
  const dataBase64 = dataUrlToBase64(dataUrl);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      dataBase64,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    try {
      if (file.type && file.type.startsWith("image/")) {
        const dataUrl = await fileToDataUrl(file);
        addAttachment({
          id: genId("img"),
          kind: "image",
          name: file.name,
          size: file.size,
          mimeType: file.type,
          dataUrl,
        });
      } else {
        const result = await uploadFileToServer(file);
        addAttachment({
          id: genId("file"),
          kind: "file",
          name: result.name,
          size: result.size,
          mimeType: result.mimeType,
          path: result.path,
        });
      }
    } catch (e) {
      alert(`处理失败 (${file.name}): ${e.message || e}`);
    }
  }
}

// ---------- v0.3: Skill 弹窗 ----------
function setSkillPopover(open) {
  skillPopoverOpen = open;
  const pop = $("skill-popover");
  const btn = $("btn-pick-skill");
  if (!pop) return;
  pop.hidden = !open;
  if (btn) btn.classList.toggle("active", open);
  if (open) {
    const search = $("skill-search");
    if (search) { search.value = ""; skillFilter = ""; search.focus(); }
    renderSkillList();
  }
}
function renderSkillList() {
  const listEl = $("skill-list");
  const emptyEl = $("skill-empty");
  if (!listEl) return;
  const filter = skillFilter.trim().toLowerCase();
  const items = filter
    ? availableSkills.filter(s =>
        (s.name || "").toLowerCase().includes(filter) ||
        (s.description || "").toLowerCase().includes(filter)
      )
    : availableSkills;
  if (!items.length) {
    listEl.innerHTML = "";
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  listEl.innerHTML = items.map(s => `
    <div class="skill-item" data-name="${escapeHtml(s.name)}">
      <div class="skill-name">/${escapeHtml(s.name)}</div>
      <div class="skill-desc">${escapeHtml(s.description || "(无描述)")}</div>
    </div>
  `).join("");
  listEl.querySelectorAll(".skill-item").forEach(el => {
    el.addEventListener("click", () => {
      const name = el.dataset.name;
      insertSkillCommand(name);
      setSkillPopover(false);
    });
  });
}
function insertSkillCommand(skillName) {
  const input = $("input");
  const cmd = `/skill:${skillName} `;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + cmd + input.value.slice(end);
  input.focus();
  const pos = start + cmd.length;
  input.setSelectionRange(pos, pos);
}

// ---------- v0.4: / 命令实时补全 ----------
// 查找光标位置所在的命令 token（以 / 开头、空白符结束）
function getCmdTokenAtCursor() {
  const input = $("input");
  const text = input.value;
  const cursor = input.selectionStart ?? text.length;
  // 向前扫描直到空白符或开头
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  if (text[start] !== "/") return null;
  // token 不能包含中间斜杠（命令名里只有 / 开头那一个）
  if (text.slice(start + 1, cursor).includes("/")) return null;
  const token = text.slice(start, cursor);
  if (!/^\/[^\s]*$/.test(token)) return null;
  return { token, start, end: cursor };
}

function setCmdPopover(open) {
  cmdPopoverOpen = open;
  const pop = $("cmd-popover");
  if (!pop) return;
  if (open) {
    renderCmdList();
    pop.hidden = false;
  } else {
    pop.hidden = true;
    cmdSelectedIdx = -1;
  }
}

function renderCmdList() {
  const listEl = $("cmd-list");
  const emptyEl = $("cmd-empty");
  if (!listEl) return;
  const filter = cmdFilter.replace(/^\//, "").toLowerCase();
  // 分组：skills → extension → prompt
  const groups = [
    { title: "Skill", items: allCommands.filter(c => c.source === "skill") },
    { title: "扩展命令", items: allCommands.filter(c => c.source === "extension") },
    { title: "提示模板", items: allCommands.filter(c => c.source === "prompt") },
  ];
  // 过滤
  const filteredGroups = groups
    .map(g => ({
      title: g.title,
      items: g.items.filter(c => {
        const name = (c.name || "").toLowerCase();
        const desc = (c.description || "").toLowerCase();
        return !filter || name.includes(filter) || desc.includes(filter);
      }),
    }))
    .filter(g => g.items.length);
  // 扁平化供键盘导航
  cmdFlattened = [];
  const html = [];
  for (const g of filteredGroups) {
    html.push(`<div class="cmd-group-title">${escapeHtml(g.title)}</div>`);
    for (const c of g.items) {
      const idx = cmdFlattened.length;
      cmdFlattened.push(c);
      html.push(`<div class="cmd-item" data-idx="${idx}">
        <div class="cmd-name">/${escapeHtml(c.name)}</div>
        <div class="cmd-desc">${escapeHtml(c.description || "(无描述)")}</div>
      </div>`);
    }
  }
  if (!filteredGroups.length) {
    listEl.innerHTML = "";
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  listEl.innerHTML = html.join("");
  listEl.querySelectorAll(".cmd-item").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (!isNaN(idx)) selectCmdByIdx(idx);
    });
    el.addEventListener("mousemove", () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (!isNaN(idx)) setCmdSelection(idx);
    });
  });
  // 恢复选中状态
  setCmdSelection(cmdSelectedIdx >= 0 ? cmdSelectedIdx : 0);
}

function setCmdSelection(idx) {
  if (!cmdFlattened.length) { cmdSelectedIdx = -1; return; }
  cmdSelectedIdx = Math.max(0, Math.min(idx, cmdFlattened.length - 1));
  const items = document.querySelectorAll(".cmd-item");
  items.forEach((el, i) => el.classList.toggle("active", i === cmdSelectedIdx));
  // 滚动到视区
  const active = items[cmdSelectedIdx];
  if (active) {
    const list = $("cmd-list");
    const aTop = active.offsetTop, aBot = aTop + active.offsetHeight;
    if (aTop < list.scrollTop) list.scrollTop = aTop - 4;
    else if (aBot > list.scrollTop + list.clientHeight) list.scrollTop = aBot - list.clientHeight + 4;
  }
}

function selectCmdByIdx(idx) {
  const c = cmdFlattened[idx];
  if (!c) return;
  // 替换输入框里的 token 为 "/name "
  const input = $("input");
  const tok = getCmdTokenAtCursor();
  if (!tok) return;
  const insert = `/${c.name} `;
  input.value = input.value.slice(0, tok.start) + insert + input.value.slice(tok.end);
  const pos = tok.start + insert.length;
  input.focus();
  input.setSelectionRange(pos, pos);
  setCmdPopover(false);
  // 触发一次 input 事件以刷新其他状态
  input.dispatchEvent(new Event("input"));
}

// ---------- v0.4: 图片灯箱 ----------
function openLightbox(images, idx) {
  if (!images.length) return;
  lightboxImages = images;
  lightboxIdx = Math.max(0, Math.min(idx, images.length - 1));
  renderLightbox();
  $("lightbox").hidden = false;
}
function closeLightbox() {
  $("lightbox").hidden = true;
  lightboxImages = [];
  lightboxIdx = -1;
}
function navLightbox(dir) {
  if (lightboxImages.length <= 1) return;
  lightboxIdx = (lightboxIdx + dir + lightboxImages.length) % lightboxImages.length;
  renderLightbox();
}
function renderLightbox() {
  const img = lightboxImages[lightboxIdx];
  if (!img) return;
  const imgEl = $("lightbox-img");
  const capEl = $("lightbox-caption");
  imgEl.src = img.src;
  imgEl.alt = img.name || "";
  capEl.textContent = img.name || "";
  // 单图时隐藏导航按钮
  const prev = document.querySelector(".lightbox-prev");
  const next = document.querySelector(".lightbox-next");
  const hide = lightboxImages.length <= 1;
  if (prev) prev.style.display = hide ? "none" : "";
  if (next) next.style.display = hide ? "none" : "";
}
function collectAllImages() {
  // 从聊天气泡 + 当前 chip 区收集所有可见图片
  const imgs = [];
  document.querySelectorAll(".msg.user img, .chip.image img").forEach(el => {
    imgs.push({ src: el.src, name: el.alt || el.title || "" });
  });
  return imgs;
}

// ---------- UI 控制 ----------
function setStatus(s) {
  const el = $("pi-status");
  el.textContent = s === "online" ? "已连接" : "未连接";
  el.className = `status ${s}`;
}

function setActivity(text) { $("tool-activity").textContent = text; }

function setSendState() {
  $("btn-send").textContent = isStreaming ? "队列…" : "发送";
  $("btn-send").disabled = false;
}

function updateUsage(usage) {
  // 只记录最近一次 usage，累计在 finalizeMessage（message_end）里做，
  // 避免流式多次 update 重复累加。侧栏 stat-* 已移除。
  if (!usage) return;
  lastUsage = usage;
}

function updateStats(n) {
  // 消息数仍用于聊天头部副标题（· N 条消息）；侧栏 stat-messages 已移除
  if (typeof n === "number") { messageCount = n; }
}

// ---------- v0.5: 顶部状态栏（模型 / 上下文占用 / 累计 tokens / 命中率） ----------
function findModelWindow(provider, id) {
  const m = models.find(x => x.provider === provider && x.id === id) || models.find(x => x.id === id);
  if (!m) return null;
  return m.contextWindow ?? m.context_window ?? m.contextLimit ?? m.max_input_tokens ?? null;
}

function updateStatusBar() {
  const bar = $("statusbar");
  if (!bar) return;
  const parts = [];
  if (currentModel) {
    parts.push(`模型 <b>${escapeHtml(currentModel.provider + "/" + currentModel.id)}</b>`);
  }
  if (lastContextTokens > 0) {
    if (modelContextWindow) {
      const pct = Math.min(100, (lastContextTokens / modelContextWindow) * 100);
      parts.push(`上下文 <b>${fmtInt(lastContextTokens)}</b> / ${fmtInt(modelContextWindow)}（${pct.toFixed(1)}%）`);
    } else {
      parts.push(`上下文 <b>${fmtInt(lastContextTokens)}</b> tokens`);
    }
  }
  const u = sessionUsage;
  const totalIn = u.input + u.cacheRead + u.cacheWrite;
  if (totalIn + u.output > 0) {
    parts.push(`累计 <b>${fmtInt(totalIn)}</b> in / <b>${fmtInt(u.output)}</b> out`);
    if (totalIn > 0) parts.push(`缓存命中 <b>${((u.cacheRead / totalIn) * 100).toFixed(0)}%</b>`);
  }
  if (messageCount) parts.push(`${messageCount} 条消息`);
  bar.innerHTML = parts.map(p => `<span class="sb-item">${p}</span>`).join('<span class="sb-sep">·</span>');
  bar.hidden = parts.length === 0;
}

// ---------- v0.5: 长对话折叠（超过阈值时折叠早期消息，点击展开） ----------
const COLLAPSE_THRESHOLD = 30;
function applyCollapse() {
  const existing = messagesEl.querySelector(".collapse-bar");
  if (existing) existing.remove();
  const kids = Array.from(messagesEl.children).filter(
    (el) => el.classList.contains("msg") || el.classList.contains("tool-card") || el.classList.contains("tool-result")
  );
  if (kids.length <= COLLAPSE_THRESHOLD) return;
  const toHide = kids.slice(0, kids.length - COLLAPSE_THRESHOLD);
  const bar = document.createElement("div");
  bar.className = "collapse-bar";
  bar.textContent = `已折叠 ${toHide.length} 条早期消息 · 点击展开`;
  bar.addEventListener("click", () => {
    toHide.forEach((el) => { el.style.display = ""; });
    bar.remove();
  });
  toHide.forEach((el) => { el.style.display = "none"; });
  messagesEl.insertBefore(bar, toHide[0]);
}

function updateChatHeader() {
  const titleEl = $("chat-title");
  const subEl = $("chat-sub");
  if (currentSessionInfo && currentSessionInfo.pending) {
    // v0.7: 懒创建态——会话文件还没落盘
    titleEl.textContent = "新会话";
    subEl.textContent = "发送第一条消息后创建";
    return;
  }
  if (!currentSessionInfo || !currentSessionPath) {
    titleEl.textContent = "未选择会话";
    subEl.textContent = "";
    return;
  }
  const name = currentSessionInfo.name || deriveNameFromCurrent();
  titleEl.textContent = name || "(未命名)";
  // 显示文件名的简短 id
  const shortId = (currentSessionInfo.id || currentSessionPath).split(/[\\/]/).pop().replace(/\.jsonl$/, "").slice(0, 12);
  subEl.textContent = `id: ${shortId} · ${messageCount} 条消息`;
}

function deriveNameFromCurrent() {
  // 从 allSessions 里找匹配项
  const m = allSessions.find(s => s.path === currentSessionPath);
  return m ? (m.name || (m.firstMessage ? m.firstMessage.slice(0, 40) : null)) : null;
}

function refreshModelSelect() {
  const sel = $("model-select");
  sel.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = `${m.provider}/${m.id}`;
    opt.textContent = m.name || `${m.provider}/${m.id}`;
    if (currentModel && m.provider === currentModel.provider && m.id === currentModel.id) opt.selected = true;
    sel.appendChild(opt);
  }
}

function scrollBottom() {
  // v0.9: 滚动容器永远是 #messages（视图容器只是它的子项）
  MESSAGES_ROOT.scrollTop = MESSAGES_ROOT.scrollHeight;
}

// ---------- 交互 ----------
function sendMessage() {
  const input = $("input");
  const text = input.value.trim();
  if (!text && !attachments.length) return;

  // 收集图片（内存 base64，直接进 prompt.images）
  const images = attachments
    .filter(a => a.kind === "image")
    .map(a => ({
      type: "image",
      data: dataUrlToBase64(a.dataUrl),
      mimeType: a.mimeType,
    }));

  // 收集文件路径，附加到消息文本
  const files = attachments.filter(a => a.kind === "file");
  let promptText = text;
  if (files.length) {
    const lines = files.map(f => `- ${f.path}`).join("\n");
    promptText = text
      ? `${text}\n\n[已上传文件，请用 read 工具读取]\n${lines}`
      : `[请查看我上传的文件，使用 read 工具读取]\n${lines}`;
  }

  // 用户气泡渲染（含附件预览）
  const sentAttachments = attachments.slice();
  addUserMessageWithAttachments(text, sentAttachments);
  input.value = "";
  input.style.height = "auto";
  attachments = [];
  renderChips();
  const wasStreaming = isStreaming; // 发送前快照：是否已有回合在跑
  isStreaming = true;
  setSendState();
  if (wasStreaming) {
    // v0.6.2: 流式中 → 纯前端 FIFO 队列（agent_settled 后自动按序发出）。
    // 不用协议 follow_up：实测 follow_up+clear_queue 组合有入队延迟竞态
    // （input handler 异步入队，移除时 clear 清不到），且纯前端队列
    // 移除 chip 零竞态，刷新清空可接受（任务卡明示）。
    followUpQueue.push({ message: promptText, images, sessionId: currentSessionPath || null });
    renderQueueChips();
  } else if (pendingNewSession) {
    // v0.7: 懒创建态——先发 new_session（pi 会落盘建文件），暂存本条消息，
    // new_session 响应回来后自动发出。避免“点了新建却不发消息”产生空文件。
    // v0.9: 支持会话进程池的 server 已为 new:<ts> key 拉起「全新会话」进程
    // （spawn 时主动 new_session），这里不再发（否则多出一个空文件）。
    pendingFirstPrompt = { message: promptText, images, atts: sentAttachments };
    if (!poolSupported) rpc({ type: "new_session" });
    else rpc({ type: "get_state" }); // 顺带让 server 完成 key→真实路径映射
  } else {
    const cmd = { type: "prompt", message: promptText };
    if (images.length) cmd.images = images;
    rpc(cmd);
  }
}

function addUserMessageWithAttachments(text, atts) {
  const empty = messagesEl.querySelector(".empty-hint");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "msg user";
  if (text) {
    const txt = document.createElement("div");
    txt.textContent = text;
    div.appendChild(txt);
  }
  if (atts && atts.length) {
    const wrap = document.createElement("div");
    wrap.className = "msg-attachments";
    for (const a of atts) {
      if (a.kind === "image") {
        const img = document.createElement("img");
        img.src = a.dataUrl;
        img.className = "msg-attachment-thumb";
        img.alt = a.name;
        wrap.appendChild(img);
      } else {
        const chip = document.createElement("div");
        chip.className = "msg-attachment-file";
        chip.textContent = `📎 ${a.name}`;
        wrap.appendChild(chip);
      }
    }
    div.appendChild(wrap);
  }
  attachEditBtn(div); // v0.6.3: 编辑重发入口
  messagesEl.appendChild(div);
  scrollBottom();
}

// ============================================================
// v0.6.3: 编辑重发（edit & re-ask，协议原生 fork）
//
// 流程：user 气泡 hover 出现 ✎ → 点击 → confirm（提示丢弃条数）→
// rpc fork{entryId}（pi 在 branched session 中回退到该条之前）→
// 截断 UI（该气泡及之后全部移除）→ 原文回填输入框 → 改完发送。
// 序号对齐：forkableList 与 DOM user 气泡同序（都来自 active branch，
// agent_settled / get_messages 后刷新；流式中编辑被拦截，无竞态）。
// ============================================================

function refreshForkable() {
  rpc({ type: "get_fork_messages" });
}

function attachEditBtn(div) {
  const btn = document.createElement("button");
  btn.className = "msg-edit-btn";
  btn.textContent = "✎";
  btn.title = "编辑重发";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    startEditMessage(div);
  });
  div.appendChild(btn);
}

function startEditMessage(div) {
  if (isStreaming) {
    addSystemNote("回合进行中，无法编辑重发");
    return;
  }
  const userBubbles = [...messagesEl.querySelectorAll(".msg.user")];
  const idx = userBubbles.indexOf(div);
  const item = forkableList[idx];
  // 长度一致校验：列表与 DOM 不同长 → 必有错位（乐观气泡/列表滞后），拒绝并刷新
  if (forkableList.length !== userBubbles.length) {
    addSystemNote("消息列表与编辑候选不同步，已刷新，请重试");
    refreshForkable();
    return;
  }
  // 文本校验：气泡内容应包含该条原文开头（防列表错位误删）
  const bubbleText = (div.textContent || "").replace(/\s+/g, " ").trim();
  const orig = ((item && item.text) || "").replace(/\s+/g, " ").trim();
  const head = orig.slice(0, 30);
  if (!item || (head && !bubbleText.includes(head))) {
    addSystemNote("无法定位该消息（列表已变化），请重试");
    refreshForkable();
    return;
  }
  // 丢弃条数 = 该气泡及之后的全部消息节点
  const all = [...messagesEl.children];
  const discarded = all.length - all.indexOf(div);
  if (!confirm(`编辑重发将丢弃本条及其后的全部 ${discarded} 条消息，并创建会话新分支。确定？`)) return;
  lastEditTarget = { entryId: item.entryId, el: div };
  rpc({ type: "fork", entryId: item.entryId });
}

$("btn-send").onclick = sendMessage;
$("input").addEventListener("keydown", (e) => {
  // v0.4: 弹窗打开时先处理键盘导航
  if (cmdPopoverOpen) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCmdSelection(cmdSelectedIdx + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCmdSelection(cmdSelectedIdx - 1);
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      if (cmdSelectedIdx >= 0) selectCmdByIdx(cmdSelectedIdx);
      else if (cmdFlattened.length) selectCmdByIdx(0);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setCmdPopover(false);
      return;
    }
  }
  // v0.4: 灯箱打开时的键盘处理
  if (!$("lightbox").hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeLightbox(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); navLightbox(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); navLightbox(1); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$("input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 160) + "px";
  // v0.4: 检测 / 命令补全
  const tok = getCmdTokenAtCursor();
  if (tok) {
    cmdFilter = tok.token;
    if (!cmdPopoverOpen) setCmdPopover(true);
    else renderCmdList();
  } else if (cmdPopoverOpen) {
    setCmdPopover(false);
  }
});
$("input").addEventListener("blur", () => {
  // 失焦时延迟关闭，点面板项不会被吞掉
  setTimeout(() => setCmdPopover(false), 150);
});
$("input").addEventListener("paste", (e) => {
  // 剪贴板里的图片直接走内存 base64
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    handleFiles(files);
  }
});
$("btn-abort").onclick = () => rpc({ type: "abort" });

// v0.3: 文件 / 图片 / Skill 按钮
$("btn-attach-file").onclick = () => $("file-input").click();
$("btn-attach-image").onclick = () => $("image-input").click();
$("file-input").addEventListener("change", (e) => {
  handleFiles(e.target.files);
  e.target.value = ""; // 允许重复选同一个文件
});
$("image-input").addEventListener("change", (e) => {
  handleFiles(e.target.files);
  e.target.value = "";
});
$("btn-pick-skill").onclick = () => setSkillPopover(!skillPopoverOpen);
$("skill-search").addEventListener("input", function () {
  skillFilter = this.value;
  renderSkillList();
});
// 点弹窗外面关闭
document.addEventListener("click", (e) => {
  if (skillPopoverOpen) {
    const pop = $("skill-popover");
    const btn = $("btn-pick-skill");
    if (pop && !pop.contains(e.target) && !(btn && btn.contains(e.target))) {
      setSkillPopover(false);
    }
  }
  if (cmdPopoverOpen) {
    const pop = $("cmd-popover");
    const input = $("input");
    if (pop && !pop.contains(e.target) && !(input && input.contains(e.target))) {
      setCmdPopover(false);
    }
  }
  // v0.4: 点击图片打开灯箱
  const img = e.target.closest(".msg.user img, .chip.image img");
  if (img) {
    const images = collectAllImages();
    const idx = images.findIndex(x => x.src === img.src);
    if (idx >= 0) openLightbox(images, idx);
  }
});
// v0.4: 灯箱控件
$("lightbox").addEventListener("click", (e) => {
  if (e.target.classList.contains("lightbox-backdrop")) closeLightbox();
});
document.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
document.querySelector(".lightbox-prev").addEventListener("click", (e) => { e.stopPropagation(); navLightbox(-1); });
document.querySelector(".lightbox-next").addEventListener("click", (e) => { e.stopPropagation(); navLightbox(1); });
// 拖拽上传
const composerEl = $("composer");
composerEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  composerEl.classList.add("drag-over");
});
composerEl.addEventListener("dragleave", (e) => {
  if (e.target === composerEl) composerEl.classList.remove("drag-over");
});
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  composerEl.classList.remove("drag-over");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});

$("btn-new-session").onclick = () => {
  if (!confirm("开始新会话？")) return;
  startPendingNewSession();
};

// v0.7: 懒创建——点「新建会话」只设前端 pending 态，不发 rpc。
// 原因：pi 的 new_session 会立即落一个 header-only 空文件（空会话的源头），
// 用户点了不发消息就留下垃圾；推迟到首条消息发出时才真正建会话。
let pendingNewSession = false;
let pendingFirstPrompt = null; // { message, images } 建会话后要自动发出的首条消息

function startPendingNewSession() {
  pendingNewSession = true;
  pendingFirstPrompt = null;
  if (followUpQueue.length) { followUpQueue = []; renderQueueChips(); }
  // v0.9: 新会话 = 新的视图容器（不复用旧会话的 DOM/状态）
  switchActiveSession(`new:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  messagesEl.innerHTML = "";
  streamingEl = null;
  streamingBlocks = [];
  sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  lastUsage = null;
  lastContextTokens = 0;
  sessionStartedAt = Date.now();
  historyLoadedOnce = true; // 阻止 get_state 响应自动拉旧会话历史
  currentSessionPath = null;
  currentSessionInfo = { pending: true, name: "新会话" };
  updateChatHeader();
  addSystemNote("已进入新会话（发送第一条消息后正式创建）");
}

$("btn-rename").onclick = () => {
  if (!currentSessionInfo) { alert("当前没有活跃会话"); return; }
  const cur = (currentSessionInfo.name || deriveNameFromCurrent() || "").slice(0, 60);
  const name = prompt("重命名当前会话：", cur);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { alert("名字不能为空"); return; }
  rpc({ type: "set_session_name", name: trimmed });
};

$("btn-compact").onclick = () => {
  if (!currentSessionPath) { alert("当前没有会话可压缩"); return; }
  if (!confirm("压缩当前会话上下文？\n这会总结较早的消息以腾出空间，原数据仍然保留。")) return;
  const instr = prompt("（可选）给压缩器的特殊指令：", "") || undefined;
  rpc({ type: "compact", customInstructions: instr });
};

$("btn-export").onclick = () => {
  if (!currentSessionPath) { alert("当前没有会话可导出"); return; }
  rpc({ type: "export_html" });
};

$("btn-refresh-sessions").onclick = loadSessionList;

$("session-search").addEventListener("input", function () {
  sessionListFilter = this.value;
  renderSessionList();
});

$("model-select").onchange = function () {
  const [provider, ...rest] = this.value.split("/");
  rpc({ type: "set_model", provider, modelId: rest.join("/") });
};

function addEmptyHint() {
  messagesEl.innerHTML = `<div class="empty-hint">
    <h2>π Pi WebUI</h2>
    <p>已连接 Pi RPC 模式 · 直接在下方输入开始对话</p>
    <p>Pi 可以读取、编辑工作目录中的文件并执行命令</p>
  </div>`;
}

// v0.9: 启动时先为默认会话建视图容器（后续内容写进容器，而非 #messages 根）
loadViewState("default");
addEmptyHint();

// ============================================================
// v0.6: 扩展 UI 交互（rpc-extension-ui.md 子协议）
//
// Pi 在 RPC 模式下发来 extension_ui_request：
//   - 阻塞式对话框: select / confirm / input / editor
//     → 前端弹框，用户操作后回 extension_ui_response（同 id）
//   - 即发即忘: notify / setStatus / setWidget / setTitle / set_editor_text
//     → 无需响应
// server.js 桥接是全量透传，无需改动；本段全部纯前端实现。
// ============================================================

const extDialogQueue = [];   // 排队的阻塞式请求
let extDialogActive = null;  // 当前展示的请求 {id, method, ...}
const extStatuses = new Map();   // statusKey → statusText
const extWidgets = new Map();    // widgetKey → element
let lastResolvedId = null;       // 最近被（本端或他端）解决的对话框 id

function extRespond(id, payload) {
  // 响应原样透传回 pi stdin（server 的 rpc 通道不改写已带 id 的命令）
  rpc(Object.assign({ type: "extension_ui_response", id }, payload));
}

function handleExtensionUiRequest(rec) {
  const id = rec.id;
  if (id === undefined || id === null) return; // 协议要求带 id
  switch (rec.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      extDialogQueue.push(rec);
      if (!extDialogActive) showNextExtDialog();
      break;
    case "notify":
      extToast(rec.message || "", rec.notifyType || "info");
      break;
    case "setStatus": {
      // statusText 缺省 = 清除该 key（协议语义）
      if (rec.statusText === undefined || rec.statusText === null || rec.statusText === "") {
        extStatuses.delete(rec.statusKey);
      } else {
        extStatuses.set(rec.statusKey, rec.statusText);
      }
      renderExtStatusStrip();
      break;
    }
    case "setWidget": {
      const key = rec.widgetKey || "default";
      let el = extWidgets.get(key);
      if (!el) {
        el = document.createElement("div");
        el.className = "ext-widget";
        el.innerHTML = '<div class="ext-widget-head"></div><button class="ext-widget-close" title="收起">×</button><div class="ext-widget-body md-body"></div>';
        el.querySelector(".ext-widget-close").addEventListener("click", () => {
          el.remove();
          extWidgets.delete(key);
          updateExtWidgetArea();
        });
        extWidgets.set(key, el);
        $("ext-widgets").appendChild(el);
      }
      el.querySelector(".ext-widget-head").textContent = rec.title || key;
      el.querySelector(".ext-widget-body").innerHTML = (rec.widgetLines || []).map((l) => escapeHtml(l)).join("<br>");
      updateExtWidgetArea();
      break;
    }
    case "setTitle":
      document.title = rec.title || "Pi WebUI";
      break;
    case "set_editor_text": {
      const input = $("input");
      input.value = rec.text || "";
      input.dispatchEvent(new Event("input"));
      input.focus();
      break;
    }
    default: {
      // fail-open：未知方法可能是未来新增的阻塞式请求 —— 回 cancelled 让 pi
      // 侧优雅降级（若 pi 未跟踪该 id 则忽略此响应，无副作用）；
      // 静默忽略会让未知的阻塞式请求一直卡到 pi 自己超时。
      console.warn("[ext-ui] 未知 extension_ui method，已回 cancelled:", rec.method);
      extRespond(id, { cancelled: true });
    }
  }
}

function updateExtWidgetArea() {
  $("ext-widgets").hidden = extWidgets.size === 0;
}

function renderExtStatusStrip() {
  const strip = $("ext-status-strip");
  if (extStatuses.size === 0) { strip.hidden = true; strip.textContent = ""; return; }
  strip.textContent = [...extStatuses.entries()].map(([k, v]) => `${k}: ${v}`).join(" · ");
  strip.hidden = false;
}

// ---------- 阻塞式对话框 ----------
function showNextExtDialog() {
  const rec = extDialogQueue.shift();
  if (!rec) return;
  extDialogActive = rec;
  const titleEl = $("ext-dialog-title");
  const msgEl = $("ext-dialog-message");
  const textEl = $("ext-dialog-text");
  const areaEl = $("ext-dialog-area");
  const optEl = $("ext-dialog-options");
  optEl.innerHTML = "";
  textEl.value = "";
  areaEl.value = "";
  textEl.hidden = true;
  areaEl.hidden = true;

  const title = rec.title || { select: "请选择", confirm: "请确认", input: "请输入", editor: "编辑" }[rec.method] || "Pi 请求交互";
  titleEl.textContent = title;
  msgEl.innerHTML = rec.message ? PiMD.render(rec.message, { streaming: false }) : "";
  // select/confirm 等 description 字段兼容
  if (!rec.message && rec.description) msgEl.innerHTML = PiMD.render(rec.description, { streaming: false });

  const btn = (label, cls, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", fn);
    optEl.appendChild(b);
    return b;
  };

  if (rec.method === "select") {
    (rec.options || []).forEach((opt) => {
      btn(opt, "ext-btn ext-btn-primary", () => extFinishDialog({ value: opt }));
    });
    btn("取消", "ext-btn ext-btn-ghost", () => extFinishDialog({ cancelled: true }));
  } else if (rec.method === "confirm") {
    btn("确认", "ext-btn ext-btn-primary", () => extFinishDialog({ confirmed: true }));
    btn("拒绝", "ext-btn ext-btn-danger", () => extFinishDialog({ confirmed: false }));
    btn("取消", "ext-btn ext-btn-ghost", () => extFinishDialog({ cancelled: true }));
  } else if (rec.method === "input") {
    textEl.hidden = false;
    textEl.placeholder = rec.placeholder || "";
    btn("确定", "ext-btn ext-btn-primary", () => extFinishDialog({ value: textEl.value }));
    btn("取消", "ext-btn ext-btn-ghost", () => extFinishDialog({ cancelled: true }));
    setTimeout(() => textEl.focus(), 0);
  } else if (rec.method === "editor") {
    areaEl.hidden = false;
    areaEl.value = rec.prefill || "";
    btn("确定", "ext-btn ext-btn-primary", () => extFinishDialog({ value: areaEl.value }));
    btn("取消", "ext-btn ext-btn-ghost", () => extFinishDialog({ cancelled: true }));
    setTimeout(() => { areaEl.focus(); }, 0);
  }
  $("ext-dialog").hidden = false;
}

function extFinishDialog(payload) {
  if (!extDialogActive) return;
  const id = extDialogActive.id;
  extDialogActive = null;
  $("ext-dialog").hidden = true;
  extRespond(id, payload);
  if (extDialogQueue.length) showNextExtDialog();
}

/** 他端/服务端仲裁：该 id 的对话框已在别处被应答 —— 本端静默关框不回响应 */
function extDialogResolvedRemotely(id) {
  lastResolvedId = id;
  const qi = extDialogQueue.findIndex((r) => String(r.id) === String(id));
  if (qi >= 0) {
    extDialogQueue.splice(qi, 1);
    return;
  }
  if (extDialogActive && String(extDialogActive.id) === String(id)) {
    extDialogActive = null;
    $("ext-dialog").hidden = true;
    if (extDialogQueue.length) showNextExtDialog();
  }
}

// Enter 提交 input 对话框；textarea 内 Shift+Enter 换行
document.addEventListener("keydown", (e) => {
  if ($("ext-dialog").hidden || !extDialogActive) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    extFinishDialog({ cancelled: true });
  } else if (e.key === "Enter" && extDialogActive.method === "input" && !e.shiftKey) {
    e.preventDefault();
    extFinishDialog({ value: $("ext-dialog-text").value });
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && extDialogActive.method === "editor") {
    // editor 多行编辑：Ctrl/⌘+Enter 提交，单 Enter 换行
    e.preventDefault();
    e.stopPropagation();
    extFinishDialog({ value: $("ext-dialog-area").value });
  }
}, true); // capture：优先于全局聊天快捷键

// ---------- Toast（notify） ----------
function extToast(message, type) {
  const wrap = $("ext-toast-wrap");
  const t = document.createElement("div");
  t.className = `ext-toast ext-toast-${type === "warning" ? "warning" : type === "error" ? "error" : "info"}`;
  t.textContent = message;
  t.addEventListener("click", () => t.remove());
  wrap.appendChild(t);
  setTimeout(() => t.remove(), type === "error" ? 10000 : 5000);
}

// ---------- 测试钩子（探针专用，不发送任何 RPC） ----------
// v0.7: trace.js 读取当前会话文件路径（轨迹面板数据源）
window.__piwebui_state = { getSessionPath: () => currentSessionPath };

// v0.9: 会话视图/进程池调试与探针钩子
window.__piwebui_pool = {
  activeKey: () => activeSessionKey,
  views: () => [...sessionViews.keys()],
  busy: () => Object.fromEntries(poolBusy),
  unread: () => Object.fromEntries([...sessionViews].map(([k, v]) => [k, v.unread || 0])),
  viewKeys: () => [...sessionViews.keys()],
  viewText: (key) => { const v = sessionViews.get(resolveViewKey(key)); return v ? (v.el.textContent || "") : ""; },
  viewCount: () => sessionViews.size,
};

window.__piwebui_test = {
  activeKey: () => activeSessionKey,
  handleExtensionUiRequest,
  extRespond,
  queue: {
    // 探针专用：直接设置队列镜像 + 读取
    update: (list) => { followUpQueue = (list || []).map((t) => ({ message: t, images: [], sessionId: null })); renderQueueChips(); },
    state: () => followUpQueue.map((x) => x.message),
  },
  state: () => ({
    active: extDialogActive ? { id: extDialogActive.id, method: extDialogActive.method } : null,
    queued: extDialogQueue.map((r) => r.id),
    statuses: Object.fromEntries(extStatuses),
    widgets: [...extWidgets.keys()],
    dialogHidden: $("ext-dialog").hidden,
    lastResolvedId,
  }),
};

// ============================================================
// v0.6.2: Steer 队列（纯前端 FIFO，agent_settled 自动投递）
//
// 流式中发送的消息进入本地队列（不发 RPC），本轮 agent_settled 后
// FIFO 投递队首（正常 prompt，开启新回合），直到队列清空。
// 选型说明：协议 follow_up + clear_queue 组合存在入队延迟竞态
// （input handler 异步入队导致移除时 clear 清不到、重复投递），
// 纯前端队列移除零竞态；刷新清空可接受（任务卡明示）。
// ============================================================

let followUpQueue = [];   // [{message, images, sessionId}] — 唯一事实源（前端）

// v0.6.3: 编辑重发（fork）—— active branch 上可回退的 user 消息列表
let forkableList = [];       // [{entryId, text}]（与 DOM user 气泡序号对齐）
let lastEditTarget = null;   // 待 fork 的 {entryId, el}

function renderQueueChips() {
  const wrap = $("queue-chips");
  if (!wrap) return;
  if (!followUpQueue.length) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = "";
  const label = document.createElement("span");
  label.className = "queue-chips-label";
  label.textContent = `已排队 ${followUpQueue.length}：`;
  wrap.appendChild(label);
  followUpQueue.forEach((item, i) => {
    const text = item.message || "";
    const chip = document.createElement("span");
    chip.className = "queue-chip";
    const t = document.createElement("span");
    t.textContent = text.length > 40 ? text.slice(0, 40) + "..." : text;
    t.title = text;
    const x = document.createElement("button");
    x.className = "queue-chip-x";
    x.textContent = "×";
    x.title = "从队列移除";
    x.addEventListener("click", () => removeQueuedMessage(i));
    chip.appendChild(t);
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
}

function removeQueuedMessage(i) {
  const removed = followUpQueue.splice(i, 1)[0];
  if (!removed) return;
  renderQueueChips();
  // 同步移除乐观渲染的用户气泡（该消息不再投递）
  const bubbles = [...document.querySelectorAll("#messages .msg.user")];
  for (let b = bubbles.length - 1; b >= 0; b--) {
    if ((bubbles[b].textContent || "").startsWith(removed.message)) {
      bubbles[b].remove();
      break;
    }
  }
}

/** agent_settled 后投递队首：正常 prompt 开启新回合（气泡已在入队时渲染）。
 *  仅投递属于当前会话的条目；切换会话后的旧队列条目保留但不投递。 */
function pumpFollowUpQueue() {
  if (!followUpQueue.length) return;
  const next = followUpQueue[0];
  if (next.sessionId !== (currentSessionPath || null)) return; // 会话归属不符 → 不投
  followUpQueue.shift();
  renderQueueChips();
  isStreaming = true;
  setSendState();
  const cmd = { type: "prompt", message: next.message };
  if (next.images && next.images.length) cmd.images = next.images;
  rpc(cmd);
}
