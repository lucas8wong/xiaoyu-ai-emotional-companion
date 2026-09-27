/**
 * 朗读声音设置弹窗（VoxCPM2 音色/语气/语速/语种可调）——受控组件
 * 每次改选项实时写回上层 voiceCfg（朗读立即用它），保证「设置=听到的声音」；
 * 「保存到本机」才持久化。按界面语言自动推荐语种。
 */
import { useEffect, useState } from 'react';
import { X, Play, Loader2, Check } from 'lucide-react';
import { t } from '../i18n';
import Modal from './ui/Modal';
import { CHIP, ToggleRow } from './ui/controls';

export interface VoiceConfig {
  mode: 'clone' | 'custom'; // clone=小愈默认克隆声；custom=用户自定义文本音色设计
  age: 'young' | 'adult' | 'mature';
  gender: 'female' | 'male' | 'neutral';
  style: string;   // 声线/气质
  pace: 'slow' | 'moderate' | 'fast';
  dialect: string; // '' 中文（跟随文本）/ en-US 英文·美音 / en-GB 英文·英音
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  mode: 'clone',
  age: 'young',
  gender: 'female',
  style: 'warm and clear',
  pace: 'moderate',
  dialect: '',
};

export const AGE_OPTIONS = [
  { label: 'voiceAgeYoung', value: 'young' },
  { label: 'voiceAgeAdult', value: 'adult' },
  { label: 'voiceAgeMature', value: 'mature' },
];

export const STYLE_OPTIONS: { label: string; value: string }[] = [
  { label: 'voiceStyleWarmClear', value: 'warm and clear' },
  { label: 'voiceStyleSoft', value: 'soft and gentle' },
  { label: 'voiceStyleMagnetic', value: 'warm and magnetic' },
  { label: 'voiceStyleLively', value: 'bright and lively' },
  { label: 'voiceStyleIntellectual', value: 'calm and intellectual' },
  { label: 'voiceStyleCoquettish', value: 'playful and sweet' },
  { label: 'voiceStyleDeep', value: 'deep and low' },
  { label: 'voiceStyleBright', value: 'clear and bright' },
];
export const PACE_OPTIONS = [
  { label: 'voicePaceSlow', value: 'slow' },
  { label: 'voicePaceModerate', value: 'moderate' },
  { label: 'voicePaceFast', value: 'fast' },
];
// 语言自动跟界面语言（简体/繁体→中文；en→英文），英文才提供口音选项
export const ENGLISH_ACCENT_OPTIONS = [
  { label: 'voiceAccentUs', value: 'en-US' },
  { label: 'voiceAccentUk', value: 'en-GB' },
];
export const GENDER_OPTIONS = [
  { label: 'voiceGenderFemale', value: 'female' },
  { label: 'voiceGenderMale', value: 'male' },
  { label: 'voiceGenderNeutral', value: 'neutral' },
];

