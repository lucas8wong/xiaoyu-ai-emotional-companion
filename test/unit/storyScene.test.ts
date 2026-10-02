import { test } from 'node:test';
import assert from 'node:assert';
import {
  SCENE_THEMES,
  SCENE_WORLDVIEWS,
  SCENE_PLACES,
  DEFAULT_THEME,
  DEFAULT_WORLDVIEW,
  themeOfText,
  matchTheme,
  worldviewOf,
  placeOf,
  masterScenePrompt,
  masterSceneUrl,
  scenePrompt,
  sceneImageFor,
  sceneUrlFor,
  poolUrlsFor,
  scenePoolUrl,
  sceneOwnUrl,
  sceneArtMatrix,
  SCENE_STYLE_SUFFIX as _SCENE_STYLE_SUFFIX,
  SCENE_STYLE_BASE,
  SCENE_NEGATIVE_PROMPT,
  negativePromptFor,
  SCENE_ART_VERSION,
  withSceneVersion,
  moodOf,
} from '../../src/lib/storyScene.js';

// 【主题解析：都市情感语境（文游那张武侠权谋表不能复用，这里是重做后的表）】
test('themeOfText：情感剧本文本 → 主题（雨/心动/争执/独处/承诺…）', () => {
  assert.strictEqual(themeOfText('「外面雨大，先进来躲一会儿吧。」'), 'rain');
  assert.strictEqual(themeOfText('他吻了吻她的额头'), 'intimate');
  assert.strictEqual(themeOfText('两个人吵了起来，杯子摔在地上'), 'conflict');
  assert.strictEqual(themeOfText('她一个人坐在天台上发呆'), 'alone');
  assert.strictEqual(themeOfText('他说：余生请多指教'), 'promise');
  assert.strictEqual(themeOfText('她翻出小时候的照片'), 'memory');
  assert.strictEqual(themeOfText('厨房里还温着一杯牛奶'), 'daily');
});

test('themeOfText：优先级与兜底（天气优先于时段；危机≠对峙；空值 → 日常）', () => {
  // "雨夜" 必须出雨景，而不是普通夜景（rain 在数组里排在 night 之前）
  assert.strictEqual(themeOfText('雨夜，路灯把水洼照得发亮'), 'rain');
  // 危机（追杀/受伤/失控）优先于对峙
  assert.strictEqual(themeOfText('有人追杀他，他受了伤，几乎失控'), 'crisis');
  // 但"质问/争吵"是对峙而非危机，不要因为写得激烈就升级成危机画面
  assert.strictEqual(themeOfText('他追上去质问她'), 'conflict');
  assert.strictEqual(themeOfText(''), DEFAULT_THEME);
  assert.strictEqual(themeOfText(null), DEFAULT_THEME);
  assert.strictEqual(themeOfText('嗯。'), DEFAULT_THEME);
});

test('worldviewOf：标签 → 世界观（留洋优先于世家 → 民国洋房，不是古风庭院）', () => {
  assert.strictEqual(worldviewOf({ tags: ['古代架空'] }), 'ancient');
  assert.strictEqual(worldviewOf({ tags: ['世家', '留洋'] }), 'republic');
  assert.strictEqual(worldviewOf({ tags: ['港圈年上'] }), 'hk');
  assert.strictEqual(worldviewOf({ tags: ['校园'] }), 'campus');
  assert.strictEqual(worldviewOf({ tags: ['都市', '总裁'] }), DEFAULT_WORLDVIEW);
  assert.strictEqual(worldviewOf({}), DEFAULT_WORLDVIEW);
});

test('matchTheme：换幕只认"明确命中"（未命中返回 null，避免画面乱闪）', () => {
  assert.strictEqual(matchTheme('雨点砸在窗上'), 'rain');
  assert.strictEqual(matchTheme('嗯。'), null);
  assert.strictEqual(matchTheme(''), null);
  assert.strictEqual(matchTheme(null), null);
  // themeOfText 是 matchTheme 的兜底版
  assert.strictEqual(themeOfText('嗯。'), DEFAULT_THEME);
  assert.strictEqual(themeOfText('雨点砸在窗上'), matchTheme('雨点砸在窗上'));
});

