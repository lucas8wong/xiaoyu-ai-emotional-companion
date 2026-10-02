/**
 * 通用偏好编辑面板（单一数据源 / single source of truth）
 * 覆盖：地区口音 · 语气程度 · 智能贴合 · 故事风格（「陪伴方式」档位于 2026-09-23 整体退场）
 * 复用位置：聊一聊 / 理一理 / 我的-偏好（PreferencesModal）
 * - 所有文案走 i18n（三语言自动）
 * - 改动即保存（savePreferences，fire-and-forget）
 * - 英文模式地区口音显示 4 风格，中文显示 10 地区
 */

import { useEffect, useRef, useState } from 'react';
import { savePreferences, getQuota, getCachedPlan, subscribePush, unsubscribePush, sendPushTestSelf, getOutreachSubjects, muteOutreachSubject, unmuteOutreachSubject, reportTimezone, isLoggedIn, type Region, type Intensity, type ChatRelationKind } from '../services/api';
import { subscribeToPush, unsubscribeFromPush, isPushSupported } from '../services/notifications';
import PushInstallGuide from './PushInstallGuide';
import type { PwaInstallMode } from '../hooks/usePwaInstall';
import { getCachedPreferences, setCachedPreferences, loadPreferences } from '../lib/prefsCache';
import { getLang, t } from '../i18n';
import { CHIP, GroupLabel, OptionGroup, ToggleRow } from './ui/controls';

/**
 * ⚠️ 2026-09-23：本文件内原来还有 `selectedCls/normalCls` 两个「深色填充 + 方角」的选中态常量，
 * 只被「关系类型」一处用（「陪伴方式」网格退场后），而同一屏的其它组早就是 `CHIP` 的
 * 「沙色轨道 + 白胶囊 + 品牌细环」语言 —— 一屏两套选中文案正是 `ui/controls.tsx` 立那一层要治的病。
 * 现在关系类型也换成 `OptionGroup`（同一套语言），这两个常量随之删除。
 */

const REGIONS_ZH: [Region, string][] = [
  ['putonghua', 'regionPutonghua'],
  ['dongbei', 'regionDongbei'],
  ['jingjin', 'regionJingjin'],
  ['chuanyu', 'regionChuanyu'],
  ['yuegang', 'regionYuegang'],
  ['jiangnan', 'regionJiangnan'],
  ['guanzhong', 'regionGuanzhong'],
  ['minnan', 'regionMinnan'],
  ['mindong', 'regionMindong'],
  ['taiwan', 'regionTaiwan'],
];
const REGIONS_EN: [Region, string][] = [
  ['neutral', 'regionNeutral'],
  ['us', 'regionUs'],
  ['uk', 'regionUk'],
];
const INTENSITIES: [Intensity, string][] = [
  ['natural', 'intensityNatural'],
  ['obvious', 'intensityObvious'],
  ['strong', 'intensityStrong'],
];
const STORY_STYLES = [
  ['poetic', 'storyPoetic'],
  ['warm', 'storyWarmStyle'],
  ['concise', 'storyConcise'],
  ['abstract', 'storyAbstract'],
] as const;
/**
 * 关系类型（2026-09-21）：与后端 `api/services/chatRelation.ts` 的四档一一对应。
 * 顺序＝从最轻到最亲（用户从上往下读，正好是"越来越熟"的顺序）。
 */
const RELATIONS: [ChatRelationKind, string, string][] = [
  ['friend', 'relationFriend', 'relationFriendDesc'],
  ['buddy', 'relationBuddy', 'relationBuddyDesc'],
  ['family', 'relationFamily', 'relationFamilyDesc'],
  ['lover', 'relationLover', 'relationLoverDesc'],
];

