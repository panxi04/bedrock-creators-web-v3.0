'use strict';
var TOPICS = [
  { key: 'bedrock', label: '基岩版' },
  { key: 'java', label: 'Java版' },
  { key: 'create', label: '机械动力' }
];
var cfg = {}, jobs = {}, topicStats = {}, current = null, cache = {};

function api(path, body) {
  return fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  } : {}).then(function (r) { return r.json(); });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function fmtTime(ts) {
  return ts ? new Date(ts * 1000).toLocaleString('zh-CN') : '尚未抓取';
}

function renderTabs() {
  document.getElementById('tabs').innerHTML = TOPICS.map(function (t) {
    var s = topicStats[t.key] || { nodes: 0 };
    return '<button class="tab ' + t.key + (current === t.key ? ' active' : '') + '" data-tab="' + t.key + '">' +
      '<span class="dot"></span>' + t.label + ' <span class="cnt">' + s.nodes + '</span></button>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
    b.onclick = function () { switchTopic(b.getAttribute('data-tab')); };
  });
}

function switchTopic(t) {
  current = t;
  renderTabs(); renderViewer(); renderHistory();
}

function renderViewer() {
  if (!current) return;
  var d = cache[current];
  document.getElementById('viewerTitle').textContent =
    (TOPICS.filter(function (x) { return x.key === current; })[0] || {}).label + ' · 数据总览';
  document.getElementById('historyTopic').textContent = '(' + (d && d.label || current) + ')';
  if (!d) {
    document.getElementById('viewerMeta').textContent = '正在读取 data/' + current + '.json …';
    document.getElementById('summary').innerHTML = '';
    document.getElementById('creatorList').innerHTML = '<div class="empty">加载中</div>';
    document.getElementById('edgeList').innerHTML = '<div class="empty">加载中</div>';
    return;
  }
  var s = topicStats[current] || {};
  document.getElementById('viewerMeta').textContent =
    '来源 data/' + current + '.json · 更新于 ' + fmtTime(d.updated);
  document.getElementById('summary').innerHTML =
    '<div class="stat"><b>' + (d.nodes || []).length + '</b><span>作者</span></div>' +
    '<div class="stat"><b>' + (d.links || []).length + '</b><span>合作关系</span></div>' +
    '<div class="stat"><b>' + Object.keys(d.creators || {}).length + '</b><span>作者档案</span></div>' +
    '<div class="stat"><b>' + (d.history || []).length + '</b><span>抓取次数</span></div>';
  renderLists();
}

function renderLists() {
  var d = cache[current];
  if (!d) return;
  var q = (document.getElementById('find').value || '').trim().toLowerCase();
  var names = {};
  (d.nodes || []).forEach(function (n) { names[n.id] = n.name; });
  var ns = (d.nodes || []).slice().sort(function (a, b) { return (b.v || 0) - (a.v || 0); });
  if (q) ns = ns.filter(function (n) {
    return String(n.name).toLowerCase().indexOf(q) >= 0 || String(n.id).indexOf(q) >= 0;
  });
  document.getElementById('creatorList').innerHTML = ns.length
    ? ns.slice(0, 200).map(function (n) {
      return '<div class="row">' +
        (n.face ? '<img class="avatar" src="' + esc(n.face) + '" referrerpolicy="no-referrer">' : '') +
        '<span class="name" title="' + esc(n.id) + '">' + esc(n.name) + '</span>' +
        '<span class="num">' + (n.v || 0) + ' 投稿</span></div>';
    }).join('') : '<div class="empty">没有匹配的作者</div>';

  var ls = (d.links || []).slice().sort(function (a, b) { return (b.n || 0) - (a.n || 0); });
  if (q) ls = ls.filter(function (l) {
    return String(names[l.source] || '').toLowerCase().indexOf(q) >= 0 ||
           String(names[l.target] || '').toLowerCase().indexOf(q) >= 0;
  });
  document.getElementById('edgeList').innerHTML = ls.length
    ? ls.slice(0, 200).map(function (l) {
      return '<div class="row"><span class="name">' + esc(names[l.source] || l.source) +
        ' ↔ ' + esc(names[l.target] || l.target) + '</span>' +
        '<span class="num">' + (l.j ? '联投 · ' : '') + (l.n || 1) + ' 次</span></div>';
    }).join('') : '<div class="empty">没有匹配的关系</div>';
}

