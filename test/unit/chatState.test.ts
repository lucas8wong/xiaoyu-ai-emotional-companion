/**
 * 聊一聊「会话状态层」守卫（B 档，2026-09-21）
 *
 * 这组断言钉死六件事：
 *   ① scene 只收**具体动作**——万能动作（叹气/点头/眼神）、被 slop 清单点名的道具族（手机/灯/声音）、
 *      以及**别扭句**（同一个词隔字重复，实测原句「把怀里那罐光往怀里搂了搂」）一律不收；
 *   ② 情绪惯性：判得出就更新，判不出就**沿用**（不自作主张重置成中性）；
 *   ③ 账（grudge）宁缺勿滥：短、指向你、且不处在低落气氛里，三条同时成立才记；
 *   ④ 梗（joke）必须是**双方嘴里都出现过**的片段，且要玩到第 2 次才注入（停用词一律不算）；
 *   ⑤ 过期即消失（state 是"此刻"，不是第二份长期记忆）+ 纯函数（不改入参）；
 *   ⑥ 括号刹车：最近两条 AI 回复都带括号才刹车，且它真的进得了 system。
 *   ⑦ 自己的近况（ownLife，2026-09-23）：你讲过的小事要**跨会话**记下来，只 +1 次不新增条目，
 *      14 天过期、最多 6 条，并且注入时明写"不许再从头讲一遍"（同时给延续的出口）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const st: typeof import('../../api/services/chatState.js') = await import('../../api/services/chatState.js');
const gem: any = await import('../../api/services/gemini.js');
const growth: any = await import('../../api/services/chatCharacterGrowth.js');
const prefs: any = await import('../../api/services/preferences.js');

const H = 3600_000;

/* ───────── ① scene ───────── */

test('scene：具体动作收下；万能动作、被点名的道具族、别扭句一律不收', () => {
  assert.equal(st.extractScene('乖。\n\n（把充电线拽过来给自己充上电）都这个点了'), '把充电线拽过来给自己充上电');
  assert.equal(st.extractScene('（把外套往沙发上一搭）过来'), '把外套往沙发上一搭');

  // 万能动作：放谁身上都成立
  assert.equal(st.extractScene('（轻轻叹了口气）我懂'), undefined);
  assert.equal(st.extractScene('（点了点头）'), undefined);
  assert.equal(st.extractScene('（压低声音）'), undefined);

  // slop 清单点名的道具族：记下来等于给刚禁掉的那一族续命
  assert.equal(st.extractScene('（把手机搁一边）'), undefined);
  assert.equal(st.extractScene('（把灯调暗了些）'), undefined);

  // 别扭句：同一个词隔字重复（**实测原句**，判据不能只查相邻重复）
  assert.equal(st.extractScene('（把怀里那罐光往怀里搂了搂）那你倒说说'), undefined);

  // 没有括号 = 没有场景
  assert.equal(st.extractScene('行，我笨。'), undefined);
});

test('scene：纯函数与幂等——同一份输入跑两遍结果一致', () => {
  const a = st.extractScene('（把杯子往你那边推了推）喝点');
  const b = st.extractScene('（把杯子往你那边推了推）喝点');
  assert.equal(a, b);
  assert.equal(a, '把杯子往你那边推了推');
});

/* ───────── ② mood ───────── */

test('mood：各档命中；判不出返回 undefined（沿用旧心情，不硬猜）', () => {
  assert.equal(st.detectMood('哼，才不理你'), 'sulky');
  assert.equal(st.detectMood('都这个点了，闭眼睡'), 'sleepy');
  assert.equal(st.detectMood('看吧，我就说你撑不住'), 'proud');
  assert.equal(st.detectMood('没事吧？别硬撑'), 'worried');
  assert.equal(st.detectMood('哈哈，逗你的'), 'teasing');
  assert.equal(st.detectMood('乖，抱一下'), 'warm');
  assert.equal(st.detectMood('今天天气不错'), undefined);
  assert.equal(st.detectMood(''), undefined);
});

/* ───────── ③ grudge ───────── */

