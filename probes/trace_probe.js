/**
 * v0.7 专项探针：轨迹审计面板（P1-④）
 *
 * PHASE 1: 端点直测 —— 合成 300 行 JSONL（真实字段结构）→
 *          /api/sessions/trace 返回结构化事件；路径穿越/不存在 → 400
 * PHASE 2: 真实链路 —— 发短消息造真实会话 → 「≡ 轨迹」打开 → 行数/meta/耗时
 * PHASE 3: 过滤「tool」→ 只剩 tool badge 行
 * PHASE 4: 搜索关键词 → 只剩匹配行
 * PHASE 5: 点击展开 → 完整 JSON + tok 高亮 span
 * PHASE 6: 合成 1200 事件（>500 大会话）→ 分页渲染 200、加载更多、耗时 < 1s
 *
 * 运行（自起 3211 临时实例，不碰正式 3210）：
 *   NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *   node trace_probe.js
 */
const { chromium } = require("playwright-core");
const { spawn, execSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? " :: " + detail : ""}`);
}

function waitListen(ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const req = http.get(`${BASE}/`, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() - t0 > ms) reject(new Error("server not listening"));
        else setTimeout(poll, 300);
      });
    };
    poll();
  });
}

// ---------- 合成 JSONL（字段结构来自真实会话文件，勿改字段名） ----------
function buildSynthJsonl(count) {
  const t0 = Date.parse("2026-10-16T00:00:00.000Z");
  const lines = [];
  let id = 0;
  const nid = () => String(++id).padStart(8, "0");
  lines.push(JSON.stringify({ type: "session", version: 3, id: nid(), timestamp: new Date(t0).toISOString(), cwd: "D:\\tmp\\trace-probe" }));
  lines.push(JSON.stringify({ type: "model_change", id: nid(), parentId: null, timestamp: new Date(t0 + 1).toISOString(), provider: "probe", modelId: "Probe-M1" }));
  let ts = t0 + 10;
  for (let i = 0; i < count; i++) {
    ts += 1000;
    const T = new Date(ts).toISOString();
    const kind = i % 4;
    if (kind === 0) {
      lines.push(JSON.stringify({ type: "message", id: nid(), parentId: null, timestamp: T,
        message: { role: "user", content: [{ type: "text", text: i === 8 ? "这条含 TRACE_MARKER_XYZ 关键词" : `普通用户消息 ${i}，询问第 ${i} 号问题` }] } }));
    } else if (kind === 1) {
      lines.push(JSON.stringify({ type: "message", id: nid(), parentId: null, timestamp: T,
        message: { role: "assistant", content: [
          { type: "thinking", thinking: `分析问题 ${i}` },
          { type: "text", text: `回答内容 ${i}` },
          { type: "toolCall", id: "call_" + i, name: i % 2 ? "read" : "bash", arguments: { path: `/tmp/f${i}`, command: `echo ${i}` } },
        ] } }));
    } else if (kind === 2) {
      lines.push(JSON.stringify({ type: "message", id: nid(), parentId: null, timestamp: T,
        message: { role: "toolResult", toolCallId: "call_" + i, toolName: i % 2 ? "read" : "bash",
          content: [{ type: "text", text: `工具输出 ${i}：ok` }] } }));
    } else {
      lines.push(JSON.stringify({ type: "custom", customType: "probe-event", data: { i, note: `custom 事件 ${i}` }, id: nid(), parentId: null, timestamp: T }));
    }
  }
  lines.push(JSON.stringify({ type: "compaction", id: nid(), parentId: null, timestamp: new Date(ts + 1).toISOString(), summary: "压缩摘要" }));
  return lines.join("\n") + "\n";
}

// 非 ephemeral + 临时 cwd（trace 端点读 SESSION_DIR，探针预写合成文件进去）
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "piwebui-trace-probe-"));
const SESSION_DIR = path.join(TMP_CWD, "sessions");
fs.mkdirSync(SESSION_DIR, { recursive: true });
const SYNTH_FILE = "synth-trace-test.jsonl";
fs.writeFileSync(path.join(SESSION_DIR, SYNTH_FILE), buildSynthJsonl(300));

const server = spawn(process.execPath,
  [path.join(__dirname, "server.js"), "--port", String(PORT),
   "--cwd", TMP_CWD, "--session-dir", SESSION_DIR],
  { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));
let serverDead = false;
server.on("error", (e) => { serverDead = true; console.error("server spawn error:", e.message); });
server.on("exit", (code) => { if (!serverDead) { serverDead = true; console.error(`server 提前退出 (code ${code})`); } });
const origWaitListen = waitListen;
waitListen = async (ms) => {
  await origWaitListen(ms);
  if (serverDead) throw new Error(`server 未能启动（可能端口 ${PORT} 被占，先 taskkill 残留进程）`);
};

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

(async () => {
  await waitListen(15000);
  console.log(`临时 server 已监听 ${BASE}`);

  console.log("=== PHASE 1: 端点直测（合成 300+ 行 JSONL） ===");
  let r = await httpGetJson(`${BASE}/api/sessions/trace?file=${SYNTH_FILE}`);
  check("端点 200", r.status === 200, `status=${r.status}`);
  const evs = (r.body && r.body.events) || [];
  check("事件数 = 303（300 轮 + session + model_change + compaction）", r.body.count === evs.length && evs.length === 303, `${r.body.count}`);
  check("字段齐全（n/ts/type/role/label/summary/raw）",
    evs.every((e) => "n" in e && "ts" in e && "type" in e && "role" in e && "label" in e && "summary" in e && "raw" in e), "全量校验");
  const roles = {};
  for (const e of evs) roles[e.role] = (roles[e.role] || 0) + 1;
  check("role 归类（user/assistant/tool/system）",
    roles.user === 75 && roles.assistant === 75 && roles.tool === 75 && roles.system === 78,
    JSON.stringify(roles));
  check("raw 为原始行", evs[1].raw.startsWith("{\"type\":\"model_change\""), evs[1].raw.slice(0, 40));
  r = await httpGetJson(`${BASE}/api/sessions/trace?file=..%2F..%2Fevil.json`);
  check("路径穿越被拒（400）", r.status === 400, `status=${r.status}`);
  r = await httpGetJson(`${BASE}/api/sessions/trace?file=no-such.jsonl`);
  check("不存在文件 400", r.status === 400, `status=${r.status}`);

  console.log("=== PHASE 2: 真实链路（短消息 → 打开面板） ===");
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/.test(m.text())) errors.push("CONSOLE: " + m.text());
  });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  await page.fill("#input", "不要调用任何工具，直接只回复五个字：轨迹测试");
  await page.click("#btn-send");
  let idle = false;
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000);
    const btn = await page.$eval("#btn-send", (el) => el.textContent);
    const has = await page.evaluate(() => document.body.textContent.includes("轨迹测试"));
    if (btn === "发送" && has) { idle = true; break; }
  }
  check("短消息回合完成", idle, "空闲态");

  await page.click("#btn-trace");
  await page.waitForSelector("#trace-panel:not([hidden])", { timeout: 5000 });
  let rows = 0;
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    rows = await page.$$eval("#trace-list .trace-row", (els) => els.length).catch(() => 0);
    const meta = await page.$eval("#trace-meta", (el) => el.textContent).catch(() => "");
    if (rows > 0 && !meta.includes("加载中")) break;
    await page.waitForTimeout(300);
  }
  const elapsed = Date.now() - t0;
  check("面板打开且渲染出事件行", rows > 0, `${rows} 行`);
  check("渲染 < 1s（含 fetch）", elapsed < 1000, `${elapsed}ms`);
  const meta = await page.$eval("#trace-meta", (el) => el.textContent);
  check("meta 显示事件总数", /(\d+) 事件/.test(meta), meta.slice(0, 50));
  const badges = await page.$$eval("#trace-list .trace-badge", (els) => [...new Set(els.map((e) => e.textContent))]);
  check("真实会话含多种 badge", badges.length >= 2, JSON.stringify(badges.slice(0, 6)));

  console.log("=== PHASE 3: 过滤 user（短消息会话无 tool 事件） ===");
  await page.click('#trace-chips .trace-chip[data-f="user"]');
  await page.waitForTimeout(300);
  const toolBadges = await page.$$eval("#trace-list .trace-badge", (els) => [...new Set(els.map((e) => e.textContent))]);
  check("只剩 user badge", toolBadges.length === 1 && toolBadges[0] === "user", JSON.stringify(toolBadges));
  const st = await page.evaluate(() => window.__trace_test.state());
  check("state.filter=user", st.filter === "user", JSON.stringify(st));

  console.log("=== PHASE 4: 搜索关键词 ===");
  // 真实会话搜「轨迹测试」（刚发的消息）
  await page.click('#trace-chips .trace-chip[data-f="all"]');
  await page.fill("#trace-search", "轨迹测试");
  await page.waitForTimeout(400);
  const searchRows = await page.$$eval("#trace-list .trace-row", (els) => els.length);
  const searchTexts = await page.$$eval("#trace-list .trace-summary", (els) => els.map((e) => e.textContent));
  check("搜索只剩匹配行（≥2：user+assistant）", searchRows >= 2 && searchRows <= 5,
    `${searchRows} 行: ${JSON.stringify(searchTexts.map((t) => t.slice(0, 20)))}`);
  check("全部行含关键词", searchTexts.every((t) => t.includes("轨迹测试")), "文本校验");

  console.log("=== PHASE 5: 点击展开完整 JSON ===");
  await page.fill("#trace-search", "");
  await page.waitForTimeout(300);
  await page.click("#trace-list .trace-row");
  await page.waitForTimeout(200);
  const rawEl = await page.$("#trace-list .trace-row.expanded .trace-raw");
  check("展开出现 JSON 载荷", !!rawEl, rawEl ? "found" : "missing");
  const rawText = rawEl ? await rawEl.textContent() : "";
  let rawOk = false;
  if (rawText) { try { JSON.parse(rawText); rawOk = true; } catch {} }
  check("载荷为合法 JSON", rawOk, `${(rawText || "").length} 字符`);
  const tokSpans = await page.$$eval("#trace-list .trace-raw .tok-kw, #trace-list .trace-raw .tok-str, #trace-list .trace-raw .tok-key, #trace-list .trace-raw .tok-num",
    (els) => els.length).catch(() => 0);
  check("JSON 高亮 tok span", tokSpans > 0, `${tokSpans} 个`);

  console.log("=== PHASE 6: 合成 1200 事件（大会话分页） ===");
  // 复用端点验证过的合成数据，前端 render 注入（确定性，跳过 fetch）
  const synth = await (async () => {
    const r2 = await httpGetJson(`${BASE}/api/sessions/trace?file=${SYNTH_FILE}`);
    return r2.body.events;
  })();
  const big = [];
  for (let k = 0; k < 4; k++) {
    for (const e of synth) big.push({ ...e, n: big.length });
  }
  const t1 = Date.now();
  await page.evaluate((evs) => window.__trace_test.render(evs), big);
  const renderMs = Date.now() - t1;
  const st6 = await page.evaluate(() => window.__trace_test.state());
  check("总事件 1212、首屏分页 200", st6.total === 1212 && st6.shown === 200,
    `total=${st6.total} shown=${st6.shown}`);
  check("渲染 < 1s（不含 fetch）", renderMs < 1000, `${renderMs}ms`);
  await page.click("#trace-more-btn");
  await page.waitForTimeout(200);
  const st6b = await page.evaluate(() => window.__trace_test.state());
  check("加载更多 → 400", st6b.shown === 400, `shown=${st6b.shown}`);
  // 过滤 + 搜索仍工作
  await page.click('#trace-chips .trace-chip[data-f="system"]');
  await page.waitForTimeout(200);
  const sysCount = await page.$$eval("#trace-list .trace-badge", (els) => els.filter((e) => e.textContent !== "tool" && e.textContent !== "user" && e.textContent !== "assistant").length);
  const sysRows = await page.$$eval("#trace-list .trace-row", (els) => els.length);
  check("大合成集过滤 system 生效", sysRows > 0 && sysCount === sysRows, `${sysRows} 行全 system`);
  // tool 过滤（合成集含 300 toolResult；真实短会话无 tool，在此补验）
  await page.click('#trace-chips .trace-chip[data-f="tool"]');
  await page.waitForTimeout(200);
  const toolOnly = await page.$$eval("#trace-list .trace-badge", (els) => [...new Set(els.map((e) => e.textContent))]);
  check("大合成集过滤 tool 生效", toolOnly.length === 1 && toolOnly[0] === "tool", JSON.stringify(toolOnly));
  check("无 JS 错误", errors.length === 0, errors.join(" | "));

  const pass = results.filter((r3) => r3.pass).length;
  console.log(`\n=== 结果: ${pass}/${results.length} ===`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(async (e) => {
  console.error("PROBE FAILED:", e);
  process.exit(2);
});
process.on("exit", () => {
  try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" }); } catch {}
  try { fs.rmSync(TMP_CWD, { recursive: true, force: true }); } catch {}
});
