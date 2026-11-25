# -*- coding: utf-8 -*-
"""单主题抓取引擎：搜索召回 -> 详情 -> 建图 -> 并入 store。

状态按主题隔离在 data/state/<topic>/，可断点续跑。
"""
import json
import gzip
import os
import random
import threading
import time
import calendar
import collections
import re
import sys

from bili import Bili, RiskError, strip_tags
from signals import Matcher
import store

BASE = os.path.dirname(os.path.abspath(__file__))
SPACE_PAGES_MAX = 5          # 每个创作者名字最多翻5页(150条)，防超大UP拖垮整轮
_PROBE_OK = [0.0]            # 风控探测通过时间，10 分钟内各阶段复用

# 业务错误码：接口正常返回、只是这条数据不可访问，不算网络异常
_BUSINESS_CODES = {-404, 62002, 62003, 62004, 62012}
# 网络/风控类：接口调用失败或触发限流，计入连续异常
_RISK_CODES = {-412, -352, -799, -403, 412}


class NetCircuit:
    """连续网络异常熔断器：连续 N 次失败则判定网络不可用，终止本轮抓取。

    - fail() 记一次失败（网络异常 / 风控码 / call 返回 None），成功调 ok() 清零
    - 达到阈值后 tripped=True，should_stop() 据此让各阶段停下来
    - 线程安全（详情/增量阶段是多线程调用）
    """
    def __init__(self, limit, L):
        self.limit = max(1, int(limit))
        self.L = L
        self.streak = 0
        self.tripped = False
        self.lock = threading.Lock()
        self._announced = False

    def ok(self):
        with self.lock:
            if self.streak:
                self.streak = 0

    def fail(self, what, detail=""):
        trip = False
        with self.lock:
            if self.tripped:
                return
            self.streak += 1
            if self.streak >= self.limit:
                self.tripped = True
                trip = True
                self._announced = True
        if trip:
            self.L("连续 %d 次网络异常（%s %s），熔断：停止本轮抓取"
                   % (self.streak, what, detail))
        else:
            self.L("网络异常累计 %d/%d（%s %s）" % (self.streak, self.limit, what, detail))

    def note(self, d, what):
        """按一次接口返回结果记成功/失败。d 为 bili.call() 的返回值。"""
        if d is None:
            self.fail(what, "网络异常/重试耗尽")
            return False
        code = d.get("code")
        if code == 0 or code in _BUSINESS_CODES:
            self.ok()
            return True
        if code in _RISK_CODES or isinstance(code, int) and code < 0:
            self.fail(what, "code=%s" % code)
        else:
            # 其它非零业务码：不算网络异常，但也不是成功
            self.ok()
        return False

    def is_tripped(self):
        return self.tripped


def _net_limit(cfg):
    """从配置读连续异常阈值，默认5。兼容分区级与顶层配置。"""
    for c in (cfg, _TOP_CFG):
        if isinstance(c, dict) and c.get("net_fail_limit") is not None:
            try:
                return max(1, int(c["net_fail_limit"]))
            except (ValueError, TypeError):
                pass
    return 5


_TOP_CFG = {}


def _guard_log(topic, msg):
    """熔断日志写进该主题的 crawl.log（守卫在 job 建立前就要能记录）。"""
    try:
        p = os.path.join(store.STATE, topic, "crawl.log")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        log(p, msg)
    except Exception:
        pass


def _load_top_cfg():
    """读取 config.json 顶层配置（阈值等）。兼容源码/exe 两种目录。"""
    global _TOP_CFG
    bases = [BASE]
    if getattr(sys, "frozen", False):
        bases.insert(0, os.path.dirname(BASE))
    for b in bases:
        p = os.path.join(b, "config.json")
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as f:
                    _TOP_CFG = json.load(f)
            except (ValueError, OSError):
                pass
            break


_load_top_cfg()


def log(path, msg):
    line = time.strftime("[%H:%M:%S] ") + msg
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        pass                    # 控制台非UTF-8时特殊昵称可能打印失败，不影响写文件
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")


class TopicState:
    def __init__(self, topic):
        self.dir = os.path.join(store.STATE, topic)
        os.makedirs(self.dir, exist_ok=True)
        self.logfile = os.path.join(self.dir, "crawl.log")

    def load(self, name, default):
        p = os.path.join(self.dir, name + ".json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        # 归档后的断点：优先读明文，没有明文再读 .gz。
        # 这样从旧版直接拷贝明文 state/ 过来也能无缝继续抓取。
        gz = p + ".gz"
        if os.path.exists(gz):
            with gzip.open(gz, "rt", encoding="utf-8") as f:
                return json.load(f)
        return default

    def save(self, name, obj):
        p = os.path.join(self.dir, name + ".json")
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, p)


def year_range(y):
    return (calendar.timegm((y, 1, 1, 0, 0, 0)) - 8 * 3600,
            calendar.timegm((y + 1, 1, 1, 0, 0, 0)) - 8 * 3600)


def clean_title(s):
    return (s or "").replace('<em class="keyword">', "").replace("</em>", "")


