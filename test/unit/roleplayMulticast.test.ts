/**
 * 多角色（群像）剧情的守卫测试（2026-10-01）
 *
 * 这组断言钉死三件最容易在后续编辑里悄悄失效的事：
 *   1. cast 侧表只在**指定剧本**上生效（其余剧本必须一字不变）；
 *   2. 多角色格式块必须排在「任务指令」之后（任务指令写着"不要输出任何标记"，
 *      位置错了模型就不敢写 【角色名】，功能静默失效）；
 *   3. 试水剧本的开场白真的带了标记（否则 O1 打字机只会吐一段旁白）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const rp: any = await import('../../api/services/roleplay.js');

const TRIAL = 'peixiuyuan-linwantang';

test('scenarioCast：名单只长在登记过的剧本上，表外剧本为空（行为不变）', () => {
  const zh = rp.scenarioCast(TRIAL, 'zh');
  assert.ok(Array.isArray(zh) && zh.length >= 2, '试水剧本应有 >= 2 位可开口角色');
  // 2026-10-01：加入「姐姐（逃婚的林家长女）」—— 逃婚本身就是前提，双模式后她必须在 cast 里
  assert.deepStrictEqual(zh.map((m: any) => m.name), ['裴修远', '林晚菱', '李嬷嬷', '翠屏']);
  assert.strictEqual(zh.filter((m: any) => m.lead).length, 1, '有且只有一个主角色');
  assert.strictEqual(zh.find((m: any) => m.lead).id, 'peixiuyuan');

  // 详情页「角色介绍」要用的身份 + 一句话介绍（2026-10-01）：每位都要有，三语齐全。
  // 按 id 取（而不是下标）—— cast 是会变的，下标断言一改人就错位。
  const byId = (list: any[]) => Object.fromEntries(list.map((m: any) => [m.id, m]));
  const zhById = byId(zh);
  assert.ok(zh.every((m: any) => m.role && m.desc), '每位角色都要有身份与介绍');
  assert.strictEqual(zhById['peixiuyuan'].role, '国公府世子');
  assert.ok(String(zhById['linwanling'].role).includes('长女'), '姐姐的身份要写明是逃婚的林家长女');
  assert.ok(String(zhById['limomo'].desc).includes('嬷嬷'), '介绍写的是这位角色本人的事');
  assert.strictEqual(zhById['cuiping'].role, '林家陪嫁丫鬟');

  const en = rp.scenarioCast(TRIAL, 'en');
  assert.deepStrictEqual(en.map((m: any) => m.name), ['Pei Xiuyuan', 'Lin Wanling', 'Matron Li', 'Cuiping']);
  assert.ok(en.every((m: any) => m.role && m.desc), '英文也要有身份与介绍');

  const tw = rp.scenarioCast(TRIAL, 'zh-TW');
  assert.strictEqual(tw.length, zh.length, '繁中分支不应丢人');
  assert.ok(tw.every((m: any) => m.name.length > 0));
  assert.ok(tw.every((m: any) => m.role && m.desc), '繁中也要有身份与介绍');

  /**
   * 阶段 3 是**分批**落地的（首批 10 部 → 后续每批 10 部），所以这里**不硬编码名单**：
   * 遍历全部官方剧本，凡是登记了 cast 的就逐个校验不变量。这样每加一批都不用改测试，
   * 而"漏配头像/漏写介绍"这类错仍然当场红。
   */
  const withCast = rp.SCENARIOS.map((s: any) => s.id).filter((id: string) => rp.scenarioCast(id, 'zh').length > 0);
  assert.ok(withCast.length >= 20, '阶段 3 至少应有 20 部登记了 cast，实际 ' + withCast.length);
  for (const id of withCast) {
    const list = rp.scenarioCast(id, 'zh');
    assert.ok(list.length >= 3, id + ' 应有主角色 + 至少 2 位配角：' + list.length);
    assert.strictEqual(list.filter((m: any) => m.lead).length, 1, id + ' 有且只有一个主角色');
    // 每位都要有身份与介绍（详情页「同场角色」直接渲染这两项）
    assert.ok(list.every((m: any) => m.role && m.desc), id + ' 每位角色都要有身份与介绍');
    // 配角头像（lead 走剧本头像，由 flatScenario 补）—— 每位新角色都必须配图，不能留首字色块
    const subs = list.filter((m: any) => !m.lead);
    assert.ok(subs.every((m: any) => typeof m.avatar === 'string' && m.avatar.includes('/img/roleplay/')), id + ' 每位配角都要登记头像');
  }
  // 表外剧本 = 空数组（前端不做任何多角色渲染，行为与改造前一致）
  assert.deepStrictEqual(rp.scenarioCast('liyuan', 'zh'), []);
  assert.deepStrictEqual(rp.scenarioCast('not-a-real-scenario', 'zh'), []);
  assert.deepStrictEqual(rp.scenarioCast('不存在的剧本', 'zh'), []);
});

