/**
 * Pi WebUI Server
 * 桥接 Pi RPC 子进程 (JSONL over stdin/stdout) 与浏览器 WebSocket
 *
 * Pi RPC 协议参考:
 *   node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
 *   node_modules/@earendil-works/pi-coding-agent/docs/rpc-commands.md
 *   node_modules/@earendil-works/pi-coding-agent/docs/json.md
 *
 * 启动: node server.js [--cwd <项目目录>] [--port 3210]
 *                     [--session-dir <自定义会话目录>] [--ephemeral] [--name <初始名>]
 * 浏览器访问: http://localhost:3210
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

// ---------- 配置 ----------
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
function hasFlag(name) {
  return args.includes(name);
}
const PORT = parseInt(getArg("--port", "3210"), 10);
const WORK_DIR = path.resolve(getArg("--cwd", process.cwd()));
// 会话存储位置 —— 默认放项目内 sessions/，也可显式指定
const SESSION_DIR = path.resolve(getArg("--session-dir", path.join(__dirname, "sessions")));
// 旧默认行为兼容：传 --ephemeral 等同旧版的 --no-session（不持久化）
const EPHEMERAL = hasFlag("--ephemeral");
const INITIAL_NAME = getArg("--name", "");
const PI_MODEL = getArg("--model", "minimax/MiniMax-M3"); // 默认模型，避免内置目录模型的协议不匹配

// ---------- v0.10: P2-⑪ 设置面板（config.json 持久化 + OAuth 只读） ----------
// config.json 存 pi-webui/ 下（--config 可覆盖，探针用临时路径隔离）。
// schema 严格：写入时未知键/类型错误直接 400；读取时未知键忽略（fail-open）。
const SETTINGS_FILE = getArg("--config", path.join(__dirname, "config.json"));
const AUTH_FILE = getArg("--auth-file", path.join(os.homedir(), ".pi", "agent", "auth.json"));
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    const out = {};
    if (j.model && typeof j.model === "object"
        && typeof j.model.provider === "string" && typeof j.model.id === "string") {
      out.model = { provider: j.model.provider, id: j.model.id };
    }
    if (typeof j.thinkingLevel === "string" && THINKING_LEVELS.has(j.thinkingLevel)) {
      out.thinkingLevel = j.thinkingLevel;
    }
    return out;
  } catch (e) { return {}; } // 不存在/损坏 → 空默认（fail-open）
}

function validateSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("设置必须是 JSON 对象");
  const unknown = Object.keys(body).filter((k) => k !== "model" && k !== "thinkingLevel");
  if (unknown.length) throw new Error(`未知设置项: ${unknown.join(", ")}`);
  const out = {};
  if (body.model !== undefined) {
    if (!body.model || typeof body.model !== "object" || Array.isArray(body.model)) throw new Error("model 必须是对象");
    const uk = Object.keys(body.model).filter((k) => k !== "provider" && k !== "id");
    if (uk.length) throw new Error(`model 未知字段: ${uk.join(", ")}`);
    if (typeof body.model.provider !== "string" || typeof body.model.id !== "string"
        || !body.model.provider || !body.model.id) throw new Error("model.provider/model.id 必须是非空字符串");
    out.model = { provider: body.model.provider, id: body.model.id };
  }
  if (body.thinkingLevel !== undefined) {
    if (typeof body.thinkingLevel !== "string" || !THINKING_LEVELS.has(body.thinkingLevel)) {
      throw new Error(`thinkingLevel 必须是 ${[...THINKING_LEVELS].join("/")}`);
    }
    out.thinkingLevel = body.thinkingLevel;
  }
  return out;
}

function saveSettings(next) {
  const merged = { ...loadSettings(), ...next };
  const tmp = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  fs.renameSync(tmp, SETTINGS_FILE); // 原子替换
  return merged;
}

/** 登录凭据只读摘要：只返回 provider + type，绝不返回 key/token */
function readAuthProviders() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    return Object.keys(j).sort().map((p) => ({
      provider: p,
      type: (j[p] && typeof j[p] === "object" && j[p].type) ? String(j[p].type) : "unknown",
    }));
  } catch (e) { return []; }
}

// 启动时读一次作为 spawn 默认值（「下次启动读取为默认值」）
const START_SETTINGS = loadSettings();
const SPAWN_MODEL = START_SETTINGS.model ? `${START_SETTINGS.model.provider}/${START_SETTINGS.model.id}` : PI_MODEL;
// v0.3: 附件上传 — 单文件上限（MB）+ 落盘目录
const MAX_UPLOAD_BYTES = parseInt(getArg("--max-upload", "25"), 10) * 1024 * 1024;
const UPLOAD_DIR = path.join(WORK_DIR, ".pi-uploads");

