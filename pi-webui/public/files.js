/**
 * v0.8 文件树 + 预览面板（P1-⑦）
 *
 * 数据（全部只读端点）：
 *   GET /api/files?path=<rel>   列目录（懒加载，排除 .git/node_modules/.pi-uploads）
 *   GET /api/file?path=<rel>    文本（≤1MB）/ 图片占位 / 二进制 / 超限提示
 *   GET /api/file/raw?path=     原始字节（图片走已有灯箱）
 *   GET /api/git-status         porcelain 全量映射（非 git → 不显示圆点）
 *
 * 交互：侧栏「📁 文件」区块 → 树形懒加载；点击 .md → PiMD.render；
 *       图片 → 灯箱；文本/代码 → highlight 预览 + 复制按钮。
 * 依赖：PiMD（markdown.js）、openLightbox（app.js）、$（app.js 全局）
 */
(function () {
  "use strict";

  let gitMap = null; // rel path → "M"/"A"/"??" 等（null=未加载/非 git）

  function ensureDom() {
    if (document.getElementById("files-tree")) return;
    // 注入侧栏区块（正式侧栏 id=sidebar）
    const sidebar = document.getElementById("sidebar") || document.body;
    const sec = document.createElement("div");
    sec.className = "files-section";
    sec.innerHTML = `
      <div class="files-head" id="files-head">📁 文件 <span id="files-git-note" class="files-git-note"></span></div>
      <div id="files-tree" class="files-tree" hidden></div>`;
    sidebar.appendChild(sec);
    document.getElementById("files-head").addEventListener("click", toggleTree);
  }

  async function toggleTree() {
    ensureDom();
    const tree = document.getElementById("files-tree");
    if (!tree.hidden) { tree.hidden = true; return; }
    tree.hidden = false;
    if (!tree.childElementCount) await loadDir("", tree);
    loadGitStatus();
  }

  function relJoin(base, name) {
    return base ? base.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name : name;
  }

  async function loadDir(rel, container) {
    container.innerHTML = '<div class="files-loading">…</div>';
    try {
      const res = await fetch("/api/files?path=" + encodeURIComponent(rel));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      container.innerHTML = "";
      if (!data.entries.length) {
        container.innerHTML = '<div class="files-empty">(空目录)</div>';
        return;
      }
      for (const e of data.entries) {
        container.appendChild(makeNode(relJoin(rel, e.name), e, 0));
      }
    } catch (err) {
      container.innerHTML = `<div class="files-empty">加载失败: ${escapeHtml(String(err.message))}</div>`;
    }
  }

  function makeNode(rel, entry, depth) {
    const row = document.createElement("div");
    row.className = "file-row" + (entry.dir ? " is-dir" : " is-file");
    row.style.paddingLeft = 6 + depth * 14 + "px";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = entry.dir ? "▸" : extIcon(rel);
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = entry.name;
    row.appendChild(icon);
    row.appendChild(name);
    if (gitMap && gitMap.has(rel)) {
      const dot = document.createElement("span");
      const st = gitMap.get(rel);
      dot.className = "file-git-dot" + (st === "??" ? " untracked" : "");
      dot.title = "git: " + st;
      dot.textContent = "●";
      row.appendChild(dot);
    }
    if (entry.dir) {
      const kid = document.createElement("div");
      kid.className = "file-kids";
      kid.hidden = true;
      row.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (kid.hidden) {
          if (!kid.childElementCount) await loadDir(rel, kid);
          kid.hidden = false;
          icon.textContent = "▾";
        } else {
          kid.hidden = true;
          icon.textContent = "▸";
        }
      });
      row.appendChild(kid);
    } else {
      row.addEventListener("click", (e) => { e.stopPropagation(); previewFile(rel); });
    }
    return row;
  }

  function extIcon(rel) {
    const ext = rel.split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext)) return "🖼";
    if (ext === "md") return "📝";
    if (["js", "ts", "jsx", "tsx", "mjs", "cjs"].includes(ext)) return "📜";
    if (ext === "json") return "🧾";
    return "📄";
  }

  async function loadGitStatus() {
    const note = document.getElementById("files-git-note");
    try {
      const res = await fetch("/api/git-status");
      const data = await res.json();
      if (!data.git) { gitMap = null; note.textContent = "（非 git 仓库）"; return; }
      note.textContent = "";
      gitMap = new Map();
      for (const e of data.entries) {
        const st = (e.x === " " ? "" : e.x) + (e.y === " " ? "" : e.y);
        gitMap.set(e.path, st || "M");
      }
      refreshDots();
    } catch { gitMap = null; note.textContent = ""; }
  }

  function refreshDots() {
    // 重新渲染已加载的目录节点（带 git 圆点）
    const tree = document.getElementById("files-tree");
    if (!tree || tree.hidden || !gitMap) return;
    rebindDots(tree, "");
  }

  function rebindDots(container, baseRel) {
    for (const row of container.querySelectorAll(":scope > .file-row")) {
      const nameEl = row.querySelector(".file-name");
      const kid = row.querySelector(":scope > .file-kids");
      if (!nameEl) continue;
      const rel = baseRel ? baseRel + "/" + nameEl.textContent : nameEl.textContent;
      if (!row.querySelector(".file-git-dot") && gitMap.has(rel)) {
        const st = gitMap.get(rel);
        const dot = document.createElement("span");
        dot.className = "file-git-dot" + (st === "??" ? " untracked" : "");
        dot.title = "git: " + st;
        dot.textContent = "●";
        row.appendChild(dot);
      }
      if (kid && !kid.hidden) rebindDots(kid, rel);
    }
  }

  // ---------- 预览 ----------
  async function previewFile(rel) {
    ensurePreview();
    const panel = document.getElementById("file-preview");
    const title = document.getElementById("file-preview-title");
    const body = document.getElementById("file-preview-body");
    panel.hidden = false;
    title.textContent = rel;
    body.innerHTML = '<div class="files-loading">…</div>';
    const ext = rel.split(".").pop().toLowerCase();
    try {
      const res = await fetch("/api/file?path=" + encodeURIComponent(rel));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      if (data.kind === "image") {
        body.innerHTML = "";
        const img = document.createElement("img");
        img.className = "file-preview-image";
        img.src = data.url + "&t=" + Date.now();
        img.alt = rel;
        body.appendChild(img);
        // 复用已有灯箱（单击放大）
        img.addEventListener("click", () => {
          if (typeof openLightbox === "function") openLightbox([{ src: img.src, name: rel }], 0);
        });
        return;
      }
      if (data.kind === "too-large" || data.kind === "binary") {
        body.innerHTML = `<div class="files-empty">${data.kind === "binary" ? "二进制文件，不支持预览" : escapeHtml(data.hint || "文件过大")}</div>`;
        return;
      }
      // 文本
      body.innerHTML = "";
      if (ext === "md" && window.PiMD && PiMD.render) {
        const md = document.createElement("div");
        md.className = "md-body file-md";
        md.innerHTML = PiMD.render(data.content, { streaming: false });
        body.appendChild(md);
      } else {
        const pre = document.createElement("pre");
        pre.className = "file-code";
        const code = document.createElement("code");
        code.innerHTML = (window.PiMD && PiMD.highlight) ? PiMD.highlight(data.content, ext) : escapeHtml(data.content);
        pre.appendChild(code);
        body.appendChild(pre);
      }
      // 复制按钮
      const bar = document.createElement("div");
      bar.className = "file-preview-bar";
      const btn = document.createElement("button");
      btn.className = "trace-more-btn";
      btn.textContent = "⧉ 复制全文";
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(data.content); btn.textContent = "✓ 已复制"; }
        catch { btn.textContent = "复制失败"; }
        setTimeout(() => { btn.textContent = "⧉ 复制全文"; }, 1500);
      });
      bar.appendChild(btn);
      body.appendChild(bar);
    } catch (err) {
      body.innerHTML = `<div class="files-empty">预览失败: ${escapeHtml(String(err.message))}</div>`;
    }
  }

  function ensurePreview() {
    if (document.getElementById("file-preview")) return;
    const panel = document.createElement("div");
    panel.id = "file-preview";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="trace-head">
        <div class="trace-title">📄 <span id="file-preview-title"></span></div>
        <button id="file-preview-close" class="trace-close" title="关闭">×</button>
      </div>
      <div class="file-preview-body" id="file-preview-body"></div>`;
    document.body.appendChild(panel);
    document.getElementById("file-preview-close").addEventListener("click", () => { panel.hidden = true; });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- anchors 徽标（P1-⑤ 前端） ----------
  async function refreshAnchors() {
    ensureDom();
    let badge = document.getElementById("anchors-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "anchors-badge";
      badge.className = "anchors-badge";
      badge.title = "每轮 git 锚点（refs/piweb/rounds）";
      const sidebar = document.getElementById("sidebar");
      const head = sidebar && sidebar.querySelector(".sidebar-header");
      if (head && head.nextSibling) sidebar.insertBefore(badge, head.nextSibling);
      else if (sidebar) sidebar.appendChild(badge);
      else document.body.appendChild(badge);
    }
    try {
      const res = await fetch("/api/anchors");
      const data = await res.json();
      if (!data.git || !data.refs.length) { badge.hidden = true; return; }
      badge.hidden = false;
      badge.textContent = `⚓ anchors: ${data.refs.length}`;
      const old = badge.querySelector(".anchors-list");
      if (old) old.remove();
      const list = document.createElement("div");
      list.className = "anchors-list";
      list.hidden = true;
      for (const r of data.refs.slice(0, 5)) {
        const line = document.createElement("div");
        line.className = "anchors-line";
        line.textContent = `#${r.n} ${r.hash} ${r.message}`;
        list.appendChild(line);
      }
      badge.appendChild(list);
    } catch { /* fail-open */ }
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureDom();
    refreshAnchors();
    document.getElementById("anchors-badge").addEventListener("click", () => {
      const list = badgeList();
      if (list) list.hidden = !list.hidden;
    });
    function badgeList() { return document.querySelector("#anchors-badge .anchors-list"); }
  });

  // 探针钩子
  window.__files_test = {
    toggle: toggleTree,
    preview: previewFile,
    anchors: refreshAnchors,
    state: () => ({
      treeOpen: !(document.getElementById("files-tree") || { hidden: true }).hidden,
      rows: document.querySelectorAll("#files-tree .file-row").length,
      gitDots: document.querySelectorAll("#files-tree .file-git-dot").length,
      previewOpen: !(document.getElementById("file-preview") || { hidden: true }).hidden,
      previewText: (document.getElementById("file-preview-body") || { textContent: "" }).textContent.slice(0, 80),
      hasMd: !!document.querySelector("#file-preview-body .file-md"),
      hasCode: !!document.querySelector("#file-preview-body .file-code"),
      anchorsText: (document.getElementById("anchors-badge") || {}).textContent || "",
      anchorsVisible: !(document.getElementById("anchors-badge") || { hidden: true }).hidden,
    }),
  };
})();
