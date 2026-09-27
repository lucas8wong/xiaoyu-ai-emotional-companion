/**
 * 方案 B 守卫：句级「禁止复现」清单的抽取、注入位置与开关（2026-09-17）
 *
 * 为什么需要这组断言：跨轮复读是**句级**现象（A 的通用规则与 D 的 token penalty 都压不住，已有两轮复刻数据）。
 * 唯一有效的做法是把已经写过的那几句明确标成禁止项、并放在 system 最后。
 * 这里钉死四件事：抽得出来、不超长、永远在最末、开关能关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const rp: any = await import('../../api/services/roleplay.js');

const A1 = '（我微微侧身，目光落在你泛红的耳尖上。）「来，替朕按按这胸口。力道要匀，莫要拘谨。」';
const A2 = '（我并未回头催促，只静静感受着身后传来的细微动静。）「来，替朕按按这胸口。力道要匀，你且放轻松些。」';
const A3 = '（我并未回头催促，只静静感受着身后传来的细微动静。）「朕觉得，这般服侍甚是好。」';
/** 英文样本（en 的阈值不同：片段 ≥25 字符、单条 ≤80 字符） */
const E1 = '(I turn my head and watch your reddened ear.) "Come, press my chest. Even pressure, do not hold back."';
const E2 = '(I do not turn to hurry you, only listening to the small sounds behind me.) "Come, press my chest. Even pressure, and relax a little."';

test('抽取①落点：最近两条 AI 回复的收尾句都要在清单里', () => {
  const got = rp.collectAvoidPhrases([{ role: 'assistant', content: A1 }, { role: 'assistant', content: A3 }], 'zh');
  assert.ok(got.some((p: string) => p.includes('朕觉得，这般服侍甚是好')), '末条回落点未抽到：' + JSON.stringify(got));
  assert.ok(got.some((p: string) => p.includes('力道要匀')), '上一条落点未抽到：' + JSON.stringify(got));
});

test('抽取②模板：相邻两条之间的长公共片段要被抓到（这正是「句式模板复用」）', () => {
  const t1 = '（我并未回头催促，只静静感受着身后传来的细微动静与那缕熟悉的馨香。）「来，替朕按按这胸口。」';
  const t2 = '（我并未回头催促，只静静感受着身后传来的细微动静与那缕熟悉的馨香。）「力道要匀，你且放轻松些。」';
  const got = rp.collectAvoidPhrases([{ role: 'assistant', content: t1 }, { role: 'assistant', content: t2 }], 'zh');
  assert.ok(got.some((p: string) => p.includes('我并未回头催促')), '模板片段未抓到：' + JSON.stringify(got));
});

test('抽取：没有 AI 历史 → 空清单（不注入空噪声）', () => {
  assert.deepStrictEqual(rp.collectAvoidPhrases([{ role: 'user', content: '你好' }], 'zh'), []);
  assert.deepStrictEqual(rp.collectAvoidPhrases([], 'zh'), []);
});

test('抽取：条数与单条长度都在剧情上限内，且不出现互相包含的重复项', () => {
  // ⚠️ 2026-09-20：剧情侧上限由 3 条/44 字放宽到 12 条/70 字（依据见下方
  //    「复现句优先」那组测试与 `api/services/roleplay.ts` 的 RP_AVOID_* 注释：
  //    旧上限让单轮 17 句逐字重复的真实会话只被点名 1 句）。这里断言的是**不变式**，
  //    具体数值随容量参数走，不再把旧数值写死。
  // 20 条历史里每条的收尾句都不同（真实形态：落点句句不同，重复的是正文模板）
  const REP20 = '（他顿了顿。）他并未因你的推拒而放缓，反而把掌心稳稳贴住你微凉的后颈。';
  const RP_MAX = rp.collectAvoidPhrases(
    Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', content: REP20 + '「第' + (i + 1) + '句不同的收尾，慢慢说给我听。」' })), 'zh',
  ).length;
  assert.ok(RP_MAX >= 3, '条数上限不该低于旧值 3：' + RP_MAX);
  const long = '（我并未回头催促，只静静感受着身后传来的细微动静与那缕熟悉的馨香，手指在你腰侧停了一停）「莫要拘束。」';
  const got = rp.collectAvoidPhrases([
    { role: 'assistant', content: long }, { role: 'assistant', content: long }, { role: 'assistant', content: long },
  ], 'zh');
  assert.ok(got.length <= RP_MAX, '条数超限：' + got.length + ' > ' + RP_MAX);
  for (const p of got) assert.ok(p.length <= 70, '单条过长：' + p.length);
  for (const a of got) for (const b of got) if (a !== b) assert.ok(!a.includes(b), '存在互相包含的条目');
});

