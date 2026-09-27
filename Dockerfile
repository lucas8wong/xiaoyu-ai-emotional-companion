# 小愈（Xiaoyu）阶段1上云镜像
# 说明：
#  - 用 Debian/glibc 基础镜像（node:20-slim），因为 onnxruntime-node 需要 glibc（alpine/musl 会跑不了 embedding）。
#  - 构建时：安装依赖 → 编译前端 dist → 预下载本地 embedding 模型（离线可用）。
#  - 运行时：挂载 /app/data 持久卷（存放所有用户记忆/账号/会话），.env 用环境变量或挂载文件注入（勿打进镜像）。
FROM node:20-slim AS runtime
WORKDIR /app

# 系统依赖（sharp/onnxruntime-node/msedge-tts 等可能需要；最小化但保留常用）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 依赖（含 devDeps：tsx/cross-env/vite 用于构建与运行）
COPY package.json package-lock.json ./
RUN npm ci

# 源码 + 配置
COPY . .

# 编译前端（vite build → dist/）
RUN npm run build:prod

# 预下载本地 embedding 模型（离线可用，写入缓存目录，不随数据卷/不含敏感信息）
ENV TRANSFORMERS_CACHE=/app/.cache/transformers
RUN node -e "import('@huggingface/transformers').then(async ({pipeline})=>{const e=await pipeline('feature-extraction','Xenova/paraphrase-multilingual-MiniLM-L12-v2');await e('小愈',{pooling:'mean',normalize:true});console.log('embedding model ready (offline)');}).catch(e=>{console.error('embedding model preload failed:',e.message);process.exit(0);})"

# 预先下载本地语音识别 Whisper 模型（离线可用；与 embedding 同一缓存目录）。
# 默认 whisper-large-v3-turbo（质量最高）；要省资源可改 ASR_WHISPER_MODEL 并同步预下载对应模型。
RUN node -e "import('@huggingface/transformers').then(async ({pipeline})=>{const a=await pipeline('automatic-speech-recognition','onnx-community/whisper-large-v3-turbo');await a(new Float32Array(16000),{language:'zh',task:'transcribe'});console.log('asr whisper model ready (offline)');}).catch(e=>{console.error('asr whisper model preload failed:',e.message);process.exit(0);})"

ENV NODE_ENV=production
EXPOSE 3001

# 以挂载的 /app/data 作为持久数据目录（见 docker-compose.yml / 部署文档）
CMD ["npm", "run", "start:prod"]
