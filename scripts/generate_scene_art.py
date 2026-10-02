#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
剧情「场景配图」离线批量生成（docs/roleplay-immersion-plan.md §4.3 = S3 出图库）

生成的是**共享主题池**这一层：`public/img/roleplay-scenes/{worldview}-{theme}.webp`
（5 世界观 × 14 主题 = 70 张），全站剧本按标签+剧情文本命中复用：静态托管、即时加载、零实时算力。

配置不在这里维护：prompt/主题表/世界观都来自 `src/lib/storyScene.ts`，先用
    npx tsx scripts/export-scene-config.mts
导出成 temp/scene-config.json 再喂给本脚本（**单一事实来源**，避免两处漂移）。

用法（在 .venv-image 里跑，见 scripts/requirements-image.txt）：
    npx tsx scripts/export-scene-config.mts
    .venv-image\\Scripts\\python.exe scripts/generate_scene_art.py --config temp/scene-config.json
    ... --only modern:rain hk:night     # 只出指定几张（调风格时用）
    ... --skip-existing                 # 断点续跑（已存在的跳过）
    ... --size 1024x576 --steps 4

⚠️ 显存闸（方案 §2.3 定的硬约束）：本机可用显存实测在 3.6GB↔15.5GB 之间摆动
（VoxCPM TTS 侧车与桌面应用争用）。sdxl-turbo @1024 峰值约 10.5GB，故脚本**默认要求
空闲 ≥ 11.5GB**，不够就退出并说明"需与 VoxCPM 互斥"，**不要**为了跑批去偷偷停生产侧车。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import zlib
from pathlib import Path

# Windows 控制台默认 GBK：直接 print ❌/✅ 会 UnicodeEncodeError 崩掉
# （最要命的是"显存不足"提示正好用 ❌，恰恰在最需要它说话时崩）。强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "public" / "img" / "roleplay-scenes"
MODEL_ID = os.environ.get("SCENE_ART_MODEL", "stabilityai/sdxl-turbo")

# ⚠️ 模型档案（2026-09-14 用户拍板"用更好的模型"后新增）
#    sdxl-turbo：1-4 步、guidance=0（无 CFG → **负向词无效**），快但**画不准特定场景**
#                （实测：prompt 写"outdoor street"却画成室内客厅；"病房"画成卧室）
#    sdxl-base ：28 步 + CFG 6.5 → **支持负向词**，能画准具体场景/建筑/器物；约 10-12s/张
PROFILES = {
    "sdxl-turbo": {"repo": "stabilityai/sdxl-turbo", "steps": 4, "guidance": 0.0, "negative": False},
    "sdxl-base": {"repo": "stabilityai/stable-diffusion-xl-base-1.0", "steps": 28, "guidance": 6.5, "negative": True},
}
# 负向词（仅 CFG>1 的模型有效）：把红线与常见崩坏一次挡掉
NEGATIVE_PROMPT = (
    "people, person, human, face, faces, hands, body, crowd, crowd of people, silhouette of a person, "
    "text, letters, words, signage, signboard, watermark, signature, logo, poster, "
    "blood, corpse, weapon, gun, knife, "
    "blurry, low quality, deformed, extra limbs, cluttered, oversaturated"
)
# 实测：**旧 16:9 1024x576 峰值约 8.8GB**；新默认 **竖版 960x1280 峰值约 10.5GB**
#（像素数相当，取高的一档留余量）→ 留 ~1.7GB 余量
MIN_FREE_GB = 10.5


def parse_size(s: str) -> tuple[int, int]:
    w, _, h = s.partition("x")
    return int(w), int(h or w)


# ---------- 红线抽检（内置在出图流水线里，不靠 prompt 的运气） ----------

def _load_env() -> dict:
    """读 .env 拿视觉模型配置（只读键值，不外传）"""
    env = {}
    p = ROOT / ".env"
    if not p.exists():
        return env
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


AUDIT_QUESTION = (
    "这是一张场景插画。请只输出一个JSON对象（不要其他文字）："
    '{"has_person":true|false,"has_text":true|false,"description":"一句话"}。'
    "has_person 包含人物、剪影、远景行人、镜中人、雕像分辨不清的人形；has_text 包含任何可辨认的文字/字母/招牌/水印。"
)


