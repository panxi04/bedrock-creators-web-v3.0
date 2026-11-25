# -*- coding: utf-8 -*-
"""抓取引擎与联网助手共用的全局请求节流。

两条链路都用 bili.Bili 发请求，但过去各自限速：抓取按阶段内部 delay，
联网助手按 helper._MIN_GAP，两者同时跑时同一出口 IP 会自己把自己刷到 412。
这里把最小间隔收敛到一个进程级令牌位：所有 Bili.get / helper 代理请求都先排队。
"""
import threading
import time

GAP = 0.35          # 全进程对 B 站的最小请求间隔（秒）
_lock = threading.Lock()
_last = [0.0]


def wait():
    """占用一个请求位；返回实际等待的秒数。持锁 sleep 保证全局串行。"""
    with _lock:
        d = GAP - (time.time() - _last[0])
        if d > 0:
            time.sleep(d)
        else:
            d = 0.0
        _last[0] = time.time()
        return d
