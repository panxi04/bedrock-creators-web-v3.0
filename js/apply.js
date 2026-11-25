/* ------------------------------------------------------------------
 * 申请收录 UP：右下角胶囊里的 ? 按钮 → 弹窗 → 提交到相对路径 API。
 *   · 昵称与 ID 至少填一个
 *   · POST /api/apply（相对路径，适配反向代理；后端负责写入 apply_list.txt）
 *   · 协议自适应：file:// 下连本地管理器服务（需 exe 运行），http(s) 下走同源相对路径
 * ------------------------------------------------------------------ */
(function () {
"use strict";
function $(id) { return document.getElementById(id); }

var askBtn = $("toolAskBtn"), modal = $("applyModal");
var nameEl = $("apName"), idEl = $("apId"), videosEl = $("apVideos");
var msg = $("apMsg"), submit = $("apSubmit");
if (!askBtn || !modal) return;

function open() {
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  msg.textContent = ""; msg.className = "add-msg";
  nameEl.value = ""; idEl.value = ""; videosEl.value = "";
  setTimeout(function () { nameEl.focus(); }, 30);
}
function close() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

askBtn.addEventListener("click", open);
// 关闭：× 按钮 / 点遮罩 / Esc
Array.prototype.forEach.call(modal.querySelectorAll("[data-close]"), function (b) {
  b.addEventListener("click", close);
});
modal.addEventListener("click", function (ev) { if (ev.target === modal) close(); });
document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && modal.classList.contains("open")) close(); });

function fail(text) { msg.textContent = text; msg.className = "add-msg err"; }

submit.addEventListener("click", function () {
  var name = (nameEl.value || "").trim();
  var uid = (idEl.value || "").trim();
  var videos = (videosEl.value || "").trim();
  if (!name && !uid) { fail("昵称和 ID 至少填写一个"); return; }
  if (videos && !/^\d+$/.test(videos)) { fail("稿件数量请填写非负整数"); return; }

  submit.disabled = true;
  msg.textContent = "提交中…"; msg.className = "add-msg";
  var ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = setTimeout(function () { if (ac) ac.abort(); }, 9000);
  // 协议自适应：file:// 双击本地打开时连管理器本地服务（CORS 已开放）；
  // http(s) 上线时用相对路径走反代。两种模式都不暴露后端地址。
  var base = "";
  try { if (window.GRAPH_ONLINE && window.GRAPH_ONLINE.helperBase) base = window.GRAPH_ONLINE.helperBase() || ""; } catch (e) {}
  fetch(base + "/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name, id: uid, videos: videos }),
    signal: ac ? ac.signal : undefined
  }).then(function (r) {
    clearTimeout(timer);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json().catch(function () { return {}; });
  }).then(function () {
    close();
  }).catch(function (e) {
    clearTimeout(timer);
    fail("提交失败：" + ((e && e.name === "AbortError") ? "请求超时" : (e && e.message ? e.message : "网络异常")) + "，请稍后重试");
  }).then(function () {
    submit.disabled = false;
  });
});
})();