interface PreferencePanelProps {
  onFeedback?: () => void;
  showStoryStyle?: boolean; // 故事风格仅「理一理」展示（聊一聊/主页偏好里隐藏）
  onRequestMembership?: () => void; // 非 Pro 点击「最大」档时触发会员升级引导
  /** tone=「小愈怎么陪你」（地区/程度/智能贴合/聊天内心独白）；
   *  global=「我的-偏好」全局（剧情内心独白/AI主动找我/深度思考）；full=全部（默认） */
  variant?: 'tone' | 'global' | 'full';
  /** 直达「主动找我」：打开时滚动并高亮 AI 主动找我开关（不自动开） */
  focusProactivePush?: boolean;
  /**
   * 「AI 主动找我」里的「装到桌面/主屏」引导（2026-10-02 用户真机反馈）：
   * 由 Home 的 usePwaInstall 单例注入（与底部轻提示/⋯ 里的「保存 Xiaoyu」共用同一份
   * beforeinstallprompt）。不传则不显示（聊一聊/理一理的 tone 变体本就没有推送区块）。
   */
  pwaInstall?: { installed: boolean; mode: PwaInstallMode; promptInstall: () => Promise<string> } | null;
  /**
   * 关系类型（2026-09-21）：朋友 / 损友 / 家人 / 恋人。
   *
   * 面板自己**不碰数据源**：由调用方（ChatPage）决定写哪儿——
   * 内置小愈写用户级 `savePreferences({ xiaoyuRelation })`，自定义角色写
   * `updateChatCharacter(id, { relation })`（每角色一档）。不传 = 面板自己按用户级存。
   */
  relationValue?: ChatRelationKind;
  onRelationChange?: (r: ChatRelationKind) => void;
  /** 隐藏「关系类型」那一段（剧情角色：剧本人设自带关系与称呼，叠一层会把它冲成"小愈味"） */
  hideRelation?: boolean;
  /**
   * 当前角色名（2026-09-21，缺省 = 内置小愈／Xiaoyu）：面板里凡是「她怎么陪你」的描述句都跟着它走，
   * 否则和哥哥聊着天，面板里却在说小愈。调用方（ChatPage）传当前角色名；其余调用点不传即保持原文。
   */
  name?: string;
}

