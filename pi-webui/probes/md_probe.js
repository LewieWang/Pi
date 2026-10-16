/**
 * v0.9.1 专项探针：Markdown 渲染 + 状态栏 + 长对话折叠
 * PHASE A: 造历史 → 刷新 → 历史消息 markdown 渲染（复制/高亮/用户气泡）
 * PHASE B: 流式 markdown 全链路（HTML 结构渐进 + 终态结构化）
 *
 * v0.9.1 安全重写：自起 3211 隔离实例（--ephemeral），绝不直连 3210 live。
 * 旧版直连 3210 且 guard 只查 msgs>40 —— 压缩过的 live 会话只剩几条可见消息，
 * guard 形同虚设，PHASE B 把测试 prompt 注入用户会话 4 次（其中一次还落成
 * 独立 jsonl，制造了"凭空多出的会话"）。隔离后 guard 概念整体废弃。
 *
 * 运行: NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *       node md_probe.js
 */
const { chromium } = require("playwright-core");
const { spawn, execSync } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || "" });
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

const MD_PROMPT = "请严格用以下 Markdown 元素回复：一个 # 一级标题、一句 **加粗**、一个 - 列表项、一个 ```js 代码块（写 const x = 1;）、一个两列表格。不要有多余解释。";

const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), "--port", String(PORT), "--ephemeral"], {
  cwd: __dirname,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));
