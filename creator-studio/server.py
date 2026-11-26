# -*- coding: utf-8 -*-
"""graph-server：本地 HTTP 服务 + 原生桌面窗口。

统一管理：抓取数据 / 联网搜索 / 打开创作者星图。
"""
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import engine
import store
import helper

if getattr(sys, "frozen", False):
    # exe 与原项目 index.html 同层（bedrock-creators-web/ 根目录）
    # 工具自身的配置/数据放在同层的 creator-studio/ 子目录，绝不写进原项目 data/
    EXE_DIR = os.path.dirname(os.path.abspath(sys.executable))
    BASE = os.path.join(EXE_DIR, "creator-studio")
    WEB = os.path.join(getattr(sys, "_MEIPASS", BASE), "web")
else:
    BASE = os.path.dirname(os.path.abspath(__file__))
    WEB = os.path.join(BASE, "web")
CONFIG = os.path.join(BASE, "config.json")
APPLY_TXT = os.path.join(BASE, "apply_list.txt")          # 申请收录消息（追加写）
APPLY_READ = os.path.join(BASE, "apply_read.json")        # 已读状态：已读行的行号列表
PENDING_ADD = os.path.join(store.STATE, "pending_adds.json")  # 待渲染的手动加入清单
APPLY_LOCK = threading.Lock()
RENDER_JOB = {"running": False, "percent": 0, "phase": "", "done": False, "error": "", "added": {}}
RENDER_LOCK = threading.Lock()
PORT = int(os.environ.get("CREATOR_STUDIO_PORT", "8788"))

# ---- 输入与并发限制 ----
# /api/apply 是唯一对公网开放的可写接口（Caddy 白名单里只有它），
# 其余 /api/* 只在管理器本机使用，但依然统一限一遍，避免畸形请求把进程搞挂。
MAX_BODY = 16 * 1024          # 请求体上限 16KB
MAX_QUERY = 2048              # 整条 URL 上限
MAX_KW = 50                   # 搜索关键词截断长度（与前端提示一致）
MAX_URL = 512                 # /img 代理的地址长度上限
MAX_CONCURRENT = 32           # 同时处理的连接数，超出直接 503
SOCK_TIMEOUT = 30             # 单连接 socket 超时，防慢速连接长期占用
LOG_TAIL_BYTES = 8 * 1024 * 1024   # /api/log 最多读日志尾部 8MB

APPLY_PER_IP = 5              # 每 IP 10 分钟最多提交 5 条
APPLY_GLOBAL = 120            # 全局 10 分钟最多 120 条，防刷爆磁盘
APPLY_WINDOW = 600

_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_APPLY_HITS = {}              # ip -> deque[ts]，只保留窗口内的提交
_APPLY_ALL = deque()          # 全局窗口内的提交时间戳（用于总量配额）
_APPLY_LOCK = threading.Lock()


def _clean(s, limit):
    """去掉控制字符（含换行，防止往 apply_list.txt 里注入假记录）并截断。"""
    return _CTRL.sub(" ", str(s or "")).strip()[:limit]


def _qint(q, key, default, lo, hi):
    """取整数查询参数：非法抛 ValueError（调用方回 400），越界clamp。"""
    raw = (q.get(key) or [""])[0].strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except (TypeError, ValueError):
        raise ValueError(key)
    return max(lo, min(hi, v))


def _apply_allowed(ip):
    """按 IP + 全局两个维度的滑动窗口，防止 /api/apply 被灌垃圾。

    注意：全局总量必须用「窗口内」的时间戳统计。早期写法遍历所有 IP 的原始列表，
    过期的历史记录会永久计入总量，累积到 APPLY_GLOBAL 之后所有人都会收到 429。
    """
    now = time.time()
    cutoff = now - APPLY_WINDOW
    with _APPLY_LOCK:
        while _APPLY_ALL and _APPLY_ALL[0] <= cutoff:
            _APPLY_ALL.popleft()
        q = _APPLY_HITS.get(ip)
        if q is None:
            q = _APPLY_HITS[ip] = deque()
        else:
            while q and q[0] <= cutoff:
                q.popleft()
        if len(q) >= APPLY_PER_IP or len(_APPLY_ALL) >= APPLY_GLOBAL:
            return False
        q.append(now)
        _APPLY_ALL.append(now)
        # 僵尸 IP 的空队列定期清掉，避免字典无限增长
        if len(_APPLY_HITS) > 5000:
            for k in [k for k, v in _APPLY_HITS.items() if not v]:
                _APPLY_HITS.pop(k, None)
        return True


