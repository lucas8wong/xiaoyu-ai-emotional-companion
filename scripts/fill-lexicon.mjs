/**
 * 语料库灌入工具，把任意来源的文本写进 prompts/adult-lexicon.{en,zh}.txt
 *
 * 用途：你手上有现成的措辞清单（网页、本地文件、剪贴板），一条命令就能灌进去，
 *       不用手工翻文件、不用担心粘错位置。
 *
 * 用法：
 *   node scripts/fill-lexicon.mjs <来源> <en|zh> [--mode=append|replace] [--from=<标记文本>] [--out=<输出路径>]
 *
 *   <来源>  可以是 https:// 网址，也可以是本地文件路径，或 "-" 表示从标准输入读
 *   --mode  append（默认，追加）| replace（覆盖原有的注入正文）
 *   --from  只取该标记文本**之后**的内容（例如 --from="Table of Contents"），
 *           适合从带前言的长文里只摘正文段落；不传则整份写入
 *   --out   写给**任意路径**而不是项目内的 prompts/ 目录（例如存到桌面/备份/分享给别人）。
 *           注意：用 --out 时不追加说明头，就是一份干净的纯文本。
 *
 * 例：
 *   node scripts/fill-lexicon.mjs https://example.com/guide en
 *   node scripts/fill-lexicon.mjs ./my-list.txt zh --mode=replace
 *   node scripts/fill-lexicon.mjs guide.txt en --from="Table of Contents" --out="$HOME/Desktop/lexicon.txt"
 *   Get-Content big.txt -Raw | node scripts/fill-lexicon.mjs - en
 *
 * 说明：
 *   · 写入位置 = 文件里「，以下为注入正文，」那行之后；该行之前的说明注释保持不动。
 *   · 每行以 # 开头的会被服务端当注释跳过，所以注入正文里尽量不要以 # 开头。
 *   · 灌完后自查：npx tsx scripts/dump-rp-prompt.mts，然后看 temp/prompt-<lang>-on.txt。
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKER = '· 以下为注入正文（把内容粘在这里） ·';

const args = process.argv.slice(2);
const src = args[0];
const lang = (args[1] || 'en').toLowerCase();
if (!src || !['en', 'zh'].includes(lang)) {
  console.error('用法: node scripts/fill-lexicon.mjs <来源|-> <en|zh> [--mode=append|replace] [--from=<标记>]');
  process.exit(1);
}
const mode = (args.find((a) => a.startsWith('--mode=')) || '--mode=append').split('=')[1];
const fromArg = args.find((a) => a.startsWith('--from='));
const fromMarker = fromArg ? fromArg.slice('--from='.length) : null;
const outArg = args.find((a) => a.startsWith('--out='));
const outPath = outArg ? outArg.slice('--out='.length) : null;
const secArg = args.find((a) => a.startsWith('--sections='));
const wanted = secArg
  ? secArg.slice('--sections='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  : null;
const strip = args.includes('--strip-prohibited');
const audit = args.includes('--audit');
const stripIns = args.includes('--strip-insults');

/**
 * 违法类别过滤：把命中**硬边界**的条目剔除后再注入。
 *
 * 为什么必须有这道：语料是直接进 system prompt 的"可调用素材"，而 roleplay 的硬边界是
 * 「未成年性化 / 非自愿胁迫 / 乱伦 / 兽交」。若语料里含这些类别的词，就等于一边在输出侧设防
 * （见 services/safety.ts 的 OUTPUT_HARD_BLOCK），一边在输入侧把违禁词当素材递给模型
 * 自己拆自己的防线。用 --strip-prohibited 可保证语料永远不含这几类。
 *
 * 判定与 services/safety.ts 的硬边界保持同一套语义（不放宽、不新增）。
 */
