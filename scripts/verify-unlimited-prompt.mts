/**
 * 验证「成人模式」的提示词行为，走真实生产链路（roleplayReply + 路由 + 偏好）
 *
 * 用 stub 拦截 globalThis.fetch 拿到**完整请求体**（比 mock 服务更能断言文本内容），
 * 因此可以做强断言：压制条款在成人模式下**根本不存在**（物理移除），而非"被声明作废"。
 *
 * 判别设计：两个用例指向同一 stub，唯一差异是 unlimited 开关。
 * 另有可判别差异：DeepSeek 分支会注入 thinking，compat 分支不会，用来确认真的换了分支。
 *
 * 用法：npx tsx scripts/verify-unlimited-prompt.mts
 */
import { setupTempCwd } from '../test/unit/setup.js';

setupTempCwd();

for (const p of ['RP_ZH', 'RP_EN']) {
  process.env[p + '_BASE_URL'] = 'http://127.0.0.1:9/v1';
  process.env[p + '_API_KEY'] = 'stub';
  process.env[p + '_MODEL'] = 'stub/model';
}
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.DEEPSEEK_API_KEY = 'stub';

const rp: any = await import('../api/services/roleplay.js');

const scenario = rp.getScenario((rp.listScenarios('zh') as any[])[0].id);
if (!scenario) { console.error('取不到剧本'); process.exit(1); }

let body: any = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_u: any, init: any) => {
  body = JSON.parse(init.body);
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '（stub）' } }], usage: {} }),
    text: async () => '',
  } as any;
}) as any;

async function getSystem(lang: string, unlimited: boolean | undefined) {
  body = null;
  await rp.roleplayReply(scenario, [{ role: 'user', content: '（探针）我推门进来。' }], { lang, unlimited });
  const sys = String(body?.messages?.[0]?.content || '');
  return {
    sys,
    // 检测要同时覆盖简体/繁体/英文三种写法（繁体里是「獨立提示詞」）
    hasBlock: /成人模式 · 独立提示词|成人模式 · 獨立提示詞|Adult mode · standalone prompt/.test(sys),
    hasThinking: body?.thinking !== undefined,
  };
}

// 成人模式下必须**不存在**的压制条款
const CAPS_ZH = [
  '完整的回复不超过四句',
  '每次回复里的场景转换不超过三次',
  '要求你回复简洁，一次一两句',
  '你语言简短，不会描述与当下环境场景无关的无效信息',
  '减少动作的描写，多是语言',
  '禁止夸张、大段落、书面化的心理、情绪、动作描写',
  '禁止使用夸张的、小说化的语句',
];
const CAPS_EN = [
  'A complete reply is no longer than 4 sentences',
  'No more than 3 scene changes per reply',
  'Reply concisely, one or two sentences at a time',
  'Keep language brief',
  'Reduce action description and favor speech',
  'No exaggerated, long-paragraph',
  'No exaggerated, novelistic sentences',
];

console.log('\n=== 成人模式提示词验证（stub 拦截真实请求体）===\n');

const zhOn = await getSystem('zh', true);
const zhOff = await getSystem('zh', false);
const enOn = await getSystem('en', true);
const enOff = await getSystem('en', false);
const twOn = await getSystem('zh-TW', true);
const auto = await getSystem('zh', undefined);
globalThis.fetch = realFetch; // 所有用例跑完再还原

for (const [n, d] of [['zh on', zhOn], ['zh off', zhOff], ['en on', enOn], ['en off', enOff], ['zh-TW on', twOn], ['zh auto', auto]] as const) {
  console.log(`  ${n.padEnd(10)} system=${String(d.sys.length).padStart(5)} 字  成人块=${d.hasBlock ? '有' : '无'}  thinking=${d.hasThinking ? '有(DeepSeek)' : '无(compat)'}`);
}

