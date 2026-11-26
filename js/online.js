/* ------------------------------------------------------------------
 * 联网增强（新增）
 *
 * 1) 联网搜索 / 添加 UP
 *    · 「在 B 站搜索」用 window.open 调起本地浏览器打开 B 站搜索页（已登录状态最好用）
 *    · 也可以粘贴 UID / 空间链接直接加进「我的添加」，名字头像与名单存在 localStorage
 * 2) 右键创作者 → 作品信息（AV/BV 号、标题、封面、播放量），卡片超链接到 B 站详情页
 *
 * 浏览器无法直接读 api.bilibili.com（不返回 CORS 头、外来 Origin 直接 403），
 * 因此实时数据经由「graph-server.exe」内置的本地服务（127.0.0.1:8788）转发；
 * 未启动管理器时全部降级为唤起浏览器打开 B 站对应页面，功能不阻塞。
 * ------------------------------------------------------------------ */
(function () {
"use strict";

var app = window.GRAPH_APP;
var HELPER_DEFAULT = "http://127.0.0.1:8788";
var K_FAV = "bedrock.favs.v1";
var K_HELPER = "bedrock.helper.v1";
var K_VCACHE = "bedrock.vcache.v1";

function $(id) { return document.getElementById(id); }
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
function readJSON(k, def) {
  try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : def; } catch (e) { return def; }
}
function writeJSON(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
}
function fmtNum(n) {
  n = +n || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + " 亿";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return String(n);
}
function fmtDur(s) {
  s = Math.max(0, +s || 0);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0");
}
function fmtDate(ts) {
  if (!ts) return "";
  var d = new Date(ts * 1000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* ================= 我的添加（localStorage） ================= */
var favs = readJSON(K_FAV, []);
if (!Array.isArray(favs)) favs = [];
var favMap = {};
function rebuildFavMap() {
  favMap = {};
  favs.forEach(function (f) { favMap[f.id] = f; });
}
rebuildFavMap();

function saveFavs() {
  writeJSON(K_FAV, favs);
  rebuildFavMap();
  if (app.setFavorites) app.setFavorites(favs.map(function (f) { return f.id; }));
  if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH();
  window.dispatchEvent(new CustomEvent("graph:favs"));
}
function isFav(id) { return !!favMap[String(id)]; }
function favOf(id) { return favMap[String(id)] || null; }

function putFav(rec) {
  var old = favMap[rec.id];
  if (old) { rec.addedAt = old.addedAt; rec.faceData = rec.faceData || old.faceData; }
  else rec.addedAt = Date.now();
  if (old) { favs[favs.indexOf(old)] = rec; } else { favs.push(rec); }
  saveFavs();
  return rec;
}
function removeFav(id) {
  var f = favMap[String(id)];
  if (!f) return;
  favs.splice(favs.indexOf(f), 1);
  saveFavs();
}
function toggleFav(id, fallback) {
  if (isFav(id)) { removeFav(id); return false; }
  var node = app.nodeById(id) || fallback || { id: String(id), name: "UID " + id, face: "" };
  var rec = putFav({ id: String(id), name: node.name || ("UID " + id), face: faceUrl(node.face), src: node.name ? "graph" : "unresolved" });
  cacheFace(rec);
  return true;
}

/* 头像本地化：经助手取图后压到 96px 存进 localStorage，断网也能显示 */
function downscale(blob, size) {
  return new Promise(function (resolve) {
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement("canvas");
        c.width = c.height = size;
        var g = c.getContext("2d");
        var s = Math.min(img.width, img.height);
        g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(c.toDataURL("image/jpeg", 0.82));
      } catch (e) { resolve(""); }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { URL.revokeObjectURL(url); resolve(""); };
    img.src = url;
  });
}
function cacheFace(rec) {
  if (!rec.face || rec.faceData || !online.helper) return;
  fetch(helperBase() + "/img?u=" + encodeURIComponent(rec.face))
    .then(function (r) { if (!r.ok) throw new Error("img"); return r.blob(); })
    .then(function (b) { return downscale(b, 96); })
    .then(function (d) {
      if (!d) return;
      var f = favMap[rec.id];
      if (!f) return;
      f.faceData = d;
      writeJSON(K_FAV, favs);
      if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH();
    })
    .catch(function () { /* 头像缓存失败不影响功能 */ });
}

/* ================= 助手通道（协议自适应） =================
 * file:// 双击本地打开 → 连本地管理器 exe（127.0.0.1:8788，localStorage 可覆盖）
 * http(s) 上线/反代   → 走同源相对路径 ""，请求 /ping /search 等由反代转发，
 *                       不暴露后端地址；忽略 localStorage 里残留的旧本地地址。
 */
function helperBase() {
  if (location.protocol !== "file:") return "";   // 同源相对路径，反代生效
  var h = readJSON(K_HELPER, HELPER_DEFAULT);
  if (typeof h !== "string" || !/^https?:\/\//.test(h)) h = HELPER_DEFAULT;
  return h.replace(/\/+$/, "");
}

var online = { helper: false, checked: false, busy: false, message: "" };

function call(path, timeoutMs) {
  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = setTimeout(function () { if (ac) ac.abort(); }, timeoutMs || 9000);
  return fetch(helperBase() + path, { signal: ac ? ac.signal : undefined, cache: "no-store" })
    .then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .catch(function (e) {
      clearTimeout(timer);
      return { ok: false, offline: true, message: (e && e.name === "AbortError") ? "请求超时" : "助手未连接" };
    });
}
function probe() {
  if (online.busy) return Promise.resolve(online.helper);
  online.busy = true;
  return call("/ping", 1500).then(function (r) {
    online.busy = false;
    online.checked = true;
    online.helper = !!r.ok;
    online.message = r.ok ? "" : (r.message || "助手未连接");
    paintStatus();
    return online.helper;
  });
}
function statusText() {
  if (!online.checked) return "联网功能检测中…";
  return online.helper ? "graph-server 已连接" : "请打开 graph-server.exe（当前仅可跳转 B 站）";
}
function paintStatus() {
  var nodes = document.querySelectorAll("[data-net-status]");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].textContent = statusText();
    nodes[i].className = "net-status " + (online.helper ? "on" : (online.checked ? "off" : ""));
  }
  if (typeof updateButtons === "function") updateButtons();
  if (typeof paintHelperBtn === "function") paintHelperBtn();
}

/* ================= B 站链接 ================= */
function spaceUrl(id) { return "https://space.bilibili.com/" + id + "/video"; }
function searchUrl(q) { return "https://search.bilibili.com/upuser?keyword=" + encodeURIComponent(q); }
function videoUrl(bv) { return "https://www.bilibili.com/video/" + bv; }
function openExternal(url) {
  var w = window.open(url, "_blank", "noopener");
  if (w) w.opener = null;
}

/* ================= 作品弹窗 ================= */
var vcache = readJSON(K_VCACHE, {});
if (!vcache || typeof vcache !== "object") vcache = {};
var VC_TTL = 6 * 3600 * 1000;

function vcacheGet(id) {
  var hit = vcache[id];
  if (!hit) return null;
  if (Date.now() - hit.ts > VC_TTL) { delete vcache[id]; return null; }
  return hit;
}
function vcacheSet(id, card, items) {
  vcache[id] = { ts: Date.now(), card: card || null, items: items || [] };
  var keys = Object.keys(vcache);
  if (keys.length > 60) { for (var i = 0; i < keys.length - 40; i++) delete vcache[keys[i]]; }
  writeJSON(K_VCACHE, vcache);
}

var workModal = $("workModal"), workBody = $("workBody");
var workCtx = { id: null };

function showModal(el) { if (el) { el.classList.add("open"); el.setAttribute("aria-hidden", "false"); } }
function hideModal(el) { if (el) { el.classList.remove("open"); el.setAttribute("aria-hidden", "true"); } }

function openWorks(id, name, face) {
  id = String(id);
  if (app.hideTip) app.hideTip();
  hideCtx();
  var node = app.nodeById(id);
  name = name || (node && node.name) || (favOf(id) && favOf(id).name) || ("UID " + id);
  face = faceUrl(face || (node && node.face) || (favOf(id) && favOf(id).face) || "");
  workCtx.id = id;
  $("workName").textContent = name;
  $("workMeta").textContent = "UID " + id + (favOf(id) ? " · ★ 已添加" : "");
  var img = $("workFace");
  if (face) { img.src = face; img.style.display = ""; } else { img.removeAttribute("src"); img.style.display = "none"; }
  $("workSpace").href = spaceUrl(id);
  $("workSearch").href = searchUrl(name === "UID " + id ? id : name);
  $("workAdd").textContent = isFav(id) ? "从我的添加移除" : "加入我的添加";
  $("workAdd").dataset.id = id;
  showModal(workModal);
  loadWorks(id);
}

function loadWorks(id) {
  var hit = vcacheGet(id);
  if (hit) { renderWorks(hit); return; }
  workBody.innerHTML = '<div class="wk-state">正在读取 B 站作品…</div>';
  paintStatus();
  probe().then(function (ok) {
    if (id !== workCtx.id) return;
    if (!ok) { renderNeedHelper(); return; }
    Promise.all([call("/videos?mid=" + id + "&ps=12"), call("/card?mid=" + id)]).then(function (rs) {
      if (id !== workCtx.id) return;
      var v = rs[0], c = rs[1];
      if (!v.ok) {
        workBody.innerHTML = '<div class="wk-state">读取失败：' + escapeHtml(v.message || ("code " + v.code)) +
          '<br><span>可能是 B 站频率限制，稍后重试</span></div>' +
          '<div class="wk-state"><button class="g-btn" id="wkRetry">重试</button></div>';
        var b = $("wkRetry");
        if (b) b.addEventListener("click", function () { delete vcache[id]; loadWorks(id); });
        return;
      }
      vcacheSet(id, c && c.ok ? c.data : null, v.data.items);
      renderWorks(vcache[id]);
    });
  });
}

/* 未连上助手时，每 4 秒轻探一次，一旦连上自动继续（最多等 ~48 秒） */
var watcher = 0;
function paintWait(left) {
  var nodes = document.querySelectorAll("[data-net-wait]");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].textContent = left == null ? "" : "正在等待助手启动…（还会检测 " + left + " 次）";
  }
}
function watchHelper(onUp, tries) {
  if (watcher) { clearInterval(watcher); watcher = 0; }
  var left = tries || 12;
  function tick() {
    if (document.hidden) return;
    if (left <= 0) {
      clearInterval(watcher); watcher = 0; paintWait(null);
      waiting = false; paintHelperBtn();
      var pop = document.getElementById("helperPop");
      if (pop && !pop.hidden) {
        var w = pop.querySelector("[data-net-wait]");
        if (w) w.textContent = "超过 1 分钟没检测到，确认脚本已运行后再点「重新检测」";
      }
      return;
    }
    paintWait(left--);
    call("/ping", 1200).then(function (r) {
      if (!r.ok) return;
      clearInterval(watcher); watcher = 0;
      online.helper = true; online.checked = true; online.message = "";
      waiting = false;
      paintStatus(); paintWait(null); paintHelperBtn();
      if (onUp) onUp();
    });
  }
  tick();
  watcher = setInterval(tick, 4000);
}

