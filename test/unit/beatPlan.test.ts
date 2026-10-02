/**
 * 「一拍计划」（B 方案）回归网，2026-09-24
 *
 * 这一层的失效方式只有两种，都很致命，所以两边都要钉死：
 *   ① **泄漏**：计划行被当成角色台词下发/落盘/回灌（2026-09-15 事故的同类风险，系统文本进了业务消息集合）；
 *   ② **吞正文**：为了剥计划把玩家真正该看到的正文也丢了。
 * 两条安全阀（"没有正文就不剥" / "流式拿不准就放行"）就是为第 ②
 * 类准备的，本文件重点是**证明它们真的生效**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBeatPlan, createBeatPlanFilter, MIN_BODY_CHARS } from '../../src/lib/beatPlan.js';

const BODY = '（他起身把窗合上，回头看了你一眼。）「先睡吧，明早再说。」';
const PLAN = '他起身把窗合上，决定今晚不再提林同学的事。';

/* ------------------------- 整段剥离 ------------------------- */

test('剥离：中文计划行 + 空行 + 正文 → 计划被取走，正文完整', () => {
  const r = splitBeatPlan('【本拍】' + PLAN + '\n\n' + BODY);
  assert.equal(r.stripped, true);
  assert.equal(r.plan, PLAN);
  assert.equal(r.body, BODY, '正文必须逐字保留（含首尾的括号与引号）');
});

test('剥离：允许标记前有空行、标记后带冒号/破折号', () => {
  const a = splitBeatPlan('\n\n【本拍】' + PLAN + '\n\n' + BODY);
  assert.equal(a.stripped, true);
  assert.equal(a.body, BODY);
  const b = splitBeatPlan('【本拍】：' + PLAN + '\n' + BODY);
  assert.equal(b.stripped, true);
  assert.equal(b.plan, PLAN, '标记后的冒号应被吃掉');
});

test('剥离：英文标记（大小写不敏感）', () => {
  for (const mk of ['[BEAT]', '[beat]', '[Beat]']) {
    const r = splitBeatPlan(mk + ' He closes the window and says nothing more.\n\n' + BODY);
    assert.equal(r.stripped, true, mk + ' 未识别');
    assert.equal(r.body, BODY);
  }
});

test('剥离：没有标记 → 原样返回（模型不遵守时的行为与改造前完全一致）', () => {
  const r = splitBeatPlan(BODY);
  assert.equal(r.stripped, false);
  assert.equal(r.body, BODY);
  assert.equal(r.plan, '');
});

test('⭐ 安全阀：只有计划行、剥完没正文 → **不剥**（绝不把回复吞掉）', () => {
  const r = splitBeatPlan('【本拍】' + PLAN);
  assert.equal(r.stripped, false, '剥完为空时必须放弃剥离');
  assert.equal(r.body, '【本拍】' + PLAN);
  // 正文太短（< 阈值）同样不剥
  const tiny = splitBeatPlan('【本拍】' + PLAN + '\n\n' + '好。'.repeat(Math.floor((MIN_BODY_CHARS - 1) / 2)));
  assert.equal(tiny.stripped, false);
});

test('剥离：标记不在第一行（出现在正文中间）→ 不剥（不是计划行，是正文内容）', () => {
  const text = BODY + '\n【本拍】' + PLAN + '\n' + BODY;
  const r = splitBeatPlan(text);
  assert.equal(r.stripped, false);
  assert.equal(r.body, text);
});

/* ------------------------- 流式过滤 ------------------------- */

function collect(chunks: string[]): { out: string; sawPlan: boolean } {
  let out = '';
  const f = createBeatPlanFilter((d) => { out += d; });
  for (const c of chunks) f.push(c);
  f.flush();
  return { out, sawPlan: f.sawPlan() };
}

test('流式：整段一次推入 → 只出正文，计划行不出现', () => {
  const r = collect(['【本拍】' + PLAN + '\n\n' + BODY]);
  assert.equal(r.out, BODY);
  assert.equal(r.sawPlan, true);
});

test('⭐ 流式：逐字符推入（标记被切碎）→ 仍然只出正文', () => {
  const full = '【本拍】' + PLAN + '\n\n' + BODY;
  const r = collect(full.split(''));
  assert.equal(r.out, BODY, '逐 token 场景下不能泄漏计划行');
  assert.ok(!r.out.includes('本拍'));
});

test('流式：标记恰好在两个 chunk 的边界上 → 仍然正确', () => {
  const full = '【本拍】' + PLAN + '\n\n' + BODY;
  const cut = 2; // 「【本」|「拍】…」
  const r = collect([full.slice(0, cut), full.slice(cut, cut + 3), full.slice(cut + 3)]);
  assert.equal(r.out, BODY);
});

test('流式：没有计划行 → 原样逐字输出（普通轮零影响）', () => {
  const chunks = [BODY.slice(0, 5), BODY.slice(5, 12), BODY.slice(12)];
  const r = collect(chunks);
  assert.equal(r.out, BODY);
  assert.equal(r.sawPlan, false);
});

test('⭐ 流式安全阀：只有计划行、没有正文 → flush 时**原样吐出**（宁可泄漏，也不吞）', () => {
  const full = '【本拍】' + PLAN;
  const r = collect([full]);
  assert.equal(r.out, full);
});

test('流式安全阀：标记之后长时间没有换行（模型跑偏）→ 放行原样输出', () => {
  const long = '【本拍】' + '啊'.repeat(700);
  const r = collect([long]);
  assert.equal(r.out, long, '超过容忍长度必须放行，不能一直吞着');
});

test('流式：以半角方括号开头的正常正文不会被吞（拿不准一律放行）', () => {
  const text = '[Scene: the bedroom, door closed.] ' + BODY;
  const r = collect([text.slice(0, 10), text.slice(10)]);
  assert.equal(r.out, text);
});
