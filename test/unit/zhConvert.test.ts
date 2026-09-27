import { test } from 'node:test';
import assert from 'node:assert';
import { toZhTw, toZhSimple, toZhTwDeep, looksTraditionalText, withProtectedTerms, normalizeScriptTextProtected } from '../../api/services/zhConvert.js';
import { setupTempCwd } from './setup.js';

// 与其它剧情用例同一口径：先把 cwd 切到临时目录，再 import 带 store 的服务（绝不碰生产 data/）
setupTempCwd();
const rp: any = await import('../../api/services/roleplay.js');
const displayName = rp.displayName as (raw: string | undefined | null, fallback: string, lang: 'zh' | 'zh-TW' | 'en') => string;

test('toZhTw / toZhSimple：简繁互转', () => {
  assert.strictEqual(toZhTw('简体'), '簡體');
  assert.strictEqual(toZhSimple('簡體'), '简体');
  assert.strictEqual(toZhTw('软件'), '軟件');
  assert.strictEqual(toZhSimple('軟件'), '软件');
  // 空值原样返回
  assert.strictEqual(toZhTw(''), '');
});

test('toZhTwDeep：递归转换对象/数组里的字符串', () => {
  const out = toZhTwDeep({ a: '软件', b: ['网络', '内存'], c: 1, d: null });
  assert.strictEqual(out.a, '軟件');
  assert.deepStrictEqual(out.b, ['網絡', '內存']);
  assert.strictEqual(out.c, 1);
  assert.strictEqual(out.d, null);
});

/* ==================================================================== *
 * 2026-09-20：简繁转换的**方向闸**
 *
 * 事故（用户 59f42afe「小愈的朋友」的真实记录，取证 temp/rp-59f42afe/）：
 * 自建剧本角色名「沈重」被无条件的 tw→cn 改成「沉重」（OpenCC 词表把「沈重」当作「沉重」的繁体写法），
 * 于是模型收到的人设从头到尾写着「沉重」、用户界面里印着「沈重」；用户连着两轮反馈也无效——
 * **那句「是沈重不是沉重啊」的偏好原文同样被改写成了「是沉重不是沉重啊」**。
 * 同一类误伤还有「著称→着称」（官方剧本人设）、「安乾镐→安干镐」「藉口→借口」。
 *
 * 不变量（这一节的每一条都是它的一个面）：**对「本来就是简体」的文本，toZhSimple 必须零改写**；
 * 只有确实像繁体的文本才转。
 * ==================================================================== */

test('zhConvert 方向闸：简体文本零改写（专名/正常词都不许被“顺手纠正”）', () => {
  // 人名（事故本体）
  assert.strictEqual(toZhSimple('沈重'), '沈重');
  assert.strictEqual(toZhSimple('沈重个人档案'), '沈重个人档案');
  assert.strictEqual(toZhSimple('安乾镐'), '安乾镐');
  // 正常词被 tw→cn 词表改成错别字（官方剧本《顾淮之·产后》人设实测）
  assert.strictEqual(toZhSimple('以冷硬果决著称'), '以冷硬果决著称');
  assert.strictEqual(toZhSimple('显著'), '显著');
  assert.strictEqual(toZhSimple('藉口'), '藉口');
  // 用户亲笔写下的偏好原文必须逐字保留（这正是病因：连抱怨都被改写）
  const pref = '· 用户希望：写沈重要用他代指。而且是沈重不是沉重啊，你在搞什么玩意';
  assert.strictEqual(toZhSimple(pref), pref);
});

test('zhConvert 方向闸：确实像繁体的文本照旧转简体（功能不退化）', () => {
  assert.strictEqual(toZhSimple('簡體'), '简体');
  assert.strictEqual(toZhSimple('這座陌生的城市剛入夜'), '这座陌生的城市刚入夜');
  assert.strictEqual(toZhSimple('陸深站在床邊'), '陆深站在床边');
  assert.strictEqual(toZhSimple('沈從文'), '沈从文'); // 含繁体专用字「從」→ 该转就转
  // 混合文本（同时含繁简专用字）按保守口径**不转**：宁可留繁体，也不赌哪边是正文
  const mixed = '陸深和这个字';
  assert.strictEqual(toZhSimple(mixed), mixed);
});