def probe(bili, L, guard=None, should_stop=None):
    if time.time() - _PROBE_OK[0] < 600:
        L("风控探测缓存命中（10 分钟内已通过）")
        return
    while True:
        if guard and guard.is_tripped():
            return
        if should_stop and should_stop():
            return
        wait = 60
        try:
            d = bili.get("https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7")
            if guard:
                guard.note(d, "风控探测")
            if d.get("code") in (0, -404, 62002, 62004):
                _PROBE_OK[0] = time.time()
                L("风控探测通过")
                return
            L("风控探测 code=%s" % d.get("code"))
        except RiskError as e:
            if guard:
                guard.fail("风控探测", "HTTP%s" % e.status)
            wait = 90
            L("IP 风控冷却 HTTP%d" % e.status)
        except Exception as e:
            if guard:
                guard.fail("风控探测", repr(e))
            L("探测异常 %r" % e)
        # 冷却期间每 2 秒检查一次停止标记，点「停止」最多等 2 秒即可退出
        until = time.time() + wait
        while time.time() < until:
            if should_stop and should_stop():
                return
            time.sleep(2)


def _end_count(done):
    return sum(1 for x in done if str(x).endswith("|END"))


def phase_search(cfg, st, L, should_stop, progress=None, guard=None):
    kws = cfg["keywords"]
    y0, y1 = cfg.get("years", [2020, 2026])
    videos = st.load("videos", {})
    done = set(st.load("search_done", []))
    tasks = []
    for kw in kws:
        for y in range(y0, y1 + 1):
            tasks.append((kw, str(y), "totalrank"))
        tasks.append((kw, "all", "pubdate"))
    L("搜索任务 %d 组，已完成 %d 页，已有视频 %d" % (len(tasks), len(done), len(videos)))
    if progress:
        progress(_end_count(done), len(tasks), "搜索")
    bili = Bili(L)
    req = 0
    for kw, sl, order in tasks:
        if should_stop():
            break
        if "%s|%s|%s|END" % (kw, sl, order) in done:
            continue
        page = 1
        while page <= 50 and not should_stop():
            tag = "%s|%s|%s|%d" % (kw, sl, order, page)
            if tag in done:
                page += 1
                continue
            params = {"search_type": "video", "keyword": kw, "page": page,
                      "page_size": 30, "order": order}
            if sl != "all":
                beg, end = year_range(int(sl))
                params["pubtime_begin_s"], params["pubtime_end_s"] = beg, end
            d = bili.call(lambda: bili.signed_get("search/type", params),
                          "搜索 %s %s p%d" % (kw, sl, page))
            req += 1
            if guard:
                guard.note(d, "搜索")
            if d is None or d.get("code") != 0:
                done.add(tag)
                st.save("search_done", sorted(done))
                break
            res = (d["data"] or {}).get("result") or []
            nump = d["data"].get("numPages") or 0
            for v in res:
                bv = v.get("bvid")
                if bv and bv not in videos:
                    videos[bv] = {
                        "mid": str(v.get("mid")), "author": v.get("author") or "",
                        "title": clean_title(v.get("title")),
                        "desc": strip_tags(v.get("description")),
                        "pubdate": v.get("pubdate") or 0, "tag": v.get("tag") or "",
                        "kw": kw,
                    }
            done.add(tag)
            if req % 10 == 0:
                st.save("videos", videos); st.save("search_done", sorted(done))
                L("搜索 请求%d 视频%d | %s %s p%d/%d" % (req, len(videos), kw, sl, page, nump))
            if not res or page >= nump:
                done.add("%s|%s|%s|END" % (kw, sl, order))
                st.save("search_done", sorted(done))
                if progress:
                    progress(_end_count(done), len(tasks), "搜索")
                break
            page += 1
            time.sleep(random.uniform(1.1, 1.8))
        time.sleep(random.uniform(0.4, 0.9))
    st.save("videos", videos); st.save("search_done", sorted(done))
    L("搜索完成：视频 %d 请求 %d" % (len(videos), req))
    return len(videos)