test('禁止复现块：三语齐全、声明是「你自己写过的」、无证据时不注入', () => {
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: A1 }, { role: 'assistant', content: A2 }]);
  assert.ok(zh.includes('【本轮禁止复现｜你最近亲手写过的东西】'), 'zh 缺标题');
  assert.ok(zh.includes('不要再用这些句子'), 'zh 缺硬要求');
  const tw = rp.buildAntiRepeatBlock('zh-TW', [{ role: 'assistant', content: A1 }, { role: 'assistant', content: A2 }]);
  assert.ok(tw.includes('【本輪禁止復現｜你最近親手寫過的東西】'), 'zh-TW 未转繁体：' + tw.slice(0, 30));
  const en = rp.buildAntiRepeatBlock('en', [{ role: 'assistant', content: E1 }, { role: 'assistant', content: E2 }]);
  assert.ok(en.includes('【DO NOT REPEAT') && en.includes('different words'), 'en 块不完整：' + en.slice(0, 60));
  assert.strictEqual(rp.buildAntiRepeatBlock('zh', []), '', '无历史时应为空串');
});

test('禁止复现块：RP_ANTI_REPEAT=0 可关闭（消融 / 线上止血）', () => {
  const history = [{ role: 'assistant', content: A1 }, { role: 'assistant', content: A2 }];
  const before = process.env.RP_ANTI_REPEAT;
  try {
    process.env.RP_ANTI_REPEAT = '0';
    assert.strictEqual(rp.buildAntiRepeatBlock('zh', history), '', '开关没生效');
  } finally {
    if (before === undefined) delete process.env.RP_ANTI_REPEAT; else process.env.RP_ANTI_REPEAT = before;
  }
});

test('注入位置：禁止复现块永远在 system 最末（连用户偏好块之后）', () => {
  const avoid = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: A1 }, { role: 'assistant', content: A2 }]);
  const composed = rp.composeRoleplaySystem({
    sys: '【人设】', lang: 'zh', style: 'immersive', adult: true, taskInstr: '【任务指令】',
    userPreference: '想要温柔一点', avoidBlock: avoid,
  });
  assert.ok(composed.endsWith(avoid), '禁止复现块不在最末');
  assert.ok(composed.indexOf('【剧情偏好') < composed.indexOf('【本轮禁止复现'), '偏好块应在它之前');
  assert.strictEqual(composed.indexOf(avoid), composed.lastIndexOf(avoid), '块被重复注入');
  // 不传时不能凭空多出这一段
  const none = rp.composeRoleplaySystem({ sys: 'x', lang: 'zh', style: 'immersive', adult: false, taskInstr: 'y' });
  assert.ok(!none.includes('禁止复现'));
});

test('落点规则已上移到纪律块最末一条（成人块那一份被无视过）', () => {
  const im = rp.buildTurnDisciplineBlock('zh', 'immersive');
  const cl = rp.buildTurnDisciplineBlock('zh', 'classic');
  assert.ok(im.includes('6. **亲密进行中（最高优先）**'), '沉浸档缺第 6 条');
  assert.ok(im.includes('正在进行的肉体动作或身体反应') && im.includes('梳理发丝'), '第 6 条内容不完整');
  assert.ok(cl.includes('6. **亲密进行中（最高优先）**'), '经典档也应有第 6 条（钩子落在肉体动作上）');
  const en = rp.buildTurnDisciplineBlock('en', 'immersive');
  assert.ok(en.includes('While intimacy is under way (top priority)'), 'en 缺第 6 条');
});

/* —— 2026-09-18：「收尾形态」刹车（钩子 ≠ 问句）——
 * 背景：用户翻剧情记录时发现「好多条 AI 的消息在最后都会问『想跟我多说点？』之类的，太多余了」。
 * 句级负例（上面那套）只能禁「你写过的那一句」，治不了「换成另一种说法接着问」；
 * 这一路按**上一轮真实使用的收尾形态**按需生成禁令 —— 判据来自 src/lib/rpEnding.ts（结构判定），
 * 不是写死某几个句子，所以不算 overfit。 */

