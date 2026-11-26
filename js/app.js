(function () {
"use strict";

/* ------------------------------------------------------------------
 * 数据加载：两种运行方式共用同一份数据
 *   http(s)  -> fetch data/bedrock.json、data/layouts_bedrock/*.json
 *   file://  -> 本地 fetch 被同源策略拦截，自动回退到同名 *.bundle.js
 *               （script 标签不受该限制，内容与 JSON 完全一致）
 * ------------------------------------------------------------------ */
var DATA_DIR = "data/";
var FILE_MODE = location.protocol === "file:";
var GRAPH = null;
var GRAPH_SOURCE = "bedrock.json";     // 当前读取的 data/*.json（基岩版由抓取写入 bedrock.json）
// 每份图谱用各自的预计算布局目录，三分区完全独立
var LAYOUT_DIRS = { "bedrock.json": "data/layouts_bedrock/", "java.json": "data/layouts_java/",
                    "create.json": "data/layouts_create/" };
var LAYOUT_DIR = LAYOUT_DIRS[GRAPH_SOURCE];

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    var el = document.createElement("script");
    el.src = src;
    el.onload = function () { el.parentNode && el.parentNode.removeChild(el); resolve(); };
    el.onerror = function () { el.parentNode && el.parentNode.removeChild(el); reject(new Error("无法加载 " + src)); };
    document.head.appendChild(el);
  });
}
function takeBundle(key) {
  var d = window[key];
  try { window[key] = undefined; } catch (e) { /* ignore */ }
  if (!d) throw new Error("bundle 缺失");
  return d;
}
// 三分区统一用 GRAPH_SOURCE 这个 bundle 变量、同名 .bundle.js 文件
function sourceBundleKey(name) { return "GRAPH_SOURCE"; }
function sourceBundleFile(name) { return name.replace(/\.json$/, ".bundle.js"); }
// 时代切换按钮已从页面移除：三个分区统一使用「全部」视图，这里只更新说明文字
function applyEraUIForSource(name) {
  era = "all";
  if (name === "bedrock.json") eraDesc.textContent = ERA_INFO.all;
  else eraDesc.textContent = "联合投稿 + @提及 · " + (name === "java.json" ? "Java版" : "机械动力");
}

function loadGraph(name) {
  name = name || GRAPH_SOURCE;
  GRAPH_SOURCE = name;
  LAYOUT_DIR = LAYOUT_DIRS[name];
  applyEraUIForSource(name);
  if (!FILE_MODE) {
    return fetch(DATA_DIR + name).then(function (r) {
      if (!r.ok) throw new Error(name + " " + r.status);
      return r.json();
    }).catch(function () {
      return loadScript(DATA_DIR + sourceBundleFile(name)).then(function () { return takeBundle(sourceBundleKey(name)); });
    });
  }
  return loadScript(DATA_DIR + sourceBundleFile(name))
    .then(function () { return takeBundle(sourceBundleKey(name)); });
}

function fetchLayout(key) {
  if (!FILE_MODE) {
    return fetch(LAYOUT_DIR + key + ".json").then(function (r) {
      if (!r.ok) throw new Error("layout");
      return r.json();
    }).catch(function () {
      return loadScript(LAYOUT_DIR + key + ".bundle.js").then(function () { return takeBundle("__GRAPH_LAYOUT"); });
    });
  }
  return loadScript(LAYOUT_DIR + key + ".bundle.js").then(function () { return takeBundle("__GRAPH_LAYOUT"); });
}

var canvas = document.getElementById("chart");
var ctx = canvas.getContext("2d", { alpha: false });
var loading = document.getElementById("loading");
var stat = document.getElementById("stat");
var eraDesc = document.getElementById("eraDesc");
var tip = document.getElementById("tip");
var allAvatars = document.getElementById("allAvatars");

var ERA_INFO = {
  all: "2011-08-06 至今 · 联合投稿 + @提及",
  pe: "携带版时代 2011-08-06 ~ 2017-09-19",
  br: "基岩版时代 2017-09-20 至今"
};
var era = "all", layoutName = "flat";
var nodes = [], edges = [], incidentEdges = [], indexById = new Map();
var rawById = new Map(), pendingSelectId = null;
var layoutGroups = null, groupColors = null, groupColorsSoft = null, layoutReady = false;
var layoutCache = {}, loadToken = 0;
var showAllAvatars = false;
var DPR_CAP = 2, dpr = 1, width = 1, height = 1, strokeUnit = 1;
var MIN_SCALE = 0.04, MAX_SCALE = 5, AVATAR_MIN_R = 5;
var view = { scale: 1, ox: 0, oy: 0, ready: false }, fitScale = 1;
var interacting = false, interactionTimer = 0;
var screenR = new Float32Array(0);
var palette = ["#5d7089", "#7d9fc7", "#8f7fb8", "#6f9e8a", "#b08d6a", "#a7748a", "#6a9bb0", "#9a9a6a"];

/* ---- 深色 / 白色界面：画布配色跟着换 ---- */
var THEMES = {
  dark:  { bg: "#0d1015", edge: "145,160,182", edgeHi: "180,205,235", letter: "rgba(235,242,250,.82)",
           edgeAlpha: 0.26, edgeEnd: 0.07, edgeWidth: 0.9, edgeWEnd: 0.5 },
  light: { bg: "#f7f8fb", edge: "108,130,158", edgeHi: "47,93,140", letter: "rgba(38,50,66,.78)",
           edgeAlpha: 0.11, edgeEnd: 0.03, edgeWidth: 0.72, edgeWEnd: 0.42 }
};
var themeName = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
function themeC() { return THEMES[themeName] || THEMES.dark; }
var nodeFill = [], bgGrad = null;

/* 白色界面的节点色带：度数越高越深（白底上深色才醒目），沿色带插值，避免硬分档出现断层 */
var LIGHT_BAND = [
  [0, 213, 223, 233],   // #d5dfe9  外围底噪，几乎融进背景
  [2, 178, 195, 213],
  [6, 126, 154, 184],
  [20, 76, 112, 149],
  [60, 44, 86, 126]     // #2c567e  枢纽
];
var bandCache = {};
function lightNodeColor(deg) {
  var d = deg > 60 ? 60 : (deg < 0 ? 0 : deg);
  var hit = bandCache[d];
  if (hit) return hit;
  var i = 1;
  while (i < LIGHT_BAND.length - 1 && d > LIGHT_BAND[i][0]) i++;
  var a = LIGHT_BAND[i - 1], b = LIGHT_BAND[i];
  var span = b[0] - a[0] || 1, t = (d - a[0]) / span;
  var c = "rgb(" + Math.round(a[1] + (b[1] - a[1]) * t) + "," +
          Math.round(a[2] + (b[2] - a[2]) * t) + "," +
          Math.round(a[3] + (b[3] - a[3]) * t) + ")";
  bandCache[d] = c;
  return c;
}
function refreshNodeFill() {
  nodeFill = nodes.map(function (n) {
    if (themeName === "light") return lightNodeColor(n.degree);
    return n.degree >= 10 ? "#7d9fc7" : (n.degree >= 4 ? "#5d7089" : "#465366");
  });
}


function fnv(ids) {
  var h = 0x811c9dc5, s = ids.join(",");
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function faceUrl(f) {
  if (!f) return "";
  if (f.indexOf("//") === 0) return "https:" + f;
  if (f.indexOf("http://") === 0) return "https://" + f.slice(7);
  return f;
}
function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function communityColor(g, soft) {
  var hue = (g * 137.508) % 360;
  // 白色界面下换成低饱和的莫兰迪调：原来的高饱和在白底上会出现刺眼的鲜绿/鲜橙环
  var lit = themeName === "light";
  if (lit && soft) return "hsl(" + hue.toFixed(1) + ",16%,74%)";   // 孤立点用极淡的同色相，保留归属又退到背景
  var sat = (lit ? 26 : 38) + (g * 53 % 3) * (lit ? 5 : 7);
  var light = (lit ? 48 : 55) + (g * 31 % 3) * (lit ? 4 : 7);
  return "hsl(" + hue.toFixed(1) + "," + sat + "%," + light + "%)";
}
function darken(hex, k) {
  if (hex[0] !== "#") return hex;
  var n = parseInt(hex.slice(1), 16);
  var r = Math.round(((n >> 16) & 255) * (1 - k));
  var g = Math.round(((n >> 8) & 255) * (1 - k));
  var b = Math.round((n & 255) * (1 - k));
  return "rgb(" + r + "," + g + "," + b + ")";
}
function lighten(hex, k) {
  if (hex[0] !== "#") return hex;
  var n = parseInt(hex.slice(1), 16);
  var r = Math.round(((n >> 16) & 255) + (255 - ((n >> 16) & 255)) * k);
  var g = Math.round(((n >> 8) & 255) + (255 - ((n >> 8) & 255)) * k);
  var b = Math.round((n & 255) + (255 - (n & 255)) * k);
  return "rgb(" + r + "," + g + "," + b + ")";
}
function nodeColor(i) {
  if (layoutName === "comm" && groupColors) {
    var g = layoutGroups[i];
    // 白色界面：没有连边的孤立点用极淡的同色相，避免外圈糊成一整片高饱和色环
    if (themeName === "light" && groupColorsSoft && nodes[i].degree === 0) return groupColorsSoft[g] || palette[0];
    return groupColors[g] || palette[0];
  }
  return nodeFill[i] || palette[0];
}

function buildView() {
  var vn = GRAPH.nodes.filter(function (n) { return era === "all" || n[era]; });
  nodes = vn.map(function (n) {
    return { id: String(n.id), name: n.name || "", face: faceUrl(n.face), vpe: n.vpe || 0, vbr: n.vbr || 0,
             degree: 0, radius: 8, x: 0, y: 0, avatar: null, avatarState: 0, avatarFade: 0 };
  });
  indexById = new Map();
  nodes.forEach(function (n, i) { indexById.set(n.id, i); });
  edges = [];
  GRAPH.links.forEach(function (l) {
    if (era !== "all" && !l[era]) return;
    var a = indexById.get(String(l.source)), b = indexById.get(String(l.target));
    if (a === undefined || b === undefined || a === b) return;
    edges.push({ a: a, b: b, j: l.j });
  });
  incidentEdges = nodes.map(function () { return []; });
  edges.forEach(function (e, i) {
    nodes[e.a].degree++; nodes[e.b].degree++;
    incidentEdges[e.a].push(i); incidentEdges[e.b].push(i);
  });
  nodes.forEach(function (n) { n.radius = 8 + Math.min(12, Math.sqrt(n.degree) * 2.8); });
  refreshNodeFill();
  screenR = new Float32Array(nodes.length);
  stat.textContent = nodes.length + "人 " + edges.length + "边";
  eraDesc.textContent = ERA_INFO[era];
}

function fitTarget() {
  var pts = nodes.filter(function (n) { return n.degree > 0; });
  if (!pts.length) pts = nodes;
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pts.forEach(function (n) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  });
  var pad = Math.max(24, Math.min(55, Math.min(width, height) * 0.08));
  var gw = Math.max(maxX - minX, 1), gh = Math.max(maxY - minY, 1);
  var scale = Math.max(MIN_SCALE, Math.min(Math.min((width - pad * 2) / gw, (height - pad * 2) / gh), 1.4));
  return { scale: scale, ox: width / 2 - (minX + maxX) / 2 * scale, oy: height / 2 - (minY + maxY) / 2 * scale };
}
function fit() {
  var t = fitTarget();
  view.scale = t.scale; view.ox = t.ox; view.oy = t.oy; fitScale = t.scale; view.ready = true;
}

