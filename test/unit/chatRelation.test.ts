/**
 * 聊一聊「关系档 × 场景分流」守卫（2026-09-21）
 *
 * 覆盖本次改动的四条机制里**可自动判据**的部分（真人感本身没有自动判据，靠实跑 + 人读）：
 *   ① 关系档白名单：缺省/非法值一律回落 friend（老数据没有这个字段）；
 *   ② 四档真的产出**不同的口吻参数**（不是四套体系，是同一套机制跑不同参数）；
 *   ③ 场景分流：playful/tender 各注入自己的块、neutral 不注入，
 *      **tender 优先于 playful**（宁把玩笑误判成低落，也不能把"我撑不住了"误判成玩梗）；
 *   ④ 三语齐全，且 en 不串中文、zh-TW 是繁体；
 *   ⑤ `CHAT_RELATION=0` 是干净的空串（消融臂 = 改动前行为）；
 *   ⑥ 接线正确：内置小愈读**用户级偏好**、自定义角色读**角色字段**、**剧情角色不注入**（Q4=A 口径）；
 *      并且"连发"规则真的进了 system（本次解除了原来的禁止拆条）；
 *   ⑦ 第二条红线（2026-10-02）：四档 × 三气氛都带着「玩梗要 TA 先起头 / 不许替 TA 认定 / 不许给 TA 出题」
 *      三条禁令，并逐字点名封掉「你还想装没追？」「别装了」这一族句式；损友档的旧措辞（"谁也别想在对方面前装"、
 *      "翻 TA 的旧账"）不得回归，同时"怼"的许可保留 —— 只改"怼什么"，不改玩梗强度。
 *
 * 最后一条不变量与 `chatVoice.test.ts` 咬合：关系块**不许**把「我在呢 / 慢慢说」请回提示词
 * （那两句是被模型当标准答案抄的样板，见 chatVoice.ts 文件头）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const cr: typeof import('../../api/services/chatRelation.js') = await import('../../api/services/chatRelation.js');
const gem: any = await import('../../api/services/gemini.js');
const prefs: any = await import('../../api/services/preferences.js');
const cc: typeof import('../../api/services/chatCharacter.js') = await import('../../api/services/chatCharacter.js');

const KINDS = ['friend', 'buddy', 'family', 'lover'] as const;
const block = (relation: string, scene: 'playful' | 'tender' | 'neutral' = 'neutral', lang = 'zh-CN') =>
  cr.buildChatRelationBlock({ relation, scene, lang });

/* ───────── ① 白名单与缺省 ───────── */

test('关系档：四档都认；缺省/非法/空值一律回落 friend', () => {
  for (const k of KINDS) assert.equal(cr.normalizeRelation(k), k);
  for (const bad of [undefined, null, '', 'friend2', 'LOVER', 'x', 1, {}]) {
    assert.equal(cr.normalizeRelation(bad), 'friend', String(bad) + ' 应当回落 friend');
  }
  assert.equal(cr.RELATION_KINDS.length, 4);
  assert.ok(cr.isRelationKind('buddy') && !cr.isRelationKind('buddy '));
});

/* ───────── ② 四档产出真的不同 ───────── */

test('关系档：四档产出互不相同，且各自写出自己的关系名与分寸', () => {
  const texts = KINDS.map((k) => block(k));
  assert.equal(new Set(texts).size, 4, '四档的提示词块必须互不相同');
  assert.ok(texts[0].includes('朋友'));
  assert.ok(texts[1].includes('损友'));
  assert.ok(texts[2].includes('家人'));
  assert.ok(texts[3].includes('恋人'));
  // 分寸必须真的有差别：家人档敢管、损友档敢怼、恋人档要注意力
  assert.ok(block('family').includes('管'), '家人档必须写清"有资格管 TA"');
  assert.ok(block('buddy').includes('怼'), '损友档必须写清"可以怼回去"');
  assert.ok(block('lover').includes('注意力'), '恋人档必须写清"你要的是 TA 的注意力"');
  assert.ok(block('friend').includes('没资格命令'), '朋友档必须写清"没有命令 TA 的资格"');
});

test('关系档：只有家人/恋人档带「亲密上限」，且恋人档把性内容与道德绑架都钉成禁令', () => {
  assert.ok(!block('friend').includes('亲密上限'));
  assert.ok(!block('buddy').includes('亲密上限'));
  const fam = block('family');
  const lov = block('lover');
  assert.ok(fam.includes('亲密上限') && fam.includes('不许越界替 TA 做决定'));
  assert.ok(lov.includes('亲密上限') && lov.includes('不写性内容'));
  assert.ok(lov.includes('没有我你怎么办'), '必须逐字点名封掉情感绑架那一族');
});