// Pi 可执行文件定位：优先用 --pi 参数，其次常见安装位置，最后 PATH
function findPiCmd() {
  const explicit = getArg("--pi", "");
  const candidates = [
    explicit,
    path.join(process.env.USERPROFILE || "", ".workbuddy", "binaries", "node", "versions", "22.22.2-6", process.platform === "win32" ? "pi.cmd" : "pi"),
    path.join(process.env.APPDATA || "", "npm", process.platform === "win32" ? "pi.cmd" : "pi"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.platform === "win32" ? "pi.cmd" : "pi"; // 兜底走 PATH
}
const PI_CMD = findPiCmd();

// ---------- Pi RPC 子进程管理（v0.9 会话进程池） ----------
// 每个会话一个独立的 pi --mode rpc 子进程；key 为会话文件路径（临时会话为
// "new:<ts>"）。fileIndex 反查保证同一 jsonl 永远只有一个进程（防双写损坏）。
const POOL = new Map();       // key -> entry {key, tag, proc, sessionFile, lastUsed, timer}
const FILE_INDEX = new Map(); // sessionFile -> entry
let rpcClients = new Set();   // 所有连接的浏览器
// ---------- Extension UI 仲裁（rpc-extension-ui 子协议） ----------
// 多浏览器客户端同时连接时，同一对话框会在每端渲染；pi 侧以首个到达的
// 响应为准。这里用 pending 集合去重：首个响应转发给 pi 并广播
// ui_dialog_resolved 让其它端自动关框；重复/未知 id 的响应被抑制，
// 避免污染 pi 的请求/响应配对。
const UI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const pendingUiIds = new Set();
let reqId = 0;
const pending = new Map(); // id -> {resolve}

// 给浏览器广播的编号（用于 UI 关联）
let uiSeq = 0;

/** 进程池：取（必要时 spawn）指定会话的 pi 进程。key=null/"" → "default" */
function getEntry(key) {
  key = normalizeKey(key);
  // 已知会话文件 → 复用已打开该文件的进程（避免同一 jsonl 双进程）
  if (FILE_INDEX.has(key)) {
    const e = FILE_INDEX.get(key);
    touchEntry(e);
    return e;
  }
  if (POOL.has(key)) {
    touchEntry(POOL.get(key));
    return POOL.get(key);
  }
  return spawnEntry(key);
}

function normalizeKey(key) {
  if (key === undefined || key === null || key === "") return "default";
  return String(key);
}

/** 该 key 是否对应真实会话文件（非 default / 非临时 key） */
function keyIsSessionFile(key) {
  return key !== "default" && !key.startsWith("new:");
}

function spawnEntry(key) {
  const piArgs = ["--mode", "rpc", "--model", SPAWN_MODEL];
  let sessionFile = null;
  if (EPHEMERAL) {
    piArgs.push("--no-session");
  } else {
    piArgs.push("--session-dir", SESSION_DIR);
    if (keyIsSessionFile(key)) {
      sessionFile = key;
      piArgs.push("--session", key); // 加载已有会话文件
    } else if (INITIAL_NAME) {
      piArgs.push("--name", INITIAL_NAME);
    }
  }
  log(`启动 Pi RPC 子进程 [${key}] (cwd: ${WORK_DIR}${sessionFile ? ", session: " + sessionFile.split(/[\\/]/).pop() : ""})`);
  const proc = spawn(PI_CMD, piArgs, {
    cwd: WORK_DIR,
    shell: process.platform === "win32",
    env: { ...process.env },
  });
  const entry = { key, tag: key, proc, sessionFile, lastUsed: Date.now(), timer: null };
  POOL.set(key, entry);
  if (sessionFile) FILE_INDEX.set(sessionFile, entry);
  // v0.9: 临时会话（new:<ts>）——仅传 --session-dir 时 pi 会恢复「最近一个会话」，
  // 导致新会话的消息写进旧 jsonl（两个进程共写同一文件）。这里主动 new_session
  // 拿到全新文件，保证「一进程一会话文件」不变量。
  if (key.startsWith("new:") && !EPHEMERAL) {
    entry.proc.stdin.write(JSON.stringify({ id: `new-${++uiSeq}`, type: "new_session" }) + "\n");
  }
  // v0.10: config.json 里的 thinkingLevel 作为新 spawn 进程的默认值（模型已由
  // --model 传入）。fire-and-forget，与 new_session 同模式；pi 会自行排队。
  if (START_SETTINGS.thinkingLevel) {
    try {
      entry.proc.stdin.write(JSON.stringify({ id: `cfg-${++uiSeq}`, type: "set_thinking_level", level: START_SETTINGS.thinkingLevel }) + "\n");
    } catch (e) { /* fail-open：默认级别不阻塞启动 */ }
  }

  // 关键：按 LF 切分 JSONL，不能用 readline（会错误切分 U+2028/U+2029）
  // 这里直接用 buffer indexOf，更可靠
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (e) {
        log(`JSON 解析失败: ${e.message}`);
        continue;
      }
      touchEntry(entry);
      handlePiRecord(record, entry);
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => {
    // stderr 只是诊断信息，不是协议数据
    process.stderr.write(`[pi:${entry.tag}] ${d}`);
  });

  proc.on("exit", (code) => {
    log(`Pi 进程退出 [${entry.tag}] (code: ${code})`);
    if (POOL.get(entry.key) === entry) POOL.delete(entry.key);
    if (entry.sessionFile && FILE_INDEX.get(entry.sessionFile) === entry) FILE_INDEX.delete(entry.sessionFile);
    // 清空待应答对话框并通知所有端关框（旧进程的 id 已无意义）
    for (const rid of pendingUiIds) {
      broadcastSession(entry, { type: "ui_dialog_resolved", id: rid });
    }
    pendingUiIds.clear();
    broadcastSession(entry, { type: "pi_exited", code });
    broadcastPoolState();
  });
  broadcastPoolState();
  return entry;
}

const POOL_IDLE_MS = Math.max(0, Number(getArg("--pool-idle-timeout", "1800"))) * 1000;

/** 活动刷新（重置空闲回收定时器） */
function touchEntry(entry) {
  entry.lastUsed = Date.now();
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  if (POOL_IDLE_MS > 0) {
    entry.timer = setTimeout(() => killEntry(entry.key, "idle-timeout"), POOL_IDLE_MS);
    if (entry.timer.unref) entry.timer.unref();
  }
}

/** 杀掉指定会话的进程（关闭会话 / 删除会话 / 空闲回收 / 服务关闭） */
function killEntry(key, reason) {
  key = normalizeKey(key);
  const entry = FILE_INDEX.has(key) ? FILE_INDEX.get(key) : POOL.get(key);
  if (!entry) return false;
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  POOL.delete(entry.key);
  if (entry.sessionFile && FILE_INDEX.get(entry.sessionFile) === entry) FILE_INDEX.delete(entry.sessionFile);
  try { entry.proc.stdin.end(); } catch (e) {}
  try { entry.proc.kill(); } catch (e) {}
  log(`已关闭 Pi 进程 [${entry.tag}] (${reason || "manual"})`);
  broadcastPoolState();
  return true;
}

function killAllEntries(reason) {
  for (const key of [...POOL.keys()]) killEntry(key, reason);
}

function poolState() {
  const items = [];
  for (const e of POOL.values()) {
    items.push({ session: e.tag, sessionFile: e.sessionFile, busy: isEntryBusy(e), lastUsed: e.lastUsed });
  }
  return { sessions: items, idleTimeoutSec: POOL_IDLE_MS / 1000 };
}

function broadcastPoolState() {
  broadcast({ type: "pool_state", ...poolState() });
}

/** 该会话是否有进行中的回合（用于侧栏「运行中」动效） */
function isEntryBusy(e) {
  return e.busyUntil && Date.now() < e.busyUntil;
}

function stopAllPi() {
  killAllEntries("shutdown");
}


function handlePiRecord(record, entry) {
  const owner = entry || null;
  const tag = owner ? owner.tag : "default";
  // 原始 usage 证据日志：每条带 usage 的 assistant 消息追加到 sessions/usage.jsonl，
  // 可对照供应商控制台审计（fail-open：日志失败不影响转发）。
  try {
    if (record && record.type === "message_end" && record.message
        && record.message.role === "assistant" && record.message.usage) {
      appendUsageLog(record.message.usage);
    }
    // 阻塞式对话框请求 → 登记待应答 id（供响应去重）
    if (record && record.type === "extension_ui_request"
        && UI_DIALOG_METHODS.has(record.method) && record.id !== undefined && record.id !== null) {
      pendingUiIds.add(String(record.id));
    }
    // v0.8: 缓存会话文件（get_state 响应携带）——临时会话拿到文件后重映射 fileIndex
    if (record && record.type === "response" && record.command === "get_state"
        && record.success && record.data && record.data.sessionFile) {
      const sf = String(record.data.sessionFile);
      if (owner) {
        // pi 可能换会话文件（如 new_session 建的空会话在首条 prompt 时被轮换），
        // 同步清理旧映射，保证「一文件一进程」不变量
        const old = owner.sessionFile;
        if (old && old !== sf && FILE_INDEX.get(old) === owner) FILE_INDEX.delete(old);
        owner.sessionFile = sf;
        owner.tag = sf; // 记录携带真实路径后对外用路径标识
        FILE_INDEX.set(sf, owner);
      }
    }
    // v0.8: 每轮结束（assistant 回复+其工具调用完成）→ git 锚点（静默、异步）
    if (record && record.type === "turn_end") {
      scheduleGitAnchor(owner);
    }
    // v0.9: 运行中状态（agent_start/turn_start → busy；agent_settled → 空闲）
    if (owner) {
      if (record && (record.type === "agent_start" || record.type === "turn_start")) {
        owner.busyUntil = Date.now() + 120000;
      } else if (record && record.type === "agent_settled") {
        owner.busyUntil = 0;
      }
    }
  } catch (e) {
    // 忽略日志错误（fail-open）
  }
  // 1) 命令响应 → 原样转发（浏览器按 id 关联）
  // 2) 会话事件 → 转发给订阅了该会话的浏览器
  broadcastSession(owner, { type: "pi_record", record, session: tag });
  if (owner && record && (record.type === "agent_start" || record.type === "agent_settled")) {
    broadcastPoolState();
  }
}

/** 发送到指定会话的 pi 进程（无 id 的命令自动编号） */
function sendToPi(command, sessionKey) {
  const entry = getEntry(sessionKey);
  if (!command.id) command.id = `ui-${++uiSeq}`;
  pending.set(command.id, { resolve: () => {} });
  try {
    entry.proc.stdin.write(JSON.stringify(command) + "\n");
  } catch (e) {
    log(`写入 pi stdin 失败 [${entry.tag}]: ${e.message}`);
  }
  return command.id;
}


// ---------- v0.8: P1-⑤ 每轮 git 锚点（绝对只读不改用户 git 状态） ----------
// 原理：git stash create 只生成 commit 对象（不动工作区/index/HEAD/不进 stash list），
//       git commit-tree 从其 tree 建快照 commit，git update-ref 挂到
//       refs/piweb/rounds/<session>/<round-n>。无变更时快照=HEAD（直接挂 HEAD）。
const execFile = require("child_process").execFile;
// v0.9: 锚点状态按会话进程分开（WeakMap entry -> {sid, next, chain}）
const anchorState = new WeakMap(); // entry -> {sid, next, chain}
let anchorFallback = null;         // 无 entry 时的兑底标识

function anchorStateOf(entry) {
  if (!entry) {
    if (!anchorFallback) anchorFallback = { sid: null, next: 0, chain: null };
    return anchorFallback;
  }
  let st = anchorState.get(entry);
  if (!st) { st = { sid: null, next: 0, chain: null }; anchorState.set(entry, st); }
  return st;
}

function gitExec(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: WORK_DIR, timeout: timeoutMs || 5000, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

function getAnchorSid(entry) {
  const st = anchorStateOf(entry);
  if (st.sid) return st.sid;
  const sf = (entry && (entry.sessionFile || entry.tag)) || null;
  st.sid = sf ? path.basename(sf).replace(/\.jsonl$/i, "") : "proc-" + process.pid;
  return st.sid;
}

function scheduleGitAnchor(entry) {
  const st = anchorStateOf(entry);
  st.chain = (st.chain || Promise.resolve()).then(() => doGitAnchor(entry)).catch(() => {});
}

async function doGitAnchor(entry) {
  const st = anchorStateOf(entry);
  try {
    const inside = await gitExec(["rev-parse", "--is-inside-work-tree"]);
    if (inside.err || inside.stdout.trim() !== "true") return; // 非 git 仓库：静默跳过
    const sid = getAnchorSid(entry);
    // 首次锚点：扫现有最大轮号（重启后继续递增）
    if (st.next === 0) {
      const refs = await gitExec(["for-each-ref", `refs/piweb/rounds/${sid}/`, "--format=%(refname)"]);
      let maxN = 0;
      for (const m of refs.stdout.matchAll(/\/(\d+)$/g)) maxN = Math.max(maxN, parseInt(m[1], 10));
      st.next = maxN;
    }
    // 快照对象：stash create（无副作用；无变更时返回空）
    const stash = await gitExec(["stash", "create"]);
    let commitSrc;
    if (stash.stdout.trim()) {
      // 从 stash commit 解出 tree，建独立快照 commit（不引用 stash）
      const tree = await gitExec(["rev-parse", `${stash.stdout.trim()}^{tree}`]);
      if (tree.err || !tree.stdout.trim()) return;
      commitSrc = tree.stdout.trim();
    } else {
      // 无变更：快照等价 HEAD；仓库尚无 HEAD（无提交）→ 跳过
      const head = await gitExec(["rev-parse", "--verify", "HEAD"]);
      if (head.err || !head.stdout.trim()) return;
      commitSrc = head.stdout.trim();
    }
    const n = ++st.next;
    const msg = `piweb round ${n} ${sid}`;
    const ct = await gitExec(["commit-tree", commitSrc, "-m", msg]);
    if (ct.err || !ct.stdout.trim()) return;
    const ur = await gitExec(["update-ref", `refs/piweb/rounds/${sid}/${n}`, ct.stdout.trim()]);
    if (ur.err) { st.next = n - 1; return; }
    log(`git 锚点: refs/piweb/rounds/${sid}/${n} -> ${ct.stdout.trim().slice(0, 10)}`);
  } catch (e) {
    // git 不存在/任何失败：静默跳过（P1-⑤ 约束）
    log(`git 锚点跳过: ${e.message}`);
  }
}

// ---------- v0.8: P1-⑦ 文件端点辅助 ----------
const TRACE_EXCLUDE = new Set([".git", "node_modules", ".pi-uploads"]);
const TRACE_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
const TRACE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".txt": "text/plain", ".json": "application/json", ".html": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".md": "text/plain", ".pdf": "application/pdf",
};

/** 相对路径 → WORK_DIR 内绝对路径；拒绝绝对路径与穿越（P1-⑦ 安全约束） */
function resolveWorkPath(rel) {
  if (typeof rel !== "string" || rel.includes("\0")) throw new Error("非法路径");
  const decoded = rel;
  // 盘符开头（含 drive-relative 如 C:Windows，无分隔符也不放行）+ UNC
  if (/^[a-zA-Z]:/.test(decoded) || path.isAbsolute(decoded) || /^\\\\/.test(decoded)) {
    throw new Error("拒绝绝对路径");
  }
  const full = path.resolve(WORK_DIR, decoded);
  const base = path.resolve(WORK_DIR);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("路径越界");
  }
  return full;
}

