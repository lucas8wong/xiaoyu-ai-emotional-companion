/**
 * 心情打卡（独立子模块）
 * 从「我的」中抽出：今日心情 + 一句话 + 连续打卡 + 近30天日历
 */

import { useEffect, useState } from 'react';
import { CalendarDays, Loader2, Check, X, Share2 } from 'lucide-react';
import { getDiary, saveDiary, type DiaryEntry } from '../services/api';
import { t, getLang } from '../i18n';
import StoryShareModal, { type StoryBubble } from './StoryShareModal';

const MOODS = [
  { key: 'happy', emoji: '😊', labelKey: 'moodHappy' },
  { key: 'calm', emoji: '😌', labelKey: 'moodCalm' },
  { key: 'neutral', emoji: '😐', labelKey: 'moodNeutral' },
  { key: 'sad', emoji: '😔', labelKey: 'moodSad' },
  { key: 'anxious', emoji: '😟', labelKey: 'moodAnxious' },
  { key: 'angry', emoji: '😠', labelKey: 'moodAngry' },
  { key: 'tired', emoji: '😴', labelKey: 'moodTired' },
  { key: 'grateful', emoji: '🥰', labelKey: 'moodGrateful' },
];
const MOOD_EMOJI: Record<string, string> = Object.fromEntries(MOODS.map(m => [m.key, m.emoji]));

