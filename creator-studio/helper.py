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

from bili import Bili, API, strip_tags
import throttle

_CACHE = {}
_LOCK = threading.Lock()
_TTL = 300          # 5 分钟
# 最小请求间隔由 throttle.py 统一管理（抓取引擎与联网助手共用），这里不再单独限速


def _cached(key, producer):
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _TTL:
            return hit[1]
    val = producer()
    if isinstance(val, dict) and val.get("ok"):
        with _LOCK:
            _CACHE[key] = (now, val)
            if len(_CACHE) > 600:
                for k in list(_CACHE)[:200]:
                    _CACHE.pop(k, None)
    return val


def _bili():
    return Bili(lambda m: None)   # 日志静默，避免写进主抓取日志


def _get(b, url, referer="https://www.bilibili.com/"):
    """用 Bili 的 CookieJar 发请求，但按接口需要覆盖 Referer。"""
    import urllib.request
    req = urllib.request.Request(url, headers={
        "User-Agent": b.opener.addheaders[0][1] if b.opener.addheaders else "",
        "Referer": referer,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Origin": "https://www.bilibili.com",
    })
    throttle.wait()
    with b.opener.open(req, timeout=15) as r:
        return __import__("json").loads(r.read().decode("utf-8"))


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


def fetch_image(url):
    """仅允许 hdslb.com 图片，返回二进制。"""
    from urllib.parse import urlparse
    host = urlparse(url).hostname or ""
    if not (host == "hdslb.com" or host.endswith(".hdslb.com")):
        return None
    b = _bili()
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={
            "User-Agent": b.opener.addheaders[0][1] if b.opener.addheaders else "",
            "Referer": "https://www.bilibili.com/",
        })
        with urllib.request.urlopen(req, timeout=12) as r:
            return r.read()
    except Exception:
        return None
