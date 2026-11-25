# -*- coding: utf-8 -*-
"""用原项目 layout.py 的算法，为任意一份图谱生成 3视图×4布局 的预计算布局。

用法:
  python make_layouts.py <graph.json> <输出目录>
例:
  python make_layouts.py ../data/java.json ../data/layouts_java
  python make_layouts.py ../data/create.json ../data/layouts_create
输出文件与原项目完全一致: {count, hash, x, y, group}，文件名 <view>_<name>.json
"""
import json
import os
import sys
# --noconsole 的 exe 里 sys.stdout 可能为 None，print 会抛异常中断布局生成
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
import layout_orig as L


def _write_layout(outdir, view, name, obj):
    """同时写 json 和 bundle.js，保证 http / file:// 两种模式都能读到新布局。"""
    p = os.path.join(outdir, "%s_%s.json" % (view, name))
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    with open(p[:-5] + ".bundle.js", "w", encoding="utf-8", newline="\n") as f:
        f.write("window.__GRAPH_LAYOUT=" + text + ";\n")


def make(graph_path, outdir):
    graph = json.load(open(graph_path, encoding="utf-8"))
    os.makedirs(outdir, exist_ok=True)
    # 三分区都不再有时代切换，前端只读 all_* 布局；pe/br 视图不再生成。
    for view in ("all",):
        nodes = [nd for nd in graph["nodes"] if view == "all" or nd.get(view)]
        ids = [nd["id"] for nd in nodes]
        idx = {m: i for i, m in enumerate(ids)}
        edges = [(idx[l["source"]], idx[l["target"]]) for l in graph["links"]
                 if (view == "all" or l.get(view)) and l["source"] in idx and l["target"] in idx]
        n = len(nodes)
        h = L.fnv(ids)
        if n == 0:                      # 空图谱也要写空布局，前端才不会报“布局加载失败”
            empty = {"count": 0, "hash": h, "x": [], "y": [], "group": []}
            for name in ("flat", "comm", "hierarchy", "hub"):
                _write_layout(outdir, view, name, empty)
            print("视图 %s: 0节点（空布局已写）" % view, flush=True)
            continue
        L.K = 30.0 if n <= 20000 else (42.0 if n <= 40000 else 52.0)
        adj = [[] for _ in range(n)]
        for a, b in edges:
            adj[a].append(b); adj[b].append(a)
        print("视图 %s: %d节点 %d边" % (view, n, len(edges)), flush=True)
        deg = [len(a) for a in adj]
        core = [i for i in range(n) if deg[i] > 0]
        iso = [i for i in range(n) if deg[i] == 0]
        ci = {v: k for k, v in enumerate(core)}
        ce = [(ci[a], ci[b]) for a, b in edges]
        cadj = [[] for _ in core]
        for a, b in ce:
            cadj[a].append(b); cadj[b].append(a)
        cgroups = L.label_propagation(len(core), cadj) if core else []

        def place_halo(x, y):
            R0 = (max((x[i] ** 2 + y[i] ** 2) ** 0.5 for i in core) + L.K * 1.5) if core else L.K * 2
            S = L.K * 0.95
            for k, i in enumerate(iso):
                r = (R0 * R0 + (k + 1) * S * S / 3.141592653589793) ** 0.5
                ang = k * 2.399963229728653
                x[i] = r * __import__("math").cos(ang); y[i] = r * __import__("math").sin(ang)
            return x, y

        layouts = {}
        core_n = len(core)
        fit_iters = 280 if core_n <= 3000 else (160 if core_n <= 12000 else 90)
        relax_iters = 150 if n <= 10000 else (90 if n <= 25000 else 55)
        if core:
            fx, fy = L.force_layout(core_n, ce, iters=fit_iters)
            x = [0.0] * n; y = [0.0] * n
            for k, i in enumerate(core):
                x[i], y[i] = fx[k], fy[k]
            x, y = place_halo(x, y)
            layouts["flat"] = (x, y, [0] * n)
            fx, fy = L.force_layout(core_n, ce, cgroups, iters=fit_iters)
            x = [0.0] * n; y = [0.0] * n
            for k, i in enumerate(core):
                x[i], y[i] = fx[k], fy[k]
            x, y = place_halo(x, y)
            gfull = [0] * n
            for k, i in enumerate(core):
                gfull[i] = cgroups[k]
            for i in iso:
                gfull[i] = (max(cgroups) + 1) if cgroups else 0
            layouts["comm"] = (x, y, gfull)
        else:
            x = [0.0] * n; y = [0.0] * n
            x, y = place_halo(x, y)
            layouts["flat"] = (x, y, [0] * n)
            layouts["comm"] = (x, y, [0] * n)
        hx, hy, hg = L.hierarchy_layout(n, edges, None)
        hx, hy = place_halo(hx, hy)
        layouts["hierarchy"] = (hx, hy, hg)
        ux, uy, ug = L.hub_layout(n, edges, adj)
        ux, uy = place_halo(ux, uy)
        layouts["hub"] = (ux, uy, ug)
        rad = [8 + min(12, d ** 0.5 * 2.8) for d in deg]
        for name in list(layouts):
            lx, ly, lg = layouts[name]
            passes = 2 if n > 25000 else (3 if name in ("hub", "hierarchy") else 1)
            for _ in range(passes):
                # 孤立点只参与避让、不参与移动（它们由螺旋按面积摆放，本来不重叠）
                lx, ly = L.relax_positions(len(lx), lx, ly, rad, iters=relax_iters, active=core)
            layouts[name] = (lx, ly, lg)
        for name, (x, y, g) in layouts.items():
            obj = {"count": n, "hash": h,
                   "x": [round(v, 1) for v in x], "y": [round(v, 1) for v in y], "group": g}
            _write_layout(outdir, view, name, obj)
    print("完成:", outdir, flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    make(sys.argv[1], sys.argv[2])
