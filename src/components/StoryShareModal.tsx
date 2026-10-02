/**
 * 故事书分享弹窗（通用）
 * 把一段「对话/剧情/情绪陪伴」渲染成符合小愈主题的长图，可保存/分享
 * 通用组件：聊天、理一理、角色扮演共用，保证分享样式一致
 * 支持「选择要分享的话」：默认全选，可只挑部分条目分享/复制
 */

import { useEffect, useRef, useState } from 'react';
import { Download, Copy, Check, CalendarDays, ListChecks, Image as ImageIcon, Share2 } from 'lucide-react';
import * as QRCode from 'qrcode';
import { toPng } from 'html-to-image';
import { t, getLang } from '../i18n';
import { SUPPORT_IG_URL } from '../lib/support';
import { useSkin } from './SkinProvider';
import RoleplayRichText from './RoleplayRichText';
import Modal from './ui/Modal';

export interface StoryBubble {
  side: 'me' | 'them';
  name: string;
  content: string;
  image?: string; // 用户发送的图片（base64 data URL）
  /** 引用回复：这条消息在回复哪一句（name=被引用那条的发言人，text=已收口好的引用正文）。
   *  由调用方（如 ChatPage）解析好再传进来——分享卡只管画，不重复实现定位/占位词逻辑。 */
  quote?: { name: string; text: string };
}

interface StoryShareModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  headerEmoji?: string;
  bubbles: StoryBubble[];
  /** 当前对话/剧情的「对方」名（如自定义角色）；传入后分享卡提供「隐藏角色名」开关 */
  partnerName?: string;
  /** 标题文案 key（含 {name} 占位）；与 partnerName 配合，隐藏角色名时用中性词替换标题中的名字 */
  titleNameKey?: string;
}

function fmtDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
}

function shareStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const SITE_SHARE_URL = 'https://myxiaoyu.com/';
// IG 主页统一走 lib/support.ts 的常量（与客服入口同一份，避免两处漂移）
const IG_PROFILE_URL = SUPPORT_IG_URL;
// 分享卡固定宽度 = 聊天页内容宽度（视口-24px≈366px + 卡片内边距24px = 390px），保证气泡换行与聊天完全一致
const SHARE_CARD_WIDTH = 390;