def phase_space(cfg, st, L, should_stop, progress=None, guard=None):
    """按创作者名字反查投稿（search/type, order=pubdate），补回主题关键词1000条上限漏掉的投稿。

    思路与原项目 phase_space 一致：
      · 从已命中视频(含 staff)收集 mid -> 名字
      · 以名字为关键词逐页搜，只留 mid 属于目标集合、且主题命中的视频
      · 结果存 space_videos.json，按名字记 space_done.json 断点，可续跑
      · 失败的名字不记 done，下轮重试
    最后把 space_videos 里未收录的视频并入 videos（kw 标为「名字补抓」），供详情/建图阶段使用。
    """
    videos = st.load("videos", {})
    details = st.load("details", {})
    m = Matcher(cfg["signals"])

    # 1) 收集已命中视频的作者 mid 和名字（含联合投稿 staff）
    #    名字直接取 videos.author / details.staff.name（本引擎没有 creators 状态）
    hit = {bv for bv, v in videos.items() if m.hit(v.get("title", ""), v.get("desc", ""), v.get("tag", ""))}
    name2mids = {}
    for bv in hit:
        v = videos[bv]
        if v.get("mid") and str(v["mid"]) != "0" and v.get("author"):
            name2mids.setdefault(v["author"], set()).add(str(v["mid"]))
        for s in (details.get(bv) or {}).get("staff", []):
            if s.get("mid") and str(s["mid"]) != "0" and s.get("name"):
                name2mids.setdefault(s["name"], set()).add(str(s["mid"]))
    mids = set().union(*name2mids.values()) if name2mids else set()

    space_videos = st.load("space_videos", {})
    done = set(st.load("space_done", []))
    todo_all = [nm for nm in sorted(name2mids) if nm not in done]
    names_max = max(1, int(cfg.get("space_names_max", 300)))
    todo = todo_all[:names_max]
    if len(todo_all) > len(todo):
        L("名字补抓本轮限制 %d / %d 个名字（space_names_max=%d），其余下轮继续"
          % (len(todo), len(todo_all), names_max))
    L("名字补抓：作者 %d（名字 %d），已完成 %d，本轮 %d，已有候选 %d"
      % (len(mids), len(name2mids), len(done), len(todo), len(space_videos)))
    if progress:
        progress(0, len(todo), "名字补抓")
    if not todo:
        return _merge_space_videos(videos, space_videos, st, L)

    lock = threading.Lock()
    pause_until = [0.0]
    delay_floor = [1.8]
    tls = threading.local()
    counter = [0]
    added = [0]
    failed = []

    def brake(code):
        with lock:
            pause_until[0] = max(pause_until[0], time.time() + 240)
            delay_floor[0] = min(8.0, delay_floor[0] * 2.0)
            L("风控刹车 code=%s: 全局暂停240s, delay_floor=%.1fs" % (code, delay_floor[0]))

    # 探针：确认搜索接口可用再开跑
    probe = Bili(L)
    while True:
        if should_stop():
            raise KeyboardInterrupt()
        wait = 90
        try:
            d = probe.call(lambda: probe.signed_get("search/type", {
                "search_type": "video", "keyword": "我的世界", "page": 1,
                "page_size": 30, "order": "pubdate"}), "搜索探测", on_risk=brake)
            if guard:
                guard.note(d, "名字补抓探测")
            if d and d.get("code") == 0:
                L("搜索接口探测通过，开始名字补抓")
                break
            L("搜索端口 code=%s, %ds后重探" % ((d or {}).get("code"), wait))
        except RiskError as e:
            if guard:
                guard.fail("名字补抓探测", "HTTP%s" % e.status)
            L("搜索接口冷却(HTTP%d), 120s后重探" % e.status)
            wait = 120
        except Exception as e:
            if guard:
                guard.fail("名字补抓探测", repr(e))
            L("探测异常 %r, %ds后重试" % (e, wait))
        time.sleep(wait)

    def worker(name):
        while time.time() < pause_until[0]:
            if should_stop():
                return
            time.sleep(2)
        if not hasattr(tls, "bili"):
            tls.bili = Bili(L)
        bili = tls.bili
        want = name2mids[name]
        pn, max_pn = 1, 1
        ok = True
        while pn <= min(SPACE_PAGES_MAX, max_pn) and not should_stop():
            params = {"search_type": "video", "keyword": name, "page": pn,
                      "page_size": 30, "order": "pubdate"}
            d = bili.call(lambda: bili.signed_get("search/type", params),
                          "名字补抓 " + name, tries=3, on_risk=brake)
            if guard:
                guard.note(d, "名字补抓")
            if d is None or d.get("code") != 0:
                ok = False
                L("名字补抓失败 %s code=%s (下轮重试)" % (name, (d or {}).get("code", "net")))
                break
            data = d.get("data") or {}
            res = data.get("result") or []
            max_pn = data.get("numPages") or 1
            with lock:
                for v in res:
                    mid = str(v.get("mid"))
                    if mid not in want:
                        continue
                    bv = v.get("bvid")
                    if not bv or bv in space_videos:
                        continue
                    title = clean_title(v.get("title"))
                    desc = strip_tags(v.get("description"))
                    tag = v.get("tag") or ""
                    if not m.hit(title, desc, tag):
                        continue
                    space_videos[bv] = {"mid": mid, "author": v.get("author") or name,
                                        "title": title, "desc": desc,
                                        "pubdate": v.get("pubdate") or 0, "tag": tag}
                    added[0] += 1
            if not res or pn >= max_pn:
                break
            pn += 1
            time.sleep(random.uniform(delay_floor[0], delay_floor[0] + 0.4))
        with lock:
            counter[0] += 1
            if ok:
                done.add(name)
            else:
                failed.append(name)
            if progress and counter[0] % 10 == 0:
                progress(counter[0], len(todo), "名字补抓")
            if counter[0] % 100 == 0:
                st.save("space_videos", space_videos); st.save("space_done", sorted(done))
                L("名字补抓 %d/%d (%.1f%%), 新增候选 %d, delay_floor=%.1fs"
                  % (counter[0], len(todo), 100.0 * counter[0] / max(1, len(todo)),
                     added[0], delay_floor[0]))
                if delay_floor[0] > 1.8 and time.time() > pause_until[0]:
                    delay_floor[0] = max(1.8, delay_floor[0] * 0.9)
        time.sleep(random.uniform(0.3, 0.7))

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(worker, todo))
    st.save("space_videos", space_videos); st.save("space_done", sorted(done))
    if failed:
        L("本轮失败 %d 个名字，保留待下轮重试: %s" % (len(failed), ", ".join(failed[:8])))
    if progress:
        progress(len(todo), len(todo), "名字补抓")
    return _merge_space_videos(videos, space_videos, st, L)