function renderNeedHelper() {
  workBody.innerHTML =
    '<div class="wk-state"><b>请打开 graph-server.exe</b>' +
    '<p>浏览器无法直接读取 B 站接口（B 站不开放跨域），读取作品由「graph-server.exe」统一提供。</p>' +
    '<p class="wk-cmd">双击与本页同目录的 <b>graph-server.exe</b>，保持窗口开启即可联网搜人、看作品。</p>' +
    '<p class="wk-dim" data-net-wait></p></div>' +
    '<div class="wk-state">' +
    '<button class="g-btn" id="wkRetry">已启动，重新检测</button></div>';
  var b = $("wkRetry");
  if (b) b.addEventListener("click", function () {
    online.checked = false;
    loadWorks(workCtx.id);
  });
  paintStatus();
  watchHelper(function () { if (workCtx.id) loadWorks(workCtx.id); });
}

function renderWorks(hit) {
  var card = hit.card || null, items = hit.items || [];
  var head = "";
  if (card) {
    $("workName").textContent = card.name || $("workName").textContent;
    if (card.face) { var im = $("workFace"); im.src = faceUrl(card.face); im.style.display = ""; }
    $("workMeta").textContent = "UID " + card.mid + " · Lv" + (card.level || "?") +
      " · " + fmtNum(card.fans) + " 粉丝 · " + fmtNum(card.archive) + " 个投稿" + (favOf(card.mid) ? " · ★ 已添加" : "");
    if (card.sign) head = '<div class="wk-sign">' + escapeHtml(card.sign.replace(/\n/g, " ")) + "</div>";
  }
  if (!items.length) {
    workBody.innerHTML = head + '<div class="wk-state">没有取到投稿（可能该 UP 投稿不可见，或接口限流）</div>';
    return;
  }
  var html = head + '<div class="wk-grid">';
  items.forEach(function (v) {
    var cover = faceUrl(v.pic);
    html += '<a class="wk-card" href="' + videoUrl(v.bvid) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="wk-pic">' +
      (cover ? '<img src="' + escapeHtml(cover) + '" referrerpolicy="no-referrer" loading="lazy" alt="">' : "") +
      '<em>' + fmtDur(v.duration) + "</em></span>" +
      "<b>" + escapeHtml(v.title) + "</b>" +
      '<span class="wk-meta">' + escapeHtml(v.bvid) + " · av" + v.aid + " · " +
      fmtNum(v.view) + " 播放 · " + fmtDate(v.pubdate) + "</span></a>";
  });
  html += "</div>";
  workBody.innerHTML = html;
}

