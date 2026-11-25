# -*- coding: utf-8 -*-
"""增量数据层：每个分区一个自包含 JSON，只进不出。

data/ 下三个成品文件，前端切换分区就是切换读取的文件：
  data/bedrock.json   基岩版（原始项目数据迁入 + 后续增量）
  data/java.json      Java版
  data/create.json    机械动力

每个文件结构完全一致：
  {
    "topic": "create", "label": "机械动力", "updated": 时间戳,
    "nodes":    [{id,name,face,v}],
    "links":    [{source,target,j,n}],
    "creators": {mid:{name,face,v,first,last,sources}},
    "history":  [{ts,keywords,scanned,hit,new_creators,new_edges,...}]
  }

规则：
  - 节点/边/作者只增不减；重复抓取只取最大值刷新计数、更新 last，不删除旧数据
  - 每完成一次抓取，只重写对应分区的那一个文件（原子替换，不出半成品）
  - history 只追加；超过 500 条保留最近 500 条
"""
import json
import gzip
import os
import sys
import time

if getattr(sys, "frozen", False):
    # exe 在 bedrock-creators-web/ 根目录；成品 JSON 写入同级 data/
    # 与 graph.json 并列，供 index.html 的数据源下拉框直接读取
    EXE_DIR = os.path.dirname(os.path.abspath(sys.executable))
    BASE = os.path.join(EXE_DIR, "creator-studio")
    DATA = os.path.join(EXE_DIR, "data")
else:
    BASE = os.path.dirname(os.path.abspath(__file__))
    DATA = os.path.join(os.path.dirname(BASE), "data")
# 抓取断点状态放在工具自己的目录，不混进原项目 data/
STATE = os.path.join(BASE, "state")
os.makedirs(STATE, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

TOPICS = {
    "bedrock": "基岩版",
    "java": "Java版",
    "create": "机械动力",
}
FILES = {t: os.path.join(DATA, t + ".json") for t in TOPICS}


def _default(topic):
    return {"topic": topic, "label": TOPICS.get(topic, topic), "updated": 0,
            "nodes": [], "links": [], "creators": {}, "history": [],
            "eraSplit": "2017-09-20"}


def _creators_path(topic):
    return os.path.join(STATE, topic, "creators.json")


def _load(topic):
    p = FILES.get(topic)
    if not p or not os.path.exists(p):
        d = _default(topic)
    else:
        try:
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
        except (ValueError, OSError):
            d = _default(topic)
    had_creators = "creators" in d      # 必须在 setdefault 之前判断，否则空字典会误判成旧数据
    for k, v in _default(topic).items():
        d.setdefault(k, v)
    # 文件里是原项目形态(vpe/vbr)，内部统一用 v/n，避免二次抓取丢计数
    for n in d.get("nodes", []):
        if "v" not in n:
            n["v"] = int(n.get("vbr", 0)) + int(n.get("vpe", 0))
    # creators 只有后端合并需要，前端从不读；存到 state/，让 Web 数据瘦一半。
    # 老版本图谱里还带着 creators 时，先把它搬到 state（图谱里的为准）。
    cp = _creators_path(topic)
    if had_creators:
        os.makedirs(os.path.dirname(cp), exist_ok=True)
        tmp = cp + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d["creators"], f, ensure_ascii=False)
        os.replace(tmp, cp)
    try:
        with open(cp, encoding="utf-8") as f:
            d["creators"] = json.load(f)
    except (ValueError, OSError):
        try:
            with gzip.open(cp + ".gz", "rt", encoding="utf-8") as f:
                d["creators"] = json.load(f)
        except (ValueError, OSError):
            d["creators"] = d.get("creators") or {}
    return d


def to_graph_shape(d):
    """转成原项目 graph.json 的形态：nodes 带 pe/br/vpe/vbr，links 带 pe/br/j。
    管理器的 creators/history 等作为附加字段保留，前端只用 nodes/links，互不影响。"""
    nodes = []
    for n in d.get("nodes", []):
        v = int(n.get("v", 0))
        nodes.append({"id": str(n["id"]), "name": n.get("name") or "",
                      "face": n.get("face", ""),
                      "pe": 0, "br": 1, "vpe": 0, "vbr": v})
    links = []
    for l in d.get("links", []):
        links.append({"source": str(l["source"]), "target": str(l["target"]),
                      "pe": 0, "br": 1, "j": int(l.get("j", 0))})
    out = dict(d)
    out["nodes"] = nodes
    out["links"] = links
    out["eraSplit"] = "2017-09-20"
    out.pop("creators", None)   # 后端元数据留 state/，不发给前端
    return out


