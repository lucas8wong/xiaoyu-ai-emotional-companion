/**
 * 剧情扮演 system prompt 体积体检（含构成拆解）
 *
 * 用途：
 *  1. 换第三方 / 自托管模型前，先确认「协议开销」有多大，上下文窗口装不下会出现
 *     人设丢失 / 回复莫名截断 / 上游 400。
 *  2. 判断「压 prompt」到底能省多少、该压哪一块：把 system 拆成
 *       · 内容块（角色卡 + 背景 + 开场），剧本本体，不能压
 *       · 规则块（写作要求 + 禁令 + 语言指令 + 用户偏好 + 尾句），历史累积，可压
 *       · 边界句 / 任务指令，短，基本不必动
 *
 * 用法：npx tsx scripts/check_rp_prompt_size.mts
 *
 * token 为**估算**（CJK ≈ 1.5 字/token，其余 ≈ 4 字符/token），用于判断量级与选型档位，
 * 不作计费依据；精确值请用目标模型自己的 tokenizer 实测。
 */
import { setupTempCwd } from '../test/unit/setup.js';

setupTempCwd(); // 隔离 store，避免读写真 data/

const rp = await import('../api/services/roleplay.js');

/**
 * token 估算：按字符类型分别折价，避免用中文系数去算英文（会高估一倍以上）。
 *  - CJK 汉字 ≈ 1.5 字/token
 *  - 英文/标点/空白 ≈ 4 字符/token
 */
function tok(text: string): number {
  const cjk = (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

const ids = (rp.listScenarios('zh') as any[]).map((s: any) => s.id);
// getScenario 返回原始剧本（含 .zh/.en 双语）；listScenarios 返回的是给列表用的扁平对象
const raws = ids.map((id: string) => rp.getScenario(id)).filter(Boolean) as any[];
if (!raws.length) {
  console.error('没有可用剧本，无法体检');
  process.exit(1);
}

const MARKER: Record<string, string> = {
  zh: '【写作与交互要求】',
  'zh-TW': '【寫作與交互要求】',
  en: '[Writing & interaction rules]',
};

for (const lang of ['zh', 'en'] as const) {
  const s = raws.find((r) => (lang === 'en' ? r.en : r.zh));
  if (!s) {
    console.warn('跳过 ' + lang + '：没有该语言版本的剧本');
    continue;
  }

  const sys = rp.buildSystemPrompt(s, lang) as string;
  // 内容块 = 【写作与交互要求】之前的一切（角色卡 + 用户角色 + 背景 + 开场）
  const marker = MARKER[lang];
  const idx = sys.indexOf(marker);
  const contentPart = idx >= 0 ? sys.slice(0, idx) : sys;
  const rulesPart = idx >= 0 ? sys.slice(idx) : '';

  const boundary = rp.injectionBoundaryFor(lang) as string;
  const task = rp.roleplayTaskInstr('immersive', '角色', lang) as string;

  const rows: Array<[string, string]> = [
    ['内容块（角色卡+用户角色+背景+开场）', contentPart],
    ['规则块（写作要求+禁令+语言指令+偏好+尾句）', rulesPart],
    ['边界句（反注入）', boundary],
    ['任务指令（每轮收尾）', task],
  ];
  // 括号心理活动块未导出：从常量文本长度近似（开启态）
  const innerApprox = lang === 'en'
    ? '\n\n【Bracketed inner monologue & expression · ON】For a more human, immersive feel, you may naturally use parentheses in the narration to show YOUR OWN character\u2019s inner thoughts, expression, or small action, e.g. (he sighs softly) "I\u2019m here." / (she looks up, voice softening) "Take your time." Only write your own character\u2019s inner state and actions, never the user\u2019s; use them naturally each turn without piling up. This rule overrides any earlier "no parentheses" requirement.'
    : '\n\n【括号心理活动/神情 · 开启】为了更像真人、更有沉浸感，你可以在旁白里自然使用全角括号（）写你所扮演角色的心理活动或神情/小动作，例如：（他轻轻叹了口气）「我在这儿。」（她抬眼看过来，语气软下来）「别急，慢慢说。」括号只写你自己角色的内心与神态，不替用户描写；每轮自然使用，不要堆砌。此规则优先于上面任何「禁止括号」的条款。';
  rows.push(['括号心理活动块（可开关）', innerApprox]);

  const total = rows.map(([, t]) => t).join('\n\n');

  console.log('\n================ lang=' + lang + ' ================');
  console.log('组成'.padEnd(44) + 'chars'.padStart(8) + 'est.tokens'.padStart(12) + '占比'.padStart(8));
  for (const [name, text] of rows) {
    const t = tok(text);
    const pct = ((t / tok(total)) * 100).toFixed(1) + '%';
    console.log(name.padEnd(44) + String(text.length).padStart(8) + String(t).padStart(12) + pct.padStart(8));
  }
  console.log('-'.repeat(74));
  console.log('实际 system 合计（单轮）'.padEnd(44) + String(total.length).padStart(8) + String(tok(total)).padStart(12));
  console.log('注：以上不含 history 与 longMemory 注入。');
}

// 【全剧本范围：内置剧本之间差异大（背景/人设长短不一），只看一个剧本会失真】
for (const lang of ['zh', 'en'] as const) {
  const list = raws.filter((r) => (lang === 'en' ? r.en : r.zh));
  if (!list.length) continue;
  const sizes = list.map((s) => tok(rp.buildSystemPrompt(s, lang) as string)).sort((a, b) => a - b);
  const mid = sizes[Math.floor(sizes.length / 2)];
  console.log(
    `\n[${lang}] ${sizes.length} 个内置剧本 system 体积：min=${sizes[0]} / 中位=${mid} / max=${sizes[sizes.length - 1]} token`,
  );
}

// 【自建剧本最坏情况：draft 提示词允许 aiPersona 与 background 各写到 2000 字】
const worst = '你'.repeat(4000);
console.log(
  `\n[自建剧本最坏情况] aiPersona 2000 字 + background 2000 字 ≈ ${tok(worst)} token 内容块；` +
    `再加规则块等 ≈ ${tok(worst) + 856 + 218} token（zh，未含 history）。`,
);
console.log('提示：换/自托管模型前，应按「自建剧本最坏情况 + 多轮 history」来估窗口需求，而不是按单个内置剧本。');