function loadLayout(name, first) {
  var key = era + "_" + name, token = ++loadToken;
  var data = layoutCache[key];
  var p = data ? Promise.resolve(data) : fetchLayout(key).then(function (d) { layoutCache[key] = d; return d; });
  return p.then(function (d) {
    if (token !== loadToken) return;
    if (d.count !== nodes.length || d.hash !== fnv(nodes.map(function (n) { return n.id; }))) throw new Error("布局校验失败");
    applyLayout(d, name, first, token);
  });
}
function applyLayout(d, name, first, token) {
    if (token !== loadToken) return;
    layoutGroups = d.group || null;
    for (var i = 0; i < nodes.length; i++) { nodes[i].x = d.x[i]; nodes[i].y = d.y[i]; }
    if (layoutGroups) {
      var max = 0;
      layoutGroups.forEach(function (g) { max = Math.max(max, g); });
      groupColors = []; groupColorsSoft = [];
      for (var g = 0; g <= max; g++) {
        groupColors.push(communityColor(g));
        groupColorsSoft.push(communityColor(g, true));
      }
    } else { groupColors = null; groupColorsSoft = null; }
    layoutName = name; layoutReady = true;
    fit();
    if (!first) scheduleDraw();
}

var drawPending = false;
function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(function () { drawPending = false; draw(); });
}
function beginInteraction() { interacting = true; clearTimeout(interactionTimer); }
function endInteractionSoon() {
  clearTimeout(interactionTimer);
  interactionTimer = setTimeout(function () { interacting = false; scheduleDraw(); }, 300);
}
function resizeCanvas() {
  var vv = window.visualViewport;
  var nextDpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  var nextW = Math.max(1, Math.round(window.innerWidth));
  var nextH = Math.max(1, Math.round((vv && vv.height) || window.innerHeight));
  var anchor = null;
  if (view.ready && layoutReady && width > 1) {
    anchor = { x: (width / 2 - view.ox) / view.scale, y: (height / 2 - view.oy) / view.scale };
  }
  dpr = nextDpr; strokeUnit = 1 / dpr; width = nextW; height = nextH;
  bgGrad = null;                       // 画布尺寸变了，径向渐变要重建
  canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr);
  canvas.style.width = width + "px"; canvas.style.height = height + "px";
  if (anchor) { view.ox = width / 2 - anchor.x * view.scale; view.oy = height / 2 - anchor.y * view.scale; }
  else if (!view.ready) fit();
  scheduleDraw();
}

var hovered = -1, hoverAmount = 0, hoverAnim = 0, hoverTimer = 0, hoverPending = -1, hoverX = 0, hoverY = 0;
var searchFocus = null, connectFocus = null, toolAmount = 0, toolAnim = 0, activeTool = null;
var favSet = null;   // 「我的添加」的 id 集合，由 js/online.js 注入
var lastDrawTs = 0;