// 卡片只构建一次：刷新时不重建 textarea，避免覆盖用户正在输入的关键词
var cardsBuilt = false;
function renderCards() {
  if (cardsBuilt) return;
  document.getElementById('cards').innerHTML = TOPICS.map(function (t) {
    var c = cfg[t.key] || { keywords: [], enabled: false };
    var years = c.years || [2020, 2026];
    return '<div class="card ' + t.key + '" data-card="' + t.key + '">' +
      '<div class="card-head"><h2>' + t.label + '</h2><span class="badge" data-badge>空闲</span></div>' +
      '<div class="meta" data-meta></div>' +
      '<label class="field">抓取关键词（每行一个）</label>' +
      '<textarea id="kw-' + t.key + '">' + esc((c.keywords || []).join('\n')) + '</textarea>' +
      '<div class="rowctl">' +
      '<label class="toggle"><input type="checkbox" id="en-' + t.key + '" ' + (c.enabled ? 'checked' : '') + '> 启用</label>' +
      '<span class="muted">年份</span><input type="number" id="y0-' + t.key + '" value="' + years[0] + '">' +
      '<span class="muted">至</span><input type="number" id="y1-' + t.key + '" value="' + years[1] + '">' +
      '</div><div class="rowctl">' +
      '<button class="btn-save" data-save="' + t.key + '">保存设置</button>' +
      '<button class="btn-run" data-run="' + t.key + '">开始抓取</button>' +
      '<button class="btn-incr" data-incr="' + t.key + '">增量查询</button>' +
      '<button class="btn-stop" data-stop="' + t.key + '" disabled>停止</button>' +
      '<button class="btn-log" data-log="' + t.key + '">查看日志</button>' +
      '</div><div class="eta" id="eta-' + t.key + '"></div>' +
      '<div class="progress"><i id="pg-' + t.key + '"></i></div></div>';
  }).join('');
  cardsBuilt = true;
  Array.prototype.forEach.call(document.querySelectorAll('[data-save]'), function (b) {
    b.onclick = function () { saveTopic(b.getAttribute('data-save')); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-run]'), function (b) {
    b.onclick = function () { runTopic(b.getAttribute('data-run')); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-incr]'), function (b) {
    b.onclick = function () { incrTopic(b.getAttribute('data-incr')); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-stop]'), function (b) {
    b.onclick = function () { api('/api/stop', { topic: b.getAttribute('data-stop') }).then(refresh); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-log]'), function (b) {
    b.onclick = function () { openLog(b.getAttribute('data-log')); };
  });
  updateCards();
}

