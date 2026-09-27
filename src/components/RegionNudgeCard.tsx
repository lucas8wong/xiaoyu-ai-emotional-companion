/**
 * 对话内「地区语气」轻提示卡片（一次性、可关闭）
 * 面向「从未主动设过地区语气」的用户，聊了 1–2 句后浮一次，引导 TA 选一个熟悉的味道。
 * 点「选味道」内联展开 RegionIntensityPicker（复用 PreferencePanel 同源选择器），保存后即关。
 * 不做打字/地域识别，纯靠用户自选（符合产品取向）。
 */
import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { savePreferences, type Region, type Intensity } from '../services/api';
import { getCachedPreferences, setCachedPreferences } from '../lib/prefsCache';
import { getLang, t } from '../i18n';
import RegionIntensityPicker from './RegionIntensityPicker';

interface RegionNudgeCardProps {
  onClose: () => void;
  /** 当前角色名（2026-09-21，缺省 = 内置小愈／Xiaoyu）：和哥哥聊着天，别在提示里说小愈 */
  name?: string;
}

export default function RegionNudgeCard({ onClose, name }: RegionNudgeCardProps) {
  const cached = getCachedPreferences();
  const isEn = getLang() === 'en';
  const who = (name || '').trim() || (isEn ? 'Xiaoyu' : '小愈');
  const [region, setRegion] = useState<Region>(cached?.region ?? (isEn ? 'neutral' : 'putonghua'));
  const [intensity, setIntensity] = useState<Intensity>(cached?.intensity ?? 'natural');
  const [touched, setTouched] = useState(false);
  const [intensityTouched, setIntensityTouched] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  const markSeen = () => {
    try { localStorage.setItem('cure_region_nudge_seen', '1'); } catch { /* 忽略 */ }
  };

  const dismiss = () => {
    markSeen();
    onClose();
  };

  const save = () => {
    if (saving) return;
    setSaving(true);
    // 同步更新缓存：让下一句聊天请求立即带上新地区语气
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, region, intensity }); } catch { /* 忽略 */ }
    savePreferences({ region, intensity }).then(r => {
      if (r.data) setCachedPreferences(r.data);
      try { localStorage.setItem('cure_region_set', '1'); } catch { /* 忽略 */ }
      markSeen();
      onClose();
    }).catch(() => setSaving(false));
  };

  return (
    <div className="mx-auto max-w-md bg-primary-lighter border border-clay-border rounded-2xl p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <Sparkles className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="text-sm text-ink leading-relaxed flex-1 min-w-0">
          <p className="font-semibold">{t('regionNudgeTitle', { name: who })}</p>
          <p className="text-[12px] text-gray-600 mt-0.5 leading-snug">{t('regionNudgeBody', { name: who })}</p>
        </div>
        <button onClick={dismiss} aria-label={t('regionNudgeDismiss')} className="text-ink-soft hover:text-gray-600 flex-shrink-0 -mr-1 -mt-1 p-1">
          <X className="w-4 h-4" />
        </button>
      </div>

      {expanded ? (
        <div className="mt-3">
          <RegionIntensityPicker
            region={region}
            intensity={intensity}
            onRegion={(r) => {
              setRegion(r);
              setTouched(true);
              // 选地区时默认把强度抬到「明显」：让地区味一选就有（仅当用户还没手动挑过强度、且当前还是缺省「自然」时）
              if (!intensityTouched && intensity === 'natural') setIntensity('obvious');
            }}
            onIntensity={(i) => { setIntensity(i); setIntensityTouched(true); }}
            showIntensity={touched}
          />
          <div className="flex items-center justify-end gap-2 mt-3">
            <button onClick={dismiss} className="text-[12px] text-ink-soft hover:text-gray-700">{t('regionNudgeDismiss')}</button>
            <button
              onClick={save}
              disabled={!touched || saving}
              className="text-[12px] font-medium text-white bg-primary-strong rounded-full px-3 py-1.5 hover:bg-primary transition-all disabled:opacity-50"
            >
              {saving ? '…' : t('regionNudgeSave')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2 mt-3">
          <button onClick={dismiss} className="text-[12px] text-ink-soft hover:text-gray-700">{t('regionNudgeDismiss')}</button>
          <button
            onClick={() => setExpanded(true)}
            className="text-[12px] font-medium text-primary-text bg-white border border-primary/30 rounded-full px-3 py-1.5 hover:bg-primary-lighter transition-all"
          >
            {t('regionNudgeCta')}
          </button>
        </div>
      )}
    </div>
  );
}
