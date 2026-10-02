#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
剧情「按需出图」GPU 侧车（端口 8004），docs/roleplay-immersion-plan.md §4.5（S5）

职责边界（很重要，别越界）：
- 本侧车**只接受白名单枚举**（worldview / theme / seed / 尺寸），**不接受自由文本 prompt**。
  拼 prompt 由 `api/services/sceneArt.ts` 依据 `src/lib/storyScene.ts` 的表完成，
  这是方案 §4.4 的红线：**用户文本绝不能直接进图像模型**（自建剧本 = prompt injection 通道）。
- 本侧车不做内容判定；出图后的抽检由服务端/离线流程负责（见 temp/qa-scene-art.mjs 与方案 §4.4）。

运行（必须用 `.venv-image`，别用生产 TTS 的 `.venv-voxcpm`）：
    .venv-image\\Scripts\\python.exe scripts\\image_server.py
环境变量：
    SCENE_ART_PORT      默认 8004
    SCENE_ART_IDLE_UNLOAD_S  默认 0（=常驻）。>0 时闲置该秒数后卸载模型释放显存（与 VoxCPM 争卡时的解法）
    SCENE_ART_MIN_FREE_GB    出图前要求的最小空闲显存，默认 10.5（不足直接 503，让上层降级到共享图库）

接口：
    GET  /health              → {ok, model, cuda, loaded, freeGb}
    POST /generate            → {worldview, theme, seed?, width?, height?} → {webpBase64, seconds, peakGb, seed}
