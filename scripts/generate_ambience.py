#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
剧情「环境音」素材生成（docs/roleplay-immersion-plan.md §4.1 的环境音效部分）

⚠️ 为什么是"自生成"而不是下载 CC0 素材：
   Pixabay/Freesound 一类站点需要账号/API key，且批量抓取通常违反其条款；
   而雨声/风声/室内底噪这类**宽带噪声类**环境音恰好是程序合成最擅长的——
   于是这里用 numpy 直接合成，**版权 100% 自有（无第三方权利）**，无需登记授权。
   将来想换成精选 CC0 素材：把同名文件放进 public/audio/roleplay-ambience/ 覆盖即可
   （前端只认 manifest 里的文件名，不改代码）。

关键工程点：
- **无缝循环**：先生成 L+fade 长度的信号，再把尾巴与开头做等功率交叉淡化 → 循环点无爆音（有单测/分析脚本校验）。
- **长度与格式**：22050Hz 单声道 16bit WAV（浏览器全兼容、本身即无缝，避开 mp3 编码器延迟导致的循环接缝）。
- **电平**：环境音归一化到 -26 dBFS 左右（远低于人声/朗读），雷声一次性音效略响（-16 dBFS）。
- 输出 manifest（含 rms/时长/license 字段），与剧本 BGM 的资产登记口径保持一致。

用法（用 .venv-image，它已带 numpy）：
    .venv-image\\Scripts\\python.exe scripts\\generate_ambience.py
    ... --out public/audio/roleplay-ambience --force
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import wave
from pathlib import Path

try:  # Windows 控制台 GBK，emoji 会崩
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np

SR = 22050
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "public" / "audio" / "roleplay-ambience"


# ---------- 基础工具 ----------

def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def moving_avg(x: np.ndarray, k: int) -> np.ndarray:
    if k <= 1:
        return x
    ker = np.ones(k, dtype=np.float64) / k
    return np.convolve(x, ker, mode="same")


def low_pass(x: np.ndarray, k: int) -> np.ndarray:
    """简单滑动平均低通（够用且无需 scipy）"""
    return moving_avg(x, k)


def high_pass(x: np.ndarray, k: int) -> np.ndarray:
    return x - moving_avg(x, k)


def normalize_rms(x: np.ndarray, target_dbfs: float) -> np.ndarray:
    rms = float(np.sqrt(np.mean(x ** 2))) or 1e-9
    target = 10 ** (target_dbfs / 20.0)
    y = x * (target / rms)
    peak = float(np.max(np.abs(y))) or 1e-9
    if peak > 0.98:                      # 防削波
        y = y * (0.98 / peak)
    return y


def seamless(x: np.ndarray, fade: int) -> np.ndarray:
    """把尾巴与开头等功率交叉淡化 → 循环点无爆音"""
    if fade <= 0 or len(x) <= fade * 2:
        return x
    L = len(x) - fade
    head = x[:L].copy()
    tail = x[L:L + fade]
    w = np.linspace(0.0, 1.0, fade, dtype=np.float64)
    head[:fade] = head[:fade] * w + tail * (1.0 - w)
    return head