def _client_ip(handler):
    """经过 Cloudflare 时真实 IP 在 CF-Connecting-IP；直连（本机）用它自己。"""
    ip = (handler.headers.get("CF-Connecting-IP") or "").strip()
    if not ip:
        ip = handler.client_address[0]
    return _clean(ip, 45)


def _read_log_tail(path, max_bytes=LOG_TAIL_BYTES):
    """读日志尾部，返回 (lines, truncated)。日志过大时只给尾部，不再整份读进内存。"""
    size = os.path.getsize(path)
    if size <= max_bytes:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().splitlines(), False
    with open(path, "rb") as f:
        f.seek(size - max_bytes)
        raw = f.read()
    if b"\n" in raw:
        raw = raw.split(b"\n", 1)[1]      # 丢掉可能被截断的半行
    return raw.decode("utf-8", "replace").splitlines(), True

# 原项目 index.html：与 exe 同层（或源码运行时在上级目录）。只取路径打开，绝不修改。
def find_visual_index():
    candidates = [
        os.path.join(os.path.dirname(BASE), "index.html"),
        os.path.join(os.path.dirname(os.path.dirname(BASE)), "bedrock-creators-web", "index.html"),
        os.path.join(BASE, "bedrock-creators-web", "index.html"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None

DEFAULT_CONFIG = {
    "bedrock": {
        "label": "基岩版", "enabled": True,
        "keywords": ["我的世界基岩版", "基岩版", "我的世界PE", "MCPE", "我的世界手机版", "MCBE"],
        "years": [2011, 2026], "workers": 8, "detail_delay": 0.7,
        "signals": {
            "strong": ["基岩", "bedrock", "mcbe", "mcpe", "携带版", "addon", "行为包", "pocket\\s*edition", "minecraft\\s*pe"],
            "weak": ["手机版", "移动版", "手游", "安卓", "android", "ios"],
            "context": ["我的世界", "minecraft", "(?<![A-Za-z])mc(?![A-Za-z])", "方块", "苦力怕", "史蒂夫", "红石", "生存", "建造"],
            "other_game": ["迷你世界", "蛋仔派对", "和平精英", "原神", "roblox", "我的世界地下城"],
        },
    },
    "java": {
        "label": "Java版", "enabled": True,
        "keywords": ["我的世界Java版", "Java版生存", "minecraft java", "我的世界整合包", "我的世界mod", "我的世界模组", "minecraft forge", "minecraft fabric"],
        "years": [2011, 2026], "workers": 8, "detail_delay": 0.7,
        "signals": {
            "strong": ["java版", "java\\s*edition", "minecraft\\s*java", "forge", "fabric", "optifine", "(?<![A-Za-z])java(?![A-Za-z])"],
            "weak": ["模组", "整合包", "光影", "材质包", "mod"],
            "context": ["我的世界", "minecraft", "(?<![A-Za-z])mc(?![A-Za-z])", "方块", "生存", "红石"],
            "other_game": ["迷你世界", "蛋仔派对", "基岩版", "bedrock", "mcbe", "我的世界地下城"],
        },
    },
    "create": {
        "label": "机械动力", "enabled": True,
        "keywords": ["我的世界机械动力", "机械动力", "机械动力生存", "我的世界create", "create mod", "minecraft create", "机械动力教程", "create模组"],
        "years": [2019, 2026], "workers": 8, "detail_delay": 0.7,
        "signals": {
            "strong": ["机械动力", "create\\s*mod", "create模组", "我的世界create", "mc\\s*create", "contraption"],
            "weak": ["create", "齿轮", "传送带", "蒸汽", "动力", "自动化", "红石机关"],
            "context": ["我的世界", "minecraft", "(?<![A-Za-z])mc(?![A-Za-z])", "方块", "生存", "整合包", "模组"],
            "other_game": ["迷你世界", "蛋仔派对", "罗布乐思", "roblox", "我的世界地下城", "原神", "和平精英"],
        },
    },
}

TOPICS = ("bedrock", "java", "create")

INCREMENTAL_DEFAULTS = {
    "incremental_interval_days": 90,
    "incremental_pages_max": 5,
    "incremental_catchup_pages": 2,
    "net_fail_limit": 5,          # 连续网络异常达到该次数即熔断停止（抓取/增量通用）
}

# app.ico 同时用于 PyInstaller exe 图标与 pywebview 原生窗口图标
ICON = os.path.join(getattr(sys, "_MEIPASS", BASE), "app.ico")
if not os.path.isfile(ICON):
    ICON = os.path.join(BASE, "app.ico")


def load_config():
    if os.path.exists(CONFIG):
        try:
            with open(CONFIG, encoding="utf-8") as f:
                cfg = json.load(f)
            for t in TOPICS:
                cfg.setdefault(t, DEFAULT_CONFIG[t])
            for k, v in INCREMENTAL_DEFAULTS.items():
                cfg.setdefault(k, v)
            return cfg
        except (ValueError, OSError):
            pass
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(INCREMENTAL_DEFAULTS)
    save_config(cfg)
    return cfg


def save_config(cfg):
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CONFIG)


def _read_applies():
    """读全部申请消息：{line, ts, raw, read}。行号即稳定ID（txt只追加）。按时间倒序。"""
    lines = []
    if os.path.isfile(APPLY_TXT):
        with open(APPLY_TXT, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    try:
        read_set = set(json.load(open(APPLY_READ, encoding="utf-8")).get("read", []))
    except (ValueError, OSError, AttributeError):
        read_set = set()
    out = []
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        # 时间从 [YYYY-MM-DD HH:MM:SS] 前缀解析，解析不到用行号兜底排序
        ts = line[1:20] if line.startswith("[") and len(line) >= 20 else ""
        out.append({"line": i, "ts": ts, "text": line, "read": i in read_set})
    out.sort(key=lambda x: (x["ts"], x["line"]), reverse=True)
    return out


def _write_read_set(lines):
    tmp = APPLY_READ + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"read": sorted(set(lines))}, f)
    os.replace(tmp, APPLY_READ)


