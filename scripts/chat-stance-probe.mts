/**
 * 陪伴倾向改制探针（2026-09-23）—— 固定探针 × 双臂对照（真实模型）
 *
 * ## 为什么写它
 * 用户投诉「选了『接住我』，就偶尔会看到小愈说什么『行，我接住了』，这太容易让人出戏了」。
 * 改制（删掉用户侧档位卡 → 内部判断块 + 明写"不许说出口"）到底有没有把这类**元叙述/动作自述**压下去，
 * 只能拿真模型的输出来量，不能靠提示词里写了什么来宣称。
 *
 * ## 双臂设计（同一段历史、同一用户，只有 system 有差异）
 *   · new    —— 当前生产 prompt（`COMPANION_STANCE` + `NO_META_NARRATION_RULE`）
 *   · legacy —— **近似复现改制前**：把判断块换回旧的 `hug` 档位卡（**插在同一个位置**：
 *               `HUMANIZE_RULES` 之后，与旧代码 `modeExtra` 的位置一致），并去掉新的禁令规则。
 *   为什么说"近似"：旧卡还有 ally/clarify/light/objective 四张，探针只跑 `hug` 一张
 *   —— 用户报的那句正是 hug 卡（卡名就是「接住我」）；只跑它能把变量压到最小。
 *
 * ## 判据（两档，别只看字面）
 *   · **字面族**（`META_FAMILY`）：把自己的动作当结果宣告 / 报菜单。`我接住了` 这类**描述性**读数，
 *     只能证明"那一句还在不在"，不能代表整体人机感 —— 与 `chat-voice-scan.mts` 的口径一致。
 *   · **结构代理**（字数、条目数）：改制的风险是把小愈压成"更短更空"。所以同时看字数中位数，
 *     一旦明显变短就说明改伤了（旧的「出口太窄 → 涌向模板」教训）。
 *
 * ## 用法
 *   npx tsx scripts/chat-stance-probe.mts [--out=temp/chat-stance-probe.json] [--arms=new,legacy]
 *
 * ## 数据安全
 * `setupTempCwd()` 把 store 切到系统临时目录：**不读也不写 `data/` 里的真实用户数据**（红线 3）。
 * 只调用真实模型（`feature: 'chat'`），不写任何会话记录（落库在路由层，这里不走路由）。
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { setupTempCwd } from '../test/unit/setup.js';

// ⚠️ 必须在 setupTempCwd() 之前锁项目根并加载 .env：setupTempCwd() 会把 cwd 切到临时目录，
// 之后的相对路径（含 dotenv 默认的 `.env`）都会指错地方。
const PROJECT_ROOT = process.cwd();
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
setupTempCwd();

const gem: any = await import('../api/services/gemini.js');
const { COMPANION_STANCE, NO_META_NARRATION_RULE } = await import('../api/services/companionStance.js');
const { HUMANIZE_RULES } = await import('../api/services/prompts.js');
const { createDeepSeekClient } = await import('../api/services/deepseek.js');

const argv = process.argv.slice(2);
const argOf = (k: string): string => (argv.find((a) => a.startsWith('--' + k + '=')) || '').split('=').slice(1).join('=');
const OUT = argOf('out') || 'temp/chat-stance-probe.json';
const ARMS = (argOf('arms') || 'new,legacy').split(',').map((s) => s.trim()).filter(Boolean) as Arm[];

type Arm = 'new' | 'legacy';

/** 改制前那张 hug 档位卡（原文照抄自 prompts.ts 的 MODE_PERSONAS.hug，只用于对照，不进生产 prompt） */
const LEGACY_HUG_CARD = '【当前陪伴方式：接住我】这轮陪聊，小愈把"接住"放在第一位：更慢、更软、更细地陪在情绪旁边，帮用户轻轻说出那些自己也没说清的感受。依然是同一个"小愈"，口头禅、语气词、说话习惯全部不变，只是语气更柔和、节奏更慢，不说教、不催促、不廉价安慰。这一轮的侧重是：先接住情绪 → 帮用户说清一点点 → 给空间。**这不是四步流程，别照着格子填**，每一步都要落在用户刚说的具体内容上。';

/**
 * 固定探针：覆盖五种倾向各自最容易被触发的处境。
 * 全部单轮（首轮口径）——首轮没有负例块，正是这类模板最容易冒出来的地方（「我在呢」那次实测首轮 41.9%）。
 */
const PROBES: { key: string; text: string; want: string }[] = [
  { key: '自责', text: '我搞砸了今天的汇报，好丢脸', want: '温柔接住' },
  { key: '低能量', text: '我就是很累，不想说话', want: '温柔接住' },
  { key: '委屈', text: '同事当着大家的面说我不行，明明不是我的错', want: '撑腰' },
  { key: '想理清', text: '我最近老是因为小事跟我妈吵，我也不知道为什么', want: '一起理清' },
  { key: '自我否定', text: '我什么都做不好，是不是我这个人有问题', want: '看得轻一点' },
  { key: '开心', text: '我拿到 offer 了！！', want: '陪着高兴' },
];

