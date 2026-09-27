#!/usr/bin/env python3
"""
小愈 · VoxCPM2 服务端语音合成（TTS）侧车（GPU）
================================================
用 OpenBMB VoxCPM2-2B（无 tokenizer、可音色设计/克隆、48kHz）合成自然人声，
比 CosyVoice/msedge 更拟人、能通过文本前缀做「音色/语气」设计。
Node 后端 /api/tts 可把请求转发到这里（VoxCPM 侧车）；失败可回退 CosyVoice/msedge。

用法：
   set VOXCPM_MODEL_DIR=D:\\deepseek_harness\\角色扮演-情绪\\voxcpm_model
   set VOXCPM_PORT=8003
   python scripts/voxcpm_server.py
"""
import base64
import hashlib
import io
import json
import os
import numpy as np
import soundfile as sf
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import asyncio

MODEL_DIR = os.environ.get("VOXCPM_MODEL_DIR", "D:/deepseek_harness/角色扮演-情绪/voxcpm_model")
PORT = int(os.environ.get("VOXCPM_PORT", "8003"))
# 默认音色设计：年轻温暖女声（成年，"角色声"，一致性优先）；可经 VOXCPM_VOICE 覆盖
DEFAULT_VOICE = os.environ.get("VOXCPM_VOICE", "(young adult female voice, warm and clear tone, moderate pace)")
# 音色克隆参考（小愈"专属声"）：用 CosyVoice 自然中文女声作为克隆参考，长文本也不退化。
# 设置后 /tts 优先走克隆（忽略文本音色设计前缀）。可用 VOXCPM_REFERENCE_WAV/TEXT 覆盖。
REFERENCE_WAV = os.environ.get("VOXCPM_REFERENCE_WAV", "D:/deepseek_harness/角色扮演-情绪/third_party/CosyVoice/asset/zero_shot_prompt.wav").strip()
REFERENCE_TEXT = os.environ.get("VOXCPM_REFERENCE_TEXT", "希望你以后能够做的比我还好呦。").strip()
# 🎙️ 音色参考库（方案②"自举参考音频"，2026-09-15）：
#   每个预设一个参考音频 `third_party/voice-refs/{name}.wav`，**并配一份同名 .txt 文字稿**。
#   ⚠️ 文字稿必须与音频内容一致 —— 实测不一致时（用写死的全局 REFERENCE_TEXT 配新音频）
#   模型会输出被截断的垃圾（51 字的一句话只出 0.80 秒）。
#   请求里传 `reference: "<name>"`（**只接受参考库里的名字**，不接受任意路径）即走克隆。
REFERENCE_DIR = os.environ.get("VOXCPM_REFERENCE_DIR", "D:/deepseek_harness/角色扮演-情绪/third_party/voice-refs").strip()


def _resolve_reference(req: "TTSRequest") -> tuple[str, str]:
    """把请求里的 reference 解析成 (音频路径, 对应文字稿)。
    支持：① 参考库名字（推荐，如 "gentle-f"）② 直接给的绝对路径（调试用，文字稿取全局）。"""
    raw = (getattr(req, "reference", "") or "").strip()
    if raw and not os.path.isabs(raw) and "/" not in raw and "\\" not in raw:
        wav = os.path.join(REFERENCE_DIR, raw + ".wav")
        if not os.path.exists(wav):
            raise HTTPException(400, f"reference not found: {raw}")
        txt_path = os.path.join(REFERENCE_DIR, raw + ".txt")
        txt = open(txt_path, encoding="utf-8").read().strip() if os.path.exists(txt_path) else REFERENCE_TEXT
        return wav, txt
    return raw, REFERENCE_TEXT


def _clone_kwargs(eng, req: "TTSRequest"):
    """返回 generate 的克隆参数；无参考则返回空 dict（用文本音色设计）。"""
    ref = (getattr(req, "reference", "") or REFERENCE_WAV or "").strip()
    if not ref:
        return {}
    wav_path, txt = _resolve_reference(req) if getattr(req, "reference", "") else (ref, REFERENCE_TEXT)
    kw = {"prompt_wav_path": wav_path}
    if txt.strip():
        kw["prompt_text"] = txt
    return kw


def _seed_for(voice: str, text: str) -> int:
    """稳定的 seed：同一(音色,文本)永远生成一致音频，解决"两次读差别很大"。
    不同文本用不同 seed（保留自然变化），但同一条消息每次读都一致。"""
    h = hashlib.sha256(f"{voice}|{text}".encode("utf-8")).hexdigest()
    return int(h[:16], 16)


