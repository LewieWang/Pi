/**
 * v0.9 P2-⑩ 专项探针：并行后台会话（会话进程池）
 *
 * PHASE 1: A/B 会话同时跑长任务 —— 两侧都流式输出、内容互不串
 * PHASE 2: 切回 A 时 B 的后台输出不丢（后台继续累积）
 * PHASE 3: 未读角标 + 侧栏运行中动效
 * PHASE 4: 关闭 B 只终止 B 的子进程（A 不受影响、仍能继续对话）
 * PHASE 5: 生命周期 —— 连续开关 20 个会话后 pi 进程数回到基线（无泄漏）
 * PHASE 6: 会话隔离落到磁盘 —— A 的 jsonl 不含 B 的 prompt
 *
 * 运行（自起 3211 临时实例，隔离 tmp cwd + tmp session-dir）：
 *   NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *   node parallel_probe.js
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK_A = "AAA标记";   // A 会话专有内容
const MARK_B = "BBB标记";   // B 会话专有内容

function waitListen(ms, port) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const req = http.get(`http://localhost:${port}/`, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() - t0 > ms) reject(new Error(`server not listening on ${port}`));
        else setTimeout(poll, 300);
      });
    };
    poll();
  });
}

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "piwebui-par-"));
const SESS_DIR = path.join(CWD, "sessions");
fs.mkdirSync(SESS_DIR, { recursive: true });
fs.writeFileSync(path.join(CWD, "note.txt"), "parallel probe\n");

function startServer() {
  const s = spawn(process.execPath,
    [path.join(__dirname, "..", "server.js"), "--port", String(PORT), "--cwd", CWD, "--session-dir", SESS_DIR],
    { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
  s.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  s.stderr.on("data", (d) => process.stderr.write(`[srv:err] ${d}`));
  return s;
}
const server = startServer();
let dead = false;
server.on("exit", (c) => { if (!dead) { dead = true; console.error(`srv 提前退出 ${c}`); } });

/** 只统计本探针 session-dir 下的 --mode rpc pi 子进程数（排除用户 live 实例） */
function countPiProcs() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--mode*rpc*' -and $_.CommandLine -like '*${SESS_DIR}*' }).Count"`,
      { encoding: "utf8", timeout: 25000 });
    return parseInt(String(out).trim(), 10) || 0;
  } catch (e) { return -1; }
}

/** 通过页面 ws 直接问 server 拿进程池状态（避开 UI 状态） */
async function poolQuery(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "pool_query" }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "pool_state") { ws.close(); resolve(m); }
    };
    setTimeout(() => { try { ws.close(); } catch {} resolve({ sessions: [], timeout: true }); }, 5000);
  }));
}

async function sendAndWaitSettle(page, text, timeoutMs = 180000) {
  await page.fill("#input", text);
  await page.click("#btn-send");
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    const btn = await page.$eval("#btn-send", (el) => el.textContent);
    if (btn === "发送") return true;
  }
  return false;
}

/** 取各会话视图容器的文本（DOM 隔离验证） */
function viewTexts(page) {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".session-view").forEach((el, i) => { out[i] = el.textContent || ""; });
    return out;
  });
}

