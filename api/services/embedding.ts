/**
 * 本地 embedding（transformers.js + 多语言 MiniLM，离线、无 API Key）
 * 用于「全量可召回」：对记忆做语义检索，按相关度取 top-K，而不是只取最近几条。
 * 模型首次使用会加载并缓存到本地（transformers.js 缓存目录），之后离线可用。
 * 若模型加载失败，所有调用返回 null，调用方回退到「最近窗口」逻辑，不报错。
 */

import { pipeline, env } from '@huggingface/transformers';

// 支持外部指定模型缓存目录（Docker 里烤进镜像，离线可用）
if (process.env.TRANSFORMERS_CACHE) {
  env.cacheDir = process.env.TRANSFORMERS_CACHE;
}

// 多语言句向量模型（支持中英），输出 384 维，归一化后可直接点积作余弦
const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

let extractorPromise: Promise<any> | null = null;
function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL)
      .then((ex) => { extractorReady = true; return ex; })
      .catch((e) => {
        extractorPromise = null;
        throw e;
      });
  }
  return extractorPromise;
}

// 文本 → 向量缓存（跨请求复用，避免重复推理）
const cache = new Map<string, number[]>();
export function clearEmbeddingCache(): void { cache.clear(); }

let extractorReady = false;
/** 是否已就绪（模型加载完成）；用于冷启动时快速回退，避免每次 prompt 都等加载 */
export function isEmbeddingReady(): boolean { return extractorReady; }

/** 预热：启动时调用（fire-and-forget），首次加载模型并返回是否就绪 */
export async function ensureEmbeddingReady(): Promise<boolean> {
  try {
    const ex = await getExtractor();
    // 触发一次最小推理，确保模型真正可用
    await ex('小愈', { pooling: 'mean', normalize: true } as any);
    extractorReady = true;
    return true;
  } catch {
    extractorReady = false;
    return false;
  }
}

/** 归一化余弦（向量已归一化时即为点积） */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot >= 1 ? 1 : dot <= -1 ? -1 : dot;
}

/** 嵌入单个文本；失败返回 null */
export async function embedOne(text: string): Promise<number[] | null> {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  const hit = cache.get(t);
  if (hit) return hit;
  try {
    const extractor = await getExtractor();
    const out = await extractor(t, { pooling: 'mean', normalize: true } as any);
    const vec = Array.from(out.data as Float32Array);
    cache.set(t, vec);
    return vec;
  } catch {
    return null;
  }
}

/** 批量嵌入（一次推理多个文本，更快）；返回与输入等长的向量数组（失败项为 null） */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (!texts || texts.length === 0) return [];
  const result: (number[] | null)[] = new Array(texts.length).fill(null);
  const missingIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = (texts[i] || '').trim();
    if (!t) continue;
    const hit = cache.get(t);
    if (hit) result[i] = hit;
    else missingIdx.push(i);
  }
  if (missingIdx.length === 0) return result;
  try {
    const extractor = await getExtractor();
    const batchTexts = missingIdx.map(i => texts[i].trim());
    const out = await extractor(batchTexts, { pooling: 'mean', normalize: true } as any);
    // out 为 [N, dim] 的 Tensor
    const rows = (out.tolist ? out.tolist() : null) as number[][] | null;
    for (let k = 0; k < missingIdx.length; k++) {
      const vec = rows && rows[k] ? rows[k] : (out.data ? Array.from((out.data as Float32Array).slice(k * 384, (k + 1) * 384)) : null);
      if (vec && vec.length) {
        result[missingIdx[k]] = vec;
        cache.set(texts[missingIdx[k]].trim(), vec);
      }
    }
  } catch {
    // 批量失败：逐条兜底
    for (const i of missingIdx) {
      result[i] = await embedOne(texts[i]);
    }
  }
  return result;
}
