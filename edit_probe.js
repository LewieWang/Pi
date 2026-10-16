/**
 * v0.6.3 专项探针：编辑重发（edit & re-ask，协议原生 fork）
 *
 * PHASE 1: 发一个短任务 → 等空闲（第一轮回复上屏）
 * PHASE 2: hover 第 1 条 user 气泡 → ✎ → confirm 接受 →
 *          fork 帧发出 + 该条及之后 UI 全部截断 + 原文回填输入框
 * PHASE 3: 改字后发送 → 等空闲 → 新回复上屏、旧气泡/旧回复消失
 * PHASE 4: get_state 拿新 sessionFile（branched）→ JSONL 逐行 JSON.parse
 * PHASE 5: 二次确认取消（dismiss）→ 不发 fork 帧、UI 不截断
 *
 * 运行（自起 3211 临时实例，不碰正式 3210）：
 *   NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *   node edit_probe.js
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

// 非 ephemeral + 独立临时 cwd：fork 需要持久化会话才能验证 JSONL（任务卡验收 2），
// pi 会话写在 ~/.pi/agent/sessions/<encoded-tmpcwd>/，不碰真实项目。
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "piwebui-edit-probe-"));
const server = spawn(process.execPath,
  [path.join(__dirname, "server.js"), "--port", String(PORT),
   "--cwd", TMP_CWD, "--session-dir", path.join(TMP_CWD, "sessions")],
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

(async () => {
  await waitListen(15000);
  console.log(`临时 server 已监听 ${BASE}`);

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
  // confirm() 对话框：PHASE 2 accept、PHASE 5 dismiss（用变量切换）
  let dialogAction = "accept";
  page.on("dialog", (d) => {
    console.log(`  [dialog:${d.type()}] ${d.message().slice(0, 60)}...`);
    if (dialogAction === "accept") d.accept(); else d.dismiss();
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__frames = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      window.__frames.push(String(d));
      return orig.call(this, d);
    };
  });

  const btnText = () => page.$eval("#btn-send", (el) => el.textContent);
  const framesOf = (type) => page.evaluate((t) =>
    window.__frames.filter((x) => x.includes(`"type":"${t}"`)), type);
  const userBubbleTexts = () => page.$$eval("#messages .msg.user", (els) =>
    els.map((el) => (el.querySelector(".md-body") || el).textContent.trim()));

  console.log("=== PHASE 1: 短任务启动并等空闲 ===");
  await page.fill("#input", "不要调用任何工具，直接只回复五个字：第一轮完成");
  await page.click("#btn-send");
  let idle = false;
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000);
    const btn = await btnText();
    const msgs = await page.$$eval("#messages .msg.assistant", (els) => els.length).catch(() => 0);
    if (btn === "发送" && msgs >= 1) { idle = true; break; }
  }
  check("第一轮完成（空闲态 + 回复上屏）", idle, `btn=${await btnText()}`);
  const before = await userBubbleTexts();
  check("user 气泡 1 条", before.length === 1, JSON.stringify(before.map((t) => t.slice(0, 20))));
  const domText1 = await page.evaluate(() => document.body.textContent);
  check("第一轮回复文本上屏", domText1.includes("第一轮完成"), "DOM 检索");

  console.log("=== PHASE 2: hover ✎ → confirm 接受 → fork + 截断 + 回填 ===");
  const editBtn = await page.$("#messages .msg.user .msg-edit-btn");
  check("✎ 编辑按钮存在于 user 气泡", !!editBtn, editBtn ? "found" : "missing");
  dialogAction = "accept";
  await page.click("#messages .msg.user .msg-edit-btn");
  // 等 fork 响应 + UI 截断 + 回填
  let inputVal = "";
  let truncated = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    inputVal = await page.$eval("#input", (el) => el.value).catch(() => "");
    truncated = await page.$$eval("#messages .msg.user", (els) => els.length).then((n) => n === 0).catch(() => false);
    if (inputVal && truncated) break;
  }
  const fuFrames = await framesOf("fork");
  check("fork 帧已发出", fuFrames.length === 1, `${fuFrames.length} 帧`);
  check("该条及之后 UI 已截断（user 气泡 0）", truncated,
    JSON.stringify(await userBubbleTexts()));
  const assistantsAfterFork = await page.$$eval("#messages .msg.assistant",
    (els) => els.filter((e) => e.textContent.includes("第一轮完成")).length).catch(() => -1);
  check("旧 assistant 回复同步移除", assistantsAfterFork === 0, `${assistantsAfterFork} 条`);
  check("原文回填输入框", inputVal.includes("第一轮完成"), JSON.stringify(inputVal.slice(0, 30)));

  console.log("=== PHASE 3: 改字后发送 → 新回复上屏 ===");
  await page.fill("#input", "不要调用任何工具，直接只回复五个字：第二轮完成");
  await page.click("#btn-send");
  let idle2 = false;
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000);
    const btn = await btnText();
    const hasNew = await page.evaluate(() => document.body.textContent.includes("第二轮完成"));
    if (btn === "发送" && hasNew) { idle2 = true; break; }
  }
  check("新回合完成且新回复上屏", idle2, `btn=${await btnText()}`);
  const after = await userBubbleTexts();
  check("新 user 气泡 1 条（改后文本）", after.length === 1 && after[0].includes("第二轮完成"),
    JSON.stringify(after.map((t) => t.slice(0, 20))));
  const domText2 = await page.evaluate(() => document.getElementById("messages").textContent);
  check("旧回复「第一轮完成」已消失（对话区）", !domText2.includes("第一轮完成"), "#messages 检索");
  check("新回复「第二轮完成」出现（对话区）", domText2.includes("第二轮完成"), "#messages 检索");

  console.log("=== PHASE 4: branched session JSONL 完整性 ===");
  // fork 后 sessionFile 变更 → 从 get_state 响应（__inRecords）取新路径
  const sessionFile = await page.evaluate(() => {
    const recs = window.__inRecords || [];
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i];
      const rec = r.record || r;
      if (rec.type === "response" && rec.command === "get_state" && rec.success) {
        return rec.data && rec.data.sessionFile;
      }
    }
    return null;
  });
  check("get_state 返回 branched sessionFile", !!sessionFile, sessionFile || "null");
  if (sessionFile && fs.existsSync(sessionFile)) {
    const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim());
    let bad = 0;
    for (const l of lines) { try { JSON.parse(l); } catch { bad++; } }
    check("JSONL 逐行可解析（未写坏）", bad === 0, `${lines.length} 行 / 坏 ${bad}`);
    const raw = fs.readFileSync(sessionFile, "utf8");
    check("新分支含改后 prompt", raw.includes("第二轮完成"), "文件检索");
    check("新分支不含被丢弃的旧 prompt", !raw.includes("第一轮完成"), "文件检索");
  } else {
    check("JSONL 逐行可解析（未写坏）", false, "sessionFile 不可达");
    check("新分支含改后 prompt", false, "sessionFile 不可达");
    check("新分支不含被丢弃的旧 prompt", false, "sessionFile 不可达");
  }

  console.log("=== PHASE 5: confirm 取消 → 不截断 ===");
  const beforeBubbles = await page.$$eval("#messages .msg.user", (els) => els.length);
  dialogAction = "dismiss";
  await page.click("#messages .msg.user .msg-edit-btn");
  await page.waitForTimeout(800);
  const afterBubbles = await page.$$eval("#messages .msg.user", (els) => els.length);
  check("取消后气泡不变", afterBubbles === beforeBubbles, `${beforeBubbles} → ${afterBubbles}`);
  const fuFrames2 = await framesOf("fork");
  check("取消后未发 fork 帧", fuFrames2.length === 1, `仍 ${fuFrames2.length} 帧`);
  const inputAfter = await page.$eval("#input", (el) => el.value).catch(() => "");
  check("取消后输入框未回填", inputAfter === "" || !inputAfter.includes("第二轮完成"), "输入框未动");

  check("无 JS 错误", errors.length === 0, errors.join(" | "));

  const pass = results.filter((r) => r.pass).length;
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
