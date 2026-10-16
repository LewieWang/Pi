/**
 * v0.7 专项探针：源头防空会话（API 过滤 + 启动清扫 + 懒创建 + 拆除降噪 UI）
 * PHASE A: 空白消息清理回归（v0.6 成果；有历史时才全量断言）
 * PHASE B: 源头过滤——创建空会话文件 → API 不返回 → 页面不显示 → 无降噪行 DOM → 无"已隐藏"文本 → API 删除
 * PHASE D: usage.jsonl 不被当会话；API 返回的会话全部 hasMessages===true
 * PHASE E: 懒创建——点「新建会话」不落盘（目录文件集不变）；header 显示"新会话"；刷新还原
 * PHASE C: 回归（状态栏 / 消息区 / 会话分组）
 * 运行（指向临时实例，避免重启用户正在用的 3210）:
 *   PROBE_BASE=http://localhost:3211 NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *     C:\Users\lewie\.workbuddy\binaries\node\versions\22.22.2-6\node.exe session_probe.js
 */
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const BASE = process.env.PROBE_BASE || "http://localhost:3210";
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
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = (m.location() && m.location().url) || "";
    if (/favicon/.test(url) || /favicon/.test(m.text())) return;
    errors.push("CONSOLE: " + m.text() + " @" + url);
  });
  page.on("dialog", (d) => d.accept()); // 自动确认（新建会话 confirm / 删除确认）

  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  // 等 pi 就绪（冷启动 + 恢复活跃会话可能较慢）
  let rendered = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    rendered = await page.evaluate(() =>
      document.querySelectorAll("#messages .msg, #messages .tool-result").length);
    if (rendered > 5) break;
  }
  // 新实例（pi 刚 spawn）活跃会话可能无历史——切换到数据量最大的会话，
  // 让 PHASE A 有真实历史可验（pi 的 session 文件懒落盘：get_state 返回的
  // 路径首条消息才建；列表首个=最新，未必有历史，故选 size 最大的）
  if (rendered <= 5) {
    console.log("  活跃会话无足够历史，切换到数据量最大的会话…");
    await page.evaluate(async () => {
      const res = await fetch("/api/sessions/list");
      const j = await res.json();
      const list = j.sessions || [];
      if (!list.length) return;
      const biggest = list.reduce((a, b) => (b.size > a.size ? b : a));
      const el = [...document.querySelectorAll("#session-list .session-item")]
        .find(x => x.dataset.path === biggest.path);
      if (el) el.click();
    });
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      rendered = await page.evaluate(() =>
        document.querySelectorAll("#messages .msg, #messages .tool-result").length);
      if (rendered > 5) break;
    }
  }
  check("历史消息已渲染", rendered > 5, `${rendered} 个节点`);

  // ---------- PHASE A: 空白消息清理回归 ----------
  console.log("=== PHASE A: 空白消息清理 ===");
  const a = await page.evaluate(() => {
    const r = {};
    r.hasEmptyResponseText = [...document.querySelectorAll("#messages *")]
      .some(el => el.children.length === 0 && /\(空响应\)/.test(el.textContent || ""));
    r.zeroMeta = [...document.querySelectorAll("#messages .meta")]
      .filter(el => /\b0 in \/ 0 out tokens\b/.test(el.textContent || "")).length;
    r.emptyBubbles = [...document.querySelectorAll("#messages .msg.assistant")]
      .filter(el => !el.querySelector(".md-body,.thinking,.tool-card,.tool-result,img,pre,.blank-response-note,.meta")
                    && !el.classList.contains("switching-note")
                    && !el.classList.contains("history-note"))
      .length;
    r.msgCount = document.querySelectorAll("#messages .msg, #messages .tool-result").length;
    return r;
  });
  console.log("  A 详情:", JSON.stringify(a));
  check("无 (空响应) 占位文本", a.hasEmptyResponseText === false);
  check("无 0 in / 0 out tokens meta 行", a.zeroMeta === 0, `${a.zeroMeta} 条`);
  check("无空白 assistant 气泡", a.emptyBubbles === 0, `${a.emptyBubbles} 个`);

  // ---------- PHASE B: 源头过滤（server API 不返回空会话） ----------
  console.log("=== PHASE B: 源头过滤 ===");
  const sessionsInfo = await page.evaluate(async () => {
    const res = await fetch("/api/sessions/list");
    return await res.json();
  });
  const dir = sessionsInfo.sessions && sessionsInfo.sessions.length
    ? path.dirname(sessionsInfo.sessions[0].path)
    : sessionsInfo.sessionDir;
  const stamp = Date.now();
  const probeName = `__probe_empty_session_${stamp}.jsonl`;
  const emptyFile = path.join(dir, probeName);
  fs.writeFileSync(emptyFile, JSON.stringify({
    type: "session",
    id: `__probe_empty_${stamp}`,
    timestamp: new Date().toISOString(),
    cwd: "D:\\PI\\workspace",
  }) + "\n", "utf8");
  console.log("  已创建测试空会话:", emptyFile);

  // 刷新列表（服务端重读目录）
  await page.evaluate(() => { if (typeof loadSessionList === "function") loadSessionList(); });
  await page.waitForTimeout(1500);

  // B1: API 层——空会话不出现在 /api/sessions/list 响应里（源头过滤）
  const apiAfter = await page.evaluate(async () => {
    const res = await fetch("/api/sessions/list");
    const j = await res.json();
    return {
      names: (j.sessions || []).map(s => s.fileName),
      allHaveMessages: (j.sessions || []).every(s => s.hasMessages === true),
    };
  });
  console.log("  B1 API 详情:", JSON.stringify(apiAfter).slice(0, 300));
  check("API 不返回空会话（源头过滤）", !apiAfter.names.includes(probeName),
    `返回 ${apiAfter.names.length} 个会话`);
  check("API 返回的会话全部有消息", apiAfter.allHaveMessages === true);

  // B2: 页面层——列表无该项、无降噪行 DOM、无"已隐藏"文案
  const b2 = await page.evaluate((probe) => {
    const list = [...document.querySelectorAll("#session-list .session-item")];
    return {
      probeVisible: list.some(el => (el.dataset.path || "").includes(probe)),
      hasNoiseRow: !!document.querySelector("#session-hidden-empty"),
      hasHiddenText: /已隐藏/.test(document.querySelector("#sidebar") ? document.querySelector("#sidebar").textContent : ""),
      itemCount: list.length,
    };
  }, `__probe_empty_session_${stamp}`);
  console.log("  B2 页面详情:", JSON.stringify(b2));
  check("空会话不出现在页面列表", b2.probeVisible === false);
  check("无降噪提示行 DOM（#session-hidden-empty）", b2.hasNoiseRow === false);
  check("侧栏无\"已隐藏\"文案", b2.hasHiddenText === false);

  // B3: 清理——通过 API 删除探针文件（UI 已无清理按钮，属预期）
  const delOk = await page.evaluate(async (fp) => {
    const res = await fetch("/api/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fp }),
    });
    return res.ok;
  }, emptyFile);
  await page.waitForTimeout(500);
  check("API 删除探针空会话成功", delOk === true);
  check("探针空会话文件已删除", !fs.existsSync(emptyFile));

  // ---------- PHASE D: 内部文件排除 ----------
  console.log("=== PHASE D: 内部文件排除 ===");
  // usage.jsonl（用量审计日志）不应被当会话返回；若目录里没有就造一个验证排除逻辑
  const usageFile = path.join(dir, "usage.jsonl");
  const usageExisted = fs.existsSync(usageFile);
  if (!usageExisted) {
    fs.writeFileSync(usageFile, JSON.stringify({ ts: new Date().toISOString(), input: 1, output: 1 }) + "\n", "utf8");
  }
  await page.evaluate(() => { if (typeof loadSessionList === "function") loadSessionList(); });
  await page.waitForTimeout(1200);
  const d = await page.evaluate(async () => {
    const res = await fetch("/api/sessions/list");
    const j = await res.json();
    return { names: (j.sessions || []).map(s => s.fileName) };
  });
  check("usage.jsonl 不出现在会话列表", !d.names.includes("usage.jsonl"), d.names.join(","));
  if (!usageExisted) { try { fs.unlinkSync(usageFile); } catch (e) {} }
  check("usage.jsonl 未被误删（双护栏）", !usageExisted ? true : fs.existsSync(usageFile));

  // ---------- PHASE E: 懒创建 ----------
  console.log("=== PHASE E: 懒创建 ===");
  const listJsonl = () => fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
  const beforeClick = listJsonl();
  await page.click("#btn-new-session"); // confirm 对话框已自动 accept
  await page.waitForTimeout(2000);
  const afterClick = listJsonl();
  const e1 = await page.evaluate(() => ({
    title: (document.querySelector("#chat-title") || {}).textContent || "",
    sub: (document.querySelector("#chat-sub") || {}).textContent || "",
  }));
  console.log("  E 详情:", JSON.stringify({ before: beforeClick.length, after: afterClick.length, ...e1 }));
  check("点新建会话不落盘（无新空文件）",
    JSON.stringify(beforeClick) === JSON.stringify(afterClick),
    `${beforeClick.length} → ${afterClick.length} 个文件`);
  check("header 显示新会话（懒创建态）", /新会话/.test(e1.title), e1.title + " / " + e1.sub);

  // 刷新还原（懒创建是纯前端态，刷新即弃）
  await page.reload({ waitUntil: "networkidle" });
  let rendered2 = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    rendered2 = await page.evaluate(() =>
      document.querySelectorAll("#messages .msg, #messages .tool-result").length);
    if (rendered2 > 5) break;
  }
  const e2 = await page.evaluate(() => ({
    itemCount: document.querySelectorAll("#session-list .session-item").length,
    title: (document.querySelector("#chat-title") || {}).textContent || "",
    msgNodes: document.querySelectorAll("#messages .msg, #messages .tool-result").length,
    hasEmptyHint: !!document.querySelector("#messages .empty-hint"),
  }));
  console.log("  E2 刷新后:", JSON.stringify(e2));
  check("刷新后会话列表恢复", e2.itemCount > 0, `${e2.itemCount} 项`);
  check("刷新后弃懒创建态（回到真实会话）", !!e2.title && !/新会话|未选择/.test(e2.title), e2.title);
  check("刷新后消息区正常", e2.msgNodes > 0 || e2.hasEmptyHint, `${e2.msgNodes} 节点`);

  // ---------- PHASE C: 回归 ----------
  console.log("=== PHASE C: 回归 ===");
  const c = await page.evaluate(() => {
    return {
      statusbarVisible: (document.querySelector("#statusbar") || {}).hidden === false
        && (document.querySelector("#statusbar") || {}).textContent.length > 5,
      // 消息区完好：有消息节点，或合法空态（欢迎页）。不强制 >3——小会话/新实例天然就几条
      messagesStillThere: document.querySelectorAll("#messages .msg").length > 0
        || !!document.querySelector("#messages .empty-hint"),
      sessionGroups: document.querySelectorAll("#session-list .session-group-title").length,
    };
  });
  console.log("  C 详情:", JSON.stringify(c));
  check("状态栏仍可见", c.statusbarVisible);
  check("消息区未损坏", c.messagesStillThere);
  check("会话分组渲染正常", c.sessionGroups > 0, `${c.sessionGroups} 组`);

  check("全程无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter(r => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { console.log("失败项:", failed.map(f => f.name).join(", ")); process.exit(1); }
})().catch((e) => { console.error("探针崩溃:", e); process.exit(2); });
