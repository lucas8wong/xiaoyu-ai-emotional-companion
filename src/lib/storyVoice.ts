/**
 * 剧情「角色配音」音色库与默认分配
 * 对应 docs/roleplay-immersion-plan.md §4.1（S1 声音层）。
 *
 * 设计要点（都与项目既有结论对齐，别另起一套）：
 * 1. 音色 = VoxCPM 的「**文本音色设计**」前缀（与 `VoiceSettingsModal.composeVoice` 同口径）：
 *    语言词**只在英文界面加**（中文不加，让 VoxCPM 按文本语言自然读：普通话读普通话、粤港文本读粤语）。
 * 2. 默认音色按「**剧本标签分组**（与 storyBgm 共用同一套分组）+ **AI 角色性别**」双维度选，
 *    所以同一套标签下的男主/女主不会共用一个声音（`RoleplayScenarioInfo.ai.gender` 前端可见）。
 * 3. `speakableRoleplayText()`：剧情文本 → 可朗读文本。**必须去掉 （）/() 里的心理活动与神态**
 *    括号心理描写是"看不见的内心"（`buildRoleplayInnerMonologueBlock` 鼓励模型用它），
 *    念出来会立刻出戏；对白与旁白保留。
 *
 * 本文件是**纯函数**（无 DOM/无请求），便于单测；播放与缓存见 `src/hooks/useStoryVoice.ts`。
 */

import { ANCIENT, SCHOOL, COOL, WARM } from './storyBgm';

// ============ 音色预设 ============

export type StoryVoiceTone = 'gentle' | 'warm' | 'bright' | 'cool' | 'calm';
export type StoryVoiceGender = 'female' | 'male' | 'neutral';

export interface StoryVoicePreset {
  id: string;
  tone: StoryVoiceTone;
  gender: StoryVoiceGender;
  /** i18n key（三语在 src/i18n/index.ts） */
  label: string;
  /** VoxCPM 文本音色设计（不含语言词，语言词由 storyVoiceDesign 拼） */
  design: string;
}

export const VOICE_PRESETS: StoryVoicePreset[] = [
  { id: 'gentle-f', tone: 'gentle', gender: 'female', label: 'rpVoiceGentle', design: 'young adult female voice, soft and gentle tone, slow pace' },
  { id: 'warm-f', tone: 'warm', gender: 'female', label: 'rpVoiceWarm', design: 'young adult female voice, warm and clear tone, moderate pace' },
  { id: 'bright-f', tone: 'bright', gender: 'female', label: 'rpVoiceBright', design: 'young adult female voice, bright and lively tone, moderate pace' },
  { id: 'cool-f', tone: 'cool', gender: 'female', label: 'rpVoiceCool', design: 'young adult female voice, calm and cool tone, slow pace' },
  { id: 'steady-m', tone: 'warm', gender: 'male', label: 'rpVoiceSteady', design: 'adult male voice, warm and magnetic tone, moderate pace' },
  { id: 'deep-m', tone: 'cool', gender: 'male', label: 'rpVoiceDeep', design: 'adult male voice, deep and low tone, slow pace' },
  { id: 'youthful-m', tone: 'bright', gender: 'male', label: 'rpVoiceYouthful', design: 'young adult male voice, clear and bright tone, moderate pace' },
  { id: 'calm-n', tone: 'calm', gender: 'neutral', label: 'rpVoiceCalm', design: 'adult voice, calm and intellectual tone, moderate pace' },
];

export const presetById = (id: string | undefined | null): StoryVoicePreset | undefined =>
  VOICE_PRESETS.find(p => p.id === id);

/** 朗读文本上限（服务端 /api/tts 亦在 2000 处截断；这里留余量并在句末截断，避免念到一半被砍） */
export const SPEECH_MAX_CHARS = 1800;

// ============ 剧本 → 音色 ============

/** 标签 → 语气基调（与 storyBgm.setForScenario 同一套分组，顺序即优先级） */
export function toneForScenario(s: { tags?: string[] }): StoryVoiceTone {
  const tags = (s.tags || []).map(String);
  if (tags.some(t => SCHOOL.includes(t))) return 'bright';
  if (tags.some(t => COOL.includes(t))) return 'cool';
  if (tags.some(t => WARM.includes(t))) return 'gentle';
  if (tags.some(t => ANCIENT.includes(t))) return 'warm';
  return 'warm'; // 都市默认
}

/**
 * AI 角色性别：优先剧本里人设的 gender（'男'/'女'/'Male'/'Female'…），
 * 缺失时回退受众分区（`her`=给她=男性 AI / `him`=给他=女性 AI，见 roleplay.ts 的 SCENARIO_AUDIENCE 注释）。
 */
