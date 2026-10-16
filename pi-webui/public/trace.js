/**
 * v0.7 轨迹审计面板（P1-④）
 *
 * 数据：GET /api/sessions/trace?file=<name>（server 只读解析 JSONL）
 * UI：右侧滑入面板；过滤 chips（全部/user/assistant/tool/system）+
 *     关键词实时搜索（匹配 summary + raw 全文）；点击行展开完整 JSON
 *     （PiMD.highlight 复用，lang=json）；分页每页 200 条防卡死。
 * 只读：面板内无任何写操作。
 *
 * 依赖：全局 PiMD（markdown.js）、window.__piwebui_state.getSessionPath()（app.js 提供）
 */
(function () {
  "use strict";

  const PAGE_SIZE = 200;
  let allEvents = [];        // [{n, ts, type, role, label, summary, raw}]
  let filtered = [];         // 过滤+搜索后的子集
  let shownCount = 0;        // 已渲染条数（分页游标）
  let curFilter = "all";     // all | user | assistant | tool | system
  let curQuery = "";
  let expanded = new Set();  // 展开的行号集合
  let loading = false;

  // ---------- 骨架（首次打开时注入） ----------
  function ensureDom() {
    if (document.getElementById("trace-panel")) return;
    const wrap = document.createElement("div");
    wrap.id = "trace-panel";
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="trace-head">
        <div class="trace-title">≡ 轨迹 <span id="trace-file" class="trace-file"></span></div>
        <button id="trace-close" class="trace-close" title="关闭">×</button>
      </div>
      <div class="trace-tools">
        <div class="trace-chips" id="trace-chips">
          <button class="trace-chip active" data-f="all">全部</button>
          <button class="trace-chip" data-f="user">user</button>
          <button class="trace-chip" data-f="assistant">assistant</button>
          <button class="trace-chip" data-f="tool">tool</button>
          <button class="trace-chip" data-f="system">system</button>
        </div>
        <input id="trace-search" class="trace-search" type="text" placeholder="搜索事件全文…" />
      </div>
      <div class="trace-meta" id="trace-meta"></div>
      <div class="trace-list" id="trace-list"></div>
      <div class="trace-more"><button id="trace-more-btn" class="trace-more-btn" hidden>加载更多</button></div>`;
    document.body.appendChild(wrap);

    document.getElementById("trace-close").addEventListener("click", close);
    document.getElementById("trace-chips").addEventListener("click", (e) => {
      const btn = e.target.closest(".trace-chip");
      if (!btn) return;
      curFilter = btn.dataset.f;
      for (const c of document.querySelectorAll("#trace-chips .trace-chip")) {
        c.classList.toggle("active", c === btn);
      }
      applyFilter();
    });
    document.getElementById("trace-search").addEventListener("input", (e) => {
      curQuery = e.target.value.trim().toLowerCase();
      applyFilter();
    });
    document.getElementById("trace-more-btn").addEventListener("click", () => renderMore());
    // 事件委托：点击行展开/收起
    document.getElementById("trace-list").addEventListener("click", (e) => {
      const row = e.target.closest(".trace-row");
      if (!row) return;
      const n = Number(row.dataset.n);
      if (expanded.has(n)) {
        expanded.delete(n);
        row.classList.remove("expanded");
        const body = row.querySelector(".trace-raw");
        if (body) body.remove();
      } else {
        expanded.add(n);
        const ev = allEvents[n];
        if (!ev) return;
        row.classList.add("expanded");
        const pre = document.createElement("pre");
        pre.className = "trace-raw";
        const code = document.createElement("code");
        // PiMD.highlight 输出已 escapeHtml，安全
        code.innerHTML = (window.PiMD && window.PiMD.highlight) ? PiMD.highlight(ev.raw, "json") : escapeHtml(ev.raw);
        pre.appendChild(code);
        row.appendChild(pre);
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- 数据加载 ----------
  async function open() {
    ensureDom();
    const panel = document.getElementById("trace-panel");
    panel.hidden = false;
    const path = window.__piwebui_state && window.__piwebui_state.getSessionPath();
    if (!path) {
      setMeta("当前会话尚未保存到磁盘（发一条消息后再试）");
      return;
    }
    const file = path.split(/[\\/]/).pop();
    document.getElementById("trace-file").textContent = file;
    loading = true;
    setMeta("加载中…");
    try {
      const res = await fetch("/api/sessions/trace?file=" + encodeURIComponent(file));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      allEvents = data.events || [];
      expanded = new Set();
      loading = false;
      applyFilter();
    } catch (e) {
      loading = false;
      setMeta(`加载失败: ${e.message}（若刚更新 server.js，需在无任务窗口重启后生效）`);
    }
  }

  function close() {
    const panel = document.getElementById("trace-panel");
    if (panel) panel.hidden = true;
  }

  // ---------- 过滤 / 搜索 / 渲染 ----------
  function applyFilter() {
    const q = curQuery;
    filtered = allEvents.filter((ev) => {
      if (curFilter !== "all" && ev.role !== curFilter) return false;
      if (q && !(ev.summary.toLowerCase().includes(q) || ev.raw.toLowerCase().includes(q))) return false;
      return true;
    });
    shownCount = 0;
    const list = document.getElementById("trace-list");
    list.innerHTML = "";
    renderMore();
  }

  function fmtTime(ts) {
    if (!ts) return "--:--:--";
    const d = new Date(ts);
    if (isNaN(d)) return "--:--:--";
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function renderMore() {
    if (loading) return;
    const list = document.getElementById("trace-list");
    const frag = document.createDocumentFragment();
    const end = Math.min(shownCount + PAGE_SIZE, filtered.length);
    for (let i = shownCount; i < end; i++) {
      const ev = filtered[i];
      const row = document.createElement("div");
      row.className = "trace-row role-" + ev.role;
      row.dataset.n = ev.n;
      const head = document.createElement("div");
      head.className = "trace-row-head";
      const idx = document.createElement("span");
      idx.className = "trace-idx";
      idx.textContent = ev.n;
      const time = document.createElement("span");
      time.className = "trace-time";
      time.textContent = fmtTime(ev.ts);
      const badge = document.createElement("span");
      badge.className = "trace-badge b-" + ev.role;
      badge.textContent = ev.label || ev.role;
      const summ = document.createElement("span");
      summ.className = "trace-summary";
      summ.textContent = ev.summary || "(空)";
      summ.title = ev.summary || "";
      head.appendChild(idx);
      head.appendChild(time);
      head.appendChild(badge);
      head.appendChild(summ);
      row.appendChild(head);
      frag.appendChild(row);
    }
    list.appendChild(frag);
    shownCount = end;
    const moreBtn = document.getElementById("trace-more-btn");
    moreBtn.hidden = shownCount >= filtered.length;
    setMeta(`${filtered.length} 事件（显示 ${shownCount}）· 会话共 ${allEvents.length}`);
  }

  function setMeta(text) {
    const el = document.getElementById("trace-meta");
    if (el) el.textContent = text;
  }

  // ---------- 对外接口 ----------
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("btn-trace");
    if (btn) btn.addEventListener("click", open);
    // Esc 关闭（面板可能从未打开——DOM 尚未创建时必须空保护）
    document.addEventListener("keydown", (e) => {
      const panel = document.getElementById("trace-panel");
      if (e.key === "Escape" && panel && !panel.hidden) close();
    });
  });

  // 探针钩子 + 状态读取（独立命名空间：trace.js 先于 app.js 加载，
  // 若挂 __piwebui_test 会被 app.js 的对象字面量整体覆盖）
  window.__trace_test = {
    /** 直接用合成事件渲染（跳过 fetch，探针确定性用） */
    render: (events) => {
      ensureDom();
      document.getElementById("trace-panel").hidden = false;
      allEvents = events || [];
      expanded = new Set();
      curFilter = "all";
      curQuery = "";
      const s = document.getElementById("trace-search");
      if (s) s.value = "";
      for (const c of document.querySelectorAll("#trace-chips .trace-chip")) {
        c.classList.toggle("active", c.dataset.f === "all");
      }
      applyFilter();
    },
    state: () => ({
      open: !document.getElementById("trace-panel").hidden,
      filter: curFilter,
      query: curQuery,
      total: allEvents.length,
      visible: filtered.length,
      shown: shownCount,
      expandedCount: expanded.size,
    }),
  };
  window.__piwebui_trace = { open, close };
})();