function draw() {
  var t0 = performance.now();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  if (themeName === "light") {
    // 白底：中心提亮、边缘极淡压灰，让最外圈的底色噪点柔和收住，而不是一圈硬边
    if (!bgGrad) {
      var gcx = width * 0.5, gcy = height * 0.46, grr = Math.max(width, height) * 0.62;
      bgGrad = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, grr);
      bgGrad.addColorStop(0, "#ffffff");
      bgGrad.addColorStop(0.55, "#f8fafc");
      bgGrad.addColorStop(1, "#e7ebf2");
    }
    ctx.fillStyle = bgGrad;
  } else {
    ctx.fillStyle = themeC().bg;
  }
  ctx.fillRect(0, 0, width, height);
  if (!layoutReady) return;
  var highlight = null, incident = [], fade = 0, focusIdx = -1, focusSet = null;
  if (searchFocus && toolAmount > 0.01) {
    highlight = new Set([searchFocus.node]);
    searchFocus.neighbors.forEach(function (i) { highlight.add(i); });
    incident = incidentEdges[searchFocus.node]; fade = toolAmount; focusIdx = searchFocus.node;
  } else if (connectFocus && connectFocus.connected && toolAmount > 0.01) {
    highlight = connectFocus.nodes; incident = connectFocus.edges; fade = toolAmount; focusSet = connectFocus.endpoints;
  } else if (hovered >= 0 && hoverAmount > 0.01) {
    highlight = new Set([hovered]);
    incident = incidentEdges[hovered];
    incident.forEach(function (ei) { highlight.add(edges[ei].a); highlight.add(edges[ei].b); });
    fade = hoverAmount; focusIdx = hovered;
  }
  for (var i = 0; i < nodes.length; i++) screenR[i] = Math.min(44, Math.max(1.6, nodes[i].radius * view.scale));
  // 边
  var tc = themeC();
  ctx.beginPath();
  for (var e = 0; e < edges.length; e++) addEdgePath(e);
  ctx.strokeStyle = "rgba(" + tc.edge + "," + (tc.edgeAlpha + (tc.edgeEnd - tc.edgeAlpha) * fade).toFixed(3) + ")";
  ctx.lineWidth = (tc.edgeWidth + (tc.edgeWEnd - tc.edgeWidth) * fade) * strokeUnit;
  ctx.stroke();
  if (highlight && incident.length) {
    ctx.beginPath();
    incident.forEach(addEdgePath);
    ctx.strokeStyle = "rgba(" + tc.edgeHi + "," + (0.95 * fade).toFixed(3) + ")";
    ctx.lineWidth = (tc.edgeWidth + 1.1 * fade) * strokeUnit;
    ctx.stroke();
  }
  var now = performance.now(), dt = lastDrawTs ? Math.min(64, now - lastDrawTs) : 16;
  lastDrawTs = now;
  var fadeActive = false;
  var focusGroup = (layoutName === "comm" && layoutGroups && focusIdx >= 0 && fade > 0.01) ? layoutGroups[focusIdx] : -1;
  for (var a = 0; a < nodes.length; a++) {
    var nd = nodes[a];
    var allowed = focusGroup < 0 || a === focusIdx || (highlight && highlight.has(a)) || (layoutGroups && layoutGroups[a] === focusGroup);
    // 全头像模式也设下限: overview时节点仅1~2px, 加载上万头像既看不出区别又吃满内存
    var minR = showAllAvatars ? 2.5 : AVATAR_MIN_R;
    var want = allowed && screenR[a] >= minR ? 1 : 0;
    // 触发必须早于fade推进: fade一旦>0.01, 绘制循环里的懒加载条件就永远不成立
    if (want && !nd.avatar && !nd.avatarState && !interacting) {
      var sx = nd.x * view.scale + view.ox, sy = nd.y * view.scale + view.oy, sr = screenR[a];
      if (sx > -sr && sy > -sr && sx < width + sr && sy < height + sr) ensureAvatar(nd);
    }
    if (!nd.avatar && nd.avatarFade === 0) continue;
    if (nd.avatarFade === want) continue;
    var step = dt / 140;
    nd.avatarFade = nd.avatarFade < want ? Math.min(want, nd.avatarFade + step) : Math.max(want, nd.avatarFade - step);
    if (nd.avatarFade !== want) fadeActive = true;
  }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (var k = 0; k < nodes.length; k++) {
    var n = nodes[k];
    var x = n.x * view.scale + view.ox, y = n.y * view.scale + view.oy;
    var r = screenR[k];
    if (x < -r || y < -r || x > width + r || y > height + r) continue;
    var isFocus = k === focusIdx || !!(focusSet && focusSet.has(k));
    var isRel = !!(highlight && highlight.has(k)) && !isFocus;
    var dim = !!(highlight && !highlight.has(k));
    var color = nodeColor(k);
    ctx.globalAlpha = dim ? 1 - 0.82 * fade : 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    var baseWant = showAllAvatars || r >= AVATAR_MIN_R;
    if (baseWant && n.avatar && n.avatarFade > 0.01) {
      ctx.globalAlpha = (dim ? 1 - 0.82 * fade : 1) * n.avatarFade;
      ctx.drawImage(n.avatar, x - r, y - r, r * 2, r * 2);
    } else if (baseWant && !dim && n.avatarFade <= 0.01) {
      if (r >= 7) {
        ctx.fillStyle = themeC().letter;
        ctx.font = Math.min(28, Math.max(7, r * 1.05)) + "px -apple-system,'Segoe UI','Microsoft YaHei',sans-serif";
        ctx.fillText((n.name || "?").trim().charAt(0) || "?", x, y + 0.5);
      }
    }
    if (r >= AVATAR_MIN_R || isFocus || isRel) {
      var ringW = (isFocus ? 3.2 : (isRel ? 2.4 : 1.6)) * strokeUnit;
      ctx.beginPath(); ctx.arc(x, y, r + ringW * 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = isFocus
        ? (themeName === "light" ? darken(color, 0.32) : lighten(color, 0.55))
        : color;
      ctx.lineWidth = ringW; ctx.stroke();
    }
    // 「我的添加」标记：金色细环（新增）
    if (favSet && favSet.has(n.id)) {
      ctx.beginPath(); ctx.arc(x, y, Math.max(r + 3.2 * strokeUnit, 3.4), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(240,201,138,.92)";
      ctx.lineWidth = 1.3 * strokeUnit; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (fadeActive) scheduleDraw();
}
function addEdgePath(ei) {
  var ed = edges[ei], A = nodes[ed.a], B = nodes[ed.b];
  var ax = A.x * view.scale + view.ox, ay = A.y * view.scale + view.oy;
  var bx = B.x * view.scale + view.ox, by = B.y * view.scale + view.oy;
  var dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  var ra = screenR[ed.a] || 0, rb = screenR[ed.b] || 0;
  if (len <= ra + rb + 0.6) return;
  var ux = dx / len, uy = dy / len;
  ctx.moveTo(ax + ux * ra, ay + uy * ra);
  ctx.lineTo(bx - ux * rb, by - uy * rb);
}

// 头像懒加载
var avatarQueue = [], avatarActive = 0, avatarRedrawTimer = 0, avatarLru = [];
function evictAvatars() {
  while (avatarLru.length > 3000) {
    var k = avatarLru.findIndex(function (n) {
      var x = n.x * view.scale + view.ox, y = n.y * view.scale + view.oy, r = n.radius * view.scale;
      return x < -r || y < -r || x > width + r || y > height + r;
    });
    if (k < 0) break;
    var old = avatarLru.splice(k, 1)[0];
    old.avatar = null; old.avatarState = 0; old.avatarFade = 0;
  }
}
function circularAvatar(img) {
  var out = document.createElement("canvas");
  out.width = out.height = 64;
  var g = out.getContext("2d");
  g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.clip();
  g.drawImage(img, 0, 0, 64, 64);
  return out;
}
function ensureAvatar(n) {
  if (!n.face || n.avatarState) return;
  n.avatarState = 1;
  avatarQueue.push(n);
  pumpAvatars();
}
function pumpAvatars() {
  while (avatarActive < 24 && avatarQueue.length) {
    var n = avatarQueue.shift();
    avatarActive++;
    // 头像CDN防盗链: 外站Referer一律403, 必须空Referer; 无CORS头故不能用fetch
    new Promise(function (res) {
      var img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = function () { try { n.avatar = circularAvatar(img); n.avatarState = 2; avatarLru.push(n); evictAvatars(); } catch (e) { n.avatarState = 3; } res(); };
      img.onerror = function () { n.avatarState = 3; res(); };
      img.src = n.face;
    }).then(function () {
      avatarActive--;
      if (!avatarRedrawTimer && !interacting) {
        avatarRedrawTimer = setTimeout(function () { avatarRedrawTimer = 0; if (!interacting) scheduleDraw(); }, 300);
      }
      pumpAvatars();
    });
  }
}
allAvatars.addEventListener("change", function () { showAllAvatars = this.checked; scheduleDraw(); });

// 视图动画 / 手势
var pointers = new Map(), drag = null, pinch = null, gesture = null, inertiaId = 0, viewAnim = 0;
var velocity = { x: 0, y: 0, t: 0 }, lastTap = { t: 0, x: 0, y: 0 };
function stopViewAnim() { if (viewAnim) cancelAnimationFrame(viewAnim); viewAnim = 0; }
function stopInertia() { if (inertiaId) cancelAnimationFrame(inertiaId); inertiaId = 0; }
function animateView(ts, tox, toy, dur) {
  stopViewAnim(); stopInertia();
  var from = { scale: view.scale, ox: view.ox, oy: view.oy }, start = performance.now();
  beginInteraction();
  function step(now) {
    var p = Math.min(1, (now - start) / (dur || 240)), e = 1 - Math.pow(1 - p, 2);
    view.scale = from.scale + (ts - from.scale) * e;
    view.ox = from.ox + (tox - from.ox) * e;
    view.oy = from.oy + (toy - from.oy) * e;
    if (hovered >= 0 && tip.style.display === "block") {
      var f = nodes[hovered];
      placeTip(f.x * view.scale + view.ox, f.y * view.scale + view.oy);
    }
    scheduleDraw();
    if (p < 1) viewAnim = requestAnimationFrame(step);
    else { viewAnim = 0; endInteractionSoon(); }
  }
  viewAnim = requestAnimationFrame(step);
}
function zoomAt(px, py, next) {
  next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  var wx = (px - view.ox) / view.scale, wy = (py - view.oy) / view.scale;
  animateView(next, px - wx * next, py - wy * next, 240);
}
function resetView() { var t = fitTarget(); animateView(t.scale, t.ox, t.oy, 260); }
function startInertia() {
  stopInertia();
  var vx = velocity.x, vy = velocity.y;
  if (Math.hypot(vx, vy) < 0.08) { endInteractionSoon(); return; }
  var last = performance.now();
  function step(now) {
    var frames = Math.min(3, Math.max(0.5, (now - last) / 16.7));
    last = now;
    var decay = Math.pow(0.93, frames);
    vx *= decay; vy *= decay;
    view.ox += vx * 16.7 * frames; view.oy += vy * 16.7 * frames;
    scheduleDraw();
    if (Math.hypot(vx, vy) < 0.02) { inertiaId = 0; endInteractionSoon(); return; }
    inertiaId = requestAnimationFrame(step);
  }
  inertiaId = requestAnimationFrame(step);
}
function nearestNode(mx, my, slop) {
  var best = null, bestD = Infinity, pad = slop == null ? 2 : slop;
  for (var i = 0; i < nodes.length; i++) {
    var x = nodes[i].x * view.scale + view.ox, y = nodes[i].y * view.scale + view.oy;
    var r = Math.min(44, Math.max(3, nodes[i].radius * view.scale)) + pad;
    var d = Math.hypot(mx - x, my - y);
    if (d < r && d < bestD) { bestD = d; best = { index: i, dist: d }; }
  }
  return best;
}
function pointSegDist(px, py, x1, y1, x2, y2) {
  var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  var t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
  return Math.hypot(x1 + dx * t - px, y1 + dy * t - py);
}
function nearestEdge(mx, my, focus, slop) {
  if (focus < 0) return null;
  var f = nodes[focus], fx = f.x * view.scale + view.ox, fy = f.y * view.scale + view.oy;
  var best = null, bestD = slop;
  incidentEdges[focus].forEach(function (ei) {
    var ed = edges[ei], o = nodes[ed.a === focus ? ed.b : ed.a];
    var d = pointSegDist(mx, my, fx, fy, o.x * view.scale + view.ox, o.y * view.scale + view.oy);
    if (d < bestD) { bestD = d; best = { index: ei, dist: d }; }
  });
  return best;
}
var tipW = 210, tipH = 76;
function placeTip(mx, my) {
  var rect = tip.getBoundingClientRect();
  if (rect.width) tipW = rect.width;
  if (rect.height) tipH = rect.height;
  var gap = 14, left = mx + gap, top = my - tipH - gap;
  if (top < 8) top = my + gap + 18;
  if (left + tipW > width - 8) left = mx - tipW - gap;
  tip.style.left = Math.max(8, Math.min(left, width - tipW - 8)) + "px";
  tip.style.top = Math.max(8, Math.min(top, height - tipH - 8)) + "px";
}
function positionTip(n, mx, my) {
  tip.innerHTML = '<div class="row">' + (n.face ? '<img src="' + escapeHtml(n.face) + '" alt="">' : "") +
    "<div><b>" + escapeHtml(n.name) + '</b><br><span class="sub">' + escapeHtml(n.id) + "</span></div></div>";
  tip.dataset.id = String(n.id);
  tip.dataset.name = n.name || "";
  tip.dataset.face = n.face || "";
  tip.style.display = "block";
  placeTip(mx, my);
}
function hideTip() {
  clearTimeout(hoverTimer); hoverPending = -1; tip.style.display = "none";
  if (hoverAnim) cancelAnimationFrame(hoverAnim);
  hovered = -1;
  if (hoverAmount) { hoverAmount = 0; scheduleDraw(); }
}
function animateHover(target) {
  var from = hoverAmount, start = performance.now(), dur = target > from ? 160 : 120;
  if (hoverAnim) cancelAnimationFrame(hoverAnim);
  function step(now) {
    var p = Math.min(1, (now - start) / dur), e = p * p * (3 - 2 * p);
    hoverAmount = from + (target - from) * e;
    draw();
    if (p < 1) hoverAnim = requestAnimationFrame(step);
    else { hoverAnim = 0; if (target === 0 && hoverPending < 0) hovered = -1; }
  }
  hoverAnim = requestAnimationFrame(step);
}
function hoverAllowed(i) {
  if (!activeTool) return true;
  if (activeTool === "search" && searchFocus) return i === searchFocus.node || searchFocus.neighbors.has(i);
  if (activeTool === "connect" && connectFocus) return connectFocus.nodes.has(i);
  return false;
}
function requestHover(i, mx, my) {
  if (i >= 0 && !hoverAllowed(i)) i = -1;
  hoverX = mx; hoverY = my;
  if (i === hovered && i >= 0) { tip.style.display = "block"; placeTip(mx, my); return; }
  if (i === hoverPending && i >= 0) return;
  clearTimeout(hoverTimer);
  hoverPending = i;
  if (i < 0) { hoverPending = -1; tip.style.display = "none"; animateHover(0); return; }
  if (hovered >= 0 && hovered !== i) { tip.style.display = "none"; animateHover(0); }
  hoverTimer = setTimeout(function () {
    if (hoverPending !== i) return;
    hoverPending = -1; hovered = i;
    animateHover(1);
    positionTip(nodes[i], hoverX, hoverY);
  }, 140);
}
function focusNode(i, zoomIn) {
  var n = nodes[i], x = n.x * view.scale + view.ox, y = n.y * view.scale + view.oy;
  clearTimeout(hoverTimer); hoverPending = -1; hovered = i; hoverAmount = 1;
  positionTip(n, x, y);
  if (zoomIn) {
    // 搜索结果定位：把创作者放到屏幕正中，并放大到能看清周围合作关系的比例
    var target = Math.min(MAX_SCALE, Math.max(0.75, view.scale * 1.6));
    animateView(target, width / 2 - n.x * target, height / 2 - n.y * target, 320);
  } else {
    var margin = 90;
    if (Math.abs(x - width / 2) > width / 2 - margin || Math.abs(y - height / 2) > height / 2 - margin) {
      animateView(view.scale, width / 2 - n.x * view.scale, height / 2 - n.y * view.scale, 260);
    }
  }
  scheduleDraw();
}
function handleTap(mx, my) {
  var now = performance.now();
  var near = Math.hypot(mx - lastTap.x, my - lastTap.y) < 44;
  // 双击缩放只在空白处生效：落在节点上时留给"打开详情卡"
  if (now - lastTap.t < 320 && near && !nearestNode(mx, my, 22)) {
    lastTap.t = 0; hideTip();
    if (view.scale > fitScale * 1.5) resetView(); else zoomAt(mx, my, view.scale * 2.3);
    noteGesture();
    return;
  }
  lastTap.t = now; lastTap.x = mx; lastTap.y = my;
  var tn = nearestNode(mx, my, 16);
  if (activeTool) { if (tn && hoverAllowed(tn.index)) requestHover(tn.index, mx, my); return; }
  var te = nearestEdge(mx, my, hovered, 26);
  if (te && (!tn || te.dist + 6 < tn.dist)) {
    lastTap.t = 0;
    var ed = edges[te.index];
    focusNode(ed.a === hovered ? ed.b : ed.a);
    return;
  }
  if (tn) {
    requestHover(tn.index, mx, my);
    pickNode(nodes[tn.index].id);
    return;
  }
  requestHover(-1, 0, 0);
  pickNode(null);
}
// 通知详情卡（js/detail.js）：点了谁；null 表示点了空白
var lastPickId = null;
function pickNode(id) {
  lastPickId = id ? String(id) : null;
  window.dispatchEvent(new CustomEvent("graph:pick", { detail: { id: lastPickId } }));
}
canvas.addEventListener("wheel", function (ev) {
  ev.preventDefault();
  stopViewAnim(); stopInertia();
  var mx = ev.clientX, my = ev.clientY;
  var bx = (mx - view.ox) / view.scale, by = (my - view.oy) / view.scale;
  var next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * Math.exp(-ev.deltaY * 0.0012)));
  view.ox = mx - bx * next; view.oy = my - by * next; view.scale = next;
  beginInteraction(); scheduleDraw(); noteGesture(); endInteractionSoon();
}, { passive: false });
canvas.addEventListener("pointerdown", function (ev) {
  stopViewAnim(); stopInertia();
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  beginInteraction();
  if (pointers.size === 1) {
    drag = { x: ev.clientX, y: ev.clientY };
    gesture = { sx: ev.clientX, sy: ev.clientY, moved: 0, at: performance.now(), type: ev.pointerType || "mouse" };
    velocity.x = velocity.y = 0; velocity.t = performance.now();
    canvas.classList.add("dragging");
    if (ev.pointerType === "touch") { tip.style.display = "none"; clearTimeout(hoverTimer); hoverPending = -1; }
    else hideTip();
  } else if (pointers.size === 2) {
    var pts = Array.from(pointers.values());
    pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
              cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2,
              scale: view.scale, ox: view.ox, oy: view.oy };
    drag = null; gesture = null; hideTip();
  }
});
canvas.addEventListener("pointermove", function (ev) {
  if (!pointers.has(ev.pointerId)) {
    if (ev.pointerType !== "touch") {
      var hit = nearestNode(ev.clientX, ev.clientY, 2);
      requestHover(hit ? hit.index : -1, ev.clientX, ev.clientY);
    }
    return;
  }
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2 && pinch) {
    beginInteraction(); noteGesture();
    var pts = Array.from(pointers.values());
    var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    var next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinch.scale * d / Math.max(pinch.d, 1)));
    var cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
    var wx = (pinch.cx - pinch.ox) / pinch.scale, wy = (pinch.cy - pinch.oy) / pinch.scale;
    view.scale = next; view.ox = cx - wx * next; view.oy = cy - wy * next;
    scheduleDraw(); endInteractionSoon();
    return;
  }
  if (drag) {
    beginInteraction();
    var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (gesture) gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (gesture && gesture.moved > 8) noteGesture();
    drag.x = ev.clientX; drag.y = ev.clientY;
    var now = performance.now(), el = Math.max(1, now - velocity.t);
    velocity.t = now;
    velocity.x = velocity.x * 0.7 + dx / el * 0.3;
    velocity.y = velocity.y * 0.7 + dy / el * 0.3;
    view.ox += dx; view.oy += dy;
    scheduleDraw(); endInteractionSoon();
  }
});
function endPointer(ev) {
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    var rest = pointers.values().next().value;
    drag = { x: rest.x, y: rest.y };
    velocity.x = velocity.y = 0; velocity.t = performance.now();
    return;
  }
  if (pointers.size === 0) {
    var g = gesture;
    gesture = null; drag = null;
    canvas.classList.remove("dragging");
    if (!g) { endInteractionSoon(); return; }
    if (g.type === "mouse") {
      endInteractionSoon();
      // 鼠标单击也走 tap 判定：原来的 2px 命中太苛刻，点节点几乎点不中
      if (g.moved < 8 && performance.now() - g.at < 700) { handleTap(ev.clientX, ev.clientY); return; }
      var hit = nearestNode(ev.clientX, ev.clientY, 2);
      requestHover(hit ? hit.index : -1, ev.clientX, ev.clientY);
      return;
    }
    if (g.moved < 12 && performance.now() - g.at < 600) { handleTap(ev.clientX, ev.clientY); endInteractionSoon(); }
    else startInertia();
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", function (ev) { if (gesture) gesture.moved = 1e6; endPointer(ev); });
canvas.addEventListener("pointerleave", function (ev) {
  if (ev.pointerType !== "touch" && pointers.size === 0) requestHover(-1, 0, 0);
});
// 右键创作者 → 交给 js/online.js 弹菜单（新增，不改动左键交互）
canvas.addEventListener("contextmenu", function (ev) {
  var hit = nearestNode(ev.clientX, ev.clientY, 12);
  if (!hit) return;
  ev.preventDefault();
  var n = nodes[hit.index];
  window.dispatchEvent(new CustomEvent("graph:nodecontext", { detail: {
    id: String(n.id), name: n.name || "", face: n.face || "",
    x: ev.clientX, y: ev.clientY, from: "canvas"
  } }));
});

// 工具栏 / 搜索 / 连接
var toolbox = document.getElementById("toolbox");
var searchStatus = document.getElementById("searchStatus");
var searchModal = document.getElementById("searchModal");
var searchInput = document.getElementById("searchInput");
var searchResults = document.getElementById("searchResults");
var connectModal = document.getElementById("connectModal");
var connectPicks = { a: -1, b: -1 }, pickerSlot = null;
var remindTimer = 0;
var ICON_SEARCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.3-4.3"/></svg>';
var ICON_CONNECT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="2.6"/><circle cx="19" cy="12" r="2.6"/><path d="M7.8 12h8.4"/></svg>';
function setToolbarOpen(open) {
  // 工具栏已改为常驻（只剩一个「连接两位创作者」按钮），保留函数名以免调用点报错
  toolbox.classList.toggle("open", open);
}
function scheduleReminder() {
  clearTimeout(remindTimer);
  if (!activeTool) return;
  remindTimer = setTimeout(function () {
    if (!activeTool) return;
    toolbox.classList.remove("remind");
    void toolbox.offsetWidth;
    toolbox.classList.add("remind");
    setTimeout(function () { toolbox.classList.remove("remind"); }, 1300);
    scheduleReminder();
  }, 2000);
}
function noteGesture() { if (toolbox.classList.contains("open") && !activeTool) setToolbarOpen(false); }
function animateTool(target, done) {
  if (toolAnim) cancelAnimationFrame(toolAnim);
  var from = toolAmount, start = performance.now(), dur = target > from ? 200 : 160;
  function step(now) {
    var p = Math.min(1, (now - start) / dur), e = p * p * (3 - 2 * p);
    toolAmount = from + (target - from) * e;
    scheduleDraw();
    if (p < 1) toolAnim = requestAnimationFrame(step);
    else { toolAnim = 0; if (target === 0 && done) done(); }
  }
  toolAnim = requestAnimationFrame(step);
}
function faceHtml(n, cls) {
  var ch = (n.name || "?").trim().charAt(0) || "?";
  return n.face ? '<img class="' + cls + '" src="' + escapeHtml(n.face) + '" referrerpolicy="no-referrer" alt="">' :
    '<span class="' + cls + ' face-fallback">' + escapeHtml(ch) + "</span>";
}
function renderToolStatus() {
  if (activeTool === "search") {
    if (searchFocus) {
      var n = nodes[searchFocus.node];
      searchStatus.innerHTML = faceHtml(n, "ss-avatar") + '<span class="ss-text"><b>' + escapeHtml(n.name) + "</b><span>" + escapeHtml(n.id) + "</span></span>";
    } else searchStatus.innerHTML = '<span class="ss-hint">' + ICON_SEARCH + "<span>搜索创作者…</span></span>";
  } else if (activeTool === "connect") {
    if (connectPicks.a < 0 || connectPicks.b < 0) {
      searchStatus.innerHTML = '<span class="ss-hint">' + ICON_CONNECT + "<span>连接两位创作者</span></span>";
    } else if (connectFocus) {
      var duo = '<span class="duo">' + faceHtml(nodes[connectPicks.a], "ss-avatar") + faceHtml(nodes[connectPicks.b], "ss-avatar") + "</span>";
      var txt;
      if (connectFocus.same) txt = "<b>同一创作者</b><span>这是同一个人呀</span>";
      else if (connectFocus.direct) txt = "<b>直接相连</b><span>他们之间没有中间人</span>";
      else if (connectFocus.connected) txt = "<b>" + connectFocus.count + " 位创作者</b><span>将他们连接起来</span>";
      else txt = "<b>他们现在连不上</b><span>这两个时代还没交集</span>";
      searchStatus.innerHTML = duo + '<span class="ss-text">' + txt + "</span>";
    }
  }
  searchStatus.title = activeTool === "search" ? "点击退出高亮" :
    (activeTool === "connect" ? "点击打开连接面板" : "");
}
function setToolMode(tool) {
  activeTool = tool;
  toolbox.classList.toggle("toolmode", !!tool);
  document.body.classList.toggle("tooling", !!tool);
  document.getElementById("toolConnectBtn").classList.toggle("on", tool === "connect");
  scheduleReminder();
}
function openSearchModal(asPicker) {
  pickerSlot = asPicker || null;
  searchModal.classList.add("open");
  clearTimeout(remindTimer);
  var change = !!pickerSlot || !!searchFocus;
  searchModal.classList.toggle("change", change);
  document.getElementById("searchTitle").textContent = pickerSlot ? "选择创作者" : "搜索创作者";
  searchInput.value = "";
  renderResults("");
  setTimeout(function () { searchInput.focus(); }, 0);
}
function closeSearchModal() {
  searchModal.classList.remove("open", "change");
  scheduleReminder();
}
function openConnectModal() {
  connectModal.classList.add("open");
  clearTimeout(remindTimer);
  connectModal.classList.toggle("change", connectPicks.a >= 0 && connectPicks.b >= 0);
  renderConnectSlots();
}
function closeConnectModal() {
  connectModal.classList.remove("open", "change");
  scheduleReminder();
}
function activateTool(tool) {
  setToolMode(tool);
  connectPicks.a = connectPicks.b = -1;
  connectFocus = null;
  renderToolStatus();
  openConnectModal();
}
function exitTool() {
  setToolMode(null);
  pickerSlot = null;
  hideTip();
  hidePathBar();
  if (searchFocus || connectFocus) {
    animateTool(0, function () { searchFocus = null; connectFocus = null; });
  }
}
document.getElementById("toolConnectBtn").addEventListener("click", function () {
  // 唯一的工具按钮：点一次进入「连接两位创作者」，再点一次退出（已去掉展开箭头）
  if (activeTool === "connect") {
    closeConnectModal();
    exitTool();
    return;
  }
  if (activeTool) exitTool();
  activateTool("connect");
});
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Escape" || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  if (searchModal.classList.contains("open")) { document.getElementById("searchModalClose").click(); return; }
  if (connectModal.classList.contains("open")) { document.getElementById("connectModalClose").click(); return; }
  if (activeTool) exitTool();
});
searchStatus.addEventListener("click", function () {
  if (activeTool === "connect") openConnectModal();
  else if (activeTool === "search") exitTool();
  else {
    var f = document.getElementById("findInput");
    if (f) { f.focus(); f.select(); }
  }
});
document.getElementById("searchModalClose").addEventListener("click", function () {
  closeSearchModal();
  if (!searchFocus) exitTool();
});
document.getElementById("searchModalCancel").addEventListener("click", function () {
  var wasPicker = !!pickerSlot;
  closeSearchModal();
  pickerSlot = null;
  if (wasPicker) openConnectModal();
  else if (!searchFocus) exitTool();
});
searchModal.addEventListener("click", function (ev) {
  if (ev.target === searchModal) document.getElementById(searchModal.classList.contains("change") ? "searchModalCancel" : "searchModalClose").click();
});
document.getElementById("connectModalClose").addEventListener("click", function () { closeConnectModal(); exitTool(); });
document.getElementById("connectModalCancel").addEventListener("click", function () { closeConnectModal(); });
connectModal.addEventListener("click", function (ev) {
  if (ev.target === connectModal) document.getElementById(connectModal.classList.contains("change") ? "connectModalCancel" : "connectModalClose").click();
});
function pickerDisabled() {
  if (!pickerSlot) return -1;
  return pickerSlot === "a" ? connectPicks.b : connectPicks.a;
}
function searchNodes(q) {
  q = q.trim();
  if (!q) return [];
  var ql = q.toLowerCase(), exact = indexById.get(q);
  var head = exact === undefined ? [] : [exact];
  var rest = [];
  for (var i = 0; i < nodes.length; i++) {
    if (i === exact || !nodes[i].name) continue;
    if (nodes[i].name.toLowerCase().indexOf(ql) >= 0) rest.push(i);
  }
  rest.sort(function (a, b) { return nodes[b].degree - nodes[a].degree; });
  var list = head.concat(rest), dis = pickerDisabled();
  if (dis >= 0 && list.indexOf(dis) >= 0) {
    list.splice(list.indexOf(dis), 1);
    list = list.slice(0, 8);
    list.push(dis);
  }
  return list.slice(0, 8);
}
function renderResults(q) {
  if (!q.trim()) { searchResults.innerHTML = ""; return; }
  var list = searchNodes(q), dis = pickerDisabled();
  if (!list.length) { searchResults.innerHTML = '<div class="sr-empty">没有匹配的创作者</div>'; return; }
  var html = "";
  list.forEach(function (i) {
    var n = nodes[i], off = i === dis;
    html += '<div class="sr-row' + (off ? " disabled" : "") + '" data-i="' + i + '">' + faceHtml(n, "sr-face") +
      '<span class="sr-text"><b>' + escapeHtml(n.name) + "</b><span>" + escapeHtml(n.id) + " · " + n.degree + " 个合作</span></span></div>";
  });
  html += '<div class="sr-end">已经到底了</div>';
  searchResults.innerHTML = html;
}
searchInput.addEventListener("input", function () { renderResults(this.value); });
searchResults.addEventListener("click", function (ev) {
  var row = ev.target.closest(".sr-row");
  if (!row || row.classList.contains("disabled")) return;
  var i = +row.dataset.i;
  if (pickerSlot) {
    connectPicks[pickerSlot] = i;
    pickerSlot = null;
    closeSearchModal();
    openConnectModal();
    if (connectPicks.a >= 0 && connectPicks.b >= 0) finishConnect();
    return;
  }
  closeSearchModal();
  hideTip();
  connectFocus = null;
  var nb = new Set();
  incidentEdges[i].forEach(function (ei) { nb.add(edges[ei].a); nb.add(edges[ei].b); });
  nb.delete(i);
  searchFocus = { node: i, neighbors: nb };
  renderToolStatus();
  animateTool(1);
  focusNode(i);
});
function renderConnectSlots() {
  ["a", "b"].forEach(function (key) {
    var el = document.getElementById(key === "a" ? "connectSlotA" : "connectSlotB");
    var i = connectPicks[key];
    if (i >= 0) {
      var n = nodes[i];
      el.classList.add("filled");
      el.innerHTML = faceHtml(n, "ss-avatar") + '<span class="ss-text"><b>' + escapeHtml(n.name) + "</b><span>" + escapeHtml(n.id) + "</span></span>";
    } else {
      el.classList.remove("filled");
      el.innerHTML = '<span class="ss-avatar face-fallback">+</span><span class="ss-text"><b class="ph">点击选择创作者</b></span>';
    }
  });
}
document.getElementById("connectSlotA").addEventListener("click", function () { closeConnectModal(); openSearchModal("a"); });
document.getElementById("connectSlotB").addEventListener("click", function () { closeConnectModal(); openSearchModal("b"); });
function shortestPath(from, to) {
  if (from === to) return { nodes: [from], edges: [] };
  var prev = new Array(nodes.length).fill(-1), prevE = new Array(nodes.length).fill(-1);
  prev[from] = from;
  var queue = [from];
  for (var qi = 0; qi < queue.length; qi++) {
    var cur = queue[qi];
    var list = incidentEdges[cur];
    for (var li = 0; li < list.length; li++) {
      var ei = list[li], ed = edges[ei];
      var nxt = ed.a === cur ? ed.b : ed.a;
      if (prev[nxt] !== -1) continue;
      prev[nxt] = cur; prevE[nxt] = ei;
      if (nxt === to) {
        var pn = [], pe = [], c = to;
        while (c !== from) { pn.push(c); pe.push(prevE[c]); c = prev[c]; }
        pn.push(from); pn.reverse(); pe.reverse();
        return { nodes: pn, edges: pe };
      }
      queue.push(nxt);
    }
  }
  return null;
}
function frameNodes(set) {
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  set.forEach(function (i) {
    var n = nodes[i];
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  });
  var x1 = minX * view.scale + view.ox, y1 = minY * view.scale + view.oy;
  var x2 = maxX * view.scale + view.ox, y2 = maxY * view.scale + view.oy;
  var m = 60;
  if (x1 >= m && y1 >= m && x2 <= width - m && y2 <= height - m) return;
  var bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
  var scale = Math.max(MIN_SCALE, Math.min(Math.min((width - 120) / bw, (height - 120) / bh), view.scale));
  animateView(scale, width / 2 - (minX + maxX) / 2 * scale, height / 2 - (minY + maxY) / 2 * scale, 260);
}
function finishConnect() {
  closeConnectModal();
  hideTip();
  searchFocus = null;
  var same = connectPicks.a === connectPicks.b;
  var path = shortestPath(connectPicks.a, connectPicks.b);
  if (path) {
    connectFocus = { nodes: new Set(path.nodes), edges: path.edges, endpoints: new Set([connectPicks.a, connectPicks.b]),
                     count: Math.max(0, path.nodes.length - 2), connected: true, same: same, direct: !same && path.nodes.length === 2 };
    animateTool(1);
    if (!same && path.nodes.length > 1) showPathBar(path); else hidePathBar();
  } else {
    connectFocus = { nodes: new Set([connectPicks.a, connectPicks.b]), edges: [], endpoints: new Set([connectPicks.a, connectPicks.b]),
                     count: 0, connected: false, same: same, direct: false };
    hidePathBar();
  }
  renderToolStatus();
  frameNodes(connectFocus.nodes);
  warmAvatars();
}

