/** Saved preferences and deterministic local schedules. No model call or browser state. */
export type MomentVolume = 'quiet' | 'natural' | 'warm';
export type MomentSpeed = 'slow' | 'mixed' | 'fast';
export interface MomentCharacterRhythm {
  sleep: string;
  wake: string;
  browsing: 'rare' | 'normal' | 'often';
  expression: MomentVolume;
}
export interface MomentRhythmSettings {
  version: 1;
  volume: MomentVolume;
  speed: MomentSpeed;
  timezone: string;
  allowLateNights: boolean;
  quiet: { enabled: boolean; start: string; end: string };
  characters: Record<string, MomentCharacterRhythm>;
}
export const defaultMomentRhythm = (volume: MomentVolume = 'natural', timezone = 'Asia/Shanghai'): MomentRhythmSettings => ({
  version: 1, volume, speed: 'mixed', timezone, allowLateNights: true,
  quiet: { enabled: false, start: '23:30', end: '07:30' }, characters: {},
});
export function rhythmSample(seed: string): number {
  let n = 2166136261;
  for (let i = 0; i < seed.length; i++) n = Math.imul(n ^ seed.charCodeAt(i), 16777619);
  n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const formatTime = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const validMomentTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const volume = (v: unknown): v is MomentVolume => v === 'quiet' || v === 'natural' || v === 'warm';
export function parseMomentRhythm(value: unknown): MomentRhythmSettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as MomentRhythmSettings;
  if (v.version !== 1 || !volume(v.volume) || !['slow', 'mixed', 'fast'].includes(v.speed) || typeof v.allowLateNights !== 'boolean') return null;
  if (typeof v.timezone !== 'string' || v.timezone.length > 80) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }).format(0); } catch { return null; }
  if (!v.quiet || typeof v.quiet.enabled !== 'boolean' || !validMomentTime(v.quiet.start) || !validMomentTime(v.quiet.end) || v.quiet.start === v.quiet.end) return null;
  if (!v.characters || typeof v.characters !== 'object' || Array.isArray(v.characters) || Object.keys(v.characters).length > 100) return null;
  const characters: Record<string, MomentCharacterRhythm> = {};
  for (const [id, c] of Object.entries(v.characters)) {
    if (!id || id.length > 160 || ['__proto__', 'constructor', 'prototype'].includes(id) || !c || !validMomentTime(c.sleep) || !validMomentTime(c.wake) || c.sleep === c.wake || !['rare', 'normal', 'often'].includes(c.browsing) || !volume(c.expression)) return null;
    // At least three hours of ordinary rest; an all-nighter is a separate day variation.
    const duration = (minute(c.wake) - minute(c.sleep) + 1440) % 1440;
    if (duration < 180 || duration > 960) return null;
    characters[id] = { sleep: c.sleep, wake: c.wake, browsing: c.browsing, expression: c.expression };
  }
  return { version: 1, volume: v.volume, speed: v.speed, timezone: v.timezone, allowLateNights: v.allowLateNights,
    quiet: { enabled: v.quiet.enabled, start: v.quiet.start, end: v.quiet.end }, characters };
}
export function defaultCharacterRhythm(owner: string, id: string): MomentCharacterRhythm {
  const r = rhythmSample(`${owner}:${id}:habit`);
  const sleep = 22 * 60 + Math.floor(r * 270);
  return { sleep: formatTime(sleep), wake: formatTime(sleep + 7 * 60 + Math.floor(rhythmSample(`${owner}:${id}:rest`) * 90)),
    browsing: r < .2 ? 'rare' : r > .8 ? 'often' : 'normal', expression: 'natural' };
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function localMinute(now: number, timezone: string): number {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatters.size > 200) formatters.clear();
    formatters.set(timezone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(now).map(v => [v.type, v.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day) / 60000 + +p.hour * 60 + +p.minute;
}
function inWindow(m: number, start: number, end: number) { return start < end ? m >= start && m < end : m >= start || m < end; }
export function momentQuietAt(settings: MomentRhythmSettings, now: number): boolean {
  return settings.quiet.enabled && inWindow(localMinute(now, settings.timezone) % 1440, minute(settings.quiet.start), minute(settings.quiet.end));
}
/** Variation is keyed to the evening on which rest starts, so a late night has a later recovery. */
export function momentRestPlan(owner: string, id: string, settings: MomentRhythmSettings, day: number) {
  const c = settings.characters[id] || defaultCharacterRhythm(owner, id);
  let start = minute(c.sleep); if (start < 720) start += 1440;
  let end = start + (minute(c.wake) - minute(c.sleep) + 1440) % 1440;
  const draw = rhythmSample(`${owner}:${id}:${day}:night`);
  const kind = settings.allowLateNights && draw < .015 ? 'allNight' : settings.allowLateNights && draw < .14 ? 'late' : 'usual';
  if (kind === 'allNight') { start = Math.max(start, 1440 + 8 * 60); end = start + 6 * 60; }
  else if (kind === 'late') { start += 60 + Math.floor(rhythmSample(`${owner}:${id}:${day}:late`) * 120); end += 60 + Math.floor(rhythmSample(`${owner}:${id}:${day}:recovery`) * 120); }
  return { start: day * 1440 + start, end: day * 1440 + end, kind };
}
export function momentCharacterAwake(owner: string, id: string, settings: MomentRhythmSettings, now: number): boolean {
  if (momentQuietAt(settings, now)) return false;
  const local = localMinute(now, settings.timezone), day = Math.floor(local / 1440);
  for (let d = day - 2; d <= day; d++) {
    const rest = momentRestPlan(owner, id, settings, d);
    if (local >= rest.start && local < rest.end) return false;
  }
  return true;
}
function browsingAt(owner: string, id: string, settings: MomentRhythmSettings, now: number) {
  if (!momentCharacterAwake(owner, id, settings, now)) return false;
  const c = settings.characters[id] || defaultCharacterRhythm(owner, id);
  const period = c.browsing === 'rare' ? 180 : c.browsing === 'often' ? 45 : 90;
  const local = localMinute(now, settings.timezone), slot = Math.floor(local / period);
  const start = slot * period + Math.floor(rhythmSample(`${owner}:${id}:${slot}:browse`) * (period - 12));
  return local >= start && local < start + 8 + Math.floor(rhythmSample(`${owner}:${id}:${slot}:length`) * 5);
}
export function nextMomentBrowse(owner: string, id: string, settings: MomentRhythmSettings, now: number): number {
  if (browsingAt(owner, id, settings, now)) return now;
  // Step on the UTC timeline: DST skipped/repeated hours stay real. Sessions last at least eight minutes.
  for (let at = now + 60000; at <= now + 48 * 3600000; at += 60000) if (browsingAt(owner, id, settings, at)) return at;
  return now + 48 * 3600000;
}
export function nextMomentAwake(owner: string, id: string, settings: MomentRhythmSettings, now: number): number {
  if (momentCharacterAwake(owner, id, settings, now)) return now;
  for (let at = now + 60000; at <= now + 48 * 3600000; at += 60000) if (momentCharacterAwake(owner, id, settings, at)) return at;
  return now + 48 * 3600000;
}
export function momentReactionDue(owner: string, id: string, settings: MomentRhythmSettings, now: number, kind: 'like' | 'comment' | 'post', seed: string): number {
  const seen = nextMomentBrowse(owner, id, settings, now), r = rhythmSample(`${owner}:${id}:${seed}:${kind}`);
  const fast = settings.speed === 'fast' ? .7 : settings.speed === 'slow' ? .08 : .35;
  const delay = kind === 'like' ? r < fast ? 1000 + r / fast * 9000 : 15000 + r * 90000
    : r < fast ? 5000 + r / fast * 25000 : 30000 + r * (settings.speed === 'slow' ? 900000 : 240000);
  return nextMomentAwake(owner, id, settings, seen + Math.round(delay));
}
export const momentInteractionChance = (settings: MomentRhythmSettings, expression: MomentVolume, base: number) =>
  Math.min(.95, base * (settings.volume === 'quiet' ? .5 : settings.volume === 'warm' ? 1.5 : 1) * (expression === 'quiet' ? .6 : expression === 'warm' ? 1.25 : 1));
