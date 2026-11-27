/* ------------------------------------------------------------------
 * 创作者排行榜（新增）
 *
 * 三个榜，数据全部来自本机，不主动联网：
 *   · 投稿数   图谱内该时代命中基岩信号的投稿数（vpe / vbr），全量 38,557 人
 *   · 合作数   图谱内连边数（由 links 现算，按时代过滤），全量
 *   · 粉丝数   只统计本地已有缓存：用联网搜索添加过的、或右键看过作品的创作者
 *              （bedrock.favs.v1 / bedrock.vcache.v1），没缓存的显示为空榜提示
 *
 * 默认前十；「展开全部」后先渲染 100 条，滚到底再加载 100 条。
 * 点任意一行：在图谱内就跳过去定位，只存在于本地名单的则打开其作品面板。
 * ------------------------------------------------------------------ */
(function () {
"use strict";

var app = window.GRAPH_APP;
var K_FAV = "bedrock.favs.v1", K_VC = "bedrock.vcache.v1", K_UI = "bedrock.rank.v1", K_HIDDEN = "bedrock.rank.hidden";
var K_ZOOM = "bedrock.rank.size.v1";

function $(id) { return document.getElementById(id); }
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function readJSON(k, def) {
  try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : def; } catch (e) { return def; }
}
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function faceUrl(f) {
  if (!f) return "";
  if (f.indexOf("//") === 0) return "https:" + f;
  if (f.indexOf("http://") === 0) return "https://" + f.slice(7);
  return f;
}
function comma(v) { return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function wan(v) {
  v = +v || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, "") + " 亿";
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return comma(v);
}

var ERA_LABEL = { all: "展开排行榜", pe: "携带版", br: "基岩版" };
var METRIC_LABEL = { posts: "投稿数", links: "合作数", fans: "粉丝数" };
var PAGE = 100;

var el = null, listEl, footEl, eraEl, tabsEl, noteEl;
var state = { metric: "posts", era: "all", expanded: false, limit: PAGE, rows: [], total: 0, note: "" };
var idx = null;      // 度数索引（与时代无关，建一次）

/* 被手动移出榜单的人（存在本地，可一键恢复） */
var hiddenIds = (function () {
  var raw = readJSON(K_HIDDEN, []);
  var set = new Set();
  if (Array.isArray(raw)) raw.forEach(function (v) { if (v != null) set.add(String(v)); });
  return set;
})();
function saveHidden() { try { writeJSON(K_HIDDEN, Array.from(hiddenIds)); } catch (e) { /* ignore */ } }

/* ---------------- 数据 ---------------- */
function buildIndex() {
  if (idx) return;
  var links = app.allLinks();
  var all = new Map(), pe = new Map(), br = new Map();
  function bump(m, k) { m.set(k, (m.get(k) || 0) + 1); }
  for (var i = 0; i < links.length; i++) {
    var l = links[i], s = String(l.source), t = String(l.target);
    bump(all, s); bump(all, t);
    if (l.pe) { bump(pe, s); bump(pe, t); }
    if (l.br) { bump(br, s); bump(br, t); }
  }
  idx = { all: all, pe: pe, br: br };
}

function postsOf(n, era) {
  if (era === "pe") return n.vpe || 0;
  if (era === "br") return n.vbr || 0;
  return (n.vpe || 0) + (n.vbr || 0);
}
function linksOf(id, era) {
  var m = era === "pe" ? idx.pe : (era === "br" ? idx.br : idx.all);
  return m.get(id) || 0;
}

/* 本地已有的联网缓存：我的添加 + 看过的作品面板 */
function cachedCreators() {
  var map = {};
  function put(id, name, face, fans, archive, fav) {
    if (!id) return;
    var e = map[id] || (map[id] = { id: String(id), name: "", face: "", fans: 0, archive: 0, fav: false });
    if (name && !e.name) e.name = name;
    if (face && !e.face) e.face = faceUrl(face);
    if (fans > (e.fans || 0)) e.fans = fans;
    if (archive > (e.archive || 0)) e.archive = archive;
    if (fav) e.fav = true;
  }
  readJSON(K_FAV, []).forEach(function (f) {
    if (f && f.id) put(f.id, f.name, f.faceData || f.face, f.fans || 0, f.videos || f.archive || 0, true);
  });
  var vc = readJSON(K_VC, {});
  Object.keys(vc || {}).forEach(function (id) {
    var c = vc[id] && vc[id].card;
    if (c && c.mid) put(String(c.mid), c.name, c.face, c.fans || 0, c.archive || 0, false);
  });
  return map;
}

function buildRows() {
  buildIndex();
  var era = state.era, metric = state.metric;
  var rows = [];

  if (metric === "fans") {
    var cached = cachedCreators(), inGraph = {};
    app.allNodes().forEach(function (n) { inGraph[String(n.id)] = n; });
    Object.keys(cached).forEach(function (id) {
      var c = cached[id];
      if (!(c.fans > 0)) return;
      if (hiddenIds.has(id)) return;
      var g = inGraph[id];
      rows.push({
        id: id,
        name: c.name || (g && g.name) || ("UID " + id),
        face: c.face || (g ? faceUrl(g.face) : ""),
        value: c.fans,
        tag: g ? "" : (c.fav ? "仅本地" : "已缓存"),
        inGraph: !!g
      });
    });
    rows.sort(function (a, b) { return b.value - a.value || a.name.length - b.name.length; });
    state.note = "粉丝数来自本地缓存（用联网搜索添加、或右键看过作品的创作者）";
    return rows;
  }

  var nodes = app.allNodes();
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var id = String(n.id);
    if (hiddenIds.has(id)) continue;
    var active = era === "all" ? (n.pe || n.br) : (era === "pe" ? n.pe : n.br);
    if (!active) continue;
    var v = metric === "posts" ? postsOf(n, era) : linksOf(id, era);
    if (!(v > 0)) continue;
    rows.push({ id: id, name: n.name || ("UID " + id), face: faceUrl(n.face), value: v, tag: "", inGraph: true });
  }
  rows.sort(function (a, b) { return b.value - a.value || a.name.length - b.name.length; });
  state.note = metric === "posts" ? "图谱内命中基岩信号的投稿数（按当前时代）" : "图谱内的合作边数（按当前时代）";
  return rows;
}