const cleanup = () => { try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" }); } catch (e) { /* 已退出 */ } };
process.on("exit", cleanup);

(async () => {
  await waitListen(15000);
  console.log(`临时 server 已监听 ${BASE}`);

  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // console 错误事件的 text() 不含 URL（只有 "Failed to load resource..."），URL 在 location()
    const loc = m.location();
    const url = (loc && loc.url) || "";
    if (/favicon/.test(url) || /favicon/.test(m.text())) return;
    errors.push("CONSOLE: " + m.text() + " @" + url);
  });
  page.on("response", (r) => {
    if (r.status() === 404 && !/favicon/.test(r.url())) errors.push("HTTP404: " + r.url());
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  /** 发一条 prompt 并等本轮结算（token note 出现）。首条会触发 pi 惰性启动，等待更久。 */
  async function sendAndWaitSettled(text, maxSec) {
    await page.fill("#input", text);
    await page.click("#btn-send");
    for (let i = 0; i < maxSec; i++) {
      await page.waitForTimeout(1000);
      const done = await page.evaluate(() => !!document.querySelector("#messages .token-note"));
      if (done) return true;
    }
    return false;
  }

  // ---------- PHASE A: 造历史 + 历史渲染 ----------
  console.log("=== PHASE A: 造历史 → 刷新 → 历史渲染 ===");
  const settledA = await sendAndWaitSettled(MD_PROMPT, 180);
  check("首轮 prompt 结算（token note）", settledA);

  // 刷新页面强制走历史渲染路径（renderMessages / renderHistoryAssistant）
  await page.reload({ waitUntil: "networkidle" });
  let rendered = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    rendered = await page.evaluate(() =>
      document.querySelectorAll("#messages .msg, #messages .tool-result, #messages .history-note").length);
    if (rendered >= 2) break;
  }
  check("历史消息已渲染", rendered >= 2, `${rendered} 个节点`);

  const a = await page.evaluate(() => {
    const r = {};
    const md = [...document.querySelectorAll("#messages .md-body")];
    r.mdBodyCount = md.length;
    // 结构化 HTML：任一带 p/strong/ul/pre/code-block/hN 子元素
    r.structured = md.filter(el => el.querySelector("p,strong,em,ul,ol,pre,code,table,h1,h2,h3,blockquote,hr,.code-block")).length;
    // markdown 区内 white-space 必须是 normal（不是 .msg 的 pre-wrap）
    r.mdWhiteSpace = md.length ? getComputedStyle(md[0]).whiteSpace : null;
    // 代码块与高亮
    r.codeBlocks = document.querySelectorAll("#messages .code-block").length;
    r.tokSpans = document.querySelectorAll("#messages .tok-kw,#messages .tok-str,#messages .tok-num,#messages .tok-com").length;
    r.copyBtns = document.querySelectorAll("#messages .code-copy").length;
    // 状态栏
    const bar = document.querySelector("#statusbar");
    r.statusbarHidden = bar ? bar.hidden : "missing";
    r.statusbarText = bar ? bar.textContent.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    // 折叠条（v0.9: 消息在 .session-view 容器内，必须用后代选择器）
    const kids = document.querySelectorAll("#messages .msg, #messages .tool-card, #messages .tool-result");
    r.msgNodes = kids.length;
    r.collapseBar = !!document.querySelector(".collapse-bar");
    // 用户气泡 markdown 化（隔离实例必然有 user 消息）
    const users = [...document.querySelectorAll("#messages .msg.user")];
    r.userTotal = users.length;
    r.userWithMd = users.filter(u => u.querySelector(".md-body")).length;
    r.userMdBody = r.userTotal === 0 ? null : r.userWithMd === r.userTotal;
    return r;
  });
  console.log("  A 详情:", JSON.stringify(a));
  check("assistant 消息已 markdown 化", a.mdBodyCount > 0, `${a.mdBodyCount} 个 .md-body`);
  check("存在结构化 markdown 元素", a.structured > 0, `${a.structured} 个含块级元素`);
  check("md-body white-space=normal", a.mdWhiteSpace === "normal", a.mdWhiteSpace);
  check("状态栏可见且有内容", a.statusbarHidden === false && a.statusbarText.length > 5, a.statusbarText.slice(0, 80));
  if (a.userTotal > 0) {
    check("用户气泡也 markdown 化", a.userMdBody === true, `${a.userWithMd}/${a.userTotal}`);
  } else {
    check("用户气泡也 markdown 化", false, "历史中无 user 消息（异常）");
  }
  if (a.msgNodes > 30) {
    check("超长对话出现折叠条", a.collapseBar === true, `${a.msgNodes} 节点`);
  } else {
    check("短对话不出现折叠条", a.collapseBar === false, `${a.msgNodes} 节点`);
  }
  if (a.codeBlocks > 0) {
    check("代码块带复制按钮", a.copyBtns >= a.codeBlocks, `${a.codeBlocks} 块 / ${a.copyBtns} 按钮`);
    // 语法高亮仅在代码块语言处于支持族（js/ts/py/sh/json/jsonc）内时断言；
    // 折叠后可见代码块可能是 text/html 等无高亮语言 → SKIP 而非失败
    const langs = await page.$$eval("#messages .code-block code", (els) =>
      els.map((el) => {
        const m = (el.className || "").match(/language-([\w+-]+)/);
        return m ? m[1].toLowerCase() : "";
      }));
    const HL_FAMILIES = /^(javascript|js|jsx|mjs|cjs|typescript|ts|tsx|python|py|bash|sh|zsh|shell|console|shellsession|json|jsonc)$/;
    const hlable = langs.filter((l) => HL_FAMILIES.test(l)).length;
    if (hlable > 0) {
      check("语法高亮 span 存在", a.tokSpans > 0, `${a.tokSpans} 个 token span（可高亮块 ${hlable}/${langs.length}）`);
    } else {
      results.push({ name: "语法高亮 span 存在", pass: true });
      console.log(`  ✓ 语法高亮 span 存在 :: SKIP（可见代码块语言不在支持族: ${JSON.stringify(langs)}）`);
    }
    // 点击复制按钮（上下文已授权剪贴板）
    const copied = await page.evaluate(async () => {
      const btn = document.querySelector("#messages .code-copy");
      if (!btn) return "no-btn";
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      return btn.textContent;
    });
    check("复制按钮点击反馈", copied === "已复制", `按钮文字: ${copied}`);
  } else {
    check("代码块带复制按钮", false, "历史中无代码块（异常）");
  }

  // ---------- PHASE B: 流式渲染 ----------
  console.log("=== PHASE B: 流式 Markdown（隔离实例发真实 prompt）===");
  await page.fill("#input", MD_PROMPT);
  await page.click("#btn-send");

  // 等流式开始（出现流式 md-body）
  let streamStarted = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    streamStarted = await page.evaluate(() => {
      const el = document.querySelector("#messages .msg.assistant .md-body");
      return !!el && el.innerHTML.length > 10;
    });
    if (streamStarted) break;
  }
  check("流式输出开始", streamStarted);

  // 流式中： Progressive 检查——内容在增长且已是 HTML 结构
  const midStream = await page.evaluate(() => {
    const el = document.querySelector("#messages .msg.assistant .md-body");
    return el ? { len: el.innerHTML.length, hasTags: /<(p|h1|strong|ul|pre|div)/.test(el.innerHTML) } : null;
  });
  check("流式内容为 HTML 结构（非纯文本）", midStream && midStream.hasTags, midStream ? `len=${midStream.len}` : "null");

  // 等本轮结束（token note 数量比 PHASE A 多 1 即本轮完结）
  const baseNotes = await page.evaluate(() => document.querySelectorAll("#messages .token-note").length);
  let settled = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    const now = await page.evaluate(() => document.querySelectorAll("#messages .token-note").length);
    if (now > baseNotes) { settled = true; break; }
  }
  check("本轮结束（token note 已追加）", settled);

  const b = await page.evaluate(() => {
    // 取最后一个「带 .md-body」的 assistant（token-note 也是 .msg.assistant，要排除）
    const asst = [...document.querySelectorAll("#messages .msg.assistant")].filter(el => el.querySelector(".md-body")).pop();
    const md = asst ? asst.querySelector(".md-body") : null;
    return {
      hasH1: md ? !!md.querySelector("h1") : false,
      hasStrong: md ? !!md.querySelector("strong") : false,
      hasList: md ? !!md.querySelector("ul li, ol li") : false,
      hasCodeBlock: md ? !!md.querySelector(".code-block") : false,
      hasTokKw: md ? !!md.querySelector(".tok-kw") : false,
      hasTable: md ? !!md.querySelector("table") : false,
      statusbar: (document.querySelector("#statusbar") || {}).textContent?.replace(/\s+/g, " ").trim().slice(0, 120) || "",
    };
  });
  console.log("  B 详情:", JSON.stringify(b));
  check("最终渲染含标题/加粗/列表", b.hasH1 && b.hasStrong && b.hasList);
  check("最终渲染含代码块+高亮", b.hasCodeBlock && b.hasTokKw);
  check("最终渲染含表格", b.hasTable);
  check("状态栏已更新", b.statusbar.length > 5, b.statusbar.slice(0, 80));

  check("全程无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { console.log("失败项:", failed.map(f => f.name).join(", ")); process.exit(1); }
})().catch((e) => { console.error("探针崩溃:", e); cleanup(); process.exit(2); });
