#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
剧情模式「场景插画」出图引擎实测脚本（spike · 只做测量，不改动任何产品代码）

要回答的问题只有一个：
  在这台机器的 RTX 5070 Ti 16GB 上，「按剧情出场景图」到底要等多久、吃多少显存、
  能不能和已经在跑的 VoxCPM(TTS) 侧车共存？

用法（建议在独立 venv `.venv-image` 里跑，别动生产用的 `.venv-voxcpm`）：
    python scripts/image_spike.py --list
    python scripts/image_spike.py --model sd-turbo
    python scripts/image_spike.py --model sd-turbo --steps 1,2,4 --size 512 --runs 3
    python scripts/image_spike.py --model sdxl-turbo --size 512,1024
    python scripts/image_spike.py --all            # 依次跑全部模型，单个失败不中断
    python scripts/image_spike.py --model sd-turbo --hf-mirror   # 大陆网络走 hf-mirror.com

产物：
    temp/image-spike/<model>-<size>-<steps>step[-rN].png   样图（第 1 张即 warmup 后的首张）
    temp/image-spike/result-<model>.json                   延迟/显存数据（机器可读，供方案文档引用）

口径说明（决定了数据能不能横向比较，改口径就等于改结论）：
- 计时 = wall time，**含 VAE 解码与 CPU→GPU 搬运**（不是纯 UNet 前向），因为用户等的是整张图；
- 每个 (size, steps) 组合先跑 1 次 warmup **不计入**，之后跑 --runs 次取中位数；
- 显存 = torch.cuda.max_memory_allocated() 峰值（每次生成前 reset），另打印整卡 free/total；
- VoxCPM 侧车是**独立进程**，它占的显存直接体现在整卡 free 里，所以「共存测试」
  就是在侧车开着的情况下跑本脚本，看还够不够、会不会 OOM。不要为了漂亮数字去停侧车。

⚠️ 一个会影响安全设计的事实（脚本会记录到 json 里）：
   turbo 类模型用 guidance_scale=0（无 CFG）时 **negative_prompt 不生效**，
   所以「靠负向词挡违规内容」在实时出图这条路上不成立，
   安全必须靠「正向白名单模板 + 出图后抽检」，见 docs/roleplay-immersion-plan.md §4.4。
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = ROOT / "temp" / "image-spike"

# 默认 prompt = 方案文档 §4.4「白名单视觉要素模板」的样例：**无人物环境图**。
# 共享图库走这条口径（安全、可复用、风格统一）；人物图只留给后续个人化实时出图。
DEFAULT_PROMPT = (
    "soft cinematic illustration, warm low-saturation palette, "
    "a modern apartment interior beside a floor-to-ceiling window, dusk, "
    "light rain outside the glass, quiet and tender mood, "
    "medium shot slightly from the side, environment only, empty room, "
    "no people, no text, no watermark"
)
DEFAULT_NEGATIVE = (
    "people, person, face, portrait, child, teenager, nude, nsfw, gore, blood, "
    "weapon, text, watermark, signature, logo, extra limbs, deformed"
)

# 每个模型的加载/调用差异都放在这里，主流程不分叉。
MODELS: dict[str, dict] = {
    "sd-turbo": {
        "id": "stabilityai/sd-turbo",
        "dtype": "fp16",
        "variant": "fp16",
        "guidance": 0.0,
        "steps": [1, 2, 4],
        "sizes": [512],
        "note": "最小最快（SD2.1 底模 / 512px），用来看延迟下界",
    },
    "sdxl-turbo": {
        "id": "stabilityai/sdxl-turbo",
        "dtype": "fp16",
        "variant": "fp16",
        "guidance": 0.0,
        "steps": [1, 2, 4],
        "sizes": [512, 1024],
        "note": "1024px 画质可用档，显存约 7GB",
    },
    "z-image-turbo": {
        "id": "Tongyi-MAI/Z-Image-Turbo",
        "dtype": "bfloat16",
        "variant": None,
        "guidance": 0.0,
        "steps": [4, 8],
        "sizes": [1024],
        "note": "6B / 中文提示词友好（待确认 diffusers 是否已支持，失败即跳过）",
    },
    "flux-schnell": {
        "id": "black-forest-labs/FLUX.1-schnell",
        "dtype": "bfloat16",
        "variant": None,
        "guidance": 0.0,
        "steps": [4],
        "sizes": [1024],
        "offload": True,  # bf16 约 24GB > 16GB，只能 CPU offload（慢，用来证明"不可实时"）
        "note": "画质参考档；16GB 需量化（fp8/GGUF）才谈得上实时",
    },
}

