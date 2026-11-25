/* ------------------------------------------------------------------
 * 数据统计面板（纯前端，读取现有 data 图谱，不依赖后端）
 *   · 投稿分布：nodes.vpe/vbr 分档直方图
 *   · 合作分布：links 现算度数分档
 *   · 关系类型：links.j（联投 vs @提及）占比
 *   · 社区地图：layouts_<主题>/all_comm 的 group 分组气泡图（点击高亮整簇）
 * 数据全部来自 window.GRAPH_APP（图谱）与布局 bundle/json；随分区、时代切换联动。
 * ------------------------------------------------------------------ */
(function () {
"use strict";

var app = window.GRAPH_APP;
function $(id) { return document.getElementById(id); }
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
}); }
function comma(n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

var panel = $("statsPanel"), head = $("stHead"), tabs = $("stTabs");
var note = $("stNote"), chart = $("stChart"), label = $("stLabel");
var curTab = "posts";
var commCache = {};      // 按数据源缓存社区分组
var commPending = null;

function sourceName() { return document.getElementById("sourceSelect").value || "bedrock.json"; }
function sourceKey() { return sourceName().replace(/\.json$/, ""); }

// 展开/收起
if (head) head.addEventListener("click", function () {
  var opening = panel.classList.contains("collapsed");
  panel.classList.toggle("collapsed");
  head.setAttribute("aria-expanded", opening ? "true" : "false");
  document.body.classList.toggle("stats-open", opening);
  if (opening) {
    // 统计面板与详情卡都在左侧，同时展开会重叠；展开统计时收起详情卡（功能不变，随时可再点开）
    if (window.GRAPH_DETAIL && window.GRAPH_DETAIL.close) window.GRAPH_DETAIL.close();
    render();
  }
});

// 标签切换
if (tabs) tabs.addEventListener("click", function (ev) {
  var b = ev.target.closest("button");
  if (!b || !b.dataset.tab) return;
  curTab = b.dataset.tab;
  Array.prototype.forEach.call(tabs.children, function (x) { x.classList.toggle("on", x === b); });
  render();
});

// 分区 / 视图切换联动
window.addEventListener("graph:source", function () { commCache = {}; commPending = null; schedule(); });
window.addEventListener("graph:view", function () { schedule(); });
var _t = null;
function schedule() {
  if (_t) clearTimeout(_t);
  _t = setTimeout(function () { if (panel && !panel.classList.contains("collapsed")) render(); }, 250);
}

// ---- 布局社区分组读取（http 用 fetch，file 用 bundle 脚本）----
function loadComm(cb) {
  var key = sourceKey();
  if (commCache[key]) { cb(commCache[key]); return; }
  var jsonPath = "data/layouts_" + key + "/all_comm.json";
  var bundlePath = "data/layouts_" + key + "/all_comm.bundle.js";
  function done(g) { commCache[key] = g || null; cb(commCache[key]); }
  if (location.protocol !== "file:") {
    fetch(jsonPath).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { done(d && d.group); }).catch(function () { loadBundle(); });
  } else loadBundle();
  function loadBundle() {
    var el = document.createElement("script");
    el.src = bundlePath;
    el.onload = function () {
      var g = window.__GRAPH_LAYOUT && window.__GRAPH_LAYOUT.group;
      try { window.__GRAPH_LAYOUT = undefined; } catch (e) {}
      el.parentNode && el.parentNode.removeChild(el);
      done(g || null);
    };
    el.onerror = function () { el.parentNode && el.parentNode.removeChild(el); done(null); };
    document.head.appendChild(el);
  }
}

// ---- 取当前时代的节点与边（与 GRAPH_APP 一致）----
function data() {
  if (!app) return null;
  var era = app.era();
  var nodes = app.allNodes().filter(function (n) { return era === "all" || n[era]; });
  var links = app.allLinks().filter(function (l) { return era === "all" || l[era]; });
  return { era: era, nodes: nodes, links: links };
}