/* ---------------- 渲染 ---------------- */
function avatarHtml(r) {
  if (r.face) return '<img class="rk-face" src="' + esc(r.face) + '" referrerpolicy="no-referrer" alt="">';
  return '<span class="rk-face face-fallback">' + esc((r.name || "?").charAt(0)) + "</span>";
}
function rowHtml(r, i) {
  var v = state.metric === "fans" ? wan(r.value) : comma(r.value);
  return '<div class="rk-row' + (i < 3 ? " top" + (i + 1) : "") + '" data-id="' + esc(r.id) + '" data-ingraph="' + (r.inGraph ? 1 : 0) + '">' +
    '<span class="rk-no">' + (i + 1) + "</span>" + avatarHtml(r) +
    '<span class="rk-name">' + esc(r.name) + (r.tag ? " <em>" + esc(r.tag) + "</em>" : "") + "</span>" +
    '<span class="rk-val">' + v + "</span>" +
    '<button class="rk-del" type="button" data-del="' + esc(r.id) + '" title="从排行榜移除" aria-label="从排行榜移除">×</button></div>';
}
function render() {
  if (!listEl) return;
  var rows = buildRows();
  state.rows = rows;
  state.total = rows.length;
  var shown = state.expanded ? Math.min(state.limit, rows.length) : Math.min(10, rows.length);

  el.classList.toggle("collapsed", !!state.collapsed);
  eraEl.textContent = ERA_LABEL[state.era];
  Array.prototype.forEach.call(tabsEl.children, function (b) {
    b.classList.toggle("on", b.dataset.metric === state.metric);
  });

  // 粉丝榜的说明：只统计你查看过 / 添加过的人
  if (noteEl) {
    noteEl.hidden = state.metric !== "fans";
    if (state.metric === "fans") noteEl.textContent = "查看过的 UP 才会出现在本排行榜中";
  }

  if (!rows.length) {
    listEl.innerHTML = '<div class="rk-empty">' +
      (state.metric === "fans"
        ? "还没有粉丝数缓存<br>用「联网搜人」添加创作者、或右键看 TA 的作品后，这里就会有数据"
        : "这个时代没有可排的数据") + "</div>";
    footEl.innerHTML = restoreHtml();
    return;
  }

  var html = "";
  for (var i = 0; i < shown; i++) html += rowHtml(rows[i], i);
  listEl.innerHTML = html;

  if (state.expanded) {
    footEl.innerHTML = '<button type="button" id="rkCollapse">收起</button>' +
      '<span class="rk-count"> 已显示 ' + shown + " / " + comma(rows.length) + "</span>" + restoreHtml();
  } else {
    footEl.innerHTML = (rows.length > 10
      ? '<button type="button" id="rkExpand">展开全部（' + comma(rows.length) + " 人）</button>"
      : '<span class="rk-count">共 ' + comma(rows.length) + " 人</span>") + restoreHtml();
  }
}
function restoreHtml() {
  if (!hiddenIds.size) return "";
  return '<div class="rk-restore"><button type="button" id="rkRestore">恢复已移除的 ' + hiddenIds.size + " 人</button></div>";
}
/* 从榜单移除：记进隐藏名单，并清掉本地缓存里这一条，免得下次又冒出来 */
function removeRankRow(id) {
  id = String(id);
  hiddenIds.add(id);
  saveHidden();
  var favs = readJSON(K_FAV, []);
  if (Array.isArray(favs) && favs.length) {
    var hit = favs.some(function (f) { return String(f && f.id) === id; });
    if (hit && window.GRAPH_ONLINE && window.GRAPH_ONLINE.dropFav) window.GRAPH_ONLINE.dropFav(id);
  }
  var vc = readJSON(K_VC, {});
  if (vc && vc[id]) { delete vc[id]; writeJSON(K_VC, vc); }
  render();
}