DTYPES = {"fp16": "float16", "bf16": "bfloat16", "fp32": "float32"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="剧情场景插画出图引擎实测（RTX 5070 Ti 16GB）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--model", default="sd-turbo", choices=sorted(MODELS))
    p.add_argument("--all", action="store_true", help="依次跑全部模型（失败即记 error 继续）")
    p.add_argument("--steps", default="", help="覆盖步数，如 1,2,4")
    p.add_argument("--size", default="", help="覆盖分辨率，如 512 或 512,1024")
    p.add_argument("--runs", type=int, default=3, help="每个组合的计时次数（不含 warmup，取中位数）")
    p.add_argument("--seed", type=int, default=20260914)
    p.add_argument("--prompt", default=DEFAULT_PROMPT)
    p.add_argument("--negative", default=DEFAULT_NEGATIVE)
    p.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    p.add_argument("--hf-mirror", action="store_true", help="设 HF_ENDPOINT=https://hf-mirror.com")
    p.add_argument("--low-vram", action="store_true", help="开 attention/vae slicing（降显存、加时间）")
    p.add_argument("--list", action="store_true", help="只列出内置模型配置")
    return p.parse_args()


def vram_snapshot() -> dict:
    """整卡 free/total + 本进程峰值。没有 CUDA 就返回 available=False。"""
    try:
        import torch
    except Exception as e:  # torch 没装
        return {"available": False, "error": str(e)}
    if not torch.cuda.is_available():
        return {"available": False, "error": "torch.cuda.is_available() == False"}
    free, total = torch.cuda.mem_get_info()
    snap = {
        "available": True,
        "device": torch.cuda.get_device_name(0),
        "free_gb": round(free / 1024 ** 3, 2),
        "total_gb": round(total / 1024 ** 3, 2),
        "used_gb": round((total - free) / 1024 ** 3, 2),
    }
    try:
        snap["proc_peak_alloc_gb"] = round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2)
        snap["proc_peak_reserved_gb"] = round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2)
    except Exception:
        pass
    return snap


def load_pipe(torch, spec: dict, low_vram: bool):
    """按 model_index.json 自动解析管线类（比写死 AutoPipelineForText2Image 更抗模型差异）。"""
    from diffusers import DiffusionPipeline

    dtype = getattr(torch, DTYPES[spec["dtype"]])
    kwargs = {"torch_dtype": dtype}
    if spec.get("variant"):
        kwargs["variant"] = spec["variant"]
    try:
        pipe = DiffusionPipeline.from_pretrained(spec["id"], **kwargs)
    except Exception as e:
        if "variant" not in kwargs:
            raise
        print(f"   ↳ variant={kwargs['variant']} 不可用（{type(e).__name__}），去掉 variant 重试")
        kwargs.pop("variant", None)
        pipe = DiffusionPipeline.from_pretrained(spec["id"], **kwargs)

    pipe.set_progress_bar_config(disable=True)
    if spec.get("offload"):
        pipe.enable_model_cpu_offload()
        print("   ↳ enable_model_cpu_offload()（显存不够，用 CPU offload 换时间）")
    else:
        pipe.to("cuda")
    if low_vram:
        pipe.enable_attention_slicing()
        try:
            pipe.enable_vae_slicing()
        except Exception:
            pass
    return pipe


def generate_once(torch, pipe, prompt: str, negative: str, size: int, steps: int,
                  guidance: float, seed: int):
    """跑一次并返回 (PIL 图, 秒)。含 VAE 解码，口径与用户等待一致。"""
    params = inspect.signature(pipe.__call__).parameters
    call_kwargs: dict = {
        "prompt": prompt,
        "num_inference_steps": steps,
        "height": size,
        "width": size,
        "generator": torch.Generator(device="cpu").manual_seed(seed),
    }
    if "guidance_scale" in params:
        call_kwargs["guidance_scale"] = guidance
    # guidance=0（无 CFG）时负向词不参与计算；只有真开 CFG 才传，避免"以为挡了其实没挡"
    if guidance and guidance > 1.0 and "negative_prompt" in params:
        call_kwargs["negative_prompt"] = negative

    torch.cuda.synchronize()
    t0 = time.perf_counter()
    out = pipe(**call_kwargs)
    torch.cuda.synchronize()
    return out.images[0], time.perf_counter() - t0


