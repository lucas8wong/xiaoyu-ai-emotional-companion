/**
 * AI 狼人杀 · 复盘卡「这局谁在骗你」
 *
 * 一局结束后把「真相」摊开给用户看：谁在骗你、谁怎么出局的、夜里到底发生了什么、
 * 桌上的角色各自是什么身份。这是本玩法最值得做成传播资产的一块。
 *
 * 实现要点（沿用项目既有分享经验）：
 *  - 用 `html-to-image` 的 `toPng` 捕获**可见**节点（`pixelRatio: 3`）。
 *    ⚠️ 项目踩过坑：早前用屏外 `fixed` 卡捕获会出空白图，所以卡必须真的渲染在可视流里。
 *  - 分享优先走系统面板（`navigator.share` + files），不支持时明确提示「先保存再上传」，不静默失败。
 */

import { useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { Copy, Download, Loader2, Share2, X } from 'lucide-react';

import { roleName, wwT } from '../werewolf/i18n';
import { buildReplay, replayCast, type ReplayTruth } from '../werewolf/replay';
import type { WerewolfView } from '../werewolf/engine/view';

interface Props {
  view: WerewolfView;
  onClose: () => void;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export default function WerewolfReplayCard({ view, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');
  const [hint, setHint] = useState('');

  const replay = buildReplay(view);
  const cast = replayCast(view);
  const me = view.players.find((p) => p.isYou);

  const truthText = (t: ReplayTruth): string => {
    const who = `${t.seat} ${t.name}`;
    switch (t.kind) {
      case 'wolfKill':
        return wwT('truthWolfKill', { who });
      case 'seerCheck':
        return wwT('truthSeerCheck', { who, camp: t.camp === 'wolf' ? wwT('wolfLabel') : wwT('villageLabel') });
      case 'witchHeal':
        return wwT('truthWitchHeal', { who });
      case 'witchPoison':
        return wwT('truthWitchPoison', { who });
      default:
        return '';
    }
  };

  const deathText = (by: string): string =>
    by === 'night' ? wwT('byNight') : by === 'vote' ? wwT('byVote') : wwT('byHunter');

  /** 捕获可见卡（pixelRatio 3 保证清晰） */
  const capture = async (): Promise<string | null> => {
    const node = cardRef.current;
    if (!node) return null;
    try {
      return await toPng(node, {
        pixelRatio: 3,
        backgroundColor: '#14100e',
        cacheBust: true,
        width: node.offsetWidth,
        height: node.offsetHeight,
      });
    } catch (e) {
      console.error('[Werewolf] 复盘卡生成失败', e);
      setErr(wwT('replayFail'));
      return null;
    }
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    const dataUrl = await capture();
    if (dataUrl) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `xiaoyu-werewolf-${stamp()}.png`;
      a.click();
    }
    setBusy(false);
  };

  const handleCopy = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const dataUrl = await capture();
      if (!dataUrl) throw new Error('capture failed');
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.error('[Werewolf] 复制复盘卡失败', e);
      setErr(wwT('replayFail'));
    }
    setBusy(false);
  };

  const handleShare = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    setHint('');
    try {
      const dataUrl = await capture();
      if (!dataUrl) throw new Error('capture failed');
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `xiaoyu-werewolf-${stamp()}.png`, { type: 'image/png' });
      const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
      if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
        await nav.share({ files: [file], title: wwT('replayTitle') });
      } else {
        // 不静默失败：明确告诉用户怎么自己上传
        setHint(wwT('replayShareHint'));
      }
    } catch (e) {
      // 用户取消分享也会走到这里，不当作错误处理
      console.warn('[Werewolf] 分享未完成', e);
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/45 flex items-start justify-center overflow-y-auto p-4" data-testid="ww-replay">
      <div className="w-full max-w-sm my-4">
        {/* 被捕获的卡（必须可见，避免 html-to-image 出空白图） */}
        <div
          ref={cardRef}
          className="bg-clay-bg rounded-3xl p-5 shadow-lift"
          style={{ backgroundColor: '#14100e' }}
          data-testid="ww-replay-card"
        >
          <div className="text-center">
            <div className="text-3xl">🐺</div>
            <div className="text-base font-bold text-ink mt-1">{wwT('replayTitle')}</div>
            <div className="text-xs text-ink-soft mt-1 leading-relaxed">{wwT(replay.headlineKey)}</div>
          </div>

          {/* 你的身份 */}
          <div className="mt-4 bg-clay-surface rounded-2xl px-3 py-2.5 flex items-center justify-between">
            <span className="text-xs text-ink-soft">{wwT('replayYourRole')}</span>
            <span className="text-sm font-bold text-ink">
              {me?.name} · {roleName(replay.myRole)}
              <span className={'ml-1.5 text-xs ' + (replay.iAmWolf ? 'text-red-600' : 'text-primary-text')}>
                {replay.iAmWolf ? wwT('campWolf') : wwT('campVillage')}
              </span>
            </span>
          </div>

          {/* 骗你的人 / 你的同伙 */}
          <div className="mt-2.5 bg-clay-surface rounded-2xl px-3 py-2.5">
            <div className="text-xs text-ink-soft mb-1.5">{replay.iAmWolf ? wwT('replayPack') : wwT('replayLiars')}</div>
            <div className="flex flex-wrap gap-1.5">
              {replay.liars.length ? (
                replay.liars.map((p) => (
                  <span key={p.seat} className="text-[11px] px-2 py-1 rounded-full bg-red-50 text-red-700">
                    {p.seat} {p.name} · {roleName(p.role)}
                  </span>
                ))
              ) : (
                <span className="text-[11px] text-ink-soft">—</span>
              )}
            </div>
          </div>

          {/* 把你票出去的人 */}
          {replay.votedMeOut.length ? (
            <div className="mt-2.5 bg-clay-surface rounded-2xl px-3 py-2.5">
              <div className="text-xs text-ink-soft mb-1.5">{wwT('replayVotedMeOut')}</div>
              <div className="text-xs text-ink">{replay.votedMeOut.map((p) => `${p.seat} ${p.name}`).join('、')}</div>
            </div>
          ) : null}

          {/* 夜里的真相 */}
          {replay.truths.length ? (
            <div className="mt-2.5 bg-clay-surface rounded-2xl px-3 py-2.5">
              <div className="text-xs text-ink-soft mb-1.5">{wwT('replayTruths')}</div>
              <ul className="space-y-1">
                {replay.truths.map((t, i) => (
                  <li key={i} className="text-xs text-ink flex gap-1.5">
                    <span className="text-ink-soft shrink-0">{wwT('replayRound', { n: t.round })}</span>
                    <span>{truthText(t)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 谁怎么出局的 */}
          {replay.deaths.length ? (
            <div className="mt-2.5 bg-clay-surface rounded-2xl px-3 py-2.5">
              <div className="text-xs text-ink-soft mb-1.5">{wwT('replayDeaths')}</div>
              <ul className="space-y-1">
                {replay.deaths.map((d, i) => (
                  <li key={i} className="text-xs text-ink flex gap-1.5">
                    <span className="text-ink-soft shrink-0">{wwT('replayRound', { n: d.round })}</span>
                    <span>
                      {d.seat} {d.name}（{roleName(d.role)}）· {deathText(d.by)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 陪你这局的角色 */}
          <div className="mt-2.5 bg-clay-surface rounded-2xl px-3 py-2.5">
            <div className="text-xs text-ink-soft mb-1.5">{wwT('replayCast')}</div>
            <div className="flex flex-wrap gap-1.5">
              {cast.map((p) => (
                <span key={p.seat} className="text-[11px] px-2 py-1 rounded-full bg-clay-muted text-ink">
                  {p.name}
                  {p.role !== 'unknown' ? ` · ${roleName(p.role)}` : ''}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-4 text-center text-[11px] text-ink-soft">myxiaoyu.com</div>
        </div>

        {/* 操作区（不进卡片，避免被一起截图） */}
        <div className="mt-3">
          {err ? <div className="text-xs text-red-200 mb-2 text-center">{err}</div> : null}
          {hint ? <div className="text-xs text-white/85 mb-2 text-center">{hint}</div> : null}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={handleSave}
              disabled={busy}
              data-testid="ww-replay-save"
              className="py-2.5 rounded-xl bg-clay-surface text-ink text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {wwT('replaySave')}
            </button>
            <button
              onClick={handleCopy}
              disabled={busy}
              className="py-2.5 rounded-xl bg-clay-surface text-ink text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Copy className="w-3.5 h-3.5" />
              {copied ? wwT('replayCopied') : wwT('replayCopy')}
            </button>
            <button
              onClick={handleShare}
              disabled={busy}
              className="py-2.5 rounded-xl bg-primary text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Share2 className="w-3.5 h-3.5" />
              {wwT('replayShare')}
            </button>
          </div>
          <button
            onClick={onClose}
            data-testid="ww-replay-close"
            className="mt-2 w-full py-2.5 rounded-xl border border-white/40 text-white/90 text-xs font-semibold flex items-center justify-center gap-1.5"
          >
            <X className="w-3.5 h-3.5" />
            {wwT('replayClose')}
          </button>
        </div>
      </div>
    </div>
  );
}
