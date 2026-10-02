/**
 * 剧情配乐曲库与默认分配
 * - TRACKS：可切换曲库（文件名与 public/music/roleplay/ 一致）
 * - defaultTrackForScenario：按剧本标签 → 5 套音景 → 套内按剧情侧重点选默认曲
 * - 自建/投稿剧本无 tags 时回退 S1 主推曲
 */

export interface BgmTrack {
  id: string;          // = 文件名（不含扩展名）
  file: string;        // public/music/roleplay 下的文件名
  set: 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  zh: string;
  en: string;
  side: string;        // 侧重建议（中文，面板里展示）
}

export const TRACKS: BgmTrack[] = [
  // S1 治愈暖
  { id: 'S1-1-warm-guitar-soft-piano', file: 'S1-1-warm-guitar-soft-piano.mp3', set: 'S1', zh: '暖·吉他软钢琴', en: 'Warm Guitar & Soft Piano', side: '温暖治愈底色（默认推）' },
  { id: 'S1-3-sound-of-sadness', file: 'S1-3-sound-of-sadness.mp3', set: 'S1', zh: '温柔带伤·钢琴', en: 'Gentle Sadness (Piano)', side: '卑微/心疼/安全感缺失向' },
  { id: 'B2-S1-2-organ-bossa-nova', file: 'B2-S1-2-organ-bossa-nova.mp3', set: 'S1', zh: '管风琴·软 Bossa', en: 'Organ Soft Bossa', side: '温润低回的温柔' },
  // S2 古韵
  { id: 'S2-1-chinese-classical', file: 'S2-1-chinese-classical.mp3', set: 'S2', zh: '中式古典', en: 'Chinese Classical', side: '端庄大气（帝王/宫廷，默认推）' },
  { id: 'S2-2-chinese-flute-serenade', file: 'S2-2-chinese-flute-serenade.mp3', set: 'S2', zh: '笛箫小夜曲', en: 'Flute Serenade', side: '温婉命定（替嫁/世家）' },
  { id: 'S2-3-moonlit-blossoms', file: 'S2-3-moonlit-blossoms.mp3', set: 'S2', zh: '月下花间', en: 'Moonlit Blossoms', side: '月下浪漫夜景' },
  { id: 'S2-4-moonlit-whispers', file: 'S2-4-moonlit-whispers.mp3', set: 'S2', zh: '月下低语', en: 'Moonlit Whispers', side: '清雅含蓄' },
  { id: 'S2-5-sad-melancolic-oriental', file: 'S2-5-sad-melancolic-oriental.mp3', set: 'S2', zh: '中式伤情', en: 'Melancholic Oriental', side: '虐恋/失宠/废后向' },
  { id: 'B2-S2-1-celestial-bamboo-melody', file: 'B2-S2-1-celestial-bamboo-melody.mp3', set: 'S2', zh: '竹笛空灵', en: 'Celestial Bamboo', side: '轻盈辽阔（和亲/草原向）' },
  { id: 'B2-S2-2-winter-flute-soft', file: 'B2-S2-2-winter-flute-soft.mp3', set: 'S2', zh: '冬夜箫笛', en: 'Winter Flute (Soft)', side: '舒缓清冷古韵' },
  { id: 'B2-S2-3-plum-blossom-piano', file: 'B2-S2-3-plum-blossom-piano.mp3', set: 'S2', zh: '梅·古意钢琴', en: 'Plum Blossom Piano', side: '中西折中安静（世家/留洋向）' },
  // S3 都市轻暖
  { id: 'S3-1-bossa-lounge', file: 'S3-1-bossa-lounge.mp3', set: 'S3', zh: 'Bossa 休息室', en: 'Bossa Lounge', side: '都市精英感（职场/总裁，默认推）' },
  { id: 'S3-2-riviera-sunset', file: 'S3-2-riviera-sunset.mp3', set: 'S3', zh: '里维埃拉黄昏', en: 'Riviera Sunset', side: '从容明快（御姐/律政）' },
  { id: 'S3-3-cozy-corner-bossa', file: 'S3-3-cozy-corner-bossa.mp3', set: 'S3', zh: '温馨角落 Bossa', en: 'Cozy Corner Bossa', side: '暖向日常恋爱' },
  { id: 'B2-S3-1-piano-and-guitar-bossa', file: 'B2-S3-1-piano-and-guitar-bossa.mp3', set: 'S3', zh: '钢琴吉他 Bossa', en: 'Piano & Guitar Bossa', side: '更静的都市轻暖' },
  // S4 清冷
  { id: 'B3-S4-1-empathy-sad-ambient', file: 'B3-S4-1-empathy-sad-ambient.mp3', set: 'S4', zh: '共情·空灵氛围', en: 'Empathy Ambient', side: '空灵克制（清冷套默认推）' },
  { id: 'B4-S4-2-celestial-nothingness', file: 'B4-S4-2-celestial-nothingness.mp3', set: 'S4', zh: '天穹虚空', en: 'Celestial Nothingness', side: '太空虚空感（压抑/封闭向）' },
  { id: 'B4-S4-3-stars-acoustics-terranova', file: 'B4-S4-3-stars-acoustics-terranova.mp3', set: 'S4', zh: '星间声学', en: 'Terra Nova', side: '轻盈清冷短曲' },
  // S5 元气明快
  { id: 'S5-1-fun-jazz', file: 'S5-1-fun-jazz.mp3', set: 'S5', zh: '俏皮轻爵士', en: 'Fun Jazz', side: '校园/甜宠（默认推）' },
  { id: 'S5-3-summertime-happiness', file: 'S5-3-summertime-happiness.mp3', set: 'S5', zh: '夏日明媚', en: 'Summertime Happiness', side: '青春明亮短 cue' },
  { id: 'B4-S5-2-light-pop-piano', file: 'B4-S5-2-light-pop-piano.mp3', set: 'S5', zh: '流行感轻钢琴', en: 'Light Pop Piano', side: '现代流行曲风（原创）' },
  { id: 'B4-S5-3-summer-flute-bossa', file: 'B4-S5-3-summer-flute-bossa.mp3', set: 'S5', zh: '夏日长笛轻 Bossa', en: 'Summer Flute Bossa', side: '明亮柔和' },
];