/* ---- 连接路径条：把「几跳、经过谁」写出来 ---- */
var pathBarEl = null;
function showPathBar(path) {
  if (!pathBarEl) pathBarEl = document.getElementById("pathBar");
  if (!pathBarEl) return;
  document.getElementById("pbHops").textContent = (path.nodes.length - 1) + " 跳";
  var last = path.nodes.length - 1, html = "";
  path.nodes.forEach(function (idx, k) {
    var n = nodes[idx];
    if (k) html += '<span class="pb-arrow">→</span>';
    var ch = (n.name || "?").trim().charAt(0) || "?";
    var av = n.face ? '<img src="' + escapeHtml(n.face) + '" referrerpolicy="no-referrer" alt="">' : escapeHtml(ch);
    html += '<button type="button" data-id="' + escapeHtml(n.id) + '"' + (k === 0 || k === last ? ' class="end"' : "") + ">" +
      '<span class="pb-av">' + av + '</span><span class="pb-nm">' + escapeHtml(n.name) + "</span></button>";
  });
  document.getElementById("pbChain").innerHTML = html;
  pathBarEl.hidden = false;
}
function hidePathBar() {
  if (!pathBarEl) pathBarEl = document.getElementById("pathBar");
  if (pathBarEl) pathBarEl.hidden = true;
}

