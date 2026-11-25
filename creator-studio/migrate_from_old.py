# -*- coding: utf-8 -*-
"""把旧版项目里跑完的新数据，迁入本优化副本（默认只预览，不改动）。

用法：
    python migrate_from_old.py --old "D:/软件备份/up云/bedrock-creators-web" --apply

只迁移数据/断点/消息，不覆盖本副本的代码（server.py / engine.py /
make_layouts.py / config.json 等保持优化版）。

安全检查：
  * 布局只在 count/hash 与图谱一致时才复制；不一致就跳过，提示在本副本重算
  * 申请消息按行追加去重，不会覆盖已有收件箱
  * 待渲染名单按 (分区, UID) 合并，不会丢本副本已有的记录
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NEW_ROOT = os.path.dirname(HERE)
TOPICS = ("bedrock", "java", "create")
LAYOUT_NAMES = ("all", "pe", "br")
LAYOUT_STYLES = ("flat", "comm", "hierarchy", "hub")


def newer(src, dst):
    if not os.path.isfile(src):
        return False
    if not os.path.exists(dst):
        return True
    return os.path.getmtime(src) > os.path.getmtime(dst) + 1


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def graph_signature(path):
    d = load_json(path, None)
    if not d:
        return None
    sys.path.insert(0, HERE)
    import layout_orig
    ids = [str(n.get("id")) for n in d.get("nodes", [])]
    return len(ids), layout_orig.fnv(ids)


def copy_file(src, dst, apply_it, actions):
    if not newer(src, dst):
        return
    actions.append(("copy", os.path.relpath(src, OLD_ROOT), os.path.relpath(dst, NEW_ROOT)))
    if apply_it:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)


def main():
    global OLD_ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True, help="旧项目根目录")
    ap.add_argument("--apply", action="store_true", help="真正执行；默认是干跑预览")
    args = ap.parse_args()
    OLD_ROOT = os.path.abspath(args.old)
    apply_it = args.apply
    actions = []

    # 1) 三份图谱 + uid_topics（布局要等校验通过）
    for t in TOPICS:
        for name in (t + ".json", t + ".bundle.js"):
            copy_file(os.path.join(OLD_ROOT, "data", name),
                      os.path.join(NEW_ROOT, "data", name), apply_it, actions)
    for name in ("uid_topics.json", "uid_topics.bundle.js"):
        copy_file(os.path.join(OLD_ROOT, "data", name),
                  os.path.join(NEW_ROOT, "data", name), apply_it, actions)

    # 2) 布局：只有 count/hash 与旧图谱一致才复制
    for t in TOPICS:
        src_graph = os.path.join(OLD_ROOT, "data", t + ".json")
        sig = graph_signature(src_graph)
        src_dir = os.path.join(OLD_ROOT, "data", "layouts_" + t)
        if not os.path.isdir(src_dir):
            continue
        ok = True
        if sig:
            probe = os.path.join(src_dir, "all_flat.json")
            lay = load_json(probe, None)
            if not lay or lay.get("count") != sig[0] or str(lay.get("hash")) != str(sig[1]):
                ok = False
                actions.append(("WARN", "layouts_" + t,
                                "旧布局 hash/count 与旧图谱不一致，跳过；请在本副本重算布局"))
        if not ok:
            continue
        for view in LAYOUT_NAMES:
            for style in LAYOUT_STYLES:
                for ext in (".json", ".bundle.js"):
                    name = view + "_" + style + ext
                    copy_file(os.path.join(src_dir, name),
                              os.path.join(NEW_ROOT, "data", "layouts_" + t, name),
                              apply_it, actions)

    # 3) 抓取断点（明文优先；本副本的读取代码同时支持 .gz）
    for t in TOPICS:
        src_dir = os.path.join(OLD_ROOT, "creator-studio", "state", t)
        dst_dir = os.path.join(NEW_ROOT, "creator-studio", "state", t)
        if not os.path.isdir(src_dir):
            continue
        for name in os.listdir(src_dir):
            if not name.endswith(".json"):
                continue
            copy_file(os.path.join(src_dir, name), os.path.join(dst_dir, name), apply_it, actions)

    # 4) 申请收录消息：按行追加去重，不覆盖
    src_apply = os.path.join(OLD_ROOT, "creator-studio", "apply_list.txt")
    dst_apply = os.path.join(NEW_ROOT, "creator-studio", "apply_list.txt")
    if os.path.isfile(src_apply):
        old_lines = [x.rstrip("\n") for x in open(src_apply, encoding="utf-8")]
        new_lines = []
        if os.path.isfile(dst_apply):
            new_lines = [x.rstrip("\n") for x in open(dst_apply, encoding="utf-8")]
        missing = [x for x in old_lines if x and x not in new_lines]
        if missing:
            actions.append(("append", "apply_list.txt", "%d 行" % len(missing)))
            if apply_it:
                with open(dst_apply, "a", encoding="utf-8") as f:
                    for line in missing:
                        f.write(line + "\n")
    src_read = os.path.join(OLD_ROOT, "creator-studio", "apply_read.json")
    dst_read = os.path.join(NEW_ROOT, "creator-studio", "apply_read.json")
    old_set = {int(x) for x in (load_json(src_read, {}) or {}).get("read", []) if str(x).isdigit()}
    new_set = {int(x) for x in (load_json(dst_read, {}) or {}).get("read", []) if str(x).isdigit()}
    if old_set - new_set:
        actions.append(("merge", "apply_read.json", "已读行号 +%d" % len(old_set - new_set)))
        if apply_it:
            with open(dst_read, "w", encoding="utf-8") as f:
                json.dump({"read": sorted(old_set | new_set)}, f)

    # 5) 待渲染名单：按 (分区, UID) 合并
    src_pending = os.path.join(OLD_ROOT, "creator-studio", "state", "pending_adds.json")
    dst_pending = os.path.join(NEW_ROOT, "creator-studio", "state", "pending_adds.json")
    old_p = load_json(src_pending, {}) or {}
    new_p = load_json(dst_pending, {}) or {}
    merged = dict(new_p)
    for topic, recs in old_p.items():
        if not isinstance(recs, list):
            continue
        have = {str(x.get("id")) for x in merged.get(topic, []) if isinstance(x, dict)}
        bucket = list(merged.get(topic, []))
        for rec in recs:
            if isinstance(rec, dict) and str(rec.get("id")) not in have:
                bucket.append(rec)
                have.add(str(rec.get("id")))
        merged[topic] = bucket
    if merged != new_p:
        actions.append(("merge", "pending_adds.json", "合并后 %d 个分区"
                        % len(merged)))
        if apply_it:
            with open(dst_pending, "w", encoding="utf-8") as f:
                json.dump(merged, f, ensure_ascii=False, indent=1)

    print("模式：", "执行" if apply_it else "干跑预览（加 --apply 才真正写）")
    for kind, a, b in actions:
        print("  [%s] %s -> %s" % (kind, a, b))
    if not actions:
        print("  没有需要迁移的内容（旧数据不比副本新）")
    print("共 %d 项。" % len(actions))


if __name__ == "__main__":
    main()
