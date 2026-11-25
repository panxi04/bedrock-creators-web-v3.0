/* ------------------------------------------------------------------
 * 人物详情卡
 *
 * 点画布上的节点 → 左下角（移动端为底部抽屉）弹出这张卡：
 *   · 头像 / 名字 / UID / 时代
 *   · 该时代投稿数、合作关系数
 *   · 社区布局下显示「所属圈子」，可一键高亮整簇
 *   · 最常合作的 5 个人（按合作次数排序，可点击跳转）
 *   · 看作品 / 加入我的添加 / 聚焦 / 复制 UID
 * 点空白处、切时代或布局、按 Esc 都会关闭。
 * ------------------------------------------------------------------ */
(function () {
"use strict";

var app = window.GRAPH_APP;
function $(id) { return document.getElementById(id); }
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function comma(n) {
  var s = String(Math.round(n || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function firstChar(name) {
  return (String(name || "?").trim().charAt(0) || "?");
}
function note(msg, ms) {
  if (window.GRAPH_ONLINE && window.GRAPH_ONLINE.toast) window.GRAPH_ONLINE.toast(msg, ms);
}

var box = null, curId = null, curInfo = null, lastOpenAt = 0;

// UID → 分区标记映射（b=基岩版 j=Java版 c=机械动力），按需加载一次
var uidTopics = null, topicsLoading = null;
var TOPIC_NAMES = { b: "基岩版", j: "Java版", c: "机械动力" };
function loadUidTopics() {
  if (uidTopics) return Promise.resolve(uidTopics);
  if (topicsLoading) return topicsLoading;
  topicsLoading = new Promise(function (resolve) {
    if (location.protocol !== "file:") {
      fetch("data/uid_topics.json").then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { uidTopics = d || {}; resolve(uidTopics); })
        .catch(function () { uidTopics = {}; resolve(uidTopics); });
    } else {
      var s = document.createElement("script");
      s.src = "data/uid_topics.bundle.js";
      s.onload = function () { uidTopics = window.UID_TOPICS || {}; s.parentNode && s.parentNode.removeChild(s); resolve(uidTopics); };
      s.onerror = function () { uidTopics = {}; s.parentNode && s.parentNode.removeChild(s); resolve(uidTopics); };
      document.head.appendChild(s);
    }
  });
  return topicsLoading;
}
// 给详情卡和搜索结果共用的分区文案：实际收录的所有分区，如「基岩版 · Java版」
function topicLabel(id) {
  return loadUidTopics().then(function (m) {
    var flags = m[String(id)] || "";
    var names = [];
    for (var i = 0; i < flags.length; i++) if (TOPIC_NAMES[flags[i]]) names.push(TOPIC_NAMES[flags[i]]);
    return names.length ? names.join(" · ") : "未收录";
  });
}
function showTopics(id) {
  var el = $("dtEra");
  topicLabel(id).then(function (text) {
    if (!el || String(curId) !== String(id)) return;   // 卡片已切换则丢弃过期结果
    el.textContent = text;
  });
}

function fill(info) {
  $("dtFace").innerHTML = info.face
    ? '<img src="' + esc(info.face) + '" referrerpolicy="no-referrer" alt="">'
    : esc(firstChar(info.name));
  $("dtName").textContent = info.name || ("UID " + info.id);
  $("dtUid").textContent = "UID " + info.id;
  $("dtEra").textContent = "分区读取中…";
  showTopics(info.id);   // 异步填充分区（该UID实际收录的所有分区）

  var posts = info.era === "pe" ? info.vpe : (info.era === "br" ? info.vbr : info.vpe + info.vbr);
  $("dtPosts").textContent = comma(posts);
  $("dtLinks").textContent = comma(info.degree);

  // 社区布局才有簇信息
  var sec = $("dtGroupSec"), gi = app.groupInfo(info.id);
  if (gi && gi.size > 1) {
    sec.hidden = false;
    var btn = $("dtGroup");
    btn.dataset.g = gi.g;
    btn.classList.remove("on");
    btn.textContent = "簇 #" + gi.g + " · " + comma(gi.size) + " 人" +
      (gi.core ? " · 核心 " + gi.core.name : "");
  } else {
    sec.hidden = true;
  }

  var nb = app.neighbors(info.id, 5), top = $("dtTop");
  if (!nb.length) {
    top.innerHTML = '<p class="dt-empty">还没有合作关系</p>';
  } else {
    top.innerHTML = nb.map(function (x) {
      var av = x.face
        ? '<img src="' + esc(x.face) + '" referrerpolicy="no-referrer" alt="">'
        : esc(firstChar(x.name));
      return '<button type="button" data-id="' + esc(x.id) + '">' +
        '<span class="dt-av">' + av + '</span>' +
        '<span class="dt-nm">' + esc(x.name) + '</span>' +
        '<span class="dt-j">' + comma(x.j) + ' 次</span></button>';
    }).join("");
  }

  var on = !!(window.GRAPH_ONLINE && window.GRAPH_ONLINE.isFav(info.id));
  $("dtFav").classList.toggle("on", on);
  $("dtFav").textContent = on ? "已加入我的添加" : "加入我的添加";
}

// 桌面端把卡片放到 HUD 下方，跟着 HUD 实际高度走（移动端由 CSS 固定在底部抽屉）
function place() {
  if (!box) return;
  if (window.innerWidth <= 640) { box.style.top = ""; return; }
  var hud = document.querySelector(".hud");
  if (!hud) return;
  var top = hud.getBoundingClientRect().bottom + 12;
  var maxTop = window.innerHeight - 230;
  box.style.top = Math.round(Math.max(72, Math.min(top, maxTop))) + "px";
}

function open(id) {
  if (!app || !app.info) return;
  var info = app.info(id);
  if (!info) { close(); return; }
  curId = info.id;
  curInfo = info;
  lastOpenAt = Date.now();
  fill(info);
  box.hidden = false;
  box.scrollTop = 0;
  place();
  // 详情卡与统计面板都在左侧，同时展开会重叠；打开详情卡时收起统计面板（随时可再展开）
  if (document.body.classList.contains("stats-open")) {
    var sp = document.getElementById("statsPanel"), sh = document.getElementById("stHead");
    if (sp && sh) { sp.classList.add("collapsed"); document.body.classList.remove("stats-open"); sh.setAttribute("aria-expanded", "false"); }
  }
}

window.addEventListener("resize", function () { if (box && !box.hidden) place(); });

function close() {
  if (!box || box.hidden) return;
  box.hidden = true;
  curId = null;
  curInfo = null;
}

function bind() {
  box = $("detail");
  if (!box) return;

  $("dtClose").addEventListener("click", close);

  $("dtWorks").addEventListener("click", function () {
    if (!curId) return;
    if (window.GRAPH_ONLINE) window.GRAPH_ONLINE.openWorks(curId);
    else note("联网模块还没加载好");
  });

  $("dtFav").addEventListener("click", function () {
    if (!curInfo || !window.GRAPH_ONLINE) return;
    var added = window.GRAPH_ONLINE.toggleFav(curInfo.id, { id: curInfo.id, name: curInfo.name, face: curInfo.face });
    this.classList.toggle("on", !!added);
    this.textContent = added ? "已加入我的添加" : "加入我的添加";
  });

  $("dtFocus").addEventListener("click", function () {
    if (!curId) return;
    app.openCreator(curId);
  });

  $("dtCopy").addEventListener("click", function () {
    if (!curId) return;
    var text = String(curId);
    function done(ok) { note(ok ? "已复制 UID：" + text : "复制失败：" + text, 2200); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacy(text)); });
    } else done(legacy(text));
  });

  $("dtTop").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-id]");
    if (!b) return;
    app.openCreator(b.dataset.id);
    open(b.dataset.id);
  });

  $("dtGroup").addEventListener("click", function () {
    var g = +this.dataset.g;
    if (isNaN(g)) return;
    if (app.focusGroup(g)) {
      this.classList.add("on");
      note("已高亮簇 #" + g, 1800);
    }
  });

  // 画布点击：点了节点就换人，点空白就收起
  window.addEventListener("graph:pick", function (ev) {
    var id = ev.detail && ev.detail.id;
    if (!id) { close(); return; }
    if (id === curId && box && !box.hidden) {
      // 双击节点时第二次点击会落在这里：短时间内不当作"再点一次收起"
      if (Date.now() - lastOpenAt > 450) close();
      return;
    }
    open(id);
  });

  // 切时代 / 切布局后节点重建，旧卡片数据失效
  window.addEventListener("graph:view", close);

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && box && !box.hidden) close();
  }, true);
}

function legacy(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

if (app.isReady()) bind();
else app.onReady(bind);

// 供其它模块（例如排行榜点行）复用
window.GRAPH_DETAIL = { open: open, close: close, topicLabel: topicLabel };
})();