/* ───────── ③ 场景分流（tender 优先） ───────── */

test('场景判定：玩梗 → playful，低落/高危 → tender，平常 → neutral', () => {
  assert.equal(cr.pickChatScene('哈哈哈哈你也太笨了吧'), 'playful');
  assert.equal(cr.pickChatScene('这种哥哥还能要吗？'), 'playful');
  assert.equal(cr.pickChatScene('切'), 'playful');
  assert.equal(cr.pickChatScene('今天真的好累，什么都不想做'), 'tender');
  assert.equal(cr.pickChatScene('我撑不下去了'), 'tender');
  assert.equal(cr.pickChatScene('太痛苦了'), 'tender', '与 DISTRESS_PATTERNS 共用同一份高危判据');
  assert.equal(cr.pickChatScene('帮我想想明天吃什么'), 'neutral');
  assert.equal(cr.pickChatScene(''), 'neutral');
});

test('场景判定：tender 压过 playful（宁把玩笑误判成低落，也不把"撑不住"误判成玩梗）', () => {
  assert.equal(cr.pickChatScene('笑死，但我是真的撑不住了'), 'tender');
  assert.equal(cr.pickChatScene('哈哈哈，不过我现在好累'), 'tender');
});

test('场景块：playful 要"接着加码"，tender 要"玩闹全部停用"；neutral 不注入场景块', () => {
  const play = block('lover', 'playful');
  const soft = block('lover', 'tender');
  const neutral = block('lover', 'neutral');
  assert.ok(play.includes('气氛') && play.includes('加码'));
  assert.ok(soft.includes('停用'), 'tender 块必须明写关系档的棱角这一轮全部停用');
  assert.ok(soft.includes('不分析 TA 的心理'));
  assert.ok(!neutral.includes('【这一轮的气氛'), 'neutral 不该被额外指挥');
  assert.ok(neutral.includes('【你和 TA 的关系'));
});

/* ───────── ④ 三语 ───────── */

test('三语：en 不出中文、zh-TW 是繁体、四档名各自本地化', () => {
  const en = block('lover', 'playful', 'en');
  assert.ok(!/[\u4e00-\u9fff]/.test(en), '英文块里不许夹中文');
  assert.ok(en.includes('partner') && en.includes('TONE OF THIS TURN'));
  const tw = block('family', 'tender', 'zh-TW');
  assert.ok(tw.includes('關係') && tw.includes('稱呼'), 'zh-TW 必须转繁体');
  assert.ok(!tw.includes('关系'));
});

/* ───────── ⑤ 消融开关 ───────── */

test('CHAT_RELATION=0：整体返回空串（消融臂 = 改动前行为）', () => {
  const prev = process.env.CHAT_RELATION;
  process.env.CHAT_RELATION = '0';
  try {
    assert.equal(block('lover', 'playful'), '');
    assert.equal(block('friend', 'tender'), '');
  } finally {
    if (prev === undefined) delete process.env.CHAT_RELATION; else process.env.CHAT_RELATION = prev;
  }
});

/* ───────── ⑦ 第二条红线（2026-10-02）：不替 TA 认定、不主动开火、不出题 ───────── */

test('红线：四档 × 三种气氛都带着「不替 TA 认定 / 玩梗要 TA 先起头 / 不出题」三条禁令', () => {
  for (const k of KINDS) {
    for (const sc of ['playful', 'tender', 'neutral'] as const) {
      const t = block(k, sc);
      assert.ok(t.includes('玩梗要 TA 先起头'), `${k}/${sc} 缺「先起头」`);
      assert.ok(t.includes('不许替 TA 认定'), `${k}/${sc} 缺「不替 TA 认定」`);
      assert.ok(t.includes('不许给 TA 出题'), `${k}/${sc} 缺「不出题」`);
      // 逐字点名被封的那一族句式（本次实测就是它：你还想装没追？）
      assert.ok(t.includes('你还想装没追？') && t.includes('别装了'), `${k}/${sc} 没点名封掉「装」字句`);
    }
  }
  const en = block('buddy', 'playful', 'en');
  assert.ok(!/[\u4e00-\u9fff]/.test(en), '英文块里不许夹中文');
  assert.ok(en.includes('Banter needs a first move from them'));
  assert.ok(en.includes('Never decide anything about them') && en.includes('Do not set them a test'));
});