/* ================= 右键菜单 ================= */
var ctxMenu = $("ctxMenu");

function openCtx(d) {
  if (!d || !d.id) return;
  var id = String(d.id);
  var fav = isFav(id);
  var items = [
    { k: "detail", t: "查看简介卡片" },
    { k: "works", t: "查看作品（联网）" },
    { k: "fav", t: fav ? "从我的添加中移除" : "加入我的添加" },
    { k: "space", t: "在 B 站打开空间 ↗" },
    { k: "copy", t: "复制 UID" }
  ];
  ctxMenu.innerHTML = items.map(function (it) {
    return '<button class="ctx-item" data-k="' + it.k + '" data-id="' + escapeHtml(id) + '" data-name="' +
      escapeHtml(d.name || "") + '" data-face="' + escapeHtml(d.face || "") + '">' + it.t + "</button>";
  }).join("");
  ctxMenu.hidden = false;
  var w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  var x = Math.max(8, Math.min(d.x, window.innerWidth - w - 8));
  var y = Math.max(8, Math.min(d.y, window.innerHeight - h - 8));
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
}
function hideCtx() { ctxMenu.hidden = true; }

ctxMenu.addEventListener("pointerdown", function (ev) {
  var btn = ev.target.closest(".ctx-item");
  if (!btn) return;
  ev.preventDefault();
  var id = btn.dataset.id, name = btn.dataset.name, face = btn.dataset.face, k = btn.dataset.k;
  hideCtx();
  if (k === "detail") { if (window.GRAPH_DETAIL) window.GRAPH_DETAIL.open(id); }
  else if (k === "works") openWorks(id, name, face);
  else if (k === "fav") { toggleFav(id, { id: id, name: name, face: face }); if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH(); }
  else if (k === "space") openExternal(spaceUrl(id));
  else if (k === "copy") {
    if (navigator.clipboard) navigator.clipboard.writeText(id).catch(function () {});
  }
});
document.addEventListener("pointerdown", function (ev) {
  if (!ctxMenu.hidden && !ctxMenu.contains(ev.target)) hideCtx();
}, true);
window.addEventListener("resize", hideCtx);
window.addEventListener("blur", hideCtx);