test('剧本接口：cast 随 listScenarios / getScenarioInfo 一起下发，且已按语言本地化', () => {
  const info = rp.getScenarioInfo(TRIAL, 'zh');
  assert.ok(info && Array.isArray(info.cast) && info.cast.length >= 2);
  assert.deepStrictEqual(info.cast.map((m: any) => m.name), ['裴修远', '林晚菱', '李嬷嬷', '翠屏']);
  // 主角色的头像 = 剧本头像（含 hash 版本号）：前端任何 cast 展面都据此渲染，不必各自认 lead
  const lead = info.cast.find((m: any) => m.lead);
  assert.ok(lead && typeof lead.avatar === 'string' && lead.avatar.includes('peixiuyuan-linwantang'), '主角色必须带上剧本头像');
  assert.strictEqual(lead.avatar, info.avatar, '主角色头像应与剧本 avatar 完全一致（同一个 URL）');
  // 配角头像（2026-10-01）：登记后要带上内容版本号（`?v=<hash>`），换图即换 URL
  const limomo = info.cast.find((m: any) => m.id === 'limomo');
  const cuiping = info.cast.find((m: any) => m.id === 'cuiping');
  assert.ok(String(limomo.avatar).startsWith('/img/roleplay/peixiuyuan-linwantang-limomo.jpg'), '配角头像路径');
  assert.ok(/\?v=[0-9a-f]{8}$/.test(String(limomo.avatar)), '配角头像必须带内容版本号：' + limomo.avatar);
  assert.ok(/\?v=[0-9a-f]{8}$/.test(String(cuiping.avatar)), '配角头像必须带内容版本号：' + cuiping.avatar);
  assert.notStrictEqual(limomo.avatar, cuiping.avatar, '两位配角不能共用同一张图');

  // 本批新增的剧本也要能从列表接口读到 cast（含配角头像）
  const other = rp.getScenarioInfo('lutingyuan-shenyan', 'zh');
  assert.ok(other.cast.length >= 3, '新增剧本的 cast 必须随接口下发');
  assert.ok(other.cast.filter((m: any) => !m.lead).every((m: any) => /\?v=[0-9a-f]{8}$/.test(String(m.avatar))), '配角头像一律带内容版本号');
  // 表外剧本仍是空数组（不是 undefined，也无可渲染名单）—— 用一个确定没登记的官方剧本。
  // ⚠️ 2026-10-01：第三条批落地后，**只有《沦为玩物的亡国公主》刻意保持 solo-only**（提案判定：
  // 强 1v1 + 题材敏感，做群像反而削弱设定与合规），所以这里的「表外样本」就是它。
  // 将来若给它补 cast（或另补一部同题材群像剧本），必须同时改这一行，别让它变成假绿。
  assert.deepStrictEqual(rp.getScenarioInfo('aluola-ailian', 'zh').cast, []);
  assert.deepStrictEqual(rp.getScenarioInfo('xiaoyan-chisha', 'zh').cast.filter((m: any) => !m.lead).length, 3, '爆款宫廷剧这一批必须已登记 3 位配角');

  const list = rp.listScenarios('zh');
  const row = list.find((s: any) => s.id === TRIAL);
  assert.ok(row && row.cast.length >= 2);
});