def _read_pending():
    try:
        d = json.load(open(PENDING_ADD, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (ValueError, OSError):
        return {}


def _write_pending(d):
    os.makedirs(os.path.dirname(PENDING_ADD), exist_ok=True)
    tmp = PENDING_ADD + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PENDING_ADD)


def _render_set(percent, phase, done=False, error="", added=None):
    with RENDER_LOCK:
        RENDER_JOB["percent"] = percent
        RENDER_JOB["phase"] = phase
        RENDER_JOB["done"] = done
        RENDER_JOB["error"] = error
        if done:
            RENDER_JOB["running"] = False
        if added is not None:
            RENDER_JOB["added"] = added


def _render_worker(pending):
    """后台线程：把待渲染清单并入各分区图谱并重算布局，按阶段上报进度。"""
    try:
        from make_layouts import make as make_layouts
        _render_set(5, "准备合并")
        pending = {t: lst for t, lst in pending.items() if t in TOPICS and lst}
        total = max(1, len(pending))
        labels = {"bedrock": "基岩版", "java": "Java版", "create": "机械动力"}
        done, i = {}, 0
        for t, lst in pending.items():
            i += 1
            base = 5 + int(85 * (i - 1) / total)
            label = labels.get(t, t)
            _render_set(base, "合并 " + label + " 数据")
            d = store.read(t)
            ids = {str(n.get("id")) for n in d["nodes"]}
            added = 0
            for rec in lst:
                uid = str(rec.get("id") or "")
                if not uid or uid in ids:
                    continue
                v = int(rec.get("videos") or 0)
                d["nodes"].append({"id": uid, "name": rec.get("name") or ("UID " + uid),
                                   "face": rec.get("face") or "", "v": v})
                d["creators"][uid] = {"name": rec.get("name") or "", "face": rec.get("face") or "",
                                      "v": v, "first": int(rec.get("ts") or time.time()),
                                      "last": int(rec.get("ts") or time.time()),
                                      "sources": ["手动加入"]}
                ids.add(uid); added += 1
            if added:
                d["updated"] = int(time.time())
                store._write(t, d)
                _render_set(base + int(85 / total * 0.3), label + " 重算布局中")
                make_layouts(store.FILES[t], os.path.join(store.DATA, "layouts_" + t))
            done[t] = added
            _render_set(base + int(85 / total), label + " 完成")
        with APPLY_LOCK:
            _write_pending({})
        _render_set(100, "完成", done=True, added=done)
    except Exception as e:
        _render_set(RENDER_JOB["percent"], "失败", done=True, error=repr(e))


class Handler(BaseHTTPRequestHandler):
    server_version = "CreatorStudio/1.0"
    timeout = SOCK_TIMEOUT

    def _send(self, code, ctype, body, cache="no-store", extra=None):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("Access-Control-Allow-Origin", "*")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def _not_modified(self, etag):
        try:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "public, max-age=604800, immutable")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
        except (ConnectionResetError, BrokenPipeError):
            pass

    def _json(self, obj, code=200):
        self._send(code, "application/json; charset=utf-8",
                   json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _body(self):
        """读 JSON 请求体；非法或超限直接回 4xx 并返回 None（调用方立即 return）。"""
        raw = self.headers.get("Content-Length")
        if raw is None or raw == "":
            return {}
        try:
            n = int(raw)
        except (TypeError, ValueError):
            self._json({"ok": False, "message": "Content-Length 无效"}, 400)
            return None
        if n < 0:
            self._json({"ok": False, "message": "Content-Length 无效"}, 400)
            return None
        if n == 0:
            return {}
        if n > MAX_BODY:
            self._json({"ok": False, "message": "请求体过大"}, 413)
            return None
        try:
            d = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json({"ok": False, "message": "请求体不是合法 JSON"}, 400)
            return None
        if not isinstance(d, dict):
            self._json({"ok": False, "message": "请求体必须是 JSON 对象"}, 400)
            return None
        return d

    def do_GET(self):
        if len(self.path) > MAX_QUERY:
            return self._json({"ok": False, "message": "URL 过长"}, 414)
        u = urllib.parse.urlparse(self.path)
        path = u.path
        q = urllib.parse.parse_qs(u.query)
        if path in ("/", "/index.html"):
            with open(os.path.join(WEB, "index.html"), "rb") as f:
                return self._send(200, "text/html; charset=utf-8", f.read())
        if path == "/app.js":
            with open(os.path.join(WEB, "app.js"), "rb") as f:
                return self._send(200, "application/javascript; charset=utf-8", f.read())
        if path == "/style.css":
            with open(os.path.join(WEB, "style.css"), "rb") as f:
                return self._send(200, "text/css; charset=utf-8", f.read())
        if path == "/api/config":
            return self._json(load_config())
        if path == "/api/status":
            return self._json({"jobs": engine.status(), "topics": store.stats_all()})
        if path.startswith("/api/data/"):
            topic = path[len("/api/data/"):]
            if topic not in store.TOPICS:
                return self._json({"error": "unknown topic"}, 404)
            return self._json(store.read(topic))
        if path == "/api/visual-path":
            p = find_visual_index()
            return self._json({"ok": bool(p), "path": p or ""})
        if path == "/api/log":
            topic = (q.get("topic") or [""])[0] if q else ""
            if topic not in store.TOPICS:
                return self._json({"ok": False, "message": "unknown topic"}, 400)
            try:
                since = _qint(q, "since", 0, 0, 10 ** 9)
            except ValueError:
                return self._json({"ok": False, "message": "since 参数无效"}, 400)
            lp = os.path.join(store.STATE, topic, "crawl.log")
            lines, truncated = ([], False)
            if os.path.isfile(lp):
                lines, truncated = _read_log_tail(lp)
            since = max(0, min(since, len(lines)))
            return self._json({"ok": True, "topic": topic, "lines": lines[since:],
                               "total": len(lines), "next": len(lines),
                               "truncated": truncated})
        # 兼容原 index.html 的联网助手路径（/ping /search /card /videos /img）
        if path == "/ping":
            # rev 便于上线后确认新版本真的生效（替换 exe 后看这个字段即可）
            return self._json({"ok": True, "version": "manager/1.1", "rev": "20261126b"})
        if path in ("/search", "/helper/search"):
            kw = (q.get("keyword") or [""])[0].strip()
            if not kw:
                return self._json({"ok": False, "message": "keyword 不能为空"}, 400)
            if len(kw) > 200:
                return self._json({"ok": False, "message": "keyword 过长"}, 400)
            try:
                page = _qint(q, "page", 1, 1, 10)
            except ValueError:
                return self._json({"ok": False, "message": "page 参数无效"}, 400)
            return self._json(helper.search_users(kw[:MAX_KW], page))
        if path in ("/card", "/helper/card"):
            mid = (q.get("mid") or [""])[0].strip()
            if not re.match(r"^\d{1,12}$", mid):
                return self._json({"ok": False, "message": "mid 无效"}, 400)
            return self._json(helper.up_card(mid))
        if path in ("/videos", "/helper/videos"):
            mid = (q.get("mid") or [""])[0].strip()
            if not re.match(r"^\d{1,12}$", mid):
                return self._json({"ok": False, "message": "mid 无效"}, 400)
            try:
                ps = _qint(q, "ps", 12, 1, 30)
            except ValueError:
                return self._json({"ok": False, "message": "ps 参数无效"}, 400)
            return self._json(helper.up_videos(mid, ps))
        if path in ("/img", "/helper/img"):
            src = (q.get("u") or [""])[0]
            if not src:
                return self._json({"ok": False, "message": "u 不能为空"}, 400)
            if len(src) > MAX_URL:
                return self._json({"ok": False, "message": "u 过长"}, 400)
            data = helper.fetch_image(src)
            if data is None:
                return self._json({"ok": False, "message": "图片获取失败"}, 502)
            etag = '"%s"' % hashlib.md5(data).hexdigest()[:16]
            if self.headers.get("If-None-Match") == etag:
                return self._not_modified(etag)
            return self._send(200, "image/jpeg", data,
                              "public, max-age=604800, immutable", {"ETag": etag})
        if path == "/api/applies":
            items = _read_applies()
            return self._json({"ok": True, "items": items,
                               "unread": sum(1 for x in items if not x["read"])})
        if path == "/api/pending-add":
            return self._json({"ok": True, "items": _read_pending()})
        if path == "/api/render-status":
            with RENDER_LOCK:
                return self._json({"ok": True, **{k: v for k, v in RENDER_JOB.items()}})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        if len(self.path) > MAX_QUERY:
            return self._json({"ok": False, "message": "URL 过长"}, 414)
        path = urllib.parse.urlparse(self.path).path
        body = self._body()
        if body is None:
            return
        if path == "/api/config":
            cfg = load_config()
            for t in TOPICS:
                if t in body:
                    for k in ("enabled", "keywords", "years", "workers", "detail_delay"):
                        if k in body[t]:
                            cfg[t][k] = body[t][k]
                    if "signals" in body[t]:
                        cfg[t]["signals"].update(body[t]["signals"])
            save_config(cfg)
            return self._json({"ok": True})
        if path == "/api/crawl":
            topic = body.get("topic")
            if topic not in TOPICS:
                return self._json({"error": "unknown topic"}, 400)
            cfg = load_config()
            if engine.run_topic(topic, cfg[topic]):
                return self._json({"ok": True, "topic": topic})
            return self._json({"error": "该主题正在抓取中"}, 409)
        if path == "/api/incremental":
            topic = body.get("topic")
            if topic not in TOPICS:
                return self._json({"error": "unknown topic"}, 400)
            cfg = load_config()
            if engine.run_incremental(topic, cfg):
                return self._json({"ok": True, "topic": topic})
            return self._json({"error": "该主题正在查询中"}, 409)
        if path == "/api/stop":
            topic = body.get("topic")
            return self._json({"ok": engine.stop_topic(topic)})
        if path == "/api/open-visual":
            p = find_visual_index()
            if not p:
                return self._json({"ok": False, "message": "未找到 bedrock-creators-web/index.html"}, 404)
            try:
                webbrowser.open("file:///" + p.replace("\\", "/"))
                return self._json({"ok": True, "path": p})
            except Exception as e:
                return self._json({"ok": False, "message": repr(e)}, 500)
        if path == "/api/apply":
            # 公网唯一可写入口：字段长度、类型、频率三重校验
            name = _clean(body.get("name"), 32)
            uid = _clean(body.get("id"), 12)
            videos = _clean(body.get("videos"), 6)
            if uid and not uid.isdigit():
                return self._json({"ok": False, "message": "ID 只能是数字"}, 400)
            if videos and not videos.isdigit():
                return self._json({"ok": False, "message": "稿件数量只能是数字"}, 400)
            if not name and not uid:
                return self._json({"ok": False, "message": "昵称和ID至少填一个"}, 400)
            ip = _client_ip(self)
            if not _apply_allowed(ip):
                return self._json({"ok": False, "message": "提交过于频繁，请稍后再试"}, 429)
            ts = time.strftime("%Y-%m-%d %H:%M:%S")
            with APPLY_LOCK:
                with open(APPLY_TXT, "a", encoding="utf-8", newline="\n") as f:
                    f.write("[%s] 昵称=%s | ID=%s | 稿件数量=%s\n"
                            % (ts, name or "-", uid or "-", videos or "-"))
            return self._json({"ok": True})
        if path == "/api/apply-read":
            mode = body.get("mode")  # all / none / lines
            with APPLY_LOCK:
                if mode == "all":
                    _write_read_set([x["line"] for x in _read_applies()])
                elif mode == "none":
                    _write_read_set([])
                elif mode == "lines" and isinstance(body.get("lines"), list):
                    cur = set()
                    try:
                        cur = set(json.load(open(APPLY_READ, encoding="utf-8")).get("read", []))
                    except (ValueError, OSError, AttributeError):
                        pass
                    cur.update(int(x) for x in body["lines"] if str(x).isdigit())
                    _write_read_set(cur)
                else:
                    return self._json({"ok": False, "message": "mode 无效"}, 400)
            return self._json({"ok": True, "unread": sum(1 for x in _read_applies() if not x["read"])})
        if path == "/api/pending-add":
            uid = str(body.get("id") or "").strip()
            if not uid.isdigit():
                return self._json({"ok": False, "message": "uid 无效"}, 400)
            topics = [t for t in (body.get("topics") or []) if t in TOPICS]
            if not topics:
                return self._json({"ok": False, "message": "至少选一个分区"}, 400)
            rec = {"id": uid, "name": str(body.get("name") or "").strip(),
                   "face": str(body.get("face") or "").strip(),
                   "videos": str(body.get("videos") or "").strip(),
                   "ts": int(time.time())}
            with APPLY_LOCK:
                d = _read_pending()
                for t in topics:
                    lst = d.setdefault(t, [])
                    lst[:] = [x for x in lst if str(x.get("id")) != uid]  # 去重，更新覆盖
                    lst.append(rec)
                _write_pending(d)
            return self._json({"ok": True, "topics": topics})
        if path == "/api/pending-remove":
            # 从「待渲染名单」移除某位 UP：按分区逐行移除，不影响其它分区的同一 UP
            uid = str(body.get("id") or "").strip()
            topic = str(body.get("topic") or "").strip()
            if not uid.isdigit() or topic not in TOPICS:
                return self._json({"ok": False, "message": "参数无效"}, 400)
            with APPLY_LOCK:
                d = _read_pending()
                d[topic] = [x for x in (d.get(topic) or []) if str(x.get("id")) != uid]
                if not d[topic]:
                    d.pop(topic, None)
                _write_pending(d)
            return self._json({"ok": True, "items": d})
        if path == "/api/render":
            # 异步：立即返回，后台线程重算布局并按阶段上报进度（前端轮询 /api/render-status）
            with RENDER_LOCK:
                if RENDER_JOB["running"]:
                    return self._json({"ok": False, "message": "正在渲染中"}, 409)
            pending = _read_pending()
            if not pending:
                return self._json({"ok": False, "message": "没有待渲染的 UP"}, 400)
            with RENDER_LOCK:
                RENDER_JOB.update({"running": True, "percent": 0, "phase": "启动",
                                   "done": False, "error": "", "added": {}})
            threading.Thread(target=_render_worker, args=(pending,), daemon=True).start()
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        pass


class LimitedServer(ThreadingHTTPServer):
    """限制同时处理的连接数：每请求一线程，不设上限时小请求就能把线程打满。"""
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self._sem = threading.Semaphore(MAX_CONCURRENT)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._sem.acquire(timeout=5):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\n"
                                b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._sem.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._sem.release()


def _debug(msg):
    """冻结 exe 无控制台，把启动诊断写到 data/ 下，方便排查窗口是否成功。"""
    print(msg, flush=True)
    try:
        with open(os.path.join(BASE, "data", "startup.log"), "a", encoding="utf-8") as f:
            f.write(time.strftime("[%H:%M:%S] ") + msg + "\n")
    except OSError:
        pass


def main():
    os.chdir(BASE)
    load_config()
    srv = LimitedServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/" % PORT
    _debug("graph-server 已启动: %s" % url)

    if "--no-window" in sys.argv:
        # 调试模式：不开窗口，保持进程
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    else:
        try:
            import webview
            _debug("pywebview 已导入，创建原生窗口")
            win = webview.create_window("graph-server", url, width=1280, height=860,
                                        min_size=(960, 640))
            webview.start(icon=ICON if os.path.isfile(ICON) else None)
            _debug("原生窗口已关闭，退出")
        except Exception as e:
            # 万一 WebView2 缺失，降级到浏览器，保证程序仍可用
            _debug("原生窗口启动失败(%r)，降级浏览器" % e)
            webbrowser.open(url)
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                pass
    srv.shutdown()


if __name__ == "__main__":
    main()
