# -*- coding: utf-8 -*-
"""通用主题信号匹配 —— 把原项目硬编码的基岩正则改成配置驱动。

配置里给三组正则：
  strong      命中即算（如「机械动力 / create mod / 齿轮传动」）
  context     语境词（如「我的世界 / minecraft / mc / 方块」）
  other_game  其他游戏噪声（如「迷你世界 / 蛋仔派对」）
  weak        弱信号，需配合 context 才算（如「蒸汽 / 动力 / 自动化」）

判定：
  标题以 other_game 开头           -> 否
  strong 命中                      -> 是（除非 other_game 命中且无 MC 语境）
  other_game 命中                  -> 否
  weak 且 context 同时命中         -> 是
  其余                             -> 否
"""
import re

AT_RE = re.compile(r"[@＠]([一-鿿A-Za-z0-9_\-]{1,24})")


class Matcher:
    def __init__(self, cfg):
        self.strong = re.compile("|".join(cfg["strong"]), re.I) if cfg.get("strong") else None
        self.weak = re.compile("|".join(cfg["weak"]), re.I) if cfg.get("weak") else None
        self.context = re.compile("|".join(cfg["context"]), re.I) if cfg.get("context") else None
        self.other = re.compile("|".join(cfg["other_game"]), re.I) if cfg.get("other_game") else None

    def hit(self, title, desc="", tag=""):
        t = title or ""
        text = "%s %s %s" % (t, desc or "", tag or "")
        if self.strong and self.strong.search(text):
            if self.other and self.other.search(t) and not (self.context and self.context.search(text)):
                return False
            return True
        if self.other and self.other.search(text):
            return False
        if self.weak and self.context and self.weak.search(text) and self.context.search(text):
            return True
        return False

    def match_at(self, text, names):
        """复用原项目的前缀最长匹配：@张某人 -> 若「张某」在图内则连到「张某」。"""
        found = set()
        for m in AT_RE.finditer(text or ""):
            s = m.group(1)
            for L in range(len(s), 0, -1):
                if s[:L] in names:
                    found.add(s[:L])
                    break
        return found