// 只更新状态显示，绝不改动输入框的值
function updateCards() {
  TOPICS.forEach(function (t) {
    var card = document.querySelector('[data-card="' + t.key + '"]');
    if (!card) return;
    var job = jobs[t.key] || {};
    var running = !!job.running;
    var badge = card.querySelector('[data-badge]');
    if (badge) {
      badge.className = 'badge' + (running ? ' run' : (job.result && job.result.status === 'error' ? ' err' : ''));
      badge.textContent = running ? ('抓取中 · ' + (job.phase || '')) : (job.result && job.result.status === 'error' ? '出错' : '空闲');
    }
    var meta = card.querySelector('[data-meta]');
    if (meta) meta.textContent = '已收录 ' + ((topicStats[t.key] || {}).nodes || 0) + ' 位作者 · ' +
      ((topicStats[t.key] || {}).links || 0) + ' 条关系';
    var run = card.querySelector('[data-run]'), incr = card.querySelector('[data-incr]'),
        stop = card.querySelector('[data-stop]');
    if (run) run.disabled = running;
    if (incr) incr.disabled = running;
    if (stop) stop.disabled = !running;
    var pg = document.getElementById('pg-' + t.key);
    var eta = document.getElementById('eta-' + t.key);
    var pr = job.progress || {};
    var pct = running && pr.total ? Math.min(100, Math.round(pr.done / pr.total * 100)) : (running ? 2 : 0);
    if (pg) pg.style.width = pct + '%';
    if (eta) {
      if (running && pr.total) {
        eta.textContent = fmtEta(pr) + ' · ' + (pr.label || job.phase || '') + ' ' + pr.done + '/' + pr.total;
      } else if (job.result && job.result.status === 'error') {
        eta.textContent = '出错：' + (job.result.error || '详见日志');
      } else {
        eta.textContent = '';
      }
    }
  });
}

// 预估完成时间格式化
function fmtEta(pr) {
  if (!pr || pr.eta === null || pr.eta === undefined) return '估算中…';
  var s = Math.max(0, pr.eta || 0);
  if (s < 60) return '预计还需 ' + s + ' 秒';
  if (s < 3600) return '预计还需 ' + Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  return '预计还需 ' + Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
}

function payload(t) {
  return {
    enabled: document.getElementById('en-' + t).checked,
    keywords: document.getElementById('kw-' + t).value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
    years: [parseInt(document.getElementById('y0-' + t).value, 10) || 2020,
            parseInt(document.getElementById('y1-' + t).value, 10) || 2026]
  };
}
function saveTopic(t) {
  var body = {}; body[t] = payload(t);
  api('/api/config', body).then(function () { alert('已保存 ' + t + ' 的设置'); refresh(); });
}
function runTopic(t) {
  var body = {}; body[t] = payload(t);
  api('/api/config', body).then(function () { return api('/api/crawl', { topic: t }); }).then(function (r) {
    if (r.error) { alert(r.error); return; }
    openLog(t);            // 启动即自动弹出实时日志
    refresh();
  });
}
function incrTopic(t) {
  var body = {}; body[t] = payload(t);
  api('/api/config', body).then(function () { return api('/api/incremental', { topic: t }); }).then(function (r) {
    if (r.error) { alert(r.error); return; }
    openLog(t);            // 与完整抓取一致，启动即弹出实时日志
    refresh();
  });
}

/* ---------- 抓取实时日志弹窗 ---------- */
var logTopic = null, logSince = 0, logTimer = null;
var LOG_LABELS = { bedrock: '基岩版', java: 'Java版', create: '机械动力' };
function logLineClass(line) {
  if (/异常|失败|error|Error|刹车|风控|冷却|Traceback|未连接/.test(line)) return 'err';
  if (/停止|中断|stopped/.test(line)) return 'warn';
  if (/完成|完成：|建图|布局已重算/.test(line)) return 'done';
  return '';
}
function openLog(topic) {
  logTopic = topic; logSince = 0;
  var modal = document.getElementById('logModal');
  modal.hidden = false;
  document.getElementById('logTopic').textContent = LOG_LABELS[topic] || topic;
  document.getElementById('logBody').innerHTML = '';
  document.getElementById('logCount').textContent = '';
  pollLog();
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(pollLog, 1500);
}
function closeLog() {
  document.getElementById('logModal').hidden = true;
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
}
function pollLog() {
  if (!logTopic) return;
  api('/api/log?topic=' + encodeURIComponent(logTopic) + '&since=' + logSince).then(function (r) {
    if (!r.ok) return;
    var body = document.getElementById('logBody');
    if (r.lines && r.lines.length) {
      var html = '';
      r.lines.forEach(function (line) {
        html += '<div class="log-line ' + logLineClass(line) + '">' + esc(line) + '</div>';
      });
      body.insertAdjacentHTML('beforeend', html);
      body.scrollTop = body.scrollHeight;
    }
    logSince = r.next || logSince;
    document.getElementById('logCount').textContent = '共 ' + r.total + ' 行';
    var job = (jobs && jobs[logTopic]) || {};
    var st = document.getElementById('logStatus');
    st.textContent = job.running ? ('抓取中 · ' + (job.phase || '')) : (job.result && job.result.status === 'error' ? '出错' : '空闲');
    st.className = 'badge' + (job.running ? ' run' : (job.result && job.result.status === 'error' ? ' err' : ''));
    var pr = job.progress || {}, pb = document.getElementById('logProgress');
    if (job.running && pr.total) {
      var pct = Math.min(100, Math.round(pr.done / pr.total * 100));
      pb.innerHTML = '<span class="eta">' + fmtEta(pr) + '</span> · ' + esc(pr.label || '') + ' ' + pr.done + '/' + pr.total + ' (' + pct + '%)' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>';
    } else if (job.result && job.result.status === 'error') {
      pb.innerHTML = '<span class="eta" style="color:#dc2626">异常：' + esc(job.result.error || '') + '</span>';
    } else {
      pb.innerHTML = job.end ? '本次抓取已结束' : '准备中…';
    }
  });
}