/** 字面族：把自己的动作当结果宣告（"我接住了"）/ 报菜单（"我换个客观的角度"）。 */
const META_FAMILY = /我(把|已经)?(接住|兜住|稳稳接住)了|接住你了|我接住你|我在这里接着你|我稳稳地接着你|我换个客观的角度|我帮你梳理一下结构|我这就来给你撑腰/;

interface Row { arm: Arm; key: string; want: string; probe: string; reply: string; ms: number; chars: number; meta: boolean; jiezhu: number; error?: string }

const client = createDeepSeekClient();

async function buildArmSystem(arm: Arm, probe: string): Promise<{ system: string; user: string }> {
  const { system, user } = await gem.buildChatPromptParts([{ role: 'user', content: probe }], { userId: 'probe-stance-' + arm }, true);
  if (arm === 'new') return { system, user };
  // legacy：换回旧卡（同位置）+ 去掉新禁令 —— 其余一模一样，差异只剩这两处
  const legacy = system
    .replace('\n\n' + COMPANION_STANCE, '\n\n' + LEGACY_HUG_CARD)
    .replace(NO_META_NARRATION_RULE, '');
  if (legacy === system) {
    throw new Error('legacy 臂没能替换出旧卡：system 里找不到 COMPANION_STANCE / 禁令（提示词结构变了？）');
  }
  // HUMANIZE_RULES 仍在，说明位置没跑偏（卡就在它后面一格）
  if (!legacy.includes(HUMANIZE_RULES)) throw new Error('legacy 臂结构异常：HUMANIZE_RULES 不在 system 里');
  return { system: legacy, user };
}

async function runArm(arm: Arm): Promise<Row[]> {
  const rows: Row[] = [];
  for (const p of PROBES) {
    const t0 = Date.now();
    let reply = '';
    let error = '';
    try {
      const { system, user } = await buildArmSystem(arm, p.text);
      const res: any = await client.models.generateContent({
        model: 'gemini-2.5-flash', // 兼容占位符＝默认模型（同 chatReply）
        contents: [
          { role: 'system', parts: [{ text: system }] },
          { role: 'user', parts: [{ text: user }] },
        ],
        thinkingLevel: 'off', // 只测"说话像不像人"，思考档只烧钱不改结论
        feature: 'chat',
      });
      reply = String(res?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (!reply) error = 'EMPTY_REPLY';
    } catch (e: any) {
      error = String(e?.message || e);
    }
    rows.push({
      arm, key: p.key, want: p.want, probe: p.text, reply, ms: Date.now() - t0,
      chars: reply.length, meta: META_FAMILY.test(reply), jiezhu: (reply.match(/接住/g) || []).length,
      ...(error ? { error } : {}),
    });
  }
  return rows;
}

const all: Row[] = [];
for (const arm of ARMS) {
  console.log(`\n=== 跑 ${arm} 臂（${PROBES.length} 条固定探针）===`);
  const rows = await runArm(arm);
  all.push(...rows);
  for (const r of rows) {
    console.log(`\n[${arm} · ${r.key}｜期望：${r.want}] ${r.probe}`);
    console.log(r.error ? `  ⚠️ 调用失败：${r.error}` : `  ${r.reply}`);
  }
}

// ———————————————— 汇总 ————————————————
const median = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
console.log('\n=== 汇总（字面判据是描述性的；结构代理才是决策指标）===');
for (const arm of ARMS) {
  const rows = all.filter((r) => r.arm === arm);
  const ok = rows.filter((r) => !r.error);
  console.log(`  ${arm.padEnd(7)} 成功 ${ok.length}/${rows.length}` +
    ` ｜ 元叙述/报菜单命中 ${ok.filter((r) => r.meta).length}` +
    ` ｜ 「接住」出现 ${ok.reduce((a, r) => a + r.jiezhu, 0)} 次` +
    ` ｜ 字数中位数 ${median(ok.map((r) => r.chars))}` +
    ` ｜ 中位延迟 ${median(ok.map((r) => r.ms))}ms`);
}
if (all.some((r) => r.error)) {
  console.log('\n⚠️ 有调用失败：先看是不是 DEEPSEEK_API_KEY 没配或网络问题，别把失败当"没命中"。');
}
console.log('\n注意：样本 6 条 × 每臂 —— 结论只能是**方向性**的（命中 0 不等于永不出现）。' +
  '真实用户的长期读数请用 `scripts/chat-voice-scan.mts --probe=<正则>`（按上线日期切前后窗口）。');

const outPath = path.resolve(PROJECT_ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  arms: ARMS,
  metaFamily: String(META_FAMILY),
  probes: PROBES,
  rows: all,
}, null, 2) + '\n', 'utf8');
console.log('\n已写出原始数据：' + outPath);