test('buildMulticastBlock：三语齐全，点名名单 + 标记形状 + 不代写用户', () => {
  const names = ['裴修远', '李嬷嬷', '翠屏'];
  const zh = rp.buildMulticastBlock('zh', names, '林晚棠');
  assert.ok(zh.includes('裴修远') && zh.includes('李嬷嬷') && zh.includes('翠屏'));
  assert.ok(zh.includes('【裴修远】'), '必须给出标记形状示例，模型才会逐字照抄');
  assert.ok(zh.includes('林晚棠'), '要显式禁止代写用户角色');
  assert.ok(zh.includes('不要加标记'), '要说明旁白不带标记');

  const tw = rp.buildMulticastBlock('zh-TW', names, '林晚棠');
  assert.ok(tw.includes('【多角色同場'), 'zh-TW 未转繁体：' + tw.slice(0, 30));

  const en = rp.buildMulticastBlock('en', ['Pei Xiuyuan', 'Matron Li', 'Cuiping'], 'Lin Wantang');
  assert.ok(en.includes('MULTI-CHARACTER'));
  assert.ok(en.includes('【Pei Xiuyuan】'));
  assert.ok(en.includes('Lin Wantang'));
});

test('composeRoleplaySystem：多角色块在「任务指令」之后、「回合纪律」之前（顺序＝权重）', () => {
  const sys = '【人设】前缀';
  const mc = rp.buildMulticastBlock('zh', ['裴修远', '李嬷嬷'], '林晚棠');
  const composed = rp.composeRoleplaySystem({
    sys, lang: 'zh', style: 'immersive', adult: false, taskInstr: '【任务指令】继续剧情', multicastBlock: mc,
  });
  const discipline = rp.buildTurnDisciplineBlock('zh', 'immersive');
  assert.ok(composed.indexOf('【任务指令】') < composed.indexOf(mc), '多角色块必须晚于任务指令（否则被"不要标记"压住）');
  assert.ok(composed.indexOf(mc) < composed.indexOf(discipline), '多角色块必须早于回合纪律（收尾条款仍占末段）');
  assert.ok(composed.endsWith(discipline), '纪律块仍必须是最后一段');

  // 不传 multicastBlock 时，system 与改造前一致（不含任何多角色痕迹）
  const plain = rp.composeRoleplaySystem({ sys, lang: 'zh', style: 'immersive', adult: false, taskInstr: '【任务指令】继续剧情' });
  assert.ok(!plain.includes('多角色同场'), '单角色剧本不该出现多角色块');
});

test('试水剧本的开场白带标记：旁白 + 两位角色，且名字与 cast 对得上', () => {
  const s = rp.getScenario(TRIAL);
  assert.ok(s, '试水剧本必须存在');
  for (const lang of ['zh', 'en'] as const) {
    // 双模式（2026-10-01）：多角色线有**专属开场**，它才是最该检查标记的那一份
    const multi: string = lang === 'en' ? s.en.multiOpeningAssistant : s.zh.multiOpeningAssistant;
    assert.ok(multi, lang + ' 应有 multiOpeningAssistant（多角色线专属开场）');
    const opening: string = multi;
    const cast = rp.scenarioCast(TRIAL, lang).map((m: any) => m.name);
    const tagged = cast.filter((n: string) => opening.includes('【' + n + '】'));
    assert.ok(tagged.length >= 2, lang + ' 开场白至少要出现两位角色的标记，实际: ' + tagged.join(','));
  }
});
