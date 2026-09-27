/**
 * 场景图**红线抽检**的共享实现（跑批时抽检 + 事后全库复核，共用一套判据，避免两处漂移）。
 *
 * 判据（方案 §4.4）：场景图里**不许有人物、不许有文字**。
 * 为什么必须抽检、不能只靠 prompt：实测万相会把霓虹招牌上的字真画出来（"霓虹招牌 'NICGHIT CLUB'"），
 * 而负向词只写 `text/letters/signage` **挡不住**——只能"正向强约束 + 出图后抽检 + 不合格换 seed 重出"闭环。
 *
 * ⚠️ 抽检模型偶发不吐合法 JSON（实测 6 张）——此时**按设计放行**并如实标记 `unavailable`，
 * 由事后全库复核兜底（`scripts/check_scene_art_redline.mts`）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_Q = '这是一张场景插画。请只输出一个JSON对象（不要其他文字）：'
  + '{"has_person":true|false,"has_text":true|false,"description":"一句话"}。'
  + 'has_person 包含人物、剪影、远景行人、镜中人、雕像分辨不清的人形；has_text 包含任何可辨认的文字/字母/招牌/水印。';

export interface AuditResult { ok: boolean; why?: string; error?: string }

function readEnvFile(root: string): Record<string, string> {
  const p = path.join(root, '.env');
  const out: Record<string, string> = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const [k, ...rest] = s.split('=');
    out[k.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function auditEnv(root: string): { key: string; base: string; model: string } {
  const env = readEnvFile(root);
  return {
    key: (process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '').trim(),
    base: (process.env.DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  };
}

const mimeOf = (ext: string) => (ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp');

export async function auditImageBytes(bytes: Buffer, ext: string, env: { key: string; base: string; model: string }): Promise<AuditResult> {
  if (!env.key) return { ok: true, error: 'no api key' };
  try {
    const r = await fetch(env.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.key },
      body: JSON.stringify({
        model: env.model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: AUDIT_Q },
          { type: 'image_url', image_url: { url: `data:${mimeOf(ext)};base64,` + bytes.toString('base64') } },
        ] }],
        max_tokens: 2000, // 该视觉模型是推理模型：max_tokens 太小会被 reasoning 吃光 → content 为空
      }),
    });
    const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, error: 'no json' };
    const o = JSON.parse(m[0]) as { has_person?: boolean; has_text?: boolean; description?: string };
    const bad = o.has_person === true || o.has_text === true;
    const why = bad ? `${o.has_person ? '有人物' : ''}${o.has_text ? (o.has_person ? ' + ' : '') + '有文字' : ''}：${o.description || ''}` : undefined;
    return { ok: !bad, why };
  } catch (e) {
    // 抽检失败**不阻塞出图**（按设计放行），但如实记录，由事后复核兜底
    return { ok: true, error: (e as Error).message };
  }
}

export async function auditImageFile(file: string, env: { key: string; base: string; model: string }): Promise<AuditResult> {
  const ext = path.extname(file).slice(1).toLowerCase();
  return auditImageBytes(fs.readFileSync(file), ext, env);
}