window.addEventListener("graph:nodecontext", function (ev) { openCtx(ev.detail); });

var tipEl = document.getElementById("tip");
if (tipEl) {
  tipEl.addEventListener("contextmenu", function (ev) {
    if (!tipEl.dataset.id) return;
    ev.preventDefault();
    openCtx({ id: tipEl.dataset.id, name: tipEl.dataset.name, face: tipEl.dataset.face, x: ev.clientX, y: ev.clientY });
  });
}

/* ================= 添加 UP 弹窗 ================= */
function extractMid(v) {
  v = String(v || "").trim();
  if (!v) return "";
  var m = v.match(/space\.bilibili\.com\/(\d+)/i) || v.match(/[?&]mid=(\d+)/i) || v.match(/^(\d{3,})$/);
  return m ? m[1] : "";
}

function openAdd(prefill) {
  var input = $("addInput");
  input.value = prefill || "";
  $("addMsg").textContent = "";
  $("addMsg").className = "add-msg";
  showModal($("addModal"));
  paintStatus();
  setTimeout(function () { input.focus(); input.select(); }, 40);
}

function submitAdd() {
  var raw = $("addInput").value;
  var id = extractMid(raw);
  var msg = $("addMsg");
  if (!id) { msg.textContent = "没找到 UID，请粘贴数字 UID 或空间链接"; msg.className = "add-msg err"; return; }
  var node = app.nodeById(id);
  if (node) {
    putFav({ id: id, name: node.name, face: faceUrl(node.face), src: "graph" });
    msg.textContent = "已添加「" + node.name + "」（数据来自本地图谱）";
    msg.className = "add-msg ok";
    if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH();
    return;
  }
  msg.textContent = "本地图谱里没有这个 UID，正在联网补全…";
  msg.className = "add-msg";
  probe().then(function (ok) {
    if (!ok) {
      putFav({ id: id, name: "UID " + id, face: "", src: "unresolved" });
      msg.textContent = "已保存 UID（未联网，名字和头像待补全）";
      msg.className = "add-msg ok";
      if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH();
      return;
    }
    call("/card?mid=" + id).then(function (r) {
      if (r.ok && r.data) {
        var rec = putFav({ id: id, name: r.data.name || ("UID " + id), face: faceUrl(r.data.face), sign: r.data.sign, fans: r.data.fans, src: "live" });
        cacheFace(rec);
        msg.textContent = "已添加「" + rec.name + "」";
        msg.className = "add-msg ok";
      } else {
        msg.textContent = "B 站没有返回这个 UID：" + (r.message || ("code " + r.code));
        msg.className = "add-msg err";
      }
      if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH();
    });
  });
}