// ---------- Usage 证据日志 ----------
// pi 对 OpenAI 兼容 provider 的规范化（parseChunkUsage）：
//   input      = prompt_tokens − cached_tokens − cache_write_tokens（未走缓存的输入）
//   cacheRead  = prompt_tokens_details.cached_tokens（缓存命中，供应商实报）
//   cacheWrite = prompt_tokens_details.cache_write_tokens（多数 provider 不上报）
// rawPromptTokens 还原了供应商侧的 prompt_tokens，可与其账单/控制台交叉验证。
const USAGE_LOG = path.join(SESSION_DIR, "usage.jsonl");
function appendUsageLog(u) {
  const input = u.input ?? 0, output = u.output ?? 0;
  const cacheRead = u.cacheRead ?? 0, cacheWrite = u.cacheWrite ?? 0;
  const rec = {
    ts: new Date().toISOString(),
    input, output, cacheRead, cacheWrite,
    reasoning: u.reasoning ?? 0,
    rawPromptTokens: input + cacheRead + cacheWrite,
    totalTokens: u.totalTokens ?? (input + output + cacheRead + cacheWrite),
  };
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.appendFile(USAGE_LOG, JSON.stringify(rec) + "\n", () => {});
}

// ---------- 会话文件扫描 ----------
// 列出 SESSION_DIR 下所有 *.jsonl，解析出 header / 名字 / 首条用户消息
// v0.7: 轨迹事件序列化（P1-④ 只读端点用）
// role 归四类 badge：user / assistant / tool（toolResult）/ system（其余元事件）
function serializeTraceEvent(n, o, rawLine) {
  const ev = { n, ts: o.timestamp || null, type: o.type || "?", role: "system", label: o.type, summary: "", raw: rawLine };
  const clip = (s, k) => {
    if (typeof s !== "string") return "";
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > k ? t.slice(0, k) + "..." : t;
  };
  if (o.type === "message" && o.message) {
    const m = o.message;
    const role = m.role || "?";
    if (role === "user") { ev.role = "user"; ev.label = "user"; }
    else if (role === "assistant") { ev.role = "assistant"; ev.label = "assistant"; }
    else if (role === "toolResult") { ev.role = "tool"; ev.label = "tool"; }
    else { ev.role = "system"; ev.label = role; }
    const parts = [];
    if (role === "toolResult") {
      parts.push(`🔧 ${m.toolName || "?"} 返回`);
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") parts.push(clip(b.text, 160));
        else if (b.type === "thinking") parts.push(`💭 ${clip(b.thinking, 60)}`);
        else if (b.type === "toolCall") parts.push(`🔧 ${b.name || "?"}(${clip(JSON.stringify(b.arguments || {}), 80)})`);
        else if (b.type === "image") parts.push("🖼 图片");
      }
    } else if (typeof m.content === "string") {
      parts.push(clip(m.content, 160));
    }
    ev.summary = parts.join(" ").slice(0, 220);
    if (role === "toolResult") ev.summary = parts.join(" ").slice(0, 220);
  } else if (o.type === "model_change") {
    ev.summary = `⚙ ${o.provider || "?"} / ${o.modelId || "?"}`;
  } else if (o.type === "thinking_level_change") {
    ev.summary = `🧠 thinking = ${o.thinkingLevel || "?"}`;
  } else if (o.type === "compaction") {
    ev.summary = `🗜 压缩：${clip(o.summary || "", 160)}`;
  } else if (o.type === "context_edit") {
    ev.summary = `✂ 上下文编辑 target=${o.targetId || "?"}`;
  } else if (o.type === "custom") {
    ev.summary = `🏷 ${o.customType || "?"} ${clip(JSON.stringify(o.data || {}), 120)}`;
  } else if (o.type === "session") {
    ev.summary = `会话开始 cwd=${o.cwd || "?"} v${o.version || "?"}`;
  } else if (o.type === "parse_error") {
    ev.summary = "⚠ 该行 JSON 解析失败（原文见展开）";
  } else {
    ev.summary = clip(JSON.stringify(o), 160);
  }
  return ev;
}