def _write(topic, obj):
    p = FILES[topic]
    text = json.dumps(to_graph_shape(obj), ensure_ascii=False, separators=(",", ":"))
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, p)
    # 同步生成 *.bundle.js，供 index.html 在 file:// 双击模式下读取
    # 约定：window.GRAPH_SOURCE = {nodes, links, ...}（与 JSON 内容一致）
    b = os.path.join(DATA, topic + ".bundle.js")
    btmp = b + ".tmp"
    with open(btmp, "w", encoding="utf-8", newline="\n") as f:
        f.write("window.GRAPH_SOURCE=" + text + ";\n")
    os.replace(btmp, b)
    # 后端元数据单独落盘，不进前端数据文件
    cp = _creators_path(topic)
    os.makedirs(os.path.dirname(cp), exist_ok=True)
    ctmp = cp + ".tmp"
    with open(ctmp, "w", encoding="utf-8") as f:
        json.dump(obj.get("creators", {}), f, ensure_ascii=False)
    os.replace(ctmp, cp)
    write_uid_topics()


_TOPIC_FLAG = {"bedrock": "b", "java": "j", "create": "c"}
UID_TOPICS_JSON = os.path.join(DATA, "uid_topics.json")
UID_TOPICS_BUNDLE = os.path.join(DATA, "uid_topics.bundle.js")


def write_uid_topics():
    """生成 UID → 所在分区标记映射（b=基岩 j=Java c=机械动力，可组合如 bj）。
    供星图详情卡显示某人实际收录的所有分区。同时写 json 与 file:// 用的 bundle。"""
    m = {}
    for t in TOPICS:
        flag = _TOPIC_FLAG[t]
        p = FILES[t]
        if not os.path.isfile(p):
            continue
        try:
            d = json.load(open(p, encoding="utf-8"))
        except (ValueError, OSError):
            continue
        for n in d.get("nodes", []):
            uid = str(n.get("id") or "")
            if not uid:
                continue
            m[uid] = m.get(uid, "") + flag if flag not in m.get(uid, "") else m[uid]
    text = json.dumps(m, ensure_ascii=False, separators=(",", ":"))
    for path, prefix, suffix in ((UID_TOPICS_JSON, "", ""), (UID_TOPICS_BUNDLE, "window.UID_TOPICS=", ";\n")):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(prefix + text + suffix)
        os.replace(tmp, path)


def read(topic):
    """前端读取分区完整数据用的接口。"""
    return _load(topic)


def stats_all():
    out = {}
    for t in TOPICS:
        d = _load(t)
        out[t] = {"label": d["label"], "nodes": len(d["nodes"]),
                  "links": len(d["links"]), "creators": len(d["creators"]),
                  "runs": len(d["history"]), "updated": d["updated"]}
    return out


def merge(topic, nodes, links, run_meta):
    """把一次抓取结果并入该分区文件。nodes/links 是本轮增量。"""
    if topic not in TOPICS:
        raise ValueError("unknown topic: %s" % topic)
    now = int(time.time())
    d = _load(topic)
    node_idx = {n["id"]: n for n in d["nodes"]}
    link_idx = {(l["source"], l["target"]): l for l in d["links"]}
    creators = d["creators"]
    new_nodes = new_links = 0

    for n in nodes:
        mid = str(n["id"])
        e = node_idx.get(mid)
        if e:
            e["v"] = max(e.get("v", 0), int(n.get("v", 0)))
            if n.get("face") and not e.get("face"):
                e["face"] = n["face"]
            if n.get("name") and not e.get("name"):
                e["name"] = n["name"]
        else:
            e = {"id": mid, "name": n.get("name") or mid,
                 "face": n.get("face", ""), "v": int(n.get("v", 0))}
            d["nodes"].append(e)
            node_idx[mid] = e
            new_nodes += 1

        c = creators.get(mid, {"name": "", "face": "", "v": 0,
                               "first": now, "last": now, "sources": []})
        if n.get("name"):
            c["name"] = n["name"]
        if n.get("face"):
            c["face"] = n["face"]
        c["v"] = max(c.get("v", 0), int(n.get("v", 0)))
        c["last"] = now
        for s in n.get("sources", []):
            if s not in c["sources"]:
                c["sources"].append(s)
        creators[mid] = c

    for l in links:
        a, b = str(l["source"]), str(l["target"])
        if a == b or a not in node_idx or b not in node_idx:
            continue
        key = (a, b) if a < b else (b, a)
        e = link_idx.get(key)
        if e:
            e["j"] = max(e.get("j", 0), int(l.get("j", 0)))
            e["n"] = max(e.get("n", 0), int(l.get("n", 0)))
        else:
            e = {"source": key[0], "target": key[1], "j": int(l.get("j", 0)),
                 "n": int(l.get("n", 0))}
            d["links"].append(e)
            link_idx[key] = e
            new_links += 1

    rec = dict(run_meta)
    rec.update({"ts": now, "new_creators": new_nodes, "new_edges": new_links,
                "total_nodes": len(d["nodes"]), "total_links": len(d["links"])})
    d["history"].append(rec)
    if len(d["history"]) > 500:
        d["history"][:] = d["history"][-500:]
    d["updated"] = now
    _write(topic, d)
    return {"new_nodes": new_nodes, "new_links": new_links,
            "total_nodes": len(d["nodes"]), "total_links": len(d["links"])}
