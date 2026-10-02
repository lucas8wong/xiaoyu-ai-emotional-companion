/**
 * «与你的旅程» 弹窗 · B 版（可滚动「星图/时间轴」，纯代码，不生成任何图片）
 * 把陪伴证据（初次相遇 / 心情打卡与趋势 / 关系记忆 / 自画像 / 它记得的关于你 / 你喜欢的剧情）
 * 串成一幅可回访的星图时间线。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Compass, Heart, CalendarDays, Sparkles, Bird, GitCommitHorizontal, BookOpen, Milestone, ChevronDown, MessageCircleHeart, Drama } from 'lucide-react';
import { getJourney, type JourneyData, type JourneyCharacter, type JourneyMoment } from '../services/api';
import { t, getLang } from '../i18n';
import { memoryWhenText } from '../lib/memoryTime';
import { useSkin } from './SkinProvider';
import Modal from './ui/Modal';

interface JourneyModalProps {
  open: boolean;
  onClose: () => void;
  /** 空态直达：进聊一聊 / 理一理 / 剧情扮演（由上层关闭弹窗并跳转） */
  onStartChat?: () => void;
  onStartStructure?: () => void;
  onStartRoleplay?: () => void;
}

const MOOD_EMOJI: Record<string, string> = {
  happy: '😊', calm: '😌', neutral: '😐', sad: '😔',
  anxious: '😟', angry: '😠', tired: '😴', grateful: '🥰',
};

const MOMENT_LABEL: Record<JourneyMoment['type'], string> = {
  first: 'journeyFirst',
  mood: 'journeyMood',
  memory: 'journeyMemory',
  portrait: 'journeyPortrait',
  like: 'journeyLike',
};

/** “与 TA 的瞬间”默认预览条数（超出收进「更多/收起」折叠） */
const MOMENT_PREVIEW = 3;

/** “你去过的剧情”默认预览条数（超出收进「更多/收起」折叠） */
const STORY_PREVIEW = 6;

/**
 * 自建剧本内部 id 兜底：数据层（`api/services/scenarioTitle.ts`）已统一解析成用户自己起的剧名，
 * 这里只防「极端情况下内部 id 露到界面上」。两种前缀都要认——角色扮演自建是 `custom_`，
 * 千世书自建是 `custom-`（此前只写下划线，于是千世书自建书在旅程里一直显示 `custom-xxxx`）。
 */
const isCustomId = (title: string): boolean => /^custom[_-]/i.test(String(title || ''));

/** 真名（解析不到的旧 id 视为「没有名字」）；没名字时前端才用兜底文案 */
const storyName = (title?: string): string => (title && !isCustomId(title) ? title : '');

const MOMENT_COLOR: Record<JourneyMoment['type'], string> = {
  first: 'border-primary',
  mood: 'border-amber-400',
  memory: 'border-sky-400',
  portrait: 'border-violet-400',
  like: 'border-pink-400',
};

function displayName(c: { isDefault: boolean; name: string }): string {
  return c.isDefault ? (getLang() === 'en' ? 'Xiaoyu' : '小愈') : c.name;
}

/** 统一的 bullet 圆点：大小与“TA 记得的关于你”一致，颜色随皮肤（--color-primary） */
function BulletDot() {
  return <span className="mt-[7px] w-1 h-1 rounded-full bg-primary flex-shrink-0" aria-hidden="true" />;
}