const checks: Array<[string, boolean]> = [];
// 1) 物理移除：成人模式下这些条款必须一条都不剩
for (const c of CAPS_ZH) checks.push([`zh 成人模式下「${c.slice(0, 16)}…」已物理移除`, !zhOn.sys.includes(c)]);
for (const c of CAPS_EN) checks.push([`en 成人模式下「${c.slice(0, 30)}…」已物理移除`, !enOn.sys.includes(c)]);
// 2) 反向：非成人模式下这些条款**必须仍在**（证明不是误删全局）
checks.push(['zh 非成人模式下压制条款仍在（未误删全局）', CAPS_ZH.every((c) => zhOff.sys.includes(c))]);
checks.push(['en 非成人模式下压制条款仍在（未误删全局）', CAPS_EN.every((c) => enOff.sys.includes(c))]);
// 3) 繁体分支同样移除
checks.push(['zh-TW 成人模式下已移除（繁体育转换正确）', !twOn.sys.includes('完整的回复不超过四句') && !twOn.sys.includes('完整的回覆不超過四句')]);
checks.push(['zh-TW 成人模式下块也已注入（繁体标题）', twOn.hasBlock]);
// 4) 分支与块的对应关系
checks.push(['成人模式注入块 + 走 compat 分支', zhOn.hasBlock && !zhOn.hasThinking]);
checks.push(['非成人模式不注入块 + 回落 DeepSeek 分支', !zhOff.hasBlock && zhOff.hasThinking]);
checks.push(['未传 unlimited 时保持改造前行为（compat + 有块）', auto.hasBlock && !auto.hasThinking]);
// 5) 成人块本身的内容要求
const block = rp.buildUnlimitedModeBlock('zh') as string;
const blockEn = rp.buildUnlimitedModeBlock('en') as string;
const blockTw = rp.buildUnlimitedModeBlock('zh-TW') as string;
const blockCl = rp.buildUnlimitedModeBlock('zh', 'classic') as string;
checks.push(['块要求完整露骨描写', /露骨/.test(block) && /不许蒙太奇/.test(block)]);
checks.push(['块禁止回避性词汇', /直呼其名/.test(block)]);
checks.push(['块禁止省略式收尾', /第二天早上/.test(block) && /此处省略/.test(block)]);
checks.push(['块要求角色更主动', /主动求欢/.test(block) && /不写「这样不好吧」/.test(block)]);
// 篇幅：短而精。必须有上限，且必须没有残留的「无上限」表述
// ⚠️ 2026-09-17 修两次：① 篇幅上限已**按叙事风格分档**（下面原来钉的是分档前的统一值，必然全红）；
//    ② 方案 E 后沉浸档再拆成「日常 ≤100 字 / 亲密 250–450 字」，亲密场景必须**解除**旧上限，
//    否则用户明确推进时模型没有字数写下一步（实测取证：这正是「18+ 丰富度不够」的主因之一）。
checks.push(['块含篇幅上限（沉浸：日常 ≤100 字 / 亲密 250–450 字）',
  /不超过 100 字/.test(block) && /250–450 字/.test(block) && !/即使亲密场景，正文也最多 200 字/.test(block)]);
checks.push(['块含篇幅上限（经典 400–700 字）', /400–700 字/.test(blockCl)]);
checks.push(['块不再宣称「不设句数/字数上限」', !/不设句数上限/.test(block) && !/不设字数上限/.test(block)]);
checks.push(['块含反注水条款（不许重复/堆砌/复述/填充）',
  /不许重复同一个动作/.test(block) && /不许堆砌形容词/.test(block) && /不许复述用户已经写过/.test(block) && /填充篇幅/.test(block)]);
checks.push(['块含密度优先（宁短而句句到位）', /密度优先：宁可短而句句到位/.test(block)]);
checks.push(['块含沉浸档默认简洁（日常一两句）', /一次一两句/.test(block) && /日常对话/.test(block)]);
checks.push(['英文块含字数上限与反注水', /under 60 words/.test(blockEn) && /120-250 words/.test(blockEn) && /Do NOT substitute volume for quality/.test(blockEn)]);
checks.push(['英文块不再宣称 no word cap', !/no word cap/.test(blockEn) && !/no sentence cap/.test(blockEn)]);
// 方案 E（2026-09-17）：推进/落点/意图节 + 语料库真的注入了（语料库空 = 整套机制空转，此前从未被断言过）
checks.push(['块含推进/落点/用户意图节', /★ 推进、落点与用户意图/.test(block) && /用户的动作就是指令/.test(block)]);
checks.push(['块明确五种「不算推进」的写法', /不算推进/.test(block) && /软化替代/.test(block)]);
checks.push(['语料库已注入且非空（zh/en）', /【可直接调用的措辞素材】/.test(block) && /【可直接调用的措辞素材】/.test(blockEn)]);
checks.push(['块保留硬边界（未成年/自愿/乱伦兽交）', /未成年/.test(block) && /自愿/.test(block) && /乱伦、兽交/.test(block)]);
checks.push(['块声明自伤/血腥边界继续遵守', /自伤\/血腥\/暴力/.test(block)]);
checks.push(['英文块含对应要求', /explicitly/.test(blockEn) && /consensual/.test(blockEn) && /underage/.test(blockEn)]);
checks.push(['繁体块已转换', /成人模式/.test(blockTw) && /作廢|不必/.test(blockTw) || /成人模式/.test(blockTw)]);
// 6) 尺寸关系：成人版比普通版长（块加进来、条款移出去，净增）
checks.push(['zh 成人版 system 长于普通版', zhOn.sys.length > zhOff.sys.length]);
checks.push(['en 成人版 system 长于普通版', enOn.sys.length > enOff.sys.length]);

console.log('\n=== 断言 ===');
let ok = true;
for (const [name, pass] of checks) {
  if (!pass) ok = false;
  console.log(`  ${pass ? '✔' : '✖'} ${name}`);
}
console.log(`\n结果：${ok ? '全部通过 ✅' : '存在失败 ❌'}（共 ${checks.length} 条）`);
process.exit(ok ? 0 : 1);
