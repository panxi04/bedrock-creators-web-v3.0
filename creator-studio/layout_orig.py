# -*- coding: utf-8 -*-
"""预计算图布局: 3视图(all/pe/br) × 4布局(flat/comm/hierarchy/hub) -> layouts/*.json
纯Python, 双层网格近似斥力(O(n²/64)), 无需第三方依赖。
输出格式: {count, hash, x:[], y:[], group:[]}  hash=FNV-1a(节点id逗号串)
"""
import json, os, math, random, collections

BASE = os.path.dirname(os.path.abspath(__file__))
random.seed(42)
K = 30.0  # 理想边长

def fnv(ids):
    h = 0x811c9dc5
    for ch in ",".join(ids):
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")

def label_propagation(n, adj):
    labels = list(range(n))
    order = list(range(n))
    for _ in range(30):
        random.shuffle(order)
        changed = False
        for i in order:
            if not adj[i]:
                continue
            cnt = collections.Counter(labels[j] for j in adj[i])
            best = max(cnt.values())
            cands = [l for l, c in cnt.items() if c == best]
            new = random.choice(cands) if len(cands) > 1 else cands[0]
            if new != labels[i]:
                labels[i] = new
                changed = True
        if not changed:
            break
    uniq = {}
    for l in labels:
        if l not in uniq:
            uniq[l] = len(uniq)
    return [uniq[l] for l in labels]