test('形态刹车：上一轮是问句收尾 → 本轮显式禁掉问句收尾（三语）', () => {
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: '（他抬眼看你。）「你这是什么意思？」' }]);
  assert.ok(zh.includes('【本轮禁止的收尾形态】'), 'zh 缺形态刹车');
  assert.ok(zh.includes('这一轮禁止再用问句收尾'), 'zh 刹车文案不完整');
  const tw = rp.buildAntiRepeatBlock('zh-TW', [{ role: 'assistant', content: '（他抬眼看你。）「你这是什么意思？」' }]);
  assert.ok(tw.includes('本輪禁止的收尾形態'), 'zh-TW 未转繁体：' + tw.slice(0, 40));
  const en = rp.buildAntiRepeatBlock('en', [{ role: 'assistant', content: '(He looks up.) "What do you mean?"' }]);
  assert.ok(en.includes('ENDING FORM BANNED THIS TURN'), 'en 缺形态刹车');
});

test('形态刹车：上一轮是「征询继续」→ 问句与「邀请对方多说」一起禁', () => {
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: '（他停下来。）「想跟我多说点吗？」' }]);
  assert.ok(zh.includes('征询玩家要不要继续聊'), 'zh 未识别出「征询继续」这一档：' + zh.slice(-160));
  assert.ok(zh.includes('「邀请对方多说」的说法'), 'zh 缺「邀请多说」禁令');
});

test('形态刹车：上一轮是动作/陈述收尾 → 不该多出这一段（按需生成，不是每轮都注入）', () => {
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: '（他把外套搭在椅背上，抬手示意你坐过来。）「先坐下吧，别站着。」' }]);
  assert.ok(zh.includes('【本轮禁止复现'), '正常情况仍应有句子级负例');
  assert.ok(!zh.includes('【本轮禁止的收尾形态】'), '陈述收尾不该触发形态刹车');
});

test('形态刹车：没有可抽取的句子负例时也要注入（不能因为 phrases 为空就整块丢掉）', () => {
  // 「你意下如何？」只有 5 字，抽不出落点（中文门槛 6 字），但它是问句收尾 → 刹车必须仍然生效
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: '「你意下如何？」' }]);
  assert.ok(zh.includes('【本轮禁止的收尾形态】'), 'phrases 为空时刹车被一起丢掉了：' + JSON.stringify(zh));
});

/* —— 2026-09-17 回退后的口径：**负例一律逐字原文**（不剥称呼、不改写） ——
 * 背景：我曾把清单里的称呼剥掉（「daddy 会一直这样抱着你…」→「会一直这样抱着你…」、「daddy 陪着你」直接丢），
 * 用户对比后判定**旧的做法更好**：剥完的句子不再是模型自己写过的那一句，模型认不出来，负例的约束力更弱。
 * 下面这几条断言就是防止「剥称呼」被再次加回来。 */

const D1 = '（他抬手抚过你的发顶。）「daddy 陪着你。」';
const D2 = '（他将你抱紧。）「daddy 陪着你。」';
const F1 = '（他抬手抚过你的发顶。）「daddy 会一直这样抱着你，直到你完全舒展。」';
const F2 = '（他将你抱紧。）「daddy 会一直这样抱着你，直到你完全舒展。」';

test('负例用逐字原文：称呼必须原样保留在清单里（不许剥掉/改写）', () => {
  const got = rp.collectAvoidPhrases([{ role: 'assistant', content: F1 }, { role: 'assistant', content: F2 }], 'zh');
  assert.ok(got.some((p: string) => p.includes('daddy 会一直这样抱着你，直到你完全舒展')), '清单里应保留带称呼的原句：' + JSON.stringify(got));
  assert.ok(got.every((p: string) => !/^会一直这样抱着你/.test(p)), '不该出现被剥掉称呼的版本：' + JSON.stringify(got));
});

test('纯称呼+口癖的句子也照收（不再整条丢弃）', () => {
  const got = rp.collectAvoidPhrases([{ role: 'assistant', content: D1 }, { role: 'assistant', content: D2 }], 'zh');
  assert.ok(got.some((p: string) => p.includes('daddy 陪着你')), '重复出现的称呼句也应进清单：' + JSON.stringify(got));
  const block = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: D1 }, { role: 'assistant', content: D2 }]);
  assert.ok(block.includes('「daddy 陪着你'), '块里应是原文（带称呼）：' + block.slice(0, 120));
});