export default function StoryShareModal({ open, onClose, title, subtitle, bubbles, partnerName, titleNameKey }: StoryShareModalProps) {
  const { meta, bgWash } = useSkin();
  const cardRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [cardH, setCardH] = useState(0);
  const [imgUrl, setImgUrl] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareFallback, setShareFallback] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [hideName, setHideName] = useState(false);
  const [qrSite, setQrSite] = useState('');
  const [qrIg, setQrIg] = useState('');

  // —— 选择要分享的条目 ——
  const [selecting, setSelecting] = useState(false); // 当前是否在「选择中」（列出条目打勾）
  const [selected, setSelected] = useState<number[]>([]);
  const prevOpen = useRef(false);

  // 每次打开弹窗：重置为「全选」+ 预览态，避免换会话残留上次选择
  useEffect(() => {
    if (open && !prevOpen.current) {
      setSelected(bubbles.map((_, i) => i));
      setSelecting(false);
      setImgUrl('');
      setCopied(false);
      setShareFallback(false);
      setSharing(false);
      setHideName(false);
    }
    prevOpen.current = open;
  }, [open, bubbles]);

  // 生成分享卡底部的双小二维码（网站 + IG；预览卡可点，导出图片可扫码打开）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const qrOpts = { width: 96, margin: 1, color: { dark: '#243B2E', light: '#FFFFFF' } };
    QRCode.toDataURL(SITE_SHARE_URL, qrOpts).then(u => { if (alive) setQrSite(u); }).catch(e => console.error('QR 网站失败', e));
    QRCode.toDataURL(IG_PROFILE_URL, qrOpts).then(u => { if (alive) setQrIg(u); }).catch(e => console.error('QR IG 失败', e));
    return () => { alive = false; };
  }, [open]);

  // 预览等比缩放：把整张分享卡缩到弹窗可视宽度，不出现横向滚动条（导出仍按 SHARE_CARD_WIDTH 全宽输出）
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const w = previewRef.current?.clientWidth || SHARE_CARD_WIDTH;
      const scale = Math.min(1, w / SHARE_CARD_WIDTH);
      const h = cardRef.current?.offsetHeight || 0;
      setPreviewScale(scale);
      setCardH(h);
    };
    measure();
    const t = window.setTimeout(measure, 300); // 内容/图片加载后重测高度
    window.addEventListener('resize', measure);
    return () => { window.clearTimeout(t); window.removeEventListener('resize', measure); };
  }, [open, bubbles, selecting]);

  if (!open) return null;

  const toggle = (i: number) =>
    setSelected(s => (s.includes(i) ? s.filter(x => x !== i) : [...s, i].sort((a, b) => a - b)));
  const shareBubbles = bubbles.filter((_, i) => selected.includes(i));
  const empty = shareBubbles.length === 0;
  /** 引用块里的发言人名：勾了「隐藏角色名」时，被引用的「对方」也一并遮掉（隐私一致） */
  const quoteName = (b: StoryBubble): string => (hideName && partnerName && b.quote?.name === partnerName ? t('shareThem') : (b.quote?.name || ''));
  const multiBubble = bubbles.length > 1;
  // 标题：有具名角色时用「和 {name}…」模板（隐藏开关开启时替换为中性词 TA/your companion）
  const displayTitle = partnerName && titleNameKey ? t(titleNameKey, { name: hideName ? t('shareThem') : partnerName }) : title;

  const handleSave = async () => {
    const node = cardRef.current;
    if (!node || generating || empty) return;
    setGenerating(true);
    try {
      // 捕获可见卡（px3 保证清晰；不再用屏外 fixed 卡，避免 html-to-image 空白）
      const dataUrl = await toPng(node, {
        pixelRatio: 3,
        backgroundColor: '#FBF6EE',
        cacheBust: true,
        width: node.offsetWidth,
        height: node.offsetHeight,
      });
      setImgUrl(dataUrl);
      const a = document.createElement('a');
      a.href = dataUrl;
      // 文件名带时间戳，便于区分
      const ts = new Date();
      const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}-${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}`;
      a.download = 'xiaoyu-share-' + stamp + '.png';
      a.click();
    } catch (e) {
      console.error('生成分享图失败', e);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyText = async () => {
    const text = shareBubbles
      // 引用回复也带进文字稿：先一行「↩ 谁：被引用的那句」，再是本体（与长图/聊一聊里的观感一致）
      .map(b => [b.quote ? `↩ ${quoteName(b)}：${b.quote.text}` : '', b.name + '：' + (b.content || (b.image ? '[图片]' : ''))].filter(Boolean).join('\n'))
      .filter(line => line.trim().length > 0)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* 忽略 */ }
  };

  // —— 社交平台分享（混合形态：系统分享面板为主 + 平台直达为辅 + 复制/保存兜底） ——
  const capturePng = async (): Promise<File | null> => {
    const node = cardRef.current;
    if (!node || empty) return null;
    try {
      const dataUrl = await toPng(node, {
        pixelRatio: 3,
        backgroundColor: '#FBF6EE',
        cacheBust: true,
        width: node.offsetWidth,
        height: node.offsetHeight,
      });
      const blob = await (await fetch(dataUrl)).blob();
      return new File([blob], 'xiaoyu-share-' + shareStamp() + '.png', { type: 'image/png' });
    } catch (e) {
      console.error('生成分享图失败', e);
      return null;
    }
  };

  const shareViaSystem = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const file = await capturePng();
      if (!file) return;
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      if (nav && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: t('appName') });
          return; // 用户已交给系统面板/成功
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return; // 用户取消，静默
          console.error('系统分享失败', e);
        }
      }
      setShareFallback(true); // 桌面 / 设备不支持 → 一行兜底提示
    } finally {
      setSharing(false);
    }
  };

  // 分享卡片内容（预览用 100%，导出用隐藏宽卡 SHARE_W）——更宽让气泡文字更短、整图更均衡
  const renderShareCard = (width: string, items: StoryBubble[]) => {
    const bgAmbient = meta.bgPortrait || meta.bg || '/skins/healing/bg-portrait.webp?v=3';
    const bgHero = meta.hero || '/skins/healing/hero.webp?v=3';
    // 复用聊天页的「氛围背景深浅」：叠加同色 wash（透明度=用户 bgWash），让分享卡背景与用户看到的聊天背景虚化程度一致
    const washColor = typeof document !== 'undefined'
      ? (getComputedStyle(document.documentElement).getPropertyValue('--skin-bg-wash-color').trim() || '251 246 238')
      : '251 246 238';
    const bgWashLayer = `linear-gradient(rgb(${washColor} / ${bgWash}), rgb(${washColor} / ${bgWash}))`;
    return (
    <div className="relative bg-clay-bg" style={{ width }}>
      {/* 整卡背景：用户所选皮肤的竖版氛围底（=聊一聊背景），复用聊天「无厚遮罩、让氛围透出」的做法 */}
      <div aria-hidden className="absolute inset-0" style={{ backgroundImage: `${bgWashLayer}, url("${bgAmbient}")`, backgroundSize: '100% 100%', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} />
      <div className="relative">
        {/* 顶部：用户所选皮肤的 hero 主图 + Xiaoyu 字标 */}
        <div className="relative overflow-hidden text-white">
          <img src={bgHero} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover object-[50%_72%]" />
          <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-[rgba(0,0,0,0.42)] via-[rgba(0,0,0,0.18)] to-[rgba(0,0,0,0.08)]" />
          <div className="relative px-5 pt-4 pb-4">
            <div className="min-w-0">
              <p className="font-bold text-[14px] leading-tight">{t('appName')}</p>
              {subtitle && <p className="text-[10px] text-white/85 leading-snug mt-0.5">{subtitle}</p>}
            </div>
            <p className="relative mt-2.5 text-[16px] font-bold leading-snug">{displayTitle}</p>
            <div className="relative mt-1.5 flex items-center gap-1.5 text-[10px] text-white/85">
              <CalendarDays className="w-3 h-3" />
              <span>{fmtDate()}</span>
            </div>
          </div>
        </div>
        {/* 正文气泡：逐像素复刻聊一聊（行对齐/头像/内边距/字号与 ChatPage 一致） */}
        <div className="px-3 py-4 space-y-3">
          {items.map((b, i) => (
            <div key={i}>
              {b.image && (
                <div className={`flex ${b.side === 'me' ? 'justify-end' : 'justify-start'} mb-1`}>
                  <img src={b.image} alt="" className="max-w-[70%] max-h-56 rounded-2xl border border-gray-200 object-cover shadow-sm" />
                </div>
              )}
              {b.content && (
                <div className={`flex items-end gap-2 ${b.side === 'me' ? 'justify-end' : 'justify-start'}`}>
                  {b.side !== 'me' && (
                    <img src={meta.companion || '/skins/healing/companion.webp?v=3'} alt={t('appName')} className="w-7 h-7 rounded-full object-cover flex-shrink-0 mix-blend-multiply" />
                  )}
                  <div className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-line break-words shadow-sm ${
                    b.side === 'me' ? 'bg-primary text-white rounded-br-sm' : 'bg-white text-ink border border-gray-100 rounded-bl-sm'
                  }`}>
                    {/* 引用回复：与聊一聊逐像素一致（彩色气泡里用同族深色 + 白字，浅气泡里用淡薄荷 + 深绿字；
                        圆角 4px（同心）、正文由调用方收到约两行；这里只是画，不带交互） */}
                    {b.quote && (
                      <div className={`mb-1.5 rounded border-l-2 px-2.5 py-1.5 text-[12px] leading-snug ${
                        b.side === 'me' ? 'border-white/70 bg-primary-strong text-white' : 'border-primary bg-primary-lighter text-primary-text'
                      }`}>
                        <span className="font-medium">{quoteName(b)}：</span>{b.quote.text}
                      </div>
                    )}
                    {/* AI 侧（剧情/聊一聊）走三档渲染，与页面里看到的排版一致；用户侧直出原文 */}
                    {b.side === 'me' ? b.content : <RoleplayRichText text={b.content} lang={getLang()} />}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {/* 尾部（二维码并进各行 + 压缩留白）：预览可点，导出图片可扫码 */}
        <div className="px-4 pt-2.5 pb-2.5 text-center bg-white border-t border-clay-border">
          <div className="flex flex-col items-center gap-1.5 text-[12px] text-ink-soft">
            <div className="flex items-center gap-1.5">
              {qrSite && <img src={qrSite} alt={t('appName')} width={32} height={32} className="rounded-sm flex-shrink-0" loading="lazy" />}
              <a href={SITE_SHARE_URL} target="_blank" rel="noopener noreferrer" className="hover:underline decoration-dotted underline-offset-2" title={t('appName')}>myxiaoyu.com</a>
            </div>
            <div className="flex items-center gap-1.5">
              {qrIg && <img src={qrIg} alt={t('socialShareLine')} width={32} height={32} className="rounded-sm flex-shrink-0" loading="lazy" />}
              <a href={IG_PROFILE_URL} target="_blank" rel="noopener noreferrer" className="hover:underline decoration-dotted underline-offset-2" title={t('socialShareLine')}>{t('socialShareLine')}</a>
            </div>
          </div>
        </div>
      </div>
    </div>
    );
  };

  return (
    <Modal open={open} onClose={onClose} overlayClassName="z-[60] bg-black/60 flex items-center justify-center p-3" padding="p-4" maxHeight="max-h-[94vh]" overflow="" layout="flex">
        <h2 className="text-base font-bold text-gray-800 text-center mb-1">{displayTitle}</h2>
        <p className="text-xs text-ink-soft text-center mb-3">{t('chatShare')}</p>

        {/* 隐藏角色名开关（仅当分享对象是具名角色时显示，隐私用） */}
        {partnerName && titleNameKey && (
          <label className="flex items-center justify-center gap-1.5 mb-3 text-[12px] text-ink-soft select-none cursor-pointer">
            <input
              type="checkbox"
              checked={hideName}
              onChange={e => setHideName(e.target.checked)}
              className="w-3.5 h-3.5 accent-primary-strong"
            />
            {t('shareHideName')}
          </label>
        )}

        {/* 选择控制条（>1 条才显示） */}
        {multiBubble && (
          <div className="flex items-center justify-between gap-2 mb-2">
            {selecting ? (
              <>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setSelected(bubbles.map((_, i) => i))}
                    className="text-[12px] font-medium text-primary-text px-2 py-1 rounded-md hover:bg-primary-lighter"
                  >
                    {t('shareSelectAll')}
                  </button>
                  <button
                    onClick={() => setSelected([])}
                    className="text-[12px] font-medium text-ink-soft px-2 py-1 rounded-md hover:bg-gray-100"
                  >
                    {t('shareSelectNone')}
                  </button>
                </div>
                <button
                  onClick={() => setSelecting(false)}
                  disabled={empty}
                  className="flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1 rounded-full bg-primary-strong text-white hover:bg-primary transition-colors disabled:opacity-40"
                >
                  <Check className="w-3.5 h-3.5" /> {t('shareShareSelected', { n: selected.length })}
                </button>
              </>
            ) : (
              <button
                onClick={() => setSelecting(true)}
                className="flex items-center gap-1 text-[12px] font-medium text-primary-text px-2.5 py-1 rounded-full border border-primary/30 hover:bg-primary-lighter transition-colors"
              >
                <ListChecks className="w-3.5 h-3.5" /> {t('shareChooseMessages')}
              </button>
            )}
          </div>
        )}

        {/* 内容区：预览长图 或 选择列表 */}
        <div ref={previewRef} className="flex-1 overflow-y-auto rounded-2xl border border-clay-border bg-clay-bg">
          {selecting ? (
            <div className="p-2 space-y-2">
              {bubbles.map((b, i) => {
                const on = selected.includes(i);
                return (
                  <button
                    key={i}
                    onClick={() => toggle(i)}
                    className={"w-full flex items-start gap-2 text-left rounded-lg border px-2.5 py-2 transition-colors " + (on ? 'border-primary bg-primary-lighter/60' : 'border-clay-border bg-white')}
                  >
                    <span className={"mt-0.5 w-5 h-5 rounded-full flex items-center justify-center border flex-shrink-0 " + (on ? 'bg-primary border-primary text-white' : 'border-gray-300 text-transparent')}>
                      <Check className="w-3.5 h-3.5" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className={"block text-[11px] font-semibold " + (b.side === 'me' ? 'text-primary-text' : 'text-ink-soft')}>{(b.side === 'them' && hideName) ? t('shareThem') : b.name}</span>
                      {/* 选择列表里也让引用看得见（否则选了哪条、带不带引用没感觉） */}
                      {b.quote && (
                        <span className="block text-[11px] text-ink-soft leading-snug break-words line-clamp-1">
                          ↩ {quoteName(b)}：{b.quote.text}
                        </span>
                      )}
                      <span className="block text-[13px] text-gray-700 leading-snug break-words max-h-16 overflow-hidden">{b.content || (b.image ? '[图片]' : '')}</span>
                    </span>
                  </button>
                );
              })}
              {bubbles.length === 0 && <p className="py-10 text-center text-sm text-ink-soft">{t('chatShareEmpty')}</p>}
            </div>
          ) : (
            empty ? (
              <div className="py-16 text-center text-sm text-ink-soft">{t('chatShareEmpty')}</div>
            ) : (
              <div style={{ width: SHARE_CARD_WIDTH * previewScale, height: (cardH || 1) * previewScale }} className="relative">
                <div style={{ width: SHARE_CARD_WIDTH, transform: `scale(${previewScale})`, transformOrigin: 'top left' }}>
                  <div ref={cardRef}>{renderShareCard(SHARE_CARD_WIDTH + 'px', shareBubbles)}</div>
                </div>
              </div>
            )
          )}
        </div>

        {/* 生成结果图（长按保存） */}
        {imgUrl && (
          <div className="mt-3">
            <img src={imgUrl} alt={title} className="w-full max-h-[50vh] object-contain rounded-xl border border-gray-200" />
            <p className="text-[11px] text-ink-soft text-center mt-1.5">{t('chatShareHint')}</p>
          </div>
        )}

        {/* 操作按钮（仅预览态显示；选择态用顶部的「分享选中的」确认） */}
        {!selecting && (
          <div className="mt-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={handleCopyText}
                disabled={empty}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-clay-border text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40"
              >
                {copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
                {copied ? t('shareCopied') : t('chatShareCopy')}
              </button>
              <button
                onClick={handleSave}
                disabled={empty || generating}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-primary-strong text-white text-sm font-semibold hover:bg-primary transition-colors disabled:opacity-40"
              >
                {generating ? <ImageIcon className="w-4 h-4 animate-pulse" /> : <Download className="w-4 h-4" />}
                {generating ? t('chatShareGenerating') : t('chatShareSave')}
              </button>
            </div>

            {/* 一键分享（系统分享面板）：网页无法预选目标 App，故只保留一个入口 */}
            <button
              onClick={shareViaSystem}
              disabled={empty || sharing}
              className="mt-2 w-full flex items-center justify-center gap-1.5 py-3 rounded-xl bg-primary-strong text-white text-sm font-semibold hover:bg-primary transition-colors disabled:opacity-40"
            >
              {sharing ? <ImageIcon className="w-4 h-4 animate-pulse" /> : <Share2 className="w-4 h-4" />}
              {t('shareSystemShare')}
            </button>
            {/* 兜底：设备不支持系统分享时提示 */}
            {shareFallback && (
              <p className="mt-2 text-[12px] text-ink-soft">{t('shareGuideFallback')}</p>
            )}
          </div>
        )}
    </Modal>
  );
}
