/**
 * 聊一聊「模型自己传的交接信号」（2026-09-25）
 *
 * 为什么换判据：初版用「用户消息关键词闸 + 回复要件」，真机第一条就碎——用户发「操我吧」，
 * 小愈的回复**完整指了路**（剧情演绎 + 我的偏好 + 无限制模式），但那道**用户侧词表没收「操」**
 * ⇒ 按钮没出。用户拍板：**让模型自己判断、自己传这个 true**（回复末尾输出 [[RP-UNLOCK]]，
 * 服务端剥掉并置位），关键词只降级为兜底。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const sig: any = await import('../../api/services/chatSignal.js');
const cv: any = await import('../../api/services/chatVoice.js');

test('剥标记：出现即置位并剥掉；容忍写法；不吞正文', () => {
  const r1 = sig.extractChatHandoff('要不要过去挑个本子试试。\n[[RP-UNLOCK]]');
  assert.equal(r1.handoff, true);
  assert.equal(r1.text, '要不要过去挑个本子试试。');
  assert.ok(!r1.text.includes('RP-UNLOCK'), '标记必须被剥掉');
  // 容忍写法：全角/下划线/空格/大小写
  for (const s of ['[[RP_UNLOCK]]', '[[rp-unlock]]', '[[ RP - UNLOCK ]]']) {
    assert.equal(sig.extractChatHandoff('正文。' + s).handoff, true, '未识别：' + s);
    assert.ok(!/RP[s_-]*UNLOCK/i.test(sig.extractChatHandoff('正文。' + s).text), '未剥掉：' + s);
  }
  // 没有标记 → 原样返回、不置位
  const r2 = sig.extractChatHandoff('今天天气不错。');
  assert.equal(r2.handoff, false);
  assert.equal(r2.text, '今天天气不错。');
  // 红线②：剥完什么都不剩 → 当成没剥（正文优先）
  const r3 = sig.extractChatHandoff('[[RP-UNLOCK]]');
  assert.equal(r3.text, '[[RP-UNLOCK]]');
  assert.equal(sig.extractChatHandoff('').handoff, false);
});

test('流式过滤器：标记被切成多个 delta 也不漏、不丢正文、收尾要 flush', () => {
  const f = sig.createChatHandoffFilter();
  const parts = ['想玩真的，去剧情演绎，', '右上角「我的偏好」把无限制模式打开。\n[[RP-UN', 'LOCK]]'];
  let out = '';
  for (const p of parts) out += f.feed(p);
  assert.equal(f.handoff, true, '跨 delta 的标记没被识别');
  assert.equal(f.flush(), '', 'flush 不该再吐出标记');
  assert.ok(!out.includes('RP-UNLOCK') && !out.includes('[[RP'), '标记漏给了前端：' + out);
  assert.ok(out.includes('去剧情演绎') && out.includes('无限制模式'), '正文被吞：' + out);
  // 没有标记的普通流：一个字都不能丢
  const g2 = sig.createChatHandoffFilter();
  let out2 = '';
  for (const ch of '晚安') out2 += g2.feed(ch);
  out2 += g2.flush();
  assert.equal(out2, '晚安');
  assert.equal(g2.handoff, false);
  // 尾部扣住的部分必须由 flush 补回（否则末尾几个字永远到不了前端）
  const g3 = sig.createChatHandoffFilter();
  const first = g3.feed('好的就这样');
  const rest = g3.flush();
  assert.equal(first + rest, '好的就这样');
});

test('兜底判据：回复要件齐全才算（真机那条「操我吧」的回复应当命中）', () => {
  assert.equal(sig.replySuggestsAdultHandoff('想玩真的，去剧情演绎，右上角有个「我的偏好」，把无限制模式打开，头回开要先确认年满18。'), true);
  assert.equal(sig.replySuggestsAdultHandoff('Go to the Roleplay area and turn on Unlimited mode.'), true);
  assert.equal(sig.replySuggestsAdultHandoff('难受归难受，我扛得住。你先把腰坐直了。'), false);
  assert.equal(sig.replySuggestsAdultHandoff('今天天气不错'), false);
  assert.equal(sig.replySuggestsAdultHandoff(''), false);
});

test('提示词里写明了这个机制（常驻块 + 硬触发块，中英都要有）', () => {
  const zh = cv.buildChatAdultRedirectBlock('zh');
  assert.ok(zh.includes('[[RP-UNLOCK]]'), '常驻块缺交接信号说明');
  assert.ok(zh.includes('只有真的给出这条引导时才输出'), '常驻块缺「别乱标」的约束');
  assert.ok(cv.buildChatAdultRedirectBlock('en').includes('[[RP-UNLOCK]]'), '英文常驻块缺交接信号');
  assert.ok(cv.buildChatExplicitSteerBlock('zh').includes('[[RP-UNLOCK]]'), '硬触发块缺交接信号');
  assert.ok(cv.buildChatExplicitSteerBlock('en').includes('[[RP-UNLOCK]]'), '英文硬触发块缺交接信号');
  assert.ok(!zh.includes('——'), '新写的说明不许引入破折号');
});