test('剧本角色名同样按原文保留', () => {
  const got = rp.collectAvoidPhrases(
    [{ role: 'assistant', content: '（他低笑。）「景橪一直陪着你，哪儿也不去。」' },
      { role: 'assistant', content: '（他俯身。）「景橪一直陪着你，哪儿也不去。」' }], 'zh');
  assert.ok(got.some((p: string) => p.includes('景橪一直陪着你')), '角色名应在原文里保留：' + JSON.stringify(got));
});

test('模板门槛：普通短承接句不会被误判成模板（中文 12 字起）', () => {
  const s1 = '（我并未立刻退开。）他把掌心贴在你背上。';
  const s2 = '（我并未立刻退开。）他将掌心覆在你的腰侧。';
  const got = rp.collectAvoidPhrases([{ role: 'assistant', content: s1 }, { role: 'assistant', content: s2 }], 'zh');
  assert.ok(got.every((p: string) => !p.includes('我并未立刻退开')), '9 字级的普通承接句不该被当成模板：' + JSON.stringify(got));
  // 只有 2 条历史（＝2 条落点 + 至多 1 条平级重复句），与容量上限无关
  assert.ok(got.length <= 3, '两条历史时不该超出 3 条：' + JSON.stringify(got));
});

test('块的文案说明「禁的是句子与句式，不是称呼方式」', () => {
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: F1 }, { role: 'assistant', content: F2 }]);
  assert.ok(zh.includes('不是你怎么称呼对方'), 'zh 缺口径说明');
  assert.ok(zh.includes('照常叫'), 'zh 没点明称呼照常');
  const en = rp.buildAntiRepeatBlock('en', [{ role: 'assistant', content: F1 }, { role: 'assistant', content: F2 }]);
  assert.ok(en.includes('not how you address the player') && en.includes('keep using'), 'en 缺口径说明');
});

/* ───────── 收尾形态刹车：逐字引用上一轮收尾句 + 连续两轮升级（2026-09-20） ───────── */

/**
 * 为什么加这两条：`scripts/rp-ending-scan.mts` 在**真实线上数据**（2026-09-20 跑）里量到
 * 「连续两轮以上以问句收尾」出现在 **22/114 段会话**（最长 4 轮）——单轮刹车会被无视一两次。
 * 处置不是再写一遍同样的规则（同一句指令重复第三遍没用），而是：
 *   ① 把**上一轮那句收尾原文**摆出来（本仓库两轮取证：有约束力的是点名具体字符串）；
 *   ② 连续两轮时再升一级。
 */
const Q_LAST = '（我并未回头催促。）「你到底想怎么样？」';
const S_MID = '（我静静听着身后传来的动静。）他把掌心贴在你背上。';

test('收尾刹车：逐字引用上一轮最后一句（不是只说"你用了问句"）', () => {
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: Q_LAST }]);
  assert.ok(zh.includes('本轮禁止的收尾形态'), '刹车没触发：' + zh);
  assert.ok(zh.includes('你到底想怎么样'), '没有把上一轮收尾原文摆出来（这是本仓库唯一被证明有效的机制）');
});

test('收尾刹车：连续两轮都是问句 → 升级提醒（真实线上 22/114 段就是这个形态）', () => {
  const two = rp.buildAntiRepeatBlock('zh', [
    { role: 'assistant', content: Q_LAST },
    { role: 'assistant', content: '（他皱了皱眉。）「你今晚到底去哪了？」' },
  ]);
  assert.ok(two.includes('连着两轮'), '连续两轮没有升级：' + two);
  // 只有一条问句收尾时**不该**出现升级语（避免每轮都说"连着两轮"，那等于没有权重）
  const one = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: Q_LAST }]);
  assert.ok(!one.includes('连着两轮'), '单轮就升级了 → 升级语会贬值');
  // 上一条是陈述句：连刹车都不该触发
  const none = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: S_MID }]);
  assert.ok(!none.includes('本轮禁止的收尾形态'), '陈述句收尾不该触发刹车：' + none);
});