/** 紧凑音色选择器（供「角色声音设置」等复用）：渲染 年龄/性别/音色·性格/快慢/语言 + 跟随小愈默认 */
// region 目前未使用：用 `原名: _别名` 的解构重命名保留对外 props 形状（region?: string），
// 同时满足 lint 的 `^_` 忽略规则（给属性名加前缀会变成"不存在的 prop"）。
export function VoiceConfigPicker({ value, onChange, lang = 'zh-CN', region: _region }: { value: VoiceConfig; onChange: (c: VoiceConfig) => void; lang?: string; region?: string }) {
  const optBtn = (active: boolean) =>
    `px-2.5 py-1 rounded-full text-[12px] border transition-colors ${active ? 'bg-primary text-white border-primary' : 'bg-white text-ink-soft border-clay-border hover:bg-primary-lighter'}`;
  const set = (patch: Partial<VoiceConfig>) => onChange({ ...value, mode: 'custom', ...patch });
  return (
    <div className="space-y-2.5 text-[12px]">
      <div className="flex gap-1.5 flex-wrap">
        <button onClick={() => onChange({ ...DEFAULT_VOICE_CONFIG })} className={optBtn(value.mode === 'clone')}>{t('voiceUseDefault')}</button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap"><span className="w-14 text-ink-soft shrink-0">{t('voiceAge')}</span>{AGE_OPTIONS.map(o => (
        <button key={o.value} onClick={() => set({ age: o.value as VoiceConfig['age'] })} className={optBtn(value.mode === 'custom' && value.age === o.value)}>{t(o.label)}</button>
      ))}</div>
      <div className="flex items-center gap-1.5 flex-wrap"><span className="w-14 text-ink-soft shrink-0">{t('voiceGender')}</span>{GENDER_OPTIONS.map(o => (
        <button key={o.value} onClick={() => set({ gender: o.value as VoiceConfig['gender'] })} className={optBtn(value.mode === 'custom' && value.gender === o.value)}>{t(o.label)}</button>
      ))}</div>
      <div className="flex items-center gap-1.5 flex-wrap"><span className="w-14 text-ink-soft shrink-0">{t('voiceStyle')}</span>{STYLE_OPTIONS.map(o => (
        <button key={o.value} onClick={() => set({ style: o.value })} className={optBtn(value.mode === 'custom' && value.style === o.value)}>{t(o.label)}</button>
      ))}</div>
      <div className="flex items-center gap-1.5 flex-wrap"><span className="w-14 text-ink-soft shrink-0">{t('voicePace')}</span>{PACE_OPTIONS.map(o => (
        <button key={o.value} onClick={() => set({ pace: o.value as VoiceConfig['pace'] })} className={optBtn(value.mode === 'custom' && value.pace === o.value)}>{t(o.label)}</button>
      ))}</div>
      {lang === 'en' && (
        <div className="flex items-center gap-1.5 flex-wrap"><span className="w-14 text-ink-soft shrink-0">{t('voiceAccent')}</span>{ENGLISH_ACCENT_OPTIONS.map(o => (
          <button key={o.value} onClick={() => set({ dialect: o.value })} className={optBtn(value.mode === 'custom' && (effectiveDialect(value.dialect, lang) === o.value))}>{t(o.label)}</button>
        ))}</div>
      )}
    </div>
  );
}

const LS_KEY = 'xiaoyu_voice_config_v1';

export function composeVoice(cfg: VoiceConfig): string {
  const ageWord = cfg.age === 'young' ? 'young adult' : cfg.age === 'adult' ? 'adult' : 'mature';
  const genderWord = cfg.gender === 'female' ? 'female voice' : cfg.gender === 'male' ? 'male voice' : 'voice';
  // 语言/口音：'' 中文（不加语言词，VoxCPM 按文本语言读——普通话文本读普通话、粤港文本读粤语）；
  // en-US=American English；en-GB=British English。
  // 兼容旧值：English→英文；Cantonese/Taiwanese Mandarin→中文（跟随文本）。
  const dialectWord = cfg.dialect === 'en-US' ? 'American English'
    : cfg.dialect === 'en-GB' ? 'British English'
    : cfg.dialect === 'English' ? 'English'
    : '';
  const prefix = [dialectWord, ageWord, genderWord].filter(Boolean).join(' ');
  return `(${prefix ? prefix + ', ' : ''}${cfg.style} tone, ${cfg.pace} pace)`;
}

/** 语言自动跟界面语言：zh-CN/zh-TW → 中文('')；en → 英文口音（默认美音 en-US，可英音 en-GB）。
 *  这样即使某个角色音色存的是英文口音，在中文界面播放时也会按中文读（避免把 "American English" 前缀加到中文文本上）。 */
export function effectiveDialect(dialect: string, lang: string): string {
  if (lang !== 'en') return '';
  if (dialect === 'en-GB') return 'en-GB';
  return 'en-US';
}