export default function MoodCheckinView() {
  const [streak, setStreak] = useState(0);
  const [records, setRecords] = useState<DiaryEntry[]>([]);
  const [todayMood, setTodayMood] = useState<string | null>(null);
  const [mood, setMood] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [selectedDay, setSelectedDay] = useState<{ date: string; entry?: DiaryEntry } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const loadDiary = () => {
    getDiary().then(r => {
      if (r.success && r.data) {
        setRecords(r.data.records || []);
        setStreak(r.data.streak);
        if (r.data.today) {
          setTodayMood(r.data.today.mood);
          setMood(r.data.today.mood);
        } else {
          setTodayMood(null); setMood('');
        }
        setNote(''); // 输入框保持空；已保存的备注以只读形式回看
      }
    });
  };

  useEffect(() => { loadDiary(); }, []);

  const handleSaveMood = async () => {
    if (!mood) { setMsg({ type: 'err', text: t('errPickMood') }); return; }
    setBusy(true); setMsg(null);
    const r = await saveDiary(mood, note);
    setBusy(false);
    if (r.success && r.data) {
      setTodayMood(mood); setStreak(r.data.streak); setNote('');
      setMsg({ type: 'ok', text: r.data.reward ? r.data.message : t('profileMoodRecorded', { n: r.data.streak }) });
      loadDiary();
    } else {
      setMsg({ type: 'err', text: r.error || t('errSaveFailed') });
    }
  };

  // 今日记录（只读回看已保存的备注）
  const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
  const todayEntry = records.find(r => r.date === todayKey);

  // 近 30 天心情日历
  const diaryMap = new Map(records.map(r => [r.date, r]));

  // 日期 YYYY-MM-DD → 可读
  const fmtFullDate = (iso: string): string => {
    const p = iso.split('-');
    if (p.length !== 3) return iso;
    const [y, m, d] = p;
    if (getLang() === 'en') return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m)-1]} ${y}`;
    return `${y}年${Number(m)}月${Number(d)}日`;
  };
  const calendarDays: { date: string; entry?: DiaryEntry }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    calendarDays.push({ date: key.slice(5), entry: diaryMap.get(key) });
  }

  const todayMeta = MOODS.find(m => m.key === todayEntry?.mood);
  const shareBubbles: StoryBubble[] = (todayEntry && todayMeta)
    ? [{ side: 'me' as const, name: t('chatShareMe'), content: `${todayMeta.emoji} ${t(todayMeta.labelKey)}${todayEntry.note ? '\n\n' + todayEntry.note : ''}` }]
    : [];
  const shareDate = todayEntry ? fmtFullDate(todayEntry.date) : '';

  return (
    <div className="space-y-4">
      {/* 今日心情打卡 */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-amber-700"><CalendarDays className="w-4 h-4" /></span>
          <h3 className="font-semibold text-gray-800 text-sm flex-1 min-w-0">
            {streak > 0 ? `${t('profileTodayMood')} · ${t('profileStreak', { n: streak })} 🔥` : t('profileTodayMood')}
          </h3>
          {todayEntry && (
            <button onClick={() => setShareOpen(true)} className="p-1.5 rounded-lg text-ink-soft hover:text-primary-text hover:bg-primary-lighter/60 transition-colors flex-shrink-0" aria-label={t('diaryShareBtn')} title={t('diaryShareBtn')}>
              <Share2 className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {MOODS.map(m => (
            <button
              key={m.key}
              onClick={() => setMood(m.key)}
              className={`flex flex-col items-center px-2.5 py-1.5 rounded-lg border transition-all ${mood === m.key ? 'bg-amber-50 border-amber-300 scale-105' : 'bg-white border-gray-200 hover:border-amber-200'}`}
            >
              <span className="text-xl">{m.emoji}</span>
              <span className="text-[11px] text-ink-soft mt-0.5">{t(m.labelKey)}</span>
            </button>
          ))}
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('profileMoodNotePh')}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2 focus:ring-2 focus:ring-amber-400 focus:border-transparent"
        />
        {/* 已保存的今日备注（只读回看） */}
        {todayEntry?.note && (
          <div className="mb-2 bg-white border border-amber-100 rounded-lg px-3 py-2">
            <p className="text-[11px] text-amber-600 mb-0.5">{t('profileMoodTodayNote')}</p>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{todayEntry.note}</p>
          </div>
        )}
        <button
          onClick={handleSaveMood}
          disabled={busy}
          className="w-full bg-amber-50 text-amber-900 border-2 border-amber-600 py-2 rounded-lg text-sm font-medium hover:bg-amber-100 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : todayMood ? <Check className="w-4 h-4" /> : null}
          {todayMood ? t('profileMoodUpdate') : t('profileMoodRecord')}
        </button>
        {msg && <p className={`text-xs mt-2 ${msg.type === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</p>}
        <p className="text-[11px] text-ink-soft mt-2">{t('profileMoodRewardTip')}</p>
      </div>

      {/* 心情日历（近30天） */}
      {records.length > 0 && (
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-700"><CalendarDays className="w-4 h-4" /></span>
            <h3 className="font-semibold text-gray-800 text-sm">{t('profileCalendarTitle')}</h3>
          </div>
          <div className="grid grid-cols-10 gap-1">
            {calendarDays.map((d, i) => (
              <button
                key={i}
                onClick={() => setSelectedDay(d)}
                disabled={!d.entry}
                title={d.entry ? `${d.date}：${d.entry.note || d.entry.mood}` : d.date}
                aria-label={d.date}
                className={`aspect-square rounded flex items-center justify-center text-xs transition-all ${d.entry ? 'bg-amber-100 hover:bg-amber-200 cursor-pointer' : 'bg-gray-100 cursor-default'} ${selectedDay?.date === d.date ? 'ring-2 ring-amber-400' : ''}`}
              >
                {d.entry ? (MOOD_EMOJI[d.entry.mood] || '✓') : ''}
              </button>
            ))}
          </div>
          {/* 选中日期的备注详情 */}
          {selectedDay?.entry && (
            <div className="mt-3 bg-white border border-amber-100 rounded-xl p-3">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                  <span>{fmtFullDate(selectedDay.entry.date)}</span>
                  {selectedDay.entry.mood && <span>{MOOD_EMOJI[selectedDay.entry.mood]}</span>}
                </p>
                <button onClick={() => setSelectedDay(null)} aria-label="close" className="text-ink-soft hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {selectedDay.entry.note || t('profileMoodNoNote')}
              </p>
            </div>
          )}
          <p className="text-[11px] text-ink-soft mt-2">{t('profileCalendarFoot')}</p>
        </div>
      )}

      <StoryShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={t('diaryShareTitle')}
        subtitle={shareDate}
        headerEmoji="📔"
        bubbles={shareBubbles}
      />
    </div>
  );
}
