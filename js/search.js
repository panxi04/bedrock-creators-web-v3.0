/* ------------------------------------------------------------------
 * 全局搜索（新增功能）
 * 按「名字」或「UID」搜索，两种方式同时生效：
 *   · UID 完全相同 > 名字完全相同 > UID 前缀 > 名字前缀 > UID 包含 > 名字包含
 * 选中后复用 canvas 的聚焦逻辑（高亮该创作者 + 一跳邻居），
 * 若该创作者不在当前时代视图中，会自动切到对应时代后再聚焦。
 * 原有的工具栏内搜索完全保留，不受影响。
 * ------------------------------------------------------------------ */
(function () {
"use strict";

var app = window.GRAPH_APP;
var finder = document.getElementById("finder");
var input = document.getElementById("findInput");
var clearBtn = document.getElementById("findClear");
var kbd = finder.querySelector(".find-kbd");
var panel = document.getElementById("findPanel");
var list = document.getElementById("findList");
var foot = document.getElementById("findFoot");

var MAX_ROWS = 12;
var index = null;       // [{ id, name, nameLower, face, pe, br, deg }]
var results = [];
var active = -1;
var renderSeq = 0;      // 异步填充分区标签时，用来丢弃过期结果

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function faceUrl(f) {
  if (!f) return "";
  if (f.indexOf("//") === 0) return "https:" + f;
  if (f.indexOf("http://") === 0) return "https://" + f.slice(7);
  return f;
}
function faceHtml(n, cls) {
  if (n.face) return '<img class="' + cls + '" src="' + escapeHtml(n.face) + '" referrerpolicy="no-referrer" alt="">';
  var ch = (n.name || "?").trim().charAt(0) || "?";
  return '<span class="' + cls + ' face-fallback">' + escapeHtml(ch) + "</span>";
}

/* ---------- 索引：一次性建好，之后每次输入只做字符串比较 ---------- */
function buildIndex() {
  if (index) return;
  var raw = app.allNodes();
  var deg = new Map();
  app.allLinks().forEach(function (l) {
    var s = String(l.source), t = String(l.target);
    if (s !== t) { deg.set(s, (deg.get(s) || 0) + 1); deg.set(t, (deg.get(t) || 0) + 1); }
  });
  index = raw.map(function (n) {
    return {
      id: String(n.id),
      name: n.name || "",
      nameLower: (n.name || "").toLowerCase(),
      face: faceUrl(n.face),
      pe: !!n.pe,
      br: !!n.br,
      deg: deg.get(String(n.id)) || 0
    };
  });
}

/* ---------- 匹配 ---------- */
function rank(n, q, ql) {
  if (n.id === q) return 0;
  if (n.nameLower === ql) return 1;
  if (n.id.indexOf(q) === 0) return 2;
  if (n.nameLower.indexOf(ql) === 0) return 3;
  if (n.id.indexOf(q) >= 0) return 4;
  return 5;
}
function search(q) {
  buildIndex();
  var ql = q.toLowerCase(), out = [];
  for (var i = 0; i < index.length; i++) {
    var n = index[i];
    if (n.nameLower.indexOf(ql) < 0 && n.id.indexOf(q) < 0) continue;
    out.push({ n: n, r: rank(n, q, ql) });
  }
  out.sort(function (a, b) {
    if (a.r !== b.r) return a.r - b.r;
    if (b.n.deg !== a.n.deg) return b.n.deg - a.n.deg;
    return a.n.name.length - b.n.name.length;
  });
  return out;
}

/* ---------- 渲染 ---------- */
function highlight(name, ql) {
  var at = name.toLowerCase().indexOf(ql);
  if (!ql || at < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, at)) + "<em>" + escapeHtml(name.slice(at, at + ql.length)) + "</em>" +
    escapeHtml(name.slice(at + ql.length));
}
function eraText(n) {
  if (n.pe && n.br) return "双时代";
  return n.pe ? "携带版" : "基岩版";
}
function setPanel(open) {
  if (open === !panel.hidden) return;
  panel.hidden = !open;
  input.setAttribute("aria-expanded", open ? "true" : "false");
}
function render() {
  var q = input.value.trim();
  var seq = ++renderSeq;
  clearBtn.hidden = !q;
  kbd.hidden = !!q || document.activeElement === input;
  finder.classList.toggle("active", q.length > 0);
  if (window.GRAPH_ONLINE) window.GRAPH_ONLINE.onQuery(q);

  // 联网搜人结果接管列表
  if (q && window.GRAPH_ONLINE && window.GRAPH_ONLINE.onlineActive(q)) {
    var o = window.GRAPH_ONLINE.renderOnline();
    results = []; active = -1;
    list.innerHTML = o.html;
    foot.hidden = !o.foot;
    foot.textContent = o.foot || "";
    setPanel(true);
    return;
  }

  // 空查询：面板显示「我的添加」
  if (!q) {
    results = []; active = -1;
    var fav = window.GRAPH_ONLINE ? window.GRAPH_ONLINE.renderFavs() : null;
    if (!fav) { setPanel(false); return; }
    list.innerHTML = fav.html;
    foot.hidden = !fav.foot;
    foot.textContent = fav.foot || "";
    setPanel(true);
    return;
  }
  if (!index) {
    if (app.isReady()) buildIndex();   // 切源后可能未重建，这里兜底
    else { list.innerHTML = '<div class="find-empty">数据载入中…</div>'; foot.hidden = true; setPanel(true); return; }
  }

  var found = search(q);
  results = found.slice(0, MAX_ROWS).map(function (x) { return x.n; });
  active = results.length ? 0 : -1;

  if (!results.length) {
    var onlineNow = window.GRAPH_ONLINE && window.GRAPH_ONLINE.isOnline();
    var hint = onlineNow
      ? "可以点「联网搜人」在 B 站按名字搜，或点「B 站搜索」打开浏览器"
      : "点「B 站搜索」在浏览器里搜；想在这里直接搜人，先双击文件夹里的 启动.cmd";
    list.innerHTML = '<div class="find-empty">本地图谱没有匹配「' + escapeHtml(q) + '」的创作者<br><span class="dim">' + hint + '</span></div>';
    foot.hidden = true;
    setPanel(true);
    return;
  }
  var ql = q.toLowerCase(), html = "";
  results.forEach(function (n, i) {
    var on = window.GRAPH_ONLINE && window.GRAPH_ONLINE.isFav(n.id);
    html += '<div class="find-row' + (i === active ? " on" : "") + '" data-i="' + i + '" role="option" aria-selected="' + (i === active) + '">' +
      faceHtml(n, "find-face") +
      '<span class="find-text"><b>' + highlight(n.name, ql) + "</b><span>" + escapeHtml(n.id) + " · " + n.deg + " 个合作</span></span>" +
      '<span class="find-tag topic" title="分区读取中…">分区…</span>' +
      '<span class="find-add' + (on ? " on" : "") + '" data-add="' + escapeHtml(n.id) + '" title="' + (on ? "已在「我的添加」中" : "加入「我的添加」") + '">' + (on ? "★" : "＋") + "</span>" +
      "</div>";
  });
  list.innerHTML = html;
  // 分区标签与详情卡保持一致：读 uid_topics 映射（一个人可同时在多个分区）
  var detail = window.GRAPH_DETAIL;
  results.forEach(function (n, i) {
    var tag = list.children[i] && list.children[i].querySelector(".find-tag.topic");
    if (!tag) return;
    if (detail && detail.topicLabel) {
      detail.topicLabel(n.id).then(function (label) {
        if (seq !== renderSeq || !document.contains(tag)) return;   // 输入已变化则丢弃
        tag.textContent = label;
        tag.title = label;
      });
    } else {
      tag.textContent = eraText(n);
      tag.title = eraText(n);
    }
  });
  foot.hidden = found.length <= results.length;
  foot.textContent = "共 " + found.length + " 个结果，仅显示最匹配的 " + results.length + " 个";
  setPanel(true);
}
function moveActive(step) {
  if (!results.length) return;
  active = (active + step + results.length) % results.length;
  var rows = list.children;
  for (var i = 0; i < rows.length; i++) {
    var on = i === active;
    rows[i].classList.toggle("on", on);
    rows[i].setAttribute("aria-selected", on ? "true" : "false");
  }
  if (rows[active] && rows[active].scrollIntoView) rows[active].scrollIntoView({ block: "nearest" });
}
function select(i) {
  var n = results[i];
  if (!n) return;
  setPanel(false);
  input.blur();
  app.openCreator(n.id);
  // 聚焦后弹出人物详情卡：若 openCreator 触发了切时代，等布局就绪再打开
  function showDetail() { if (window.GRAPH_DETAIL) window.GRAPH_DETAIL.open(n.id); }
  if (app.isReady()) showDetail(); else app.onReady(showDetail);
}
function clearAll() {
  input.value = "";
  render();
  input.focus();
}

/* ---------- 事件 ---------- */
input.addEventListener("input", render);
input.addEventListener("focus", function () {
  kbd.hidden = true;
  render();
});
input.addEventListener("blur", function () {
  kbd.hidden = !!input.value.trim();
});
input.addEventListener("keydown", function (ev) {
  var k = ev.key;
  if (k === "ArrowDown") { ev.preventDefault(); if (panel.hidden) render(); else moveActive(1); return; }
  if (k === "ArrowUp") { ev.preventDefault(); moveActive(-1); return; }
  if (k === "Enter") {
    ev.preventDefault();
    if (active < 0 && results.length) active = 0;
    select(active);
    return;
  }
  if (k === "Escape") {
    ev.preventDefault();
    if (input.value) clearAll(); else { setPanel(false); input.blur(); }
  }
});
clearBtn.addEventListener("click", clearAll);
list.addEventListener("pointerdown", function (ev) {
  if (!window.GRAPH_ONLINE) return;
  var fav = ev.target.closest(".find-add[data-add]");
  if (fav) {
    ev.preventDefault();
    var fid = fav.dataset.add, node = null;
    for (var i = 0; i < results.length; i++) if (String(results[i].id) === fid) node = results[i];
    window.GRAPH_ONLINE.toggleFav(fid, node ? { id: fid, name: node.name, face: node.face } : null);
    render();
    return;
  }
  window.GRAPH_ONLINE.handleListAction(ev);
});
// 选人放到 click 阶段：pointerdown 里 preventDefault 会取消手机上的触摸滚动手势。
// 滚动时浏览器不会发 click，所以既能滑列表，也能点选。
list.addEventListener("click", function (ev) {
  if (ev.target.closest(".find-add[data-add], [data-online-add], .on-row, [data-act]")) return;
  var row = ev.target.closest(".find-row");
  if (!row || row.dataset.i == null) return;
  select(+row.dataset.i);
});
document.addEventListener("pointerdown", function (ev) {
  if (!finder.contains(ev.target)) setPanel(false);
});
// “/” 快速聚焦搜索框（输入框内不拦截；弹窗打开时不抢焦点）
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (document.querySelector("#searchModal.open, #connectModal.open")) return;
  var t = ev.target, tag = t && t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
  ev.preventDefault();
  input.focus();
  input.select();
});

/* ---------- 等数据就绪 ---------- */
function ready() {
  buildIndex();
  input.placeholder = "搜索名字 / UID";
  if (input.value.trim()) render();
}
if (app.isReady()) ready();
else app.onReady(ready);

// 收藏变化后让列表里的 ★ 立刻更新（只在面板打开时重绘，避免误弹）
window.GRAPH_REFRESH_SEARCH = function () {
  index = null;                 // 兜底：数据可能已变，重建索引
  if (!panel.hidden) render();
};
// 切换分区后索引必须重建，否则会沿用旧分区的节点列表导致搜不到人。
// ready() 钩子只在首次启动调用一次，所以切源后要主动等新图谱就绪再重建索引。
window.addEventListener("graph:source", function () {
  index = null;
  if (app.isReady()) { buildIndex(); }
  else app.onReady(buildIndex);
});
})();
