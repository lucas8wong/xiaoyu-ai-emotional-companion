#!/usr/bin/env python3
"""
小愈 · 服务端语音合成（TTS）—— CosyVoice2 侧车服务
================================================
Node 后端 /api/tts 会优先转发到这里，由 CosyVoice2-0.5B 在本地 GPU 合成 **自然的年轻女声**（带停顿/语气），
比 msedge-tts 更拟人。侧车/模型不可用时，/api/tts 自动回退到 msedge-tts。

用法（默认预设女声「中文女」）：
   set COSYVOICE_MODEL_DIR=pretrained_models/CosyVoice2-0.5B
   set COSYVOICE_PORT=8002
   python scripts/cosyvoice_server.py

零样本克隆（可选，给一段目标女声参考音频即可模仿）：
   POST /tts { "text":"...", "voice_type":"zero_shot", "reference_audio":"<b64 wav>", "reference_text":"..." }
"""
import base64
import io
import os
from contextlib import asynccontextmanager

import numpy as np
import torchaudio
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_DIR = os.environ.get("COSYVOICE_MODEL_DIR", "pretrained_models/CosyVoice2-0.5B")
PORT = int(os.environ.get("COSYVOICE_PORT", "8002"))
DEFAULT_SPEAKER = os.environ.get("COSYVOICE_SPEAKER", "中文女")

_model = None


def get_model():
    global _model
    if _model is None:
        from cosyvoice.cli.cosyvoice import CosyVoice2
        from cosyvoice.utils.file_utils import load_wav
        print(f"[cosyvoice] loading {MODEL_DIR} ...")
        _model = CosyVoice2(MODEL_DIR, load_jit=False, load_trt=False, fp16=False)
        print("[cosyvoice] model ready")
    return _model


class TTSRequest(BaseModel):
    text: str
    lang: str = "zh"
    voice_type: str = "sft"           # sft=预设音色 | zero_shot=克隆
    speaker: str = DEFAULT_SPEAKER    # sft 预设（中文女/粤语女/英文女...）
    reference_audio: str = ""          # zero_shot: base64 的 16k wav（目标女声参考）
    reference_text: str = ""          # zero_shot: 参考音频对应的文字


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    asyncio.ensure_future(asyncio.to_thread(get_model))  # 预热，避免首请求等加载
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": _model is not None, "model": "CosyVoice2-0.5B"}


def _decode_wav(b64: str):
    from cosyvoice.utils.file_utils import load_wav
    import io as _io, numpy as _np
    raw = base64.b64decode(b64)
    # 写成临时 wav 再 load（CosyVoice load_wav 期望文件路径或可被 torchaudio 读的 buffer）
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(raw)
        path = f.name
    return load_wav(path, 16000)


def _audio_to_wav_bytes(tts_speech):
    """把 CosyVoice 的 tensor 合成结果编码为 WAV 字节（24k 单声道）。"""
    import io as _io
    sample_rate = get_model().sample_rate
    # tts_speech: tensor [1, N]；转成 numpy [-1,1]
    data = tts_speech.numpy() if hasattr(tts_speech, "numpy") else tts_speech
    data = data.reshape(-1)
    buf = _io.BytesIO()
    # 用 soundfile(libsndfile) 写 wav，绕开 torchaudio 2.11 默认走 torchcodec（需 CUDA libnvrtc，CPU 容器没有）
    import soundfile as _sf
    _sf.write(buf, np.asarray(data, dtype=np.float32), sample_rate, format='WAV')
    return buf.getvalue()


@app.post("/tts")
def tts(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(400, "text required")
    model = get_model()

    outs = []
    if req.voice_type == "zero_shot" and req.reference_audio:
        ref = _decode_wav(req.reference_audio)
        for j in model.inference_zero_shot(req.text, req.reference_text or "", ref, stream=False):
            outs.append(j)
    else:
        for j in model.inference_sft(req.text, req.speaker or DEFAULT_SPEAKER, stream=False):
            outs.append(j)

    if not outs:
        raise HTTPException(502, "no audio produced")

    # 拼接所有合成片段
    import torch
    speech = torch.cat([o["tts_speech"] for o in outs], dim=1)
    wav = _audio_to_wav_bytes(speech)
    return {"audioBase64": base64.b64encode(wav).decode(), "mime": "audio/wav"}


if __name__ == "__main__":
    import uvicorn
    # Docker 端口映射只能转发到容器接口(eth0)，绑 127.0.0.1 外部访问不到；默认 0.0.0.0（本地开发可设 COSYVOICE_HOST=127.0.0.1）。
    host = os.environ.get("COSYVOICE_HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=PORT)