function renderHistory() {
  var d = cache[current];
  var h = (d && d.history || []).slice().reverse();
  document.getElementById('historyCount').textContent = '共 ' + h.length + ' 次';
  document.getElementById('history').innerHTML = h.length
    ? h.map(function (x) {
      return '<div class="hrow"><span>' + fmtTime(x.ts) + '</span>' +
        '<span class="kw" title="' + esc((x.keywords || []).join('、')) + '">' +
        esc((x.keywords || []).slice(0, 3).join('、')) + '</span>' +
        '<span class="num">+' + (x.new_creators || 0) + ' 人 / +' + (x.new_edges || 0) + ' 边' +
        (x.status ? ' · ' + esc(x.status) : '') + '</span></div>';
    }).join('') : '<div class="empty">该分区暂无抓取记录</div>';
}

function refresh() {
  api('/api/status').then(function (r) {
    jobs = r.jobs || {}; topicStats = r.topics || {};
    renderTabs();
    renderCards();      // 首次构建，之后是 no-op
    updateCards();      // 只刷新状态，不覆盖输入框
  });
  if (current) {
    api('/api/data/' + current).then(function (d) { cache[current] = d; renderViewer(); renderHistory(); });
  }
  loadPending();
}

/* ---- 待渲染名单侧栏：显示已「+」加入、但还没点「重新渲染」的 UP ---- */
var pendingItems = {};
function renderPending() {
  var box = document.getElementById('pendingList');
  if (!box) return;
  var total = 0;
  TOPICS.forEach(function (t) { total += (pendingItems[t.key] || []).length; });
  document.getElementById('pendingCount').textContent = total ? (total + ' 位') : '空';
  var html = '';
  TOPICS.forEach(function (t) {
    var list = pendingItems[t.key] || [];
    if (!list.length) return;
    html += '<div class="pd-group"><div class="pd-group-h"><span class="pd-dot ' + t.key + '"></span>' +
      t.label + '<span class="pd-n">' + list.length + ' 位</span></div>' +
      list.map(function (u) {
        var face = u.face
          ? '<img class="avatar" src="/helper/img?u=' + encodeURIComponent(u.face) + '" referrerpolicy="no-referrer">'
          : '<span class="avatar pd-face">' + esc((u.name || '?').charAt(0)) + '</span>';
        return '<div class="pd-item" data-id="' + esc(u.id) + '" data-topic="' + t.key + '">' + face +
          '<div class="pd-info"><div class="pd-name">' + esc(u.name || ('UID ' + u.id)) + '</div>' +
          '<div class="pd-meta">UID ' + esc(u.id) + ' · ' + esc(fmtTime(u.ts)) + '</div></div>' +
          '<button class="pd-del" type="button" title="从名单移除" aria-label="从名单移除">✕</button></div>';
      }).join('') + '</div>';
  });
  box.innerHTML = html || '<div class="empty">暂无待渲染的 UP</div>';
  Array.prototype.forEach.call(box.querySelectorAll('.pd-del'), function (b) {
    b.onclick = function () {
      var row = b.parentNode;
      var uid = row.getAttribute('data-id'), topic = row.getAttribute('data-topic');
      var name = (row.querySelector('.pd-name') || {}).textContent || '这位 UP';
      if (!uid || !topic || !confirm('从待渲染名单移除「' + name + '」？')) return;
      api('/api/pending-remove', { id: uid, topic: topic }).then(function (r) {
        if (r.ok) loadPending();
        else alert('移除失败：' + (r.message || ''));
      });
    };
  });
}
function loadPending() {
  return api('/api/pending-add').then(function (r) {
    pendingItems = (r && r.items) || {};
    renderPending();
  }).catch(function () { /* 侧栏刷新失败不影响其它功能 */ });
}