// 布局切换（时代切换按钮已移除，era 固定为 all）
document.getElementById("layoutSelect").addEventListener("change", function () {
  var name = this.value;
  stat.textContent = "切换布局中…";
  loadLayout(name, false).then(function () {
    stat.textContent = nodes.length + "人 " + edges.length + "边";
  }).catch(function () { stat.textContent = "布局加载失败"; });
});

// 深色 / 白色界面切换
var themeBtn = document.getElementById("themeBtn");
function paintThemeBtn() {
  if (!themeBtn) return;
  var light = themeName === "light";
  document.getElementById("themeLabel").textContent = light ? "深色界面" : "白色界面";
  themeBtn.setAttribute("aria-label", light ? "切换到深色界面" : "切换到白色界面");
  document.getElementById("themeIcon").innerHTML = light
    ? '<path d="M20.5 14.3A8.6 8.6 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8z"/>'
    : '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>';
}
function rebuildGroupColors() {
  if (layoutName !== "comm" || !layoutGroups) return;
  var max = 0;
  for (var i = 0; i < layoutGroups.length; i++) if (layoutGroups[i] > max) max = layoutGroups[i];
  var list = [], soft = [];
  for (var g = 0; g <= max; g++) { list.push(communityColor(g)); soft.push(communityColor(g, true)); }
  groupColors = list; groupColorsSoft = soft;
}
function applyTheme(name, persist) {
  themeName = name === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", themeName);
  if (persist) { try { localStorage.setItem("bedrock.theme.v1", themeName); } catch (e) { /* 隐私模式下忽略 */ } }
  bgGrad = null;
  refreshNodeFill();
  rebuildGroupColors();
  paintThemeBtn();
  scheduleDraw();
}
if (themeBtn) {
  paintThemeBtn();
  themeBtn.addEventListener("click", function () { applyTheme(themeName === "light" ? "dark" : "light", true); });
}
/* ---- 路径条交互 ---- */
document.getElementById("pbChain").addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-id]");
  if (!b) return;
  var i = indexById.get(String(b.dataset.id));
  if (i !== undefined) applySearchFocus(i);
});
document.getElementById("pbClose").addEventListener("click", function () { exitTool(); });

/* ---- 轻量提示（优先复用 online.js 的 toast） ---- */
function appToast(msg, ms) {
  if (window.GRAPH_ONLINE && window.GRAPH_ONLINE.toast) { window.GRAPH_ONLINE.toast(msg, ms); return; }
  var t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(appToast._t);
  appToast._t = setTimeout(function () { t.classList.remove("show"); }, ms || 2600);
}