def _merge_space_videos(videos, space_videos, st, L):
    """把名字补抓到的候选视频并入 videos（供详情/建图阶段），返回累计视频数。"""
    added = 0
    for bv, rec in space_videos.items():
        if bv not in videos:
            videos[bv] = {"mid": rec["mid"], "author": rec.get("author", ""),
                          "title": rec["title"], "desc": rec["desc"],
                          "pubdate": rec.get("pubdate", 0), "tag": rec.get("tag", ""),
                          "kw": "名字补抓"}
            added += 1
    if added:
        st.save("videos", videos)
    L("名字补抓完成：候选 %d，新增并入 %d，视频总数 %d" % (len(space_videos), added, len(videos)))
    return len(videos)


def phase_details(cfg, st, L, should_stop, progress=None, guard=None):
    videos = st.load("videos", {})
    details = st.load("details", {})
    faces = st.load("faces", {})
    for bv in [b for b, v in details.items() if isinstance(v, dict) and "err" in v]:
        del details[bv]
    m = Matcher(cfg["signals"])
    hit = {bv for bv, v in videos.items() if m.hit(v["title"], v["desc"], v.get("tag", ""))}
    ok_authors = {videos[bv]["mid"] for bv in hit}
    COLLAB = re.compile(r"[@＠]|联动|合作|feat|联合|guest|嘉宾", re.I)
    todo = [bv for bv, v in videos.items()
            if bv not in details and (bv in hit or
                   (v["mid"] in ok_authors and COLLAB.search(v["title"])))]
    L("详情阶段：命中 %d 待抓 %d" % (len(hit), len(todo)))
    if progress:
        progress(0, len(todo), "详情")
    if not todo:
        return len(hit)

    lock = threading.Lock()
    pause = [0.0]
    floor = [cfg.get("detail_delay", 0.7)]
    tls = threading.local()
    counter = [0]

    def brake(code):
        with lock:
            pause[0] = max(pause[0], time.time() + 180)
            floor[0] = min(8.0, floor[0] * 2.0)
            L("风控刹车 %s 暂停180s" % code)

    probe(Bili(L), L, guard, should_stop)

    def worker(bv):
        if should_stop():
            return
        while time.time() < pause[0]:
            if should_stop():
                return
            time.sleep(2)
        if not hasattr(tls, "bili"):
            tls.bili = Bili(L)
        d = tls.bili.call(lambda: tls.bili.get(
            "https://api.bilibili.com/x/web-interface/view?bvid=" + bv), "详情 " + bv, on_risk=brake)
        if guard:
            guard.note(d, "详情")
        if d is None or d.get("code") != 0:
            rec = {"err": (d or {}).get("code", "net")}
        else:
            dd = d["data"]
            ow = dd.get("owner") or {}
            rec = {
                "owner": {"mid": str(ow.get("mid")), "name": ow.get("name") or "", "face": ow.get("face") or ""},
                "staff": [{"mid": str(s.get("mid")), "name": s.get("name") or "", "face": s.get("face") or ""}
                          for s in dd.get("staff", [])],
                "title": dd.get("title") or "", "desc": dd.get("desc") or "",
                "pubdate": dd.get("pubdate") or 0,
            }
        with lock:
            details[bv] = rec
            if "err" not in rec:
                for p in [rec["owner"]] + rec["staff"]:
                    if p["mid"] and p["mid"] != "0":
                        faces[p["mid"]] = {"name": p["name"], "face": p["face"]}
            counter[0] += 1
            if counter[0] % 20 == 0 and progress:
                progress(counter[0], len(todo), "详情")
            if counter[0] % 200 == 0:
                st.save("details", details); st.save("faces", faces)
                L("详情 %d/%d" % (counter[0], len(todo)))
        time.sleep(random.uniform(floor[0], floor[0] + 0.3))

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=cfg.get("workers", 8)) as ex:
        list(ex.map(worker, todo))
    st.save("details", details); st.save("faces", faces)
    L("详情完成 成功 %d" % sum(1 for v in details.values() if "err" not in v))
    return len(hit)


def build(cfg, st, L):
    videos = st.load("videos", {})
    details = st.load("details", {})
    faces = st.load("faces", {})
    m = Matcher(cfg["signals"])
    hit = {bv for bv, v in videos.items()
           if m.hit((details.get(bv) or {}).get("title") or v["title"],
                    (details.get(bv) or {}).get("desc") or v["desc"], v.get("tag", ""))}
    nodes = {}
    for bv in hit:
        v = videos[bv]
        mid = v["mid"]
        if not mid or mid == "0":
            continue
        n = nodes.setdefault(mid, {"id": mid, "name": v["author"], "face": "", "v": 0, "sources": []})
        n["v"] += 1
        if v.get("kw") and v["kw"] not in n["sources"]:
            n["sources"].append(v["kw"])
        d = details.get(bv) or {}
        for s in d.get("staff", []):
            sm = s.get("mid")
            if sm and sm != "0":
                sn = nodes.setdefault(sm, {"id": sm, "name": s.get("name", ""),
                                           "face": s.get("face", ""), "v": 0, "sources": []})
                if s.get("name") and not sn["name"]:
                    sn["name"] = s["name"]
                if s.get("face") and not sn["face"]:
                    sn["face"] = s["face"]
    for mid, n in nodes.items():
        f = faces.get(mid) or {}
        if f.get("name") and not n["name"]:
            n["name"] = f["name"]
        if f.get("face") and not n["face"]:
            n["face"] = f["face"]

    names = {}
    for mid, n in sorted(nodes.items(), key=lambda kv: -kv[1]["v"]):
        if n["name"] and n["name"] not in names:
            names[n["name"]] = mid
    edges = {}
    def add_edge(a, b, j):
        if not a or not b or a == b or a not in nodes or b not in nodes:
            return
        k = (a, b) if a < b else (b, a)
        e = edges.setdefault(k, {"source": k[0], "target": k[1], "j": 0, "n": 0})
        e["n"] += 1
        if j:
            e["j"] = 1
    for bv in hit:
        d = details.get(bv) or {}
        if "err" in d:
            continue
        ow = d.get("owner", {}).get("mid") or videos[bv]["mid"]
        staff = [s["mid"] for s in d.get("staff", []) if s.get("mid") and s["mid"] != "0"]
        if staff:
            party = [ow] + staff
            for i in range(len(party)):
                for j in range(i + 1, len(party)):
                    add_edge(party[i], party[j], True)
        for nm in m.match_at((d.get("title") or "") + "\n" + (d.get("desc") or ""), names):
            add_edge(ow, names[nm], False)
    node_list = list(nodes.values())
    edge_list = list(edges.values())
    L("建图：节点 %d 边 %d" % (len(node_list), len(edge_list)))
    return node_list, edge_list, len(hit)