/* ================= 我的添加列表 ================= */
function favAvatarHtml(f, cls) {
  var src = f.faceData || f.face;
  if (src) return '<img class="' + cls + '" src="' + escapeHtml(src) + '" referrerpolicy="no-referrer" alt="">';
  return '<span class="' + cls + ' face-fallback">' + escapeHtml((f.name || "?").trim().charAt(0) || "?") + "</span>";
}

function renderFavs() {
  paintStatus();
  if (!favs.length) {
    return {
      html: '<div class="find-empty">「我的添加」还是空的<br><span class="dim">搜索创作者点 ＋ 收藏，或点下面的「＋ 添加 UP」粘贴 UID</span></div>',
      foot: statusText()
    };
  }
  var html = '<div class="fv-head">我的添加 · ' + favs.length + " 位</div>";
  favs.forEach(function (f) {
    var inGraph = !!app.nodeById(f.id);
    html += '<div class="find-row fv-row" data-id="' + escapeHtml(f.id) + '">' +
      favAvatarHtml(f, "find-face") +
      '<span class="find-text"><b>' + escapeHtml(f.name || ("UID " + f.id)) + "</b>" +
      "<span>" + escapeHtml(f.id) + (inGraph ? " · 在图谱中" : (f.src === "unresolved" ? " · 待补全" : " · 仅本地")) + "</span></span>" +
      '<span class="fv-btns">' +
      (inGraph ? '<button class="fv-btn" data-act="locate" data-id="' + escapeHtml(f.id) + '" title="在图中定位">定位</button>' : "") +
      '<button class="fv-btn" data-act="works" data-id="' + escapeHtml(f.id) + '" title="查看作品">作品</button>' +
      '<button class="fv-btn" data-act="space" data-id="' + escapeHtml(f.id) + '" title="打开 B 站空间">空间</button>' +
      '<button class="fv-btn del" data-act="del" data-id="' + escapeHtml(f.id) + '" title="移除">×</button>' +
      "</span></div>";
  });
  return { html: html, foot: statusText() };
}