test('grudge：短、指你、且不在低落气氛里——三条同时成立才记账', () => {
  assert.equal(st.detectGrudge({ userText: '哈哈哈你也太笨了吧', scene: 'playful' }), '哈哈哈你也太笨了吧');
  assert.equal(st.detectGrudge({ userText: '你完了', scene: 'playful' }), '你完了');
  // 不指你：用户在讲别人
  assert.equal(st.detectGrudge({ userText: '我哥真是个笨蛋', scene: 'playful' }), undefined);
  // 低落气氛：那句难过不是冲你来的，记成账就是记错仇
  assert.equal(st.detectGrudge({ userText: '我真的好累，感觉自己很没用', scene: 'tender' }), undefined);
  // 长段落在讲自己的事
  assert.equal(st.detectGrudge({ userText: '我今天遇到一个特别讨厌的人，他一直在会上打断我说话，让我很不舒服', scene: 'neutral' }), undefined);
  // 没骂
  assert.equal(st.detectGrudge({ userText: '在干嘛', scene: 'neutral' }), undefined);
});

/* ───────── ④ joke：双方都用过才算 ───────── */

test('joke：只有双方嘴里都出现过的具体片段才算「我们之间的梗」', () => {
  const hit = st.mineJokes({ userText: '这种哥哥还能要吗，我要退货', aiReply: '退货通道早就焊死了，签收十几年了' });
  assert.ok(hit.includes('退货'), '双方都用过的词应当命中：' + JSON.stringify(hit));
  // 只有一方用过 → 不是两个人的梗（那是模型自己的口癖）
  assert.deepEqual(st.mineJokes({ userText: '我要退货', aiReply: '行吧' }), []);
  // 停用词不算
  assert.deepEqual(st.mineJokes({ userText: '今天怎么样', aiReply: '今天挺好的' }), []);
});

/* ───────── ⑤ updateChatState：纯函数 + 过期 + 上限 ───────── */

test('updateChatState：不改入参（纯函数），过期条目自动消失', () => {
  const now = 1_700_000_000_000;
  const prev = {
    scene: { text: '把杯子往你那边推了推', at: now - 7 * H }, // 已过 6h TTL
    mood: { kind: 'sulky' as const, at: now - 2 * H },
    grudges: [{ text: '你完了', at: now - 30 * H }],          // 已过 24h TTL
    jokes: [{ text: '退货', at: now - 8 * 24 * H, hits: 3 }], // 已过 7d TTL
  };
  const snapshot = JSON.parse(JSON.stringify(prev));
  const next = st.updateChatState(prev, { userText: '在吗', aiReply: '在。', now });

  assert.deepEqual(prev, snapshot, '入参被改动了 —— updateChatState 必须是纯函数');
  assert.equal(next.scene, undefined, '过期 scene 应当消失');
  assert.equal(next.grudges, undefined, '过期账应当消失');
  assert.equal(next.jokes, undefined, '过期梗应当消失');
  assert.equal(next.mood?.kind, 'sulky', '未过期的情绪惯性应当保留');
});

test('updateChatState：判不出心情就沿用旧的（情绪惯性有黏性），账与梗各自去重/累加', () => {
  const now = 1_700_000_000_000;
  const first = st.updateChatState(undefined, { userText: '你也太笨了吧', aiReply: '哼，才不理你', scene: 'playful', now });
  assert.equal(first.mood?.kind, 'sulky');
  assert.equal(first.grudges?.[0]?.text, '你也太笨了吧');

  // 第二轮：模型没写情绪词 → 沿用 sulky；这句骂（**含"你"，判据要求指向你**）记成新账；梗玩到第二次 → hits=2
  const second = st.updateChatState(first, { userText: '你也真是笨蛋，退货！', aiReply: '退货？焊死了', scene: 'playful', now: now + 60_000 });
  assert.equal(second.mood?.kind, 'sulky', '判不出心情时应当沿用，而不是重置');
  assert.equal(second.grudges?.length, 2, '新账应当加上（旧账未被清掉）');
  // 第一轮没出现"退货"，所以这是**第一次**挖到它（hits=1）；玩到第 2 次才会被注入（见注入块用例）
  assert.equal(second.jokes?.find((j: any) => j.text === '退货')?.hits, 1);

  // 同一句重复骂：不去重就会刷屏；同时 AI 也接住了"退货" → hits 累加到 2
  const third = st.updateChatState(second, { userText: '你也真是笨蛋，退货！', aiReply: '退货是吧，焊死的', scene: 'playful', now: now + 120_000 });
  assert.equal(third.grudges?.filter((g: any) => g.text === '你也真是笨蛋，退货！').length, 1);
  assert.equal(third.jokes?.find((j: any) => j.text === '退货')?.hits, 2, '双方都用过之后 hits 应当累加');
});