def run_model(torch, name: str, spec: dict, args, out_dir: Path) -> dict:
    result: dict = {
        "model": name,
        "repo_id": spec["id"],
        "dtype": spec["dtype"],
        "note": spec["note"],
        "prompt": args.prompt,
        "negative_prompt_used": False,
        "negative_prompt_skipped_reason": None,
        "guidance_scale": spec["guidance"],
        "warmup_excluded": True,
        "runs_per_combo": args.runs,
        "measurements": [],
    }
    sizes = [int(x) for x in args.size.split(",")] if args.size else list(spec["sizes"])
    steps_list = [int(x) for x in args.steps.split(",")] if args.steps else list(spec["steps"])

    vram_before = vram_snapshot()
    result["vram_before_load"] = vram_before
    print(f"\n=== {name} ({spec['id']}) ===")
    print(f"   加载前整卡：free={vram_before.get('free_gb')}GB / total={vram_before.get('total_gb')}GB"
          f"（VoxCPM 侧车若在跑，它的占用已体现在这里）")

    t_load = time.perf_counter()
    pipe = load_pipe(torch, spec, args.low_vram)
    result["load_seconds"] = round(time.perf_counter() - t_load, 2)
    result["vram_after_load"] = vram_snapshot()
    print(f"   加载耗时 {result['load_seconds']}s；加载后 free={result['vram_after_load'].get('free_gb')}GB")

    for size in sizes:
        for steps in steps_list:
            combo = f"{size}px/{steps}step"
            try:
                torch.cuda.reset_peak_memory_stats()
                # warmup：首次包含 kernel 编译/显存池扩张，不计入
                _, warm_s = generate_once(torch, pipe, args.prompt, args.negative,
                                          size, steps, spec["guidance"], args.seed)
                times: list[float] = []
                last_img = None
                for i in range(max(1, args.runs)):
                    img, sec = generate_once(torch, pipe, args.prompt, args.negative,
                                             size, steps, spec["guidance"], args.seed + i + 1)
                    times.append(sec)
                    last_img = img
                    last_img.save(out_dir / f"{name}-{size}-{steps}step-r{i + 1}.png")
                peak = vram_snapshot()
                entry = {
                    "size": size,
                    "steps": steps,
                    "combo": combo,
                    "warmup_seconds": round(warm_s, 2),
                    "runs_seconds": [round(t, 2) for t in times],
                    "median_seconds": round(statistics.median(times), 2),
                    "min_seconds": round(min(times), 2),
                    "peak_alloc_gb": peak.get("proc_peak_alloc_gb"),
                    "peak_reserved_gb": peak.get("proc_peak_reserved_gb"),
                    "free_gb_after": peak.get("free_gb"),
                }
                result["measurements"].append(entry)
                print(f"   {combo}: 中位 {entry['median_seconds']}s"
                      f"（warmup {entry['warmup_seconds']}s）"
                      f" 峰值显存 {entry['peak_alloc_gb']}GB / 整卡剩余 {entry['free_gb_after']}GB")
            except Exception as e:
                result["measurements"].append({
                    "combo": combo, "size": size, "steps": steps,
                    "error": f"{type(e).__name__}: {e}",
                })
                print(f"   {combo}: 失败 → {type(e).__name__}: {e}")

    if "negative_prompt" not in inspect.signature(pipe.__call__).parameters:
        result["negative_prompt_skipped_reason"] = "该管线不支持 negative_prompt"
    elif not (spec["guidance"] and spec["guidance"] > 1.0):
        result["negative_prompt_skipped_reason"] = "guidance_scale=0（无 CFG），负向词不参与计算"
    else:
        result["negative_prompt_used"] = True

    del pipe
    try:
        torch.cuda.empty_cache()
    except Exception:
        pass
    result["vram_after_unload"] = vram_snapshot()
    return result


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.hf_mirror and not os.environ.get("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
    print(f"HF_ENDPOINT={os.environ.get('HF_ENDPOINT') or '(默认 huggingface.co)'}")

    if args.list:
        for k, v in MODELS.items():
            print(f"{k:16s} {v['id']:34s} {v['dtype']:7s} steps={v['steps']} sizes={v['sizes']}  {v['note']}")
        return 0

    import torch  # 放在后面：--list 不需要 torch

    print(f"torch={torch.__version__} cuda_available={torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"device={torch.cuda.get_device_name(0)} "
              f"capability={'.'.join(map(str, torch.cuda.get_device_capability(0)))}")

    names = sorted(MODELS) if args.all else [args.model]
    summary = {
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "hf_endpoint": os.environ.get("HF_ENDPOINT") or "https://huggingface.co",
        "runs_per_combo": args.runs,
        "vram_at_start": vram_snapshot(),
        "models": [],
    }

    for name in names:
        spec = MODELS[name]
        try:
            res = run_model(torch, name, spec, args, out_dir)
        except Exception as e:
            res = {"model": name, "repo_id": spec["id"], "note": spec["note"],
                   "fatal_error": f"{type(e).__name__}: {e}"}
            print(f"\n=== {name} 无法加载 → {type(e).__name__}: {e}")
            if isinstance(e, MemoryError) or "out of memory" in str(e).lower():
                print("   ↳ 显存不足：记录为不可用（这正是要测的结论之一）")
        summary["models"].append(res)
        with open(out_dir / f"result-{name}.json", "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)

    summary["finished_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(out_dir / "summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n----- 汇总（中位秒数 / 峰值显存） -----")
    for m in summary["models"]:
        if m.get("fatal_error"):
            print(f"{m['model']:16s} 不可用: {m['fatal_error'][:70]}")
            continue
        for e in m.get("measurements", []):
            if e.get("error"):
                print(f"{m['model']:16s} {e['combo']:12s} 失败: {e['error'][:60]}")
            else:
                print(f"{m['model']:16s} {e['combo']:12s} {e['median_seconds']:6.2f}s  "
                      f"峰值 {e['peak_alloc_gb']}GB")
    print(f"\n产物目录：{out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