/* ---- 分享：把当前时代 / 布局 / 人物写进 URL hash ---- */
function parseHash() {
  var h = (location.hash || "").replace(/^#/, "");
  if (!h) return null;
  var o = {};
  h.split("&").forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf("=");
    var k = i < 0 ? kv : kv.slice(0, i);
    var v = i < 0 ? "" : kv.slice(i + 1);
    try { o[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { o[k] = v; }
  });
  return o;
}
function currentHash() {
  var parts = [];
  if (era !== "all") parts.push("era=" + era);
  if (layoutName !== "flat") parts.push("layout=" + layoutName);
  var id = searchFocus ? nodes[searchFocus.node].id : lastPickId;
  if (id && indexById.get(String(id)) !== undefined) parts.push("id=" + encodeURIComponent(id));
  return parts.length ? "#" + parts.join("&") : "";
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
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
var shareBtn = document.getElementById("shareBtn");
if (shareBtn) shareBtn.addEventListener("click", function () {
  var hash = currentHash();
  var url = location.href.split("#")[0] + hash;
  try { history.replaceState(null, "", hash || location.href.split("#")[0]); } catch (e) { /* 某些环境不允许，忽略 */ }
  copyText(url).then(function (ok) {
    if (ok) {
      hideSharePop();
      appToast("链接已复制\n" + url, 5200);
      return;
    }
    showSharePop(url);
  });
});

function showSharePop(url) {
  var pop = document.getElementById("sharePop"), inp = document.getElementById("shareUrl");
  if (!pop || !inp) return;
  inp.value = url;
  pop.hidden = false;
  setTimeout(function () { inp.focus(); inp.select(); }, 30);
}
function hideSharePop() {
  var pop = document.getElementById("sharePop");
  if (pop) pop.hidden = true;
}
document.getElementById("sharePopClose").addEventListener("click", hideSharePop);
document.getElementById("shareRetry").addEventListener("click", function () {
  var inp = document.getElementById("shareUrl");
  if (!inp) return;
  if (legacyCopy(inp.value)) { hideSharePop(); appToast("链接已复制", 2400); }
  else { inp.focus(); inp.select(); appToast("还是不行，请手动选中复制", 2600); }
});

/* ------------------------------------------------------------------
 * 导出图片（PNG）
 *
 * 两个问题在这里一起解决：
 *  1) 之前直接 canvas.toDataURL()：主画布画过 B 站 CDN 的头像，而那些图片
 *     没有 CORS 头，画布被标记为「已污染」，toDataURL/getImageData 一律抛
 *     SecurityError —— 只要屏幕上出现过一张头像，导出就必然失败。
 *     现在不复用主画布，改成离屏重绘：头像只用「经本地助手取回、重新解码」
 *     的干净位图（blob → createImageBitmap，不污染画布），取不到就画成
 *     首字母圆点。无论联网助手在不在线，导出都不会再抛 SecurityError。
 *  2) 聚焦某位创作者时，只渲染他与他的一跳合作者，其余点位与连边不参与
 *     绘制，并按这个子集重新取景、附一行说明文字，导出即一张人物星图。
 * ------------------------------------------------------------------ */
var exporting = false;
var SAFE_AV = new Map(), SAFE_FAIL = new Set(), safePending = new Map(), SAFE_AV_MAX = 500;
var FONT_STACK = "-apple-system,'Segoe UI','Microsoft YaHei',sans-serif";

function helperImgBase() {
  try {
    if (window.GRAPH_ONLINE && window.GRAPH_ONLINE.helperBase) return window.GRAPH_ONLINE.helperBase() || "";
  } catch (e) { /* ignore */ }
  return "";
}
function helperUsable() {
  if (!window.GRAPH_ONLINE || !window.GRAPH_ONLINE.isOnline || !window.GRAPH_ONLINE.isOnline()) return false;
  // http(s) 同源相对路径下 base 为空串也有效；file:// 下需本地助手地址非空
  return location.protocol !== "file:" || !!helperImgBase();
}

/* 头像的「干净副本」：字节从助手取（带 CORS），解码后画进 64px 圆图。
   这条链路上的位图不带跨域标记，画到任何画布上都不会污染。 */
function blobToBitmap(blob) {
  if (window.createImageBitmap) return createImageBitmap(blob);
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(blob), img = new Image();
    img.onload = function () { img._url = url; res(img); };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
    img.src = url;
  });
}
function cleanAvatar(face) {
  if (!face || SAFE_FAIL.has(face)) return Promise.resolve(null);
  var hit = SAFE_AV.get(face);
  if (hit) return Promise.resolve(hit);
  var pend = safePending.get(face);
  if (pend) return pend;
  var base = helperImgBase();
  // http(s) 同源相对路径下 base="" 仍有效（fetch("/img?u=")）；仅 file:// 无助手时跳过
  if (!base && location.protocol === "file:") return Promise.resolve(null);
  var p = fetch(base + "/img?u=" + encodeURIComponent(face), { cache: "force-cache" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
    .then(blobToBitmap)
    .then(function (img) {
      var w = img.width || img.naturalWidth || 0, h = img.height || img.naturalHeight || 0, out = null;
      if (w && h) {
        out = document.createElement("canvas");
        out.width = out.height = 64;
        var g = out.getContext("2d");
        g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.clip();
        var s = Math.min(w, h);
        g.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 64, 64);
      }
      if (img.close) { try { img.close(); } catch (e) { /* ignore */ } }
      if (img._url) URL.revokeObjectURL(img._url);
      if (out) {
        if (SAFE_AV.size >= SAFE_AV_MAX) SAFE_AV.clear();
        SAFE_AV.set(face, out);
      }
      return out;
    })
    .catch(function () { if (SAFE_FAIL.size < 3000) SAFE_FAIL.add(face); return null; });
  var wrapped = p.then(function (v) { safePending.delete(face); return v; });
  safePending.set(face, wrapped);
  return wrapped;
}
// 有限并发预热，到时间就走（宁可几张头像用首字母，也不让用户干等）
function prefetchClean(faces, deadlineMs) {
  var list = faces.slice(0, 400);
  // 注意：同源部署（http/https）下 helperImgBase() 就是空串（相对路径 /img?u=），
  // 不能拿它当「助手不可用」判断——只有 file:// 才必须有显式助手地址。
  // 这里必须与 cleanAvatar 保持一致，否则线上导出会一个头像都不预取。
  if (!list.length || (!helperImgBase() && location.protocol === "file:")) return Promise.resolve();
  return new Promise(function (resolve) {
    var i = 0, running = 0, done = false;
    var timer = setTimeout(function () { done = true; resolve(); }, deadlineMs);
    function step() {
      if (done) return;
      if (i >= list.length && running === 0) { done = true; clearTimeout(timer); resolve(); return; }
      while (running < 14 && i < list.length) {
        running++;
        cleanAvatar(list[i++]).then(function () { running--; step(); });
      }
    }
    step();
  });
}

/* 聚焦之后顺手把这一小撮头像的「干净副本」抓下来，等用户点导出就不用干等 */
var warmTimer = 0;
function warmAvatars() {
  if (!helperUsable()) return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(function () {
    warmTimer = 0;
    if (!layoutReady) return;
    var p = exportPlan();
    if (!p || p.kind === "full" || !p.faces || !p.faces.length) return;
    prefetchClean(p.faces.slice(0, 120), 15000);
  }, 900);
}

/* 导出取景：聚焦时只留「他 + 一跳合作者」，否则沿用当前视图 */
function layoutLabel() {
  var sel = document.getElementById("layoutSelect");
  if (sel && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
    return sel.options[sel.selectedIndex].textContent.split("·")[0].trim();
  }
  return layoutName;
}
var ERA_LABEL = { all: "全时代", pe: "携带版时代", br: "基岩版时代" };

function exportPlan() {
  // 正在高亮中（含刚点下去、动画还没跑完）都算「聚焦」；退出高亮后立刻回到整图
  var focus = (searchFocus && (toolAmount > 0.01 || activeTool === "search")) ? searchFocus : null;
  var conn = (!focus && connectFocus && connectFocus.connected && (toolAmount > 0.01 || activeTool === "connect")) ? connectFocus : null;
  var kind = focus ? "focus" : (conn ? "connect" : "full");
  var set = null, edgeList = [], hiEdges = null, endpoints = null, rel = null;
  var focusIdx = -1, title = "", sub = "", file = "", note = "";
  var scale = view.scale, ox = view.ox, oy = view.oy, capH = 0;

  if (focus) {
    set = new Set([focus.node]);
    focus.neighbors.forEach(function (i) { set.add(i); });
    rel = new Set(set); rel.delete(focus.node);
    focusIdx = focus.node;
    if (focus.group != null && layoutGroups) {
      // 整簇聚焦：保留簇内所有连边
      for (var e = 0; e < edges.length; e++) {
        if (layoutGroups[edges[e].a] === focus.group && layoutGroups[edges[e].b] === focus.group) edgeList.push(e);
      }
    } else {
      // 单人聚焦：只留他出发的连边
      edgeList = incidentEdges[focus.node].slice();
      hiEdges = edgeList.slice();
    }
    var core = nodes[focus.node];
    var k = set.size - 1;
    if (focus.group != null) {
      title = "簇 #" + focus.group + " · " + set.size + " 人";
      sub = "核心「" + (core.name || "UID " + core.id) + "」· " + layoutLabel() + " · bedrock creators";
      note = "已导出整簇（" + set.size + " 人）";
    } else {
      title = k ? "与「" + (core.name || "UID " + core.id) + "」合作的 " + k + " 位创作者"
                : "「" + (core.name || "UID " + core.id) + "」暂无合作关系";
      sub = "UID " + core.id + " · " + (ERA_LABEL[era] || era) + " · " + layoutLabel() + " · bedrock creators";
      note = k ? "已导出与「" + (core.name || core.id) + "」相关的 " + k + " 位创作者" : "已导出该创作者";
    }
    file = "bedrock-" + String(core.id) + "-" + new Date().toISOString().slice(0, 10) + ".png";
  } else if (conn) {
    set = new Set(conn.nodes);
    edgeList = conn.edges.slice();
    hiEdges = conn.edges.slice();
    endpoints = conn.endpoints;
    var a = nodes[conn.endpoints.values().next().value], b = nodes[Array.from(conn.endpoints)[1]];
    var hops = Math.max(0, conn.nodes.size - 1);
    title = (a ? a.name : "?") + " ↔ " + (b ? b.name : "?") + " · " + hops + " 跳";
    sub = "连接路径 · " + (ERA_LABEL[era] || era) + " · " + layoutLabel() + " · bedrock creators";
    file = "bedrock-path-" + String(a ? a.id : "") + "-" + String(b ? b.id : "") + "-" + new Date().toISOString().slice(0, 10) + ".png";
    note = "已导出连接路径（" + hops + " 跳）";
  }

  // 只保留两端都在子集里的连边，避免画到不存在的点位上
  if (set) {
    edgeList = edgeList.filter(function (ei) { return set.has(edges[ei].a) && set.has(edges[ei].b); });
    if (hiEdges) hiEdges = hiEdges.filter(function (ei) { return set.has(edges[ei].a) && set.has(edges[ei].b); });
  }

  if (kind === "full") {
    var all = new Array(nodes.length);
    for (var q = 0; q < nodes.length; q++) all[q] = q;
    set = null;
    return finishPlan({
      kind: kind, order: all, edges: allEdges(), hiEdges: null, focusIdx: -1, endpoints: null, rel: null,
      scale: scale, ox: ox, oy: oy, title: "", sub: "", file: "bedrock-creators-" + new Date().toISOString().slice(0, 10) + ".png",
      note: "", capH: 0
    });
  }

  // 按子集重新取景
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  set.forEach(function (i) {
    var n = nodes[i];
    if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
  });
  var pad = Math.max(38, Math.min(width, height) * 0.075);
  capH = 84;
  var areaTop = pad, areaBottom = height - capH - pad * 0.6;
  var bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
  scale = Math.max(MIN_SCALE, Math.min((width - pad * 2) / bw, (areaBottom - areaTop) / bh, 6));
  ox = width / 2 - (minX + maxX) / 2 * scale;
  oy = (areaTop + areaBottom) / 2 - (minY + maxY) / 2 * scale;

  var order = [];
  set.forEach(function (i) { if (i !== focusIdx) order.push(i); });
  if (focusIdx >= 0 && set.has(focusIdx)) order.push(focusIdx);   // 主角最后画，压在最上层

  return finishPlan({
    kind: kind, order: order, edges: edgeList, hiEdges: hiEdges, focusIdx: focusIdx,
    endpoints: endpoints, rel: rel, scale: scale, ox: ox, oy: oy,
    title: title, sub: sub, file: file, note: note, capH: capH
  });
}
var _allEdges = null;
function allEdges() {
  if (_allEdges && _allEdges.length === edges.length) return _allEdges;
  _allEdges = new Array(edges.length);
  for (var i = 0; i < edges.length; i++) _allEdges[i] = i;
  return _allEdges;
}
// 补齐半径、需要预取头像的清单
function finishPlan(p) {
  var radii = new Float32Array(nodes.length);
  // 子集导出时点位不能缩成尘埃：合作者隔得再远也保底（人越少，点越大）
  var cnt = p.order.length;
  var minR = p.kind === "full" ? 1.6 : (cnt <= 8 ? 9 : (cnt <= 40 ? 6.5 : 4.6));
  for (var k = 0; k < p.order.length; k++) {
    var i = p.order[k];
    radii[i] = Math.min(44, Math.max(minR, nodes[i].radius * p.scale));
  }
  // 主角（以及连接路径的两端）至少要有存在感，否则缩到全图时只剩一个像素点
  if (p.focusIdx >= 0) radii[p.focusIdx] = Math.max(radii[p.focusIdx], minR * 2, 12);
  if (p.endpoints) p.endpoints.forEach(function (i) { radii[i] = Math.max(radii[i], minR * 1.6, 9); });
  p.r = radii;
  var cap = p.kind === "full" ? 160 : 400, faces = [];
  var seen = {};
  // 导出图通常被放大来看，头像的门槛比屏幕上（5px）低一点，密集时也更有生气
  var avMin = p.kind === "full" ? AVATAR_MIN_R : 3.2;
  function push(i) {
    var n = nodes[i];
    if (radii[i] < avMin || !n.face || seen[n.face]) return;
    var x = n.x * p.scale + p.ox, y = n.y * p.scale + p.oy, r = radii[i];
    if (x < -r || y < -r || x > width + r || y > height + r) return;
    seen[n.face] = 1;
    faces.push(n.face);
  }
  if (p.focusIdx >= 0) push(p.focusIdx);          // 主角优先
  if (p.endpoints) p.endpoints.forEach(push);
  for (var j = 0; j < p.order.length && faces.length < cap; j++) push(p.order[j]);
  p.faces = faces;
  return p;
}

/* 离屏绘制：只画传入的子集，头像只用 SAFE_AV 里的干净位图 */
function paintExport(g, W, H, plan, dprOut, useAv) {
  var u = 1 / dprOut, tc = themeC();
  g.setTransform(dprOut, 0, 0, dprOut, 0, 0);
  g.globalAlpha = 1;
  if (themeName === "light") {
    if (!plan.bgGrad) {
      var gcx = W * 0.5, gcy = H * 0.46, grr = Math.max(W, H) * 0.62;
      plan.bgGrad = g.createRadialGradient(gcx, gcy, 0, gcx, gcy, grr);
      plan.bgGrad.addColorStop(0, "#ffffff");
      plan.bgGrad.addColorStop(0.55, "#f8fafc");
      plan.bgGrad.addColorStop(1, "#e7ebf2");
    }
    g.fillStyle = plan.bgGrad;
  } else {
    g.fillStyle = tc.bg;
  }
  g.fillRect(0, 0, W, H);
  if (!plan.order.length) return;

  var scale = plan.scale, ox = plan.ox, oy = plan.oy, radii = plan.r;
  g.lineCap = "round";
  function seg(ei) {
    var ed = edges[ei], A = nodes[ed.a], B = nodes[ed.b];
    var ax = A.x * scale + ox, ay = A.y * scale + oy;
    var bx = B.x * scale + ox, by = B.y * scale + oy;
    var dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    var ra = radii[ed.a] || 0, rb = radii[ed.b] || 0;
    if (len <= ra + rb + 0.6) return;
    g.moveTo(ax + dx / len * ra, ay + dy / len * ra);
    g.lineTo(bx - dx / len * rb, by - dy / len * rb);
  }
  g.beginPath();
  for (var e = 0; e < plan.edges.length; e++) seg(plan.edges[e]);
  g.strokeStyle = "rgba(" + tc.edge + "," + tc.edgeAlpha.toFixed(3) + ")";
  g.lineWidth = tc.edgeWidth * u;
  g.stroke();
  if (plan.hiEdges && plan.hiEdges.length) {
    g.beginPath();
    for (var h = 0; h < plan.hiEdges.length; h++) seg(plan.hiEdges[h]);
    g.strokeStyle = "rgba(" + tc.edgeHi + ",0.66)";
    g.lineWidth = (tc.edgeWidth + 0.9) * u;
    g.stroke();
  }

  g.textAlign = "center"; g.textBaseline = "middle";
  for (var k = 0; k < plan.order.length; k++) {
    var i = plan.order[k], n = nodes[i], r = radii[i];
    if (r <= 0) continue;
    var x = n.x * scale + ox, y = n.y * scale + oy;
    if (x < -r || y < -r || x > W + r || y > H + r) continue;
    var color = nodeColor(i);
    var isFocus = i === plan.focusIdx || !!(plan.endpoints && plan.endpoints.has(i));
    var isRel = !!(plan.rel && plan.rel.has(i)) && !isFocus;

    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();

    var av = useAv ? SAFE_AV.get(n.face) : null;
    if (av) {
      g.drawImage(av, x - r, y - r, r * 2, r * 2);
    } else if (r >= 7) {
      g.fillStyle = tc.letter;
      g.font = Math.min(28, Math.max(7, r * 1.05)) + "px " + FONT_STACK;
      g.fillText((n.name || "?").trim().charAt(0) || "?", x, y + 0.5);
    }
    if (r >= AVATAR_MIN_R || isFocus || isRel) {
      var rw = (isFocus ? 3.2 : (isRel ? 2.4 : 1.6)) * u;
      g.beginPath(); g.arc(x, y, r + rw * 0.5, 0, Math.PI * 2);
      g.strokeStyle = isFocus ? ringColor(color) : color;
      g.lineWidth = rw; g.stroke();
    }
    if (favSet && favSet.has(n.id)) {
      g.beginPath(); g.arc(x, y, Math.max(r + 3.2 * u, 3.4), 0, Math.PI * 2);
      g.strokeStyle = "rgba(240,201,138,.92)";
      g.lineWidth = 1.3 * u; g.stroke();
    }
  }
  if (plan.title) paintCaption(g, W, H, plan);
}
function ringColor(color) {
  if (themeName === "light") return color.charAt(0) === "#" ? darken(color, 0.32) : "rgba(22,38,58,.55)";
  return color.charAt(0) === "#" ? lighten(color, 0.55) : "rgba(255,255,255,.78)";
}
function paintCaption(g, W, H, plan) {
  var light = themeName === "light";
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  g.fillStyle = light ? "rgba(24,38,56,.88)" : "rgba(234,242,251,.92)";
  g.font = "600 16px " + FONT_STACK;
  g.fillText(plan.title, 30, H - 42);
  g.fillStyle = light ? "rgba(72,90,112,.6)" : "rgba(186,202,222,.48)";
  g.font = "12px " + FONT_STACK;
  g.fillText(plan.sub, 30, H - 22);
  g.fillStyle = light ? "rgba(36,72,112,.85)" : "rgba(150,190,230,.8)";
  g.fillRect(30, H - 62, 22, 2);
}

function drawExport(plan) {
  // 固定按 2 倍像素渲染：屏幕上 dpr=1 时导出的字和细线也够锐利
  var outDpr = 2;
  while (outDpr > 1 && width * height * outDpr * outDpr > 14e6) outDpr -= 0.25;
  var cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(width * outDpr));
  cv.height = Math.max(1, Math.round(height * outDpr));
  var g = cv.getContext("2d", { alpha: false });
  paintExport(g, width, height, plan, outDpr, true);

  // 最后一道保险：画布若被污染（理论上不会），退回无头像版本重画一次
  var tainted = false;
  try { g.getImageData(0, 0, 1, 1); } catch (err) { tainted = true; }
  if (tainted) paintExport(g, width, height, plan, outDpr, false);

  function finish(blob) {
    var url, revoke = false;
    try {
      url = blob ? URL.createObjectURL(blob) : cv.toDataURL("image/png");
      revoke = !!blob;
    } catch (err) {
      appToast("导出失败：" + (err && err.name ? err.name : err));
      return;
    }
    var a = document.createElement("a");
    a.href = url;
    a.download = plan.file || ("bedrock-creators-" + new Date().toISOString().slice(0, 10) + ".png");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (revoke) setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    appToast(plan.note || ("已导出当前画面（" + cv.width + "×" + cv.height + "）"), 2600);
  }
  if (cv.toBlob) cv.toBlob(finish, "image/png");
  else finish(null);
}