test('updateChatState：账最多留 3 条（新的在前）', () => {
  const now = 1_700_000_000_000;
  let s = st.emptyState();
  for (const [i, t] of ['你笨死了', '你完了', '讨厌你', '你太傻了'].entries()) {
    s = st.updateChatState(s, { userText: t, aiReply: '哼', scene: 'playful', now: now + i * 1000 });
  }
  assert.equal(s.grudges?.length, 3);
  assert.equal(s.grudges?.[0]?.text, '你太傻了', '最新的账排在最前');
});

/* ───────── ⑥ 括号刹车 + 注入块 ───────── */

test('括号刹车：最近两条 AI 回复都带括号才刹车（一条不刹）', () => {
  assert.equal(st.chatBracketBrakes([
    { role: 'assistant', content: '（把杯子放下）嗯。' },
    { role: 'assistant', content: '（把外套一搭）过来。' },
  ]), true);
  assert.equal(st.chatBracketBrakes([
    { role: 'assistant', content: '（把杯子放下）嗯。' },
    { role: 'assistant', content: '过来。' },
  ]), false);
  assert.equal(st.chatBracketBrakes([]), false);
});

test('注入块：没状态就不注入；开关能关；梗要玩到第 2 次才注入', () => {
  const now = 1_700_000_000_000;
  assert.equal(st.buildChatStateBlock(undefined, { now }), '');
  assert.equal(st.buildChatStateBlock(st.emptyState(), { now }), '');

  const block = st.buildChatStateBlock({
    scene: { text: '把充电线拽过来给自己充上电', at: now - 5 * 60_000 },
    mood: { kind: 'sulky', at: now - 60_000 },
    grudges: [{ text: '你也太笨了吧', at: now - 3 * 60_000 }],
    jokes: [{ text: '退货', at: now - 60_000, hits: 3 }],
  }, { now });
  assert.ok(block.includes('把充电线拽过来给自己充上电'));
  assert.ok(block.includes('不要再抓一个新道具'), '必须写清"接着这件事做下去，不要换新道具"');
  assert.ok(block.includes('还没算完的账') && block.includes('你也太笨了吧'));
  assert.ok(block.includes('退货') && block.includes('3 次'));

  // hits=1 的梗还不算"两个人的梗"，不注入
  const oneHit = st.buildChatStateBlock({ jokes: [{ text: '退货', at: now, hits: 1 }] }, { now });
  assert.equal(oneHit, '');

  const prev = process.env.CHAT_STATE;
  process.env.CHAT_STATE = '0';
  try {
    assert.equal(st.buildChatStateBlock({ grudges: [{ text: '你完了', at: now }] }, { now }), '');
  } finally {
    if (prev === undefined) delete process.env.CHAT_STATE; else process.env.CHAT_STATE = prev;
  }
});

test('注入块：三语（en 不夹中文、zh-TW 为繁体）', () => {
  const state = { grudges: [{ text: '你也太笨了吧', at: 1_700_000_000_000 }] };
  const en = st.buildChatStateBlock(state, { now: 1_700_000_000_000, lang: 'en' });
  assert.ok(!/[\u4e00-\u9fff]/.test(en.replace('你也太笨了吧', '')), '英文块除引用原话外不许有中文');
  assert.ok(en.includes('SCORES NOT SETTLED'));
  const tw = st.buildChatStateBlock(state, { now: 1_700_000_000_000, lang: 'zh-TW' });
  // 「账」的繁体正字是「賬」（OpenCC 走 zhConvert），别把字形写死成简体的「账」
  assert.ok(/還沒算完的[賬帳]/.test(tw) && !tw.includes('还没算完的账'));
});

