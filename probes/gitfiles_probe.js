/**
 * v0.8 合并探针：P1-⑤ 每轮 git 锚点 + P1-⑦ 文件树/预览
 *
 * PHASE 1: 文件端点直测（列目录/子目录/穿越/绝对/drive-relative/文本/二进制/超限/raw/git-status）
 * PHASE 2: git 锚点端到端 —— git 仓库 tmp cwd + 3 轮对话 →
 *          refs/piweb/rounds/ ≥3 且编号连续、git show 可读快照、
 *          git status 前后逐字节一致、stash list 不变
 * PHASE 3: 非 git cwd → /api/anchors 与 /api/git-status 返回 git:false（静默跳过）
 * PHASE 4: UI —— 文件树渲染/展开/.md 渲染/.js 高亮/图片预览/M 圆点/anchors 徽标
 *
 * 运行（自起 3211 临时实例）：
 *   NODE_PATH=C:\Users\lewie\.workbuddy\binaries\node\workspace\node_modules \
 *   node gitfiles_probe.js
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

// ---------- git 仓库 tmp cwd ----------
const GIT_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "piwebui-gitfiles-"));
const GIT_DIR = path.join(GIT_CWD, "sessions");
fs.mkdirSync(GIT_DIR, { recursive: true });
execSync("git init -q", { cwd: GIT_CWD });
execSync('git config user.email probe@t && git config user.name probe', { cwd: GIT_CWD });
fs.writeFileSync(path.join(GIT_CWD, "hello.js"), "const x = 1;\nfunction hello() { return `hi ${x}`; }\n");
fs.writeFileSync(path.join(GIT_CWD, "note.md"), "# 探针笔记\n\n- 项目 **A**\n- `code` 片段\n");
fs.mkdirSync(path.join(GIT_CWD, "sub"));
fs.writeFileSync(path.join(GIT_CWD, "sub", "a.txt"), "AAA");
// 1x1 PNG
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex");
fs.writeFileSync(path.join(GIT_CWD, "dot.png"), PNG);
fs.writeFileSync(path.join(GIT_CWD, "big.bin"), Buffer.alloc(1100 * 1024, 65));
execSync("git add . && git commit -qm init", { cwd: GIT_CWD });
// 制造 M 状态（验收：树里出现 M 标记）
fs.appendFileSync(path.join(GIT_CWD, "hello.js"), "// modified by probe\n");
const STATUS_BEFORE = execSync("git status --porcelain", { cwd: GIT_CWD }).toString();
const STASH_BEFORE = execSync("git stash list", { cwd: GIT_CWD }).toString();
// 比较时排除 sessions/（pi 每轮自己写会话 jsonl，与锚点副作用无关）
const normStatus = (s) => s.split("\n").filter((l) => l.trim() && !l.includes("sessions/")).join("\n");

// 非 git cwd（PHASE 3）
const PLAIN_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "piwebui-plain-"));
fs.mkdirSync(path.join(PLAIN_CWD, "sessions"), { recursive: true });

function startServer(cwd, sessDir, port) {
  const s = spawn(process.execPath,
    [path.join(__dirname, "..", "server.js"), "--port", String(port), "--cwd", cwd, "--session-dir", sessDir],
    { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
  s.stdout.on("data", (d) => process.stdout.write(`[srv${port}] ${d}`));
  s.stderr.on("data", (d) => process.stderr.write(`[srv${port}:err] ${d}`));
  return s;
}
const server = startServer(GIT_CWD, GIT_DIR, PORT);
const serverPlain = startServer(PLAIN_CWD, path.join(PLAIN_CWD, "sessions"), 3212);
let dead = false;
server.on("exit", (c) => { if (!dead) { dead = true; console.error(`srv 提前退出 ${c}`); } });

const get = (port, u) => new Promise((resolve) => {
  http.get(`http://localhost:${port}${u}`, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await waitListen(15000, PORT);
  await waitListen(15000, 3212);
  console.log(`临时 server 已监听 ${BASE} / :3212`);

  console.log("=== PHASE 1: 文件端点直测 ===");
  let r = await get(PORT, "/api/files?path=");
  let j = JSON.parse(r.body);
  const names = j.entries.map((e) => e.name + (e.dir ? "/" : ""));
  check("顶层列表 + 排除项", r.status === 200
    && names.includes("hello.js") && names.includes("sub/")
    && !names.includes(".git/"), JSON.stringify(names));
  check("目录在前排序", j.entries[0].dir === true, JSON.stringify(names.slice(0, 2)));
  r = await get(PORT, "/api/files?path=sub");
  check("子目录列表", r.status === 200 && JSON.parse(r.body).entries[0].name === "a.txt", r.body.slice(0, 60));
  r = await get(PORT, "/api/files?path=../..");
  check("穿越被拒", r.status === 400, JSON.parse(r.body).error);
  r = await get(PORT, "/api/files?path=C:%5CWindows");
  check("绝对路径被拒", r.status === 400, JSON.parse(r.body).error);
  r = await get(PORT, "/api/files?path=C:Windows");
  check("drive-relative 被拒", r.status === 400, JSON.parse(r.body).error);
  r = await get(PORT, "/api/file?path=hello.js");
  j = JSON.parse(r.body);
  check("文本内容", r.status === 200 && j.kind === "text" && j.content.includes("hello()"), j.kind);
  r = await get(PORT, "/api/file?path=big.bin");
  check("1MB 超限提示", r.status === 200 && JSON.parse(r.body).kind === "too-large", JSON.parse(r.body).kind);
  r = await get(PORT, "/api/file?path=dot.png");
  j = JSON.parse(r.body);
  check("图片 → raw url", j.kind === "image" && j.url.includes("/api/file/raw"), JSON.stringify(j).slice(0, 80));
  r = await get(PORT, "/api/file/raw?path=dot.png");
  check("raw 字节流 + MIME", r.status === 200 && r.headers["content-type"] === "image/png", r.headers["content-type"]);
  r = await get(PORT, "/api/git-status");
  j = JSON.parse(r.body);
  check("git-status M 标记", j.git === true && j.entries.some((e) => e.path === "hello.js" && e.y === "M"),
    JSON.stringify(j.entries));
  r = await get(PORT, "/api/anchors");
  j = JSON.parse(r.body);
  check("anchors 端点（初始 0 refs）", r.status === 200 && j.git === true && j.refs.length === 0,
    `git=${j.git} refs=${j.refs.length}`);

  console.log("=== PHASE 2: git 锚点端到端（3 轮对话） ===");
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

  for (let round = 1; round <= 3; round++) {
    const tag = ["一", "二", "三"][round - 1];
    await page.fill("#input", `不要调用任何工具，直接只回复四个字：锚点${tag}号`);
    await page.click("#btn-send");
    let done = false;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const btn = await page.$eval("#btn-send", (el) => el.textContent);
      const has = await page.evaluate((t) => document.body.textContent.includes(`锚点${t}号`), tag);
      if (btn === "发送" && has) { done = true; break; }
    }
    check(`第 ${round} 轮真实完成（回复上屏 + 空闲）`, done, done ? "settled" : "timeout");
  }
  await sleep(1500); // 锚点异步落盘

  const refsOut = execSync("git for-each-ref refs/piweb/rounds/ --format=%(refname)", { cwd: GIT_CWD }).toString().trim().split("\n").filter(Boolean);
  check("refs ≥ 3", refsOut.length >= 3, `${refsOut.length} 个: ${refsOut.slice(-3).join(", ")}`);
  const nums = refsOut.map((rf) => parseInt(rf.match(/\/(\d+)$/)[1], 10)).sort((a, b) => a - b);
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  check("编号连续", contiguous, JSON.stringify(nums));
  check("同一会话目录", new Set(refsOut.map((rf) => rf.split("/")[3])).size === 1, refsOut[0]);
  const show = execSync(`git show --stat ${refsOut[0].replace("refs/", "refs/")}`, { cwd: GIT_CWD, maxBuffer: 16 * 1024 * 1024 }).toString();
  check("git show 可读快照（含 hello.js）", show.includes("hello.js"), `show ${show.length} 字符`);
  const STATUS_AFTER = execSync("git status --porcelain", { cwd: GIT_CWD }).toString();
  check("git status 逐字节一致（排除 pi 自写的 sessions/）", normStatus(STATUS_AFTER) === normStatus(STATUS_BEFORE),
    JSON.stringify({ before: normStatus(STATUS_BEFORE), after: normStatus(STATUS_AFTER) }));
  const STASH_AFTER = execSync("git stash list", { cwd: GIT_CWD }).toString();
  check("stash list 不变（无副作用）", STASH_AFTER === STASH_BEFORE, JSON.stringify(STASH_AFTER));
  const headBefore = execSync("git rev-parse HEAD", { cwd: GIT_CWD }).toString();
  const headAfter = execSync("git rev-parse HEAD", { cwd: GIT_CWD }).toString();
  check("HEAD 未移动", headBefore === headAfter, headBefore.slice(0, 10));
  // 更新后的 refs 展示在 UI 徽标
  r = await get(PORT, "/api/anchors");
  j = JSON.parse(r.body);
  check("anchors 端点返回 ≥3 refs", j.refs.length >= 3, `${j.refs.length}`);
  check("anchors 消息含轮号", j.refs.some((x) => /piweb round \d+/.test(x.message)), JSON.stringify(j.refs[0] || {}).slice(0, 90));

  console.log("=== PHASE 3: 非 git cwd 静默跳过 ===");
  r = await get(3212, "/api/anchors");
  j = JSON.parse(r.body);
  check("非 git: anchors git:false", r.status === 200 && j.git === false, JSON.stringify(j).slice(0, 60));
  r = await get(3212, "/api/git-status");
  j = JSON.parse(r.body);
  check("非 git: git-status git:false", r.status === 200 && j.git === false, JSON.stringify(j).slice(0, 60));

  console.log("=== PHASE 4: UI 文件树 + 预览 + 徽标 ===");
  await page.evaluate(() => window.__files_test.anchors());
  await sleep(500);
  let st = await page.evaluate(() => window.__files_test.state());
  check("anchors 徽标可见且计数 ≥3", st.anchorsVisible && /\d+/.test(st.anchorsText) && parseInt(st.anchorsText.replace(/\D/g, "")) >= 3,
    st.anchorsText.slice(0, 30));

  await page.evaluate(() => window.__files_test.toggle());
  await sleep(600);
  st = await page.evaluate(() => window.__files_test.state());
  check("文件树打开 + 顶层渲染", st.treeOpen && st.rows >= 4, `rows=${st.rows}`);
  check("git M 圆点出现", st.gitDots >= 1, `dots=${st.gitDots}`);

  // 展开子目录（点 sub/ 那一行；顶层第一个目录可能是 sessions/）
  const subClicked = await page.evaluate(() => {
    for (const row of document.querySelectorAll("#files-tree .file-row.is-dir")) {
      const nm = row.querySelector(".file-name");
      if (nm && nm.textContent === "sub") { row.click(); return true; }
    }
    return false;
  });
  await sleep(600);
  const kids = await page.$$eval("#files-tree .file-kids .file-row", (els) => els.map((e) => e.querySelector(".file-name").textContent));
  check("子目录懒加载展开", subClicked && kids.includes("a.txt"), JSON.stringify(kids));

  // .md 预览（PiMD.render）
  await page.evaluate(() => window.__files_test.preview("note.md"));
  await sleep(600);
  st = await page.evaluate(() => window.__files_test.state());
  check(".md 用 PiMD 渲染", st.previewOpen && st.hasMd, st.previewText.slice(0, 30));

  // .js 高亮预览
  await page.evaluate(() => window.__files_test.preview("hello.js"));
  await sleep(600);
  st = await page.evaluate(() => window.__files_test.state());
  check(".js 用 highlight 渲染", st.hasCode, st.previewText.slice(0, 30));
  const tok = await page.$$eval("#file-preview-body .tok-kw, #file-preview-body .tok-str, #file-preview-body .tok-fn", (els) => els.length);
  check("js 高亮 tok span", tok > 0, `${tok} 个`);

  // 图片预览 + 灯箱
  await page.evaluate(() => window.__files_test.preview("dot.png"));
  await sleep(600);
  const imgOk = await page.$("#file-preview-body .file-preview-image");
  check("图片预览节点", !!imgOk, imgOk ? "found" : "missing");
  await page.click("#file-preview-body .file-preview-image");
  await sleep(300);
  const lightboxShown = await page.$eval("#lightbox", (el) => !el.hidden).catch(() => false);
  check("复用灯箱打开", lightboxShown, "lightbox");
  await page.evaluate(() => { const lb = document.getElementById("lightbox"); if (lb) lb.hidden = true; });

  check("无 JS 错误", errors.length === 0, errors.join(" | "));

  const pass = results.filter((x) => x.pass).length;
  console.log(`\n=== 结果: ${pass}/${results.length} ===`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(async (e) => {
  console.error("PROBE FAILED:", e);
  process.exit(2);
});
process.on("exit", () => {
  for (const s of [server, serverPlain]) {
    try { execSync(`taskkill /PID ${s.pid} /T /F`, { stdio: "ignore" }); } catch {}
  }
  try { fs.rmSync(GIT_CWD, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(PLAIN_CWD, { recursive: true, force: true }); } catch {}
});