// v0.7: 内部日志文件（usage 审计日志等）——不是会话，扫描与清扫一律排除
const SESSION_DIR_INTERNAL_FILES = new Set(["usage.jsonl"]);
function isSessionFileName(name) {
  return name.endsWith(".jsonl") && !SESSION_DIR_INTERNAL_FILES.has(name);
}

// 全量扫描（含空会话）——listSessionFiles 与 sweepEmptySessions 共用，避免重复 IO
function scanSessionFiles() {
  if (EPHEMERAL) return [];
  if (!fs.existsSync(SESSION_DIR)) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
  } catch (e) {
    log(`读取 sessions 目录失败: ${e.message}`);
    return [];
  }
  for (const ent of entries) {
    if (!ent.isFile() || !isSessionFileName(ent.name)) continue;
    const fp = path.join(SESSION_DIR, ent.name);
    let stat;
    try { stat = fs.statSync(fp); } catch (e) { continue; }
    const info = {
      path: fp,
      fileName: ent.name,
      id: ent.name.replace(/\.jsonl$/, ""),
      modified: stat.mtimeMs,
      size: stat.size,
      timestamp: null,
      localTime: null,  // 人类可读的本地时间，2026-10-15 15:33:25+08:00
      tzOffset: null,    // 时区后缀，如 +08:00 / Z
      cwd: null,
      name: null,
      firstMessage: null,
      // v0.6: 空会话检测（DSH 官方行为：默认隐藏无消息会话，活跃会话豁免）。
      // messageCount/userMessageCount 只统计前 80 行；不足时对小文件全文回查，
      // 避免把「头 80 行恰好无消息」的会话误判为空（大文件不可能，省得全读）。
      messageCount: 0,
      userMessageCount: 0,
      hasMessages: false,
      // v0.7: 计数是否为下界（≥8MB 巨型会话只扫前 80 行，前端显示 "N+ 轮"）
      countsPartial: false,
      // v0.7: 是否有 session 头（清扫时的第二道护栏——只清"的确是 pi 建的
      // 会话文件"且零消息的；无头的陌生 jsonl 一律不碰）
      hasHeader: false,
    };
    // 仅读前 ~80 行（够拿到 header / name / 首条用户消息）
    const scanLines = (lines) => {
      for (const raw of lines) {
        let entry;
        try { entry = JSON.parse(raw); } catch (e) { continue; }
        if (entry.type === "session") {
          info.hasHeader = true;
          info.timestamp = entry.timestamp;
          info.cwd = entry.cwd;
          info.id = entry.id || info.id;
          // entry.timestamp 是 UTC ISO (…Z)；转成本地时间以避免用户在
          // CST 下看到 8 小时时差。info.localTime 也作为示例
          if (entry.timestamp) {
            const d = new Date(entry.timestamp);
            if (!Number.isNaN(d.getTime())) {
              info.localTime = formatLocalTime(d);
              info.tzOffset = formatTzOffset(d);
            }
          }
        } else if (entry.type === "session_info" && entry.name) {
          info.name = entry.name;
        } else if (entry.type === "message" && entry.message) {
          info.messageCount++;
          const m = entry.message;
          if (m.role === "user" || m.role === "BashExecution") {
            info.userMessageCount++;
            if (!info.firstMessage) info.firstMessage = extractText(m);
          }
        }
      }
    };
    try {
      scanLines(readFirstLines(fp, 80));
      if (info.messageCount === 0 && stat.size < 512 * 1024) {
        // 前 80 行无消息且文件不大：全文回查确认真空
        try { scanLines(readFirstLines(fp, Number.MAX_SAFE_INTEGER)); } catch (e) { /* 读失败按现状 */ }
      } else if (info.messageCount > 0 && stat.size < 8 * 1024 * 1024) {
        // v0.7: 轮数显示要准——大会话的前 80 行可能全是 system 提示/model_change，
        // 首条 user 消息在后面，只扫 80 行会把 700 条消息的会话显示成"1 轮"。
        // <8MB 全文精确重统计（先清零避免与 80 行的部分计数重复累计；
        // name 取最后一次 set_session_name，比首现名更当前）。
        info.messageCount = 0;
        info.userMessageCount = 0;
        info.firstMessage = null;
        try { scanLines(readFirstLines(fp, Number.MAX_SAFE_INTEGER)); } catch (e) { /* 读失败保留 80 行结果 */ }
      }
      // ≥8MB 的巨型会话保持 80 行下界（列表调用不卡顿），前端显示 "N+ 轮"
      info.countsPartial = stat.size >= 8 * 1024 * 1024;
      info.hasMessages = info.messageCount > 0;
    } catch (e) {
      // 文件读到一半没事，跳过
    }
    out.push(info);
  }
  // 按 mtime 倒序（最新在前）
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