// 【红线：出图 prompt 必须只含白名单视觉要素，且显式无人物/无文字】
test('scenePrompt：内容打头（约束已交给负向词，不再占正面 prompt 前段）', () => {
  const p = scenePrompt('hk', 'rain');
  // 新契约（2026-09-14 换 SDXL base 后）：正面 prompt 由**场景内容**开场，SDXL 前段 token 权重最高，
  // 约束挤在前面会让具体器物（输液架/花轿）画不出来。
  assert.ok(p.startsWith('rain on the window from inside'), '场景内容必须打头，实际：' + p.slice(0, 60));
  assert.ok(p.includes('1990s Hong Kong interior'), p);
  assert.ok(p.includes('interior scene'), p);
  // 红线改由负向词承担：必须包含人物/文字/血腥压制
  assert.ok(/people/.test(SCENE_NEGATIVE_PROMPT) && /person/.test(SCENE_NEGATIVE_PROMPT), SCENE_NEGATIVE_PROMPT);
  assert.ok(/text/.test(SCENE_NEGATIVE_PROMPT) && /watermark/.test(SCENE_NEGATIVE_PROMPT), SCENE_NEGATIVE_PROMPT);
  assert.ok(/blood|corpse|weapon/.test(SCENE_NEGATIVE_PROMPT), SCENE_NEGATIVE_PROMPT);
  // 户外场景额外压制"室内房间名"（实测不加就会被画成客厅，用户截图就是这种情况）
  const outdoor = negativePromptFor({ scene: 'wet asphalt, street lamps', mood: 'cool', indoor: false });
  assert.ok(/living room/.test(outdoor) && /bedroom/.test(outdoor), outdoor);
  const indoor = negativePromptFor({ scene: 'dim living room', mood: 'warm', indoor: true });
  assert.ok(!/living room/.test(indoor), '室内场景不该压制客厅词：' + indoor);
  // 未知 id 不炸
  assert.ok(scenePrompt('nope', 'nope').includes('contemporary interior'));
});

test('scenePrompt：全部组合都不超 CLIP 的 77 token 上限（防静默截断）', () => {
  // 权威口径是真实分词器：scripts/check_scene_prompt_tokens.py（实测最长 55 tokens / 词数 38）
  // 这里用词数做**回归守卫**（node 侧拿不到 CLIP 分词器），阈值按实测留足余量
  const rows = sceneArtMatrix().map(r => ({ file: r.file, words: scenePrompt(r.worldview, r.theme).split(/\s+/).length }));
  const worst = rows.slice().sort((a, b) => b.words - a.words)[0];
  assert.ok(worst.words <= 42, `最长 prompt（${worst.file}，${worst.words} 词）已接近 77 token 上限，请压缩或跑 check_scene_prompt_tokens.py 复核`);
  // 约束短语不该再出现在正面 prompt 里（会白占前段权重）
  for (const r of sceneArtMatrix()) {
    const p = scenePrompt(r.worldview, r.theme);
    assert.ok(!/no people|no text/.test(p), r.file + '：约束不该再占正面 prompt（已交给负向词）');
    assert.ok(p.includes('interior scene'), r.file + '：缺少室内标记');
  }
});

test('sceneImageFor / sceneUrlFor：四层解析（专属画面 → 主场景图 → 主题池 → 兜底）', () => {
  assert.strictEqual(sceneImageFor(null, '雨').layer, 'none');
  // 没有主场景图、命中主题 → 共享主题池
  const pool = sceneImageFor({ id: 'luyu-nvpengyou', tags: ['都市'] }, '「外面雨大」');
  assert.deepStrictEqual(pool, { url: scenePoolUrl('modern', 'rain'), theme: 'rain', worldview: 'modern', place: 'home', layer: 'pool-theme' });
  // 有专属画面 → 优先级最高
  const own = sceneImageFor({ id: 'abc', tags: ['校园'] }, '他吻了她', new Set(['abc-intimate']));
  assert.strictEqual(own.url, sceneOwnUrl('abc', 'intimate'));
  assert.strictEqual(own.layer, 'own-theme');
  assert.strictEqual(own.place, 'campus');
  // 数组形式也支持
  assert.strictEqual(sceneImageFor({ id: 'abc' }, '雨', ['abc-rain']).layer, 'own-theme');
  // 有主场景图 → 压过主题池（"整部剧在自己的空间里"，换幕靠氛围层）
  const master = sceneUrlFor({ id: 'abc', tags: ['总裁'] }, 'rain', { master: true });
  assert.strictEqual(master.url, masterSceneUrl('abc'));
  assert.strictEqual(master.layer, 'master');
  assert.strictEqual(master.place, 'office');
  // 专属画面仍高于主场景图
  assert.strictEqual(sceneUrlFor({ id: 'abc' }, 'rain', { master: true, ownTheme: true }).layer, 'own-theme');
  // 什么都没命中且无主场景图 → 共享兜底（daily 只作为最后兜底，不再是"每部剧的默认画面"）
  assert.strictEqual(sceneUrlFor({ id: 'abc' }, null).layer, 'pool-daily');
});