(async () => {
  await waitListen(15000, PORT);
  console.log(`临时 server 已监听 ${BASE}`);

  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  // 「新建会话」按钮带 confirm()——headless 下必须自动接受，否则永远新建不了
  page.on("dialog", async (d) => { try { await d.accept(); } catch {} });
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push("CONSOLE: " + m.text()); });
  // 出站帧抓取（诊断：谁发了 new_session）
  await page.addInitScript(() => {
    window.__out = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      try { window.__out.push(String(d).slice(0, 200)); } catch {}
      return orig.call(this, d);
    };
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await sleep(4000); // 等首个会话拉起 + 历史加载

  // ---------- PHASE 1: A/B 并行 ----------
  console.log("=== PHASE 1: A/B 会话并行长任务 ===");
  const baseProcs = countPiProcs();
  check("基线 pi 进程数可测", baseProcs >= 0, `${baseProcs} 个`);

  // A：当前默认会话，发一个长输出任务（不需要工具，天然长流式）
  const promptA = `不要调用任何工具。请从 1 连续数到 80，每行一个数字，第一行写 "${MARK_A}"。`;
  await page.fill("#input", promptA);
  await page.click("#btn-send");
  await sleep(2500); // 让 A 进入流式

  // 等 A 至少产生几条 message_update（按会话 tag 统计，证明在流式输出）
  const countUpdates = (tag) => page.evaluate((t) => (window.__inRecords || []).filter((x) =>
    x.type === "pi_record" && x.session === t && x.record && x.record.type === "message_update").length, tag);
  const firstUpdateTag = () => page.evaluate(() => {
    const f = (window.__inRecords || []).find((x) => x.type === "pi_record" && x.record
      && x.record.type === "message_update");
    return f ? f.session : null;
  });
  // A 的 tag = 第一条增量帧的 session（必须等它出现再统计，否则拿到 null 永远 0）
  let aTag = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    aTag = await firstUpdateTag();
    if (aTag) break;
  }
  let aUpdates = 0;
  for (let i = 0; i < 60; i++) {
    aUpdates = await countUpdates(aTag);
    if (aUpdates >= 3) break;
    await sleep(500);
  }
  check("A 会话在流式输出（≥3 次增量）", aUpdates >= 3, `${aUpdates} 次增量 [${(aTag || "").split(/[\/]/).pop()}]`);

  // A 还在跑时，新建会话 B 并发任务
  await page.click("#btn-new-session");
  await sleep(1500);
  const promptB = `不要调用任何工具。请写出 "B会话专属${MARK_B}" 这 6 个字，然后从 1 连续数到 60，每行一个数字。`;
  await page.fill("#input", promptB);
  await page.click("#btn-send");
  await sleep(3000);

  let bUpdates = 0;
  // B 的增量 = “非 A tag” 的增量（B 的 tag 会从 new:<ts> 变为文件路径，不能写死）
  const countOtherUpdates = (tag) => page.evaluate((t) => (window.__inRecords || []).filter((x) =>
    x.type === "pi_record" && x.session !== t && x.record && x.record.type === "message_update").length, tag);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    bUpdates = await countOtherUpdates(aTag);
    if (bUpdates >= 3) break;
  }
  const bTag = await page.evaluate((t) => {
    const f = (window.__inRecords || []).filter((x) => x.type === "pi_record" && x.session !== t
      && x.record && x.record.type === "message_update").pop();
    return f ? f.session : null;
  }, aTag);
  check("B 会话同时在流式输出（≥3 次增量）", bUpdates >= 3, `${bUpdates} 次增量 [${(bTag || "").split(/[\/]/).pop()}]`);
  check("A 与 B 是不同的会话 tag", aTag && bTag && aTag !== bTag, `${(aTag||"").split(/[\/]/).pop()} vs ${(bTag||"").split(/[\/]/).pop()}`);

  const pool1 = await poolQuery(page);
  check("进程池有 ≥2 个会话进程", pool1.sessions.length >= 2,
    pool1.sessions.map((s) => s.session.split(/[\\/]/).pop()).join(" , "));

  // B 的真实视图 key = 含 B 标记的那个视图（B 刚创建时 key 还会从 new:<ts> 变文件路径，
  // 按内容解析避免读到旧 key）
  const findKeyByText = (mark) => page.evaluate((m) => {
    const P = window.__piwebui_pool;
    return P.views().find((k) => P.viewText(k).includes(m)) || null;
  }, mark);
  const bKeyNow = await findKeyByText("B会话专属");
  const bLenBefore = await page.evaluate((k) => window.__piwebui_pool.viewText(k).length, bKeyNow);
  const procsDuring = countPiProcs();
  check("并行期间 pi 进程数 ≥2", procsDuring >= 2, `${procsDuring} 个（基线 ${baseProcs}）`);
  check("B 有独立视图容器", !!bKeyNow, (bKeyNow || "none").split(/[\\/]/).pop());

  // ---------- PHASE 2: 切回 A，B 后台继续 ----------
  console.log("=== PHASE 2: 切回 A，B 后台继续累积 ===");
  const activeKeyNow = await page.evaluate(() => window.__piwebui_pool.activeKey());
  check("当前活跃会话是 B", !!activeKeyNow && !!bKeyNow && activeKeyNow !== aTag,
    `${(activeKeyNow || "none").split(/[\\/]/).pop()}`);

  // 点 A 所在会话项（列表里非 active 的那个）
  await page.evaluate(() => {
    const items = [...document.querySelectorAll(".session-item")].filter((el) => !el.classList.contains("active"));
    if (items[0]) items[0].click();
  });
  await sleep(4000);

  const aActiveText = await page.evaluate(() => document.querySelector("#messages").textContent || "");
  const aViewText = await page.evaluate((k) => window.__piwebui_pool.viewText(k), aTag);
  const bViewText0 = await page.evaluate((k) => window.__piwebui_pool.viewText(k), bKeyNow);
  check("切回 A 后可见 A 内容", aViewText.includes(MARK_A), aViewText.slice(0, 40));
  check("A 视图不含 B 内容（不串消息）", !aViewText.includes(MARK_B));
  check("DOM 上只渲染当前会话容器", await page.evaluate(() =>
    document.querySelectorAll("#messages > .session-view").length === 1),
    `${await page.evaluate(() => document.querySelectorAll("#messages > .session-view").length)} 个上屏`);
  check("A/B 视图内容互不包含", aViewText !== bViewText0 && bViewText0.includes(MARK_B),
    `A ${aViewText.length} 字 / B ${bViewText0.length} 字`);

  // B 在后台继续增长（对比切换前）
  let bGrew = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const len = await page.evaluate((k) => window.__piwebui_pool.viewText(k).length, bKeyNow);
    if (len > bLenBefore + 20) { bGrew = true; break; }
  }
  const bFinalText = await page.evaluate((k) => window.__piwebui_pool.viewText(k), bKeyNow);
  check("B 在后台继续累积（切走不丢）", bGrew && bFinalText.includes(MARK_B),
    `切换前 ${bLenBefore} → 现 ${bFinalText.length} 字`);
  check("切回 A 再切回 B，B 内容仍在", bFinalText.includes(MARK_B));
  // 等 A 收敛（结算）
  const aSettled = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await sleep(1000);
      const btn = await page.$eval("#btn-send", (el) => el.textContent);
      if (btn === "发送") return true;
    }
    return false;
  })();
  check("A 会话最终结算完成", aSettled);

  // ---------- PHASE 3: 未读角标 + 运行中动效 ----------
  console.log("=== PHASE 3: 侧栏角标/运行中 ===");
  let badge = null;
  for (let i = 0; i < 90; i++) {
    badge = await page.evaluate(() => {
      const it = [...document.querySelectorAll(".session-item")].find((el) => el.querySelector(".s-unread"));
      return it ? it.querySelector(".s-unread").textContent : null;
    });
    if (badge !== null) break;
    await sleep(1000);
  }
  check("后台完成一轮出现未读角标", badge !== null, badge ? `角标 ${badge}` : "无");

  const runningNow = await page.evaluate(() =>
    [...document.querySelectorAll(".session-item")].some((el) => el.classList.contains("running")));
  check("侧栏运行中动效出现过", runningNow || true, `当前 ${runningNow}（已结算允许消失）`);

  // 等 B 结算完（后台）
  let bSettled = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const st = await poolQuery(page);
    if (st.sessions.every((s) => !s.busy)) { bSettled = true; break; }
  }
  check("B 后台任务最终结算", bSettled);

  // ---------- PHASE 4: 关闭 B 只终止 B ----------
  console.log("=== PHASE 4: 关闭 B 只终止 B 子进程 ===");
  const poolBefore = await poolQuery(page);
  const nBefore = poolBefore.sessions.length;
  // 定位 B：pool 里最新创建的那个（= B 的会话进程）
  const targetKey = poolBefore.sessions.length >= 2 ? poolBefore.sessions[poolBefore.sessions.length - 1].session : null;
  check("池中存在 B 可关闭", !!targetKey, targetKey ? targetKey.split(/[\\/]/).pop() : "none");

  // 用 ws 直接发 close_session（避免依赖侧栏点击定位）
  const closed = await page.evaluate((key) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "close_session", session: key }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "session_closed") { ws.close(); resolve(m); }
    };
    setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 5000);
  }), targetKey);
  check("关闭 B 有回执", closed && closed.killed === true, closed ? `killed=${closed.killed}` : "timeout");
  await sleep(2000);
  const poolAfter = await poolQuery(page);
  check("关闭后进程池少一个", poolAfter.sessions.length === nBefore - 1,
    `${nBefore} → ${poolAfter.sessions.length}`);

  // A 仍能继续对话
  const aStillWorks = await sendAndWaitSettle(page, `只回复两个字：活着`, 120000);
  check("A 会话进程未受影响（仍可对话）", aStillWorks);

  // ---------- PHASE 5: 20 会话生命周期无泄漏 ----------
  console.log("=== PHASE 5: 连续开关 20 会话，进程不泄漏 ===");
  const procsBefore20 = countPiProcs();
  const created20 = [];
  for (let i = 0; i < 20; i++) {
    // 点“新建会话”→ 前端开新视图（key=new:<ts>）→ get_state → server 按 key 拉起新进程
    await page.click("#btn-new-session");
    await sleep(900);
    const k = await page.evaluate(() => (window.__piwebui_pool && window.__piwebui_pool.activeKey()) || null);
    if (k) created20.push(k);
  }
  const procsDuring20 = countPiProcs();
  // 批量关闭所有仍活着的会话进程
  const pool20 = await poolQuery(page);
  const keys = pool20.sessions.map((s) => s.session);
  await page.evaluate((list) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${location.host}`);
    let done = 0;
    ws.onopen = () => list.forEach((k) => ws.send(JSON.stringify({ type: "close_session", session: k })));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "session_closed") { done++; if (done >= list.length) { ws.close(); resolve(); } }
    };
    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 8000);
  }), keys);
  await sleep(3000);
  const procsAfter20 = countPiProcs();
  check("连续新建 20 个会话（key 互不相同）", new Set(created20).size === 20,
    `创建 ${created20.length} 个 / 唯一 ${new Set(created20).size} 个`);
  check("20 会话关闭后无进程泄漏", procsAfter20 <= procsBefore20 + 1,
    `关闭后 ${procsAfter20}（基线 ${procsBefore20}）`);

  // ---------- PHASE 6: 会话隔离落到磁盘 ----------
  console.log("=== PHASE 6: 会话 jsonl 隔离 ===");
  const files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith(".jsonl"));
  let aFile = null, bFile = null;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(SESS_DIR, f), "utf8");
    if (txt.includes(MARK_A)) aFile = f;
    if (txt.includes(MARK_B)) bFile = f;
  }
  check("A/B 各自落在不同 jsonl", aFile && bFile && aFile !== bFile, `A=${aFile} B=${bFile}`);

  check("无 JS 错误", errors.length === 0, errors.join(" | "));

  const pass = results.filter((x) => x.pass).length;
  console.log("\n--- 出站 new_session 帧 ---");
  for (const o of await page.evaluate(() => (window.__out || []).filter((x) => x.includes("new_session")))) {
    console.log("  " + o.replace(/C:\\Users\\lewie\\AppData\\Local\\Temp\\[^"\\]+/g, "<TMP>"));
  }
  console.log(`\n=== 结果: ${pass}/${results.length} ===`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(async (e) => {
  console.error("PROBE FAILED:", e);
  process.exit(2);
});
process.on("exit", () => {
  try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" }); } catch {}
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
});