function handleListAction(ev) {
  var addOn = ev.target.closest("[data-online-add]");
  if (addOn) {
    ev.preventDefault();
    ev.stopPropagation();
    addOnlineFav(addOn.dataset.onlineAdd);
    return true;
  }
  var orow = ev.target.closest(".on-row");
  if (orow && orow.dataset.mid) {
    ev.preventDefault();
    ev.stopPropagation();
    openWorks(orow.dataset.mid);
    return true;
  }
  var act = ev.target.closest("[data-act]");
  if (!act) return false;
  ev.preventDefault();
  ev.stopPropagation();
  var id = act.dataset.id, k = act.dataset.act;
  if (k === "locate") app.openCreator(id);
  else if (k === "works") openWorks(id);
  else if (k === "space") openExternal(spaceUrl(id));
  else if (k === "del") { removeFav(id); if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH(); }
  return true;
}

/* ================= 按名字联网搜人（经助手调 B 站用户搜索） ================= */
var oSearch = { q: "", status: "idle", items: [], error: "" };

function refreshPanel() { if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH(); }
function resetOnline() { oSearch = { q: "", status: "idle", items: [], error: "" }; }
function onlineActive(q) { return !!q && oSearch.q === q && oSearch.status !== "idle"; }

function startOnlineSearch(q) {
  q = (q || "").trim();
  if (!q) return;
  oSearch = { q: q, status: "loading", items: [], error: "" };
  updateButtons();
  refreshPanel();
  probe().then(function (ok) {
    if (oSearch.q !== q) return;
    if (!ok) { oSearch.status = "error"; oSearch.error = "请打开 graph-server.exe，才能在线搜人"; updateButtons(); refreshPanel(); return; }
    call("/search?keyword=" + encodeURIComponent(q) + "&page=1").then(function (r) {
      if (oSearch.q !== q) return;
      if (!r.ok) {
        oSearch.status = "error";
        oSearch.error = r.offline ? "请打开 graph-server.exe" : ("B 站搜索失败：" + (r.message || ("code " + r.code)));
      } else {
        oSearch.status = "done";
        oSearch.items = r.data.items || [];
      }
      updateButtons();
      refreshPanel();
    });
  });
}