// ---- 4 个图表 ----
function bars(rows, max, unit) {
  var W = 280, H = Math.max(90, rows.length * 26 + 10), x0 = 88, bw = W - x0 - 46;
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img">';
  rows.forEach(function (r, i) {
    var y = 6 + i * 26, w = max > 0 ? Math.max(1, Math.round(bw * r.v / max)) : 1;
    s += '<text class="st-bar-label" x="' + (x0 - 6) + '" y="' + (y + 9) + '" text-anchor="end">' + esc(r.k) + '</text>';
    s += '<rect x="' + x0 + '" y="' + y + '" width="' + w + '" height="13" rx="3" fill="var(--ui-accent)" opacity="' + (0.55 + 0.45 * r.v / (max || 1)) + '"/>';
    s += '<text class="st-bar-val" x="' + (x0 + w + 5) + '" y="' + (y + 10) + '">' + comma(r.v) + '</text>';
  });
  return s + '</svg>';
}

function chartPosts(d) {
  var buckets = [
    { k: "1 条", lo: 1, hi: 1 }, { k: "2-5 条", lo: 2, hi: 5 },
    { k: "6-20 条", lo: 6, hi: 20 }, { k: "21-100 条", lo: 21, hi: 100 }, { k: "100+ 条", lo: 101, hi: Infinity }
  ];
  var counts = buckets.map(function () { return 0; });
  var era = d.era;
  d.nodes.forEach(function (n) {
    var v = era === "pe" ? (n.vpe || 0) : era === "br" ? (n.vbr || 0) : ((n.vpe || 0) + (n.vbr || 0));
    for (var i = 0; i < buckets.length; i++) if (v >= buckets[i].lo && v <= buckets[i].hi) { counts[i]++; break; }
  });
  var rows = buckets.map(function (b, i) { return { k: b.k, v: counts[i] }; });
  var total = d.nodes.length;
  note.textContent = "共 " + comma(total) + " 位创作者，按投稿数分档；投稿数为命中主题的统计，非空间全量。";
  chart.innerHTML = bars(rows, Math.max.apply(null, counts.concat([1])), "人");
}

function chartDegree(d) {
  var deg = {};
  var ids = {};
  d.nodes.forEach(function (n) { ids[String(n.id)] = 1; });
  d.links.forEach(function (l) {
    var a = String(l.source), b = String(l.target);
    if (ids[a]) deg[a] = (deg[a] || 0) + 1;
    if (ids[b]) deg[b] = (deg[b] || 0) + 1;
  });
  var buckets = [
    { k: "0 合作", lo: 0, hi: 0 }, { k: "1 合作", lo: 1, hi: 1 },
    { k: "2-5", lo: 2, hi: 5 }, { k: "6-20", lo: 6, hi: 20 }, { k: "20+", lo: 21, hi: Infinity }
  ];
  var counts = buckets.map(function () { return 0; });
  d.nodes.forEach(function (n) {
    var g = deg[String(n.id)] || 0;
    for (var i = 0; i < buckets.length; i++) if (g >= buckets[i].lo && g <= buckets[i].hi) { counts[i]++; break; }
  });
  var rows = buckets.map(function (b, i) { return { k: b.k, v: counts[i] }; });
  var linked = d.nodes.length - counts[0];
  note.textContent = comma(linked) + " 位有合作关系（占 " + (d.nodes.length ? Math.round(linked / d.nodes.length * 100) : 0) + "%）；按每人的合作边数分档。";
  chart.innerHTML = bars(rows, Math.max.apply(null, counts.concat([1])), "人");
}

function chartLink(d) {
  var j1 = 0, j0 = 0;
  d.links.forEach(function (l) { if (l.j) j1++; else j0++; });
  var total = d.links.length || 1;
  var p1 = Math.round(j1 / total * 100);
  var s = '<svg viewBox="0 0 280 120" width="100%" role="img">';
  s += '<rect x="20" y="30" width="' + Math.round(240 * j1 / total) + '" height="30" rx="4" fill="var(--ui-accent)"/>';
  s += '<rect x="' + (20 + Math.round(240 * j1 / total)) + '" y="30" width="' + Math.round(240 * j0 / total) + '" height="30" rx="4" fill="var(--ui-gold)" opacity=".7"/>';
  s += '<text class="st-bar-val" x="20" y="22">联投 ' + comma(j1) + ' 条 (' + p1 + '%)</text>';
  s += '<text class="st-bar-val" x="20" y="80">@提及 ' + comma(j0) + ' 条 (' + (100 - p1) + '%)</text>';
  s += '<text class="st-bar-label" x="20" y="102">联投=双方互相合作，@提及=文字提及关联</text>';
  chart.innerHTML = s + '</svg>';
  note.textContent = "共 " + comma(d.links.length) + " 条合作关系；联投代表更深的协作。";
}