export function genderForScenario(s: { ai?: { gender?: string }; audience?: string }): StoryVoiceGender {
  const g = String(s.ai?.gender ?? '').trim().toLowerCase();
  if (g) {
    if (g.includes('female') || g.includes('女') || g === 'f' || g === 'woman' || g === 'girl') return 'female';
    if (g.includes('male') || g.includes('男') || g === 'm' || g === 'man' || g === 'boy') return 'male';
  }
  if (s.audience === 'her') return 'male';
  if (s.audience === 'him') return 'female';
  return 'neutral';
}

/** 语气 × 性别 → 预设 id 的**显式表**（不用"找不到就回退"的隐含行为：每个组合都是刻意选的） */
const TONE_GENDER_MAP: Record<StoryVoiceTone, Record<StoryVoiceGender, string>> = {
  gentle: { female: 'gentle-f', male: 'steady-m', neutral: 'calm-n' },
  warm: { female: 'warm-f', male: 'steady-m', neutral: 'calm-n' },
  bright: { female: 'bright-f', male: 'youthful-m', neutral: 'calm-n' },
  cool: { female: 'cool-f', male: 'deep-m', neutral: 'calm-n' },
  calm: { female: 'warm-f', male: 'steady-m', neutral: 'calm-n' },
};

/** 默认音色：按语气基调 + 性别查显式表（查不到就回退中性音色） */
export function defaultVoicePreset(s: { tags?: string[]; ai?: { gender?: string }; audience?: string }): StoryVoicePreset {
  const tone = toneForScenario(s);
  const gender = genderForScenario(s);
  const id = TONE_GENDER_MAP[tone]?.[gender];
  return presetById(id) || presetById('calm-n')!;
}

/**
 * 拼成 VoxCPM 的 voice 字符串（与 `composeVoice` 同格式）。
 * dialect：'' = 中文（不加语言词）；'en-US'/'en-GB' = 英文美音/英音。
 */
export function storyVoiceDesign(preset: StoryVoicePreset, dialect = ''): string {
  const dialectWord = dialect === 'en-US' ? 'American English' : dialect === 'en-GB' ? 'British English' : '';
  const prefix = [dialectWord, preset.design].filter(Boolean).join(', ');
  return `(${prefix})`;
}

/** 一步到位：剧本 → { preset, design }（dialect 传界面语言的方言，中文界面传 ''） */
export function defaultVoiceForScenario(
  s: { tags?: string[]; ai?: { gender?: string }; audience?: string },
  dialect = '',
): { preset: StoryVoicePreset; design: string } {
  const preset = defaultVoicePreset(s);
  return { preset, design: storyVoiceDesign(preset, dialect) };
}

// ============ 剧情文本 → 可朗读文本 ============

/** 轻量 markdown 清理（比 ChatPage 的 stripMarkdown 更聚焦：剧情正文通常无表格/代码块） */
function stripMarkdownLite(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.、)]\s+/gm, '');
}

/**
 * 去掉配对的括号内容（含嵌套）。**括号不配对时整对跳过**
 * 宁可留着（可能只是文案里的一个笑脸括号），也不能因为一个落单的 "(" 把后半段台词整段吞掉。
 */
function dropBalanced(text: string, open: string, close: string): string {
  let opens = 0;
  let closes = 0;
  for (const ch of text) {
    if (ch === open) opens++;
    else if (ch === close) closes++;
  }
  if (opens === 0 || opens !== closes) return text;

  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === open) { depth++; continue; }
    if (ch === close) { if (depth > 0) { depth--; continue; } }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * 剧情文本 → 可朗读文本：
 * ① 去 markdown；② 去（）、()、【】、[] 里的心理活动/神态/舞台提示；
 * ③ 可选去掉开头的「角色名：」前缀；④ 空白归一（换行折成句断，避免朗读出现诡异长停）。
 */
export function speakableRoleplayText(raw: string, opts: { aiName?: string } = {}): string {
  if (!raw) return '';
  let s = stripMarkdownLite(String(raw));
  for (const [open, close] of [['（', '）'], ['(', ')'], ['【', '】'], ['[', ']']] as const) {
    s = dropBalanced(s, open, close);
  }
  const name = (opts.aiName || '').trim();
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('^\\s*' + esc + '\\s*[：:]\\s*'), '');
  }
  s = s.replace(/[ \t\u3000]+/g, ' ').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}

/**
 * 按句末标点截到 max 以内（避免服务端 2000 硬截断把一句话念一半）。
 * 找不到可切分点时按词/字硬切（保证不超长）。
 */
export function clampForSpeech(text: string, max = SPEECH_MAX_CHARS): string {
  const s = (text || '').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const punct = '。！？!?…；;';
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (punct.includes(head[i])) { cut = i + 1; break; }
  }
  if (cut > 0) return head.slice(0, cut).trim();
  return head.trim();
}