test('收尾刹车：消融开关 RP_ENDING_FORM=0 时引用与升级一起消失', () => {
  const before = process.env.RP_ENDING_FORM;
  try {
    process.env.RP_ENDING_FORM = '0';
    const off = rp.buildAntiRepeatBlock('zh', [
      { role: 'assistant', content: Q_LAST },
      { role: 'assistant', content: '（他皱了皱眉。）「你今晚到底去哪了？」' },
    ]);
    assert.ok(!off.includes('本轮禁止的收尾形态'), '开关没关掉刹车');
    assert.ok(!off.includes('连着两轮'), '开关没关掉升级语');
  } finally {
    if (before === undefined) delete process.env.RP_ENDING_FORM; else process.env.RP_ENDING_FORM = before;
  }
});

test('注入位置：收尾刹车（连引用一起）只能在**用户偏好块之后**——它和负例清单同属"本轮机械约束"', () => {
  const history = [
    { role: 'assistant', content: Q_LAST },
    { role: 'assistant', content: '（他皱了皱眉。）「你今晚到底去哪了？」' },
  ];
  const sys = rp.composeRoleplaySystem({
    sys: '【角色设定】测试用', lang: 'zh', style: 'immersive', taskInstr: '【任务指令】测试用',
    adult: false, userPreference: '【用户偏好】测试用偏好文本',
    avoidBlock: rp.buildAntiRepeatBlock('zh', history),
  });
  const pref = sys.indexOf('【用户偏好】测试用偏好文本');
  const brake = sys.indexOf('本轮禁止的收尾形态');
  const quote = sys.indexOf('你今晚到底去哪了');
  assert.ok(pref > 0 && brake > 0 && quote > 0, '三块没同时在场');
  assert.ok(brake > pref, '刹车跑到用户偏好之前了（偏好是声明的最高优先级，机械约束应在其后）');
  /**
   * ⚠️ 不能用「quote 的下标 > brake 的下标」来判：那句收尾话**同时**是负例清单里的"落点"（排在块首），
   * 所以第一次出现必然在刹车语之前。正确的判据是"**刹车那句本身**里带着引用"。
   */
  assert.ok(/本轮禁止的收尾形态[\s\S]{0,200}你今晚到底去哪了/.test(sys.slice(brake)), '刹车语里没有引用上一轮收尾句');
  assert.ok(quote > 0, '那句收尾话也该在负例清单里（落点抽取）');
});

/* ───────── 整段重写：跨轮最长公共子串 ≥ 60 字单独点名（2026-09-20） ───────── */

/**
 * 为什么加：真实取证 `temp/eval-roleplay-voice.mts` 里有一组出现**连续 532 字逐字重复**
 * （同一段剧情被重写一遍）。负例清单结构上挡不住它（单条上限 44 字、条数上限 3），
 * 所以单独加一路「跨轮最长公共子串 ≥ 60 字」的条款，并把这段重复的开头引出来。
 */
const PASSAGE = '他抬手替她把氅衣的领口拢紧了些，指腹在颈侧停了一瞬才收回，随即侧身让开半步，把通往内室的路让了出来，目光落在她鞋尖前那一小片青砖上，不急不催，只等她自己迈出这一步。';
const LONG_A = '（帐中烛火矮了半寸。）' + PASSAGE + '「夜深了，先去歇着吧。」';
const LONG_B = '（风把帐帘掀起一角。）' + PASSAGE + '「你若不想说，我也不问。」';

test('整段重写：跨轮 ≥60 字逐字重复 → 单独点名（含字数与开头引用）', () => {
  const zh = rp.buildAntiRepeatBlock('zh', [{ role: 'assistant', content: LONG_A }, { role: 'assistant', content: LONG_B }]);
  assert.ok(zh.includes('本轮禁止重写'), '没有点名整段重写：' + zh.slice(0, 200));
  assert.ok(/\d+ 个字/.test(zh), '没有报出重复字数（模型需要知道这不是"句式像"而是整段）');
  assert.ok(zh.includes('他抬手替她把氅衣的领口拢紧了些'), '没有引出那段重复的原文开头');
});

test('整段重写：只共享一小句（<60 字）时不点名，避免条款贬值', () => {
  const short = rp.buildAntiRepeatBlock('zh', [
    { role: 'assistant', content: '（他把茶盏推过来。）「先喝口热的。」' },
    { role: 'assistant', content: '（他把茶盏推过来。）「凉了就不好喝了。」' },
  ]);
  assert.ok(!short.includes('本轮禁止重写'), '短共享片段被误判成整段重写：' + short.slice(0, 160));
});