test('placeOf：地点按标签判定，且被世界观裁剪（不出"古风+办案室"这种穿帮）', () => {
  assert.strictEqual(placeOf({ tags: ['总裁'] }), 'office');
  assert.strictEqual(placeOf({ tags: ['刑警'] }), 'police');
  assert.strictEqual(placeOf({ tags: ['温柔女医生'] }), 'hospital');
  assert.strictEqual(placeOf({ tags: ['校园'] }), 'campus');
  assert.strictEqual(placeOf({ tags: ['都市'] }), 'home');
  assert.strictEqual(placeOf({}), 'home');
  // 世界观裁剪：古风剧本即使带"刑警/医生"标签也留在古宅内室；民国同理
  assert.strictEqual(placeOf({ tags: ['古代架空', '刑警'] }), 'chamber');
  assert.strictEqual(placeOf({ tags: ['留洋', '温柔女医生'] }), 'chamber');
  // 校园剧本不会被判成办公室
  assert.strictEqual(placeOf({ tags: ['校园', '实习生'] }), 'campus');
  // 真实内置剧本抽查
  assert.strictEqual(placeOf({ tags: ['古代架空', '暴君', '复仇'] }), 'chamber');
  assert.strictEqual(placeOf({ tags: ['总裁', '洁癖', '实习生'] }), 'office');
});

test('masterScenePrompt：约束前置、白名单拼装、不超 token 守卫', () => {
  const p = masterScenePrompt('ancient', 'chamber');
  assert.ok(p.startsWith(SCENE_STYLE_BASE), p.slice(0, 60));
  assert.ok(/traditional chamber/.test(p), p);
  assert.ok(/traditional Chinese interior/.test(p), p);
  assert.ok(SCENE_PLACES.every(x => masterScenePrompt('modern', x.id).length > 0));
  // 未知 id 不炸
  assert.ok(masterScenePrompt('nope', 'nope').startsWith(SCENE_STYLE_BASE));
});

test('moodOf：冷/暖/中性分档（修掉"什么场景都暖阳"的根因）', () => {
  // 冷：办案室/医院 + 危机/争执/冷战/独处/夜
  assert.strictEqual(moodOf({ place: 'police' }), 'cool');
  assert.strictEqual(moodOf({ place: 'hospital' }), 'cool');
  assert.strictEqual(moodOf({ theme: 'crisis' }), 'cool');
  assert.strictEqual(moodOf({ theme: 'night' }), 'cool');
  // 暖：家/古宅 + 亲密/承诺/和好/回忆/心动/日常
  assert.strictEqual(moodOf({ place: 'home' }), 'warm');
  assert.strictEqual(moodOf({ theme: 'intimate' }), 'warm');
  assert.strictEqual(moodOf({ theme: 'daily' }), 'warm');
  // 中性：办公室/校园/相遇/雨/离别…
  assert.strictEqual(moodOf({ place: 'office' }), 'neutral');
  assert.strictEqual(moodOf({ theme: 'rain' }), 'neutral');
  assert.strictEqual(moodOf({}), 'neutral');
  // 地点优先于主题：医院 + 亲密 → 冷（场所决定空间感）
  assert.strictEqual(moodOf({ place: 'hospital', theme: 'intimate' }), 'cool');
});

