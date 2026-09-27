#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
量一下场景 prompt 的**真实 CLIP token 数**（SDXL 上限 77，超了会被静默截断）

为什么单独做这一步：diffusers 只在控制台打一行 warning，图照出，但约束被砍掉一半——
靠"估"（词数×1.3）不靠谱，只有拿真分词器数一遍才知道。配置由 TS 侧导出：
    npx tsx scripts/export-scene-config.mts
    .venv-image\\Scripts\\python.exe scripts/check_scene_prompt_tokens.py --config temp/scene-config.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:  # 同 generate_scene_art.py：GBK 控制台打印 ✅/❌ 会崩
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
LIMIT = 77


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "temp" / "scene-config.json"))
    ap.add_argument("--limit", type=int, default=LIMIT)
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))

    from transformers import CLIPTokenizer
    hub = os.environ.get("HF_HUB_CACHE") or os.environ.get("HF_HOME") or str(Path.home() / ".cache" / "huggingface")
    # 从本地 sdxl-turbo 缓存里取出 tokenizer（模型已下载，不联网）
    candidates = list(Path(hub).glob("models--stabilityai--sdxl-turbo/snapshots/*/tokenizer"))
    if not candidates:
        print(f"❌ 找不到 sdxl-turbo tokenizer（在 {hub} 下）；先跑过一次出图脚本即可")
        return 2
    tok = CLIPTokenizer.from_pretrained(str(candidates[0]))

    rows = []
    for item in cfg["matrix"]:
        n = len(tok(item["prompt"]).input_ids)
        rows.append((n, item["worldview"], item["theme"], item["prompt"]))
    # 主场景图（每部剧本一张）用同一把尺子量
    for item in cfg.get("masters", []):
        n = len(tok(item["prompt"]).input_ids)
        rows.append((n, item["worldview"], "master:" + item["place"], item["prompt"]))
    rows.sort(reverse=True)
    over = [r for r in rows if r[0] > args.limit]
    print(f"prompt 总数 {len(rows)}；最长 {rows[0][0]} tokens（{rows[0][1]}:{rows[0][2]}）；超 {args.limit} 的：{len(over)} 张")
    for n, w, t, p in rows[:5]:
        print(f"  {n:3d} tokens  {w}:{t}")
        print(f"        {p[:150]}")
    if over:
        print("\n超限清单：")
        for n, w, t, _ in over:
            print(f"  {n} tokens  {w}:{t}")
        return 1
    print("✅ 全部在 77 token 以内，约束不会被截断")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
