/**
 * v0.10 专项探针：P2-⑪ 设置面板（模型 / 思维级别 / 登录凭据 / 持久化）
 *
 * PHASE 1: ⚙ 按钮 → 面板打开；模型按 provider 分组；当前模型预选
 * PHASE 2: 思维级别列表来自 get_available_thinking_levels；当前级别标记
 * PHASE 3: 切级别 → set_thinking_level 帧发出 + success + get_state 权威回读
 * PHASE 4: 切模型 → set_model 帧发出 + success + 详情行更新
 * PHASE 5: 保存为默认 → POST /api/settings → config.json 落盘且内容合法
 * PHASE 6: 登录凭据只读（--auth-file fixture：显示 provider+type，不显示密钥）
 * PHASE 7: fail-open —— /api/settings 404 时面板降级可用（热切换仍工作）
 *
 * 运行（自起 3211 隔离实例，--config/--auth-file 指向临时目录，不碰 3210/真实 config）：
 *   NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *   node settings_probe.js
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
  results.push({ name, pass: !!cond, detail: detail || "" });
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? " :: " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 隔离夹具：临时 cwd / session-dir / config.json / auth.json
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "piwebui-set-"));
const SESS_DIR = path.join(CWD, "sessions");
const CFG = path.join(CWD, "config.json");
const AUTH = path.join(CWD, "auth.json");
fs.mkdirSync(SESS_DIR, { recursive: true });
fs.writeFileSync(AUTH, JSON.stringify({
  minimax: { type: "key", key: "sk-PROBE-SECRET-MUST-NOT-APPEAR" },
  "volcengine-ark": { type: "oauth", key: "oauth-PROBE-SECRET-MUST-NOT-APPEAR" },
}));

const server = spawn(process.execPath,
  [path.join(__dirname, "..", "server.js"), "--port", String(PORT),
   "--cwd", CWD, "--session-dir", SESS_DIR,
   "--config", CFG, "--auth-file", AUTH],
  { stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv:err] ${d}`));
const cleanup = () => {
  try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" }); } catch (e) {}
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch (e) {}
};
process.on("exit", cleanup);

(async () => {
  await waitListen(15000);
  console.log(`临时 server 已监听 ${BASE}（config: ${CFG}）`);

  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/.test(m.text())) errors.push("CONSOLE: " + m.text());
  });

  // WS 出站帧捕获（验证 set_model / set_thinking_level 真的发出）
  await page.addInitScript(() => {
    window.__frames = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      try { window.__frames.push(String(d)); } catch (e) {}
      return orig.call(this, d);
    };
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  // 等 pi 就绪（get_state 回来才有 currentModel）
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await page.evaluate(() => !!(window.__piwebui_settings && window.__piwebui_settings.state().currentModel))) break;
  }

  const isOpen = () => page.evaluate(() => window.__settings_test.isOpen());
  const modelOptions = () => page.evaluate(() => window.__settings_test.modelOptions());
  const selectedModel = () => page.evaluate(() => window.__settings_test.selectedModel());
  const levelButtons = () => page.evaluate(() => window.__settings_test.levelButtons());
  const onLevel = () => page.evaluate(() => window.__settings_test.onLevel());
  const clickLevel = (lv) => page.evaluate((lv) => window.__settings_test.clickLevel(lv), lv);
  const detail = () => page.evaluate(() => window.__settings_test.detail());
  const authRows = () => page.evaluate(() => window.__settings_test.authRows());
  const panelText = () => page.evaluate(() => window.__settings_test.panelText());
  const saveAsDefault = () => page.evaluate(() => window.__settings_test.saveAsDefault());
  const statusText = () => page.evaluate(() => window.__settings_test.statusText());
  const frames = () => page.evaluate(() => window.__frames || []);
  const clearFrames = () => page.evaluate(() => { window.__frames = []; });
  const hasFrame = (substr) => frames().then((f) => f.some((x) => x.includes(substr)));

  // ---------- PHASE 1 ----------
  console.log("=== PHASE 1: 面板打开 + 模型分组 + 当前预选 ===");
  const btnExists = await page.evaluate(() => !!document.getElementById("btn-settings"));
  check("⚙ 按钮存在", btnExists);
  await page.click("#btn-settings");
  await sleep(500);
  check("面板打开", await isOpen());
  const groups = await modelOptions();
  check("模型按 provider 分组", groups.length >= 1, JSON.stringify(groups));
  const selected = await selectedModel();
  const curModel = await page.evaluate(() => window.__piwebui_settings.state().currentModel);
  check("当前模型预选", curModel && selected === `${curModel.provider}/${curModel.id}`, `selected=${selected}`);
  check("模型详情行有内容", (await detail()).length > 0, await detail());

  // ---------- PHASE 2 ----------
  console.log("=== PHASE 2: 思维级别列表 + 当前标记 ===");
  const levels = await levelButtons();
  check("级别列表非空", levels.length >= 1, JSON.stringify(levels));
  const onLv = await onLevel();
  const stLevel = await page.evaluate(() => window.__piwebui_settings.state().thinkingLevel);
  check("当前级别有标记", onLv !== null, `on=${onLv}, get_state.thinkingLevel=${stLevel}`);
  if (stLevel) check("标记与 get_state 一致", onLv === stLevel, `${onLv} vs ${stLevel}`);

  // ---------- PHASE 3 ----------
  console.log("=== PHASE 3: 切思维级别热生效 ===");
  await clearFrames();
  const target = levels.includes("high") ? "high" : levels[levels.length - 1];
  const clicked = await clickLevel(target);
  check(`点击级别 ${target}`, clicked);
  await sleep(800);
  check("set_thinking_level 帧已发出", await hasFrame(`"type":"set_thinking_level"`));
  // 等 get_state 权威回读
  let authLevel = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    authLevel = await page.evaluate(() => window.__piwebui_settings.state().thinkingLevel);
    if (authLevel === target) break;
  }
  check("get_state 回读级别=目标", authLevel === target, `权威值=${authLevel}, 目标=${target}`);
  check("面板 on 标记跟随权威值", await onLevel() === target);

  // ---------- PHASE 4 ----------
  console.log("=== PHASE 4: 切模型热生效 ===");
  const optCount = await page.evaluate(() => document.querySelectorAll("#set-model option").length);
  if (optCount >= 2) {
    await clearFrames();
    // 选一个非当前模型
    const newVal = await page.evaluate(() => {
      const sel = document.getElementById("set-model");
      const cur = window.__piwebui_settings.state().currentModel;
      const opt = [...sel.options].find((o) => o.value !== `${cur.provider}/${cur.id}`);
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change"));
      return opt.value;
    });
    await sleep(800);
    check("set_model 帧已发出", await hasFrame(`"type":"set_model"`), `目标=${newVal}`);
    let applied = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      applied = await page.evaluate(() => {
        const m = window.__piwebui_settings.state().currentModel;
        return m ? `${m.provider}/${m.id}` : null;
      });
      if (applied === newVal) break;
    }
    check("模型切换生效（state 回读）", applied === newVal, `权威值=${applied}, 目标=${newVal}`);
    check("详情行随模型更新", (await detail()).length > 0, await detail());
  } else {
    console.log("  · SKIP 切模型 :: 实例只有 1 个可选模型");
  }

  // ---------- PHASE 5 ----------
  console.log("=== PHASE 5: 保存为默认 → config.json 落盘 ===");
  await saveAsDefault();
  let saved = false;
  for (let i = 0; i < 10; i++) { await sleep(400); if (fs.existsSync(CFG)) { saved = true; break; } }
  check("config.json 已写入", saved, CFG);
  if (saved) {
    const j = JSON.parse(fs.readFileSync(CFG, "utf8"));
    check("config.json 含 model", !!(j.model && j.model.provider && j.model.id), JSON.stringify(j.model || null));
    check("config.json 含 thinkingLevel", typeof j.thinkingLevel === "string", j.thinkingLevel);
    check("无未知键落盘", Object.keys(j).every((k) => ["model", "thinkingLevel"].includes(k)), Object.keys(j).join(","));
  }
  check("面板显示保存成功", /已保存/.test(await statusText()), await statusText());
  // POST 校验：未知键必须 400
  const bad = await page.evaluate(async () => {
    const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hack: 1 }) });
    return r.status;
  });
  check("未知设置键 → 400（schema strict）", bad === 400, `HTTP ${bad}`);

  // ---------- PHASE 6 ----------
  console.log("=== PHASE 6: 登录凭据只读（无密钥泄漏） ===");
  const rows = await authRows();
  check("凭据行=fixture 的 2 个 provider", rows.length === 2, JSON.stringify(rows));
  check("显示凭据类型", rows.some((r) => r.type === "API Key") && rows.some((r) => r.type === "OAuth 已登录"), JSON.stringify(rows));
  const pText = await panelText();
  check("密钥材料不出现在面板", !pText.includes("PROBE-SECRET"), pText.slice(0, 60));
  const apiAuth = await page.evaluate(async () => (await (await fetch("/api/settings")).json()).auth);
  check("GET /api/settings 不含 key 字段", apiAuth.every((a) => !("key" in a) && !("token" in a)), JSON.stringify(apiAuth));

  // ---------- PHASE 7 ----------
  console.log("=== PHASE 7: fail-open（/api/settings 404 → 面板降级可用） ===");
  await page.route("**/api/settings", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.click("#btn-settings");
  await sleep(400);
  check("降级提示出现", /不支持|旧版/.test(await panelText()));
  await clearFrames();
  const lvOk = await clickLevel(levels[0]);
  await sleep(500);
  check("降级下热切换仍工作", lvOk && await hasFrame(`"type":"set_thinking_level"`));

  check("全程无 JS 错误", errors.filter((e) => !/Failed to load resource.*(400|404)/.test(e)).length === 0,
    errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) { console.log("失败项:", failed.map((f) => f.name).join(", ")); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("探针崩溃:", e); cleanup(); process.exit(2); });
