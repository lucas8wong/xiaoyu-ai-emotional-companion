/**
 * AI 狼人杀 · 对局页面
 *
 * 挂载方式与「AI 文游（千世书）」一致：由 `RoleplayPage` 以一级模式的形式挂进来（懒加载独立分包）。
 *
 * 关键约束（来自引擎设计）：
 *  - 页面**只渲染服务端下发的 `view`**。底牌、狼队友、验人结果都由服务端按视角过滤后才会出现，
 *    前端不做任何「猜身份」的推断，否则等于绕过了防作弊那一层。
 *  - 事件只带结构化参数（seat/target/role），文案在 `renderEvent` 里按三语拼。
 *  - 服务端每次请求只推进一小段（防边缘超时），所以「既没轮到我、也没结束」时要循环 `/advance`。
 */

// 复古暗调主题（品牌红线 #4 的放宽范围仅限本屏，见 theme.css 顶部说明）
import '../werewolf/theme.css';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Crosshair, Eye, FlaskConical, Loader2, Send, Sparkles, Users } from 'lucide-react';

// 复盘卡用到 html-to-image（出图才需要）→ 懒加载，别把出图能力塞进对局主包
const WerewolfReplayCard = lazy(() => import('./WerewolfReplayCard'));

import { roleDesc, roleName, wwT } from '../werewolf/i18n';
import { companionShortName, displayNameForCharacter } from '../lib/companionName';
import {
  advanceUntilMyTurn,
  abandonWerewolfGame,
  getWerewolfConfig,
  getWerewolfGame,
  getWerewolfGames,
  getWerewolfRoster,
  startWerewolfGame,
  submitWerewolfAction,
  type GameSize,
  type RosterCharacter,
  type SizeConfig,
  type WerewolfQuota,
  type WerewolfView,
} from '../werewolf/api';
import type { GameEvent } from '../werewolf/engine/types';

interface Props {
  onBack: () => void;
  /** 危机路径：把用户带回「聊一聊」 */
  onGoChat?: () => void;
}

/** 事件 → 文案（结构化参数在这里拼，服务端不下发语言） */
function renderEvent(e: GameEvent, view: WerewolfView): { kind: 'line' | 'speech' | 'skip'; text: string; seat?: number } {
  const who = (seat?: number) => {
    const p = view.players.find((x) => x.seat === seat);
    return p ? `${seat} ${p.name}` : String(seat ?? '');
  };
  switch (e.t) {
    case 'speech':
      return { kind: 'speech', text: e.text || '', seat: e.seat };
    case 'last-words':
      return { kind: 'speech', text: `${wwT('evPrivate')} ${e.text || ''}`, seat: e.seat };
    case 'game-start':
      return { kind: 'line', text: wwT('evStart', { n: e.count ?? view.size }) };
    case 'night-fall':
      return { kind: 'line', text: wwT('evNight', { n: e.round }) };
    case 'day-break':
      return { kind: 'line', text: wwT('evDay', { n: e.round }) };
    case 'death-announced':
      return { kind: 'line', text: wwT('evDeath', { who: who(e.seat) }) };
    case 'peaceful-night':
      return { kind: 'line', text: wwT('evPeaceful') };
    case 'vote':
      return { kind: 'line', text: wwT('evVote', { from: who(e.seat), to: who(e.to) }) };
    case 'vote-tie':
      return { kind: 'line', text: wwT('evTie') };
    case 'vote-result':
      return { kind: 'line', text: wwT('evVoteResult', { who: who(e.target), n: e.count ?? 0 }) };
    case 'exile':
      return { kind: 'line', text: wwT('evExile', { who: who(e.seat) }) };
    case 'hunter-shoot':
      return { kind: 'line', text: wwT('evHunter', { who: who(e.seat), target: who(e.target) }) };
    case 'hunter-no-shoot':
      return { kind: 'line', text: wwT('evHunterNo', { who: who(e.seat) }) };
    case 'turn-failed':
      // 模型失败时**不替角色编话**：只说明「这一轮没能开口」，绝不显示成角色台词
      return { kind: 'line', text: wwT('evTurnFailed', { who: who(e.seat) }) };
    case 'wolf-kill':
    case 'seer-check':
    case 'witch-heal':
    case 'witch-poison':
    case 'wolf-teammates':
    case 'wolf-consensus-fail':
      // 这些都是私密事件：能走到这里说明服务端判定「该看的人是你」
      return { kind: 'line', text: wwT('evPrivate') };
    default:
      return { kind: 'skip', text: '' };
  }
}