export function loadVoiceConfig(): VoiceConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_VOICE_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_VOICE_CONFIG;
}
export function saveVoiceConfig(cfg: VoiceConfig): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// —— 小愈朗读开关：控制「回复下方语音气泡 + 提前合成声音」。关闭后不再预加载 TTS、也不显示气泡，省服务端负载。 ——
const VOICE_ENABLED_KEY = 'xiaoyu_voice_enabled_v1';
export function loadVoiceEnabled(): boolean {
  try {
    const raw = localStorage.getItem(VOICE_ENABLED_KEY);
    if (raw != null) return raw !== '0';
  } catch { /* ignore */ }
  return false; // 默认关闭（想听再开）
}
export function saveVoiceEnabled(v: boolean): void {
  try { localStorage.setItem(VOICE_ENABLED_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

/** 语言跟界面语言；这里只用于英文界面下「口音」的默认值：uk→英音，其余（us/au/neutral/中文区）→美音 */
export function regionToDialect(region?: string): string {
  if (region === 'uk') return 'en-GB';
  return 'en-US';
}

// 试听句按“说话语言”切换：VoxCPM 是“读文本的语言”，试听句要跟所选项匹配，才听得出效果
const PREVIEW_BY_DIALECT: Record<string, string> = {
  '': '你好呀，今天过得怎么样？我一直在呢。',
  'en-US': "Hi there, how's your day been? I'm here.",
  'en-GB': "Hi there, how's your day been? I'm here.",
  // 旧值兼容
  Cantonese: '你好呀，今天过得怎么样？我一直在呢。',
  'Taiwanese Mandarin': '你好呀，今天过得怎么样？我一直在呢。',
  English: "Hi there, how's your day been? I'm here.",
};

export function VoiceSettingsModal({ open, onClose, lang = 'zh-CN', region, name = '小愈', config, onChange, onSave, enabled, onEnabledChange }: {
  open: boolean;
  onClose: () => void;
  lang?: string;
  region?: string;  // 用户选的「地区语气」；说话语言跟随它（比语言更细）
  name?: string;  // 当前角色名（小愈=全局）；标题/默认按钮动态引用
  config: VoiceConfig;
  onChange: (cfg: VoiceConfig) => void;
  onSave: (cfg: VoiceConfig) => void;
  /** 小愈朗读开关：关闭后不预加载声音、回复下方不显示语音气泡 */
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [saved, setSaved] = useState(false);

  // 说话语言对齐「地区语气」：英文地区默认切到英文口音（us→美音、uk→英音）；
  // 中文区默认中文（跟随文本）；仅当是非法/旧值时清理回中文。
  useEffect(() => {
    if (open) {
      if (lang === 'en') {
        const defaultAccent = region ? regionToDialect(region) : 'en-US';
        // 英文界面：默认/旧值/非法值 → 切到该地区口音（uk→英音、其余→美音）；用户已明确选英文口音则保留
        if (config.dialect !== 'en-US' && config.dialect !== 'en-GB') onChange({ ...config, dialect: defaultAccent });
      } else {
        // 中文界面（简/繁）：语言固定为中文，清掉任何英文口音
        if (config.dialect !== '') onChange({ ...config, dialect: '' });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, region, lang]);

  if (!open) return null;

  const cfg = config;
  // 语言自动跟界面语言：中文界面（简/繁）→ 中文（跟随文本）；英文界面 → 按所选项生成英文口音
  const voice = cfg.mode === 'clone' ? '' : composeVoice({ ...cfg, dialect: effectiveDialect(cfg.dialect, lang) });
  const set = (patch: Partial<VoiceConfig>) => onChange({ ...cfg, mode: 'custom', ...patch });

  async function preview() {
    try {
      setLoading(true);
      const preview = (PREVIEW_BY_DIALECT[effectiveDialect(cfg.dialect, lang)] || PREVIEW_BY_DIALECT['']).slice(0, 200);
      const resp = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: preview, lang: 'zh-CN', voice }),
      });
      if (!resp.ok) throw new Error('preview failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended = () => setPlaying(false);
      setPlaying(true);
      await a.play();
    } catch (e) {
      console.warn('[voice] preview failed', e);
      setPlaying(false);
    } finally { setLoading(false); }
  }

  function save() {
    onSave(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  }

  // 选中口径与全站一致（白底 + 品牌色细环 + 品牌色字），不再用「深绿填充」那一套
  const optionBtn = (active: boolean) =>
    CHIP.base + ' !rounded-full !px-2.5 !py-1 !text-[12px] ' + (active ? CHIP.on : 'bg-white text-ink-soft border border-clay-border hover:bg-primary-lighter');

  return (
    <Modal open={open} onClose={onClose} overlayClassName="z-[120] flex items-end sm:items-center justify-center bg-black/40" width="w-full sm:max-w-md" padding="p-4" radius="rounded-t-2xl sm:rounded-2xl" maxHeight="max-h-[88vh]" panelClassName="text-gray-800" showClose={false}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-base font-semibold">{t('voiceTitle', { name })}</h3>
          <button onClick={onClose} aria-label={t('voiceClose')} className="p-1 text-ink-soft hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        <div className="space-y-2 text-[13px]">
          <ToggleRow title={t('voiceEnable', { name })} desc={t('voiceEnableHint')} checked={enabled} onChange={(v) => onEnabledChange(v)} />
          <div className="flex gap-1.5 flex-wrap">
            <button onClick={() => onChange({ ...DEFAULT_VOICE_CONFIG })} className={optionBtn(cfg.mode === 'clone')}>{t('voiceUseDefault')}</button>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold text-ink-soft">{t('voiceAge')}</div>
            <div className="flex gap-1.5 flex-wrap">{AGE_OPTIONS.map(o => (
              <button key={o.value} onClick={() => set({ age: o.value as VoiceConfig['age'] })} className={optionBtn(cfg.mode === 'custom' && cfg.age === o.value)}>{t(o.label)}</button>
            ))}</div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold text-ink-soft">{t('voiceGender')}</div>
            <div className="flex gap-1.5 flex-wrap">{GENDER_OPTIONS.map(o => (
              <button key={o.value} onClick={() => set({ gender: o.value as VoiceConfig['gender'] })} className={optionBtn(cfg.mode === 'custom' && cfg.gender === o.value)}>{t(o.label)}</button>
            ))}</div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold text-ink-soft">{t('voiceStyle')}</div>
            <div className="flex gap-1.5 flex-wrap">{STYLE_OPTIONS.map(o => (
              <button key={o.value} onClick={() => set({ style: o.value })} className={optionBtn(cfg.mode === 'custom' && cfg.style === o.value)}>{t(o.label)}</button>
            ))}</div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold text-ink-soft">{t('voicePace')}</div>
            <div className="flex gap-1.5 flex-wrap">{PACE_OPTIONS.map(o => (
              <button key={o.value} onClick={() => set({ pace: o.value as VoiceConfig['pace'] })} className={optionBtn(cfg.mode === 'custom' && cfg.pace === o.value)}>{t(o.label)}</button>
            ))}</div>
          </div>
          {lang === 'en' && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-ink-soft">{t('voiceAccent')}</div>
              <div className="flex gap-1.5 flex-wrap">{ENGLISH_ACCENT_OPTIONS.map(o => (
                <button key={o.value} onClick={() => set({ dialect: o.value })} className={optionBtn(cfg.mode === 'custom' && (effectiveDialect(cfg.dialect, lang) === o.value))}>{t(o.label)}</button>
              ))}</div>
            </div>
          )}
        </div>

        <button onClick={preview} disabled={loading} className="w-full mt-3 flex items-center justify-center gap-1.5 py-2 rounded-xl font-medium text-sm bg-primary-lighter text-primary-text hover:bg-primary/15 transition-colors disabled:opacity-60">
          {loading || playing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {t('voicePreview')}
        </button>

        <div className="text-[11px] text-ink-soft break-all leading-snug mt-2">{cfg.mode === 'clone' ? t('voiceDefault') : `${t('voiceCustom')} · ${voice}`}</div>

        <div className="flex gap-2 mt-3">
          <button onClick={save} className="flex-1 py-2.5 rounded-xl font-medium text-sm bg-primary text-white hover:opacity-90 transition-opacity">
            {saved ? <span className="inline-flex items-center gap-1"><Check className="w-4 h-4" />{t('voiceSaved')}</span> : t('voiceSave')}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl font-medium text-sm bg-white border border-clay-border text-ink-soft hover:bg-gray-50 transition-colors">{t('voiceClose')}</button>
        </div>
    </Modal>
  );
}