def phase_incremental(topic, cfg, st, L, should_stop, progress, guard=None):
    """增量查询：段1 关键词增量发现（每次都跑） + 段2 老UP复查（90天闸门）。

    两段共用 D+E 策略：
      D 锚点起点：pubtime_begin_s = 锚点+1, order=pubdate，服务端只回锚点之后的新视频
      E 追平即停：连续 catchup_pages 页没有「属于该对象且比锚点更新」的新视频就提前停
      页数上限：每个对象最多翻 pages_max 页兜底
    """
    videos = st.load("videos", {})
    known = set(videos)
    m = Matcher(cfg["signals"])
    interval_days = max(1, int(cfg.get("incremental_interval_days", 90)))
    pages_max = max(1, int(cfg.get("incremental_pages_max", 5)))
    catchup_pages = max(1, int(cfg.get("incremental_catchup_pages", 2)))
    recheck_max = max(1, int(cfg.get("incremental_recheck_max", 200)))

    lock = threading.Lock()
    pause_until = [0.0]
    delay_floor = [1.4]

    def brake(code):
        with lock:
            pause_until[0] = max(pause_until[0], time.time() + 240)
            delay_floor[0] = min(8.0, delay_floor[0] * 2.0)
            L("增量查询风控刹车 code=%s: 全局暂停240s, delay_floor=%.1fs" % (code, delay_floor[0]))

    def wait_slot():
        while time.time() < pause_until[0]:
            if should_stop():
                return False
            time.sleep(2)
        return not should_stop()

    def search_new(bili, keyword, anchor, label, source, kw_field, mid_allow=None):
        """D+E 搜一个对象，返回 (新视频dict, 是否成功)。失败不记复查状态。"""
        found = {}
        miss = 0
        page = 1
        num_pages = 1
        while page <= pages_max and not should_stop():
            if not wait_slot():
                return found, False
            params = {"search_type": "video", "keyword": keyword, "page": page,
                      "page_size": 30, "order": "pubdate",
                      "pubtime_begin_s": int(anchor) + 1}
            d = bili.call(lambda: bili.signed_get("search/type", params),
                          "%s %s p%d" % (label, keyword, page), on_risk=brake)
            if guard:
                guard.note(d, "增量" + label)
            if d is None or d.get("code") != 0:
                L("增量查询失败 %s %s p%d code=%s（不记复查状态）"
                  % (label, keyword, page, (d or {}).get("code", "net")))
                return found, False
            data = d.get("data") or {}
            res = data.get("result") or []
            num_pages = data.get("numPages") or 1
            got = 0
            for v in res:
                bv = v.get("bvid")
                pub = int(v.get("pubdate") or 0)
                mid = str(v.get("mid") or "")
                if not bv or pub <= anchor or bv in known or bv in found:
                    continue
                if mid_allow is not None and mid not in mid_allow:
                    continue
                title = clean_title(v.get("title"))
                desc = strip_tags(v.get("description"))
                tag = v.get("tag") or ""
                if not m.hit(title, desc, tag):
                    continue
                found[bv] = {"mid": mid, "author": v.get("author") or "",
                             "title": title, "desc": desc, "pubdate": pub, "tag": tag,
                             "kw": kw_field, "source": source}
                got += 1
            if got:
                miss = 0
            else:
                miss += 1
                if miss >= catchup_pages:
                    L("增量查询 %s %s 追平：连续 %d 页无新视频（p%d）"
                      % (label, keyword, catchup_pages, page))
                    break
            if not res or page >= num_pages:
                break
            page += 1
            time.sleep(random.uniform(delay_floor[0], delay_floor[0] + 0.4))
        return found, True

    L("增量参数：锚点+1 / 追平%d页 / 上限%d页 / 复查间隔%d天"
      % (catchup_pages, pages_max, interval_days))
    bili = Bili(L)
    probe = bili.call(lambda: bili.signed_get("search/type", {
        "search_type": "video", "keyword": "我的世界", "page": 1,
        "page_size": 30, "order": "pubdate"}), "增量查询搜索探测", on_risk=brake)
    if guard:
        guard.note(probe, "增量探测")
    if guard and guard.is_tripped():
        raise KeyboardInterrupt()
    if not probe or probe.get("code") != 0:
        raise RuntimeError("搜索接口不可用 code=%s" % ((probe or {}).get("code", "net"),))
    L("增量查询搜索接口探测通过")

    # 预先读出已入图创作者（段1去重新UP、段2复查名单都要用）
    _graph = store.read(topic)
    graph_mids_pre = set()
    graph_names_pre = {}
    for nd in _graph.get("nodes", []):
        mid = str(nd.get("id") or "")
        if not mid or mid == "0":
            continue
        graph_mids_pre.add(mid)
        if nd.get("name"):
            graph_names_pre[mid] = nd["name"]

    # 段1：关键词增量发现（每次都跑，不受三个月闸门限制）
    kws = cfg["keywords"]
    progress(0, len(kws) or 1, "增量发现")
    discovered = 0
    discovered_mids = {}                  # 段1发现的全新UP：mid -> 名字，供段2复查
    for i, kw in enumerate(kws, 1):
        if should_stop():
            raise KeyboardInterrupt()
        anchor = max([int(v.get("pubdate") or 0) for v in videos.values()
                      if v.get("kw") == kw] or [0])
        found, _ = search_new(bili, kw, anchor, "关键词发现", "增量发现", kw)
        if found:
            videos.update(found)
            known.update(found)
            discovered += len(found)
            for nv in found.values():
                mnm = str(nv.get("mid") or "")
                if mnm and mnm != "0" and nv.get("author") and mnm not in graph_mids_pre:
                    discovered_mids.setdefault(mnm, nv["author"])
            st.save("videos", videos)
        L("关键词发现 %s：锚点 %s，新增 %d"
          % (kw, time.strftime("%Y-%m-%d", time.localtime(anchor)) if anchor else "无", len(found)))
        progress(i, len(kws) or 1, "增量发现")

    # 段2：老UP复查（段1刚发现的新UP从未查过，自动进入待查名单）
    # 名单只取「已入图」的创作者（成品图谱 data/<topic>.json 的 nodes），
    # 不能用 videos.json 全库——那里面大量未命中主题的视频会混入无关UP。
    # 名单 = 已入图创作者 ∪ 段1发现的全新UP
    graph_mids = set(graph_mids_pre)
    graph_names = dict(graph_names_pre)
    for mid, nm in discovered_mids.items():
        graph_mids.add(mid)
        graph_names.setdefault(mid, nm)

    # 锚点按 mid 从 videos 里取最大 pubdate；名字优先用图谱里的
    by_mid = {}
    for v in videos.values():
        mid = str(v.get("mid") or "")
        if mid not in graph_mids:
            continue                      # 只统计已入图/本轮新发现的创作者
        e = by_mid.setdefault(mid, {"anchor": 0})
        pub = int(v.get("pubdate") or 0)
        if pub > e["anchor"]:
            e["anchor"] = pub
    for mid in graph_mids:
        e = by_mid.setdefault(mid, {"anchor": 0})
        e["name"] = graph_names.get(mid) or ""
    by_mid = {mid: e for mid, e in by_mid.items() if e["name"]}   # 没名字没法按名字搜

    checked = st.load("incremental_checked", {})
    # 清理历史误记：只保留仍在已入图名单里的 mid（旧版把无关UP也记了进去）
    checked = {mid: ts for mid, ts in checked.items() if mid in by_mid}
    now = time.time()
    # 复查闸门：两个条件必须同时满足——
    #   ① 距该UP「最近一个新视频」超过 N 天（只查长期没发片的沉寂UP）
    #   ② 距上次复查也超过 N 天（避免短期内重复查同一个UP）
    todo = [mid for mid, e in by_mid.items()
            if now - e["anchor"] > interval_days * 86400
            and now - int(checked.get(mid) or 0) > interval_days * 86400]
    L("老UP复查：已入图 %d 位，待查 %d 位（最近视频超 %d 天 且 距上次复查超 %d 天）"
      % (len(by_mid), len(todo), interval_days, interval_days))
    if len(todo) > recheck_max:
        total_todo = len(todo)
        # 未复查过的优先；其余按 mid 稳定排序，保证每轮推进而不是总查同一批
        todo = sorted(todo, key=lambda mid: (int(checked.get(mid) or 0), mid))[:recheck_max]
        L("本轮只复查 %d / %d 位（incremental_recheck_max=%d），其余下轮继续"
          % (len(todo), total_todo, recheck_max))
    progress(0, len(todo) or 1, "老UP复查")
    failed = [0]
    rechecked = [0]
    added = [0]
    if todo:
        tls = threading.local()
        counter = [0]
        dirty = [0]

        def worker(mid):
            if should_stop() or not wait_slot():
                return
            if not hasattr(tls, "bili"):
                tls.bili = Bili(L)
            e = by_mid[mid]
            found, ok = search_new(tls.bili, e["name"], e["anchor"],
                                   "老UP复查", "增量复查", "增量复查", mid_allow={mid})
            with lock:
                if found:
                    videos.update(found)
                    known.update(found)
                    dirty[0] += len(found)
                    added[0] += len(found)
                if ok:
                    checked[mid] = int(time.time())
                    rechecked[0] += 1
                else:
                    failed[0] += 1
                counter[0] += 1
                if dirty[0] >= 100 or (counter[0] % 100 == 0 and dirty[0]):
                    st.save("videos", videos)
                    dirty[0] = 0
                if counter[0] % 20 == 0:
                    st.save("incremental_checked", checked)
                if progress and counter[0] % 10 == 0:
                    progress(counter[0], len(todo), "老UP复查")
                if counter[0] % 100 == 0:
                    L("老UP复查 %d/%d，新增 %d 视频，失败 %d"
                      % (counter[0], len(todo), added[0], failed[0]))
            time.sleep(random.uniform(0.3, 0.7))

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as ex:
            list(ex.map(worker, todo))

    st.save("videos", videos)
    st.save("incremental_checked", checked)
    progress(len(todo), len(todo) or 1, "老UP复查")
    L("增量查询完成：关键词发现 %d 视频，复查 %d 位（新增 %d 视频），失败 %d 位下轮重试"
      % (discovered, rechecked[0], added[0], failed[0]))
    if should_stop():
        raise KeyboardInterrupt()
    return {"discovered": discovered, "rechecked": rechecked[0],
            "added": discovered + added[0], "videos": len(videos)}