export default function WerewolfPage({ onBack, onGoChat }: Props) {
  const [phase, setPhase] = useState<'setup' | 'playing'>('setup');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [sizes, setSizes] = useState<SizeConfig[]>([]);
  const [characters, setCharacters] = useState<RosterCharacter[]>([]);
  const [quota, setQuota] = useState<WerewolfQuota | null>(null);
  const [size, setSize] = useState<GameSize>(6);
  const [picked, setPicked] = useState<string[]>([]);

  const [gameId, setGameId] = useState('');
  const [view, setView] = useState<WerewolfView | null>(null);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState<number | null>(null);
  const [crisis, setCrisis] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // ---------- 载入配置 + 角色清单 ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      const [cfg, roster] = await Promise.all([getWerewolfConfig(), getWerewolfRoster()]);
      if (!alive) return;
      if (cfg.success && cfg.data) {
        setSizes(cfg.data.sizes || []);
        setQuota(cfg.data.quota);
      }
      if (roster.success && roster.data) {
        setCharacters(roster.data.characters || []);
        // 默认全选（用户「不拉」时清空即可）
        setPicked((roster.data.characters || []).map((c) => c.id));
        setQuota(roster.data.quota);
      }
      if (!cfg.success && !roster.success) setError(wwT('errLoad'));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [view?.events.length]);

  // ---------- 未打完的对局（断线 / 刷新后能接着打） ----------
  const [unfinished, setUnfinished] = useState<Array<{ id: string; size: number; round: number }>>([]);
  const [resuming, setResuming] = useState(false);

  const refreshUnfinished = useCallback(async () => {
    const res = await getWerewolfGames();
    if (res.success && res.data) {
      const games = (res.data.games || []) as Array<{ id: string; size: number; round: number; status: string }>;
      setUnfinished(games.filter((g) => g.status === 'playing').map((g) => ({ id: g.id, size: g.size, round: g.round })));
    }
  }, []);

  useEffect(() => {
    void refreshUnfinished();
  }, [refreshUnfinished]);

  const resume = useCallback(async (id: string) => {
    setResuming(true);
    setError('');
    const res = await getWerewolfGame(id);
    if (!res.success || !res.data) {
      setError(wwT('errLoad'));
      setResuming(false);
      return;
    }
    setGameId(id);
    let v = res.data.view;
    setView(v);
    setPhase('playing');
    // 服务端可能还停在一段没跑完的地方，接着推进到「轮到我」或结束
    if (v.status === 'playing' && !v.isMyTurn) {
      const next = await advanceUntilMyTurn(id, (nv) => setView(nv));
      if (next) v = next;
      setView(v);
    }
    setResuming(false);
  }, []);

  const discard = useCallback(
    async (id: string) => {
      try {
        await abandonWerewolfGame(id);
      } catch {
        /* 放弃失败不阻断刷新 */
      }
      await refreshUnfinished();
    },
    [refreshUnfinished],
  );

  const sizeCfg = useMemo(() => sizes.find((s) => s.size === size), [sizes, size]);

  // ---------- 开局 ----------
  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    if (quota && quota.remainToday <= 0) {
      setError(wwT('errLimit'));
      setBusy(false);
      return;
    }
    const res = await startWerewolfGame({ size, characterIds: picked.slice(0, size - 1) });
    if (!res.success || !res.data) {
      setError(res.error && /额度|quota|credit/i.test(res.error) ? wwT('errQuota') : wwT('errStart'));
      setBusy(false);
      return;
    }
    setGameId(res.data.gameId);
    setQuota(res.data.quota);
    setTarget(null);
    setPhase('playing');
    let v = res.data.view;
    setView(v);
    // 服务端分段推进：还没轮到我就继续推
    if (v.status === 'playing' && !v.isMyTurn) {
      const next = await advanceUntilMyTurn(res.data.gameId, (nv) => setView(nv));
      if (next) v = next;
      setView(v);
    }
    setBusy(false);
  }, [busy, picked, quota, size]);

  // ---------- 提交动作 ----------
  const submit = useCallback(
    async (body: { text?: string; target?: number | null; heal?: boolean; poison?: number | null }) => {
      if (busy || !gameId) return;
      setBusy(true);
      setError('');
      const res = await submitWerewolfAction(gameId, body);
      if (!res.success || !res.data) {
        setError(res.error && /额度|quota|credit/i.test(res.error) ? wwT('errQuota') : wwT('errAction'));
        setBusy(false);
        return;
      }
      // 🚨 红线：命中危机内容 → 对局已中断，切到陪伴路径（不是游戏错误）
      if (res.data.crisis) {
        setCrisis(true);
        setBusy(false);
        return;
      }
      setDraft('');
      setTarget(null);
      const v = res.data.view || null;
      if (res.data.quota) setQuota(res.data.quota);
      if (v) setView(v);
      if (v && v.status === 'playing' && !v.isMyTurn) {
        const next = await advanceUntilMyTurn(gameId, (nv) => setView(nv));
        if (next) setView(next);
      }
      setBusy(false);
    },
    [busy, gameId],
  );

  const backToSetup = useCallback(async () => {
    if (gameId && view && view.status === 'playing') {
      try {
        await abandonWerewolfGame(gameId);
      } catch {
        /* 放弃失败不阻断返回 */
      }
    }
    setPhase('setup');
    setGameId('');
    setView(null);
    setTarget(null);
    setError('');
    void refreshUnfinished();
  }, [gameId, view, refreshUnfinished]);

  // ---------- 危机卡片（最先判断，优先级高于一切对局 UI） ----------
  if (crisis) {
    return (
      <div className="ww-theme min-h-screen flex items-center justify-center px-5" data-testid="ww-crisis">
        <div className="max-w-md w-full bg-clay-surface border border-clay-border rounded-2xl p-6 shadow-soft">
          <div className="text-2xl mb-2">🫂</div>
          <h2 className="text-lg font-bold text-ink">{wwT('crisisTitle')}</h2>
          <p className="text-sm text-ink-soft leading-relaxed mt-2">{wwT('crisisBody')}</p>
          <div className="flex gap-2 mt-5">
            <button
              onClick={() => (onGoChat ? onGoChat() : onBack())}
              className="flex-1 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary-strong transition-colors"
            >
              {wwT('crisisCta')}
            </button>
            <button
              onClick={onBack}
              className="px-4 py-2.5 rounded-xl border border-clay-border text-sm text-ink-soft hover:bg-clay-bg transition-colors"
            >
              {wwT('back')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- 载入 / 出错 ----------
  if (loading) {
    return (
      <div className="ww-theme min-h-screen flex items-center justify-center text-ink-soft text-sm">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        {wwT('loading')}
      </div>
    );
  }

  // ---------- 开局设置 ----------
  if (phase === 'setup') {
    const noQuota = !!quota && quota.remainToday <= 0;
    return (
      <div className="ww-theme min-h-screen bg-clay-bg" data-testid="ww-setup">
        <div className="max-w-2xl mx-auto px-4 pt-4 pb-24">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-sm text-ink-soft hover:text-primary-text transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {wwT('back')}
          </button>

          {/* 续局：上一次没打完（刷新/断线/中途离开）能直接回到牌桌 */}
          {unfinished.length ? (
            <div className="mt-4 bg-primary-lighter border border-primary rounded-2xl p-3" data-testid="ww-resume-card">
              <div className="text-sm font-semibold text-primary-text">{wwT('resumeTitle')}</div>
              {unfinished.map((g) => (
                <div key={g.id} className="flex items-center gap-2 mt-2">
                  <div className="flex-1 text-xs text-ink">{wwT('resumeDesc', { size: g.size, round: g.round })}</div>
                  <button
                    onClick={() => resume(g.id)}
                    disabled={resuming}
                    data-testid="ww-resume-btn"
                    className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {resuming ? wwT('resumeLoading') : wwT('resumeBtn')}
                  </button>
                  <button
                    onClick={() => discard(g.id)}
                    data-testid="ww-resume-discard"
                    className="px-3 py-1.5 rounded-xl border border-clay-border bg-clay-surface text-xs text-ink-soft"
                  >
                    {wwT('resumeDiscard')}
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-2 mt-4">
            <Sparkles className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold text-ink">{wwT('title')}</h1>
          </div>
          <p className="text-sm text-ink-soft mt-1.5 leading-relaxed">{wwT('subtitle')}</p>

          {/* 局型 */}
          <div className="mt-5">
            <div className="text-sm font-semibold text-ink mb-2">{wwT('sizeLabel')}</div>
            <div className="grid grid-cols-3 gap-2">
              {(sizes.length ? sizes : [{ size: 6 } as SizeConfig, { size: 9 } as SizeConfig, { size: 12 } as SizeConfig]).map((s) => (
                <button
                  key={s.size}
                  onClick={() => setSize(s.size)}
                  data-testid={`ww-size-${s.size}`}
                  className={
                    'py-3 rounded-xl border text-sm font-semibold transition-all ' +
                    (size === s.size
                      ? 'border-primary bg-primary-lighter text-primary-text'
                      : 'border-clay-border bg-clay-surface text-ink-soft hover:border-primary')
                  }
                >
                  {wwT(`size${s.size}`)}
                  {s.estimatedCredit ? (
                    <div className="text-[11px] font-normal opacity-70 mt-0.5">{wwT('estCredit', { n: s.estimatedCredit })}</div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {/* 拉谁入局 */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-ink">{wwT('rosterLabel')}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPicked(characters.map((c) => c.id))}
                  className="text-xs px-2.5 py-1 rounded-full border border-clay-border bg-clay-surface text-ink-soft hover:border-primary"
                >
                  {wwT('rosterAll')}
                </button>
                <button
                  onClick={() => setPicked([])}
                  data-testid="ww-roster-none"
                  className="text-xs px-2.5 py-1 rounded-full border border-clay-border bg-clay-surface text-ink-soft hover:border-primary"
                >
                  {wwT('rosterNone')}
                </button>
              </div>
            </div>
            <div className="text-xs text-ink-soft mb-2 leading-relaxed">{wwT('rosterHint')}</div>

            <div className="bg-clay-surface border border-clay-border rounded-xl p-2.5 flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-primary-lighter flex items-center justify-center text-primary-text text-sm font-bold">
                你
              </div>
              <div className="text-sm text-ink">{wwT('rosterYou')}</div>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-2">
              {characters.map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() =>
                      setPicked((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id].slice(0, size - 1)))
                    }
                    className={
                      'flex items-start gap-2 p-2.5 rounded-xl border text-left transition-all ' +
                      (on ? 'border-primary bg-primary-lighter' : 'border-clay-border bg-clay-surface hover:border-primary')
                    }
                  >
                    <div className="w-8 h-8 rounded-full bg-clay-surface border border-clay-border flex items-center justify-center text-sm shrink-0">
                      {c.avatar ? <img src={c.avatar} alt="" className="w-full h-full rounded-full object-cover" /> : c.name.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink truncate">{displayNameForCharacter(c)}</div>
                      {c.memoryCount > 0 ? (
                        <div className="text-[11px] text-primary-text">✦ {wwT('memoryTag')} · {c.memoryCount}</div>
                      ) : (
                        <div className="text-[11px] text-ink-soft">{c.isDefault ? companionShortName() : ''}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="text-xs text-ink-soft mt-2">🪑 {wwT('builtinNote')}</div>
          </div>

          {/* 本局配置 */}
          {sizeCfg ? (
            <div className="mt-5 bg-clay-surface border border-clay-border rounded-xl p-3">
              <div className="text-sm font-semibold text-ink flex items-center gap-1.5">
                <Users className="w-4 h-4 text-primary" />
                {wwT('rules')}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {Object.entries(sizeCfg.roster || {})
                  .filter(([, n]) => n > 0)
                  .map(([role, n]) => (
                    <span key={role} className="text-xs px-2 py-1 rounded-full bg-primary-lighter text-primary-text">
                      {roleName(role)} × {n}
                    </span>
                  ))}
              </div>
              <div className="text-xs text-ink-soft mt-2 leading-relaxed">{wwT('rulesNote')}</div>
            </div>
          ) : null}

          {error ? <div className="mt-4 text-sm text-red-600">{error}</div> : null}

          <div className="mt-6">
            <div className="text-xs text-ink-soft mb-2 text-center">
              {quota ? (noQuota ? wwT('quotaNone') : wwT('quota', { n: quota.remainToday })) : ''}
            </div>
            <button
              onClick={start}
              disabled={busy || noQuota}
              data-testid="ww-start"
              className="w-full py-3.5 rounded-2xl bg-primary text-white font-semibold hover:bg-primary-strong disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {busy ? wwT('starting') : wwT('start')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- 对局中 ----------
  if (!view) return null;
  const me = view.players.find((p) => p.isYou);
  const action = view.pendingAction;
  const ended = view.status === 'ended';
  const iWon = ended && view.winner && view.myCamp === view.winner;

  /** 可选目标（依动作不同） */
  const targets: number[] = (() => {
    if (!action || action === 'speak' || action === 'witch') return [];
    return view.players
      .filter((p) => p.alive && (action === 'wolf-kill' ? true : !p.isYou))
      .map((p) => p.seat);
  })();

  const canPick = targets.length > 0 && !busy;

  return (
    <div className="ww-theme min-h-screen bg-clay-bg flex flex-col" data-testid="ww-table">
      {/* 顶栏 */}
      <div className="bg-clay-surface border-b border-clay-border px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onBack} className="text-ink-soft hover:text-primary-text transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-ink truncate">
            {wwT('tab')} · {wwT('roundOf', { n: view.round, max: view.maxRounds })}
          </div>
          <div className="text-[11px] text-ink-soft">
            {view.living.length} / {view.size} {wwT('aliveLabel')}
          </div>
        </div>
        {me?.role ? (
          <span className="text-xs px-2.5 py-1 rounded-full bg-primary-lighter text-primary-text font-semibold">
            {roleName(me.role)}
          </span>
        ) : null}
      </div>

      <div ref={logRef} className="flex-1 overflow-y-auto px-4 py-4 max-w-2xl w-full mx-auto">
        {/* 我的私人信息 */}
        <div className="bg-clay-surface border border-clay-border rounded-xl p-3">
          <div className="text-xs text-ink-soft">{wwT('yourRole')}</div>
          <div className="text-sm font-bold text-ink mt-0.5">
            {roleName(view.myRole)} ·{' '}
            <span className={view.myCamp === 'wolf' ? 'text-red-600' : 'text-primary-text'}>
              {view.myCamp === 'wolf' ? wwT('campWolf') : wwT('campVillage')}
            </span>
          </div>
          <div className="text-xs text-ink-soft mt-1 leading-relaxed">{roleDesc(view.myRole)}</div>
          {view.wolfTeammates?.length ? (
            <div className="text-xs text-red-600 mt-1.5">
              {wwT('teammates', {
                list: view.wolfTeammates
                  .map((s) => `${s} ${view.players.find((p) => p.seat === s)?.name ?? ''}`)
                  .join('、'),
              })}
            </div>
          ) : null}
          {view.seerChecks?.length ? (
            <div className="text-xs text-ink mt-1.5">
              {wwT('seerChecks')}：
              {view.seerChecks
                .map((c) =>
                  wwT('seerCheckRow', {
                    seat: `${c.seat} ${view.players.find((p) => p.seat === c.seat)?.name ?? ''}`,
                    camp: c.camp === 'wolf' ? wwT('wolfLabel') : wwT('villageLabel'),
                  }),
                )
                .join('　')}
            </div>
          ) : null}
          {view.witch ? (
            <div className="text-xs text-ink mt-1.5">
              {wwT('witchAntidote', { state: view.witch.antidoteLeft ? wwT('have') : wwT('used') })} 
              {wwT('witchPoison', { state: view.witch.poisonLeft ? wwT('have') : wwT('used') })}
            </div>
          ) : null}
          {view.canShoot && !view.youAlive ? <div className="text-xs text-amber-700 mt-1.5">🔫 {wwT('canShoot')}</div> : null}
        </div>

        {/* 座位 */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          {view.players.map((p) => {
            const selectable = canPick && targets.includes(p.seat);
            const selected = target === p.seat;
            const speaking = view.speakOrder[view.speakIndex] === p.seat && view.phase === 'day-speak';
            return (
              <button
                key={p.seat}
                disabled={!selectable}
                onClick={() => selectable && setTarget(p.seat)}
                data-testid={`ww-seat-${p.seat}`}
                className={
                  'relative p-2 rounded-xl border text-left transition-all ' +
                  (!p.alive
                    ? 'border-clay-border bg-clay-muted opacity-60 '
                    : selected
                      ? 'border-primary bg-primary-lighter ring-2 ring-primary '
                      : selectable
                        ? 'border-clay-border bg-clay-surface hover:border-primary '
                        : 'border-clay-border bg-clay-surface ')
                }
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-ink-soft">{p.seat}</span>
                  <span className="text-xs font-semibold text-ink truncate">{p.name}</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {p.isYou ? <span className="text-[10px] px-1.5 rounded bg-primary text-white">{wwT('you')}</span> : null}
                  {p.builtin ? <span className="text-[10px] px-1.5 rounded bg-clay-muted text-ink-soft">{wwT('builtinBadge')}</span> : null}
                  {p.role && !p.isYou ? (
                    <span className={'text-[10px] px-1.5 rounded ' + (p.camp === 'wolf' ? 'bg-red-100 text-red-700' : 'bg-primary-lighter text-primary-text')}>
                      {roleName(p.role)}
                    </span>
                  ) : null}
                </div>
                {!p.alive ? <div className="text-[10px] text-ink-soft mt-0.5">{wwT('deadLabel')}</div> : null}
                {speaking ? <div className="text-[10px] text-primary-text mt-0.5">{wwT('speaking')}…</div> : null}
              </button>
            );
          })}
        </div>

        {/* 事件流 */}
        <div className="mt-4 space-y-2">
          {view.events.map((e, i) => {
            const r = renderEvent(e, view);
            if (r.kind === 'skip') return null;
            if (r.kind === 'speech') {
              const p = view.players.find((x) => x.seat === r.seat);
              return (
                <div key={i} className="flex gap-2 animate-fade-up">
                  <div className="w-7 h-7 rounded-full bg-primary-lighter flex items-center justify-center text-xs text-primary-text shrink-0">
                    {r.seat}
                  </div>
                  <div className="bg-clay-surface border border-clay-border rounded-xl rounded-tl-sm px-3 py-2 max-w-[85%]">
                    <div className="text-[11px] text-ink-soft mb-0.5">{p?.name ?? ''}</div>
                    <div className="text-sm text-ink leading-relaxed whitespace-pre-wrap">{r.text}</div>
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="text-center text-xs text-ink-soft py-0.5">
                {r.text}
              </div>
            );
          })}
        </div>

        {/* 结算 */}
        {ended ? (
          <div className="mt-5 bg-clay-surface border border-clay-border rounded-2xl p-4 text-center" data-testid="ww-ended">
            <div className="text-lg font-bold text-ink">
              {view.winner === 'wolf' ? '🐺 ' + wwT('winWolf') : '🌅 ' + wwT('winVillage')}
            </div>
            <div className={'text-sm mt-1 font-semibold ' + (iWon ? 'text-primary-text' : 'text-ink-soft')}>
              {iWon ? wwT('youWin') : wwT('youLose')}
            </div>
            <div className="text-xs text-ink-soft mt-3 mb-1.5">{wwT('finalRoles')}</div>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {view.players.map((p) => (
                <span key={p.seat} className="text-[11px] px-2 py-1 rounded-full bg-clay-muted text-ink">
                  {p.seat} {p.name}：{p.role ? roleName(p.role) : '—'}
                </span>
              ))}
            </div>
            <button
              onClick={() => setShowReplay(true)}
              data-testid="ww-replay-open"
              className="mt-3 px-4 py-2 rounded-xl bg-primary text-white text-xs font-semibold hover:bg-primary-strong transition-colors"
            >
              🐺 {wwT('replayOpen')}
            </button>
          </div>
        ) : null}
      </div>

      {/* 操作区 */}
      {!ended ? (
        <div className="bg-clay-surface border-t border-clay-border px-4 py-3 shrink-0">
          <div className="max-w-2xl mx-auto">
            {error ? <div className="text-xs text-red-600 mb-2">{error}</div> : null}

            {busy || !view.isMyTurn ? (
              <div className="flex items-center justify-center gap-2 text-sm text-ink-soft py-3">
                <Loader2 className="w-4 h-4 animate-spin" />
                {busy ? wwT('submitting') : wwT('thinking')}
              </div>
            ) : action === 'speak' ? (
              <>
                <div className="text-xs font-semibold text-ink mb-1.5 flex items-center gap-1.5">
                  <Send className="w-3.5 h-3.5 text-primary" />
                  {wwT('actSpeak')}
                </div>
                <div className="flex gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={wwT('actSpeakPh')}
                    rows={2}
                    data-testid="ww-speak-input"
                    className="flex-1 px-3 py-2 border border-clay-border rounded-xl text-sm resize-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                  <button
                    onClick={() => draft.trim() && submit({ text: draft.trim() })}
                    disabled={!draft.trim()}
                    data-testid="ww-speak-send"
                    className="px-4 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary-strong disabled:opacity-40 transition-colors"
                  >
                    {wwT('actSend')}
                  </button>
                </div>
              </>
            ) : action === 'witch' ? (
              <>
                <div className="text-xs font-semibold text-ink mb-1.5 flex items-center gap-1.5">
                  <FlaskConical className="w-3.5 h-3.5 text-primary" />
                  {wwT('actWitch')}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => submit({ heal: true })}
                    data-testid="ww-witch-heal"
                    className="px-3 py-2 rounded-xl border border-primary bg-primary-lighter text-sm text-primary-text font-semibold hover:bg-primary-soft transition-colors"
                  >
                    {wwT('actHeal', { who: '' })}
                  </button>
                  <button
                    onClick={() => target && submit({ poison: target })}
                    disabled={!target}
                    data-testid="ww-witch-poison"
                    className="px-3 py-2 rounded-xl border border-clay-border bg-clay-surface text-sm text-ink hover:border-primary disabled:opacity-40 transition-colors"
                  >
                    {wwT('actPoison')}{target ? ` → ${target}` : ''}
                  </button>
                  <button
                    onClick={() => submit({})}
                    data-testid="ww-witch-skip"
                    className="px-3 py-2 rounded-xl border border-clay-border bg-clay-surface text-sm text-ink-soft hover:border-primary transition-colors"
                  >
                    {wwT('actSkip')}
                  </button>
                </div>
                <div className="text-[11px] text-ink-soft mt-1.5">{wwT('pickTarget')}</div>
              </>
            ) : (
              <>
                <div className="text-xs font-semibold text-ink mb-1.5 flex items-center gap-1.5">
                  {action === 'seer-check' ? (
                    <Eye className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <Crosshair className="w-3.5 h-3.5 text-primary" />
                  )}
                  {action === 'wolf-kill'
                    ? wwT('actWolfKill')
                    : action === 'seer-check'
                      ? wwT('actSeerCheck')
                      : action === 'vote'
                        ? wwT('actVote')
                        : wwT('actHunter')}
                </div>
                <div className="text-[11px] text-ink-soft mb-2">
                  {action === 'hunter-shoot' ? wwT('actHunterHint') : wwT('pickTarget')}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => target && submit({ target })}
                    disabled={!target}
                    data-testid="ww-target-confirm"
                    className="flex-1 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary-strong disabled:opacity-40 transition-colors"
                  >
                    {target ? `→ ${target} ${view.players.find((p) => p.seat === target)?.name ?? ''}` : wwT('pickTarget')}
                  </button>
                  {action === 'hunter-shoot' ? (
                    <button
                      onClick={() => submit({ target: null })}
                      data-testid="ww-hunter-giveup"
                      className="px-4 py-2.5 rounded-xl border border-clay-border bg-clay-surface text-sm text-ink-soft hover:border-primary transition-colors"
                    >
                      {wwT('actGiveUp')}
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-clay-surface border-t border-clay-border px-4 py-3 shrink-0">
          <div className="max-w-2xl mx-auto flex gap-2">
            <button
              onClick={backToSetup}
              data-testid="ww-again"
              className="flex-1 py-3 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary-strong transition-colors"
            >
              {wwT('again')}
            </button>
            <button
              onClick={onBack}
              className="px-4 py-3 rounded-xl border border-clay-border bg-clay-surface text-sm text-ink-soft hover:border-primary transition-colors"
            >
              {wwT('back')}
            </button>
          </div>
        </div>
      )}

      {/* 复盘卡「这局谁在骗你」 */}
      {showReplay && ended ? (
        <Suspense fallback={null}>
          <WerewolfReplayCard view={view} onClose={() => setShowReplay(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