export const trackById = (id: string | undefined | null): BgmTrack | undefined => TRACKS.find(t => t.id === id);
export const tracksOfSet = (set: string): BgmTrack[] => TRACKS.filter(t => t.set === set);

/** 每个音景的主推曲（用户未自定义时的套内兜底） */
export const SET_DEFAULT: Record<string, string> = {
  S1: 'S1-1-warm-guitar-soft-piano',
  S2: 'S2-1-chinese-classical',
  S3: 'S3-1-bossa-lounge',
  S4: 'B3-S4-1-empathy-sad-ambient',
  S5: 'S5-1-fun-jazz',
};

/** 按剧本 id 的侧重点覆盖（在「标签→套」之上，进一步指定套内曲目） */
const SCENARIO_TRACK_OVERRIDE: Record<string, string> = {
  // S1：伤情/缺爱/产后 → 温柔带伤
  'shenshu-jiangjia': 'S1-3-sound-of-sadness',
  'guhuaizhi-chanhou': 'S1-3-sound-of-sadness',
  'shenjian-jiangnian': 'S1-3-sound-of-sadness',
  'lijinyan-xiaxia': 'S1-1-warm-guitar-soft-piano',
  // S2：替嫁/世家 → 温婉笛箫；世家留洋 → 中西折中；虐恋/失宠 → 中式伤情
  'peixiuyuan-linwantang': 'S2-2-chinese-flute-serenade',
  'shenyanzhi-liuyang': 'B2-S2-3-plum-blossom-piano',
  'xiaoyan-chisha': 'S2-5-sad-melancolic-oriental',
  'aluola-ailian': 'S2-5-sad-melancolic-oriental',
  'tuobaye-shenlianxing': 'B2-S2-1-celestial-bamboo-melody',
  'chengqingyan-xinhuang': 'S2-4-moonlit-whispers',
  'xiaoyan-qianqian': 'S2-1-chinese-classical',
  // S3
  'shenqingyi-luchi': 'S3-1-bossa-lounge',
  'suwanzhou-wenyan': 'S3-2-riviera-sunset',
  'fuxingzhou-yaba': 'B2-S3-1-piano-and-guitar-bossa',
  'guwanqing-heyu': 'S3-3-cozy-corner-bossa',
  'luyu-nvpengyou': 'S3-3-cozy-corner-bossa',
  // S5
  'luyan-waimai': 'B4-S5-2-light-pop-piano',
  'chenboyuan-qingxing': 'B4-S5-2-light-pop-piano',
  'jiangyubai-wenruanruan': 'B4-S5-3-summer-flute-bossa',
};