/* ───────── 2026-09-20 审阅取证：清单容量与「复现句优先」─────────
 * 为什么加这组断言：`data/xiaoyu.sqlite` 近 7 天真实数据（1264 个 AI 轮次）量到 ——
 *   · 旧参数（3 条 / 44 字 / 窗口 3）在**逐字重复已经发生**的 66 个轮次里只点名 39%，重复句命中率 13.2%；
 *   · 单轮最多 17 句逐字重复（用户 cf8077d3「民国背德」，其偏好原文即「内容好乱，重复太多」），
 *     清单却只点名 1 句 —— 因为清单被「2 条落点 + 1 条最长片段」占满，重复句一条也进不去；
 *   · 6034e5e2 会话 73 轮里「并未因…反而」出现 29 次、「眼底那抹」43 次，而该用户的偏好原文
 *     正是「不要跟之前的重复内容/对话。多样一点。」——**偏好没被遵守，且工具本身看不到证据**。
 * 修法：① 复现句按「复现次数 × 长度」排序；② 容量放宽（12 条 / 70 字 / 窗口 12）。
 * 实测效果（`temp/rp-pref-audit/sim4.mts`，同一份真实数据）：覆盖 39%→59%、命中率 13.2%→35.0%。
 * 这组断言钉的就是「排序」与「容量」两件事，防止被改回插入顺序。
 */

test('复现句优先：多句逐字重复时，重复句要挤进清单（不再被落点占满名额）', () => {
  // 构造贴近真实会话的形态：落点是很短的对话句，正文里有一段被反复回填的模板
  const REP = '他并未因你的推拒而放缓，反而双臂猛地收紧将你整个人更深地压向自己。';
  const hist = [
    { role: 'assistant', content: '（他垂眸。）' + REP + '「先坐下吧，别站着。」' },
    { role: 'assistant', content: '（他抬手。）' + REP + '「先喝口热的，别急。」' },
    { role: 'assistant', content: '（他侧首。）' + REP + '「先歇一会儿，我等你。」' },
    { role: 'assistant', content: '（他停手。）' + REP + '「先别说话，听我说完。」' },
  ];
  const got = rp.collectAvoidPhrases(hist, 'zh');
  assert.ok(got.some((p: string) => p.includes('并未因你的推拒而放缓')),
    '反复出现的整句没有被点名（清单被落点占满＝旧 bug 复现）：' + JSON.stringify(got));
});

test('窗口放大：复发距离超过 3 条的模板仍能被看到（窗口 3 时看不到）', () => {
  const TPL = '他并未因你的推拒而放缓，反而双臂猛地收紧将你整个人更深地压向自己，指腹深深陷入腰侧。';
  const mk = (tag: string, tail: string) => ({ role: 'assistant', content: '（他' + tag + '。）' + TPL + '「' + tail + '」' });
  // 第 1 条与第 5 条共用同一模板，中间隔了 3 条（旧窗口 3 恰好看不到）
  const hist = [mk('垂眸', '别急，先坐下。'), mk('抬手', '等我一下就好。'), mk('侧首', '乖，别动。'), mk('停手', '先喝口热的。'), mk('俯身', '听我说完再走。')];
  const got = rp.collectAvoidPhrases(hist, 'zh');
  assert.ok(got.some((p: string) => p.includes('并未因你的推拒而放缓')), '跨 4 条的复发模板没被抽到：' + JSON.stringify(got));
});

test('落点仍被优先保留（结构证据不能被长重复句吃掉）', () => {
  const REP = '他并未因你的推拒而放缓，反而双臂猛地收紧将你整个人更深地压向自己，指腹深深陷入腰侧。';
  const hist = [
    { role: 'assistant', content: '（他垂眸。）' + REP + '「别急，先坐下。」' },
    { role: 'assistant', content: '（他抬手。）' + REP + '「等我一下就好。」' },
    { role: 'assistant', content: '（他俯身。）' + REP + '「乖，别动，听我说完。」' },
  ];
  const got = rp.collectAvoidPhrases(hist, 'zh');
  assert.ok(got.some((p: string) => p.includes('等我一下就好')), '上一条落点丢了：' + JSON.stringify(got));
  assert.ok(got.some((p: string) => p.includes('乖，别动，听我说完')), '最新一条落点丢了：' + JSON.stringify(got));
});
