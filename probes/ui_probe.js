/**
 * v0.6 专项探针：扩展 UI 交互（extension_ui_request 子协议）
 *
 * 覆盖：confirm / select / input / editor 四种对话框 + notify toast +
 * setStatus 状态条 + setWidget 挂件 + setTitle + set_editor_text + 队列。
 *
 * 运行（不依赖 3210 上的正式服务，自起 3211 临时实例）：
 *   NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *   node ui_probe.js
 */
const { chromium } = require("playwright-core");
const { spawn, execSync } = require("child_process");
const http = require("http");

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

const server = spawn(process.execPath, ["server.js", "--port", String(PORT), "--ephemeral"], {
  cwd: __dirname,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));

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

  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  // 挂 WS 发送帧钩子（实例已建，原型层拦截仍生效）
  await page.evaluate(() => {
    window.__frames = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      window.__frames.push(String(d));
      return orig.call(this, d);
    };
  });

  const T = () => page.evaluate(() => window.__piwebui_test.state());
  const lastResp = () => page.evaluate(() => {
    const f = window.__frames.filter((x) => x.includes("extension_ui_response"));
    return f[f.length - 1] || null;
  });

  console.log("=== PHASE 1: confirm 对话框 ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "d1", method: "confirm", title: "执行危险命令?", message: "**rm -rf** /",
  }));
  let st = await T();
  check("confirm 弹框出现", !st.dialogHidden && st.active && st.active.id === "d1", JSON.stringify(st.active));
  await page.click("#ext-dialog-options .ext-btn-primary");
  let f = await lastResp();
  check("confirm 响应 confirmed:true 且 id 匹配", f && f.includes('"confirmed":true') && f.includes('"id":"d1"'), f);

  console.log("=== PHASE 2: select 对话框 ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "d2", method: "select", title: "选一个", options: ["Allow", "Block"],
  }));
  const opts = await page.$$eval("#ext-dialog-options .ext-btn", (els) => els.map((e) => e.textContent));
  check("select 选项渲染(含取消)", opts.join(",") === "Allow,Block,取消", opts.join(","));
  await page.click("#ext-dialog-options .ext-btn:nth-child(2)");
  f = await lastResp();
  check("select 响应 value:Block 且 id 匹配", f && f.includes('"value":"Block"') && f.includes('"id":"d2"'), f);

  console.log("=== PHASE 3: input 对话框 (Enter 提交) ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "d3", method: "input", title: "输入", placeholder: "p",
  }));
  await page.fill("#ext-dialog-text", "hello");
  await page.keyboard.press("Enter");
  f = await lastResp();
  check("input 响应 value:hello 且 id 匹配", f && f.includes('"value":"hello"') && f.includes('"id":"d3"'), f);

  console.log("=== PHASE 4: editor 对话框 (Esc 取消) ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "d4", method: "editor", title: "编辑", prefill: "abc",
  }));
  const prefill = await page.inputValue("#ext-dialog-area");
  check("editor 预填 prefill", prefill === "abc", prefill);
  await page.keyboard.press("Escape");
  f = await lastResp();
  check("editor Esc → cancelled:true 且 id 匹配", f && f.includes('"cancelled":true') && f.includes('"id":"d4"'), f);

  console.log("=== PHASE 5: 对话框队列（流式中也能弹） ===");
  await page.evaluate(() => {
    window.__piwebui_test.handleExtensionUiRequest({ type: "extension_ui_request", id: "q1", method: "confirm", title: "第一个" });
    window.__piwebui_test.handleExtensionUiRequest({ type: "extension_ui_request", id: "q2", method: "confirm", title: "第二个" });
  });
  st = await T();
  check("第二个进入队列", st.active.id === "q1" && st.queued.includes("q2"), JSON.stringify(st));
  await page.click("#ext-dialog-options .ext-btn-primary");
  st = await T();
  check("q1 应答后 q2 顶上", st.active.id === "q2", JSON.stringify(st));
  await page.click("#ext-dialog-options .ext-btn-danger");
  f = await lastResp();
  check("q2 拒绝响应 confirmed:false", f && f.includes('"confirmed":false') && f.includes('"id":"q2"'), f);

  console.log("=== PHASE 6: notify toast（无响应帧） ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "n1", method: "notify", message: "任务完成", notifyType: "info",
  }));
  await page.waitForTimeout(150);
  const toast = await page.$eval("#ext-toast-wrap .ext-toast", (el) => el.textContent).catch(() => null);
  check("notify 显示 toast", toast === "任务完成", String(toast));
  f = await lastResp();
  check("notify 不产生响应帧", !f || !f.includes('"id":"n1"'), String(f));

  console.log("=== PHASE 7: setStatus 状态条（缺省清除） ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "sol-pi", statusText: "⚡ 1 KiB saved",
  }));
  st = await T();
  check("setStatus 记录", st.statuses["sol-pi"] === "⚡ 1 KiB saved", JSON.stringify(st.statuses));
  const strip = await page.$eval("#ext-status-strip", (el) => ({ hidden: el.hidden, text: el.textContent }));
  check("状态条显示", !strip.hidden && strip.text.includes("⚡ 1 KiB saved"), JSON.stringify(strip));
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "sol-pi",
  }));
  st = await T();
  check("setStatus 缺省 = 清除", !("sol-pi" in st.statuses), JSON.stringify(st.statuses));

  console.log("=== PHASE 8: setWidget / setTitle / set_editor_text ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "plan", title: "当前计划", widgetLines: ["1. a", "2. b"],
  }));
  const widget = await page.$eval("#ext-widgets", (el) => ({ hidden: el.hidden, n: el.querySelectorAll(".ext-widget").length }));
  check("setWidget 渲染挂件", !widget.hidden && widget.n === 1, JSON.stringify(widget));
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "w2", method: "setTitle", title: "Pi · 会话X",
  }));
  check("setTitle 生效", (await page.title()) === "Pi · 会话X", await page.title());
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "e1", method: "set_editor_text", text: "预填的内容",
  }));
  check("set_editor_text 预填输入框", (await page.inputValue("#input")) === "预填的内容");

  console.log("=== PHASE 9: 未知 method fail-open（回 cancelled） ===");
  await page.evaluate(() => window.__piwebui_test.handleExtensionUiRequest({
    type: "extension_ui_request", id: "u1", method: "hologram", title: "未来方法",
  }));
  await page.waitForTimeout(100);
  f = await lastResp();
  check("未知 method 回 cancelled:true", f && f.includes('"cancelled":true') && f.includes('"id":"u1"'), f);
  st = await T();
  check("未知 method 不弹框", st.dialogHidden === true, JSON.stringify(st));

  console.log("=== PHASE 10: 多客户端仲裁（首个响应生效，他端自动关框） ===");
  const page2 = await browser.newPage();
  await page2.goto(BASE + "/", { waitUntil: "networkidle" });
  await page2.evaluate(() => {
    window.__frames = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { window.__frames.push(String(d)); return orig.call(this, d); };
  });
  const arbReq = { type: "extension_ui_request", id: "m1", method: "confirm", title: "仲裁测试" };
  await page.evaluate((r) => window.__piwebui_test.handleExtensionUiRequest(r), arbReq);
  await page2.evaluate((r) => window.__piwebui_test.handleExtensionUiRequest(r), arbReq);
  let st1 = await T();
  const st2 = await page2.evaluate(() => window.__piwebui_test.state());
  check("两端都展示同一对话框", !st1.dialogHidden && !st2.dialogHidden, JSON.stringify({ a: st1.active, b: st2.active }));
  // page2 先应答（直接走 extRespond，模拟点击）
  await page2.evaluate(() => window.__piwebui_test.extRespond("m1", { confirmed: true }));
  await page.waitForTimeout(400); // 等 server 广播 ui_dialog_resolved
  st1 = await T();
  const st2b = await page2.evaluate(() => window.__piwebui_test.state());
  check("page1 收到仲裁自动关框", st1.dialogHidden && st1.lastResolvedId === "m1", JSON.stringify(st1));
  check("page2 应答后也关框", st2b.dialogHidden && st2b.lastResolvedId === "m1", JSON.stringify(st2b));
  const dupFrames = await page.evaluate(() =>
    window.__frames.filter((x) => x.includes("extension_ui_response") && x.includes('"id":"m1"')));
  check("page1 未发送重复响应", dupFrames.length === 0, JSON.stringify(dupFrames));
  // page1 重复应答（直发 extRespond）→ 服务端抑制；pi 不会收到第二条
  await page.evaluate(() => window.__piwebui_test.extRespond("m1", { confirmed: false }));
  await page.waitForTimeout(200);
  const dup2 = await page.evaluate(() =>
    window.__frames.filter((x) => x.includes("extension_ui_response") && x.includes('"id":"m1"')));
  check("page1 迟到响应已由服务端抑制（前端仍关框不重复）", st1.dialogHidden, `发送帧 ${dup2.length} 条（服务端仅转发首条）`);
  await page2.close();

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