def _verify_layout(outdir, graph_path):
    """校验布局 count/hash 是否与当前图谱一致，一致返回 True。"""
    try:
        import layout_orig as _lo
        g = json.load(open(graph_path, encoding="utf-8"))
        ids = [str(n["id"]) for n in g["nodes"]]
        h = _lo.fnv(ids)
        p = os.path.join(outdir, "all_flat.json")
        d = json.load(open(p, encoding="utf-8"))
        return int(d.get("count", -1)) == len(ids) and str(d.get("hash")) == h
    except Exception:
        return False


def _rebuild_layout(topic, L):
    """重算该主题的预计算布局；失败重试并校验 hash，确保前端不会因布局过期而白屏。"""
    import subprocess
    outdir = os.path.join(store.DATA, "layouts_" + topic)
    gpath = store.FILES[topic]
    attempts = []

    def try_embedded():
        import make_layouts
        make_layouts.make(gpath, outdir)

    def try_external():
        # 找一个可用的外部 Python 跑外置脚本（绕过 exe 内嵌模块解压问题）
        cands = ["python", "python3", "py"]
        exe = None
        for c in cands:
            try:
                r = subprocess.run([c, "-c", "import sys;print(sys.executable)"],
                                   capture_output=True, text=True, timeout=8)
                if r.returncode == 0 and r.stdout.strip():
                    exe = r.stdout.strip().splitlines()[0]
                    break
            except Exception:
                continue
        if not exe:
            raise RuntimeError("找不到可用的外部 Python")
        script = os.path.join(BASE, "make_layouts.py")
        if not os.path.isfile(script):
            raise RuntimeError("外置布局脚本不存在: %s" % script)
        r = subprocess.run([exe, script, gpath, outdir], cwd=BASE,
                           capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            raise RuntimeError("外部布局重算失败: %s" % (r.stderr or "")[:200])

    # 依次尝试：内嵌模块（重试2次，规避 PyInstaller 一次性解压竞争）→ 外部 Python
    for label, fn in (("内嵌", try_embedded), ("内嵌重试", try_embedded),
                      ("外部Python", try_external)):
        try:
            fn()
            if _verify_layout(outdir, gpath):
                L("布局已重算并校验通过(%s): %s" % (label, outdir))
                return True
            attempts.append("%s:hash不匹配" % label)
        except Exception as le:
            attempts.append("%s:%r" % (label, le))
            if label == "内嵌":
                # zlib -3 多为 PyInstaller 模块首次解压竞争，短暂等待后重试
                import time as _t
                _t.sleep(1)
    L("布局重算失败(数据已保存，前端可能显示布局失败): %s" % " | ".join(attempts))
    return False


def _downstream(topic, cfg, st, L, job, progress, should_stop, scanned, run_meta=None):
    """详情 -> 建图 -> 合并落盘 -> 重算布局；完整抓取与增量查询共用。"""
    job["phase"] = "详情"
    phase_details(cfg, st, L, should_stop, progress)
    if should_stop():
        raise KeyboardInterrupt()
    job["phase"] = "合并数据"
    progress(0, 1, "合并数据")
    nodes, links, hit = build(cfg, st, L)
    meta = {"scanned": scanned, "hit": hit, "status": "done", "keywords": cfg["keywords"]}
    if run_meta:
        meta.update(run_meta)
    result = store.merge(topic, nodes, links, meta)
    # 只有节点/边真的变了才重算布局；空转的增量不该花几分钟重排同一张图。
    # 节点或边没变时 hash 不变，原有布局仍然有效。
    if result.get("new_nodes") or result.get("new_links"):
        job["phase"] = "重算布局"
        progress(0, 1, "重算布局")
        _rebuild_layout(topic, L)
        progress(1, 1, "完成")
    else:
        job["phase"] = "无新增，跳过重算"
        L("本轮无新增节点/边，跳过布局重算（hash 未变）")
        progress(1, 1, "完成")
    job["result"] = result
    L("完成：%s" % result)
    return result


JOBS = {}
LOCK = threading.Lock()


def _run_job(topic, title, runner):
    """后台任务公共壳：状态/进度/停止/异常收尾。runner 决定具体流水线。"""
    with LOCK:
        if JOBS.get(topic, {}).get("running"):
            return False
        JOBS[topic] = {"running": True, "phase": "准备", "start": time.time(), "stop": False,
                       "progress": {"done": 0, "total": 0, "label": "准备", "eta": None, "rate": 0.0}}
    job = JOBS[topic]
    prog = job["progress"]
    # 连续网络异常熔断：各阶段通过 job["_guard"] 记账，should_stop 统一感知
    guard = NetCircuit(_net_limit(None), lambda m: _guard_log(topic, m))
    job["_guard"] = guard
    _pg = {"t0": time.time(), "d0": 0}          # 本阶段起点，用于算速率/ETA

    def progress(done, total, label):
        now = time.time()
        if label != prog["label"]:
            _pg["t0"], _pg["d0"] = now, done
        prog["label"] = label
        prog["done"] = done
        prog["total"] = total
        elapsed = now - _pg["t0"]
        delta = done - _pg["d0"]
        if delta > 0 and elapsed > 0:
            rate = delta / elapsed                       # 单位/秒
            prog["rate"] = round(rate, 3)
            prog["eta"] = int((total - done) / rate) if rate > 0 and total > done else 0
        else:
            prog["eta"] = None

    def should_stop():
        return job["stop"] or guard.is_tripped()

    def work():
        st = TopicState(topic)
        L = lambda msg: log(st.logfile, msg)
        try:
            L("=== %s topic=%s ===" % (title, topic))
            runner(job, st, L, should_stop, progress)
        except KeyboardInterrupt:
            if guard.is_tripped():
                job["result"] = {"status": "error", "error": "连续网络异常熔断，已停止"}
                L("因连续网络异常熔断，本轮停止（已完成部分保留）")
            else:
                job["result"] = {"status": "stopped"}
                L("用户停止")
        except Exception as e:
            job["result"] = {"status": "error", "error": repr(e)}
            L("异常 %r" % e)
        finally:
            job["running"] = False
            job["phase"] = "空闲"
            job["end"] = time.time()
            prog["eta"] = None

    threading.Thread(target=work, daemon=True).start()
    return True


def _stamp_after_full_crawl(topic, st, L):
    """完整抓取成功后，把所有已入图创作者记为「今日已复查」。

    完整抓取是全量扫描（搜索召回 + 名字补抓 + 详情 + 建图），等价于对每个入图 UP
    做了一次完整复查。写入 incremental_checked 后，紧接着点「增量查询」不会再把
    刚抓过的 UP 当成「从未查过 / 最近视频超 90 天」重复查询。
    只在抓取正常完成时调用；熔断/用户停止时不标记（数据不完整）。
    """
    try:
        graph = store.read(topic)
        mids = [str(nd.get("id") or "") for nd in graph.get("nodes", [])
                if str(nd.get("id") or "") and str(nd.get("id")) != "0"]
        if not mids:
            return 0
        checked = st.load("incremental_checked", {})
        now = int(time.time())
        for mid in mids:
            checked[mid] = now
        st.save("incremental_checked", checked)
        L("完整抓取后标记复查时间：%d 位入图创作者记为今日已查（%s）"
          % (len(mids), time.strftime("%Y-%m-%d %H:%M")))
        return len(mids)
    except Exception as e:
        L("完整抓取后标记复查时间失败(不影响数据): %r" % e)
        return 0


def run_topic(topic, cfg):
    """完整抓取：搜索 -> 名字补抓 -> 详情 -> 建图 -> 合并 -> 重算布局。"""
    def runner(job, st, L, should_stop, progress):
        guard = job["_guard"]
        job["phase"] = "搜索"
        scanned = phase_search(cfg, st, L, should_stop, progress, guard)
        if should_stop():
            raise KeyboardInterrupt()
        job["phase"] = "名字补抓"
        scanned = phase_space(cfg, st, L, should_stop, progress, guard)
        if should_stop():
            raise KeyboardInterrupt()
        _downstream(topic, cfg, st, L, job, progress, should_stop, scanned)
        # 正常完成后，把本次全量扫描过的入图创作者记为已复查，避免增量查询重复劳动
        if not should_stop():
            _stamp_after_full_crawl(topic, st, L)
    return _run_job(topic, "开始抓取", runner)


def run_incremental(topic, cfg):
    """增量查询：段1发现新人 + 段2复查老人，跳过历史搜索/名字补抓直接走下游。"""
    tcfg = cfg[topic] if topic in cfg and isinstance(cfg[topic], dict) else cfg

    def runner(job, st, L, should_stop, progress):
        guard = job["_guard"]
        job["phase"] = "增量查询"
        info = phase_incremental(topic, tcfg, st, L, should_stop, progress, guard)
        if should_stop():
            raise KeyboardInterrupt()
        _downstream(topic, tcfg, st, L, job, progress, should_stop, info["videos"], {
            "keywords": ["增量查询"], "mode": "incremental",
            "discovered": info["discovered"], "rechecked": info["rechecked"],
        })
    return _run_job(topic, "增量查询", runner)


def stop_topic(topic):
    with LOCK:
        job = JOBS.get(topic)
        if job and job["running"]:
            job["stop"] = True
            return True
    return False


def status():
    out = {}
    for t, j in JOBS.items():
        out[t] = {k: j[k] for k in ("running", "phase", "start", "end", "result", "progress") if k in j}
    return out