// v0.7 源头过滤：空会话（零 message 的文件）不再进入 API 响应。
// 这类 header-only 文件由 pi 的 new_session 落盘产生（点了"新建会话"但
// 没发消息），前端据此彻底移除"已隐藏"降噪行——从源头不产生可见空会话。
function listSessionFiles() {
  return scanSessionFiles().filter(s => s.hasMessages);
}

// v0.7 启动清扫：删除历史遗留的空会话文件（有 session 头、零 message）。
// 与 listSessionFiles 的即时过滤互补：过滤管"看不见"，清扫管"不占盘"，
// 每次重启把累积的 header-only 垃圾清零（用户反馈：重启后空会话又冒出来）。
// 时机安全：pi 子进程惰性启动（首次 rpc 才起），server listen 时 pi 未运行，
// 不存在"删了 pi 正在写的文件"的竞态。
// 安全护栏：仅 SESSION_DIR 内、.jsonl、非内部文件、确有 session 头、零 message。
function sweepEmptySessions() {
  if (EPHEMERAL) return 0;
  const all = scanSessionFiles();
  let removed = 0;
  for (const s of all) {
    if (s.hasMessages || !s.hasHeader) continue;
    try {
      fs.unlinkSync(s.path);
      removed++;
      log(`启动清扫: 删除空会话 ${s.fileName}`);
    } catch (e) {
      log(`启动清扫失败 ${s.fileName}: ${e.message}`);
    }
  }
  if (removed > 0) log(`启动清扫完成: 共清理 ${removed} 个空会话文件`);
  return removed;
}