function renderOnline() {
  var s = oSearch, q = escapeHtml(s.q);
  if (s.status === "loading") {
    return { html: '<div class="find-empty">正在 B 站搜索「' + q + '」…</div>', foot: "联网数据来自 bilibili.com" };
  }
  if (s.status === "error") {
    return {
      html: '<div class="find-empty">' + escapeHtml(s.error) +
        '<br><span class="dim">可以点「B 站搜索」直接在浏览器里搜</span></div>',
      foot: statusText()
    };
  }
  if (!s.items.length) {
    return { html: '<div class="find-empty">B 站没有搜到「' + q + '」<br><span class="dim">换个关键词，注意别带太多空格</span></div>', foot: statusText() };
  }
  var html = '<div class="fv-head">B 站用户 · ' + s.items.length + " 位 · " + q + "</div>";
  s.items.forEach(function (u) {
    var on = isFav(u.mid), inGraph = !!app.nodeById(u.mid);
    html += '<div class="find-row on-row" data-mid="' + escapeHtml(u.mid) + '">' +
      (u.face ? '<img class="find-face" src="' + escapeHtml(u.face) + '" referrerpolicy="no-referrer" alt="">'
              : '<span class="find-face face-fallback">' + escapeHtml((u.name || "?").charAt(0)) + "</span>") +
      '<span class="find-text"><b>' + escapeHtml(u.name) + "</b><span>" + escapeHtml(u.mid) + " · " +
      fmtNum(u.fans) + " 粉丝 · " + fmtNum(u.videos) + " 投稿" + (inGraph ? " · 在图谱中" : "") + "</span></span>" +
      '<span class="find-add' + (on ? " on" : "") + '" data-online-add="' + escapeHtml(u.mid) + '" title="' +
      (on ? "已在「我的添加」中" : "加入「我的添加」") + '">' + (on ? "★" : "＋") + "</span></div>";
  });
  return { html: html, foot: "点一行看 TA 的作品 · ＋ 加入我的添加" };
}

function addOnlineFav(mid) {
  var u = null;
  oSearch.items.forEach(function (it) { if (String(it.mid) === String(mid)) u = it; });
  if (!u) return;
  if (isFav(u.mid)) { removeFav(u.mid); }
  else {
    putFav({ id: String(u.mid), name: u.name, face: faceUrl(u.face), sign: u.sign, fans: u.fans, videos: u.videos, src: "live" });
    cacheFace(favMap[String(u.mid)]);
  }
  updateButtons();
  refreshPanel();
}

/* ================= 面板上的联网动作 ================= */
var biliBtn = $("findBiliBtn"), onlineBtn = $("findOnlineBtn");
var backBtn = $("findBackBtn"), addBtn = $("findAddBtn");
var lastQ = "";

function updateButtons() {
  if (!biliBtn) return;
  var q = lastQ, act = onlineActive(q);
  biliBtn.hidden = !q;
  biliBtn.textContent = "B 站搜索 ↗";
  biliBtn.title = q ? "在浏览器里打开 B 站搜索「" + q + "」" : "";
  biliBtn.dataset.q = q;
  if (onlineBtn) onlineBtn.hidden = !q || !online.helper || act;
  if (backBtn) backBtn.hidden = !act;
  if (addBtn) addBtn.hidden = false;
}
function onQuery(q) {
  if (q !== oSearch.q && oSearch.status !== "idle") resetOnline();
  lastQ = q || "";
  updateButtons();
}
if (biliBtn) biliBtn.addEventListener("click", function () {
  var q = biliBtn.dataset.q;
  openExternal(q ? searchUrl(q) : "https://search.bilibili.com/");
});
if (onlineBtn) onlineBtn.addEventListener("click", function () {
  if (!lastQ) return;
  startOnlineSearch(lastQ);
  var i = document.getElementById("findInput");
  if (i) i.focus();
});
if (backBtn) backBtn.addEventListener("click", function () {
  resetOnline();
  updateButtons();
  refreshPanel();
});
if (addBtn) addBtn.addEventListener("click", function () { openAdd(""); });

/* ================= 弹窗通用事件 ================= */
["workModal", "addModal"].forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener("pointerdown", function (ev) {
    if (ev.target === el) hideModal(el);
  });
  el.querySelectorAll("[data-close]").forEach(function (b) {
    b.addEventListener("click", function () { hideModal(el); });
  });
});
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Escape") return;
  if (workModal.classList.contains("open")) { hideModal(workModal); return; }
  if ($("addModal").classList.contains("open")) hideModal($("addModal"));
});
var workAddBtn = $("workAdd");
if (workAddBtn) workAddBtn.addEventListener("click", function () {
  var id = workAddBtn.dataset.id;
  if (!id) return;
  if (isFav(id)) { removeFav(id); workAddBtn.textContent = "加入我的添加"; }
  else {
    toggleFav(id, { id: id, name: $("workName").textContent, face: $("workFace").getAttribute("src") || "" });
    workAddBtn.textContent = "从我的添加移除";
  }
  var meta = $("workMeta").textContent.replace(/ · ★ 已添加$/, "");
  $("workMeta").textContent = meta + (isFav(id) ? " · ★ 已添加" : "");
  if (window.GRAPH_REFRESH_SEARCH) window.GRAPH_REFRESH_SEARCH();
});
var addSubmit = $("addSubmit");
if (addSubmit) addSubmit.addEventListener("click", submitAdd);
var addInput = $("addInput");
if (addInput) addInput.addEventListener("keydown", function (ev) {
  if (ev.key === "Enter") { ev.preventDefault(); submitAdd(); }
});