// 打开创作者星图：调本地服务用系统默认程序打开原 index.html（绝不修改原文件）
document.getElementById('openVisual').onclick = function () {
  api('/api/open-visual', {}).then(function (r) {
    alert(r.ok ? '已打开创作者星图：\n' + r.path : ('打开失败：' + (r.message || '未知错误')));
  });
};

// 联网搜索
function doSearch() {
  var kw = (document.getElementById('onKw').value || '').trim();
  if (!kw) return;
  var box = document.getElementById('onResults');
  document.getElementById('onWorks').innerHTML = '';
  box.innerHTML = '<div class="empty">搜索中…</div>';
  api('/helper/search?keyword=' + encodeURIComponent(kw)).then(function (r) {
    if (!r.ok) { box.innerHTML = '<div class="empty">搜索失败：' + esc(r.message) + '</div>'; return; }
    var items = (r.data && r.data.items) || [];
    box.innerHTML = items.length ? items.map(function (u, i) {
      var face = u.face ? '<img class="avatar" src="/helper/img?u=' + encodeURIComponent(u.face) + '" referrerpolicy="no-referrer">' : '';
      return '<div class="on-card" data-mid="' + esc(u.mid) + '" data-i="' + i + '"' +
        ' data-face="' + esc(u.face || '') + '" data-videos="' + (u.videos || 0) + '">' + face +
        '<div class="info"><div class="nm">' + esc(u.name) + '</div>' +
        '<div class="meta">UID ' + esc(u.mid) + ' · 粉丝 ' + (u.fans || 0) + ' · 投稿 ' + (u.videos || 0) + '</div></div>' +
        '<button class="on-add" type="button" title="加入分区" aria-label="加入分区">+</button></div>';
    }).join('') : '<div class="empty">没有找到匹配的 UP</div>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-mid]'), function (el) {
      el.onclick = function (ev) {
        if (ev.target.classList.contains('on-add')) return;
        showWorks(el.getAttribute('data-mid'), el.querySelector('.nm').textContent);
      };
      var addBtn = el.querySelector('.on-add');
      if (addBtn) addBtn.onclick = function (ev) {
        ev.stopPropagation();
        openAddToTopic({ id: el.getAttribute('data-mid'), name: el.querySelector('.nm').textContent,
                         face: el.getAttribute('data-face') || '', videos: el.getAttribute('data-videos') || 0 });
      };
    });
  });
}
function showWorks(mid, name) {
  var box = document.getElementById('onWorks');
  box.innerHTML = '<div class="empty">读取 ' + esc(name) + ' 的作品…</div>';
  api('/helper/videos?mid=' + encodeURIComponent(mid) + '&ps=12').then(function (r) {
    var items = (r.data && r.data.items) || [];
    box.innerHTML = '<h3>' + esc(name) + ' 的最近投稿</h3>' + (items.length
      ? '<div class="work-grid">' + items.map(function (v) {
        return '<a class="work" href="https://www.bilibili.com/video/' + esc(v.bvid) + '" target="_blank" rel="noopener">' +
          '<img src="/helper/img?u=' + encodeURIComponent(v.pic) + '" referrerpolicy="no-referrer" loading="lazy">' +
          '<div class="wt">' + esc(v.title) + '</div></a>';
      }).join('') + '</div>' : '<div class="empty">没有可取的作品</div>');
  });
}
document.getElementById('onSearchBtn').onclick = doSearch;
document.getElementById('onKw').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') doSearch();
});

