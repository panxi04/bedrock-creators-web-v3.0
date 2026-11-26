# -*- coding: utf-8 -*-
"""联网搜索服务：移植原 bili_helper.py 的能力，复用 bili.py 的 WBI/风控。

提供：
  search_users(keyword, page)  按名字搜 UP
  up_card(mid)                 名字/头像/签名/等级/粉丝/投稿数
  up_videos(mid, ps)           最近投稿
  fetch_image(url)             头像/封面代理（仅 hdslb.com）

只读、带缓存、低频；所有请求走 Bili 类（真实 buvid + WBI + 412 刹车）。
"""
import re
import threading
import time
import urllib.error
import urllib.request

from bili import Bili, API, RiskError, UA, strip_tags
import throttle

_CACHE = {}
_LOCK = threading.Lock()
_TTL = 300          # 5 分钟
# 最小请求间隔由 throttle.py 统一管理（抓取引擎与联网助手共用），这里不再单独限速

# ---- B 站会话：进程内单例 ----
# 每请求新建 Bili 会跟着发一次 finger/spi（0.35s 令牌位 + 一次网络往返），
# 导出头像几百张时等于几百次无用 spi。这里全程复用同一个会话（CookieJar）。
_B = None
_B_LOCK = threading.Lock()
_B_RENEW_TS = 0.0
RENEW_GAP = 60      # 风控时 60 秒内最多重置一次，避免「每次请求都重建 → 每次都 spi」的风暴


def _silent(_msg):
    pass            # 日志静默，避免写进主抓取日志


def _cached(key, producer):
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    val = _guard(producer)
    if isinstance(val, dict) and val.get("ok"):
        with _LOCK:
            _CACHE[key] = (now, val)
            if len(_CACHE) > 600:
                for k in list(_CACHE)[:200]:
                    _CACHE.pop(k, None)
    return val


def _guard(fn):
    """统一兜底：风控时重置会话并返回结构化错误，避免 500 冒到前端。"""
    try:
        return fn()
    except RiskError as e:
        renewed = renew_bili()
        return {"ok": False, "code": -e.status,
                "message": ("B 站风控(HTTP%d)，会话已重置，请稍后再试" % e.status) if renewed
                           else ("B 站风控(HTTP%d)，请过一会儿再试" % e.status)}
    except Exception as e:
        return {"ok": False, "code": -1, "message": "请求失败：%r" % (e,)}


def _bili():
    global _B
    b = _B
    if b is not None:
        return b
    with _B_LOCK:
        if _B is None:
            # lazy：构造时不发 spi，由第一次真实请求按需取 buvid（见 Bili.ensure_buvid）
            _B = Bili(_silent, lazy=True)
        return _B


def renew_bili():
    """丢掉当前会话：下一次请求会重建实例并重新申请 buvid。"""
    global _B, _B_RENEW_TS
    now = time.time()
    with _B_LOCK:
        if now - _B_RENEW_TS < RENEW_GAP:
            return False
        _B_RENEW_TS = now
        _B = None
    return True


def _get(b, url, referer="https://www.bilibili.com/"):
    """用 Bili 的 CookieJar 发请求，但按接口需要覆盖 Referer。"""
    b.ensure_buvid()
    req = urllib.request.Request(url, headers={
        "User-Agent": b.ua,
        "Referer": referer,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Origin": "https://www.bilibili.com",
    })
    throttle.wait()
    try:
        with b.opener.open(req, timeout=15) as r:
            return __import__("json").loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (412, 403):
            raise RiskError(e.code)
        raise


def search_users(keyword, page=1):
    def go():
        b = _bili()
        q = b.wbi_qs({"search_type": "bili_user", "keyword": keyword, "page": page})
        d = _get(b, API + "/x/web-interface/search/type?" + q,
                 "https://search.bilibili.com/")
        if d.get("code") != 0:
            return {"ok": False, "code": d.get("code"), "message": d.get("message")}
        data = d.get("data") or {}
        items = []
        for r in (data.get("result") or []):
            pic = r.get("upic") or ""
            if pic.startswith("//"):
                pic = "https:" + pic
            items.append({
                "mid": str(r.get("mid") or ""),
                "name": strip_tags(r.get("uname")),
                "face": pic.replace("http://", "https://"),
                "fans": r.get("fans", 0),
                "videos": r.get("videos", 0),
                "level": r.get("level", 0),
                "sign": strip_tags(r.get("usign")),
            })
        return {"ok": True, "data": {"items": items, "pages": data.get("numPages", 1)}}
    return _cached("search:%s:%s" % (page, keyword), go)