function readFirstLines(filePath, maxLines) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length && lines.length < maxLines; i++) {
    if (text[i] === "\n") {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length && lines.length < maxLines) lines.push(text.slice(start));
  return lines;
}

function extractText(msg) {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === "text").map(b => b.text || "").join("\n");
  return "";
}

// ---------- 本地时间格式 ----------
// 用于 session info，让侧栏直接显示本地时间而不是 UTC ISO。
// 与 extensions/shared/journal.ts:formatLocalTime 保持一致。
function pad2(n) { return String(n).padStart(2, "0"); }
function formatLocalTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
         `${formatTzOffset(d)}`;
}
function formatTzOffset(d) {
  const offsetMin = -d.getTimezoneOffset();
  if (offsetMin === 0) return "Z";
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function deleteSession(filePath) {
  // 安全检查：路径必须在 SESSION_DIR 下
  const resolved = path.resolve(filePath);
  const base = path.resolve(SESSION_DIR);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error("拒绝：目标路径不在 sessionDir 内");
  }
  if (!fs.existsSync(resolved)) return false;
  fs.unlinkSync(resolved);
  return true;
}

// ---------- HTTP: 静态文件 + 会话 API ----------
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 会话 API
    if (pathname === "/api/sessions/list" && req.method === "GET") {
      const list = listSessionFiles();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: list, sessionDir: SESSION_DIR, ephemeral: EPHEMERAL }));
      return;
    }
    // v0.7: 轨迹审计 —— 只读解析会话 JSONL 为结构化事件（P1-④）。
    // 严格只读：仅 fs.readFileSync，无任何写入路径。
    if (pathname === "/api/sessions/trace" && req.method === "GET") {
      try {
        const urlObj = new URL(req.url, "http://localhost");
        const file = urlObj.searchParams.get("file") || "";
        // 路径安全：只允许单文件名（防目录穿越），且必须在 SESSION_DIR 内
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) || file.includes("..")) {
          throw new Error("非法文件名");
        }
        const full = path.join(SESSION_DIR, file);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("文件不存在");
        const stat = fs.statSync(full);
        if (stat.size > 64 * 1024 * 1024) throw new Error("文件过大（>64MB）");
        const raw = fs.readFileSync(full, "utf8");
        const events = [];
        let n = 0;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let o;
          try { o = JSON.parse(line); } catch { o = { type: "parse_error", timestamp: null }; }
          events.push(serializeTraceEvent(n++, o, line));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ events, count: events.length, file, bytes: stat.size }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // ---------- v0.8: P1-⑤ 锚点查询（只读） ----------
    if (pathname === "/api/anchors" && req.method === "GET") {
      try {
        const urlObj = new URL(req.url, "http://localhost");
        let sid = urlObj.searchParams.get("session");
        if (sid && !/^[A-Za-z0-9._-]+$/.test(sid)) throw new Error("非法会话标识");
        // v0.9: 未指定时优先用最近活跃的会话标识（进程池）
        if (!sid) {
          let last = null;
          for (const e of POOL.values()) if (!last || e.lastUsed > last.lastUsed) last = e;
          sid = last ? getAnchorSid(last) : getAnchorSid(null);
        }
        const inside = await gitExec(["rev-parse", "--is-inside-work-tree"]);
        if (inside.err || inside.stdout.trim() !== "true") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ git: false, session: sid, refs: [] }));
          return;
        }
        const refs = await gitExec(["for-each-ref", `refs/piweb/rounds/${sid}/`,
          "--format=%(objectname)|%(refname)|%(contents:subject)"]);
        const list = refs.stdout.split("\n").filter((l) => l.trim()).map((l) => {
          const [hash, refname, subject] = l.split("|");
          const m = refname.match(/\/(\d+)$/);
          return { n: m ? parseInt(m[1], 10) : 0, hash: (hash || "").slice(0, 10), ref: refname, message: subject || "" };
        }).sort((a, b) => b.n - a.n);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ git: true, session: sid, refs: list }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // ---------- v0.8: P1-⑦ 文件树 / 预览（严格只读） ----------
    if ((pathname === "/api/files" || pathname === "/api/file" || pathname === "/api/file/raw" || pathname === "/api/git-status") && req.method === "GET") {
      try {
        // git 状态映射（供前端文件树圆点，一次性全量）
        if (pathname === "/api/git-status") {
          const inside = await gitExec(["rev-parse", "--is-inside-work-tree"]);
          if (inside.err || inside.stdout.trim() !== "true") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ git: false, entries: [] }));
            return;
          }
          const st = await gitExec(["status", "--porcelain"]);
          const entries = st.stdout.split("\n").filter((l) => l.trim()).map((l) => {
            const x = l[0], y = l[1];
            let p = l.slice(3);
            const arrow = p.indexOf(" -> ");
            if (arrow >= 0) p = p.slice(arrow + 4); // rename 取新路径
            return { x, y, path: p.trim().replace(/^"|"$/g, "") };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ git: true, entries }));
          return;
        }
        const urlObj = new URL(req.url, "http://localhost");
        const rel = urlObj.searchParams.get("path") || "";
        const full = resolveWorkPath(rel); // 拒绝绝对路径/穿越（400）
        // 列目录
        if (pathname === "/api/files") {
          const entries = [];
          for (const d of fs.readdirSync(full, { withFileTypes: true })) {
            if (TRACE_EXCLUDE.has(d.name)) continue;
            let size = 0, mtime = 0;
            try { const s = fs.statSync(path.join(full, d.name)); size = s.size; mtime = s.mtimeMs; } catch {}
            entries.push({ name: d.name, dir: d.isDirectory(), size, mtime });
          }
          entries.sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ entries }));
          return;
        }
        const stat = fs.statSync(full);
        if (!stat.isFile()) throw new Error("不是文件");
        const ext = path.extname(full).toLowerCase();
        // 图片 → 原始字节流交给前端灯箱（对齐 25MB 上传约定）
        if (pathname === "/api/file/raw") {
          if (stat.size > 25 * 1024 * 1024) throw new Error("文件超过 25MB 上限");
          res.writeHead(200, { "Content-Type": TRACE_MIME[ext] || "application/octet-stream", "Content-Length": stat.size });
          fs.createReadStream(full).pipe(res);
          return;
        }
        if (TRACE_IMAGE.has(ext)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ kind: "image", url: `/api/file/raw?path=${encodeURIComponent(rel)}`, size: stat.size }));
          return;
        }
        // 文本：限 1MB；二进制探测（含 NUL → binary 占位）
        if (stat.size > 1024 * 1024) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ kind: "too-large", size: stat.size, hint: "文件超过 1MB，仅支持由 pi 读取片段" }));
          return;
        }
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ kind: "binary", size: stat.size }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kind: "text", content: buf.toString("utf8"), size: stat.size }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // v0.3: 文件上传（图片走前端 base64，这里只接非图片）
    if (pathname === "/api/upload" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const { filename, mimeType, dataBase64 } = body || {};
        if (!filename || !dataBase64) {
          throw new Error("缺少 filename 或 dataBase64");
        }
        // 文件名清洗：去路径分隔符、控制字符，限长
        const raw = String(filename).split(/[\\/]/).pop() || "file";
        const safeName = raw.replace(/[<>:"|?*\x00-\x1f]/g, "_").slice(0, 200);
        if (!safeName || safeName.startsWith(".")) {
          throw new Error("非法文件名");
        }
        // 解码 base64 并校验大小
        const buf = Buffer.from(dataBase64, "base64");
        if (buf.length === 0) throw new Error("文件为空");
        if (buf.length > MAX_UPLOAD_BYTES) {
          const mb = (n) => (n / 1024 / 1024).toFixed(1);
          throw new Error(`文件过大 (${mb(buf.length)} MB > ${mb(MAX_UPLOAD_BYTES)} MB)，请压缩或拆分`);
        }
        // 拼时间戳防重名
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const finalName = `${ts}_${safeName}`;
        const finalPath = path.join(UPLOAD_DIR, finalName);
        // 防越权：确保 finalPath 在 UPLOAD_DIR 内
        const resolved = path.resolve(finalPath);
        const base = path.resolve(UPLOAD_DIR) + path.sep;
        if (!resolved.startsWith(base)) throw new Error("路径越界");
        fs.writeFileSync(resolved, buf);
        log(`上传: ${finalName} (${(buf.length / 1024).toFixed(1)} KB)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          path: resolved,
          name: safeName,
          size: buf.length,
          mimeType: mimeType || "application/octet-stream",
        }));
      } catch (e) {
        const msg = (e && e.message) || String(e);
        const code = msg.includes("过大") ? 413 : 400;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }
    if (pathname === "/api/sessions/delete" && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      try {
        // v0.9: 删除前先杀掉占用该 jsonl 的进程（否则进程会继续写已删文件）
        killEntry(body.path || "", "session-deleted");
        const ok = deleteSession(body.path || "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (pathname === "/api/settings" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        settings: loadSettings(),
        auth: readAuthProviders(), // 仅 provider + type，无任何密钥材料
        file: SETTINGS_FILE,
      }));
      return;
    }
    if (pathname === "/api/settings" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on("end", () => {
        try {
          const saved = saveSettings(validateSettings(JSON.parse(body || "{}")));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ settings: saved }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sessionDir: SESSION_DIR,
        ephemeral: EPHEMERAL,
        cwd: WORK_DIR,
        model: PI_MODEL,
        uploadDir: UPLOAD_DIR,
        maxUploadBytes: MAX_UPLOAD_BYTES,
      }));
      return;
    }

    // 静态文件
    let urlPath = decodeURIComponent(pathname);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end(); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not Found"); return; }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store", // 避免浏览器缓存旧版 app.js/style.css
      });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.message || e));
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of rpcClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

/** 只发给订阅了该会话的客户端（owner 为空 → 广播，保持旧行为）
 *  订阅判定用「进程身份 + key + tag」三重匹配：get_state 后 tag 会变成真实
 *  路径，但客户端订阅时拿到的可能是 "default" 或 new:<ts>，任一命中即可。 */
function broadcastSession(owner, obj) {
  if (!owner) { broadcast(obj); return; }
  const msg = JSON.stringify(obj);
  for (const ws of rpcClients) {
    if (ws.readyState !== 1) continue;
    if (!ws.sessions) continue;
    if (!(ws.sessions.has(owner.tag) || ws.sessions.has(owner.key) || ws.sessions.has(owner))) continue;
    ws.send(msg);
  }
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

wss.on("connection", (ws) => {
  rpcClients.add(ws);
  ws.sessions = new Set();   // 该客户端订阅/使用过的会话（订阅后才能收到其记录）
  ws.current = null;         // 最近一次操作的会话（默认会话 = "default"）
  log(`浏览器已连接 (当前 ${rpcClients.size} 个)`);

  // 告诉浏览器 Pi 的工作目录 + sessionDir + 进程池状态
  ws.send(JSON.stringify({ type: "hello", cwd: WORK_DIR, sessionDir: SESSION_DIR, ephemeral: EPHEMERAL, ...poolState() }));

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    switch (msg.type) {
      // 浏览器 → Pi 的 RPC 命令（prompt/abort/set_model/get_state/get_messages 等）
      // v0.9: msg.session 指定目标会话（会话文件路径或 new:<ts>）；缺省沿用
      // 本连接上次会话，首次为 "default"（完全兼容旧行为）。
      case "rpc": {
        const key = normalizeKey(msg.session || ws.current);
        ws.current = key;
        // 订阅该 key 对应的实际进程（对象身份）——即使后续 tag 变化也能继续收
        ws.sessions.add(key);
        try { ws.sessions.add(getEntry(key)); } catch (e) {}
        // extension_ui_response 去重仲裁：首个响应生效并广播关框；
        // 重复/未知 id 被抑制（不透传给 pi），防止多端重复应答污染配对。
        if (msg.command && msg.command.type === "extension_ui_response") {
          const rid = String(msg.command.id ?? "");
          const first = pendingUiIds.has(rid);
          pendingUiIds.delete(rid);
          if (first) sendToPi(msg.command, key);
          broadcast({ type: "ui_dialog_resolved", id: msg.command.id });
          break;
        }
        const id = sendToPi(msg.command, key);
        break;
      }
      // v0.9: 关闭会话（杀该会话的 pi 子进程，其它会话不受影响）
      case "close_session": {
        const key = normalizeKey(msg.session);
        const killed = killEntry(key, "client-close");
        ws.sessions.delete(key);
        if (ws.current === key) ws.current = null;
        ws.send(JSON.stringify({ type: "session_closed", session: key, killed }));
        break;
      }
      // v0.9: 订阅某会话（切到后台会话时保持接收其后续记录）
      case "subscribe_session": {
        const key = normalizeKey(msg.session);
        ws.sessions.add(key);
        try { ws.sessions.add(getEntry(key)); } catch (e) {}
        break;
      }
      // v0.9: 查询进程池状态
      case "pool_query":
        ws.send(JSON.stringify({ type: "pool_state", ...poolState() }));
        break;
      case "refresh_sessions":
        // 浏览器请求服务端重读 sessions 目录并广播
        broadcast({ type: "sessions_changed", sessions: listSessionFiles() });
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
    }
  });

  ws.on("close", () => {
    rpcClients.delete(ws);
    log(`浏览器断开 (剩余 ${rpcClients.size} 个)`);
  });
});

// ---------- 启动 ----------
if (!EPHEMERAL) {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); }
  catch (e) { log(`创建 sessionDir 失败: ${e.message}`); }
  // v0.7: 启动清扫历史遗留空会话（此时 pi 未惰性启动，无写冲突）
  sweepEmptySessions();
}
// v0.3: 准备上传目录
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
catch (e) { log(`创建 uploadDir 失败: ${e.message}`); }

server.listen(PORT, () => {
  log(`Pi WebUI 已启动: http://localhost:${PORT}`);
  log(`工作目录: ${WORK_DIR}`);
  log(`会话目录: ${EPHEMERAL ? "<ephemeral, 不保存>" : SESSION_DIR}`);
  log(`上传目录: ${UPLOAD_DIR} (单文件 ≤ ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB)`);
  log("Pi RPC 子进程将在首次发消息时惰性启动");
});

process.on("SIGINT", () => {
  log("正在关闭...");
  stopAllPi();
  process.exit(0);
});