def write_wav(path: Path, x: np.ndarray) -> None:
    data = np.clip(x, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------- 各个环境音 ----------

def make_rain(seconds: float = 6.0) -> np.ndarray:
    """雨：高通噪声（雨幕）+ 随机雨滴瞬态（打在窗上的点）"""
    n = int(SR * (seconds + 1.0))
    g = rng(20260914)
    base = g.normal(0, 1, n)
    body = high_pass(low_pass(high_pass(base, 2), 3), 40)      # 去掉极低频轰鸣，保留雨沙沙感
    body = low_pass(body, 2)
    # 雨滴：短促衰减噪声爆发
    drops = np.zeros(n)
    count = int(seconds * 55)
    for _ in range(count):
        i = int(g.integers(0, n - 400))
        ln = int(g.integers(60, 380))
        env = np.exp(-np.linspace(0, 6, ln))
        drops[i:i + ln] += g.normal(0, 1, ln) * env * 0.85
    drops = high_pass(drops, 6)
    x = body * 0.9 + drops * 0.5
    return seamless(normalize_rms(x, -26.0), fade=int(SR * 1.0))


def make_wind(seconds: float = 8.0) -> np.ndarray:
    """风：重低通噪声 + 极慢幅度调制（气息起伏）"""
    n = int(SR * (seconds + 1.0))
    g = rng(770315)
    base = g.normal(0, 1, n)
    body = low_pass(base, 260)
    body = low_pass(body, 160)
    t = np.arange(n) / SR
    am = 0.55 + 0.45 * (0.5 + 0.5 * np.sin(2 * math.pi * 0.11 * t + 0.7)) * (0.6 + 0.4 * np.sin(2 * math.pi * 0.037 * t))
    x = body * am
    return seamless(normalize_rms(x, -27.0), fade=int(SR * 1.0))


def make_room_tone(seconds: float = 6.0) -> np.ndarray:
    """室内底噪（房间感）：极低电平的布朗噪声 + 轻微高频空气感"""
    n = int(SR * (seconds + 1.0))
    g = rng(4242)
    white = g.normal(0, 1, n)
    brown = np.cumsum(white)
    brown = brown - moving_avg(brown, 2000)                    # 去趋势
    brown = brown / (np.max(np.abs(brown)) or 1)
    air = low_pass(high_pass(g.normal(0, 1, n), 2), 6) * 0.12
    x = brown * 0.9 + air
    return seamless(normalize_rms(x, -30.0), fade=int(SR * 1.0))


def make_tick(seconds: float = 6.0) -> np.ndarray:
    """钟摆滴答：每秒一次短促脉冲（留白为主，适合安静场景）"""
    n = int(SR * (seconds + 1.0))
    g = rng(9090)
    x = np.zeros(n)
    for i in range(0, int(seconds)):
        idx = int(i * SR + SR * 0.5)
        ln = 900
        env = np.exp(-np.linspace(0, 14, ln))
        click = g.normal(0, 1, ln) * env
        click = high_pass(click, 3)
        x[idx:idx + ln] += click
        # 钟摆"摆"的一半音量
        idx2 = idx + SR // 2
        x[idx2:idx2 + ln] += click * 0.6
    return seamless(normalize_rms(x, -28.0), fade=int(SR * 0.5))


def make_thunder(seconds: float = 3.6) -> np.ndarray:
    """雷（一次性音效，不循环）：低频轰鸣 + 起始爆裂"""
    n = int(SR * seconds)
    g = rng(1313)
    low = low_pass(g.normal(0, 1, n), 700) * 14.0
    t = np.arange(n) / SR
    env = np.exp(-np.maximum(0, t - 0.05) * 1.15) * (1 - np.exp(-t * 90))
    rumble = low * env
    crack = g.normal(0, 1, n) * np.exp(-t * 26) * 0.5
    crack = high_pass(low_pass(crack, 2), 5)
    x = rumble + crack
    return normalize_rms(x, -16.0)


SPECS = [
    ("rain-soft", "雨（窗外细雨）", make_rain, True),
    ("wind-low", "风（低沉风声）", make_wind, True),
    ("room-soft", "室内底噪（房间感）", make_room_tone, True),
    ("clock-tick", "钟摆滴答", make_tick, True),
    ("thunder-far", "远处雷声（一次性）", make_thunder, False),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="剧情环境音素材生成（程序合成，免版权）")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--force", action="store_true", help="已存在也重出")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    items = []
    for aid, label, fn, loop in SPECS:
        target = out / f"{aid}.wav"
        if target.exists() and not args.force:
            print(f"skip {aid}（已存在，--force 可重出）")
        else:
            t0 = time.perf_counter()
            x = fn()
            write_wav(target, x)
            print(f"✓ {aid}  {len(x) / SR:.1f}s  {target.stat().st_size // 1024}KB  {time.perf_counter() - t0:.1f}s")
        with wave.open(str(target), "rb") as w:
            frames = w.getnframes()
            sr = w.getframerate()
            raw = np.frombuffer(w.readframes(frames), dtype="<i2").astype(np.float64) / 32768.0
        items.append({
            "id": aid, "label": label, "file": f"{aid}.wav", "loop": loop,
            "seconds": round(frames / sr, 2), "sampleRate": sr,
            "rmsDbfs": round(20 * math.log10(float(np.sqrt(np.mean(raw ** 2))) or 1e-9), 1),
            "peak": round(float(np.max(np.abs(raw))), 3),
            "seamDelta": round(abs(float(raw[0]) - float(raw[-1])), 4),
            "bytes": target.stat().st_size,
            "source": "procedural-synth (numpy)", "license": "self-generated, no third-party rights",
            "script": "scripts/generate_ambience.py",
        })

    manifest = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "note": "程序合成、免版权；如需改用精选 CC0 素材，覆盖同名文件并在 items[].source/license 里更新登记",
        "items": items,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(i["bytes"] for i in items) / 1024 / 1024
    print(f"\n完成：{len(items)} 个素材，共 {total:.2f}MB → {out}")
    for i in items:
        print(f"  {i['id']:12s} {i['seconds']:>5}s  rms={i['rmsDbfs']:>6}dBFS  peak={i['peak']:<5}  循环接缝差={i['seamDelta']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
