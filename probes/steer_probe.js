/**
 * v0.6.2 专项探针：Steer 队列（协议原生 follow_up）
 *
 * PHASE 1: 发长任务（bash sleep 12）→ 流式态（按钮变「队列…」）
 * PHASE 2: 流式中排队 2 条 → chips 出现 + follow_up 帧发出
 * PHASE 3: 仍流式中移除 chip[0] → clear_queue + 剩余重入队 + 气泡同步移除
 * PHASE 4: 等全部回合完成 → token notes ≥ 2、队列清空、投递文本上屏
 * PHASE 5: 合成 queue_update 渲染（确定性 UI 断言）
 *
 * 运行（自起 3211 临时实例，不碰正式 3210）：
 *   NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *   node steer_probe.js
 */
const { chromium } = require("playwright-core");
const { spawn, execSync } = require("child_process");
const http = require("http");
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

const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), "--port", String(PORT), "--ephemeral"], {
  cwd: __dirname,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));
// 启动失败（如端口被残留实例占用）立即中止，避免连上旧实例产生假结果
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
    if (m.text().includes("[steer-dbg]")) console.log("  [dbg]", m.text());
    else if (m.type() === "error" && !/favicon/.test(m.text())) errors.push("CONSOLE: " + m.text());
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
  const chipCount = () => page.$$eval("#queue-chips .queue-chip", (els) => els.length).catch(() => -1);
  const framesOf = (type) => page.evaluate((t) =>
    window.__frames.filter((x) => x.includes(`"type":"${t}"`)), type);

  console.log("=== PHASE 1: 长任务启动（bash sleep 12） ===");
  await page.fill("#input", "请务必先调用 bash 工具原样执行命令 `sleep 12`，不要直接回答。执行结束后只回复四个字：第一轮完成");
  await page.click("#btn-send");
  let btn = "";
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    btn = await btnText();
    if (btn === "队列…") break;
  }
  check("进入流式态（按钮变「队列…」）", btn === "队列…", btn);

  console.log("=== PHASE 2: 流式中排队 2 条 ===");
  const MSG2 = "第二轮：收到请回复五个字：第二轮完成";
  const MSG3 = "第三轮：收到请回复五个字：第三轮完成";
  await page.fill("#input", MSG2);
  await page.click("#btn-send");
  await page.fill("#input", MSG3);
  await page.click("#btn-send");
  // 等权威 queue_update 同步（乐观渲染先行，这里等 pi 回包）
  let n = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    n = await chipCount();
    if (n >= 2) break;
  }
  check("排队 chips 出现（≥2）", n >= 2, `chips=${n}`);
  const fuFrames = await framesOf("follow_up");
  check("纯前端队列：不发 follow_up 帧", fuFrames.length === 0, `${fuFrames.length} 帧`);
  const label = await page.$eval("#queue-chips .queue-chips-label", (el) => el.textContent).catch(() => "");
  check("队列计数标签", label.includes("已排队"), label);
  const userBubbles = await page.$$eval("#messages .msg.user", (els) => els.length);
  check("排队消息的乐观气泡已渲染", userBubbles >= 3, `${userBubbles} 个 user 气泡`);

  console.log("=== PHASE 3: 流式中移除 chip[0]（MSG2） ===");
  const beforeBubbles = await page.$$eval("#messages .msg.user", (els) => els.length);
  await page.click("#queue-chips .queue-chip:nth-child(2) .queue-chip-x");
  await page.waitForTimeout(800);
  const afterChips = await chipCount();
  const afterBubbles = await page.$$eval("#messages .msg.user", (els) => els.length);
  check("chip 移除后剩 1", afterChips === 1, `chips=${afterChips}`);
  check("乐观气泡同步移除", afterBubbles === beforeBubbles - 1, `${beforeBubbles} → ${afterBubbles}`);
  const cqFrames = await framesOf("clear_queue");
  check("零竞态：不发 clear_queue 帧", cqFrames.length === 0, `${cqFrames.length} 帧`);
  // 诊断 dump：queue_update 事件序列 + 镜像时间线
  const diag = await page.evaluate(() => {
    const recs = window.__inRecords || [];
    const types = {};
    for (const r of recs) types[r.type] = (types[r.type] || 0) + 1;
    return {
      total: recs.length,
      types,
      responses: recs.filter((r) => r.type === "response" && ["follow_up", "clear_queue", "prompt"].includes(r.command))
        .map((r) => JSON.stringify({ cmd: r.command, ok: r.success, data: r.data, err: r.error })),
      hasInRecords: !!window.__inRecords,
    };
  });
  console.log("  [诊断]", JSON.stringify(diag, null, 1));
  console.log("  [镜像现状]", JSON.stringify(await page.evaluate(() => window.__piwebui_test.queue.state())));

  console.log("=== PHASE 4: 等全部回合完成 ===");
  // 纯前端 FIFO：每条投递都是独立 prompt → 独立回合 → 各自 agent_settled
  // round1（sleep）+ MSG3 投递 = 2 个回合 → 2 个 token note；MSG2 已被移除。
  let notes = 0;
  let settled = false;
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(1000);
    btn = await btnText();
    notes = await page.$$eval("#messages .token-note", (els) => els.length).catch(() => 0);
    const q = await page.evaluate(() => window.__piwebui_test.queue.state());
    if (btn === "发送" && notes >= 2 && q.length === 0) { settled = true; break; }
  }
  check("队列排空并回到空闲态", settled, `btn=${btn} notes=${notes}`);
  const domText = await page.evaluate(() => document.body.textContent);
  check("第三轮投递文本上屏", domText.includes("第三轮完成"), "DOM 检索");
  check("第一轮回复上屏", domText.includes("第一轮完成"), "DOM 检索");
  check("被移除的 MSG2 未投递", !domText.includes("第二轮完成"), "DOM 检索");

  console.log("=== PHASE 5: 合成 queue_update 渲染（确定性） ===");
  await page.evaluate(() => window.__piwebui_test.queue.update(["任务A", "任务B", "任务C"]));
  let chips = await chipCount();
  check("合成队列渲染 3 chips", chips === 3, `chips=${chips}`);
  await page.evaluate(() => window.__piwebui_test.queue.update([]));
  chips = await chipCount();
  check("空队列隐藏 chips", chips === 0, `chips=${chips}`);

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
});
