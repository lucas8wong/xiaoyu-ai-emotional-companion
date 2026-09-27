/**
 * 真链路取证：「剧情偏好 · 最高优先级」是否真的以最高权重进 prompt。
 *
 * 需求原话：「剧情聊天里的用户偏好应该作为最高权重和重视度让 ai 参考。」
 *
 * 做法（零真实调用、零费用）：把 DEEPSEEK_BASE_URL 指向本地 stub（必须在 import 服务前设 env，
 * deepseek.ts 在模块加载时读 env），stub 记录收到的请求体 → 断言**真实代码路径**
 * （roleplayReply / roleplayReplyCustom / roleplaySuggestions）发出的 system 里：
 *   ① system 的最末尾就是偏好块（含原文；有禁忌时禁忌清单收在最后一行）；
 *   ② 偏好块只出现一次（不重复注入稀释）；
 *   ③ 旧的「【本剧情 · 用户的独特偏好/需求】」中段注入已彻底消失；
 *   ④ 没写偏好时 system 里没有空的偏好标题。
 * 产物：temp/verify-userpref-priority/ 下的 system 尾部快照（人可直接复核）。
 *
 * 跑法：npx tsx temp/verify-userpref-priority.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PREF = '我喜欢温柔又带点独占欲的 TA；剧情多一些日常互动；不要再发这个气息了。';
const OUT = path.join(process.cwd(), 'temp', 'verify-userpref-priority');

const captured: any[] = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { captured.push(JSON.parse(raw)); } catch { captured.push({ parseError: raw.slice(0, 200) }); }
    const isJson = String(req.url || '').includes('json') || (() => {
      try { return JSON.parse(raw).response_format?.type === 'json_object'; } catch { return false; }
    })();
    const content = isJson ? '["我想再靠近一点。","你还生我的气吗？","那我先不说了。","你累不累？"]' : '他把窗关上，转过身来看你，声音轻得像怕惊动什么。';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
});
await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const port = (stub.address() as { port: number }).port;

// 必须在 import 服务前设 env；并把 cwd 切到临时目录（store 单例按 cwd 定位数据目录，别碰真实 data/）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cure-verify-'));
process.chdir(tmp);
process.env.DEEPSEEK_API_KEY = 'stub-key';
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + port;
process.env.DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'stub-model';

const rp: any = await import('../api/services/roleplay.js');

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : ''));
}

/** 最近一次请求的 system 文本（真链路发出去的那一份） */
function lastSystem(): string {
  const last = captured[captured.length - 1];
  const msgs = Array.isArray(last?.messages) ? last.messages : [];
  const sys = msgs.find((m: any) => m?.role === 'system');
  return String(sys?.content || '');
}

const history = [
  { role: 'user' as const, content: '你来了。' },
  { role: 'assistant' as const, content: '他把窗关上，转过身来看你。' },
];
const scenario = rp.SCENARIOS[0];
const custom = {
  id: 'custom_verify', aiName: '景橪', aiPersona: '他是深宫里最沉默的那个人。',
  background: '你在宫里长大，他一直在你身边。', opening: '他把那盏灯拨亮了些：「夜深了。」',
};

// ① 官方剧本：写了偏好
await rp.roleplayReply(scenario, history, { lang: 'zh', userPreference: PREF });
fs.mkdirSync(OUT, { recursive: true });
const sysOfficial = lastSystem();
fs.writeFileSync(path.join(OUT, 'system-official-tail.txt'), sysOfficial.slice(-2600), 'utf8');
check('官方剧本：system 末尾就是偏好块（最末一句是禁忌清单条目）', sysOfficial.endsWith('不要再发这个气息了'));
check('官方剧本：偏好原文在场', sysOfficial.includes('剧情多一些日常互动'));
check('官方剧本：优先级声明在场', sysOfficial.includes('一律以用户偏好为准'));
check('官方剧本：安全兜底在场', sysOfficial.includes('以安全边界为准'));
check('官方剧本：偏好块只注入一次', sysOfficial.indexOf('【剧情偏好 · 最高优先级】') === sysOfficial.lastIndexOf('【剧情偏好 · 最高优先级】'));
check('官方剧本：偏好块在回合纪律之后', sysOfficial.indexOf('【回合纪律 · 最高优先级】') < sysOfficial.indexOf('【剧情偏好 · 最高优先级】'));
check('官方剧本：纪律块已让位（不再自称压过偏好）', sysOfficial.includes('以它为准，本节只管它没提到的地方'));
check('官方剧本：旧的中段注入已消失', !sysOfficial.includes('【本剧情 · 用户的独特偏好/需求】'));

// ② 自建剧本
await rp.roleplayReplyCustom(custom, history, { lang: 'zh', userPreference: PREF });
const sysCustom = lastSystem();
fs.writeFileSync(path.join(OUT, 'system-custom-tail.txt'), sysCustom.slice(-2600), 'utf8');
check('自建剧本：system 末尾也是偏好块', sysCustom.endsWith('不要再发这个气息了'));
check('自建剧本：旧的中段注入已消失', !sysCustom.includes('【本剧情 · 用户的独特偏好/需求】'));

// ③ 候选建议（AI 辅助聊天）
await rp.roleplaySuggestions(scenario, history, { lang: 'zh', userPreference: PREF });
const sysSuggest = lastSystem();
fs.writeFileSync(path.join(OUT, 'system-suggest-tail.txt'), sysSuggest.slice(-2600), 'utf8');
check('候选建议：system 末尾也是偏好块', sysSuggest.endsWith('不要再发这个气息了'));

// ④ 没写偏好：不该有空的偏好标题
await rp.roleplayReply(scenario, history, { lang: 'zh', userPreference: '' });
const sysNone = lastSystem();
check('没写偏好时不注入空块，纪律块仍是最末', !sysNone.includes('【剧情偏好') && sysNone.includes('【回合纪律 · 最高优先级】'));

// ⑤ 英文路径
await rp.roleplayReply(scenario, history, { lang: 'en', userPreference: "I like a gentle TA. Don't reuse that 'breath' line ever again." });
const sysEn = lastSystem();
fs.writeFileSync(path.join(OUT, 'system-en-tail.txt'), sysEn.slice(-2600), 'utf8');
check('英文路径：system 末尾也是偏好块（MUST AVOID 收尾）', /breath[^\n]*$/.test(sysEn) && sysEn.includes('[MUST AVOID]'));
check('英文路径：优先级声明在场', sysEn.includes('the player\u2019s preferences win'));

const failed = results.filter((r) => !r.pass);
console.log('\n' + (failed.length ? '❌ FAIL' : '✅ ALL PASS') + ` — ${results.length - failed.length}/${results.length}`);
console.log('快照目录：' + OUT);
process.exit(failed.length ? 1 : 0);
