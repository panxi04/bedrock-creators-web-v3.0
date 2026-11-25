# -*- coding: utf-8 -*-
"""B 站公开接口客户端 —— 移植自原项目 crawl.py 的 Bili 类并做通用化。

保留原项目验证过的风控对策：CookieJar + finger/spi 取真实 buvid、
WBI 签名、HTTP 412/403 与 code -412/-352/-799 走全局刹车、失败换 buvid。
不登录、不下载视频、只读公开接口。
"""
import hashlib
import http.cookiejar
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request

import throttle

API = "https://api.bilibili.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]


class RiskError(Exception):
    """HTTP 层风控（412/403），必须走全局刹车而不是普通重试。"""
    def __init__(self, status):
        super().__init__("http %d" % status)
        self.status = status


class Bili:
    def __init__(self, log=print, user_agent=UA):
        self.log = log
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj))
        self.opener.addheaders = [
            ("User-Agent", user_agent),
            ("Referer", "https://search.bilibili.com/"),
            ("Accept", "application/json, text/plain, */*"),
            ("Accept-Language", "zh-CN,zh;q=0.9"),
            ("Origin", "https://search.bilibili.com"),
        ]
        self.img = self.sub = None
        self.keys_ts = 0.0
        self.refresh_buvid()

    def cookie(self, name, val):
        ck = http.cookiejar.Cookie(
            0, name, val, None, False, ".bilibili.com", True, False,
            "/", True, False, int(time.time()) + 86400 * 30, False, None, None, {})
        self.cj.set_cookie(ck)

    def refresh_buvid(self):
        try:
            throttle.wait()
            with self.opener.open(API + "/x/frontend/finger/spi", timeout=15) as r:
                d = json.loads(r.read().decode())["data"]
            self.cookie("buvid3", d["b_3"])
            self.cookie("buvid4", d["b_4"])
            self.cookie("b_nut", str(int(time.time())))
        except Exception as e:
            self.log("spi 失败: %r" % e)

    def get(self, url, timeout=15):
        try:
            throttle.wait()
            with self.opener.open(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (412, 403):
                raise RiskError(e.code)
            raise

    def refresh_keys(self, force=False):
        if not force and self.img and time.time() - self.keys_ts < 1800:
            return
        d = self.get(API + "/x/web-interface/nav")
        w = d["data"]["wbi_img"]
        self.img, self.sub = w["img_url"], w["sub_url"]
        self.keys_ts = time.time()

    def wbi_qs(self, params):
        self.refresh_keys()
        raw = (self.img.rsplit("/", 1)[-1].split(".")[0]
               + self.sub.rsplit("/", 1)[-1].split(".")[0])
        key = "".join(raw[i] for i in MIXIN_TAB)[:32]
        p = dict(params, wts=int(time.time()))
        q = "".join(c for c in urllib.parse.urlencode(
            sorted(p.items()), quote_via=urllib.parse.quote) if c not in "!'()*")
        p["w_rid"] = hashlib.md5((q + key).encode()).hexdigest()
        return urllib.parse.urlencode(sorted(p.items()), quote_via=urllib.parse.quote)

    def signed_get(self, path, params, prefix="/x/web-interface/wbi/"):
        return self.get(API + prefix + path + "?" + self.wbi_qs(params))

    def call(self, fn, what, tries=4, on_risk=None):
        """带风控退避的调用：HTTP412/403 或 code -412/-352/-799 时全局刹车。"""
        for i in range(tries):
            try:
                d = fn()
                code = d.get("code")
                if code == 0:
                    return d
                if code in (-412, -352, -799):
                    if on_risk:
                        on_risk(code)
                    wait = 60 * (i + 1) + random.uniform(0, 15)
                    self.log("风控 %s code=%s 休眠 %.0fs (%d/%d)" % (what, code, wait, i + 1, tries))
                    time.sleep(wait)
                    self.refresh_buvid()
                    self.img = None
                    continue
                if code == -403:
                    self.img = None
                    time.sleep(5)
                    continue
                self.log("接口错误 %s code=%s msg=%s" % (what, code, d.get("message")))
                return d
            except RiskError as e:
                if on_risk:
                    on_risk(e.status)
                wait = 45 * (i + 1) + random.uniform(0, 15)
                self.log("风控 %s HTTP%d 休眠 %.0fs (%d/%d)" % (what, e.status, wait, i + 1, tries))
                time.sleep(wait)
                try:
                    self.refresh_buvid()
                except Exception:
                    pass
                self.img = None
            except Exception as e:
                self.log("网络异常 %s: %r，10s 后重试" % (what, e))
                time.sleep(10)
        return None


def strip_tags(s):
    import re
    return re.sub(r"<[^>]*>", "", s or "").strip()