def audit_image(path: Path, env: dict, timeout: int = 120) -> dict:
    """问视觉模型：这张图有没有人物/文字（红线）。失败时返回 {'error': ...}（不阻塞出图，交由上层记录）"""
    import base64
    import urllib.request

    key = env.get("DEEPSEEK_API_KEY", "")
    if not key:
        return {"error": "no api key"}
    base = (env.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
    model = env.get("DEEPSEEK_MODEL") or "deepseek-v4-flash"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": AUDIT_QUESTION},
            {"type": "image_url", "image_url": {"url": "data:image/webp;base64," + b64}},
        ]}],
        "max_tokens": 2000,   # 不传 thinking 字段 → 上游默认会思考，reasoning 计入 max_tokens：太小会吃光 → content 为空
    }).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        text = (payload.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return {"error": "no json"}
        return json.loads(m.group(0))
    except Exception as e:  # noqa: BLE001，抽检失败不该让整批出图挂掉
        return {"error": f"{type(e).__name__}: {e}"}


def seed_for(name: str) -> int:
    """同一张图固定 seed → 可复现（重跑同样的 prompt 得到同样的图）"""
    return zlib.crc32(name.encode("utf-8")) % (2 ** 31 - 1)


def main() -> int:
    ap = argparse.ArgumentParser(description="剧情场景配图批量生成（共享主题池）")
    ap.add_argument("--config", default=str(ROOT / "temp" / "scene-config.json"))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    # ⚠️ 2026-09-14 修正：原默认 1024x576（16:9）**是错的**，场景图在真机上是**竖版**
    #    满屏背景（手机容器实测 421×631 = 0.668，object-cover 会把 16:9 裁掉 62%）。
    #    改成竖版 3:4；口径与云路径一致（api/services/imageApi.ts 的 DEFAULT_SCENE_SIZE）。
    ap.add_argument("--size", default="960x1280", help="宽x高（默认 960x1280 竖版 3:4 场景背景）")
    ap.add_argument("--model", default=os.environ.get("SCENE_ART_PROFILE", "sdxl-base"),
                    choices=sorted(PROFILES.keys()), help="模型档案：sdxl-base（默认，28 步+负向词，画得准）/ sdxl-turbo（4 步，快但画不准场景）")
    ap.add_argument("--steps", type=int, default=0, help="覆盖档案里的步数（0 = 用档案默认）")
    ap.add_argument("--guidance", type=float, default=-1.0, help="覆盖档案里的 CFG（-1 = 用档案默认；>1 时负向词才生效）")
    ap.add_argument("--quality", type=int, default=82, help="webp 质量")
    ap.add_argument("--only", nargs="*", default=None, help="只出指定 worldview:theme（主题池用）")
    ap.add_argument("--masters", action="store_true", help="改出「每部剧本一张主场景图」（{scenarioId}-master.webp）")
    ap.add_argument("--seed-offset", type=int, default=0,
                    help="种子偏移：抽检不合格时用它换一版重出（同一张图 seed 固定 → 可复现）")
    ap.add_argument("--skip-existing", action="store_true", help="已存在的跳过（断点续跑）")
    ap.add_argument("--force-low-vram", action="store_true", help="显存不足也硬跑（可能 OOM/降速）")
    ap.add_argument("--audit", action="store_true",
                    help="出图后**内置红线抽检**（问视觉模型有没有人物/文字），不合格自动换 seed 重出")
    ap.add_argument("--audit-retries", type=int, default=3, help="红线抽检最多重试几次")
    args = ap.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.exists():
        print(f"❌ 缺少配置 {cfg_path}（先跑：npx tsx scripts/export-scene-config.mts）")
        return 2
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    width, height = parse_size(args.size)

    profile = PROFILES[args.model]
    model_id = profile["repo"]
    steps = args.steps if args.steps > 0 else profile["steps"]
    guidance = args.guidance if args.guidance >= 0 else profile["guidance"]
    use_negative = bool(profile["negative"]) and guidance > 1.0
    env_audit = _load_env() if args.audit else {}
    if args.audit and not env_audit.get("DEEPSEEK_API_KEY"):
        print("⚠️ --audit 需要 .env 里的 DEEPSEEK_API_KEY，本次抽检会被跳过")

    import torch
    from diffusers import AutoPipelineForText2Image

    if not torch.cuda.is_available():
        print("❌ CUDA 不可用（torch 是否装成 CPU 版？）")
        return 2
    free, total = torch.cuda.mem_get_info()
    free_gb, total_gb = free / 1024 ** 3, total / 1024 ** 3
    print(f"GPU={torch.cuda.get_device_name(0)} free={free_gb:.2f}GB / total={total_gb:.2f}GB")
    if free_gb < MIN_FREE_GB and not args.force_low_vram:
        print(
            f"❌ 空闲显存 {free_gb:.2f}GB < 需要的 {MIN_FREE_GB}GB。\n"
            "   sdxl-turbo@1024x576 峰值实测约 8.8GB，本机 VoxCPM TTS 侧车会占 10GB+。\n"
            "   方案（docs/roleplay-immersion-plan.md §2.3）：**与 VoxCPM 互斥**，\n"
            "   在低峰窗口停 TTS 侧车（含守护进程）再跑批，跑完恢复；或稍后重试（占用会波动）。\n"
            "   确认要硬跑可加 --force-low-vram。"
        )
        return 3

    if args.masters:
        # 主场景图：每部内置剧本一张（prompt 同样只由白名单表拼：地点 + 世界观基调）
        todo = [{"worldview": m["worldview"], "theme": f"master/{m['place']}", "file": m["file"], "prompt": m["prompt"]}
                for m in cfg.get("masters", [])]
        if not todo:
            print("❌ 配置里没有 masters（先跑 npx tsx scripts/export-scene-config.mts）")
            return 2
        if args.only:  # 抽检不合格时只重出指定剧本（按剧本 id 子串匹配）
            want = args.only
            todo = [r for r in todo if any(w in r["file"] for w in want)]
            if not todo:
                print("❌ --only 没匹配到任何剧本（应传剧本 id 子串，如 shenyanzhi-liuyang）")
                return 2
    else:
        todo = cfg["matrix"]
        if args.only:
            want = set(args.only)
            todo = [r for r in todo if f"{r['worldview']}:{r['theme']}" in want]
            if not todo:
                print("❌ --only 没匹配到任何组合")
                return 2
    if args.skip_existing:
        todo = [r for r in todo if not (out_dir / r["file"]).exists()]

    print(f"模型 {model_id} · {width}x{height} · {steps} 步 · CFG {guidance}{' · 带负向词' if use_negative else ''} · 待生成 {len(todo)} 张")
    t_load = time.perf_counter()
    pipe = AutoPipelineForText2Image.from_pretrained(model_id, torch_dtype=torch.float16, variant="fp16")
    pipe.set_progress_bar_config(disable=True)
    pipe.to("cuda")
    print(f"加载耗时 {time.perf_counter() - t_load:.1f}s")

    manifest_path = out_dir / "manifest.json"
    manifest = {"generatedAt": None, "model": model_id, "steps": steps, "guidance": guidance,
                "negative": NEGATIVE_PROMPT if use_negative else "", "width": width, "height": height,
                "style": cfg["styleSuffix"], "items": []}
    if manifest_path.exists():
        try:
            prev = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(prev.get("items"), list):
                manifest["items"] = [i for i in prev["items"] if i.get("file") not in {r["file"] for r in todo}]
        except Exception:
            pass

    ok = failed = 0
    for i, row in enumerate(todo, 1):
        name = f"{row['worldview']}-{row['theme']}"
        if args.masters:
            name = row["file"].replace(".webp", "")[:60]   # 主场景图用剧本 id 做种子名
        seed = (seed_for(name) + args.seed_offset) % (2 ** 31 - 1)
        target = out_dir / row["file"]
        t0 = time.perf_counter()
        try:
            torch.cuda.reset_peak_memory_stats()
            g = torch.Generator(device="cpu").manual_seed(seed)
            kwargs = dict(prompt=row["prompt"], num_inference_steps=steps, guidance_scale=guidance,
                          width=width, height=height, generator=g)
            if use_negative:
                # 每张图的负向词可由配置覆盖（户外场景会额外压制"室内房间名"）
                kwargs["negative_prompt"] = row.get("negative") or NEGATIVE_PROMPT
            img = pipe(**kwargs).images[0]
            img.save(target, format="WEBP", quality=args.quality, method=6)
            peak = torch.cuda.max_memory_allocated() / 1024 ** 3
            secs = time.perf_counter() - t0

            #。内置红线抽检：出现人物/文字就换 seed 重出（不靠 prompt 的运气）
            audit_info = {"checked": False}
            if args.audit:
                tries = 0
                while True:
                    a = audit_image(target, env_audit)
                    audit_info = {"checked": True, **a}
                    if a.get("error"):
                        print(f"    · 抽检跳过（{a['error']}）")
                        break
                    if not a.get("has_person") and not a.get("has_text"):
                        break
                    tries += 1
                    if tries > args.audit_retries:
                        print(f"    · 抽检仍不合格（person={a.get('has_person')} text={a.get('has_text')}），已达重试上限，保留并记录")
                        break
                    seed = (seed + 1) % (2 ** 31 - 1)
                    print(f"    · 抽检不合格（person={a.get('has_person')} text={a.get('has_text')}）→ 换 seed={seed} 重出（第 {tries} 次）")
                    g = torch.Generator(device="cpu").manual_seed(seed)
                    kwargs["generator"] = g
                    img = pipe(**kwargs).images[0]
                    img.save(target, format="WEBP", quality=args.quality, method=6)
                audit_info["retries"] = tries

            manifest["items"].append({
                "worldview": row["worldview"], "theme": row["theme"], "file": row["file"],
                "seed": seed, "prompt": row["prompt"], "bytes": target.stat().st_size,
                "seconds": round(secs, 2), "peak_vram_gb": round(peak, 2),
                "audit": audit_info,
            })
            ok += 1
            flag = ""
            if args.audit and audit_info.get("checked"):
                flag = " ✅红线OK" if not audit_info.get("has_person") and not audit_info.get("has_text") else " ⚠️红线仍不合格"
            print(f"[{i}/{len(todo)}] {name} {secs:.1f}s {target.stat().st_size // 1024}KB peak={peak:.1f}GB{flag}")
        except Exception as e:
            failed += 1
            print(f"[{i}/{len(todo)}] {name} ❌ {type(e).__name__}: {e}")

    manifest["generatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    manifest["items"].sort(key=lambda x: (x["worldview"], x["theme"]))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    total_mb = sum(i["bytes"] for i in manifest["items"]) / 1024 / 1024
    print(f"\n完成：成功 {ok} / 失败 {failed}；manifest 共 {len(manifest['items'])} 张、{total_mb:.1f}MB")
    print(f"产物目录：{out_dir}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