function formatDate(ms: number): string {
  try {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch { return ''; }
}

function MomentIcon({ type }: { type: JourneyMoment['type'] }) {
  if (type === 'mood') return <CalendarDays className="w-4 h-4 text-amber-700" />;
  if (type === 'portrait') return <Sparkles className="w-4 h-4 text-violet-500" />;
  if (type === 'memory') return <GitCommitHorizontal className="w-4 h-4 text-sky-500" />;
  if (type === 'like') return <BookOpen className="w-4 h-4 text-pink-500" />;
  return <Heart className="w-4 h-4 text-primary" />;
}

function GroupTimeline({ moments, className }: { moments: JourneyMoment[]; className?: string }) {
  let lastMonth = '';
  return (
    <div className={`relative pl-6 ${className || ''}`}>
      {/* 时间轴：细线 + 类型彩色圆点 */}
      <div className="absolute left-[10px] top-1 bottom-1 w-px bg-gray-200" />
      <div className="space-y-3">
        {moments.map((m, i) => {
          const month = m.date.slice(0, 7);
          const sep = month !== lastMonth;
          lastMonth = month;
          return (
            <div key={i}>
              {sep && (
                <div className="flex items-center gap-2 mb-1 -ml-1">
                  <span className="text-[10px] font-semibold text-ink-soft">{month}</span>
                  <span className="h-px flex-1 bg-gray-100" />
                </div>
              )}
              <div className="relative">
                <span className={`absolute -left-[15px] top-1.5 w-3 h-3 rounded-full border-2 bg-white ${MOMENT_COLOR[m.type]} shadow-sm`} />
                <div className="bg-white/85 border border-gray-100 rounded-xl px-3 py-2.5 shadow-sm">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-[10px] font-medium text-ink-soft inline-flex items-center gap-1">
                      <MomentIcon type={m.type} />
                      {t(MOMENT_LABEL[m.type])}
                      {m.characterName && (
                        <span className="text-ink-soft">· {m.characterName === '小愈' ? displayName({ isDefault: true, name: '小愈' }) : m.characterName}</span>
                      )}
                    </span>
                    <span className="text-[10px] text-ink-soft whitespace-nowrap">{m.date}</span>
                  </div>
                  {m.type === 'mood' && (
                    <p className="text-sm text-gray-700">
                      <span className="text-xl mr-1 align-middle">{MOOD_EMOJI[m.mood || ''] || m.mood || ''}</span>
                      {m.note && <span className="text-gray-600">{m.note}</span>}
                    </p>
                  )}
                  {(m.type === 'memory' || m.type === 'portrait' || m.type === 'like') && m.text && (
                    <p className="text-sm text-gray-700 leading-relaxed">{m.text}</p>
                  )}
                  {m.type === 'first' && (
                    <p className="text-sm text-ink-soft">{t('journeyFirstSub')}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CharacterCard({ c, skinAvatar, moments }: { c: JourneyCharacter; skinAvatar: string; moments: JourneyMoment[] }) {
  const name = displayName(c);
  const [open, setOpen] = useState(false);
  const [moreMemories, setMoreMemories] = useState(false);
  const [moreMoments, setMoreMoments] = useState(false);
  // 自画像：line-clamp 折叠 + 「展开全文/收起」切换（仅在真正截断时才显示入口）
  const [portraitOpen, setPortraitOpen] = useState(false);
  const [portraitOverflow, setPortraitOverflow] = useState(false);
  const portraitRef = useRef<HTMLParagraphElement>(null);
  const facts = c.facts || [];
  // 带时间轴的记忆（2026-09-17）：优先用 factEntries 显示「记住于 X」；老接口只回 facts 时降级为纯文本
  const factItems: { text: string; meta?: string }[] = (c.factEntries && c.factEntries.length
    ? c.factEntries.map(e => ({ text: e.text, meta: memoryWhenText(e) }))
    : facts.map(text => ({ text })));
  const mem = c.relationMemories || [];
  const avatar = c.isDefault ? skinAvatar : (c.avatar || skinAvatar); // 与聊一聊 avatarFor 一致
  const stamps = [
    c.daysKnown > 0 && { key: 'first', label: t('journeyStampFirst') },
    c.daysKnown >= 30 && { key: 'day30', label: t('journeyStampDay30') },
    c.daysKnown >= 100 && { key: 'day100', label: t('journeyStampDay100') },
    c.daysKnown >= 365 && { key: 'year', label: t('journeyStampYear') },
    (c.milestones || []).includes(30) && { key: 'round30', label: t('journeyStampRound30') },
    (c.milestones || []).includes(100) && { key: 'round100', label: t('journeyStampRound100') },
    (c.milestones || []).includes(300) && { key: 'round300', label: t('journeyStampRound300') },
    c.streak >= 7 && { key: 'streak7', label: t('journeyStampStreak7') },
  ].filter(Boolean) as { key: string; label: string }[];
  const hasSections = stamps.length > 0 || !!c.selfPortrait || facts.length > 0 || mem.length > 0 || moments.length > 0;
  const shownMem = moreMemories ? mem : mem.slice(-6);
  const shownMoments = moreMoments ? moments : moments.slice(0, MOMENT_PREVIEW);
  // 检测自画像是否被 line-clamp 截断，以便只在该显示「展开全文」入口时展示
  useEffect(() => {
    const el = portraitRef.current;
    if (!el) { setPortraitOverflow(false); return; }
    const measure = () => setPortraitOverflow(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [c.selfPortrait?.text, open]);
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
      {/* 折叠头：点击展开/收起 */}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center gap-2.5 p-4 text-left">
        <div className="w-9 h-9 relative rounded-full overflow-hidden bg-primary-lighter flex items-center justify-center flex-shrink-0">
          <Bird className="w-5 h-5 text-primary" />
          <img
            src={avatar}
            alt={name}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-800 truncate">{name}</p>
          <p className="text-xs text-ink-soft truncate">
            {c.daysKnown > 0 ? t('journeyDaysKnown', { n: c.daysKnown }) : t('journeyJustMet')}
            {hasSections && <span className="text-ink-soft"> · {t('journeyCollapsedMeta', { stamps: stamps.length, memories: mem.length })}</span>}
          </p>
        </div>
        {c.streak > 0 && (
          <span className="text-[11px] bg-primary-lighter text-primary-text px-2 py-1 rounded-full border border-clay-border flex-shrink-0">
            🔥 {t('journeyStreak', { n: c.streak })}
          </span>
        )}
        <ChevronDown className={`w-4 h-4 text-ink-soft flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
          {stamps.length > 0 && (
            <section>
              <h4 className="text-[11px] font-medium text-ink-soft mb-1.5 flex items-center gap-1">
                <Milestone className="w-3 h-3" /> {t('journeyStampsTitle')}
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {stamps.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-primary-lighter text-primary-text border border-clay-border">
                    <Milestone className="w-3 h-3" /> {s.label}
                  </span>
                ))}
              </div>
            </section>
          )}

          <section>
            <h4 className="text-[11px] font-medium text-ink-soft mb-1.5 flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> {t('journeyPortrait')}
            </h4>
            {c.selfPortrait ? (
              <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
                <p
                  ref={portraitRef}
                  className={`text-sm text-gray-700 leading-relaxed ${portraitOpen ? '' : 'line-clamp-4'}`}
                >
                  {c.selfPortrait.text}
                </p>
                {(portraitOpen || portraitOverflow) && (
                  <button
                    onClick={() => setPortraitOpen((o) => !o)}
                    className="text-[11px] text-primary hover:underline mt-1.5"
                  >
                    {portraitOpen ? t('journeyCollapse') : t('journeyExpand')}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-soft">{t('journeyPortraitEmpty')}</p>
            )}
          </section>

          <section>
            <h4 className="text-[11px] font-medium text-ink-soft mb-1.5 flex items-center gap-1">
              <GitCommitHorizontal className="w-3 h-3" /> {t('journeyFactsTitle')}
            </h4>
            {facts.length > 0 ? (
              <ul className="space-y-1">
                {factItems.slice(-6).map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700 leading-snug">
                    <BulletDot />
                    <span>
                      {f.text}
                      {f.meta && <span className="block mt-0.5 text-[10px] leading-none text-ink-soft">{f.meta}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-soft">{t('journeyFactsEmpty')}</p>
            )}
          </section>

          {mem.length > 0 && (
            <section>
              <h4 className="text-[11px] font-medium text-ink-soft mb-1.5 flex items-center gap-1">
                <MessageCircleHeart className="w-3 h-3" /> {t('journeyRelationTitle')} · {mem.length}
              </h4>
              <ul className="space-y-1">
                {shownMem.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700 leading-snug">
                    <BulletDot />
                    <span>{r.text}</span>
                  </li>
                ))}
              </ul>
              {mem.length > 6 && (
                <button onClick={() => setMoreMemories((o) => !o)} className="text-[11px] text-primary hover:underline mt-2">
                  {moreMemories ? t('journeyLess') : t('journeyMore', { n: mem.length - 6 })}
                </button>
              )}
            </section>
          )}

          {moments.length > 0 && (
            <section>
              <h4 className="text-[11px] font-medium text-ink-soft mb-1.5 flex items-center gap-1">
                <Heart className="w-3 h-3" /> {t('journeyWithThem')} · {moments.length}
              </h4>
              <GroupTimeline moments={shownMoments} />
              {moments.length > MOMENT_PREVIEW && (
                <button onClick={() => setMoreMoments((o) => !o)} className="text-[11px] text-primary hover:underline mt-2">
                  {moreMoments ? t('journeyLess') : t('journeyMore', { n: moments.length - MOMENT_PREVIEW })}
                </button>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export default function JourneyModal({ open, onClose, onStartChat, onStartStructure, onStartRoleplay }: JourneyModalProps) {
  const { meta, skin } = useSkin(); // 与聊一聊一致：默认头像跟随皮肤
  const skinAvatar = meta.companion || '/skins/healing/companion.webp?v=3';
  // 与首页功能入口一致：healing 用小愈治愈系「圆形裁剪」，其它皮肤用圆角方块
  const entryImgShape = skin === 'healing' ? 'rounded-full' : 'rounded-2xl';
  const [data, setData] = useState<JourneyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [moreStories, setMoreStories] = useState(false);
  // 三个直达按钮的图标：用皮肤里对应的入口 logo（聊一聊/理一理/剧情扮演），与首页功能入口一致；无对应图回退 Lucide 图标
  const chatEntryImg = meta.chatSm || meta.chat;
  const structureEntryImg = meta.structureSm || meta.structure;
  const storyEntryImg = meta.storySm || meta.story;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    setData(null);
    getJourney().then((r) => {
      setLoading(false);
      if (r.success && r.data) setData(r.data);
      else setError(r.error || t('errLoad'));
    });
  }, [open]);

  const summary = useMemo(() => data?.summary, [data]);
  const moodTrend = useMemo(
    () => (data?.moments || []).filter((m) => m.type === 'mood').slice(0, 14).reverse(),
    [data],
  );
  // 每个角色的瞬间（其专属时间线），按 characterId 分
  const momentsByChar = useMemo(() => {
    const map = new Map<string, JourneyMoment[]>();
    for (const m of data?.moments || []) {
      if (!m.characterId) continue;
      const cur = map.get(m.characterId);
      if (cur) cur.push(m); else map.set(m.characterId, [m]);
    }
    return map;
  }, [data]);
  // 「你去过的剧情」：玩过的(played) + 喜欢的(liked) 合并去重，用户级（所有角色都知道）。
  // 每条带 custom 标志（用户自建 → 剧名旁给一个「自建」标志，不显示「自定义剧情」这类占位），
  // deleted 标志＝这个自建剧本已被创作者删掉（名字可能只剩兜底文案，但要看得出来是已删的）。
  const visitedStories = useMemo(() => {
    const seen = new Set<string>();
    const out: { key: string; title: string; at: number; liked: boolean; kind?: 'roleplay' | 'wenyou'; custom: boolean; deleted: boolean }[] = [];
    for (const s of data?.stories || []) {
      const key = s.title || s.scenarioId;
      if (key && !seen.has(key)) { out.push({ key, title: s.title, at: s.at, liked: false, kind: s.kind, custom: !!s.custom, deleted: !!s.deleted }); seen.add(key); }
    }
    for (const m of data?.moments || []) {
      if (m.type === 'like' && m.text && !seen.has(m.text)) { out.push({ key: m.text, title: m.text, at: m.at, liked: true, kind: 'roleplay' as const, custom: !!m.custom, deleted: !!m.deleted }); seen.add(m.text); }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [data]);
  const shownStories = moreStories ? visitedStories : visitedStories.slice(0, STORY_PREVIEW);

  if (!open) return null;

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  } else if (error) {
    body = <p className="text-center text-red-500 py-10">{error}</p>;
  } else if (!data || (data.moments.length === 0 && visitedStories.length === 0 && data.characters.every((c) => !c.daysKnown && !c.selfPortrait && (c.facts || []).length === 0 && (c.relationMemories || []).length === 0))) {
    body = (
      <div className="text-center py-12 text-ink-soft">
        {/* 顶部已有皮肤爱心 logo，此处不重复放第二个图标 */}
        <p className="text-gray-600 font-medium">{t('journeyEmpty')}</p>
        <p className="text-sm mt-1">{t('journeyEmptySub')}</p>
        {/* 三个直达入口：等比例模拟首页——聊一聊/剧情演绎两张卡并列，理一理为下方居中二级入口 */}
        <div className="mt-6 max-w-md mx-auto">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { onClose(); onStartChat?.(); }}
              className="group text-center card-white rounded-xl px-2 py-3 shadow-lg border-2 border-clay-border hover:border-primary hover:shadow-xl transition-all duration-200"
            >
              <span className={`inline-flex w-10 h-10 ${entryImgShape} overflow-hidden items-center justify-center mx-auto mb-1.5 border border-clay-border shadow-sm bg-clay-bg`}>
                {chatEntryImg ? <img src={chatEntryImg} alt="" className="w-full h-full object-cover" /> : <MessageCircleHeart className="w-5 h-5" />}
              </span>
              <span className="block text-[13px] font-bold text-gray-800 leading-tight">{t('entryChatTitle')}</span>
              <span className="block text-[10px] text-ink-soft leading-tight mt-0.5">{t('entryChatShort')}</span>
            </button>
            <button
              onClick={() => { onClose(); onStartRoleplay?.(); }}
              className="group text-center card-white rounded-xl px-2 py-3 shadow-lg border-2 border-clay-border hover:border-primary hover:shadow-xl transition-all duration-200"
            >
              <span className={`inline-flex w-10 h-10 ${entryImgShape} overflow-hidden items-center justify-center mx-auto mb-1.5 border border-clay-border shadow-sm bg-clay-bg`}>
                {storyEntryImg ? <img src={storyEntryImg} alt="" className="w-full h-full object-cover" /> : <Drama className="w-5 h-5" />}
              </span>
              <span className="block text-[13px] font-bold text-gray-800 leading-tight">{t('rpModuleTitle')}</span>
              <span className="block text-[10px] text-ink-soft leading-tight mt-0.5">{t('roleplayShort')}</span>
            </button>
          </div>
          <div className="mt-3 flex justify-center">
            <button
              onClick={() => { onClose(); onStartStructure?.(); }}
              className="group mx-auto flex items-center justify-center gap-2 text-sm text-primary-text rounded-full border border-clay-border bg-white/70 hover:bg-primary-lighter hover:border-primary hover:shadow-md transition-all px-5 py-2.5"
            >
              <span className={`inline-flex w-6 h-6 ${entryImgShape} overflow-hidden items-center justify-center border border-clay-border shadow-sm bg-clay-bg flex-shrink-0 group-hover:scale-105 transition-transform`}>
                {structureEntryImg ? <img src={structureEntryImg} alt="" className="w-full h-full object-cover" /> : <Compass className="w-4 h-4" />}
              </span>
              <span className="leading-tight">{t('entryStructureLink')}</span>
            </button>
          </div>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-5">
        {summary && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[
              { n: summary.daysKnown, label: t('journeyDaysKnown', { n: summary.daysKnown }) },
              { n: summary.moodStreak, label: t('journeyMoodStreak', { n: summary.moodStreak }) },
              { n: summary.checkins, label: t('journeyCheckins', { n: summary.checkins }) },
              { n: summary.characters, label: t('journeyCharacters', { n: summary.characters }) },
              { n: summary.memories, label: t('journeyMemories', { n: summary.memories }) },
              { n: summary.likes, label: t('journeyLikesSummary', { n: summary.likes }) },
            ].map((s, i) => (
              <div key={i} className="bg-primary-lighter border border-clay-border rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-primary-text">{s.n}</p>
                <p className="text-[11px] text-ink-soft mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {moodTrend.length > 0 && (
          <div className="bg-white/70 border border-gray-100 rounded-xl p-4">
            <h3 className="font-semibold text-gray-800 mb-2 text-sm flex items-center gap-1.5">
              <CalendarDays className="w-4 h-4 text-amber-700" /> {t('journeyMoodTrend')}
            </h3>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {moodTrend.map((m, i) => (
                <div key={i} className="flex flex-col items-center flex-shrink-0 min-w-[64px]">
                  <span className="text-2xl">{MOOD_EMOJI[m.mood || ''] || m.mood || '·'}</span>
                  {m.note && <span className="text-[10px] text-ink-soft leading-tight line-clamp-2 max-w-[72px] text-center mt-1">{m.note}</span>}
                  <span className="text-[10px] text-ink-soft mt-1">{m.date.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {visitedStories.length > 0 && (
          <div className="bg-white/70 border border-gray-100 rounded-xl p-4">
            <h3 className="font-semibold text-gray-800 mb-2 text-sm flex items-center gap-1.5">
              <BookOpen className="w-4 h-4 text-primary" /> {t('journeyStoriesTitle')} · {visitedStories.length}
            </h3>
            <p className="text-[11px] text-ink-soft mb-2">{t('journeyStoriesSub')}</p>
            <div className="flex flex-wrap gap-2">
              {shownStories.map((st) => {
                const name = storyName(st.title);
                return (
                  <span key={st.key + st.at} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full bg-primary-lighter text-primary-text border border-clay-border max-w-full">
                    {st.kind === 'wenyou' ? (
                      <span className="text-[10px] font-bold text-violet-600 flex-shrink-0">{t('journeyWenyouTag')}</span>
                    ) : (
                      <BookOpen className="w-3 h-3 flex-shrink-0" />
                    )}
                    {/* 用户自建：给出「自建」标志（与「文游」标志同款），剧名仍是用户自己起的那个 */}
                    {st.custom && name && (
                      <span className="text-[10px] font-bold text-amber-600 flex-shrink-0">{t('journeyCustomTag')}</span>
                    )}
                    <span className="truncate">{name || t('journeyCustomStory')}</span>
                    {/* 自建剧本已被创作者删除：明确标出来（否则「自建剧情」看起来像没起名） */}
                    {st.deleted && (
                      <span className="text-[10px] font-bold text-ink-soft flex-shrink-0">{t('journeyCustomDeletedTag')}</span>
                    )}
                    {st.liked && <Heart className="w-3 h-3 text-pink-500 flex-shrink-0" />}
                    <span className="text-ink-soft whitespace-nowrap flex-shrink-0">{formatDate(st.at)}</span>
                  </span>
                );
              })}
            </div>
            {visitedStories.length > STORY_PREVIEW && (
              <button onClick={() => setMoreStories((o) => !o)} className="text-[11px] text-primary hover:underline mt-2">
                {moreStories ? t('journeyLess') : t('journeyMore', { n: visitedStories.length - STORY_PREVIEW })}
              </button>
            )}
          </div>
        )}

        {data.characters.length > 0 && (
          <div>
            <h3 className="font-semibold text-gray-800 mb-2 text-sm">{t('journeyCompanions')}</h3>
            <div className="space-y-3">
              {data.characters.map((c) => (
                <CharacterCard key={c.id} c={c} skinAvatar={skinAvatar} moments={momentsByChar.get(c.id) || []} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal open={open} onClose={onClose} width="max-w-2xl" maxHeight="max-h-[92vh]" overflow="" layout="flex">
        <div className="text-center mb-5">
          {/* 顶部 logo：用皮肤 hero 的爱心 logo（与首页 hero 一致）；个别皮肤无爱心图时回退 Compass */}
          <div className="w-14 h-14 rounded-full overflow-hidden bg-white ring-4 ring-white/50 shadow-lift mx-auto mb-3">
            {meta.heart ? (
              <img src={meta.heart} alt={t('appName')} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center"><Compass className="w-7 h-7 text-primary" /></div>
            )}
          </div>
          <h2 className="text-xl font-bold text-gray-800">{t('journeyTitle')}</h2>
          <p className="text-sm text-ink-soft mt-1">{t('journeySubtitle')}</p>
        </div>

        <div className="flex-1 overflow-y-auto">{body}</div>

        <div className="pt-4">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t('journeyClose')}
          </button>
        </div>
    </Modal>
  );
}