def up_card(mid):
    def go():
        b = _bili()
        d = _get(b, API + "/x/web-interface/card?mid=" + mid,
                 "https://space.bilibili.com/" + mid)
        if d.get("code") != 0:
            return {"ok": False, "code": d.get("code"), "message": d.get("message")}
        c = (d.get("data") or {}).get("card") or {}
        return {"ok": True, "data": {
            "mid": str(c.get("mid") or mid),
            "name": c.get("name") or "",
            "face": c.get("face") or "",
            "sign": c.get("sign") or "",
            "level": (c.get("level_info") or {}).get("current_level", 0),
            "fans": c.get("fans", 0),
            "archive": (d.get("data") or {}).get("archive_count", 0),
        }}
    return _cached("card:" + mid, go)


def up_videos(mid, ps=12):
    def go():
        b = _bili()
        url = "%s/x/series/recArchivesByKeywords?mid=%s&keywords=&ps=%d" % (API, mid, ps)
        d = _get(b, url, "https://space.bilibili.com/%s/video" % mid)
        if d.get("code") != 0:
            return {"ok": False, "code": d.get("code"), "message": d.get("message")}
        items = []
        for a in ((d.get("data") or {}).get("archives") or []):
            items.append({
                "aid": a.get("aid"),
                "bvid": a.get("bvid") or "",
                "title": a.get("title") or "",
                "pic": (a.get("pic") or "").replace("http://", "https://"),
                "pubdate": a.get("pubdate") or 0,
                "duration": a.get("duration") or 0,
                "view": (a.get("stat") or {}).get("view", 0),
            })
        return {"ok": True, "data": {"items": items}}
    return _cached("videos:%s:%d" % (mid, ps), go)


# ---- 图片缓存 ----
# 头像/封面都走这条链路：cdn 请求不占 throttle 配额（打的是 CDN 不是 API），
# 但导出一次要点几百张，进程内缓存 + 浏览器 Cache-Control 能省掉绝大多数重复下载。
_IMG = {}                    # key -> (ts, bytes)
_IMG_BYTES = [0]
_IMG_LOCK = threading.Lock()
_IMG_TTL = 86400             # 1 天
_IMG_MAX = 300               # 最多 300 张
_IMG_BYTES_MAX = 64 * 1024 * 1024   # 总量 64MB
_IMG_ONE_MAX = 512 * 1024    # 单张上限 512KB，超过不缓存（也基本不会出现）


def _img_key(url):
    """去掉 @ 后面的尺寸后缀，同一张图的多种尺寸共用一份缓存。"""
    return url.split("@", 1)[0]


def fetch_image(url):
    """仅允许 hdslb.com 图片，返回二进制。只用一个 UA 常量，不建 Bili 会话。"""
    from urllib.parse import urlparse
    host = urlparse(url).hostname or ""
    if not (host == "hdslb.com" or host.endswith(".hdslb.com")):
        return None
    key = _img_key(url)
    now = time.time()
    with _IMG_LOCK:
        hit = _IMG.get(key)
        if hit and now - hit[0] < _IMG_TTL:
            return hit[1]
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Referer": "https://www.bilibili.com/",
        })
        with urllib.request.urlopen(req, timeout=12) as r:
            data = r.read(_IMG_ONE_MAX + 1)
    except Exception:
        return None
    if not data:
        return None
    if len(data) > _IMG_ONE_MAX:
        return None              # 超大图不缓存也不返回，前端会回退首字母
    with _IMG_LOCK:
        # 先摘掉同 key 的旧图，字节数必须同步扣减；否则重复计费会让 64MB 上限提前打满
        old = _IMG.pop(key, None)
        if old is not None:
            _IMG_BYTES[0] -= len(old[1])
        if len(_IMG) >= _IMG_MAX:
            for k in list(_IMG)[:max(1, _IMG_MAX // 3)]:
                _IMG_BYTES[0] -= len(_IMG.pop(k, (0, b""))[1])
        if _IMG_BYTES[0] + len(data) <= _IMG_BYTES_MAX:
            _IMG[key] = (now, data)
            _IMG_BYTES[0] += len(data)
    return data