def force_layout(n, edges, groups=None, iters=280):
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b); adj[b].append(a)
    # 重力系数须与K匹配: 平衡间距 d=sqrt(K²/g), 否则核心被斥力推到数千单位外导致fit缩到最小
    g = 0.6
    ng = (max(groups) + 1) if groups else 0
    centers = []
    if groups:
        sizes = collections.Counter(groups)
        order = sorted(range(ng), key=lambda k: -sizes[k])
        centers = [None] * ng
        cum = 0.0
        for k, gid in enumerate(order):
            rg = K * (0.65 * math.sqrt(sizes[gid]) + 0.5) + K * 0.35
            cum += rg * rg
            r = math.sqrt(cum)
            ang = k * 2.399963229728653
            centers[gid] = (r * math.cos(ang), r * math.sin(ang))
        x = [centers[groups[i]][0] + random.uniform(-K, K) for i in range(n)]
        y = [centers[groups[i]][1] + random.uniform(-K, K) for i in range(n)]
    else:
        R = math.sqrt(n) * K * 0.6
        x = [random.uniform(-R, R) for _ in range(n)]
        y = [random.uniform(-R, R) for _ in range(n)]
    fine = 2.0 * K
    coarse = 10.0 * K
    for it in range(iters):
        temp = K * 1.5 * (1.0 - it / iters) + 0.4
        fgrid = {}
        cgrid = {}
        for i in range(n):
            fc = (int(x[i] // fine), int(y[i] // fine))
            fgrid.setdefault(fc, []).append(i)
            cc = (int(x[i] // coarse), int(y[i] // coarse))
            e = cgrid.get(cc)
            if e:
                e[0] += 1; e[1] += x[i]; e[2] += y[i]
            else:
                cgrid[cc] = [1, x[i], y[i]]
        dx = [0.0] * n
        dy = [0.0] * n
        k2 = K * K
        cells = list(cgrid.items())
        for i in range(n):
            xi, yi = x[i], y[i]
            fcx, fcy = int(xi // fine), int(yi // fine)
            ccx, ccy = int(xi // coarse), int(yi // coarse)
            for gx in range(fcx - 1, fcx + 2):
                for gy in range(fcy - 1, fcy + 2):
                    for j in fgrid.get((gx, gy), ()):
                        if j == i:
                            continue
                        ddx, ddy = xi - x[j], yi - y[j]
                        d2 = ddx * ddx + ddy * ddy
                        if d2 < 0.01:
                            ddx, ddy = random.uniform(-1, 1), random.uniform(-1, 1)
                            d2 = ddx * ddx + ddy * ddy + 0.01
                        f = k2 / d2
                        dx[i] += ddx * f; dy[i] += ddy * f
            for (gx, gy), (cnt, sx, sy) in cells:
                if abs(gx - ccx) <= 1 and abs(gy - ccy) <= 1:
                    continue  # 近区已由细网格精确计算
                # 远场只保留邻近 5 个粗网格（约 10K 的半径）；更远处的斥力
                # 相对全局重力已可忽略，截掉后大幅减少内层循环次数。
                if abs(gx - ccx) > 5 or abs(gy - ccy) > 5:
                    continue
                ddx, ddy = xi - sx / cnt, yi - sy / cnt
                d2 = ddx * ddx + ddy * ddy + 1.0
                f = k2 * cnt / d2
                dx[i] += ddx * f; dy[i] += ddy * f
        for a, b in edges:
            ddx, ddy = x[a] - x[b], y[a] - y[b]
            d = math.sqrt(ddx * ddx + ddy * ddy) + 0.01
            f = d / K  # 吸引力 ~ d²/k / d
            fx, fy = ddx * f, ddy * f
            dx[a] -= fx; dy[a] -= fy
            dx[b] += fx; dy[b] += fy
        if groups:
            for i in range(n):
                cx, cy = centers[groups[i]]
                dx[i] += (cx - x[i]) * g
                dy[i] += (cy - y[i]) * g
        else:
            for i in range(n):
                dx[i] -= x[i] * g
                dy[i] -= y[i] * g
        mx = sum(x) / n; my = sum(y) / n
        for i in range(n):
            d = math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) + 0.01
            s = min(d, temp) / d
            x[i] += dx[i] * s - mx * 0.05
            y[i] += dy[i] * s - my * 0.05
    return x, y

def hierarchy_layout(n, edges, groups):
    """径向树: 每个连通分量以最高度为根, 深度=半径, 子树按比例分角度 -> 放射状分支"""
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b); adj[b].append(a)
    deg = [len(a) for a in adj]
    x = [0.0] * n; y = [0.0] * n; ring = [0] * n
    core = [i for i in range(n) if deg[i] > 0]
    if not core:
        return x, y, ring
    seen = set(); comps = []
    for s in core:
        if s in seen:
            continue
        comp = []; q = collections.deque([s]); seen.add(s)
        while q:
            u = q.popleft(); comp.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v); q.append(v)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    STEP = 70.0; GOLD = 2.399963229728653
    cum = 0.0
    for ci, comp in enumerate(comps):
        cset = set(comp)
        root = max(comp, key=lambda i: deg[i])
        parent = {root: -1}; order = [root]
        for u in order:
            for v in adj[u]:
                if v in cset and v not in parent:
                    parent[v] = u; order.append(v)
        children = collections.defaultdict(list)
        for v in order[1:]:
            children[parent[v]].append(v)
        sz = {}
        for v in reversed(order):
            s = 1
            for c in children[v]:
                s += sz[c]
            sz[v] = s
        pos = {}
        stack = [(root, 0.0, 2 * math.pi, 0)]
        while stack:
            u, a0, a1, dpt = stack.pop()
            pos[u] = (dpt, (a0 + a1) / 2.0)
            tot = sz[u] - 1
            if tot > 0:
                cur = a0
                for c in sorted(children[u], key=lambda z: -sz[z]):
                    w = (a1 - a0) * sz[c] / tot
                    stack.append((c, cur, cur + w, dpt + 1)); cur += w
        Rc = max(d for d, _ in pos.values()) * STEP + 20.0
        cum += (Rc + 70.0) ** 2
        rc = math.sqrt(cum)
        a = ci * GOLD
        ox, oy = rc * math.cos(a), rc * math.sin(a)
        for i, (dpt, th) in pos.items():
            x[i] = ox + dpt * STEP * math.cos(th)
            y[i] = oy + dpt * STEP * math.sin(th)
            ring[i] = dpt
    return x, y, ring

def hub_layout(n, edges, adj):
    """枢纽聚在中心小圈, 其余节点归属最近枢纽并向外螺旋发散 -> 中心放射+跨境弦"""
    deg = [len(a) for a in adj]
    core = [i for i in range(n) if deg[i] > 0]
    x = [0.0] * n; y = [0.0] * n; grp = [0] * n
    if not core:
        return x, y, grp
    nh = min(24, max(6, len(core) // 40))
    hubs = sorted(core, key=lambda i: -deg[i])[:nh]
    hub_index = {h: k for k, h in enumerate(hubs)}
    hubpos = {}
    for k, h in enumerate(hubs):
        r = 190.0 * math.sqrt(k + 1)
        a = k * 2.399963229728653
        hubpos[h] = (r * math.cos(a), r * math.sin(a))
    owner = {}
    q = collections.deque()
    for h in hubs:
        owner[h] = h; q.append(h)
    while q:
        u = q.popleft()
        for v in adj[u]:
            if v not in owner:
                owner[v] = owner[u]; q.append(v)
    cnt = collections.Counter()
    for i in core:
        if i in hubpos:
            x[i], y[i] = hubpos[i]
            grp[i] = hub_index[i]
            continue
        h = owner.get(i)
        if h is None:
            continue
        k = cnt[h]; cnt[h] += 1
        r = K * 1.15 * math.sqrt(k + 1)
        a = k * 2.399963229728653
        cx, cy = hubpos[h]
        x[i] = cx + r * math.cos(a); y[i] = cy + r * math.sin(a)
        grp[i] = hub_index[h]
    return x, y, grp

def relax_positions(n, x, y, rad, margin=6.0, iters=150, active=None):
    """按节点半径做碰撞松弛；active 指定需要移动的节点，其余只参与避让。

    孤立点由黄金角螺旋按面积步进摆放，间距本就大于圆直径，不必参与松弛；
    让它们只作为障碍参与碰撞，可以把 4 万个点的松弛压缩到 1 万个核心点。
    """
    cell = 2.0 * max(rad) + margin
    idxs = range(n) if active is None else active
    active_set = None if active is None else set(active)
    for _ in range(iters):
        grid = {}
        for i in range(n):
            grid.setdefault((int(x[i] // cell), int(y[i] // cell)), []).append(i)
        moved = 0
        for i in idxs:
            gx, gy = int(x[i] // cell), int(y[i] // cell)
            for ox in (gx - 1, gx, gx + 1):
                for oy in (gy - 1, gy, gy + 1):
                    for j in grid.get((ox, oy), ()):
                        if j == i:
                            continue
                        if active_set is None:
                            if j < i:
                                continue
                        elif j in active_set and j < i:
                            continue
                        dx = x[j] - x[i]; dy = y[j] - y[i]
                        d = math.sqrt(dx * dx + dy * dy)
                        need = rad[i] + rad[j] + margin
                        if d < need:
                            if d < 0.01:
                                ang = random.uniform(0, 6.283185307)
                                dx, dy, d = math.cos(ang), math.sin(ang), 1.0
                            push = (need - d) * 0.55
                            ux, uy = dx / d, dy / d
                            x[i] -= ux * push; y[i] -= uy * push
                            x[j] += ux * push; y[j] += uy * push
                            moved += 1
        if not moved:
            break
    return x, y

def main():
    graph = json.load(open(os.path.join(BASE, "graph.json"), encoding="utf-8"))
    outdir = os.path.join(BASE, "layouts")
    os.makedirs(outdir, exist_ok=True)
    for view in ("all", "pe", "br"):
        nodes = [nd for nd in graph["nodes"] if view == "all" or nd[view]]
        ids = [nd["id"] for nd in nodes]
        idx = {m: i for i, m in enumerate(ids)}
        edges = [(idx[l["source"]], idx[l["target"]]) for l in graph["links"]
                 if (view == "all" or l[view]) and l["source"] in idx and l["target"] in idx]
        n = len(nodes)
        if n == 0:
            continue
        global K
        K = 30.0 if n <= 20000 else (42.0 if n <= 40000 else 52.0)
        adj = [[] for _ in range(n)]
        for a, b in edges:
            adj[a].append(b); adj[b].append(a)
        print("视图 %s: %d节点 %d边" % (view, n, len(edges)), flush=True)
        # 核心(有合作)力导向 + 孤立节点向日葵螺旋外环, 避免上千孤立点互相重叠
        deg = [len(a) for a in adj]
        core = [i for i in range(n) if deg[i] > 0]
        iso = [i for i in range(n) if deg[i] == 0]
        ci = {v: k for k, v in enumerate(core)}
        ce = [(ci[a], ci[b]) for a, b in edges]
        cadj = [[] for _ in core]
        for a, b in ce:
            cadj[a].append(b); cadj[b].append(a)
        cgroups = label_propagation(len(core), cadj) if core else []

        def place_halo(x, y):
            R0 = (max(math.hypot(x[i], y[i]) for i in core) + K * 1.5) if core else K * 2
            S = K * 0.95
            for k, i in enumerate(iso):
                r = math.sqrt(R0 * R0 + (k + 1) * S * S / math.pi)
                ang = k * 2.399963229728653
                x[i] = r * math.cos(ang); y[i] = r * math.sin(ang)
            return x, y

        layouts = {}
        core_n = len(core)
        fit_iters = 280 if core_n <= 3000 else (160 if core_n <= 12000 else 90)
        relax_iters = 150 if n <= 10000 else (90 if n <= 25000 else 55)
        if core:
            fx, fy = force_layout(core_n, ce, iters=fit_iters)
            x = [0.0] * n; y = [0.0] * n
            for k, i in enumerate(core):
                x[i], y[i] = fx[k], fy[k]
            x, y = place_halo(x, y)
            layouts["flat"] = (x, y, [0] * n)
            fx, fy = force_layout(core_n, ce, cgroups, iters=fit_iters)
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
        hx, hy, hg = hierarchy_layout(n, edges, None)
        hx, hy = place_halo(hx, hy)
        layouts["hierarchy"] = (hx, hy, hg)
        ux, uy, ug = hub_layout(n, edges, adj)
        ux, uy = place_halo(ux, uy)
        layouts["hub"] = (ux, uy, ug)
        rad = [8 + min(12, math.sqrt(d) * 2.8) for d in deg]
        for name in list(layouts):
            lx, ly, lg = layouts[name]
            passes = 2 if n > 25000 else (3 if name in ("hub", "hierarchy") else 1)
            for _ in range(passes):
                lx, ly = relax_positions(len(lx), lx, ly, rad, iters=relax_iters)
            layouts[name] = (lx, ly, lg)
        h = fnv(ids)
        for name, (x, y, g) in layouts.items():
            obj = {"count": n, "hash": h,
                   "x": [round(v, 1) for v in x], "y": [round(v, 1) for v in y], "group": g}
            with open(os.path.join(outdir, "%s_%s.json" % (view, name)), "w", encoding="utf-8") as f:
                json.dump(obj, f)
        print("  完成 %s (核心 %d, 孤立 %d, 社区数 %d)" % (view, len(core), len(iso), (max(cgroups) + 1) if cgroups else 0), flush=True)

if __name__ == "__main__":
    main()