function appendMore() {
  if (!state.expanded) return;
  if (state.limit >= state.total) return;
  var start = state.limit;
  state.limit = Math.min(state.total, state.limit + PAGE);
  var html = "";
  for (var i = start; i < state.limit; i++) html += rowHtml(state.rows[i], i);
  listEl.insertAdjacentHTML("beforeend", html);
  var fb = footEl.querySelector(".rk-count");
  if (fb) fb.textContent = " 已显示 " + state.limit + " / " + comma(state.total);
}

/* ---------------- 事件 ---------------- */
function bind() {
  el = $("rank");
  if (!el) return;
  listEl = $("rkList"); footEl = $("rkFoot"); eraEl = $("rkEra"); tabsEl = $("rkTabs"); noteEl = $("rkNote");

  var ui = readJSON(K_UI, { collapsed: null, metric: "posts" });
  if (ui.metric && METRIC_LABEL[ui.metric]) state.metric = ui.metric;
  state.collapsed = ui.collapsed === null || ui.collapsed === undefined
    ? (window.innerWidth < 900)      // 小屏默认收起
    : !!ui.collapsed;

  /* ---- 左上角手柄：拖动改大小，单击恢复初始大小 ---- */
  var zoomBtn = $("rkZoom");
  var MIN_W = 200, MAX_W = 560, MIN_H = 180;
  var drag = null, suppressClick = false;

  function sizeLimits() {
    return {
      w: Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - 24)),
      h: Math.max(MIN_H, window.innerHeight - 120)
    };
  }
  function applySize(w, h) {
    if (!w || !h) {
      el.classList.remove("sized");
      el.style.width = "";
      el.style.height = "";
      return;
    }
    el.classList.add("sized");
    el.style.width = Math.round(w) + "px";
    el.style.height = Math.round(h) + "px";
  }
  function resetSize() {
    applySize(0, 0);
    try { localStorage.removeItem(K_ZOOM); } catch (e) {}
  }
  function restoreSize() {
    var s = readJSON(K_ZOOM, null);
    if (!s || !(s.w > 0) || !(s.h > 0)) return;
    var lim = sizeLimits();
    applySize(Math.min(s.w, lim.w), Math.min(s.h, lim.h));
  }
  restoreSize();

  if (zoomBtn) {
    zoomBtn.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0 || el.classList.contains("collapsed")) return;
      var r = el.getBoundingClientRect();
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, w: r.width, h: r.height, moved: false };
      el.classList.add("resizing");
      try { zoomBtn.setPointerCapture(ev.pointerId); } catch (e) { /* 老浏览器忽略 */ }
      ev.preventDefault();
    });
    zoomBtn.addEventListener("pointermove", function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      // 面板锚在右下角：向左 / 向上拖 = 变大
      var dx = drag.x - ev.clientX, dy = drag.y - ev.clientY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      var lim = sizeLimits();
      applySize(Math.max(MIN_W, Math.min(lim.w, drag.w + dx)),
                Math.max(MIN_H, Math.min(lim.h, drag.h + dy)));
    });
    function endDrag(ev) {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      var moved = drag.moved;
      drag = null;
      el.classList.remove("resizing");
      if (ev) { try { zoomBtn.releasePointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
      if (moved) {
        var r = el.getBoundingClientRect();
        writeJSON(K_ZOOM, { w: Math.round(r.width), h: Math.round(r.height) });
        suppressClick = true;          // 拖完别顺手触发“恢复”
      }
    }
    zoomBtn.addEventListener("pointerup", endDrag);
    zoomBtn.addEventListener("pointercancel", endDrag);
    zoomBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (suppressClick) { suppressClick = false; return; }
      resetSize();
    });
    // 窗口变小后把面板收回可用范围
    window.addEventListener("resize", function () {
      if (!el.classList.contains("sized")) return;
      var lim = sizeLimits();
      var w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      if (w > lim.w || h > lim.h) applySize(Math.min(w, lim.w), Math.min(h, lim.h));
    });
  }

  $("rkHead").addEventListener("click", function () {
    state.collapsed = !state.collapsed;
    el.classList.toggle("collapsed", state.collapsed);
    this.setAttribute("aria-expanded", state.collapsed ? "false" : "true");
    writeJSON(K_UI, { collapsed: state.collapsed, metric: state.metric });
    if (!state.collapsed) {
      // 手机上两个底部面板同时展开会互相遮挡；展开排行榜时先收起统计面板
      if (window.innerWidth <= 640 && window.GRAPH_STATS && window.GRAPH_STATS.close) window.GRAPH_STATS.close();
      render();
    }
  });
  if (state.collapsed) el.classList.add("collapsed");

  tabsEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-metric]");
    if (!b || b.dataset.metric === state.metric) return;
    state.metric = b.dataset.metric;
    state.expanded = false;
    state.limit = PAGE;
    writeJSON(K_UI, { collapsed: state.collapsed, metric: state.metric });
    render();
    listEl.scrollTop = 0;
  });

  footEl.addEventListener("click", function (ev) {
    if (ev.target.closest("#rkExpand")) {
      state.expanded = true;
      state.limit = PAGE;
      render();
      listEl.scrollTop = 0;
    } else if (ev.target.closest("#rkCollapse")) {
      state.expanded = false;
      state.limit = PAGE;
      render();
    } else if (ev.target.closest("#rkRestore")) {
      hiddenIds.clear();
      saveHidden();
      render();
    }
  });

  listEl.addEventListener("click", function (ev) {
    var del = ev.target.closest(".rk-del");
    if (del) {
      ev.stopPropagation();
      removeRankRow(del.dataset.del);
      return;
    }
    var row = ev.target.closest(".rk-row");
    if (!row) return;
    var id = row.dataset.id;
    if (row.dataset.ingraph === "1") app.openCreator(id);
    else if (window.GRAPH_ONLINE) window.GRAPH_ONLINE.openWorks(id);
  });

  listEl.addEventListener("scroll", function () {
    if (!state.expanded) return;
    if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 40) appendMore();
  });

  // 时代切换 / 视图变化后重算
  window.addEventListener("graph:view", function (ev) {
    var era = (ev.detail && ev.detail.era) || app.era();
    if (era === state.era && state.total) return;
    state.era = era;
    state.expanded = false;
    state.limit = PAGE;
    render();
  });

  // 图谱来源切换：清空度数索引并按新图谱重算排行榜
  window.addEventListener("graph:source", function () {
    idx = null;
    state.era = app.era();
    state.expanded = false;
    state.limit = PAGE;
    render();
  });

  // 收藏 / 缓存变化后刷新
  window.addEventListener("graph:favs", function () { render(); });

  render();

  window.GRAPH_RANK = {
    refresh: render,
    metric: function () { return state.metric; },
    setMetric: function (m) { if (METRIC_LABEL[m]) { state.metric = m; render(); } },
    open: function () { state.collapsed = false; el.classList.remove("collapsed"); render(); },
    close: function () {
      state.collapsed = true;
      el.classList.add("collapsed");
      var head = $("rkHead");
      if (head) head.setAttribute("aria-expanded", "false");
      writeJSON(K_UI, { collapsed: true, metric: state.metric });
    }
  };
}

if (app.isReady()) bind();
else app.onReady(bind);
})();
