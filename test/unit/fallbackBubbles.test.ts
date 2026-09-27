import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFallbackBubble, stripFallbackBubbles, LOCAL_FALLBACK_BUBBLES } from '../../src/lib/fallbackBubbles';

test('失败兜底文案识别：三语 errNetwork 都算兜底', () => {
  assert.equal(isFallbackBubble('网络好像开小差了，稍后再试试好吗？🌱'), true);
  assert.equal(isFallbackBubble('網路好像開小差了，稍後再試試好嗎？🌱'), true);
  assert.equal(isFallbackBubble('Network hiccup — let us try again in a moment 🌱'), true);
});

test('失败兜底文案识别：服务端错误串也算（历史遗留 2 处）', () => {
  assert.equal(isFallbackBubble('生成失败，请稍后重试'), true);
  assert.equal(isFallbackBubble('服务暂时不可用，请稍后重试'), true);
});

test('聊一聊空回复旧兜底也被登记（2026-09-20：伪造台词已改成抛错，但历史数据里可能还留着）', () => {
  // 简 + 繁两种形态：normalizeScriptText 对 zh-TW 会转繁体
  assert.equal(isFallbackBubble('我在的。慢慢说，我会认真听。🌱'), true);
  assert.equal(isFallbackBubble('我在的。慢慢說，我會認真聽。🌱'), true);
  // 仍然只做整串匹配：小愈真说「我在」不是兜底
  assert.equal(isFallbackBubble('嗯，我在。今天怎么样？'), false);
});

test('额度/付费文案也算兜底（2026-09-18：线上真实数据里已留 3 处，繁体带句号那句就是它）', () => {
  // 四种写法都要收：简/繁 × 带/不带句号 —— 漏一个写法，整串匹配就等于没收
  assert.equal(isFallbackBubble('免费次数已用完，请付费解锁后继续使用'), true);
  assert.equal(isFallbackBubble('免费次数已用完，请付费解锁后继续使用。'), true);
  assert.equal(isFallbackBubble('免費次數已用完，請付費解鎖後繼續使用'), true);
  assert.equal(isFallbackBubble('免費次數已用完，請付費解鎖後繼續使用。'), true);
  assert.equal(isFallbackBubble('You have used up your free chats. Unlock more with membership to continue.'), true);
  // 仍然只做整串匹配：角色在剧情里聊到额度、或这句被包进台词，都不该被当成兜底删掉
  assert.equal(isFallbackBubble('他停了停：「额度的事明天再说。」'), false);
  assert.equal(isFallbackBubble('（你的免费次数已用完，请付费解锁后继续使用——他念了一遍手机上的提示）'), false);
});

test('额度文案会被写盘前/读历史时剔除（assistant 侧）', () => {
  const msgs = [
    { role: 'user', content: '我们继续' },
    { role: 'assistant', content: '免費次數已用完，請付費解鎖後繼續使用。' },
    { role: 'assistant', content: '他把外套搭在椅背上。' },
  ];
  const out = stripFallbackBubbles(msgs);
  assert.equal(out.length, 2, '额度文案没被剔掉：' + JSON.stringify(out.map(m => m.content)));
  assert.equal(out[1].content, '他把外套搭在椅背上。');
});

test('只做整串匹配：台词里出现「没听清」等字样不被误删', () => {
  assert.equal(isFallbackBubble('他没听清，又靠近了半步。'), false);
  assert.equal(isFallbackBubble('你说的网络好像断了一下，那件事我们接着说。'), false);
  // 兜底串加了前后缀（真的在演故事）也不动
  assert.equal(isFallbackBubble('（网络好像开小差了，稍后再试试好猜——他笑着说）'), false);
  assert.equal(isFallbackBubble(''), false);
  assert.equal(isFallbackBubble('   '), false);
  assert.equal(isFallbackBubble(null), false);
  assert.equal(isFallbackBubble(undefined), false);
});

test('剔除历史兜底气泡：只删 assistant，user 一条都不动', () => {
  const msgs = [
    { role: 'user', content: '我是傻子吗，叔叔' },
    { role: 'assistant', content: '网络好像开小差了，稍后再试试好吗？🌱' },
    { role: 'user', content: '生成失败，请稍后重试' },
    { role: 'assistant', content: '夜店门口那道低音鼓又闷闷地滚过一轮。' },
  ];
  const out = stripFallbackBubbles(msgs);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.role), ['user', 'user', 'assistant']);
  // user 的原话即使等于兜底串也保留（不是我们写的，不能替用户删）
  assert.equal(out[1].content, '生成失败，请稍后重试');
});

test('剔除后保留原始对象（不改动原数组）', () => {
  const msgs = [
    { role: 'assistant', content: '网络好像开小差了，稍后再试试好吗？🌱' },
    { role: 'assistant', content: '她抬起头。' },
  ];
  const out = stripFallbackBubbles(msgs);
  assert.equal(msgs.length, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0], msgs[1]);
});

test('空值/非数组安全', () => {
  assert.deepEqual(stripFallbackBubbles(null), []);
  assert.deepEqual(stripFallbackBubbles(undefined), []);
});

test('兜底表自检：每条都非空且首尾无空白（否则整串匹配会失效）', () => {
  assert.ok(LOCAL_FALLBACK_BUBBLES.length >= 12);
  for (const s of LOCAL_FALLBACK_BUBBLES) {
    assert.equal(s, s.trim(), `兜底串首尾不该有空白: ${JSON.stringify(s)}`);
    assert.ok(s.length > 0);
    assert.equal(isFallbackBubble(s), true);
  }
});
