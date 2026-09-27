# 小愈 · CosyVoice2 CPU 版 TTS 镜像（免 GPU passthrough）
# miniconda 建 Python 3.10 环境（pynini==2.1.5 只支持 py3.7–3.12）；pip 装 CPU 版 torch + 仓库全套推理依赖；
# 把本地已 clone（含 Matcha-TTS 子模块）的 CosyVoice 仓库与自研侧车拷进去，运行 FastAPI 侧车（端口 8002）。
FROM continuumio/miniconda3:latest

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg sox libsox-dev build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY third_party/CosyVoice /workspace/CosyVoice
WORKDIR /workspace/CosyVoice

# 建 py3.10 环境（CosyVoice 官方即 python3.10 + conda pynini）
RUN conda create -y -n cosyvoice python=3.10
RUN conda run -n cosyvoice conda install -y -c conda-forge pynini==2.1.5

# CPU 版 torch（避免 2.5GB CUDA 包）
RUN conda run -n cosyvoice pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# 装仓库 requirements.txt，但滤掉 GPU-only/torch/tensorrt/deepspeed/onnxruntime 与 UI-only(大)的 gradio 行；
# 其余全保留（含 HyperPyYAML/WeTextProcessing/openai-whisper 等），避免缺依赖。
# 注：新版 setuptools(>=81) 移除了 pkg_resources，openai-whisper 这类 sdist 构建会报 No module named 'pkg_resources'；
# 所以先把 setuptools 降到 <81，并用 --no-build-isolation 让构建走本环境（含 pkg_resources）。
RUN conda run -n cosyvoice python -c "import re,pathlib; src=pathlib.Path('requirements.txt').read_text(); drop=re.compile(r'(^--extra-index-url|deepspeed|onnxruntime|tensorrt|gradio|^torch==|^torchaudio==)'); lines=[l for l in src.splitlines() if l.strip() and not drop.search(l)]; pathlib.Path('/tmp/req.txt').write_text('\n'.join(lines))" \
    && conda run -n cosyvoice pip install --no-cache-dir "setuptools<81" wheel \
    && conda run -n cosyvoice pip install --no-cache-dir numpy==1.26.4 cython \
    && conda run -n cosyvoice pip install --no-cache-dir --no-build-isolation -i https://mirrors.aliyun.com/pypi/simple/ -r /tmp/req.txt \
    && conda run -n cosyvoice pip install --no-cache-dir onnxruntime \
    && conda run -n cosyvoice pip install --no-cache-dir --no-deps "triton>=3"

COPY scripts/cosyvoice_server.py /workspace/CosyVoice/cosyvoice_server.py
ENV COSYVOICE_MODEL_DIR=/workspace/pretrained_models/CosyVoice2-0.5B
ENV COSYVOICE_PORT=8002
ENV PYTHONPATH=/workspace/CosyVoice:/workspace/CosyVoice/third_party/Matcha-TTS
EXPOSE 8002
CMD ["conda", "run", "-n", "cosyvoice", "python", "cosyvoice_server.py"]
