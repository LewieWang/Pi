/**
 * v0.10 P2-⑪ 设置面板
 *
 * 面板内容（协议真实支持，不硬造）：
 *  - 模型：provider 分组 select（复用 get_available_models），热切换（set_model）
 *  - 思维级别：当前模型支持的级别（get_available_thinking_levels），热切换（set_thinking_level）
 *  - 登录凭据（只读）：/api/settings 的 auth 摘要（仅 provider + type，无密钥）
 *  - 保存为默认：POST /api/settings → server 端 config.json（新 spawn 进程 / 下次启动读取）
 *
 * fail-open：旧 server 无 /api/settings 时面板照常工作，持久化区显示升级提示。
 * 测试钩子：window.__settings_test
 */
(function () {
  "use strict";

  const OVERLAY_ID = "settings-overlay";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /** 拉取 server 设置 + 凭据摘要；旧 server 返回 null（fail-open） */
  async function fetchServerSettings() {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  /** 保存默认设置；返回 {ok, error?} */
  async function postServerSettings(body) {
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j.error || `HTTP ${r.status}` };
      return { ok: true, settings: j.settings };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function fmtWindow(n) {
    if (!n && n !== 0) return "?";
    return n >= 1000 ? Math.round(n / 1000) + "K" : String(n);
  }

  function modelDetailLine(m) {
    if (!m) return "";
    const bits = [];
    bits.push(`上下文 ${fmtWindow(m.contextWindow)}`);
    if (m.maxTokens) bits.push(`最大输出 ${fmtWindow(m.maxTokens)}`);
    if (Array.isArray(m.input)) {
      const caps = [];
      if (m.input.includes("image")) caps.push("视觉");
      if (m.reasoning) caps.push("推理");
      if (caps.length) bits.push(caps.join(" · "));
    }
    if (m.cost && typeof m.cost === "object") {
      bits.push(`$${m.cost.input ?? "?"}/$${m.cost.output ?? "?"} per Mtok`);
    }
    return bits.join(" · ");
  }

  function buildOverlay() {
    if ($(OVERLAY_ID)) return;
    const ov = document.createElement("div");
    ov.id = OVERLAY_ID;
    ov.hidden = true;
    ov.innerHTML = `
      <div class="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
        <div class="settings-head">
          <span>⚙ 设置</span>
          <button class="settings-close" title="关闭 (Esc)">×</button>
        </div>
        <div class="settings-body">
          <div class="settings-section">
            <div class="settings-label">模型 <span class="settings-current" id="set-cur-model"></span></div>
            <select id="set-model"></select>
            <div class="settings-detail" id="set-model-detail"></div>
          </div>
          <div class="settings-section">
            <div class="settings-label">思维级别 <span class="settings-current" id="set-cur-level"></span></div>
            <div class="settings-seg" id="set-levels"></div>
          </div>
          <div class="settings-section">
            <div class="settings-label">登录凭据 <span class="settings-current">只读，不含密钥</span></div>
            <div class="settings-auth" id="set-auth"></div>
          </div>
          <div class="settings-section">
            <button id="set-save" class="settings-save">保存为默认（新会话 / 下次启动生效）</button>
            <div class="settings-status" id="set-status"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector(".settings-close").addEventListener("click", close);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !ov.hidden) close();
    });
  }

  let pendingLevel = null; // 面板里点选但未确认生效的级别（等待 get_state 回读）

  function renderLevels(levels, current) {
    const box = $("set-levels");
    const cur = pendingLevel || current || "off";
    $("set-cur-level").textContent = `当前：${current ?? "?"}`;
    box.innerHTML = "";
    if (!levels || !levels.length) {
      box.innerHTML = `<span class="settings-muted">当前模型不支持思维级别或尚未取得列表</span>`;
      return;
    }
    for (const lv of levels) {
      const b = document.createElement("button");
      b.className = "seg-btn" + (lv === cur ? " on" : "");
      b.textContent = lv;
      b.onclick = () => applyThinkingLevel(lv);
      box.appendChild(b);
    }
  }

  function applyThinkingLevel(lv) {
    const S = window.__piwebui_settings;
    pendingLevel = lv;
    S.rpc({ type: "set_thinking_level", level: lv });
    // 立即给可见反馈；权威值由 set_thinking_level 响应触发 get_state 回读刷新
    renderLevels(window.__thinkingLevelsCache || null, lv);
    status(`已发送 set_thinking_level: ${lv}`);
  }

  function renderModels(models, current) {
    const sel = $("set-model");
    $("set-cur-model").textContent = `当前：${current ? `${current.provider}/${current.id}` : "?"}`;
    sel.innerHTML = "";
    // provider 分组（optgroup）
    const groups = new Map();
    for (const m of models) {
      const p = m.provider || "(未知 provider)";
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(m);
    }
    for (const [p, list] of groups) {
      const og = document.createElement("optgroup");
      og.label = p;
      for (const m of list) {
        const opt = document.createElement("option");
        opt.value = `${m.provider}/${m.id}`;
        opt.textContent = m.name || m.id;
        if (current && m.provider === current.provider && m.id === current.id) opt.selected = true;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    updateModelDetail();
    sel.onchange = () => {
      const v = sel.value.split("/");
      const provider = v.shift();
      const id = v.join("/");
      // 注意：RPC 请求字段是 modelId（响应里的 Model 对象才是 id）
      window.__piwebui_settings.rpc({ type: "set_model", provider, modelId: id });
      status(`已发送 set_model: ${provider}/${id}`);
    };
  }

  function updateModelDetail() {
    const S = window.__piwebui_settings;
    const st = S.state();
    const v = $("set-model").value || "";
    const m = st.models.find((x) => `${x.provider}/${x.id}` === v);
    $("set-model-detail").textContent = modelDetailLine(m);
  }

  function renderAuth(auth) {
    const box = $("set-auth");
    if (auth == null) {
      box.innerHTML = `<span class="settings-muted">⚠ 当前 server 不支持 /api/settings（旧版桥）——持久化需重启 server；模型/思维级别热切换不受影响</span>`;
      return;
    }
    if (!auth.length) {
      box.innerHTML = `<span class="settings-muted">未发现已保存凭据（~/.pi/agent/auth.json）</span>`;
      return;
    }
    box.innerHTML = auth.map((a) => {
      const typeText = a.type === "oauth" ? "OAuth 已登录" : a.type === "key" ? "API Key" : esc(a.type);
      return `<div class="auth-row"><span class="auth-provider">${esc(a.provider)}</span><span class="auth-type">${typeText}</span></div>`;
    }).join("");
  }

  function status(text, isErr) {
    const el = $("set-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("err", !!isErr);
  }

  async function open() {
    buildOverlay();
    const ov = $(OVERLAY_ID);
    ov.hidden = false;
    const S = window.__piwebui_settings;
    const st = S.state();
    renderModels(st.models || [], st.currentModel);
    renderAuth(null); // 先占位，fetch 回来再填
    status("");
    // 当前模型支持的思维级别（异步回填）
    S.onThinkingLevels((levels) => {
      window.__thinkingLevelsCache = levels;
      renderLevels(levels, S.state().thinkingLevel);
    });
    // get_state 权威回读：set_thinking_level 成功后把「当前」对齐到服务端真值
    S.onState((lvl) => {
      if (!$(OVERLAY_ID) || $(OVERLAY_ID).hidden) return;
      pendingLevel = null;
      renderLevels(window.__thinkingLevelsCache || null, lvl);
    });
    S.requestThinkingLevels();
    renderLevels(window.__thinkingLevelsCache || null, st.thinkingLevel);
    // server 端设置 + 凭据
    const srv = await fetchServerSettings();
    window.__settings_test = window.__settings_test || {};
    window.__settings_test.serverSettings = srv;
    renderAuth(srv ? srv.auth : null);
    // 保存为默认
    $("set-save").onclick = async () => {
      const cur = S.state();
      const body = {};
      if (cur.currentModel) body.model = { provider: cur.currentModel.provider, id: cur.currentModel.id };
      const lvl = $("set-levels").querySelector(".seg-btn.on");
      if (lvl) body.thinkingLevel = lvl.textContent;
      const r = await postServerSettings(body);
      if (r.ok) status(`✓ 已保存到 server 端 config.json（新 spawn 进程生效）`);
      else status(`✗ 保存失败：${r.error}`, true);
    };
  }

  function close() {
    const ov = $(OVERLAY_ID);
    if (ov) ov.hidden = true;
    pendingLevel = null;
  }

  // 初始化：绑定按钮（settings.js 在 app.js 之后加载，DOM 就绪）
  document.addEventListener("DOMContentLoaded", () => {
    const btn = $("btn-settings");
    if (btn) btn.addEventListener("click", open);
  });

  // 测试钩子
  window.__settings_test = {
    open,
    close,
    isOpen: () => { const ov = $(OVERLAY_ID); return !!ov && !ov.hidden; },
    modelOptions: () => [...document.querySelectorAll("#set-model optgroup")].map((g) => ({
      provider: g.label, count: g.children.length,
    })),
    selectedModel: () => $("set-model") ? $("set-model").value : null,
    levelButtons: () => [...document.querySelectorAll("#set-levels .seg-btn")].map((b) => b.textContent),
    onLevel: () => { const b = document.querySelector("#set-levels .seg-btn.on"); return b ? b.textContent : null; },
    clickLevel: (lv) => { const b = [...document.querySelectorAll("#set-levels .seg-btn")].find((x) => x.textContent === lv); if (b) b.click(); return !!b; },
    detail: () => ($("set-model-detail") || {}).textContent || "",
    authRows: () => [...document.querySelectorAll("#set-auth .auth-row")].map((r) => ({
      provider: r.querySelector(".auth-provider")?.textContent,
      type: r.querySelector(".auth-type")?.textContent,
    })),
    panelText: () => ($("set-auth") || {}).textContent || "",
    saveAsDefault: () => { const b = $("set-save"); if (b) b.click(); },
    statusText: () => ($("set-status") || {}).textContent || "",
    serverSettings: null,
  };
})();