function chartComm(d) {
  if (!app.groupInfo || !app.focusGroup) { note.textContent = "当前无社区数据"; chart.innerHTML = ""; return; }
  note.textContent = "加载社区分组…";
  loadComm(function (groups) {
    if (!groups || groups.length !== app.allNodes().length) {
      note.textContent = "社区布局缺失或与图谱不匹配，无法绘制社区地图。";
      chart.innerHTML = ""; return;
    }
    // 按当前时代节点在 full nodes 里的下标映射 group
    var era = d.era, idxMap = [], i;
    var all = app.allNodes();
    for (i = 0; i < all.length; i++) if (era === "all" || all[i][era]) idxMap.push(i);
    var cnt = {};
    idxMap.forEach(function (gi) { var g = groups[gi]; cnt[g] = (cnt[g] || 0) + 1; });
    var list = Object.keys(cnt).map(function (g) { return { g: +g, n: cnt[g] }; });
    list.sort(function (a, b) { return b.n - a.n; });
    var top = list.slice(0, 18);
    var max = top.length ? top[0].n : 1;
    var R = 14, cols = 6, W = 280, H = Math.ceil(top.length / cols) * 40 + 6;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img">';
    top.forEach(function (c, i) {
      var x = 22 + (i % cols) * 46, y = 20 + Math.floor(i / cols) * 40;
      var r = Math.max(6, Math.round(R * Math.sqrt(c.n / max)));
      s += '<g class="st-bubble" data-g="' + c.g + '">';
      s += '<title>社区 ' + esc(c.g) + ' · ' + c.n + ' 人（点击高亮）</title>';
      s += '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="var(--ui-accent)" opacity="' + (0.4 + 0.5 * c.n / max) + '"/>';
      s += '<text class="st-bar-val" x="' + x + '" y="' + (y + 3) + '" text-anchor="middle">' + c.n + '</text>';
      s += '</g>';
    });
    chart.innerHTML = s + '</svg>';
    Array.prototype.forEach.call(chart.querySelectorAll(".st-bubble"), function (b) {
      b.addEventListener("click", function () {
        var g = +b.dataset.g;
        var sel = $("layoutSelect");
        // focusGroup 只在「社区」布局下生效。切分区后 app 内部会重置为 flat，
        // 但下拉框值可能仍停在 comm（显示与内部状态不一致），所以不能只看下拉框值：
        // 先试一次，失败就强制重设下拉框并派发 change 重新加载当前分区的 comm 布局。
        if (app.focusGroup(g)) return;
        if (sel) { sel.value = "comm"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
        var tries = 0;
        function tryFocus() {
          if (app.focusGroup(g)) return;
          if (++tries < 40) setTimeout(tryFocus, 120);   // 等布局加载完成（最多约5秒）
        }
        setTimeout(tryFocus, 60);
      });
    });
    note.textContent = "共 " + list.length + " 个社区，显示人数最多的 18 个；气泡大小=人数，点击自动切社区布局并高亮该簇。";
  });
}

function render() {
  if (!panel || panel.classList.contains("collapsed") || !app || !app.isReady()) return;
  var d = data();
  if (!d || !d.nodes.length) { note.textContent = "当前视图无数据"; chart.innerHTML = ""; return; }
  var src = sourceKey();
  label.textContent = ({ bedrock: "基岩版", java: "Java版", create: "机械动力" })[src] || src;
  if (curTab === "posts") chartPosts(d);
  else if (curTab === "degree") chartDegree(d);
  else if (curTab === "link") chartLink(d);
  else if (curTab === "comm") chartComm(d);
}

window.GRAPH_STATS = { render: render, tab: function (t) { curTab = t; render(); } };
})();