/* ================= 搜索栏里的「启动助手」按钮 ================= */
var helperBtn = $("helperBtn");
var helperPop = $("helperPop");
var waiting = false;

function toast(msg, ms) {
  var t = $("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove("show"); }, ms || 3200);
}
function paintHelperBtn() {
  if (!helperBtn) return;
  helperBtn.classList.toggle("on", !!online.helper);
  helperBtn.classList.toggle("wait", !online.helper && waiting);
  helperBtn.title = online.helper ? "graph-server 已连接（点击重新检测）" : "请打开 graph-server.exe";
}

function setPop(open) {
  if (!helperPop) return;
  helperPop.hidden = !open;
  if (open) {
    var fp = $("findPanel");
    if (fp) fp.hidden = true;
    var fi = $("findInput");
    if (fi) fi.blur();
  } else {
    paintWait(null);
  }
}
function launchHelper() {
  if (online.helper) { probe().then(paintHelperBtn); toast("graph-server 已连接", 1800); return; }
  // 浏览器不允许网页执行本地程序，这里不再尝试 window.open（只会开出空标签页/下载），
  // 直接把启动方式摆出来，并持续轮询：用户一启动，面板自动收起。
  setPop(true);
  waiting = true;
  paintHelperBtn();
  watchHelper(function () {
    waiting = false;
    paintHelperBtn();
    setPop(false);
    toast("graph-server 已连接", 2500);
    if (workCtx.id && workModal.classList.contains("open")) loadWorks(workCtx.id);
  }, 15);
}
if (helperBtn) {
  helperBtn.addEventListener("click", launchHelper);
  paintHelperBtn();
}
if (helperPop) {
  $("hpClose").addEventListener("click", function () { setPop(false); });
  $("hpRetry").addEventListener("click", function () {
    online.checked = false;
    probe().then(function (ok) {
      if (ok) { setPop(false); toast("graph-server 已连接", 2500); }
      else toast("还没检测到助手，确认窗口里的脚本已经跑起来了", 4000);
    });
  });
  document.addEventListener("pointerdown", function (ev) {
    if (helperPop.hidden) return;
    if (helperPop.contains(ev.target) || (helperBtn && helperBtn.contains(ev.target))) return;
    setPop(false);
  });
  var fi = $("findInput");
  if (fi) fi.addEventListener("focus", function () { setPop(false); });
}

/* ================= 对外接口 ================= */
window.GRAPH_ONLINE = {
  isFav: isFav,
  toggleFav: toggleFav,
  dropFav: removeFav,
  favCount: function () { return favs.length; },
  onQuery: onQuery,
  renderFavs: renderFavs,
  handleListAction: handleListAction,
  openAdd: openAdd,
  openWorks: openWorks,
  statusText: statusText,
  helperBase: helperBase,
  isOnline: function () { return online.helper; },
  onlineActive: onlineActive,
  renderOnline: renderOnline,
  startOnlineSearch: startOnlineSearch,
  toast: toast
};

/* 首次启动：同步图上的收藏标记 + 探测助手（失败则静默重试几次，覆盖助手刚启动的场景） */
if (app.setFavorites && favs.length) app.setFavorites(favs.map(function (f) { return f.id; }));
probe().then(function (ok) {
  if (!ok) watchHelper(null, 4);
});
})();