"""
from __future__ import annotations

import base64
import io
import os
import sys
import threading
import time
import zlib
from typing import Optional

try:  # Windows 控制台默认 GBK，emoji 会崩
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_ID = os.environ.get("SCENE_ART_MODEL", "stabilityai/sdxl-turbo")
PORT = int(os.environ.get("SCENE_ART_PORT", "8004"))
IDLE_UNLOAD_S = float(os.environ.get("SCENE_ART_IDLE_UNLOAD_S", "0"))
MIN_FREE_GB = float(os.environ.get("SCENE_ART_MIN_FREE_GB", "10.5"))
STEPS = int(os.environ.get("SCENE_ART_STEPS", "4"))
# CFG 强度。默认 0.0 = sdxl-turbo 的原生用法（此时 diffusers 会**忽略 negative_prompt**）。
# 换成完整 SDXL（stabilityai/stable-diffusion-xl-base-1.0）时把它设成 ~6.5，负向词才真正生效。
GUIDANCE = float(os.environ.get("SCENE_ART_GUIDANCE", "0.0"))

app = FastAPI()
_lock = threading.Lock()          # 单卡并发=1：后到者排队，不并发抢显存
_pipe = None
_last_used = 0.0
_load_error: Optional[str] = None


def _torch():
    import torch
    return torch


def _free_gb() -> float:
    try:
        torch = _torch()
        if not torch.cuda.is_available():
            return 0.0
        free, _total = torch.cuda.mem_get_info()
        return free / 1024 ** 3
    except Exception:
        return 0.0


def _unload() -> None:
    global _pipe
    if _pipe is None:
        return
    try:
        del _pipe
        _pipe = None
        _torch().cuda.empty_cache()
        print("[scene-art] model unloaded", flush=True)
    except Exception as e:
        print("[scene-art] unload failed:", e, flush=True)


def _maybe_idle_unload() -> None:
    """闲置卸载：与 VoxCPM TTS 争同一张卡时，用它把显存还回去（默认关闭=常驻）"""
    global _pipe
    if IDLE_UNLOAD_S <= 0 or _pipe is None:
        return
    if time.time() - _last_used > IDLE_UNLOAD_S:
        _unload()


def get_pipe():
    """懒加载（首次调用约 11s；之后常驻）"""
    global _pipe, _load_error
    if _pipe is not None:
        return _pipe
    free = _free_gb()
    if free < MIN_FREE_GB:
        raise HTTPException(503, f"显存不足：空闲 {free:.1f}GB < 需要 {MIN_FREE_GB}GB（需与 VoxCPM 互斥或稍后重试）")
    try:
        from diffusers import AutoPipelineForText2Image
        torch = _torch()
        print(f"[scene-art] loading {MODEL_ID} (free {free:.1f}GB) ...", flush=True)
        t0 = time.perf_counter()
        # 社区底模（国风系等）常是**单文件 .safetensors**（不是 diffusers 目录，没有 model_index.json），
        # 这种必须走 from_single_file；否则 from_pretrained 会直接报缺 model_index.json。
        if MODEL_ID.lower().endswith((".safetensors", ".ckpt")) or os.path.isfile(MODEL_ID):
            # ⚠️ from_single_file 只在**具体 pipeline 类**上（AutoPipelineForText2Image 没有这个方法，实测报
            # AttributeError）。先按 SD1.5 试，失败再按 SDXL 试，两种单文件 checkpoint 都能覆盖。
            from diffusers import StableDiffusionPipeline, StableDiffusionXLPipeline
            try:
                pipe = StableDiffusionPipeline.from_single_file(MODEL_ID, torch_dtype=torch.float16)
            except Exception as e1:
                print(f"[scene-art] SD1.5 single-file load failed ({type(e1).__name__}), trying SDXL", flush=True)
                pipe = StableDiffusionXLPipeline.from_single_file(MODEL_ID, torch_dtype=torch.float16)
        else:
          try:
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, torch_dtype=torch.float16, variant="fp16")
          except Exception as e:
            # 很多社区底模（如国风系）没有 fp16 variant 文件，直接再试一次不带 variant。
            # 不这么兜的话换底模会以 "no variant fp16" 直接加载失败。
            print(f"[scene-art] variant=fp16 unavailable ({type(e).__name__}), retrying without it", flush=True)
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, torch_dtype=torch.float16)
        pipe.set_progress_bar_config(disable=True)
        pipe.to("cuda")
        print(f"[scene-art] ready in {time.perf_counter() - t0:.1f}s", flush=True)
        _pipe = pipe
        _load_error = None
        return _pipe
    except HTTPException:
        raise
    except Exception as e:
        _load_error = f"{type(e).__name__}: {e}"
        print("[scene-art] load failed:", _load_error, flush=True)
        raise HTTPException(500, f"模型加载失败：{_load_error}")


class GenRequest(BaseModel):
    # 只允许白名单枚举；prompt 由服务端按表拼，侧车不收自由文本
    worldview: str
    theme: str
    prompt: str                      # 服务端拼好的 prompt（来自白名单表，非用户文本）
    seed: Optional[int] = None
    width: int = 1024
    height: int = 576
    # 负向词（可选）。**只在 guidance > 1 时被使用**，guidance = 0 时 diffusers 会忽略它，
    # 所以老调用方（sceneArt.ts 不带该字段）行为一字不变。
    negative: Optional[str] = None


@app.get("/health")
def health():
    _maybe_idle_unload()
    return {
        "ok": True, "model": MODEL_ID, "cuda": _torch().cuda.is_available(),
        "loaded": _pipe is not None, "freeGb": round(_free_gb(), 2), "loadError": _load_error,
        # 回显闲置卸载配置，便于确认环境变量真的生效（默认 0=常驻；生产建议设 300）
        "idleUnloadS": IDLE_UNLOAD_S, "minFreeGb": MIN_FREE_GB,
    }


@app.post("/generate")
def generate(req: GenRequest):
    global _last_used
    torch = _torch()
    if not torch.cuda.is_available():
        raise HTTPException(503, "CUDA 不可用")
    with _lock:  # 串行：单卡只跑一个生成
        _last_used = time.time()
        pipe = get_pipe()
        seed = req.seed if req.seed is not None else (zlib.crc32(f"{req.worldview}-{req.theme}".encode()) % (2 ** 31 - 1))
        t0 = time.perf_counter()
        torch.cuda.reset_peak_memory_stats()
        g = torch.Generator(device="cpu").manual_seed(int(seed))
        kwargs = dict(prompt=req.prompt.strip()[:400], num_inference_steps=STEPS, guidance_scale=GUIDANCE,
                      width=req.width, height=req.height, generator=g)
        if GUIDANCE > 1.0 and req.negative:
            kwargs["negative_prompt"] = req.negative[:300]
        img = pipe(**kwargs).images[0]
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=82, method=6)
        secs = time.perf_counter() - t0
        peak = torch.cuda.max_memory_allocated() / 1024 ** 3
        _last_used = time.time()
        print(f"[scene-art] {req.worldview}:{req.theme} {secs:.2f}s peak={peak:.1f}GB seed={seed}", flush=True)
        return {
            "webpBase64": base64.b64encode(buf.getvalue()).decode("ascii"),
            "seconds": round(secs, 2), "peakGb": round(peak, 2), "seed": int(seed),
        }


if __name__ == "__main__":
    import uvicorn
    print(f"[scene-art] serving on :{PORT} model={MODEL_ID} idleUnload={IDLE_UNLOAD_S}s", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