// 【标签 → 音景（与素材阶段 classify.mjs 一致，含少量人工覆盖）】
// 导出供 storyVoice（剧情配音音色）复用同一套标签分组，避免两处各维护一份标签表
export const ANCIENT = ['古代架空', '宫廷', '世家', '和亲', '替嫁', '帝王', '首辅', '君臣', '废后', '暴君', '才子', '世家世子', '草原王子', '病弱公主', '古筝', '留洋'];
export const SCHOOL = ['校园', '私立美高', '纯情学妹', '大金毛', '坏狗', '粘人学长', '橄榄球队长', '穷男友'];
export const COOL = ['刑警', '疯批', '背德', '禁忌', '掌控欲', '狂躁症', '情感漠视', '毒舌', '哑巴', '虐恋', '高傲', '复仇', '强制', '偏执帝王'];
export const WARM = ['治愈', '温柔', '医患', '病房', '护短', '养成', '监护人', '粘人', '缺爱', '卑微', '没有安全感', '产后抑郁'];

const TAG_SET_OVERRIDE: Record<string, 'S1' | 'S2' | 'S3' | 'S4' | 'S5'> = {
  shenshu_jiangjia: 'S1', guhuaizhi_chanhou: 'S1', shenjian_jiangnian: 'S1', lijinyan_xiaxia: 'S1', linzhao_xiaxia: 'S1',
  fuyanci_kunjing: 'S4', luwang_guxiaoman: 'S4', peizhisheng_suwan: 'S4', lutingyuan_shenyan: 'S4',
  luyan_waimai: 'S5', lusinian_chuanghuo: 'S5', chenboyuan_qingxing: 'S5',
  suwanzhou_wenyan: 'S3', shenqingyi_luchi: 'S3', luyu_nvpengyou: 'S3',
};

export function setForScenario(s: { id: string; tags?: string[] }): 'S1' | 'S2' | 'S3' | 'S4' | 'S5' {
  const idKey = s.id.replace(/-/g, '_');
  if (TAG_SET_OVERRIDE[idKey]) return TAG_SET_OVERRIDE[idKey];
  const tags = (s.tags || []).map(String);
  if (tags.some(t => ANCIENT.includes(t))) return 'S2';
  if (tags.some(t => SCHOOL.includes(t))) return 'S5';
  if (tags.some(t => COOL.includes(t))) return 'S4';
  if (tags.some(t => WARM.includes(t))) return 'S1';
  return 'S3';
}

/** 剧本的默认曲：优先剧本级覆盖 → 标签套的套内主推 → 全局 S1 主推 */
export function defaultTrackForScenario(s: { id: string; tags?: string[] }): BgmTrack {
  if (SCENARIO_TRACK_OVERRIDE[s.id]) {
    const t = trackById(SCENARIO_TRACK_OVERRIDE[s.id]);
    if (t) return t;
  }
  const set = setForScenario(s);
  const fallback = trackById(SET_DEFAULT[set]) || trackById(SET_DEFAULT.S1);
  return fallback || TRACKS[0];
}

/** 当前播放/面板用到的音频地址 */
export const bgmUrl = (id: string): string => '/music/roleplay/' + encodeURIComponent(id) + '.mp3';