const PROHIBITED = [
  /未成年|没成年|未满十[六八]|未满1[68]|不满十[六八]岁|不满1[68]岁/,
  /幼女|幼态|萝莉|童颜|小学生|初中生|高中生|校服|儿童|雏妓|恋童/,
  /强奸|轮奸|迷奸|迷晕|下药|胁迫|强迫|违背.{0,4}意愿/,
  // 兽交同义词族：只列「兽交」会漏「兽奸/人兽/禽兽」（实测就是漏了 4 行）
  // 这份输入是**词表不是散文**，不会出现「人兽冲突」这类句子，所以按词干收不会误伤。
  /乱伦|兽交|兽奸|人兽|禽兽|淫兽|近亲/,
  // 毒品（与 safety.ts 的 FORBIDDEN_NORM 一致）
  /吸毒|毒品|冰毒|海洛因|摇头丸|大麻|可卡因|制毒|贩毒/,
  /父女|母女|母子|兄妹|姐弟/,
  /child|underage|minor|pedo|incest|bestial|rape|molest/i,
];

/**
 * 骂人 / 贬低类过滤，与「法律底线」**分开**的一类。
 *
 * 为什么要分开：法律底线是「绝不能出现」，骂人是「产品风格不允许」（roleplay 提示词里本来就写了
 * 「禁止辱女词汇及句式」）。两者的从严程度、误伤风险、将来是否放宽都不一样，混在一个开关里会很难调。
 *
 * 误伤提示（故意留的口子）：
  *   · 未收「妓女」，它是正当的职业/角色设定，收了会误伤正经剧情；
  *   · 未收单字「贱」「死」等，太短，会命中「下贱的天气」这类正常表达；
  *   · 「废物/垃圾」在正常剧情对抗里很常见，若发现误伤，删掉那一条即可。
 */
const INSULTS = [
  /辱女|婊子|贱货|骚货|荡妇|母狗|贱人|贱婢|骚逼|骚比|色逼|骚屄|公交车|肉便器|淫妇|烂货|下贱|妓女/,
  /傻逼|脑残|智障|白痴|蠢货|废物点心|去死吧|滚出去/,
  /whore|slut|bitch|cunt|skank|twat|worthless (piece|thing)/i,
];

/**
 * 国骂 / 脏话类（profanity），与「辱女贬低」是**两个子类**，审计分开报。
 *
 * 为什么用结构式而不是枚举短语：这类词的变体是无穷的（他妈/你他妈/真他妈/操你妈/草你丫/擦你妈…
 * 光靠列短语永远漏）。所以抓「脏话动词 + 对象」这个主干：(操|草|干|日|cao)(你|他|她|尼|泥)。
 *
 * 已知取舍（都会造成误伤，需要就删对应那条）：
 *   · 「我操/卧槽/牛逼」是现代口语高频填充词，收了会剃掉不少正常对话；目前按用户要求收。
 *   · 「干你什么事」这类常见说法也会被主干规则命中。
 *   · 粤语脏话（屌你/丢你老母/扑街）**暂未收**：你的目标受众在港澳、剧本里有粤语台词，
 *     收了可能误伤正当的角色说话方式。要不要收由你定。
 */
/**
 * 扩展审查类别，除了已经过渡的法律底线/贬低/国骂三类之外，全量扫描时**一并报告**，
 * 避免又出现「我定了一类、过了一类、宣布干净，然后用户发现漏了另一类」的循环。
 * 这些类别**不默认剔除**（有些在剧情里可能是正当的，例如角色是警察/医生、剧情涉及创伤），
 * 只做定位报告，由项目方决定是否收。剔除请用 --strip-prohibited / --strip-insults。
 */
const EXTRA_CATS = [
  ['暴力/血腥', /砍死|捅死|割喉|割脉|分尸|碎尸|肢解|残肢|血肉模糊|开膛|挖眼|剥皮|虐待|虐杀/],
  ['自伤/自杀', /自杀|自残|自伤|割腕|跳楼|跳河|上吊|服毒|轻生|寻死|了结自己/],
  ['毒品', /吸毒|毒品|冰毒|海洛因|摇头丸|大麻|可卡因|制毒|贩毒/],
  ['排泄/卫生', /屎|尿液|粪便|拉稀|失禁|便溺/],
  ['极端/病态', /恋尸|奸尸|食人|吃人肉|虐尸|人兽/],
  ['歧视类', /残废|瞎子|聋子|哑巴|弱智|娘炮|死同性恋|黑鬼|阿三|支那/],
  ['英文极端', /necrophil|snuff|gore|torture|dismember|mutilat/i],
];

