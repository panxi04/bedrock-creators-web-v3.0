# -*- coding: utf-8 -*-
"""创作者图谱管理器：本地 HTTP 服务 + 原生桌面窗口。

统一管理：抓取数据 / 联网搜索 / 打开创作者星图。
"""
import json
import os
import sys
import threading
import time
import urllib.parse
import webbrowser
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

    def _send(self, code, ctype, body, cache="no-store"):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
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
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return {}

    def do_GET(self):
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
                since = max(0, int((q.get("since") or ["0"])[0] or 0))
            except (TypeError, ValueError):
                since = 0
            lp = os.path.join(store.STATE, topic, "crawl.log")
            lines = []
            if os.path.isfile(lp):
                with open(lp, encoding="utf-8", errors="replace") as f:
                    lines = f.read().splitlines()
            return self._json({"ok": True, "topic": topic, "lines": lines[since:],
                               "total": len(lines), "next": len(lines)})
        # 兼容原 index.html 的联网助手路径（/ping /search /card /videos /img）
        if path == "/ping":
            return self._json({"ok": True, "version": "manager/1.0"})
        if path in ("/search", "/helper/search"):
            kw = (q.get("keyword") or [""])[0].strip()
            if not kw:
                return self._json({"ok": False, "message": "keyword 不能为空"}, 400)
            page = max(1, min(10, int((q.get("page") or ["1"])[0] or 1)))
            return self._json(helper.search_users(kw[:50], page))
        if path in ("/card", "/helper/card"):
            mid = (q.get("mid") or [""])[0].strip()
            if not mid.isdigit():
                return self._json({"ok": False, "message": "mid 无效"}, 400)
            return self._json(helper.up_card(mid))
        if path in ("/videos", "/helper/videos"):
            mid = (q.get("mid") or [""])[0].strip()
            if not mid.isdigit():
                return self._json({"ok": False, "message": "mid 无效"}, 400)
            ps = max(1, min(30, int((q.get("ps") or ["12"])[0] or 12)))
            return self._json(helper.up_videos(mid, ps))
        if path in ("/img", "/helper/img"):
            src = (q.get("u") or [""])[0]
            data = helper.fetch_image(src)
            if data is None:
                return self._json({"ok": False, "message": "图片获取失败"}, 502)
            return self._send(200, "image/jpeg", data, "max-age=86400")
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
        path = urllib.parse.urlparse(self.path).path
        body = self._body()
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
            name = str(body.get("name") or "").strip()
            uid = str(body.get("id") or "").strip()
            videos = str(body.get("videos") or "").strip()
            if not name and not uid:
                return self._json({"ok": False, "message": "昵称和ID至少填一个"}, 400)
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
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/" % PORT
    _debug("创作者图谱管理器已启动: %s" % url)

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
            win = webview.create_window("创作者图谱管理器", url, width=1280, height=860,
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