test('损友档改写：不再让 TA「别装」（旧措辞不得回归），但「怼」的许可保留', () => {
  const b = block('buddy');
  assert.ok(!b.includes('谁也别想在对方面前装'), '旧措辞「谁也别想在对方面前装」是本次攻击性的种子，不许回来');
  assert.ok(!b.includes('翻 TA 的旧账'), '「翻旧账」等于拿记忆当武器，不许回来');
  assert.ok(b.includes('怼'), '损友仍然可以怼（只改"怼什么"，不改玩梗强度）');
  assert.ok(b.includes('有来有往'));
  const enB = block('buddy', 'neutral', 'en');
  assert.ok(!/show off in front of them/i.test(enB) && !/[Ff]ire back, dig up/.test(enB), '英文档的对应旧措辞也要清掉');
});

test('playful 块：可以怼那句话，但不许把 TA 说成在装（玩闹里也一样）', () => {
  const p = block('buddy', 'playful');
  assert.ok(p.includes('加码'));
  assert.ok(p.includes('不许把 TA 说成在装'), 'playful 块必须写明这条，本次翻车就发生在玩闹口吻里');
});

/* ───────── ⑥ 接线：真实 system ───────── */

const UID = 'u-relation-test';

test('接线：内置小愈的关系档读用户级偏好，并真的进了 system', async () => {
  prefs.preferenceStore.set(UID, { language: 'zh-CN', xiaoyuRelation: 'lover' });
  const { system } = await gem.buildChatPromptParts([{ role: 'user', content: '哈哈哈哈你也太笨了吧' }], { userId: UID }, true);
  assert.ok(system.includes('【你和 TA 的关系：恋人】'), '关系块没进 system');
  assert.ok(system.includes('【这一轮的气氛：轻松、在闹】'), '玩梗场景块没进 system');
  // 位置：必须在【输出语言】之前（语言规则恒为最后一条）
  assert.ok(system.indexOf('【你和 TA 的关系') < system.lastIndexOf('【输出语言'));
});

test('接线：自定义角色读角色字段（每角色一档），剧情角色一律不注入', async () => {
  const own = cc.chatCharacterStore.create('u-relation-char', { name: '阿岚', identity: 'i', boundaries: 'b', voice: 'v', relation: 'buddy' });
  const s1 = (await gem.buildChatPromptParts([{ role: 'user', content: '在干嘛' }], { userId: 'u-relation-char', character: own }, true)).system;
  assert.ok(s1.includes('【你和 TA 的关系：损友】'), '自定义角色的角色级关系档没生效');

  // 剧情角色：剧本人设自带关系与称呼，叠一层会把它冲成"小愈味"（Q4=A 口径）
  const story = cc.chatCharacterStore.create('u-relation-story', {
    name: '沈重', identity: 'i', boundaries: 'b', voice: 'v', origin: 'story',
    story: { scenarioId: 'sc1', scenarioTitle: 't', kind: 'official', aiName: '沈重', userName: '你', importedAt: 1, syncedMsgCount: 0 },
  });
  const s2 = (await gem.buildChatPromptParts([{ role: 'user', content: '在干嘛' }], { userId: 'u-relation-story', character: story }, true)).system;
  assert.ok(!s2.includes('【你和 TA 的关系'), '剧情角色不该注入关系档');
});

test('接线：连发规则已取代原来的"禁止拆条"（本次改动的第一条机制）', async () => {
  const { system } = await gem.buildChatPromptParts([{ role: 'user', content: '哈哈哈哈你也太笨了吧' }], { userId: UID }, true);
  assert.ok(system.includes('【连发·按气氛】'), 'system 里没有连发规则');
  assert.ok(!system.includes('不要主动把一个完整回复拆成连续多条消息'), '旧的禁止拆条规则还在');
});

test('不变量（与 chatVoice 咬合）：关系块不许把「我在呢 / 慢慢说」请回提示词', () => {
  for (const k of KINDS) {
    for (const sc of ['playful', 'tender', 'neutral'] as const) {
      const t = block(k, sc);
      assert.ok(!t.includes('我在呢'), k + '/' + sc + ' 又出现了被锚定的样板句');
      assert.ok(!t.includes('慢慢说'), k + '/' + sc + ' 又出现了被锚定的样板句');
    }
  }
});