export default function PreferencePanel({ onFeedback, showStoryStyle = false, onRequestMembership, variant = 'full', focusProactivePush = false, pwaInstall = null, relationValue, onRelationChange, hideRelation = false, name }: PreferencePanelProps) {
  // 哪些区块显示：tone=语气组；global=全局组；full=全部
  const showTone = variant === 'tone' || variant === 'full';
  const showGlobal = variant === 'global' || variant === 'full';
  const isEn = getLang() === 'en';
  // 角色级文案用名（缺省 = 内置小愈／Xiaoyu）：只在「当前角色的设置面」需要跟随角色时由调用方传入
  const panelName = (name || '').trim() || (isEn ? 'Xiaoyu' : '小愈');
  // 英文模式默认 Standard（neutral）；中文地区仅中文模式可用
  const EN_REGIONS: Region[] = ['neutral', 'us', 'uk'];
  const ZH_REGIONS: Region[] = ['putonghua','dongbei','jingjin','chuanyu','yuegang','jiangnan','guanzhong','minnan','mindong','taiwan','neutral'];
  const normRegion = (r?: Region): Region => {
    const list = isEn ? EN_REGIONS : ZH_REGIONS;
    return r && list.includes(r) ? r : (isEn ? 'neutral' : 'putonghua');
  };

  // 用缓存同步初始化：再次打开秒显，不再出现骨架屏等待
  const cached = getCachedPreferences();
  const cachedPro = getCachedPlan() === 'pro'; // 首屏同步快照（trial Pro 由下方 getQuota 纠正）
  const [region, setRegion] = useState<Region>(normRegion(cached?.region));
  const [intensity, setIntensity] = useState<Intensity>(cached?.intensity ?? 'natural');
  const [smartFit, setSmartFit] = useState(cached ? cached.smartFitEnabled : true);
  const [chatInner, setChatInner] = useState(cached ? cached.chatInnerMonologueEnabled !== false : true);
  // 关系类型（2026-09-21）：受控（relationValue 由 ChatPage 按当前角色传入）或自管（用户级）
  const [relationLocal, setRelationLocal] = useState<ChatRelationKind>(cached?.xiaoyuRelation ?? 'friend');
  const relation = relationValue ?? relationLocal;
  const [roleplayInner, setRoleplayInner] = useState(cached ? cached.roleplayInnerMonologueEnabled !== false : true);
  const [thinking, setThinking] = useState<'off' | 'high' | 'max'>(
    cached?.thinkingLevel === 'off' ? 'off'
      : (cached?.thinkingLevel === 'max' && cachedPro) ? 'max'
      : 'high'
  );
  const [storyStyle, setStoryStyle] = useState<'poetic' | 'concise' | 'warm' | 'abstract'>(cached?.storyStyle ?? 'poetic');
  const [loaded, setLoaded] = useState(!!cached);
  const [saved, setSaved] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(cached?.proactivePush === true);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFreq, setPushFreq] = useState<'random' | 'frequent' | 'occasional' | 'intense'>(cached?.proactiveFrequency ?? 'random');
  const [pushStatus, setPushStatus] = useState<string | null>(null);
  // 当前环境能不能真的收到 Web Push（iOS Safari 标签页 = 不能）→ 决定要不要显示「先装到主屏」引导
  const [pushUsable] = useState(() => isPushSupported());
  // 状态色调：info=琥珀（不是错误，如站内/邮件兜底）；error=红色（权限被拒、订阅失败）
  const [pushStatusKind, setPushStatusKind] = useState<'error' | 'info'>('error');
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [pushTestStatus, setPushTestStatus] = useState<string | null>(null);
  const [outreachSubjects, setOutreachSubjects] = useState<{ subjectKey: string; feature: string; label: string; muted: boolean }[]>([]);
  const [mutedBusy, setMutedBusy] = useState<string | null>(null);
  const [muteOpen, setMuteOpen] = useState(false);
  // 会员档位：max 仅 Pro/Lifetime；非 Pro 锁定这一档
  const [isPro, setIsPro] = useState<boolean | null>(cachedPro ? true : null);
  // 直达「主动找我」：滚动 + 高亮用
  const pushRef = useRef<HTMLDivElement>(null);
  const [pushPulse, setPushPulse] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadPreferences().then(d => {
      if (cancelled || !d) return;
      if (d.storyStyle) setStoryStyle(d.storyStyle);
      if (d.region) setRegion(normRegion(d.region));
      if (d.intensity) setIntensity(d.intensity);
      if (typeof d.smartFitEnabled === 'boolean') setSmartFit(d.smartFitEnabled);
      if (typeof d.chatInnerMonologueEnabled === 'boolean') setChatInner(d.chatInnerMonologueEnabled);
      // 关系档：受控时（relationValue 由 ChatPage 按当前角色传入）这个值只是兜底，不影响显示
      if (d.xiaoyuRelation) setRelationLocal(d.xiaoyuRelation);
      if (typeof d.roleplayInnerMonologueEnabled === 'boolean') setRoleplayInner(d.roleplayInnerMonologueEnabled);
      if (typeof d.proactivePush === 'boolean') setPushEnabled(d.proactivePush);
      if (d.proactiveFrequency === 'frequent' || d.proactiveFrequency === 'occasional' || d.proactiveFrequency === 'random' || d.proactiveFrequency === 'intense') setPushFreq(d.proactiveFrequency);
      if (d.thinkingLevel === 'off') setThinking('off');
      else if (d.thinkingLevel === 'max' && isPro === true) setThinking('max');
      else setThinking('high');
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  // 加载该用户全部可主动对象 + 静音状态，登录后开启时拉取
  useEffect(() => {
    if (!isLoggedIn() || !pushEnabled) return;
    let cancelled = false;
    getOutreachSubjects().then(d => {
      if (cancelled || !d || !Array.isArray(d.data)) return;
      setOutreachSubjects(d.data as any);
    }).catch(() => { /* 忽略 */ });
    return () => { cancelled = true; };
  }, [pushEnabled, pushFreq]);

  // 直达「主动找我」：加载完成后把开关滚动到可视区并短暂高亮（不自动开启）
  useEffect(() => {
    if (!focusProactivePush || !loaded) return;
    const el = pushRef.current;
    if (!el) return;
    const timer = setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setPushPulse(true);
      setTimeout(() => setPushPulse(false), 1600);
    }, 60);
    return () => clearTimeout(timer);
  }, [focusProactivePush, loaded]);

  // 会员档位探测：max 仅 Pro/Lifetime；非 Pro 归一化回 high，且不因缓存残留显示 max
  useEffect(() => {
    let cancelled = false;
    getQuota().then(r => {
      if (cancelled) return;
      const pro = !!(r.success && r.data && (r.data.plan === 'pro' || !!r.data.lifetime));
      setIsPro(pro);
      if (pro) {
        const c = getCachedPreferences();
        if (c?.thinkingLevel === 'max') setThinking('max');
        else if (c?.thinkingLevel === 'off') setThinking('off');
        else setThinking('high');
      } else {
        setThinking(prev => prev === 'max' ? 'high' : prev);
      }
    }).catch(() => setIsPro(false));
    return () => { cancelled = true; };
  }, []);

  const persist = (patch: Parameters<typeof savePreferences>[0]) => {
    savePreferences(patch).then(r => {
      if (r.success) {
        if (r.data) setCachedPreferences(r.data);
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      }
    }).catch(() => {});
  };

  const changeRegion = (r: Region) => {
    setRegion(r);
    // 用户主动设过地区 → 记一下，避免对话内「地区语气」轻提示重复打扰
    try { localStorage.setItem('cure_region_set', '1'); } catch { /* 忽略 */ }
    // 同步更新缓存：让下一句聊天请求立即带上新地区语气
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, region: r }); } catch { /* 忽略 */ }
    persist({ region: r });
  };
  const changeIntensity = (i: Intensity) => {
    setIntensity(i);
    // 同步更新缓存：让下一句聊天请求立即带上新语气程度（与地区语气一致，旧会话里切完立刻生效）
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, intensity: i }); } catch { /* 忽略 */ }
    persist({ intensity: i });
  };
  const changeSmartFit = (v: boolean) => { setSmartFit(v); persist({ smartFitEnabled: v }); };
  /**
   * 关系类型（2026-09-21）：受控时交给调用方写（内置小愈 → 用户级偏好；自定义角色 → 角色字段），
   * 未受控时按用户级偏好存（「我的-偏好」这类入口）。
   */
  const changeRelation = (r: ChatRelationKind) => {
    if (onRelationChange) { onRelationChange(r); return; }
    setRelationLocal(r);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, xiaoyuRelation: r }); } catch { /* 忽略 */ }
    persist({ xiaoyuRelation: r });
  };
  const changeChatInner = (v: boolean) => {
    setChatInner(v);
    // 同步写缓存：旧窗口切完立即发下一句，ChatPage 能马上带上新值，不等后端保存
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, chatInnerMonologueEnabled: v }); } catch { /* 忽略 */ }
    persist({ chatInnerMonologueEnabled: v });
  };
  const changeRoleplayInner = (v: boolean) => {
    setRoleplayInner(v);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, roleplayInnerMonologueEnabled: v }); } catch { /* 忽略 */ }
    persist({ roleplayInnerMonologueEnabled: v });
  };
  const changeThinking = (v: 'off' | 'high' | 'max') => {
    // max 仅 Pro/Lifetime；非 Pro 不落档，改为触发会员升级引导
    if (v === 'max' && isPro !== true) {
      onRequestMembership?.();
      return;
    }
    setThinking(v);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, thinkingLevel: v }); } catch { /* 忽略 */ }
    persist({ thinkingLevel: v });
  };
  const changeStoryStyle = (s: 'poetic' | 'concise' | 'warm' | 'abstract') => { setStoryStyle(s); persist({ storyStyle: s }); };
  // —— AI 主动找我（推送通知）——
  const changePush = async (v: boolean) => {
    if (pushBusy) return; // 防连点
    setPushBusy(true);
    setPushStatus(null);
    try {
      if (v) {
        const res = await subscribeToPush();
        if (res.ok) {
          await subscribePush(res.subscription);
          setPushEnabled(true);
          setPushStatus(null);
          persist({ proactivePush: true, proactiveFrequency: pushFreq });
          void reportTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
        } else if (isLoggedIn()) {
          // 推送不可用（iOS Safari 标签页没装主屏 / 大陆网络访问不到 Google 推送服务）→ 兜底通道：
          // 站内消息（写进「聊一聊」的未读）+ 长期未回时的邮件召回。
          // **这不是错误**，所以用琥珀提示（info），红色只留给「权限被拒 / 订阅失败」。
          setPushEnabled(true);
          setPushStatus(t('profileProactivePushEmailFallback'));
          setPushStatusKind('info');
          persist({ proactivePush: true, proactiveFrequency: pushFreq });
          void reportTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
        } else if (res.reason === 'denied') {
          setPushStatus(t('profileProactivePushDenied'));
          setPushStatusKind('error');
        } else {
          setPushStatus(t('profileProactivePushEmailNeedLogin'));
          setPushStatusKind('info');
        }
      } else {
        const endpoint = await unsubscribeFromPush();
        if (endpoint) await unsubscribePush(endpoint);
        setPushEnabled(false);
        persist({ proactivePush: false });
      }
    } catch (e) {
      setPushStatus(t('profileProactivePushDenied'));
      setPushStatusKind('error');
      console.warn('[Push] 开关操作失败:', (e as Error)?.message);
    } finally {
      setPushBusy(false);
    }
  };
  const changePushFreq = (v: 'random' | 'frequent' | 'occasional' | 'intense') => {
    setPushFreq(v);
    persist({ proactiveFrequency: v });
  };
  const handleMuteToggle = async (key: string, muted: boolean) => {
    if (mutedBusy) return;
    setMutedBusy(key);
    try {
      if (muted) await unmuteOutreachSubject(key); else await muteOutreachSubject(key);
      setOutreachSubjects(prev => prev.map(s => s.subjectKey === key ? { ...s, muted: !muted } : s));
    } catch { /* 忽略 */ } finally { setMutedBusy(null); }
  };
  const mutedCount = outreachSubjects.filter(s => s.muted).length;
  // 给自己发一条「测试推送」：用最近一次使用场景的角色口吻，跳过流失/冷却筛选（用于确认推送链路通）
  const sendTestPush = async () => {
    if (pushTestBusy) return;
    setPushTestBusy(true);
    setPushTestStatus(null);
    try {
      const res = await sendPushTestSelf();
      if (res.success) {
        const d = res.data || ({} as any);
        setPushTestStatus((d.ok ? '✅ ' : '❌ ') + (d.detail || (d.ok ? '已发送' : '发送失败')) + (d.senderName ? '（' + d.senderName + '）' : ''));
      } else {
        const d = (res.data || {}) as any;
        setPushTestStatus('❌ ' + ((res as any).error || d?.detail || '发送失败'));
      }
    } catch (e) {
      setPushTestStatus('❌ 网络错误');
      console.warn('[Push] 测试推送失败:', (e as Error)?.message);
    } finally {
      setPushTestBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-3 w-24 bg-gray-200 rounded mb-1.5" />
        <div className="grid grid-cols-2 gap-2">{[0, 1, 2, 3].map(i => <div key={i} className="h-9 bg-gray-200 rounded-lg" />)}</div>
        <div className="h-3 w-24 bg-gray-200 rounded mb-1.5" />
        <div className="flex gap-2">{[0, 1, 2].map(i => <div key={i} className="flex-1 h-9 bg-gray-200 rounded-lg" />)}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {showTone && !hideRelation && (
      <section>
        <GroupLabel>{t('profileRelationTitle')}</GroupLabel>
        <p className="text-[11px] text-ink-soft mb-1.5 leading-snug">{t('profileRelationSub')}</p>
        {/* 2026-09-23：换成全站统一的胶囊语言（原来它是面板里唯一还在用「深色填充」的一组） */}
        <OptionGroup
          cols={2}
          value={relation}
          onChange={changeRelation}
          options={RELATIONS.map(([v, labelKey, descKey]) => ({ key: v, label: t(labelKey), sub: t(descKey) }))}
        />
      </section>
      )}

      {showTone && (
      <section className="border-t border-clay-border/60 pt-3.5">
        <GroupLabel>{t('profileRegionTitle')}</GroupLabel>
        <p className="text-[11px] text-ink-soft mb-1.5 leading-snug">{t('profileRegionSub', { name: panelName })}</p>
        {/* 10 个地区原来 2 列铺 5 行、白占半个面板；改 5 列 × 2 行（英文 4 风格 → 一行 3 列） */}
        <div className={CHIP.track + ' ' + (isEn ? 'grid-cols-3' : 'grid-cols-5')}>
          {(isEn ? REGIONS_EN : REGIONS_ZH).map(([v, key]) => (
            <button key={v} type="button" onClick={() => changeRegion(v)}
aria-pressed={region === v}
className={CHIP.baseSm + ' ' + (region === v ? CHIP.on : CHIP.off)}>{t(key)}</button>
          ))}
        </div>
        {onFeedback && <p className="text-[11px] text-ink-soft mt-2 leading-snug">{t('fbRegionHint')}</p>}
      </section>
      )}

      {showTone && (
      <section className="border-t border-clay-border/60 pt-3.5">
        <GroupLabel>{t('profileIntensityTitle')}</GroupLabel>
        <div className={CHIP.track + ' grid-cols-3'}>
          {INTENSITIES.map(([v, key]) => (
            <button key={v} type="button" onClick={() => changeIntensity(v)}
aria-pressed={intensity === v}
className={CHIP.base + ' ' + (intensity === v ? CHIP.on : CHIP.off)}>{t(key)}</button>
          ))}
        </div>

        <ToggleRow className="mt-2" title={t('profileSmartFit')} desc={t('profileSmartFitDesc')} checked={smartFit} onChange={(v) => changeSmartFit(v)} />
      </section>
      )}

      {showTone && (
      <section className="border-t border-clay-border/60 pt-3.5">
        <GroupLabel>{t('profileInnerTitle')}</GroupLabel>
        <p className="text-[11px] text-ink-soft mb-1.5 leading-snug">{t('profileInnerSub')}</p>
        <div className="space-y-2">
          {showTone && (
          <ToggleRow title={t('profileInnerChat')} desc={t('profileInnerChatDesc')} checked={chatInner} onChange={(v) => changeChatInner(v)} />
          )}
          {variant === 'full' && (
          <ToggleRow title={t('profileInnerRoleplay')} desc={t('profileInnerRoleplayDesc')} checked={roleplayInner} onChange={(v) => changeRoleplayInner(v)} />
          )}
        </div>
      </section>
      )}

      {showTone && (
        <section className="border-t border-clay-border/60 pt-3.5">
          <GroupLabel>{t('profileDeepThink')}</GroupLabel>
          <p className="text-[11px] text-ink-soft mb-1.5 leading-snug">{t('profileDeepThinkDesc')}</p>
          <div className={CHIP.track + ' grid-cols-3'}>
            {(['off', 'high', 'max'] as const).map((v) => {
              const locked = v === 'max' && isPro !== true;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => changeThinking(v)}
                  aria-pressed={thinking === v}
                  aria-disabled={locked}
                  className={'relative rounded-xl px-1.5 py-2 text-center text-[13px] font-medium transition-colors ' + (locked
                    ? 'border border-dashed border-gray-300 text-ink-soft cursor-not-allowed'
                    : (thinking === v ? 'bg-white shadow-soft ring-1 ring-primary/30 text-primary-text font-semibold' : 'text-gray-600 hover:bg-white/60'))}
                >
                  {t(v === 'off' ? 'thinkOff' : v === 'high' ? 'thinkHigh' : 'thinkMax')}
                  {v === 'max' && <span className={'ml-1 text-[9px] font-bold align-middle ' + (locked ? 'text-ink-soft' : 'text-primary-text/70')}>Pro</span>}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {showGlobal && (
      <>
      <div>
        <div ref={pushRef} className={'flex items-center justify-between bg-white border rounded-lg px-3 py-2.5 transition-all ' + (pushPulse ? 'border-primary ring-2 ring-primary/40' : 'border-clay-border')}>
          <div className="flex-1 mr-2">
            <p className="text-sm font-medium text-ink">{t('profileProactivePush')}</p>
            <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{t('profileProactivePushDesc')}</p>
          </div>
          <button
            type="button"
            onClick={() => changePush(!pushEnabled)}
            className={'relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ' + (pushEnabled ? 'bg-primary' : 'bg-gray-300') + (pushBusy ? ' opacity-60 cursor-wait' : '')}
            aria-checked={pushEnabled}
            role="switch"
            aria-busy={pushBusy}
          >
            <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (pushEnabled ? 'left-[22px]' : 'left-0.5')} />
          </button>
        </div>

        {/* 「装到桌面/主屏」引导：没装好之前推送永远不会来，用户不会因为一行小字就去装 App */}
        {pwaInstall && (
          <PushInstallGuide
            installed={pwaInstall.installed}
            mode={pwaInstall.mode}
            pushUsable={pushUsable}
            promptInstall={pwaInstall.promptInstall}
          />
        )}

        {pushStatus && <p className={'text-[11px] leading-snug mt-1.5 ' + (pushStatusKind === 'info' ? 'text-amber-600' : 'text-red-500')}>{pushStatus}</p>}

        {pushEnabled && (
          <div className="mt-2 bg-white border border-clay-border rounded-lg px-3 py-2.5">
            <p className="text-xs font-semibold text-ink-soft mb-1.5">{t('profileProactiveFreq')}</p>
            <p className="text-[11px] text-ink-soft mb-1.5">{t('profileProactiveFreqDesc')}</p>
            <div className="grid grid-cols-4 gap-1 rounded-2xl border border-clay-border bg-clay-muted/50 p-1">
              {(['random', 'frequent', 'occasional', 'intense'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => changePushFreq(v)}
                  aria-pressed={pushFreq === v}
                  className={CHIP.base + ' ' + (pushFreq === v ? CHIP.on : CHIP.off)}
                >
                  {t('profileProactiveFreq' + (v === 'random' ? 'Random' : v === 'frequent' ? 'Frequent' : v === 'occasional' ? 'Occasional' : 'Intense'))}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-amber-600 leading-snug mt-2">{t('profileProactivePushHint')}</p>
            {isLoggedIn() && (
              <div className="mt-2.5 pt-2.5 border-t border-clay-border flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={sendTestPush}
                  disabled={pushTestBusy}
                  className={'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition ' + (pushTestBusy ? 'opacity-60 cursor-wait border-clay-border text-ink-soft' : 'border-primary text-primary hover:bg-primary-lighter')}
                >
                  {pushTestBusy ? '…' : '📲'} {t('profileProactiveTest')}
                </button>
                {pushTestStatus && <span className={'text-[11px] leading-snug ' + (pushTestStatus.startsWith('❌') ? 'text-red-500' : 'text-ink-soft')}>{pushTestStatus}</span>}
              </div>
            )}
            {isLoggedIn() && outreachSubjects.length > 0 && (
              <div className="mt-2.5 pt-2.5 border-t border-clay-border">
                <button
                  type="button"
                  onClick={() => setMuteOpen(o => !o)}
                  aria-expanded={muteOpen}
                  className="flex w-full items-center justify-between text-[12px] text-ink-soft hover:text-ink transition"
                >
                  <span>{t('profileProactiveMutedTitle')}{mutedCount > 0 ? `（${mutedCount}）` : ''}</span>
                  <span className="text-[10px] text-ink-soft">{muteOpen ? '▾' : '▸'}</span>
                </button>
                {muteOpen && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {outreachSubjects.map((s) => (
                      <div key={s.subjectKey} className="flex items-center justify-between gap-2">
                        <span className="text-[12px] text-ink-soft truncate">{s.label}</span>
                        <button
                          type="button"
                          disabled={mutedBusy === s.subjectKey}
                          onClick={() => handleMuteToggle(s.subjectKey, s.muted)}
                          className={'relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ' + (s.muted ? 'bg-gray-300' : 'bg-primary') + (mutedBusy === s.subjectKey ? ' opacity-60 cursor-wait' : '')}
                          aria-pressed={!s.muted}
                          aria-label={s.muted ? t('profileProactiveMutedUnmute') : t('profileProactiveMutedMute')}
                          title={s.muted ? t('profileProactiveMutedUnmute') : t('profileProactiveMutedMute')}
                        >
                          <span className={'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-[left] ' + (s.muted ? 'left-[2px]' : 'left-[18px]')} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </>
      )}

      {showStoryStyle && (
        <div>
          <p className="text-xs font-semibold text-ink-soft mb-1.5">{t('profileStoryStyle')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2">
            {STORY_STYLES.map(([v, key]) => (
              <button key={v} type="button" onClick={() => changeStoryStyle(v)}
aria-pressed={storyStyle === v}
className={CHIP.base + ' ' + (storyStyle === v ? CHIP.on : CHIP.off)}>{t(key)}</button>
            ))}
          </div>
        </div>
      )}

      {saved && <p className="text-xs text-primary-text text-center">{t('profilePrefSaved')}</p>}
    </div>
  );
}