const PROFANITY = [
  /(操|草|艹|肏|干|日|曰|擦|cao)(你|他|她|它|尼|泥|嫩)/i,
  /(操|草|干|日|cao) (你|他|她)/i,
  /他妈|你妈的|妈的个|妈了个|妈逼|妈的逼|娘西皮|册那|傻逼|煞笔|沙比/,
  /草泥马|卧槽|我操|我草|尼玛|泥马|滚犊子/,
  /fuck|motherfuck|asshole|bastard|son of a bitch|shit/i,
];

function stripInsults(text) {
  const lines = text.split(String.fromCharCode(10)).map(function (x) { return x.split(String.fromCharCode(13)).join(''); });
  const kept = [];
  let removed = 0;
  for (const l of lines) {
    if (l.trim() && (INSULTS.some((re) => re.test(l)) || PROFANITY.some((re) => re.test(l)))) { removed++; continue; }
    kept.push(l);
  }
  return { text: kept.join(String.fromCharCode(10)), removed };
}

function stripProhibited(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (const l of lines) {
    if (l.trim() && PROHIBITED.some((re) => re.test(l))) {
      removed++;
      continue;
    }
    kept.push(l);
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/**
 * 按章节标题抽取：识别 Roman 编号标题行（"ii. Reaction Words"、"xiv. Sexy Words"…），
 * 取指定编号的章节正文（到下一个标题为止）。用于**只灌你要的那几节**，而不是把整份塞进去。
 */
function pickSections(text, ids) {
  const lines = text.split(/\r?\n/);
  const headRe = /^\s*((?:x{1,3})?(?:ix|iv|v?i{0,3}))\.\s+(\S.*)$/i;
  const heads = [];
  lines.forEach((l, i) => {
    const m = headRe.exec(l);
    if (m && m[2].trim().length > 2) heads.push({ id: m[1].toLowerCase(), title: m[2].trim(), line: i });
  });
  if (!heads.length) return { text: '', found: [] };
  const out = [];
  const found = [];
  for (const id of ids) {
    const idx = heads.findIndex((h) => h.id === id);
    if (idx < 0) continue;
    const start = heads[idx].line;
    const end = idx + 1 < heads.length ? heads[idx + 1].line : lines.length;
    found.push(`${id} ${heads[idx].title}`);
    out.push(`## ${heads[idx].id}. ${heads[idx].title}\n` + lines.slice(start + 1, end).join('\n').trim());
  }
  return { text: out.join('\n\n').trim(), found };
}

/** 读取来源：网址 / 本地文件 / 标准输入 */
async function readSource(s) {
  if (s === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
    return await r.text();
  }
  return fs.readFileSync(s, 'utf8');
}

/** 粗剥 HTML（若来源是网页）：去脚本样式再退标签 */
function stripHtml(t) {
  if (!/<(html|body|div|p|br)\b/i.test(t)) return t;
  return t
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

let text = stripHtml(await readSource(src));

if (wanted && wanted.length) {
  const picked = pickSections(text, wanted);
  if (!picked.found.length) {
    console.error(`✗ 没匹配到任何章节（找的：${wanted.join(', ')}）。标题行需形如 "ii. Reaction Words"`);
    process.exit(1);
  }
  console.log('  抽到章节：\n    ' + picked.found.join('\n    '));
  const miss = wanted.filter((w) => !picked.found.some((f) => f.toLowerCase().startsWith(w)));
  if (miss.length) console.warn('  ⚠️ 未匹配到：' + miss.join(', '));
  text = picked.text;
}

if (fromMarker) {
  const i = text.indexOf(fromMarker);
  if (i < 0) {
    console.error(`✗ 没找到标记「${fromMarker}」，未写入任何内容`);
    process.exit(1);
  }
  text = text.slice(i + fromMarker.length);
}

// 压掉多余空行；注入正文里若出现以 # 开头的行，前面补个空格避免被当注释
let body = text
  .split(/\r?\n/)
  .map((l) => (l.trimStart().startsWith('#') ? ' ' + l : l))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

if (audit) {
  // 审计模式：只报告、不写入。**只打行号与命中的类别，不打印命中内容**
  // 否则审计报告本身就把违禁词又输出了一遍。
  const lines = body.split(String.fromCharCode(10));
  const CAT = ['未成年/幼态','幼态标记','非自愿胁迫','乱伦兽交','亲属关系','英文类别'];
  const hits = [];
  const insHits = [];
  const proHits = [];
  lines.forEach(function (l, i) {
    if (l.trim() && INSULTS.some(function (re) { return re.test(l); })) insHits.push(i + 1);
    if (l.trim() && PROFANITY.some(function (re) { return re.test(l); })) proHits.push(i + 1);
  });
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const idx = PROHIBITED.findIndex((re) => re.test(l));
    if (idx >= 0) hits.push('    第 ' + (i + 1) + ' 行 -> ' + (CAT[idx] || ('类别' + idx)));
  });
  console.log('== 语料审计 ==');
  console.log('  文件: ' + src);
  console.log('  有效行: ' + lines.filter((l) => l.trim()).length + '   命中硬边界: ' + hits.length);
  console.log('  骂人/贬低类命中: ' + insHits.length + (insHits.length ? ('  行号: ' + insHits.slice(0, 30).join(', ')) : ''));
  EXTRA_CATS.forEach(function (pair) {
    const nm = pair[0], re = pair[1];
    const ln = [];
    lines.forEach(function (l, i) { if (l.trim() && re.test(l)) ln.push(i + 1); });
    console.log('  【' + nm + '】命中 ' + ln.length + (ln.length ? ('  行号: ' + ln.slice(0, 40).join(', ')) : ''));
  });
  console.log('  国骂/脏话类命中: ' + proHits.length + (proHits.length ? ('  行号: ' + proHits.slice(0, 30).join(', ')) : ''));
  if (hits.length) { console.log('  需剔除的位置（不打印内容）:'); hits.forEach((h) => console.log(h)); console.log('  处理：加 --strip-prohibited 重新灌入即可剔除。'); }
  else console.log('  ✅ 干净：不含未成年性化 / 非自愿 / 乱伦 / 兽交 类词汇。');
  process.exit(hits.length || insHits.length || proHits.length ? 1 : 0);
}

if (stripIns) {
  const s = stripInsults(body);
  console.log('  --strip-insults：剔除骂人/贬低类行 ' + s.removed + ' 行');
  body = s.text;
}

if (strip) {
  const s = stripProhibited(body);
  console.log(`  --strip-prohibited：剔除命中硬边界（未成年/非自愿/乱伦/兽交）的行 ${s.removed} 行`);
  body = s.text;
}

if (!body) {
  console.error('✗ 摘出来的内容是空的，未写入');
  process.exit(1);
}

const file = outPath
  ? path.resolve(outPath.replace(/^~(?=[/\\])/, process.env.USERPROFILE || process.env.HOME || '~'))
  : path.resolve('prompts', `adult-lexicon.${lang}.txt`);

// --out 模式：写一份干净的纯文本（不带项目内的说明头），方便存桌面/备份/分享
if (outPath) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  const merged = mode === 'replace' || !existing ? body : existing + '\n\n' + body;
  fs.writeFileSync(file, merged + '\n', 'utf8');
  console.log(`✓ 已写入 ${file}`);
  console.log(`  模式=${mode}  本次新增 ${body.length} 字符  文件总计 ${merged.length} 字符`);
  process.exit(0);
}

const head = MARKER + '\n\n';
const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head;
const at = current.indexOf(MARKER);
const prefix = at >= 0 ? current.slice(0, at + head.length) : head;
const prevBody = at >= 0 ? current.slice(at + head.length).trim() : '';

const merged = mode === 'replace' || !prevBody ? body : prevBody + '\n\n' + body;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, prefix + merged + '\n', 'utf8');

console.log(`✓ 已写入 ${path.relative(process.cwd(), file)}`);
console.log(`  模式=${mode}  本次新增 ${body.length} 字符  注入正文总计 ${merged.length} 字符`);
console.log('  自查：npx tsx scripts/dump-rp-prompt.mts 然后看 temp/prompt-' + lang + '-on.txt');
