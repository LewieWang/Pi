/**
 * v0.5 专项探针：Markdown 渲染 + 状态栏 + 长对话折叠
 * PHASE A: 历史消息渲染（自动加载后）
 * PHASE B: 发一条真实 prompt，验证流式 markdown 全链路
 * 运行: NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules node md_probe.js
 */
const { chromium } = require("playwright-core");

const BASE = "http://localhost:3210";
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || "" });
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? " :: " + detail : ""}`);
}

(async () => {
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

  // ---------- PHASE A: 历史渲染 ----------
  console.log("=== PHASE A: 历史消息 Markdown 渲染 ===");
  let rendered = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    rendered = await page.evaluate(() =>
      document.querySelectorAll("#messages .msg, #messages .tool-result, #messages .history-note").length);
    if (rendered > 5) break;
  }
  check("历史消息已渲染", rendered > 5, `${rendered} 个节点`);

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
    // 折叠条
    const kids = [...document.querySelectorAll("#messages > *")].filter(el =>
      el.classList.contains("msg") || el.classList.contains("tool-card") || el.classList.contains("tool-result"));
    r.msgNodes = kids.length;
    r.collapseBar = !!document.querySelector(".collapse-bar");
    // 用户气泡 markdown 化
    const u = document.querySelector("#messages .msg.user");
    r.userMdBody = u ? !!u.querySelector(".md-body") : false;
    return r;
  });
  console.log("  A 详情:", JSON.stringify(a));
  check("assistant 消息已 markdown 化", a.mdBodyCount > 0, `${a.mdBodyCount} 个 .md-body`);
  check("存在结构化 markdown 元素", a.structured > 0, `${a.structured} 个含块级元素`);
  check("md-body white-space=normal", a.mdWhiteSpace === "normal", a.mdWhiteSpace);
  check("状态栏可见且有内容", a.statusbarHidden === false && a.statusbarText.length > 5, a.statusbarText.slice(0, 80));
  check("用户气泡也 markdown 化", a.userMdBody === true);
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
  }

  // ---------- PHASE B: 流式渲染 ----------
  console.log("=== PHASE B: 流式 Markdown（发真实 prompt）===");
  // 防误伤守卫：本阶段会发送真实 prompt。在 live 会话（消息多 / 正在流式中）
  // 上跑会污染用户会话 —— 默认中止；确认要跑时设 MD_PROBE_ALLOW_LIVE=1。
  const liveGuard = await page.evaluate(() => ({
    msgs: document.querySelectorAll("#messages .msg").length,
    sendDisabled: !!document.getElementById("btn-send")?.disabled,
  }));
  if (liveGuard.msgs > 40 || liveGuard.sendDisabled) {
    const why = liveGuard.sendDisabled ? "发送中（isStreaming）" : `${liveGuard.msgs} 条消息，疑似 live 会话`;
    console.error(`PHASE B 中止：${why}。`);
    console.error("如确要在 live 会话上跑：设 MD_PROBE_ALLOW_LIVE=1；或改用隔离实例（参考 ui_probe.js 自起 server 模式）。意外注入的历史 prompt 需手动编辑重发清理。");
    const failedNow = results.filter(r => !r.pass);
    console.log(`\n===== ${results.length - failedNow.length}/${results.length} 通过（PHASE B 未执行）=====`);
    await browser.close();
    process.exit(1);
  }
  await page.fill("#input", "请严格用以下 Markdown 元素回复：一个 # 一级标题、一句 **加粗**、一个 - 列表项、一个 ```js 代码块（写 const x = 1;）、一个两列表格。不要有多余解释。");
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

  // 等本轮结束（token note 出现即一轮完结）
  let settled = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    settled = await page.evaluate(() => !!document.querySelector("#messages .token-note"));
    if (settled) break;
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
})().catch((e) => { console.error("探针崩溃:", e); process.exit(2); });
