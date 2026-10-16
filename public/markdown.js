/**
 * Pi WebUI - 零依赖 Markdown 渲染器 + 轻量语法高亮
 *
 * 设计约束（对齐 pi-webui 薄桥接哲学）：
 *   - 不引外部库 / CDN，单文件，浏览器与 Node 均可加载（Node 用于离线单测）
 *   - 流式友好：支持 streaming 模式（未闭合的代码围栏自动补全，逐 delta 重渲染）
 *   - XSS 安全：所有文本先 escape，再套 markdown 结构；URL 白名单（http/https/mailto）
 *
 * 暴露：window.PiMD.render(src, {streaming}) -> HTML 字符串
 *       window.PiMD.highlight(code, lang)     -> HTML 字符串
 */
(function () {
  "use strict";

  var root = typeof window !== "undefined" ? window : globalThis;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------- 语法高亮 ----------
  var KEYWORDS = {
    js: "const let var function return if else for while do switch case default break continue new class extends super this typeof instanceof in of delete void yield async await import export from as try catch finally throw null true false undefined static get set interface type enum implements public private protected readonly declare namespace abstract",
    py: "def class return if elif else for while break continue import from as pass lambda None True False and or not in is global nonlocal try except finally raise with yield assert del async await self cls print len range str int float list dict set tuple bool",
    sh: "if then else elif fi for while until do done case esac in function return export local echo printf cd rm cp mv mkdir touch grep sed awk cat ls sudo apt apt-get npm npx node git python python3 pip pip3 source unset set read sleep kill ps chmod curl wget tar zip unzip make",
  };

  function highlight(code, lang) {
    var l = (lang || "").toLowerCase();
    var family = null;
    if (/^(javascript|js|jsx|mjs|cjs|typescript|ts|tsx)$/.test(l)) family = "js";
    else if (/^(python|py)$/.test(l)) family = "py";
    else if (/^(bash|sh|zsh|shell|console|shellsession)$/.test(l)) family = "sh";
    else if (/^(json|jsonc|json5)$/.test(l)) family = "json";
    if (!family) return escapeHtml(code);

    var parts = [];
    var n = 0;
    function add(type, src) { parts.push({ name: "g" + n++, type: type, src: src }); }

    if (family === "json") {
      add("key", '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)');
      add("str", '"(?:[^"\\\\]|\\\\.)*"');
      add("num", "-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b");
      add("kw", "\\b(?:true|false|null)\\b");
    } else {
      if (family === "js") add("com", "/\\*[\\s\\S]*?\\*/");
      add("com", family === "js" ? "//[^\\n]*" : "#[^\\n]*");
      add("str", '"(?:[^"\\\\\\n]|\\\\.)*"');
      add("str", "'(?:[^'\\\\\\n]|\\\\.)*'");
      if (family === "js") add("str", "`(?:[^`\\\\]|\\\\.)*`");
      add("num", "\\b\\d+(?:_\\d+)*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b");
      add("kw", "\\b(?:" + KEYWORDS[family].trim().split(/\s+/).join("|") + ")\\b");
      add("fn", "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()");
    }

    var re = new RegExp(parts.map(function (p) { return "(?<" + p.name + ">" + p.src + ")"; }).join("|"), "g");
    var cls = { com: "tok-com", str: "tok-str", num: "tok-num", kw: "tok-kw", fn: "tok-fn", key: "tok-key" };
    var out = "";
    var last = 0;
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(code)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      out += escapeHtml(code.slice(last, m.index));
      var type = "fn";
      for (var i = 0; i < parts.length; i++) {
        if (m.groups && m.groups[parts[i].name] !== undefined) { type = parts[i].type; break; }
      }
      out += '<span class="' + (cls[type] || "tok-fn") + '">' + escapeHtml(m[0]) + "</span>";
      last = m.index + m[0].length;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  // ---------- 行内元素 ----------
  function safeUrl(url, allowMailto) {
    var u = String(url).trim().replace(/[\u0000-\u001f\s"'<>`]/g, "");
    if (/^https?:\/\//i.test(u)) return u;
    if (allowMailto && /^mailto:/i.test(u)) return u;
    return null;
  }

  function inline(s) {
    // 1. 行内代码先占位保护（其中的 markdown 字符不参与后续替换）
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (m, c) {
      codes.push(c);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    s = escapeHtml(s);
    // 2. 图片 / 链接（URL 白名单）
    s = s.replace(/!\[([^\]]*)\]\(([^)\s"']+)(?:\s+"[^"]*")?\)/g, function (m, alt, url) {
      var u = safeUrl(url, false);
      return u ? '<img src="' + u + '" alt="' + alt + '" loading="lazy">' : alt;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s"']+)(?:\s+"[^"]*")?\)/g, function (m, text, url) {
      var u = safeUrl(url, true);
      return u ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + text + "</a>" : text;
    });
    // 3. 强调 / 删除线
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
         .replace(/__([^_]+)__/g, "<strong>$1</strong>")
         .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
         .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>")
         .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // 4. 软换行（段落内单 \n → <br>）
    s = s.replace(/\n/g, "<br>");
    // 5. 还原行内代码
    s = s.replace(/\u0000C(\d+)\u0000/g, function (m, idx) {
      return "<code>" + escapeHtml(codes[+idx]) + "</code>";
    });
    return s;
  }

  // ---------- 块级元素 ----------
  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (c) { return c.trim(); });
  }

  function buildTable(header, rows) {
    var th = header.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
    }).join("");
    return '<div class="md-table-wrap"><table><thead><tr>' + th + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function renderBlocks(lines) {
    var out = [];
    var para = [];
    var list = null;  // {type:'ul'|'ol', items:[]}
    var quote = null; // string[]

    function flushPara() {
      if (para.length) { out.push("<p>" + inline(para.join("\n")) + "</p>"); para = []; }
    }
    function flushList() {
      if (!list) return;
      out.push("<" + list.type + ">" + list.items.map(function (it) { return "<li>" + inline(it) + "</li>"; }).join("") + "</" + list.type + ">");
      list = null;
    }
    function flushQuote() {
      if (!quote) return;
      var inner = quote.map(function (l) { return l.replace(/^\s*>\s?/, ""); });
      out.push("<blockquote>" + renderBlocks(inner) + "</blockquote>");
      quote = null;
    }
    function flushAll() { flushPara(); flushList(); flushQuote(); }

    var idx = 0;
    while (idx < lines.length) {
      var line = lines[idx];
      var trimmed = line.trim();

      var cb = trimmed.match(/^\u0000CB(\d+)\u0000$/);
      if (cb) { flushAll(); out.push("\u0000CB" + cb[1] + "\u0000"); idx++; continue; }

      if (!trimmed) { flushAll(); idx++; continue; }

      // 表格：当前行含 |，下一行是分隔行（|---|:--:|）
      if (line.indexOf("|") !== -1 && idx + 1 < lines.length) {
        var sep = lines[idx + 1];
        if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(sep) && sep.indexOf("-") !== -1) {
          flushAll();
          var header = splitRow(line);
          idx += 2;
          var rows = [];
          while (idx < lines.length && lines[idx].trim() && lines[idx].indexOf("|") !== -1) {
            rows.push(splitRow(lines[idx])); idx++;
          }
          out.push(buildTable(header, rows));
          continue;
        }
      }

      var h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushAll();
        var lv = h[1].length;
        out.push("<h" + lv + ">" + inline(h[2].trim()) + "</h" + lv + ">");
        idx++; continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push("<hr>"); idx++; continue; }

      var q = line.match(/^\s*>\s?(.*)$/);
      if (q) { flushPara(); flushList(); if (!quote) quote = []; quote.push(q[1]); idx++; continue; }

      var ul = line.match(/^\s*[-*+]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara(); flushQuote();
        var type = ul ? "ul" : "ol";
        if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
        list.items.push((ul || ol)[1]);
        idx++; continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += "\n" + line.trim();
        idx++; continue;
      }

      flushList(); flushQuote();
      para.push(line);
      idx++;
    }
    flushAll();
    return out.join("");
  }

  function codeBlockHtml(lang, code) {
    var langLabel = escapeHtml(lang || "text");
    return '<div class="code-block" data-lang="' + langLabel + '">' +
      '<div class="code-head"><span class="code-lang">' + langLabel + "</span>" +
      '<button type="button" class="code-copy">复制</button></div>' +
      "<pre><code>" + highlight(code, lang) + "</code></pre></div>";
  }

  function render(src, opts) {
    var streaming = !!(opts && opts.streaming);
    var text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");

    // 1. 提取代码围栏（未闭合时自动吞到文末，streaming 安全）
    var blocks = [];
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, function (m, lang, body) {
      blocks.push({ lang: (lang || "").trim().slice(0, 16), code: body.replace(/\n$/, "") });
      return "\u0000CB" + (blocks.length - 1) + "\u0000";
    });

    // 2. 块级 + 行内渲染
    var html = renderBlocks(text.split("\n"));

    // 3. 还原代码块
    html = html.replace(/\u0000CB(\d+)\u0000/g, function (m, i) {
      var b = blocks[+i];
      return b ? codeBlockHtml(b.lang, b.code) : "";
    });
    return html;
  }

  // ---------- 代码块复制（事件委托，一次绑定） ----------
  if (typeof document !== "undefined") {
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(".code-copy") : null;
      if (!btn) return;
      var block = btn.closest(".code-block");
      var code = block ? block.querySelector("code") : null;
      if (!code) return;
      var done = function () {
        btn.textContent = "已复制";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = "复制"; btn.classList.remove("copied"); }, 1200);
      };
      var fallback = function () {
        var ta = document.createElement("textarea");
        ta.value = code.textContent || "";
        ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (err) { /* 忽略 */ }
        ta.remove();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code.textContent || "").then(done).catch(fallback);
      } else {
        fallback();
      }
    });
  }

  root.PiMD = { render: render, highlight: highlight, escapeHtml: escapeHtml };
})();