test('注入块：括号刹车时明写"这一轮不要写括号动作"', () => {
  const now = 1_700_000_000_000;
  const block = st.buildChatStateBlock(undefined, { now, bracketBrake: true });
  assert.ok(block.includes('不要写括号动作'));
});

/* ───────── ⑦ 接线：状态真的进 system ───────── */

test('接线：成长档案里的状态会进真实 system；连续两条带括号会触发刹车块', async () => {
  const uid = 'u-state-wire';
  const now = Date.now();
  /**
   * ⚠️ 必须显式把界面语言钉成 zh-CN：`chatOutputLang` 是「跟随输入字体 + 回退界面语言」，
   * 而本用例的探针消息（"哈哈哈哈你也太笨了吧"）**简繁同形**，判不出字体 → 回退。
   * 默认偏好是 zh-TW ⇒ 整个块会被 `toZhTw` 转成繁体，断言里的简体字符串就全都找不到了
   * （这正是我第一版测试失败的原因：不是功能坏了，是断言没算到语言这一层）。
   */
  prefs.preferenceStore.set(uid, { language: 'zh-CN' });
  growth.chatCharacterGrowthStore.setState(uid, 'xiaoyu', {
    grudges: [{ text: '你也太笨了吧', at: now - 60_000 }],
    jokes: [{ text: '退货', at: now - 60_000, hits: 2 }],
  });
  const { system } = await gem.buildChatPromptParts([{ role: 'user', content: '在干嘛' }], { userId: uid }, true);
  assert.ok(system.includes('【你们之间还没算完的账】'), '状态块没进 system');
  assert.ok(system.includes('退货'));

  const braked = (await gem.buildChatPromptParts([
    { role: 'assistant', content: '（把杯子放下）嗯。' },
    { role: 'assistant', content: '（把外套一搭）过来。' },
    { role: 'user', content: '哈哈哈哈你也太笨了吧' },
  ], { userId: uid }, true)).system;
  assert.ok(braked.includes('【这一轮括号动作停一次】'), '连续两条带括号时应当刹车');
});

/* ───────── ⑧ ownLife：你自己的近况（2026-09-23）───────── */

/**
 * 夹具是**真实数据**：同一个糗事在三个不同会话里被讲了三次（用户原话「好像过了很久又说一次」）。
 * 三条都要能被抽到 —— 第一条尤其重要：它后半截带"你"，靠**逗号也切句**才保得住前半截。
 */
const REAL_OWN_LIFE = [
  '反正我也没什么好藏的，今天我自己还坐错车，一路坐到终点站才反应过来，你要测反应速度的话我大概不及格。',
  '今天坐错车，一路坐到终点站去了，司机收工前才把我赶下来。',
  '行吧，我今天坐错车一路坐到终点站，都没你这一句离谱。',
];

test('extractOwnLife：三种真实说法都能抽到"我自己的事"', () => {
  for (const reply of REAL_OWN_LIFE) {
    const got = st.extractOwnLife(reply);
    assert.ok(got.length >= 1, '没抽到自己的事：' + reply);
    assert.ok(got.some((t) => /坐错车/.test(t)), '抽到的不是那件事：' + JSON.stringify(got));
  }
});

test('extractOwnLife：关于用户的话、问句、心情表态、超长句一律不抽', () => {
  assert.deepEqual(st.extractOwnLife('你今天坐错车了吧，要不要说说？'), [], '提到"你"的不该记成我的事');
  assert.deepEqual(st.extractOwnLife('今天你还好吗？'), []);
  assert.deepEqual(st.extractOwnLife('我今天有点累。'), [], '没有具体动作的心情表态不算一件事');
  assert.deepEqual(st.extractOwnLife('我'), []);
  assert.deepEqual(st.extractOwnLife(''), []);
  const longOne = '我今天' + '坐'.repeat(1) + '车'.repeat(50); // > 40 字
  assert.deepEqual(st.extractOwnLife(longOne), [], '超长句不该进（小事就该短）');
});

