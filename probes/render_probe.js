const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const frames = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      try { const o = JSON.parse(f.payload || f.text || "{}");
        if (o.type === "pi_record") {
          const r = o.record || {};
          if (r.type === "response") frames.push(`RESP cmd=${r.command} success=${r.success}`);
          else frames.push(`EVT ${r.type}`);
        }
      } catch(e){}
    });
    ws.on("framesent", (f) => { try { const o = JSON.parse(f.payload||f.text||"{}"); if(o.type==="rpc") frames.push(`SEND ${o.command.type}`); } catch(e){} });
  });
  page.on("pageerror", (e) => frames.push("PAGEERROR: " + e.message));

  await page.goto("http://localhost:3211/", { waitUntil: "networkidle" });
  await page.waitForSelector(".session-item", { timeout: 20000 });

  console.log("=== PHASE 0: 刷新后自动加载（bug 1 修复验证）===");
  // 轮询等待自动 get_messages 渲染出内容（冷启动 ~10s + 加载）
  let ok = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const n = await page.evaluate(() => document.querySelectorAll("#messages .msg, #messages .tool-result, #messages .history-note").length);
    if (n > 10) { ok = true; console.log(`  ${i+1}s 后渲染出 ${n} 个消息节点 ✓`); break; }
  }
  if (!ok) {
    const hint = await page.evaluate(() => (document.querySelector("#messages")||{}).textContent.slice(0,100));
    console.log("  ✗ 自动加载失败，#messages 内容:", hint);
  }

  const dump = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("#messages > *").forEach((el) => {
      const cs = getComputedStyle(el);
      out.push({ cls: el.className || "(none)", align: cs.alignSelf,
        txt: (el.textContent || "").replace(/\s+/g, " ").slice(0, 60) });
    });
    return out;
  });
  console.log(`\n=== 渲染结果总览（共 ${dump.length} 个子节点）===`);
  dump.slice(0, 6).forEach((d, i) => console.log(`#${i} [${d.cls}] align=${d.align} :: ${d.txt}`));
  console.log("...");
  const tally = {};
  dump.forEach(d => { const k = d.cls.split(" ").slice(0,2).join("."); tally[k] = (tally[k] || 0) + 1; });
  console.log("TALLY:", JSON.stringify(tally, null, 0));

  console.log("\n=== 断言 ===");
  const checks = await page.evaluate(() => {
    const r = {};
    const users = [...document.querySelectorAll("#messages .msg.user")];
    r.userCount = users.length;
    r.firstUserText = users.length ? users[0].textContent.replace(/\s+/g," ").trim().slice(0, 60) : null;
    r.emptyUserBubbles = users.filter(u => !u.textContent.trim() && !u.querySelector("img")).length;
    const notes = [...document.querySelectorAll("#messages .history-note")];
    r.noteCount = notes.length;
    r.noteTexts = notes.map(n => n.textContent.replace(/\s+/g," ").slice(0, 40));
    r.userAlign = users.length ? getComputedStyle(users[0]).alignSelf : null;
    const asst = document.querySelector("#messages .msg.assistant");
    r.assistantAlign = asst ? getComputedStyle(asst).alignSelf : null;
    r.emptyHintGone = !document.querySelector("#messages .empty-hint");
    return r;
  });
  console.log(JSON.stringify(checks, null, 2));
  const pass1 = checks.userCount === 1 && /刷新页面/.test(checks.firstUserText || "");
  const pass2 = checks.emptyUserBubbles === 0 && checks.noteCount >= 2;
  const pass3 = checks.userAlign === "flex-end" && checks.assistantAlign === "flex-start";
  console.log(`bug1(自动加载): ${ok ? "PASS" : "FAIL"} | bug2(无错位用户泡/注记存在): ${pass1 && pass2 ? "PASS" : "FAIL"} | 对齐: ${pass3 ? "PASS" : "FAIL"}`);

  console.log("\n=== PHASE 1: 点击当前会话（快路径 get_messages）===");
  const before = await page.evaluate(() => document.querySelectorAll("#messages > *").length);
  await (await page.$(".session-item")).click();
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => document.querySelectorAll("#messages > *").length);
  console.log(`点击前后子节点数: ${before} -> ${after} ${after > 10 ? "PASS" : "FAIL"}`);

  console.log("\n=== PHASE 2: 合成图片用户消息渲染（bug 3 单测）===");
  const imgTest = await page.evaluate(() => {
    // 1x1 红色 PNG
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const el = document.getElementById("messages");
    el.innerHTML = "";
    renderHistoryUser({ role: "user", content: [
      { type: "text", text: "看看这张图" },
      { type: "image", data: b64, mimeType: "image/png" },
    ]});
    const img = el.querySelector("img.msg-image");
    const txt = el.querySelector(".msg.user");
    return {
      hasImg: !!img,
      srcOk: img ? img.src.startsWith("data:image/png;base64,iVBOR") : false,
      textOk: txt ? txt.textContent.includes("看看这张图") : false,
      align: txt ? getComputedStyle(txt).alignSelf : null,
    };
  });
  console.log(JSON.stringify(imgTest));
  const imgPass = imgTest.hasImg && imgTest.srcOk && imgTest.textOk && imgTest.align === "flex-end";
  console.log(`图片用户消息: ${imgPass ? "PASS" : "FAIL"}`);

  console.log("\n=== WS FRAMES（前 25 条）===");
  frames.slice(0, 25).forEach(f => console.log(f));
  await browser.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