test('looksTraditionalText：判据只看字形（简繁同形字不算繁体）', () => {
  assert.strictEqual(looksTraditionalText('這座城市'), true);
  assert.strictEqual(looksTraditionalText('这座城市'), false);
  assert.strictEqual(looksTraditionalText('沈重'), false);   // 简繁同形 → 不是繁体
  assert.strictEqual(looksTraditionalText(''), false);
  assert.strictEqual(looksTraditionalText('hello'), false);
});

test('反向不回归：cn→tw 不碰名字（沈重仍是沈重）', () => {
  assert.strictEqual(toZhTw('沈重'), '沈重');
  assert.strictEqual(toZhTw('陆深'), '陸深');
});

test('displayName：客户端给的名字原样用，缺省才做字体归一', () => {
  // 前端传来的就是界面上显示的那份（zh-TW 已转过）→ 服务端不再转写
  assert.strictEqual(displayName('沈重', '角色', 'zh'), '沈重');
  assert.strictEqual(displayName('  沈重  ', '角色', 'zh'), '沈重');
  // 没传 → 退回剧本自带默认名：繁→简方向**不转名字**（有损，会把「冷昇」写成「冷升」），
  // 这与 zh 界面一致——列表接口对 zh 就是原样返回
  assert.strictEqual(displayName('', '冷昇', 'zh'), '冷昇');
  assert.strictEqual(displayName('', '陸深', 'zh'), '陸深');
  // 简→繁方向照转（界面本来就是按繁体显示名字的）
  assert.strictEqual(displayName(undefined, '陆深', 'zh-TW'), '陸深');
});

/* ==================================================================== *
 * 2026-09-20 第二轮（用户拍板 C）：**专名保护** —— 名字逐字不变
 *
 * 方向闸只治「判错方向」；名字里含繁体专用字的仍会被归一改掉（冷昇→冷升、陸深→陆深），
 * 与「沈重→沉重」是同一个病：界面写着 A、模型收到 B，它会一直用 B。
 * 所以名字走**占位符保护**：转换期间换成私用区字符，转完原样换回来。
 * ==================================================================== */

test('withProtectedTerms：专名逐字保留，正文照常归一', () => {
  // 名字含繁体专用字 → 正文里的「邊/說」照转，名字不动
  assert.strictEqual(
    withProtectedTerms('陸深站在床邊說話', ['陸深'], toZhSimple),
    '陸深站在床边说话',
  );
  // 多处出现都保得住
  assert.strictEqual(
    withProtectedTerms('冷昇看了你一眼。冷昇沒說話。', ['冷昇'], toZhSimple),
    '冷昇看了你一眼。冷昇没说话。',
  );
  // 多个专名（角色名 + 昵称），长的优先替换，互不串味
  assert.strictEqual(
    withProtectedTerms('范海平與沈重，沈重笑了', ['沈重', '范海平'], toZhSimple),
    '范海平与沈重，沈重笑了',   // 两个专名都保住，专名之外的「與」照转
  );
  // 1 个字的词条一律忽略（保护范围过大会误伤正文）
  assert.strictEqual(withProtectedTerms('這個人', ['這'], toZhSimple), '这个人');
  // 空名单 = 原样行为
  assert.strictEqual(withProtectedTerms('這個人', [], toZhSimple), '这个人');
  assert.strictEqual(withProtectedTerms('這個人', undefined, toZhSimple), '这个人');
});

test('normalizeScriptTextProtected：zh 方向保护、zh-TW 方向照转（与界面一致）', () => {
  // 繁→简：名字逐字不变
  assert.strictEqual(normalizeScriptTextProtected('陸深站在床邊', 'zh', ['陸深']), '陸深站在床边');
  // 简→繁：字形归一照做（界面列表接口对 zh-TW 就是这么转的）
  assert.strictEqual(normalizeScriptTextProtected('陆深站在床边', 'zh-TW', ['陆深']), '陸深站在床邊');
  // 英文原样
  assert.strictEqual(normalizeScriptTextProtected('Hello 世界', 'en', ['陆深']), 'Hello 世界');
});