document.getElementById('find').addEventListener('input', renderLists);
document.getElementById('logClose').onclick = closeLog;
document.getElementById('logClear').onclick = function () {
  document.getElementById('logBody').innerHTML = '';
};
api('/api/config').then(function (c) {
  cfg = c;
  current = 'bedrock';
  renderTabs();
  refresh();
  TOPICS.forEach(function (t) {
    api('/api/data/' + t.key).then(function (d) { cache[t.key] = d; });
  });
});
setInterval(function () { if (!renderPolling) refresh(); }, 4000);

/* ---- 申请收录消息：信封红点 + 弹窗 + 一键已读/未读 ---- */
var mailModal = document.getElementById('mailModal');
function loadMails() {
  return api('/api/applies').then(function (r) {
    if (!r.ok) return;
    var dot = document.getElementById('mailDot');
    if (dot) dot.hidden = !(r.unread > 0);
    if (mailModal && !mailModal.hidden) renderMails(r.items, r.unread);
  });
}
function renderMails(items, unread) {
  var box = document.getElementById('mailList');
  document.getElementById('mailCount').textContent = (items ? items.length : 0) + ' 条 · 未读 ' + (unread || 0);
  box.innerHTML = items.length ? items.map(function (m) {
    return '<div class="mail-item ' + (m.read ? 'read' : 'unread') + '">' +
      '<span class="dot"></span><span class="txt">' + esc(m.text) + '</span></div>';
  }).join('') : '<div class="mail-empty">暂无申请消息</div>';
}
document.getElementById('mailBtn').onclick = function () {
  mailModal.hidden = false;
  api('/api/applies').then(function (r) {
    renderMails(r.items || [], r.unread || 0);
    if (r.unread > 0) api('/api/apply-read', { mode: 'all' }).then(function () {
      document.getElementById('mailDot').hidden = true;
      api('/api/applies').then(function (r2) { renderMails(r2.items || [], r2.unread || 0); });
    });
  });
};
document.getElementById('mailClose').onclick = function () { mailModal.hidden = true; };
document.getElementById('mailRefresh').onclick = loadMails;
document.getElementById('mailAllRead').onclick = function () {
  api('/api/apply-read', { mode: 'all' }).then(function () { loadMails(); });
};
document.getElementById('mailAllUnread').onclick = function () {
  api('/api/apply-read', { mode: 'none' }).then(function () { loadMails(); });
};
loadMails();
setInterval(loadMails, 5000);

/* ---- 联网搜索卡片 + ：选择分区（多选）→ 保存到待渲染清单 ---- */
var addModal = document.getElementById('addToTopicModal');
var pendingUp = null;
function openAddToTopic(u) {
  pendingUp = u;
  document.getElementById('addToName').textContent = u.name + '（UID ' + u.id + '）';
  var box = document.getElementById('addToTopics');
  box.innerHTML = TOPICS.map(function (t) {
    return '<label><input type="checkbox" value="' + t.key + '"> ' + t.label + '</label>';
  }).join('');
  addModal.hidden = false;
}
document.getElementById('addToClose').onclick = function () { addModal.hidden = true; };
document.getElementById('addToCancel').onclick = function () { addModal.hidden = true; };
document.getElementById('addToConfirm').onclick = function () {
  if (!pendingUp) return;
  var topics = Array.prototype.slice.call(addModal.querySelectorAll('input:checked')).map(function (x) { return x.value; });
  if (!topics.length) { alert('至少选择一个分区'); return; }
  api('/api/pending-add', { id: pendingUp.id, name: pendingUp.name, face: pendingUp.face,
                            videos: pendingUp.videos, topics: topics }).then(function (r) {
    if (r.ok) {
      addModal.hidden = true;
      loadPending();   // 立刻把刚加入的人显示到右侧名单
      alert('已保存，点击「重新渲染」后生效');
    } else alert('保存失败：' + (r.message || ''));
  });
};

