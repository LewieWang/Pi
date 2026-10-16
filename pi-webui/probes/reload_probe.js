/**
 * v0.9.1 探针：刷新页面后自动恢复当前会话历史（adopt 真实会话 key）
 * 非 ephemeral（带 --session-dir），镜像 3210 正式实例形态。
 */
const { chromium } = require("playwright-core");
const { spawn, execSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs"); const os = require("os");
const PORT = 3216, BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? " :: " + detail : ""}`);
}
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "piwebui-rel-"));
const SESS_DIR = path.join(CWD, "sessions");
fs.mkdirSync(SESS_DIR, { recursive: true });
const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), "--port", String(PORT), "--cwd", CWD, "--session-dir", SESS_DIR], { stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", () => {});
server.stderr.on("data", () => {});
process.on("exit", () => { try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" }); } catch (e) {} try { fs.rmSync(CWD, { recursive: true, force: true }); } catch (e) {} });
(async () => {
  for (let i = 0; i < 50; i++) { const up = await new Promise(r => { const c = http.get(BASE + "/", (x) => { x.resume(); r(true); }); c.on("error", () => r(false)); }); if (up) break; await sleep(300); }
  const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  const errors = [];
  p.on("pageerror", e => errors.push(e.message));
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.fill("#input", "只回复两个字：好的");
  await p.click("#btn-send");
  let settled = false;
  for (let i = 0; i < 180; i++) { await sleep(1000); if (await p.evaluate(() => !!document.querySelector("#messages .token-note"))) { settled = true; break; } }
  check("首轮结算", settled);
  await p.reload({ waitUntil: "networkidle" });
  let msgs = 0, activeKey = "";
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await p.evaluate(() => ({
      msgs: document.querySelectorAll("#messages .msg").length,
      hint: !!document.querySelector("#messages .empty-hint"),
    }));
    msgs = st.msgs;
    if (msgs >= 2 && !st.hint) break;
  }
  check("刷新后历史自动恢复（无 empty-hint）", msgs >= 2, `${msgs} 个消息节点`);
  // 再刷新一次验证幂等
  await p.reload({ waitUntil: "networkidle" });
  let msgs2 = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    msgs2 = await p.evaluate(() => document.querySelectorAll("#messages .msg").length);
    if (msgs2 >= 2) break;
  }
  check("二次刷新仍恢复", msgs2 >= 2, `${msgs2} 个消息节点`);
  check("全程无 JS 错误", errors.length === 0, errors.slice(0, 2).join("|"));
  await b.close();
  const failed = results.filter(r => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) process.exit(1);
  process.exit(0);
})().catch(e => { console.error("探针崩溃:", e); process.exit(2); });