def _fix_seed(voice: str, text: str) -> None:
    try:
        import torch
        torch.manual_seed(_seed_for(voice, text))
    except Exception:
        pass

_eng = None
_model = None


def get_model():
    global _eng, _model
    if _eng is not None:
        return _eng
    from voxcpm import VoxCPM
    print(f"[voxcpm] loading {MODEL_DIR} on cuda={_cuda()} ...", flush=True)
    _eng = VoxCPM.from_pretrained(MODEL_DIR, load_denoiser=False)
    try:
        _model = _eng.tts_model
        print(f"[voxcpm] model ready sr={getattr(_model, 'sample_rate', None)}", flush=True)
    except Exception as e:
        print(f"[voxcpm] tts_model note: {e}", flush=True)
    return _eng


def _cuda():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.ensure_future(asyncio.to_thread(get_model))  # 预热
    yield


app = FastAPI(lifespan=lifespan)


class TTSRequest(BaseModel):
    text: str
    voice: str = ""           # 可选的音色/语气前缀，覆盖默认
    reference: str = ""       # 音色克隆参考 wav 路径；设置后优先克隆
    cfg_value: float = 2.0
    inference_timesteps: int = 6   # 默认 6（比 10 快近一半，聊天响应更跟手）；需要更高保真可调 10


@app.get("/health")
def health():
    return {"ok": _eng is not None, "model": "VoxCPM2-2B", "cuda": _cuda()}


@app.post("/tts")
def tts(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(400, "text required")
    eng = get_model()
    voice_clause = (req.voice or "").strip()
    # 显式给了 reference（参考库名字/路径）→ **优先克隆**（方案②：每个预设克隆自己的参考音频，
    # 既有各自音色、又是自然语速）。没给 reference 时保持原行为：
    #   传了 voice 串 = 文本音色设计；没传 = 克隆默认参考（"专属声"）。
    explicit_ref = (getattr(req, "reference", "") or "").strip()
    use_clone = bool(explicit_ref) or (bool(REFERENCE_WAV) and not voice_clause)
    if use_clone:
        full_text = req.text
        _fix_seed(REFERENCE_WAV or (getattr(req, "reference", "") or ""), req.text)
        gen_kw = {**_clone_kwargs(eng, req), "cfg_value": req.cfg_value, "inference_timesteps": req.inference_timesteps}
    else:
        v = voice_clause or DEFAULT_VOICE
        full_text = f"{v} {req.text}" if v else req.text
        _fix_seed(v, req.text)
        gen_kw = {"cfg_value": req.cfg_value, "inference_timesteps": req.inference_timesteps}
    try:
        wav = eng.generate(text=full_text, **gen_kw)
        sr = int(getattr(getattr(eng, "tts_model", None), "sample_rate", 48000))
    except Exception as e:
        print(f"[voxcpm] generation failed: {e}", flush=True)
        raise HTTPException(502, f"voxcpm generation failed")
    wav = np.asarray(wav, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV")
    return {"audioBase64": base64.b64encode(buf.getvalue()).decode(), "mime": "audio/wav"}


@app.post("/tts/stream")
def tts_stream(req: TTSRequest):
    """流式合成：用 VoxCPM generate_streaming 逐块输出 PCM，SSE 逐帧下发（前端渐进播放）。"""
    if not req.text.strip():
        raise HTTPException(400, "text required")
    eng = get_model()
    voice_clause = (req.voice or DEFAULT_VOICE).strip()
    full_text = f"{voice_clause} {req.text}" if voice_clause else req.text
    sr = int(getattr(getattr(eng, "tts_model", None), "sample_rate", 48000))

    def gen():
        try:
            _fix_seed(voice_clause, req.text)
            for chunk in eng.generate_streaming(text=full_text, cfg_value=req.cfg_value, inference_timesteps=req.inference_timesteps):
                arr = np.asarray(chunk, dtype=np.float32).reshape(-1)
                pcm = (np.clip(arr, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
                yield f"data: {json.dumps({'pcm': base64.b64encode(pcm).decode(), 'sr': sr})}\n\n"
            yield "data: " + json.dumps({"done": True}) + "\n\n"
        except Exception as e:
            print(f"[voxcpm] stream error: {e}", flush=True)
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("VOXCPM_HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=PORT)