test('updateChatState：同一件事第二次讲只 +1 次、不新增条目（这就是"别再讲第二遍"的判据来源）', () => {
  const now = 1_700_000_000_000;
  const first = st.updateChatState(undefined, { userText: '在吗', aiReply: REAL_OWN_LIFE[2], now });
  assert.equal(first.ownLife?.length, 1);
  assert.equal(first.ownLife?.[0].told, 1, '第一次讲应当记 told=1');
  const second = st.updateChatState(first, { userText: '还没睡', aiReply: '我也还醒着。' + REAL_OWN_LIFE[1], now: now + 3600_000 });
  assert.equal(second.ownLife?.length, 1, '换了个说法讲同一件事，不该变成两条');
  assert.ok((second.ownLife?.[0].told ?? 0) >= 2, 'told 没累加');
});

test('updateChatState：自己的近况 14 天过期、最多留 6 条、新的在前', () => {
  const now = 1_700_000_000_000;
  let s = st.updateChatState(undefined, { userText: '在吗', aiReply: '我今天坐错车坐到终点站了', now });
  assert.equal(s.ownLife?.length, 1);
  const expired = st.updateChatState(s, { userText: '在吗', aiReply: '在。', now: now + st.STATE_TTL.ownLife + 1000 });
  assert.equal(expired.ownLife, undefined, '14 天后应当清掉');
  for (let i = 0; i < 8; i++) {
    s = st.updateChatState(s, { userText: '在吗', aiReply: '我今天买了第' + i + '个东西', now: now + i * 1000 });
  }
  assert.equal(s.ownLife?.length, 6, '最多 6 条');
  assert.ok(/第7个/.test(s.ownLife![0].text), '最新的应当在最前：' + s.ownLife![0].text);
});

test('注入块：明写"已经讲过、不许再从头讲一遍"，并给延续的出口（不是单纯禁止）', () => {
  const now = 1_700_000_000_000;
  const block = st.buildChatStateBlock(
    { ownLife: [{ text: '今天坐错车一路坐到终点站', at: now - 3600_000, told: 2 }] },
    { now, lang: 'zh-CN' },
  );
  assert.ok(block.includes('【你自己的近况 · 这些你已经讲过了】'), '块标题不在');
  assert.ok(block.includes('今天坐错车一路坐到终点站'));
  assert.ok(block.includes('不许再从头讲一遍'), '缺"别再讲第二遍"的硬要求');
  assert.ok(block.includes('新进展'), '只禁不给出口 —— 会把模型逼向"干脆不提自己"');
  // 探针实测（scripts/chat-selflife-probe.mts）：直问"你今天干嘛了"时她仍会把**过程**复述一遍
  // ⇒ 因此加一条"非要提就一句话带过"，这一条也是从实测来的，不是想当然。
  assert.ok(block.includes('一句话带过'), '缺"别复述过程"这一层（实测她会把经过再讲一遍）');
  const en = st.buildChatStateBlock({ ownLife: [{ text: 'I took the wrong bus', at: now, told: 1 }] }, { now, lang: 'en' });
  assert.ok(en.includes('ALREADY told') && /do not tell them again/i.test(en), '英文块缺"别再讲一遍"：' + en);
  assert.equal(st.buildChatStateBlock({}, { now }), '', '没有状态时必须返回空串（不注入空噪声）');
});

test('接线：你自己的近况会进真实 system', async () => {
  const uid = 'u-own-life-wire';
  prefs.preferenceStore.set(uid, { language: 'zh-CN' });
  growth.chatCharacterGrowthStore.setState(uid, 'xiaoyu', {
    ownLife: [{ text: '今天坐错车一路坐到终点站', at: Date.now() - 120_000, told: 1 }],
  });
  const { system } = await gem.buildChatPromptParts([{ role: 'user', content: '在干嘛' }], { userId: uid }, true);
  assert.ok(system.includes('【你自己的近况 · 这些你已经讲过了】'), 'ownLife 没进 system');
  assert.ok(system.includes('坐错车'), '具体那件事没进 system');
});