var exportBtn = document.getElementById("exportBtn");
if (exportBtn) exportBtn.addEventListener("click", function () {
  if (!layoutReady) { appToast("图还没画好，稍等一下"); return; }
  if (exporting) return;
  exporting = true;
  hideTip();
  var plan = exportPlan();
  var focused = plan.kind !== "full";
  appToast(focused ? "正在生成人物视图…" : "正在生成图片…", 1600);
  var pre = (plan.faces.length && helperUsable())
    ? prefetchClean(plan.faces, plan.faces.length > 90 ? 3600 : 2400)
    : Promise.resolve();
  pre.then(function () { drawExport(plan); })
    .catch(function (e) { appToast("导出失败：" + (e && e.message ? e.message : e)); })
    .then(function () { exporting = false; });
});

function flushPendingSelect() {
  if (!pendingSelectId) return;
  var id = pendingSelectId;
  pendingSelectId = null;
  var i = indexById.get(id);
  if (i !== undefined) applySearchFocus(i);
}
function switchView() {
  exitTool();
  setToolMode(null);
  searchFocus = null; connectFocus = null; toolAmount = 0;
  hideTip();
  layoutReady = false;
  buildView();
  stat.textContent = "切换中…";
  loadLayout(layoutName, false).then(function () {
    stat.textContent = nodes.length + "人 " + edges.length + "边";
    flushPendingSelect();
    notifyView();
  }).catch(function (e) {
    stat.textContent = "布局加载失败";
    pendingSelectId = null;
  });
}
// 通知外部模块（排行榜）当前时代/视图已变化
function notifyView() {
  window.dispatchEvent(new CustomEvent("graph:view", {
    detail: { era: era, layout: layoutName, nodes: nodes.length, edges: edges.length }
  }));
}

