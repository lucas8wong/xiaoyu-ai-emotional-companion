import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMetaLeak, stripLeadingMetaLeak } from '../../api/services/outputHygiene';

/**
 * 输出卫生（2026-09-29）：模型会把「要不要写引用标记」这类内部思考写进正文，必须剥掉。
 * 用例全部来自真机截图原文。
 */

const LEAK = '上面是对应来源的编号标记……等等，这里没有实时资讯列表的编号。我用的是 web_search。那我应该直接附链接，不要用编号标记。\n\n我重写，去掉编号，直接附链接。有啊。9月28号PGL瓦拉几亚S9总决赛，Yandex三比零横扫NAVI夺冠。';

test('stripLeadingMetaLeak：剥掉开头的自言自语，保留真正要说的话', () => {
  const r = stripLeadingMetaLeak(LEAK);
  assert.equal(r.changed, true);
  assert.ok(!/web_search|编号标记|实时资讯|我重写|等等/.test(r.text), '内部思考没剥干净：' + r.text);
  assert.ok(r.text.startsWith('有啊。9月28号'), '正文必须完整保留：' + r.text);
});

test('stripLeadingMetaLeak：不碰正常回复里的「等等」（那是语气，不是思考）', () => {
  const r = stripLeadingMetaLeak('等等，你先别急，我在这儿呢。\n\n慢慢说就好。');
  assert.equal(r.changed, false);
  assert.equal(r.text, '等等，你先别急，我在这儿呢。\n\n慢慢说就好。');
});

test('stripLeadingMetaLeak：正文中间提到工具不剥（只剥开头）', () => {
  const t = '今天天气不错。\n\n你说 web_search 是什么？那是我的搜索功能。';
  const r = stripLeadingMetaLeak(t);
  assert.equal(r.changed, false);
  assert.equal(r.text, t);
});

test('stripLeadingMetaLeak：整段都是自言自语 → 整段丢掉；全丢光则返回空串', () => {
  const r = stripLeadingMetaLeak('我用的是 web_search。');
  assert.equal(r.changed, true);
  assert.equal(r.text, '');
});

test('looksLikeMetaLeak：强特征只在开头 200 字里判，避免误伤正常回答', () => {
  assert.equal(looksLikeMetaLeak(LEAK), true);
  assert.equal(looksLikeMetaLeak('嗯，我在呢。今天想聊点什么？'), false);
  const long = '嗯，我在。'.repeat(60) + '顺便说一句，我用的是 web_search。';
  assert.equal(looksLikeMetaLeak(long), false, '200 字以外的提及不算泄露');
});