test('红线（2026-09-14 二次复盘）：世界观不得再描述"房间类型"，且色调按分档而非写死暖调', () => {
  // 用户实测：刑警剧本被画成"暖阳居家书房"，根因是 modern 世界观写了 apartment + 全局 warm palette
  for (const w of SCENE_WORLDVIEWS) {
    assert.ok(!/apartment|villa|mansion/i.test(w.setting), `${w.id} 的世界观又写房间类型了：${w.setting}`);
  }
  // 刑警办案室的 prompt 必须是冷调，且不含"公寓/纱帘"这类居家词
  const police = masterScenePrompt('modern', 'police');
  assert.ok(/cool muted palette/.test(police), police);
  assert.ok(!/apartment|curtains|sheer/i.test(police), police);
  // 而"家里"仍是暖调
  assert.ok(/warm palette/.test(masterScenePrompt('modern', 'home')));
  // 主题池同理：危机/夜是冷调，日常是暖调
  assert.ok(/cool muted palette/.test(scenePrompt('modern', 'crisis')));
  assert.ok(/warm palette/.test(scenePrompt('modern', 'daily')));
});

test('新增主题 work/hospital 确实能被真实句式命中（复盘：此前全掉进 daily）', () => {
  assert.strictEqual(matchTheme('「这个项目今晚必须交。」她看了眼表。'), 'work');
  assert.strictEqual(matchTheme('「合同签了。」他松开领带。'), 'work');
  assert.strictEqual(matchTheme('医院走廊的灯很白，消毒水味道很重。'), 'hospital');
  assert.strictEqual(matchTheme('他拉住你的手腕：「你别走。」'), 'intimate');
});

test('poolUrlsFor：进入剧情预热用的主题池地址（同世界观、去重、数量=主题数）', () => {
  const urls = poolUrlsFor({ tags: ['古代架空'] });
  assert.strictEqual(urls.length, SCENE_THEMES.length);
  assert.strictEqual(new Set(urls).size, urls.length);
  assert.ok(urls.every(u => u.startsWith('/img/roleplay-scenes/ancient-')));
  assert.deepStrictEqual(poolUrlsFor(null), []);
});

test('sceneArtMatrix：出图组合矩阵 = 世界观 × 主题，文件名唯一且与 poolUrl 一致', () => {
  const m = sceneArtMatrix();
  assert.strictEqual(m.length, SCENE_WORLDVIEWS.length * SCENE_THEMES.length);
  assert.strictEqual(new Set(m.map(x => x.file)).size, m.length);
  for (const row of m) {
    // poolUrl 现在带 `?v=` 版本参数（破缓存用），比对时要去掉 query
    assert.strictEqual('/img/roleplay-scenes/' + row.file, scenePoolUrl(row.worldview, row.theme).split('?')[0]);
  }
});

test('SCENE_ART_VERSION：所有场景图 URL 都带版本号（防"改名不变→浏览器/CDN 给旧图 7 天"）', () => {
  assert.ok(SCENE_ART_VERSION.length > 0);
  for (const u of [scenePoolUrl('modern', 'rain'), sceneOwnUrl('abc', 'rain'), masterSceneUrl('abc')]) {
    assert.ok(u.includes('?v=' + SCENE_ART_VERSION), u);
  }
  assert.strictEqual(withSceneVersion(''), '');
  assert.ok(withSceneVersion('/a.webp?x=1', 'zzz').endsWith('&v=zzz'));
});

test('主题表/世界观表自洽：id 唯一、关键词与场景描述非空、正则合法', () => {
  assert.strictEqual(new Set(SCENE_THEMES.map(t => t.id)).size, SCENE_THEMES.length);
  assert.strictEqual(new Set(SCENE_WORLDVIEWS.map(w => w.id)).size, SCENE_WORLDVIEWS.length);
  for (const t of SCENE_THEMES) {
    assert.ok(t.scene.trim().length > 10, t.id + ' scene 太短');
    assert.ok(t.keywords instanceof RegExp, t.id + ' keywords 必须是正则');
    assert.ok(t.label.trim().length > 0, t.id + ' label 不能为空');
  }
  // 每个世界观都要有 setting（否则 prompt 拼不出来）
  for (const w of SCENE_WORLDVIEWS) assert.ok(w.setting.trim().length > 10, w.id + ' setting 太短');
  // 主题 id 不得与世界观 id 撞名（拼文件名时会歧义）
  const tIds = new Set(SCENE_THEMES.map(t => t.id));
  for (const w of SCENE_WORLDVIEWS) assert.ok(!tIds.has(w.id), '世界观 id 与主题 id 撞名: ' + w.id);
});
