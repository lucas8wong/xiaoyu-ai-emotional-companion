/**
 * 脱敏模块单测。
 *
 * 全部用**编造的假数据**，本模块零 I/O，不读 data/，所以从结构上就不可能碰到
 * 真实用户数据（AGENTS.md 红线 3）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, scrubMessages, describeHits } from '../../api/services/deidentify';

const T = (s: string) => scrubText(s).text;

test('联系方式：邮箱 / 链接 / @handle 各自成类', () => {
  assert.equal(T('发我邮箱 xiaoming.zhang+test@example.com 吧'), '发我邮箱 [邮箱] 吧');
  assert.equal(T('看 https://example.com/a?b=1&c=2 那个'), '看 [链接] 那个');
  assert.equal(T('我 IG 是 @xiaoming_88'), '我 IG 是 [用户名]');
});

test('邮箱优先于 @handle：a@b.com 不会被拆成 [用户名]', () => {
  assert.equal(T('a@b.com'), '[邮箱]');
});

test('手机号：大陆 11 位 / 港澳 8 位都洗掉', () => {
  assert.equal(T('我电话 13812345678'), '我电话 [手机号]');
  assert.equal(T('香港号 51234567'), '香港号 [手机号]');
  assert.equal(T('澳门号 66123456'), '澳门号 [手机号]');
});

test('证件与卡号：身份证排在银行卡前，18 位不会被当成卡号', () => {
  assert.equal(T('身份证 11010119900307551X'), '身份证 [身份证]');
  assert.equal(T('卡号 6222021234567890123'), '卡号 [银行卡]');
});

test('社交账号：微信号 / wxid / QQ', () => {
  assert.equal(T('加我 wxid_abc123def'), '加我 [微信号]');
  assert.equal(T('微信号：xiaoming_88'), '[微信号]');
  assert.equal(T('QQ：123456789'), '[QQ]');
});

test('自报姓名：保留引导词，否则审阅者读不懂句子', () => {
  assert.equal(T('我叫小明，你好'), '我叫[姓名]，你好');
  assert.equal(T('my name is John'), 'my name is [姓名]');
  assert.equal(T("my name's Alice"), "my name's [姓名]");
  assert.equal(T('call me Bob'), 'call me [姓名]');
  // 姓名用**贪婪**匹配（宁可多洗不可漏）：汉语姓名 2~4 字（如「欧阳娜娜」），
  // 非贪婪只吃 2 字会把 3~4 字姓名的后几位留在正文里，那是真泄露。
  // 代价是「叫我阿豪就行」的「就行」被一起吃掉，这个损失可以接受。
  assert.equal(T('叫我阿豪就行'), '叫我[姓名]');
  assert.equal(T('我叫欧阳娜娜'), '我叫[姓名]');
});

test('机构：只认「引导词 + 机构后缀」的窄口径组合', () => {
  assert.equal(T('我在澳门读中學'), '我在[机构]');
  assert.equal(T('我就读于香港中文大学'), '我就读于[机构]');
  // 没有引导词就不动（避免把剧情里的地名一起洗掉、损掉审阅价值）
  assert.equal(T('那所学校在山上'), '那所学校在山上');
});

test('附件 data URL 整段剥掉（图片 / 语音）', () => {
  const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  assert.equal(T(`看这个 ${img}`), '看这个 [图片]');
  const audio = 'data:audio/webm;base64,GkXfo59ChA==';
  assert.equal(T(`听听 ${audio}`), '听听 [语音]');
});

test('hits 只记类别与次数，**绝不记原文**', () => {
  const r = scrubText('打 13812345678 或 13998765432，我叫小明');
  assert.equal(r.hits['手机号'], 2);
  assert.equal(r.hits['姓名'], 1);
  // 关键断言：命中记录里不能出现被洗掉的原文（记原文等于再泄露一次）
  const dumped = JSON.stringify(r.hits);
  assert.equal(dumped.includes('13812345678'), false);
  assert.equal(dumped.includes('小明'), false);
  assert.deepEqual(describeHits(r.hits), ['手机号×2', '姓名×1']);
});

test('非字符串输入安全返回，不抛异常', () => {
  for (const v of [null, undefined, 42, true, {}, [], Symbol('x')]) {
    const r = scrubText(v as unknown);
    assert.equal(typeof r.text, 'string');
    assert.deepEqual(r.hits, {});
  }
});

test('重复调用不串：共享 /g 正则的 lastIndex 坑（连续 3 次结果必须一致）', () => {
  const input = '我电话 13812345678，我叫小明';
  const first = T(input);
  assert.equal(T(input), first);
  assert.equal(T(input), first);
  assert.equal(first, '我电话 [手机号]，我叫[姓名]');
});

test('幂等：已脱敏文本再洗一遍不变', () => {
  const once = T('我电话 13812345678，我叫小明');
  assert.equal(T(once), once);
});

test('scrubMessages：只保留 role/content/时间，附件只计数不留内容', () => {
  const r = scrubMessages([
    { role: 'user', content: '我电话 13812345678', timestamp: new Date('2026-01-01T00:00:00Z'), image: 'data:image/png;base64,AAAA' },
    { role: 'assistant', content: '嗯，我在', timestamp: new Date('2026-01-01T00:00:05Z') },
    { role: 'system', content: '这条角色不合法，应被丢弃' },
  ]);
  assert.equal(r.messages.length, 2);
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(r.messages[0].content, '我电话 [手机号]');
  assert.equal(r.hits['手机号'], 1);
  // 附件：只记数量，且脱离原对象（base64 不会跟出来）
  assert.equal(r.droppedAttachments, 1);
  assert.equal(JSON.stringify(r.messages).includes('base64'), false);
});

test('★ scrubMessages：数字时间戳（剧情的落盘形态）必须认，不能悄悄归零', () => {
  // 真实形态：roleplaySessions 存的是 epoch 毫秒（数字），聊一聊存的是 ISO 字符串。
  // 老实现只做 new Date(String(v))，数字会变成 Invalid Date → at=0 → 审阅队列里
  // 剧情的每条消息时间与间隔全部丢失（2026-09-20 修）。
  const t0 = Date.parse('2026-09-19T10:00:00Z');
  const r = scrubMessages([
    { role: 'user', content: '进店避雨吧', timestamp: t0 },
    { role: 'assistant', content: '他推开门。', timestamp: t0 + 6000 },
  ]);
  assert.equal(r.messages[0].at, t0);
  assert.equal(r.messages[1].at, t0 + 6000);

  // 四种形态都要给出同一个毫秒值
  const forms = scrubMessages([
    { role: 'user', content: 'a', timestamp: new Date(t0) },
    { role: 'user', content: 'b', timestamp: t0 },
    { role: 'user', content: 'c', timestamp: new Date(t0).toISOString() },
    { role: 'user', content: 'd', timestamp: String(t0) },
  ]).messages;
  assert.deepEqual(forms.map((m) => m.at), [t0, t0, t0, t0]);

  // 认不出来的一律 0（当作「时间未知」），不造出负数或 NaN
  const bad = scrubMessages([
    { role: 'user', content: 'x', timestamp: '不是时间' },
    { role: 'assistant', content: 'y', timestamp: undefined },
    { role: 'user', content: 'z', timestamp: -5 },
    { role: 'assistant', content: 'w', timestamp: NaN },
  ]).messages;
  assert.deepEqual(bad.map((m) => m.at), [0, 0, 0, 0]);
});

test('scrubMessages：只把白名单里的审阅维度带出来（多余的字段一个都不留）', () => {
  const r = scrubMessages([
    { role: 'assistant', content: '嗯', timestamp: 1_700_000_000_000, viaUnlimited: true, model: 'm1', style: 'immersive', incomplete: true, replyTo: { content: 'x' }, extra: '不该出现' },
    { role: 'assistant', content: '咦', timestamp: 1_700_000_001_000, viaUnlimited: 'true', model: 123, style: 'unknown', incomplete: 'yes' },
    { role: 'user', content: '我', timestamp: 1_700_000_002_000, viaUnlimited: true, style: 'classic' },
  ]);
  const [a, b, u] = r.messages;
  assert.equal(a.viaUnlimited, true);
  assert.equal(a.model, 'm1');
  assert.equal(a.style, 'immersive');
  assert.equal(a.incomplete, true);
  assert.deepEqual(Object.keys(a).sort(), ['at', 'content', 'incomplete', 'model', 'role', 'style', 'viaUnlimited']);
  // 错类型 / 未知枚举一律当「没记录」，绝不用默认值伪造
  assert.equal(b.viaUnlimited, undefined);
  assert.equal(b.model, undefined);
  assert.equal(b.style, undefined);
  assert.equal(b.incomplete, undefined);
  // 用户消息不带这些维度（它们只描述 AI 的回复）
  assert.equal(u.viaUnlimited, undefined);
  assert.equal(u.style, undefined);
});

test('scrubMessages：非数组输入不抛异常', () => {
  assert.deepEqual(scrubMessages(null).messages, []);
  assert.deepEqual(scrubMessages(undefined).messages, []);
  assert.deepEqual(scrubMessages('nope').messages, []);
});