/* ---- 重新渲染：并入图谱 + 重算布局，完成后刷新 ---- */
var renderPolling = false;
function renderProgress(st) {
  var box = document.getElementById('renderProgress');
  box.hidden = false;
  document.getElementById('rpPhase').textContent = st.phase || '处理中…';
  document.getElementById('rpPct').textContent = (st.percent || 0) + '%';
  document.getElementById('rpBar').style.width = (st.percent || 0) + '%';
}
// 渲染完成后确定性刷新：串行读 status + 当前分区数据，全部回来再一次性渲染，避免定时refresh竞态
function refreshAfterRender() {
  return Promise.all([
    api('/api/status'),
    current ? api('/api/data/' + current) : Promise.resolve(null)
  ]).then(function (rs) {
    jobs = rs[0].jobs || {}; topicStats = rs[0].topics || {};
    if (current && rs[1]) cache[current] = rs[1];
    renderTabs(); renderCards(); updateCards();
    if (current) { renderViewer(); renderHistory(); }
    TOPICS.forEach(function (t) { if (t.key !== current) api('/api/data/' + t.key).then(function (d) { cache[t.key] = d; }); });
  });
}
function pollRender(btn) {
  api('/api/render-status').then(function (st) {
    renderProgress(st);
    if (!st.done) { setTimeout(function () { pollRender(btn); }, 1000); return; }
    // 完成：恢复按钮、隐藏进度条、确定性刷新
    btn.disabled = false; btn.textContent = '重新渲染'; renderPolling = false;
    document.getElementById('renderProgress').hidden = true;
    var note = document.getElementById('pendingNote');
    if (note) {
      if (!st.error && st.added) {
        var parts = TOPICS.filter(function (t) { return (st.added[t.key] || 0) > 0; })
          .map(function (t) { return t.label + ' +' + st.added[t.key]; });
        note.textContent = parts.length ? ('上次渲染并入：' + parts.join(' · ')) : '';
      } else { note.textContent = ''; }
    }
    loadPending();   // 渲染后名单应清空
    refreshAfterRender().then(function () {
      alert(st.error ? ('渲染失败：' + st.error) : '渲染完成');
    });
  }).catch(function () {
    btn.disabled = false; btn.textContent = '重新渲染'; renderPolling = false;
    document.getElementById('renderProgress').hidden = true;
    refreshAfterRender();
  });
}
document.getElementById('btnRender').onclick = function () {
  if (renderPolling) return;
  if (!confirm('确定把已加入分区的 UP 并入图谱并重算布局吗？')) return;
  var btn = this; btn.disabled = true; btn.textContent = '渲染中…'; renderPolling = true;
  api('/api/render', {}).then(function (r) {
    if (!r.ok) {
      btn.disabled = false; btn.textContent = '重新渲染'; renderPolling = false;
      alert('渲染失败：' + (r.message || '')); return;
    }
    renderProgress({ phase: '启动', percent: 0 });
    var note = document.getElementById('pendingNote');
    if (note) note.textContent = '';
    pollRender(btn);
  }).catch(function (e) {
    btn.disabled = false; btn.textContent = '重新渲染'; renderPolling = false;
    alert('渲染请求失败：' + (e && e.message ? e.message : '网络异常'));
  });
};
