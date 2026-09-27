#!/usr/bin/env python3
"""
小愈 · 服务端语音转文字（ASR）—— faster-whisper（CTranslate2）侧车服务
================================================
Node 后端 /api/asr 会把客户端的 16kHz 单声道 PCM16 base64 转发到这里，
由 faster-whisper 在本地 CPU（默认 int8）做转写，亚秒级返回 { text }。

相比 transformers.js 的 Whisper：速度大幅提升（本地 CPU 短语音约 0.3–1s），
仍免费、本地、无云成本；质量由模型决定（默认 small，可用 FASTER_WHISPER_MODEL 换 medium/large-v3）。

启动：
   set FASTER_WHISPER_MODEL=small
   set FASTER_WHISPER_PORT=8001
   python scripts/faster_whisper_server.py
"""
import base64
import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from faster_whisper import WhisperModel

MODEL = os.environ.get("FASTER_WHISPER_MODEL", "small")
DEVICE = os.environ.get("FASTER_WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("FASTER_WHISPER_COMPUTE", "int8")
PORT = int(os.environ.get("FASTER_WHISPER_PORT", "8001"))

# 缓存已加载的模型（首次启动会从 HuggingFace 下载 once，之后常驻内存）
_model = None


class AsrRequest(BaseModel):
    lang: str = "zh"
    audioBase64: str = ""


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        print(f"[whisper] loading model {MODEL} ({DEVICE}/{COMPUTE}) ...")
        _model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)
        print("[whisper] model ready")
    return _model


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 预热：启动即加载模型（后台），避免首请求等下载
    import asyncio
    asyncio.ensure_future(asyncio.to_thread(get_model))
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": _model is not None, "model": MODEL}


@app.post("/asr")
def asr(req: AsrRequest):
    if not req.audioBase64:
        raise HTTPException(400, "audio required")
    try:
        data = base64.b64decode(req.audioBase64)
    except Exception:
        raise HTTPException(400, "invalid audio")
    if len(data) < 2:
        raise HTTPException(400, "no audio")

    # PCM16 (little-endian) -> float32 (-1..1)
    pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0

    model = get_model()
    segments, _info = model.transcribe(
        pcm,
        language=req.lang or None,
        task="transcribe",
        beam_size=1,  # 贪心解码：快；质量略降，对短语音足够
        vad_filter=False,
    )
    text = "".join(seg.text for seg in segments).strip()
    return {"text": text}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