/* ------------------------------------------------------------------
 * 对外接口：仅供 js/search.js 调用，不改变原有交互路径
 * ------------------------------------------------------------------ */
var readyHooks = [];
function applySearchFocus(i) {
  closeSearchModal();
  hideTip();
  hidePathBar();
  connectFocus = null;
  var nb = new Set();
  incidentEdges[i].forEach(function (ei) { nb.add(edges[ei].a); nb.add(edges[ei].b); });
  nb.delete(i);
  searchFocus = { node: i, neighbors: nb };
  setToolMode("search");
  setToolbarOpen(true);
  renderToolStatus();
  animateTool(1);
  focusNode(i, true);
  warmAvatars();
}
window.GRAPH_APP = {
  isReady: function () { return layoutReady && nodes.length > 0; },
  era: function () { return era; },
  allNodes: function () { return GRAPH ? GRAPH.nodes : []; },
  allLinks: function () { return GRAPH ? GRAPH.links : []; },
  // 屏幕坐标命中节点（右键菜单、外部模块用）
  nodeAt: function (clientX, clientY) {
    var hit = nearestNode(clientX, clientY, 10);
    if (!hit) return null;
    var n = nodes[hit.index];
    return { index: hit.index, id: String(n.id), name: n.name || "", face: n.face || "" };
  },
  // 取任意（含其它时代的）创作者基础信息
  nodeById: function (id) {
    var raw = rawById.get(String(id));
    return raw ? { id: String(raw.id), name: raw.name || "", face: raw.face || "" } : null;
  },
  // 详情卡：当前视图内的完整信息
  info: function (id) {
    var i = indexById.get(String(id));
    if (i === undefined) return null;
    var n = nodes[i], raw = rawById.get(n.id) || {};
    return { id: n.id, name: n.name, face: n.face, degree: n.degree,
             vpe: n.vpe || 0, vbr: n.vbr || 0, pe: !!raw.pe, br: !!raw.br, era: era };
  },
  // 详情卡：按合作次数排序的一跳邻居
  neighbors: function (id, limit) {
    var i = indexById.get(String(id));
    if (i === undefined) return [];
    var out = incidentEdges[i].map(function (ei) {
      var ed = edges[ei], j = ed.a === i ? ed.b : ed.a, nb = nodes[j];
      return { id: nb.id, name: nb.name, face: nb.face, j: ed.j || 1 };
    });
    out.sort(function (a, b) { return b.j - a.j; });
    return limit ? out.slice(0, limit) : out;
  },
  // 社区布局：某人所属的簇（人数 + 核心人物）
  groupInfo: function (id) {
    if (layoutName !== "comm" || !layoutGroups) return null;
    var i = indexById.get(String(id));
    if (i === undefined) return null;
    var g = layoutGroups[i], size = 0, best = -1;
    for (var k = 0; k < layoutGroups.length; k++) {
      if (layoutGroups[k] !== g) continue;
      size++;
      if (best < 0 || nodes[k].degree > nodes[best].degree) best = k;
    }
    var core = best >= 0 ? nodes[best] : null;
    return { g: g, size: size,
             core: core ? { id: core.id, name: core.name, face: core.face } : null,
             color: (groupColors && groupColors[g]) || null };
  },
  // 高亮整个簇（复用搜索高亮的绘制路径）
  focusGroup: function (g) {
    if (layoutName !== "comm" || !layoutGroups) return false;
    var set = new Set(), best = -1;
    for (var i = 0; i < layoutGroups.length; i++) {
      if (layoutGroups[i] !== g) continue;
      set.add(i);
      if (best < 0 || nodes[i].degree > nodes[best].degree) best = i;
    }
    if (best < 0) return false;
    var nb = new Set(set);
    nb.delete(best);
    searchFocus = { node: best, neighbors: nb, group: g };
    connectFocus = null;
    setToolMode("search");
    setToolbarOpen(true);
    renderToolStatus();
    animateTool(1);
    focusNode(best);
    frameNodes(set);
    warmAvatars();
    return true;
  },
  // 「我的添加」金色标记
  setFavorites: function (ids) {
    favSet = (ids && ids.length) ? new Set(ids.map(String)) : null;
    scheduleDraw();
  },
  hideTip: function () { hideTip(); },
  onReady: function (fn) { if (layoutReady) fn(); else readyHooks.push(fn); },
  // 按 UID 定位：布局就绪后自动聚焦（三分区统一 all 视图，不再切时代）
  openCreator: function (id) {
    id = String(id);
    var i = indexById.get(id);
    if (i !== undefined) { applySearchFocus(i); return true; }
    var raw = rawById.get(id);
    if (!raw) return false;
    pendingSelectId = id;
    return true;
  }
};

function boot(graph) {
  GRAPH = graph;
  if (!GRAPH || !Array.isArray(GRAPH.nodes)) {
    stat.textContent = "数据缺失";
    loading.classList.add("hide");
    return;
  }
  rawById = new Map();
  GRAPH.nodes.forEach(function (n) { rawById.set(String(n.id), n); });
  // 支持带状态的链接：#layout=hub&id=396443102（era 已取消，链接里的 era 参数忽略）
  var bootLayout = "flat", bootHash = parseHash();
  if (bootHash) {
    if (/^(flat|hierarchy|hub|comm)$/.test(bootHash.layout || "")) bootLayout = bootHash.layout;
    document.getElementById("layoutSelect").value = bootLayout;
    if (bootHash.id) pendingSelectId = String(bootHash.id);
  }
  resizeCanvas();
  buildView();
  loadLayout(bootLayout, true).then(function () {
    loading.classList.add("hide");
    scheduleDraw();
    notifyView();
    flushPendingSelect();
    var hooks = readyHooks; readyHooks = [];
    hooks.forEach(function (fn) { fn(); });
    // 从分享链接进来时，直接把那个人的详情卡也打开
    if (bootHash && bootHash.id && window.GRAPH_DETAIL) window.GRAPH_DETAIL.open(bootHash.id);
  }).catch(function () {
    stat.textContent = "布局加载失败(缺少 " + LAYOUT_DIR + ")";
    loading.classList.add("hide");
    var hooks = readyHooks; readyHooks = [];
    hooks.forEach(function (fn) { fn(); });
  });
}

window.addEventListener("resize", resizeCanvas);
if (window.visualViewport) window.visualViewport.addEventListener("resize", resizeCanvas);

// 数据源下拉框：切换读取 data/ 下不同的 json
var sourceSel = document.getElementById("sourceSelect");
// 图谱来源 -> 左上角标题（基岩版沿用原标题）
var SOURCE_TITLES = {
  "bedrock.json": "Bilibili Minecraft 基岩版创作者",
  "java.json": "Bilibili Minecraft Java版创作者",
  "create.json": "Bilibili Minecraft 机械动力创作者"
};
function paintSourceTitle() {
  if (!sourceSel) return;
  var o = sourceSel.options[sourceSel.selectedIndex];
  var label = o ? o.textContent : "选择数据源";
  sourceSel.title = "数据源：" + label;
  var wrap = sourceSel.parentNode;
  if (wrap) wrap.title = "数据源：" + label + "（点击箭头切换）";
  // 同步页面主标题与浏览器标签
  var h1 = document.querySelector(".hud h1");
  if (h1) h1.textContent = SOURCE_TITLES[GRAPH_SOURCE] || ("Bilibili Minecraft " + label + "创作者");
  document.title = SOURCE_TITLES[GRAPH_SOURCE] || (label + "创作者");
}
if (sourceSel) {
  try {
    var saved = localStorage.getItem("bedrock.source.v1");
    if (saved === "graph.json") saved = "bedrock.json";   // 旧数据源迁移到新文件名
    if (saved && Array.prototype.some.call(sourceSel.options, function (o) { return o.value === saved; })) {
      sourceSel.value = saved; GRAPH_SOURCE = saved;
    }
  } catch (e) {}
  paintSourceTitle();
  // 部分内嵌 WebView 不弹原生下拉，点击时用 showPicker 兜底
  sourceSel.addEventListener("click", function () {
    if (typeof this.showPicker === "function") {
      try { this.showPicker(); } catch (e) {}
    }
  });
  sourceSel.addEventListener("change", function () {
    var name = this.value;
    paintSourceTitle();
    try { localStorage.setItem("bedrock.source.v1", name); } catch (e) {}
    layoutCache = {}; layoutGroups = null;
    layoutReady = false; pendingSelectId = null; searchFocus = null;
    loading.classList.remove("hide");
    stat.textContent = "加载 " + name + "…";
    loadGraph(name).then(function (g) {
      boot(g);
      paintSourceTitle();
      // 通知排行榜/搜索等模块：数据源变了，清缓存重算
      window.dispatchEvent(new CustomEvent("graph:source", { detail: { source: name } }));
    }).catch(function (e) {
      stat.textContent = "数据加载失败：" + (e && e.message ? e.message : "");
      loading.classList.add("hide");
    });
  });
}

loadGraph(GRAPH_SOURCE).then(boot).catch(function (e) {
  stat.textContent = "数据加载失败：" + (e && e.message ? e.message : "");
  loading.classList.add("hide");
});
})();

